#!/usr/bin/env node
/**
 * subtitles.js — PRD v2.13 §4 字幕产物（M5-SUB）
 *
 * 纯函数（无 ffmpeg / 无 I/O，可离线单测）：
 *   - subtitleCues({manifest, timeline, finalDurationMs})  由 clip 实例时间线派生逐句 cue
 *   - wrapCueText(text, {ratio})                            中文标点优先换行 + 竖屏每行 ≤15 字
 *   - formatSrt(cues)                                       cue → SRT 文本（HH:MM:SS,mmm）
 *   - checkCueAlignment(cues, {fps})                        帧栅格对齐校验（<100ms 验收的代理口径）
 *   - subtitleFontChain({font})                             内置字体名 + 回退链
 *   - burnSubtitlesArgs / softSubtitlesArgs                  ffmpeg 参数数组
 *
 * ffmpeg 编排（execFileSync 参数数组，无 shell；`FFMPEG_BIN` 可覆盖）：
 *   - writeSrt(...)      默认 <episode-dir>/episode.srt（Gate #7 默认识别位），原子写、fail-closed
 *   - burnSubtitles(...) mode ∈ burn | soft | both；失败清理半成品
 *
 * 写死口径（PRD §3.6 半开区间 / §4 字幕行）：
 *   - cue 起点 = clip 的 `output_start` 帧位；时长 = `trim.keep_ms`（有 trim）否则 `dialogue_ms`，
 *     再 `+ dialogue_spill_ms`（字幕跟随实际音频：spill 只延长音频，字幕同样延伸）。
 *   - cue 边界量化到 fps 帧栅格（毫秒四舍五入）：`frame → round(frame*1000/fps)`；
 *     `checkCueAlignment` 以「与帧栅格偏差 <1ms」作为「逐句与对白实测对齐 <100ms」的代理验收
 *     （帧对齐误差 ≤ 半帧；非帧对齐 → problem 提示按 fps 量化）。
 *   - 换行：竖屏 `9:16` 每行 ≤15 字，其余比例 ≤22 字；中文标点优先断行，其次空格/标签边界，
 *     超长硬切；不产生空行、不以标点起行。
 *   - 字体：`PingFang SC` → `Noto Sans CJK SC` → `Source Han Sans SC` → `Microsoft YaHei`
 *     （`--font` 只覆盖 primary，回退链不变）。
 *   - 竖屏安全区：字幕烧录区上下各留 15%（`MarginV` 按 `videoHeight` 15% 计算，调用方给高度）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TOOL_NAME = 'subtitles';
const TOOL_VERSION = '1.0.0';

/** 竖屏（9:16）每行最大字数（PRD §4 写死） */
const MAX_CHARS_PORTRAIT = 15;
/** 非竖屏每行最大字数（写死，与竖屏同口径） */
const MAX_CHARS_DEFAULT = 22;
/** 竖屏安全区上下留白比例（PRD §4 写死） */
const PORTRAIT_SAFE_AREA_RATIO = 0.15;
/** 非竖屏字幕下边距比例（无硬性规定；取安全区同量级） */
const DEFAULT_MARGIN_RATIO = 0.05;
/** 默认字号（无 videoHeight 时的回退） */
const DEFAULT_FONT_SIZE = 24;
/** 中英文断行标点（PRD §4 写死：中文标点优先） */
const BREAK_PUNCTUATION = new Set([
  '，', '。', '！', '？', '；', '：', '、',
  ',', '.', '!', '?', ';', ':',
]);

const FONT_CHAIN = Object.freeze({
  primary: 'PingFang SC',
  fallbacks: Object.freeze(['Noto Sans CJK SC', 'Source Han Sans SC', 'Microsoft YaHei']),
});

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

function isPositiveInt(v) {
  return Number.isInteger(v) && v > 0;
}

/** 帧 → 毫秒（写死：round(frame*1000/fps)，与 audio.js frameToMs 同口径） */
function frameToMs(frame, fps) {
  if (!Number.isInteger(frame) || frame < 0) {
    throw new Error(`frame must be a non-negative integer, got ${JSON.stringify(frame)}`);
  }
  if (!isPositiveInt(fps)) {
    throw new Error(`fps must be a positive integer, got ${JSON.stringify(fps)}`);
  }
  return Math.round((frame * 1000) / fps);
}

/** 由 timeline 末 clip 的 output_end 推最终时长（毫秒）；不可得 → null */
function deriveFinalDurationMs(timeline) {
  const fps = timeline && timeline.fps;
  const clips = (timeline && Array.isArray(timeline.clips)) ? timeline.clips : [];
  if (!isPositiveInt(fps) || clips.length === 0) return null;
  const last = clips[clips.length - 1];
  if (!last || !Number.isInteger(last.output_end) || last.output_end < 0) return null;
  return frameToMs(last.output_end, fps);
}

/**
 * 由 clip 实例时间线派生逐句字幕 cue（PRD §3.6/§4）。
 *
 * 每 clip 的 `dialogue`（`measured === true` 且 `dialogue_ms != null`）产 1 cue：
 *   start_ms = output_start 帧位（量化到帧栅格）
 *   时长     = trim.keep_ms（有 trim）否则 dialogue_ms，再 + dialogue_spill_ms
 *   text     = dialogue.text（trim 已含 `…`）
 *
 * @param {{manifest?:object, timeline?:object, finalDurationMs?:number}} args
 * @returns {{cues:Array<{index:number,start_ms:number,end_ms:number,text:string,clip_id:string|null,take_id:string|null}>, problems:string[], warnings:string[]}}
 */
function subtitleCues({ manifest: _manifest, timeline, finalDurationMs } = {}) {
  const fps = timeline && timeline.fps;
  if (!isPositiveInt(fps)) {
    throw new Error(`timeline.fps must be a positive integer, got ${JSON.stringify(fps)}`);
  }
  const clips = (timeline && Array.isArray(timeline.clips)) ? timeline.clips : [];
  const cues = [];
  const problems = [];
  const warnings = [];

  clips.forEach((clip, i) => {
    if (!clip || typeof clip !== 'object') return;
    const dialogue = clip.dialogue;
    if (!dialogue || typeof dialogue !== 'object') return;
    const where = `clip ${clip.clip_id || `clips[${i}]`}`;

    // 非 measured → 只 warning，不产 cue（Gate #6 负责在 final 拒绝未解决溢出）
    if (dialogue.measured !== true || dialogue.dialogue_ms === null || dialogue.dialogue_ms === undefined) {
      warnings.push(`${where}: dialogue present but no measured TTS take (measured=false / dialogue_ms=null) — no subtitle cue produced (§4)`);
      return;
    }
    if (typeof dialogue.dialogue_ms !== 'number' || !Number.isFinite(dialogue.dialogue_ms) || dialogue.dialogue_ms < 0) {
      problems.push(`${where}: dialogue.dialogue_ms must be a finite non-negative number, got ${JSON.stringify(dialogue.dialogue_ms)}`);
      return;
    }
    const startFrame = clip.output_start;
    if (!Number.isInteger(startFrame) || startFrame < 0) {
      problems.push(`${where}: output_start must be a non-negative integer frame, got ${JSON.stringify(startFrame)}`);
      return;
    }
    const keepMs = (clip.trim && typeof clip.trim.keep_ms === 'number' && Number.isFinite(clip.trim.keep_ms))
      ? clip.trim.keep_ms
      : dialogue.dialogue_ms;
    const spillMs = (typeof clip.dialogue_spill_ms === 'number' && Number.isFinite(clip.dialogue_spill_ms) && clip.dialogue_spill_ms > 0)
      ? clip.dialogue_spill_ms
      : 0;
    const durMs = keepMs + spillMs;

    const text = (typeof dialogue.text === 'string') ? dialogue.text : '';
    if (text.trim().length === 0) {
      problems.push(`${where}: dialogue text is empty — a subtitle cue must carry text (PRD §4)`);
    }

    // 帧栅格量化（毫秒四舍五入）：end 帧 = start 帧 + round(时长 * fps)
    const startMs = frameToMs(startFrame, fps);
    const endFrame = startFrame + Math.round((durMs / 1000) * fps);
    const endMs = frameToMs(Math.max(startFrame, endFrame), fps);

    cues.push({
      index: cues.length + 1,
      start_ms: startMs,
      end_ms: endMs,
      text,
      clip_id: clip.clip_id || null,
      take_id: dialogue.take_id === undefined ? null : dialogue.take_id,
    });
  });

  // 越界：cues 全部落在 [0, final_duration]（±1ms 量化容差）
  const finalMs = (finalDurationMs === undefined || finalDurationMs === null)
    ? deriveFinalDurationMs(timeline)
    : finalDurationMs;
  if (typeof finalMs === 'number' && Number.isFinite(finalMs)) {
    for (const cue of cues) {
      if (cue.start_ms < -1 || cue.end_ms > finalMs + 1) {
        problems.push(`cue ${cue.index} [${cue.start_ms}ms, ${cue.end_ms}ms] outside [0, ${Math.round(finalMs)}ms] (final_duration)`);
      }
    }
  }

  // 重叠：按 output 顺序，后一 cue 起点不得早于前一 cue 终点（±1ms）
  for (let i = 1; i < cues.length; i++) {
    if (cues[i].start_ms < cues[i - 1].end_ms - 1) {
      problems.push(`cue ${cues[i].index} starts at ${cues[i].start_ms}ms before cue ${cues[i - 1].index} ends at ${cues[i - 1].end_ms}ms (overlap)`);
    }
  }

  return { cues, problems, warnings };
}

function maxCharsForRatio(ratio) {
  return ratio === '9:16' ? MAX_CHARS_PORTRAIT : MAX_CHARS_DEFAULT;
}

/**
 * 按行拆字幕文本（PRD §4）。
 *   竖屏 `9:16` 每行 ≤15 字，其余比例 ≤22 字；中文标点优先断行，其次空格/标签边界，超长硬切；
 *   不产生空行、不以标点起行。
 * @param {string} text
 * @param {{ratio?:string}} [opts]
 * @returns {string[]}
 */
function wrapCueText(text, opts = {}) {
  if (typeof text !== 'string') {
    throw new Error(`wrapCueText requires a string, got ${JSON.stringify(text)}`);
  }
  const max = maxCharsForRatio(opts.ratio);
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return [];

  const lines = [];
  let rest = normalized;
  while (rest.length > max) {
    const window = Math.min(max, rest.length);
    let cut = -1;
    // 1. 中文标点优先（在窗口内最后一个标点之后断行）
    for (let i = window - 1; i >= 0; i--) {
      if (BREAK_PUNCTUATION.has(rest[i])) { cut = i + 1; break; }
    }
    // 2. 空格 / 标签边界（标签结束 `>`）——断行不含边界空格
    if (cut <= 0) {
      for (let i = window - 1; i >= 0; i--) {
        if (rest[i] === ' ') { cut = i; break; }
        if (rest[i] === '>') { cut = i + 1; break; }
      }
    }
    // 3. 超长硬切
    if (cut <= 0) cut = max;

    let line = rest.slice(0, cut).replace(/\s+$/, '');
    rest = rest.slice(cut).replace(/^\s+/, '');
    // 行首无标点：把后续标点并入本行（允许轻微超出 max）
    while (rest.length > 0 && BREAK_PUNCTUATION.has(rest[0])) {
      line += rest[0];
      rest = rest.slice(1);
    }
    if (line.length > 0) lines.push(line);
  }
  if (rest.length > 0) lines.push(rest);
  return lines.filter((l) => l.length > 0);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 毫秒 → SRT 时间戳 `HH:MM:SS,mmm`（负数/NaN 视为 0） */
function msToSrtStamp(ms) {
  const total = (typeof ms === 'number' && Number.isFinite(ms)) ? Math.max(0, Math.round(ms)) : 0;
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const milli = total % 1000;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${String(milli).padStart(3, '0')}`;
}

/**
 * cue 数组 → SRT 文本（`HH:MM:SS,mmm`；行内 `\n`；末行空行）。
 * 解析侧沿用 gate.js 的 `parseSrtCues`（不重复实现）。
 * @param {Array<{index?:number,start_ms:number,end_ms:number,text:string}>} cues
 * @returns {string}
 */
function formatSrt(cues) {
  if (!Array.isArray(cues)) throw new Error(`formatSrt requires an array of cues, got ${JSON.stringify(cues)}`);
  const blocks = cues.map((cue, i) => {
    const index = Number.isInteger(cue.index) ? cue.index : i + 1;
    const text = (typeof cue.text === 'string') ? cue.text : '';
    return `${index}\n${msToSrtStamp(cue.start_ms)} --> ${msToSrtStamp(cue.end_ms)}\n${text}`;
  });
  return blocks.join('\n\n') + (blocks.length ? '\n' : '');
}

/**
 * 帧栅格对齐校验（PRD §4「逐句时间与对白实测对齐 <100ms」的代理口径）。
 *   所有 start_ms/end_ms 与 fps 帧栅格偏差必须 <1ms。
 *   帧对齐即视为 <100ms 达标（偏差 ≤ 半帧）；非帧对齐 → problem 提示按 fps 量化。
 * @param {Array<{index?:number,start_ms:number,end_ms:number}>} cues
 * @param {{fps:number}} opts
 * @returns {{ok:boolean, problems:string[]}}
 */
function checkCueAlignment(cues, opts = {}) {
  const fps = opts.fps;
  if (!isPositiveInt(fps)) {
    throw new Error(`checkCueAlignment fps must be a positive integer, got ${JSON.stringify(fps)}`);
  }
  const msPerFrame = 1000 / fps;
  const problems = [];
  const list = Array.isArray(cues) ? cues : [];
  list.forEach((cue, i) => {
    const idx = (cue && Number.isInteger(cue.index)) ? cue.index : i + 1;
    for (const [name, value] of [['start_ms', cue && cue.start_ms], ['end_ms', cue && cue.end_ms]]) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        problems.push(`cue ${idx} ${name} is not a finite number: ${JSON.stringify(value)}`);
        continue;
      }
      const nearest = Math.round(value / msPerFrame) * msPerFrame;
      const residual = Math.abs(value - nearest);
      if (residual >= 1) {
        problems.push(`cue ${idx} ${name} ${value}ms is not frame-aligned at fps ${fps} (residual ${residual.toFixed(3)}ms) — quantize to the fps frame grid`);
      }
    }
    if (cue && typeof cue.start_ms === 'number' && typeof cue.end_ms === 'number' && cue.end_ms < cue.start_ms) {
      problems.push(`cue ${idx} end_ms (${cue.end_ms}ms) < start_ms (${cue.start_ms}ms)`);
    }
  });
  return { ok: problems.length === 0, problems };
}

/**
 * 字幕字体声明（PRD §4：内置字体名 + 回退链）。
 * `opts.font` 只覆盖 primary，回退链不变。
 * @param {{font?:string}} [opts]
 * @returns {{primary:string, fallbacks:string[]}}
 */
function subtitleFontChain(opts = {}) {
  const override = (typeof opts.font === 'string' && opts.font.trim().length > 0) ? opts.font.trim() : null;
  return {
    primary: override || FONT_CHAIN.primary,
    fallbacks: FONT_CHAIN.fallbacks.slice(),
  };
}

/** ffmpeg filtergraph 中的路径转义（`:` / `\` / `'` / `,` / `[]`） */
function escapeFilterPath(p) {
  return String(p)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

/** 由调用方给的高度/画幅推字幕安全区下边距（竖屏 15%） */
function resolveMarginV({ videoHeight, videoWidth, ratio, marginV } = {}) {
  if (typeof marginV === 'number' && Number.isFinite(marginV) && marginV >= 0) return Math.round(marginV);
  if (!Number.isFinite(videoHeight) || videoHeight <= 0) return null;
  const portrait = (typeof ratio === 'string' && ratio.length > 0)
    ? ratio === '9:16'
    : (Number.isFinite(videoWidth) && videoWidth > 0 ? videoHeight > videoWidth : false);
  const ratioValue = portrait ? PORTRAIT_SAFE_AREA_RATIO : DEFAULT_MARGIN_RATIO;
  return Math.round(videoHeight * ratioValue);
}

function resolveFontSize({ videoHeight, fontSize } = {}) {
  if (typeof fontSize === 'number' && Number.isFinite(fontSize) && fontSize > 0) return Math.round(fontSize);
  if (Number.isFinite(videoHeight) && videoHeight > 0) return Math.max(16, Math.round(videoHeight / 30));
  return DEFAULT_FONT_SIZE;
}

/**
 * 硬字幕（burn）ffmpeg 参数数组（纯函数，execFileSync 直接吃）。
 * `subtitles=filename='<srt>':force_style='FontName=...,FontSize=...,MarginV=...'`
 * @param {{input:string, srtPath:string, output:string, font?:string, mode?:string,
 *          videoHeight?:number, videoWidth?:number, ratio?:string, fontSize?:number, marginV?:number}} args
 * @returns {string[]}
 */
function burnSubtitlesArgs({ input, srtPath, output, font, mode, videoHeight, videoWidth, ratio, fontSize, marginV } = {}) {
  if (typeof input !== 'string' || input.length === 0) throw new Error('burnSubtitlesArgs requires input');
  if (typeof srtPath !== 'string' || srtPath.length === 0) throw new Error('burnSubtitlesArgs requires srtPath');
  if (typeof output !== 'string' || output.length === 0) throw new Error('burnSubtitlesArgs requires output');
  if (mode !== undefined && !['burn', 'soft', 'both'].includes(mode)) {
    throw new Error(`burnSubtitlesArgs mode must be one of burn|soft|both, got ${JSON.stringify(mode)}`);
  }
  if (mode === 'soft') return softSubtitlesArgs({ input, srtPath, output });

  const chain = subtitleFontChain({ font });
  const style = [`FontName=${chain.primary}`];
  style.push(`FontSize=${resolveFontSize({ videoHeight, fontSize })}`);
  const mv = resolveMarginV({ videoHeight, videoWidth, ratio, marginV });
  if (mv !== null) style.push(`MarginV=${mv}`);
  const vf = `subtitles=filename='${escapeFilterPath(srtPath)}':force_style='${style.join(',')}'`;
  return [
    '-y', '-i', input,
    '-vf', vf,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
    '-c:a', 'copy',
    output,
  ];
}

/** 软字幕（soft）ffmpeg 参数数组：`-c copy -c:s mov_text` */
function softSubtitlesArgs({ input, srtPath, output } = {}) {
  if (typeof input !== 'string' || input.length === 0) throw new Error('softSubtitlesArgs requires input');
  if (typeof srtPath !== 'string' || srtPath.length === 0) throw new Error('softSubtitlesArgs requires srtPath');
  if (typeof output !== 'string' || output.length === 0) throw new Error('softSubtitlesArgs requires output');
  return [
    '-y', '-i', input,
    '-i', srtPath,
    '-map', '0', '-map', '1',
    '-c', 'copy', '-c:s', 'mov_text',
    output,
  ];
}

// ---------------------------------------------------------------------------
// I/O 与 ffmpeg 编排
// ---------------------------------------------------------------------------

/** 原子写文本文件（tmp + rename），与 atomicWriteJson 同语义 */
function atomicWriteText(filePath, text) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
}

function resolveRatio(manifest, timeline) {
  if (manifest && typeof manifest.ratio === 'string' && manifest.ratio.length > 0) return manifest.ratio;
  if (manifest && manifest.defaults && typeof manifest.defaults.ratio === 'string') return manifest.defaults.ratio;
  if (timeline && typeof timeline.ratio === 'string' && timeline.ratio.length > 0) return timeline.ratio;
  return null;
}

/**
 * 生成并原子写 SRT（默认 `<episode-dir>/episode.srt`；Gate #7 默认识别位）。
 * problems 非空 → 抛错（fail-closed）；warnings 打印。
 * @param {{epDir:string, manifest?:object, timeline?:object, outPath?:string, finalDurationMs?:number, ratio?:string}} args
 * @returns {{ok:boolean, outPath:string, cueCount:number, warnings:string[], problems:string[]}}
 */
function writeSrt({ epDir, manifest, timeline, outPath, finalDurationMs, ratio } = {}) {
  if (typeof epDir !== 'string' || epDir.length === 0) throw new Error('writeSrt requires epDir');
  const dest = outPath || path.join(epDir, 'episode.srt');
  const { cues, problems, warnings } = subtitleCues({ manifest, timeline, finalDurationMs });
  if (problems.length > 0) {
    throw new Error(`subtitle cue problems (fail-closed):\n  - ${problems.join('\n  - ')}`);
  }
  const effRatio = (typeof ratio === 'string' && ratio.length > 0) ? ratio : resolveRatio(manifest, timeline);
  const wrapped = cues.map((cue) => Object.assign({}, cue, {
    text: wrapCueText(cue.text, { ratio: effRatio }).join('\n'),
  }));
  const srt = formatSrt(wrapped);
  atomicWriteText(dest, srt);
  for (const w of warnings) console.warn(`WARN: ${w}`);
  return { ok: true, outPath: dest, cueCount: cues.length, warnings, problems: [] };
}

function ffmpegBin(opts = {}) {
  return opts.ffmpegBin || process.env.FFMPEG_BIN || 'ffmpeg';
}

function runFfmpeg(opts, args, label) {
  try {
    execFileSync(ffmpegBin(opts), args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      encoding: 'utf8',
    });
  } catch (e) {
    const stderr = String((e && e.stderr) || '').trim();
    const message = `ffmpeg failed (${label}): ${(stderr || (e && e.message) || 'unknown error').slice(-500)}`;
    // 硬烧录需要 libass(`subtitles` 滤镜);缺该滤镜时给可执行的提示,而不是裸 ffmpeg 输出
    if (/No such filter[^\n]*['"]?subtitles/i.test(message)) {
      const err = new Error(
        `ffmpeg build lacks the 'subtitles' filter (libass) — hard burn (mode=burn|both) is unavailable. ` +
        `Use mode=soft (mov_text sidecar), or install a full ffmpeg build with libass and retry. Original: ${message}`
      );
      err.cause = e;
      err.kind = 'missing_libass';
      throw err;
    }
    throw new Error(message);
  }
}

const SUBTITLES_FILTER_CACHE = new Map();

/** 当前 ffmpeg 构建是否带 `subtitles` 滤镜(libass);结果按二进制路径缓存。 */
function hasSubtitlesFilter(bin) {
  const key = bin || ffmpegBin({});
  if (SUBTITLES_FILTER_CACHE.has(key)) return SUBTITLES_FILTER_CACHE.get(key);
  let ok = false;
  try {
    const out = execFileSync(key, ['-hide_banner', '-filters'], {
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8'
    });
    ok = /^\s*\S+\s+subtitles\s/m.test(out);
  } catch { ok = false; }
  SUBTITLES_FILTER_CACHE.set(key, ok);
  return ok;
}

function makeTmpFile(dir, tag, cleanup, ext) {
  const name = `.tmp-subtitle-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext || ''}`;
  const p = path.join(dir, name);
  cleanup.push(p);
  return p;
}

/**
 * 烧录/封装字幕（ffmpeg 编排，fail-closed）。
 *   mode `burn` → 硬字幕；`soft` → mov_text 软字幕；`both` → 先 burn 再 soft（两步）。
 * 失败抛错并清理半成品。
 * @param {{input:string, srtPath:string, output:string, font?:string, mode?:string,
 *          videoHeight?:number, videoWidth?:number, ratio?:string, fontSize?:number, marginV?:number, ffmpegBin?:string}} args
 * @returns {{ok:boolean, outPath:string, mode:string, argsHistory:Array<string[]>}}
 */
function burnSubtitles({ input, srtPath, output, font, mode = 'burn', videoHeight, videoWidth, ratio, fontSize, marginV, ffmpegBin: bin } = {}) {
  const m = mode || 'burn';
  if (!['burn', 'soft', 'both'].includes(m)) {
    throw new Error(`burnSubtitles mode must be one of burn|soft|both, got ${JSON.stringify(mode)}`);
  }
  if (typeof input !== 'string' || input.length === 0) throw new Error('burnSubtitles requires input');
  if (typeof srtPath !== 'string' || srtPath.length === 0) throw new Error('burnSubtitles requires srtPath');
  if (typeof output !== 'string' || output.length === 0) throw new Error('burnSubtitles requires output');
  if (!fs.existsSync(input)) throw new Error(`burnSubtitles: input not found: ${input}`);
  if (!fs.existsSync(srtPath)) throw new Error(`burnSubtitles: srt not found: ${srtPath}`);

  const opts = bin ? { ffmpegBin: bin } : {};
  const outDir = path.dirname(output);
  fs.mkdirSync(outDir, { recursive: true });
  const cleanup = [];
  const argsHistory = [];
  const run = (args, label) => { argsHistory.push(args); runFfmpeg(opts, args, label); };

  try {
    if (m === 'burn') {
      run(burnSubtitlesArgs({ input, srtPath, output, font, videoHeight, videoWidth, ratio, fontSize, marginV }), `burn subtitles → ${output}`);
    } else if (m === 'soft') {
      run(softSubtitlesArgs({ input, srtPath, output }), `soft subtitles → ${output}`);
    } else {
      const burned = makeTmpFile(outDir, 'burned', cleanup, path.extname(output) || '.mp4');
      run(burnSubtitlesArgs({ input, srtPath, output: burned, font, videoHeight, videoWidth, ratio, fontSize, marginV }), `burn subtitles (both step 1) → ${burned}`);
      run(softSubtitlesArgs({ input: burned, srtPath, output }), `soft subtitles (both step 2) → ${output}`);
    }
    if (!fs.existsSync(output)) {
      throw new Error(`ffmpeg did not produce the subtitles output: ${output}`);
    }
    return { ok: true, outPath: output, mode: m, argsHistory };
  } catch (e) {
    try { fs.rmSync(output, { force: true }); } catch { /* best effort */ }
    throw e;
  } finally {
    for (const p of cleanup) {
      try { fs.rmSync(p, { force: true }); } catch { /* best effort */ }
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage() {
  console.log('usage: node tools/subtitles.js <episode-dir> [--timeline <path>] [--write] [--burn <video> --out <path>]');
  console.log('       [--mode burn|soft|both] [--font <name>] [--final-duration-ms <n>] [--json]');
  console.log('  §4 字幕产物：cue 由 clip 实例时间线派生；--write 生成 <episode-dir>/episode.srt（Gate #7 识别位）');
  console.log('  --burn 需要 --out；--final-duration-ms 缺省由 timeline 末 clip output_end/fps 推得');
}

/** 由 manifest 的 defaults.resolution / resolution 推视频高度（CLI burn 的 MarginV 输入） */
function resolveVideoHeight(manifest) {
  const raw = (manifest && (manifest.resolution || (manifest.defaults && manifest.defaults.resolution))) || null;
  if (typeof raw !== 'string') return null;
  const m = /^(\d+)p$/i.exec(raw.trim());
  if (!m) return null;
  return Number(m[1]);
}

function main(argv) {
  const args = argv.slice(2);
  let episodeDir = null;
  let timelinePath = null;
  let doWrite = false;
  let burnInput = null;
  let outPath = null;
  let mode = 'burn';
  let font = null;
  let finalDurationMs = null;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') json = true;
    else if (a === '--write') doWrite = true;
    else if (a === '--timeline') timelinePath = args[++i];
    else if (a.startsWith('--timeline=')) timelinePath = a.slice('--timeline='.length);
    else if (a === '--burn') burnInput = args[++i];
    else if (a.startsWith('--burn=')) burnInput = a.slice('--burn='.length);
    else if (a === '--out') outPath = args[++i];
    else if (a.startsWith('--out=')) outPath = a.slice('--out='.length);
    else if (a === '--mode') mode = args[++i];
    else if (a.startsWith('--mode=')) mode = a.slice('--mode='.length);
    else if (a === '--font') font = args[++i];
    else if (a.startsWith('--font=')) font = a.slice('--font='.length);
    else if (a === '--final-duration-ms') finalDurationMs = Number(args[++i]);
    else if (a.startsWith('--final-duration-ms=')) finalDurationMs = Number(a.slice('--final-duration-ms='.length));
    else if (a === '--help' || a === '-h') { printUsage(); return 0; }
    else if (a.startsWith('-')) { console.error(`unknown option: ${a}`); printUsage(); return 2; }
    else if (episodeDir === null) episodeDir = a;
    else { console.error(`unexpected argument: ${a}`); printUsage(); return 2; }
  }

  if (!episodeDir) { printUsage(); return 2; }
  const absEpDir = path.isAbsolute(episodeDir) ? episodeDir : path.resolve(episodeDir);

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(absEpDir, 'manifest.json'), 'utf8'));
  } catch (e) {
    console.error(`ERROR: cannot read manifest.json: ${e.message}`);
    return 2;
  }

  const resolvedTimelinePath = timelinePath
    ? (path.isAbsolute(timelinePath) ? timelinePath : path.resolve(timelinePath))
    : path.join(absEpDir, 'timeline.json');
  if (!fs.existsSync(resolvedTimelinePath)) {
    console.error(`ERROR: timeline.json not found at ${resolvedTimelinePath} (v2 subtitles require a built timeline — run tools/build-timeline.js)`);
    return 2;
  }
  let timeline;
  try {
    timeline = JSON.parse(fs.readFileSync(resolvedTimelinePath, 'utf8'));
  } catch (e) {
    console.error(`ERROR: cannot read timeline.json: ${e.message}`);
    return 2;
  }

  const finalMs = (typeof finalDurationMs === 'number' && Number.isFinite(finalDurationMs))
    ? finalDurationMs
    : deriveFinalDurationMs(timeline);
  const ratio = resolveRatio(manifest, timeline);

  if (!doWrite && !burnInput) {
    // 只读模式：报告 cue 而不写盘（--json 输出）
    const { cues, problems, warnings } = subtitleCues({ manifest, timeline, finalDurationMs: finalMs });
    const result = { ok: problems.length === 0, cueCount: cues.length, cues, problems, warnings, ratio, finalDurationMs: finalMs };
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`cues: ${cues.length}`);
      for (const w of warnings) console.warn(`  WARN: ${w}`);
      for (const p of problems) console.error(`  PROBLEM: ${p}`);
    }
    return problems.length > 0 ? 4 : 0;
  }

  let srtPath;
  if (doWrite || !burnInput) {
    try {
      const res = writeSrt({ epDir: absEpDir, manifest, timeline, finalDurationMs: finalMs, ratio });
      srtPath = res.outPath;
      if (!json) console.log(`srt: ${res.outPath} (${res.cueCount} cue(s))`);
    } catch (e) {
      console.error(`ERROR: ${e.message}`);
      return 4;
    }
  } else {
    // --burn 未显式 --write：使用既有 episode.srt（或 --out 的 srt 来源由 --write 决定）
    srtPath = path.join(absEpDir, 'episode.srt');
    if (!fs.existsSync(srtPath)) {
      console.error(`ERROR: subtitle artifact not found: ${srtPath} (run with --write first)`);
      return 2;
    }
  }

  if (burnInput) {
    if (!outPath) {
      console.error('ERROR: --burn requires --out <path>');
      return 2;
    }
    const resolvedOut = path.isAbsolute(outPath) ? outPath : path.resolve(outPath);
    const absBurnInput = path.isAbsolute(burnInput) ? burnInput : path.resolve(burnInput);
    try {
      const res = burnSubtitles({
        input: absBurnInput,
        srtPath,
        output: resolvedOut,
        font,
        mode,
        videoHeight: resolveVideoHeight(manifest),
        ratio,
      });
      if (json) console.log(JSON.stringify(res, null, 2));
      else console.log(`subtitles (${res.mode}): ${res.outPath}`);
    } catch (e) {
      console.error(`ERROR: ${e.message}`);
      return 3;
    }
  } else if (json) {
    console.log(JSON.stringify({ ok: true, outPath: srtPath }, null, 2));
  }

  return 0;
}

module.exports = {
  TOOL_NAME,
  TOOL_VERSION,
  MAX_CHARS_PORTRAIT,
  MAX_CHARS_DEFAULT,
  PORTRAIT_SAFE_AREA_RATIO,
  BREAK_PUNCTUATION,
  FONT_CHAIN,
  frameToMs,
  hasSubtitlesFilter,
  deriveFinalDurationMs,
  subtitleCues,
  wrapCueText,
  formatSrt,
  msToSrtStamp,
  checkCueAlignment,
  subtitleFontChain,
  burnSubtitlesArgs,
  softSubtitlesArgs,
  writeSrt,
  burnSubtitles,
  main,
};

if (require.main === module) {
  process.exitCode = main(process.argv);
}
