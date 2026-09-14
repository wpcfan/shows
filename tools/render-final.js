#!/usr/bin/env node
/**
 * render-final.js — PRD v2.13 §3.3/§3.6/§3.9/§4 帧口径最终出片（M5-EDIT/D4）
 *
 * 消费 M1 `timeline.json`（clip 实例，唯一发布基准）产出最终成片：
 *   - 逐 clip 帧精确裁切（入点 / 删帧右移 / 静帧补长 / CFR 规格），concat demuxer `-c copy`；
 *   - 混流 `<episode-dir>/audio/program.m4a`（M5-AUD，§3.9 AAC 48k stereo）；
 *   - 字幕接入 `<episode-dir>/episode.srt`（M5-SUB；默认 soft/mov_text，burn 无 libass 降级 soft）；
 *   - 封面 `<episode-dir>/cover.png`（M5-SUB `cover.generateCover`，§4/#11）；
 *   - 出片后用 `probe.verifyFinalMedia` 做 v2 全量规格 + 完整解码 + A/V 长度校验（§5 #8/#9）。
 *
 * 硬规则（§3.6 一次性写死）：
 *   - 半开区间 `[source_in, source_out)`；`output_len = source_out - source_in - deleted_head_frames + padding_frames`；
 *   - 删帧通过「入点右移」实现（实际首帧 = `source_in + deleted_head_frames`），**不改写 clip.source_in**；
 *   - `padding_frames > 0` → `tpad=stop_mode=clone` 静帧补长（`-t` 先把素材截到 source_out）；
 *   - 帧数由 `-frames:v output_len` 精确控制；CFR/编码复用 `junction.cfrNormalizeArgs` 的滤镜链；
 *   - 确定性参数写死：`-fflags +bitexact -flags +bitexact -map_metadata -1 -threads 1`。
 *
 * CLI：`node tools/render-final.js <episode-dir> [--out <path>] [--timeline <path>] [--json] [--skip-cover]`
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { readJsonFile } = require('./build-manifest');
const { cfrNormalizeArgs } = require('./junction');
const { expectedVideoSpec, verifyFinalMedia } = require('./probe');
const { intentFlags } = require('./intent');
const { takeDependencyProblem } = require('./gate');
const { hasSubtitlesFilter, burnSubtitles } = require('./subtitles');
const { generateCover } = require('./cover');

const ROOT = path.resolve(__dirname, '..');
const TOOL_NAME = 'render-final';
const TOOL_VERSION = '1.0.0';

/** 模式说明（入口接线统一打印，写死） */
const MODE_LINE_V2 = 'v2 timeline render (frame-accurate, PRD §3.6)';
const MODE_LINE_V1 = 'legacy seconds render (v1 semantics)';

/** 确定性编码/封装参数（同 toolchain 口径，写死） */
const DETERMINISTIC_ARGS = ['-fflags', '+bitexact', '-flags', '+bitexact', '-map_metadata', '-1', '-threads', '1'];

function ffmpegBin(opts = {}) {
  return opts.ffmpegBin || process.env.FFMPEG_BIN || 'ffmpeg';
}

function ffprobeBin(opts = {}) {
  return opts.ffprobeBin || process.env.FFPROBE_BIN || 'ffprobe';
}

/** 帧数 → 秒字符串（仅供 ffmpeg 定位/限流，帧数由 -frames:v 精确控制） */
function secStr(frames, fps) {
  return String(Number((frames / fps).toFixed(9)));
}

/**
 * 解析 episode 模板（manifest.ratio/resolution，回退 defaults / 首个 shot）。
 * @param {object} manifest
 * @returns {{ratio:*, resolution:*}}
 */
function resolveTemplate(manifest) {
  const m = manifest || {};
  const d = (m.defaults && typeof m.defaults === 'object') ? m.defaults : {};
  const shot0 = ((m.shots || [])[0]) || {};
  const ratio = m.ratio != null ? m.ratio : (d.ratio != null ? d.ratio : shot0.ratio);
  const resolution = m.resolution != null ? m.resolution : (d.resolution != null ? d.resolution : shot0.resolution);
  return { ratio, resolution };
}

/**
 * 每个 clip 的 ffmpeg 渲染参数数组（纯函数，可单测）。
 * - 入点 = `(source_in + deleted_head_frames) / fps`（删帧右移）；
 * - 输入限流 `-t = (source_out - source_in - deleted_head_frames)/fps`，使 `tpad` 在 source_out 处静帧补长；
 * - `-frames:v = output_len`；滤镜链 = `cfrNormalizeArgs` 的 scale/pad/fps/format (+ tpad)；
 * - 追加确定性参数。
 * @param {{clip:object, takePath:string, fps:number, width:number, height:number,
 *          srcDurationFrames?:number, outPath?:string}} args
 * @returns {string[]}
 */
function clipRenderArgs({ clip, takePath, fps, width, height, srcDurationFrames, outPath } = {}) {
  if (!clip || typeof clip !== 'object') {
    throw new Error('clipRenderArgs requires a clip object');
  }
  if (typeof takePath !== 'string' || takePath.length === 0) {
    throw new Error('clipRenderArgs requires takePath');
  }
  if (!Number.isInteger(fps) || fps <= 0) {
    throw new Error(`clipRenderArgs fps must be a positive integer, got ${JSON.stringify(fps)}`);
  }
  const output = outPath
    || (typeof clip.clip_id === 'string' && clip.clip_id.length > 0 ? `${clip.clip_id}.mp4` : null);
  if (!output) {
    throw new Error('clipRenderArgs requires outPath (or a clip.clip_id)');
  }
  const sourceIn = clip.source_in;
  const sourceOut = clip.source_out;
  for (const [name, value] of [['source_in', sourceIn], ['source_out', sourceOut]]) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`clipRenderArgs ${name} must be a non-negative integer frame, got ${JSON.stringify(value)}`);
    }
  }
  if (!(sourceIn < sourceOut)) {
    throw new Error(`clipRenderArgs source_in (${sourceIn}) must be < source_out (${sourceOut})`);
  }
  const deleted = (clip.deleted_head_frames === undefined || clip.deleted_head_frames === null)
    ? 0 : clip.deleted_head_frames;
  const padding = (clip.padding_frames === undefined || clip.padding_frames === null)
    ? 0 : clip.padding_frames;
  for (const [name, value] of [['deleted_head_frames', deleted], ['padding_frames', padding]]) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`clipRenderArgs ${name} must be a non-negative integer, got ${JSON.stringify(value)}`);
    }
  }
  const realFrames = sourceOut - sourceIn - deleted;
  const outputLen = realFrames + padding;
  if (outputLen <= 0) {
    throw new Error(
      `clipRenderArgs output length must be > 0, got ${outputLen} ` +
      `(source range ${sourceOut - sourceIn}, deleted ${deleted}, padding ${padding})`
    );
  }
  if (srcDurationFrames !== undefined && srcDurationFrames !== null) {
    if (!Number.isInteger(srcDurationFrames) || srcDurationFrames < 0) {
      throw new Error(`clipRenderArgs srcDurationFrames must be a non-negative integer, got ${JSON.stringify(srcDurationFrames)}`);
    }
    if (sourceOut > srcDurationFrames) {
      throw new Error(
        `clipRenderArgs source_out ${sourceOut} exceeds source duration ${srcDurationFrames} frames ` +
        `(${clip.clip_id || 'clip'})`
      );
    }
  }

  // 复用 junction 的 CFR 滤镜链 + 编码参数（含 -an）
  const args = cfrNormalizeArgs({ input: takePath, output, fps, width, height });
  const vfIdx = args.indexOf('-vf');
  let filter = args[vfIdx + 1];
  if (padding > 0) {
    filter += `,tpad=stop_mode=clone:stop_duration=${secStr(padding, fps)}`;
  }
  args[vfIdx + 1] = filter;

  // -ss（删帧右移后的入点）/ -t（截到 source_out，使 tpad 生效）必须放在 -i 之前
  const iIdx = args.indexOf('-i');
  args.splice(iIdx, 0, '-ss', secStr(sourceIn + deleted, fps), '-t', secStr(realFrames, fps));

  // -frames:v 精确控制输出帧数 + 确定性参数（输出选项，置于输出文件之前）
  args.splice(args.length - 1, 0, '-frames:v', String(outputLen), ...DETERMINISTIC_ARGS);
  return args;
}

/**
 * 解析 take 文件绝对路径（先按项目 ROOT，再按 episode 目录）。
 * @returns {string|null}
 */
function resolveTakePath(rawPath, absEpDir) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return null;
  const candidates = path.isAbsolute(rawPath)
    ? [rawPath]
    : [path.resolve(ROOT, rawPath), path.resolve(absEpDir, rawPath)];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

/** 素材时长（秒）→ 帧数（仅供 source_out 合法性校验） */
function probeDurationFrames(filePath, fps, opts = {}) {
  let out;
  try {
    out = execFileSync(
      ffprobeBin(opts),
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }
    );
  } catch (e) {
    throw new Error(`ffprobe failed for ${filePath}: ${(e && e.message) || e}`);
  }
  const dur = parseFloat(String(out).trim());
  if (!Number.isFinite(dur) || dur <= 0) return null;
  return Math.round(dur * fps);
}

function runFfmpeg(bin, args, label) {
  try {
    execFileSync(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', maxBuffer: 1 << 28 });
  } catch (e) {
    const stderr = String((e && e.stderr) || '').trim();
    throw new Error(`ffmpeg failed (${label}): ${(stderr || (e && e.message) || 'unknown error').slice(-800)}`);
  }
}

/**
 * 判断 --final 应走 v2 帧口径还是 v1 秒制（写死条件：schema≥2 且 timeline.json 存在）。
 * @param {{absEpDir:string, manifest:object}} args
 * @returns {{mode:'v1'|'v2', schemaVersion:number, timelinePath:string|null, modeLine:string}}
 */
function detectRenderMode({ absEpDir, manifest } = {}) {
  const schemaVersion = manifest && manifest.schema_version != null ? Number(manifest.schema_version) : 1;
  const timelinePath = (typeof absEpDir === 'string' && absEpDir.length > 0)
    ? path.join(absEpDir, 'timeline.json') : null;
  const hasTimeline = !!(timelinePath && fs.existsSync(timelinePath));
  if (schemaVersion >= 2 && hasTimeline) {
    return { mode: 'v2', schemaVersion, timelinePath, modeLine: MODE_LINE_V2 };
  }
  return { mode: 'v1', schemaVersion, timelinePath, modeLine: MODE_LINE_V1 };
}

/**
 * 按 `timeline.json` 渲染最终成片（v2 帧口径，fail-closed）。
 * @param {{absEpDir:string, manifest:object, timeline:object, outPath?:string, opts?:object}} args
 *   opts.skipCover / opts.ffmpegBin / opts.ffprobeBin / opts.coverPath / opts.warn
 * @returns {{ok:boolean, outPath:string, clips:number, duration_sec:number,
 *            audio:boolean, subtitles:'soft'|'burn'|null, cover:string|null, warnings:string[]}}
 */
function renderFinal({ absEpDir, manifest, timeline, outPath, opts = {} } = {}) {
  if (typeof absEpDir !== 'string' || absEpDir.length === 0) {
    throw new Error('renderFinal requires absEpDir');
  }
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('renderFinal requires manifest');
  }
  if (!timeline || typeof timeline !== 'object') {
    throw new Error('renderFinal requires timeline');
  }
  const clips = Array.isArray(timeline.clips) ? timeline.clips : [];
  if (clips.length === 0) {
    throw new Error('renderFinal requires a non-empty timeline.clips');
  }
  const fps = timeline.fps;
  if (!Number.isInteger(fps) || fps <= 0) {
    throw new Error(`renderFinal timeline.fps must be a positive integer, got ${JSON.stringify(fps)}`);
  }
  if (manifest.fps != null && Number(manifest.fps) !== fps) {
    throw new Error(`renderFinal timeline fps ${fps} does not match manifest.fps ${manifest.fps} (PRD §3.6 episode-wide fps)`);
  }

  const template = resolveTemplate(manifest);
  const spec = expectedVideoSpec({ template, fps });

  // ---- 1. clip → take 解析（非 rejected；文件存在） ----
  const resolved = clips.map((clip, i) => {
    const label = (clip && clip.clip_id) ? clip.clip_id : `clips[${i}]`;
    if (!clip || typeof clip !== 'object') {
      throw new Error(`renderFinal ${label} must be an object`);
    }
    const shot = (manifest.shots || []).find(s => s && s.id === clip.shot_id);
    if (!shot) {
      throw new Error(`renderFinal ${label}: unknown shot_id ${JSON.stringify(clip.shot_id)}`);
    }
    const take = (shot.takes || []).find(t => t && t.id === clip.take_id);
    if (!take) {
      throw new Error(`renderFinal: unusable take — ${label}: take ${JSON.stringify(clip.take_id)} not found in shot ${shot.id}`);
    }
    // 完整素材可用性 pre-flight（与 Release Gate #4a / takeDependencyProblem 共用同一裁定）:
    // blocked / rejected / human reject / superseded(无 reuse_record) / fingerprint 失配 / take 缺失。
    // 任一 problem → 在任何 ffmpeg 之前抛错，不产出任何输出。
    const usability = takeDependencyProblem(manifest, shot, take, label);
    if (usability.length > 0) {
      throw new Error(`renderFinal: unusable take — ${usability.join('; ')}`);
    }
    const abs = resolveTakePath(take.path, absEpDir);
    if (!abs || !fs.existsSync(abs)) {
      throw new Error(`renderFinal ${label}: take file missing: ${take.path || '(null)'}`);
    }
    return { clip, shot, take, takePath: abs };
  });

  // ---- 2. intent / 音频 / 字幕 fail-closed（在任何 ffmpeg 之前） ----
  const intent = (manifest.intent && typeof manifest.intent === 'object') ? manifest.intent : {};
  const flags = intentFlags(intent);
  const warnings = [];
  const warn = (m) => { warnings.push(m); if (typeof opts.warn === 'function') opts.warn(m); else console.warn(`WARN: ${m}`); };

  let audioPath = null;
  if (flags.requires_audio) {
    const candidate = path.join(absEpDir, 'audio', 'program.m4a');
    if (fs.existsSync(candidate)) {
      audioPath = candidate;
    } else if (intent.silent === true) {
      warn(`requires_audio is true but intent.silent=true and no program audio at ${candidate} — rendering without an audio track`);
    } else {
      throw new Error(
        `renderFinal: requires_audio is true but program audio is missing: ${candidate} — run: node tools/audio.js ${absEpDir}`
      );
    }
  }

  let srtPath = null;
  let subtitleMode = null;
  if (flags.requires_subtitles) {
    const candidate = path.join(absEpDir, 'episode.srt');
    if (!fs.existsSync(candidate)) {
      throw new Error(
        `renderFinal: requires_subtitles is true but the subtitle artifact is missing: ${candidate} — run: node tools/subtitles.js ${absEpDir} --write`
      );
    }
    srtPath = candidate;
    if (intent.subtitles === 'burn' || intent.subtitles === 'both') {
      subtitleMode = intent.subtitles;
    } else {
      subtitleMode = 'soft';
      if (intent.subtitles === 'none') {
        warn('requires_subtitles is true (dialogue) but intent.subtitles=none — defaulting to soft (mov_text)');
      }
    }
    if (subtitleMode !== 'soft' && !hasSubtitlesFilter(opts.ffmpegBin)) {
      warn(`ffmpeg lacks the 'subtitles' filter (libass) — degrading subtitles mode '${subtitleMode}' to 'soft' (mov_text)`);
      subtitleMode = 'soft';
    }
  }

  const finalOut = outPath || path.join(ROOT, 'output', path.basename(absEpDir), 'episode.mp4');
  fs.mkdirSync(path.dirname(finalOut), { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-final-'));
  const bin = ffmpegBin(opts);
  let success = false;

  try {
    // ---- 3. 逐 clip 帧精确渲染 ----
    const clipFiles = [];
    resolved.forEach((r, i) => {
      const dst = path.join(tmpDir, `clip-${String(i).padStart(4, '0')}.mp4`);
      const srcDurationFrames = probeDurationFrames(r.takePath, fps, opts);
      const args = clipRenderArgs({
        clip: r.clip, takePath: r.takePath, fps,
        width: spec.width, height: spec.height, srcDurationFrames, outPath: dst,
      });
      runFfmpeg(bin, args, `clip ${r.clip.clip_id || i}`);
      clipFiles.push(dst);
    });

    // ---- 4. concat demuxer（-c copy） ----
    // 延迟 require：避免 edit-episode ↔ render-final 的加载期循环依赖
    const { escapeConcatPath } = require('./edit-episode');
    const listFile = path.join(tmpDir, 'concat-list.txt');
    fs.writeFileSync(listFile, clipFiles.map(f => `file ${escapeConcatPath(f)}`).join('\n'));
    const videoOnly = path.join(tmpDir, 'video.mp4');
    runFfmpeg(bin, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', videoOnly], 'concat clips');

    // ---- 5. 音轨混流 ----
    let muxed = videoOnly;
    let audioAdded = false;
    if (audioPath) {
      muxed = path.join(tmpDir, 'muxed.mp4');
      runFfmpeg(bin, ['-y', '-i', videoOnly, '-i', audioPath, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', muxed], 'mux program audio');
      audioAdded = true;
    }

    // ---- 6. 字幕接入 → finalOut ----
    let subtitlesApplied = null;
    if (subtitleMode) {
      burnSubtitles({
        input: muxed, srtPath, output: finalOut, mode: subtitleMode,
        videoHeight: spec.height, videoWidth: spec.width, ratio: template.ratio,
        ffmpegBin: opts.ffmpegBin,
      });
      subtitlesApplied = subtitleMode === 'burn' || subtitleMode === 'both' ? 'burn' : subtitleMode;
    } else {
      fs.copyFileSync(muxed, finalOut);
    }

    // ---- 7. 封面 ----
    let coverPath = null;
    if (!opts.skipCover) {
      const coverOut = opts.coverPath || path.join(absEpDir, 'cover.png');
      generateCover({ manifest, timeline, epDir: absEpDir, outPath: coverOut, opts: { ffmpegBin: opts.ffmpegBin } });
      coverPath = coverOut;
    }

    // ---- 8. v2 全量规格 + 完整解码 + A/V 长度校验 ----
    const verify = verifyFinalMedia({
      finalPath: finalOut,
      manifest,
      template,
      intent,
      schemaVersion: manifest.schema_version != null ? manifest.schema_version : 1,
      opts: { fps, probeOpts: opts.probeOpts, decodeOpts: opts.decodeOpts },
    });
    if (!verify.ok) {
      throw new Error(`renderFinal: final media verification failed (PRD §4/§5 #8/#9):\n  - ${verify.problems.join('\n  - ')}`);
    }

    success = true;
    const lastClip = clips[clips.length - 1];
    return {
      ok: true,
      outPath: finalOut,
      clips: clips.length,
      duration_sec: lastClip.output_end / fps,
      audio: audioAdded,
      subtitles: subtitlesApplied,
      cover: coverPath,
      warnings,
      mediaResult: verify,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (!success) {
      try { fs.rmSync(finalOut, { force: true }); } catch { /* best effort */ }
    }
  }
}

/**
 * 确定性摘要：视频流解码后 MD5 + 音频 PCM(48k stereo s16le) SHA256。
 * `audio_md5` 为 sha256(PCM)；无音轨 → null。
 * @param {string} filePath
 * @param {{ffmpegBin?:string}} [opts]
 * @returns {{video_md5:string|null, audio_md5:string|null}}
 */
function determinismDigests(filePath, opts = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('determinismDigests requires a file path');
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`determinismDigests: file not found: ${filePath}`);
  }
  const bin = ffmpegBin(opts);
  let video_md5 = null;
  try {
    const out = execFileSync(
      bin,
      ['-v', 'error', '-i', filePath, '-map', '0:v', '-f', 'md5', '-'],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 1 << 30 }
    );
    const m = /MD5=([0-9a-f]{32})/i.exec(String(out));
    video_md5 = m ? m[1].toLowerCase() : null;
  } catch {
    video_md5 = null;
  }
  let audio_md5 = null;
  try {
    const buf = execFileSync(
      bin,
      ['-v', 'error', '-i', filePath, '-map', '0:a', '-f', 's16le', '-ar', '48000', '-ac', '2', '-'],
      { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 30 }
    );
    audio_md5 = crypto.createHash('sha256').update(buf).digest('hex');
  } catch {
    audio_md5 = null;
  }
  return { video_md5, audio_md5 };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage() {
  console.log('usage: node tools/render-final.js <episode-dir> [--out <path>] [--timeline <path>] [--json] [--skip-cover]');
  console.log('  PRD §3.6 v2 帧口径最终出片：timeline.json clip 实例 + program.m4a + episode.srt + cover.png');
  console.log('  default timeline: <episode-dir>/timeline.json');
  console.log('  default out:      output/<episode>/episode.mp4');
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { episodeDir: null, outPath: null, timelinePath: null, json: false, skipCover: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') out.json = true;
    else if (a === '--skip-cover') out.skipCover = true;
    else if (a === '--out') out.outPath = args[++i];
    else if (a.startsWith('--out=')) out.outPath = a.slice('--out='.length);
    else if (a === '--timeline') out.timelinePath = args[++i];
    else if (a.startsWith('--timeline=')) out.timelinePath = a.slice('--timeline='.length);
    else if (a === '--help' || a === '-h') { out.help = true; }
    else if (a.startsWith('-')) { out.error = `unknown option: ${a}`; }
    else if (out.episodeDir === null) out.episodeDir = a;
    else { out.error = `unexpected argument: ${a}`; }
  }
  return out;
}

function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.help) { printUsage(); return 0; }
  if (parsed.error) { console.error(parsed.error); printUsage(); return 2; }
  if (!parsed.episodeDir) { printUsage(); return 2; }

  const absEpDir = path.isAbsolute(parsed.episodeDir) ? parsed.episodeDir : path.resolve(parsed.episodeDir);
  let manifest;
  try {
    manifest = readJsonFile(path.join(absEpDir, 'manifest.json'), { label: 'manifest.json' });
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    return 2;
  }
  const timelinePath = parsed.timelinePath
    ? (path.isAbsolute(parsed.timelinePath) ? parsed.timelinePath : path.resolve(parsed.timelinePath))
    : path.join(absEpDir, 'timeline.json');
  if (!fs.existsSync(timelinePath)) {
    console.error(`ERROR: timeline.json not found at ${timelinePath} (v2 final render requires a built timeline — run tools/build-timeline.js)`);
    return 2;
  }
  let timeline;
  try {
    timeline = readJsonFile(timelinePath, { label: 'timeline.json' });
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    return 2;
  }
  if (parsed.outPath && !path.isAbsolute(parsed.outPath)) {
    parsed.outPath = path.resolve(parsed.outPath);
  }

  let result;
  try {
    result = renderFinal({ absEpDir, manifest, timeline, outPath: parsed.outPath, opts: { skipCover: parsed.skipCover } });
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    return 3;
  }
  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`RENDERED: ${result.outPath}`);
    console.log(`  clips: ${result.clips}`);
    console.log(`  duration: ${result.duration_sec.toFixed(2)}s`);
    console.log(`  audio: ${result.audio ? 'yes' : 'no'}`);
    console.log(`  subtitles: ${result.subtitles || 'none'}`);
    console.log(`  cover: ${result.cover || '(skipped)'}`);
    for (const w of result.warnings) console.warn(`  WARN: ${w}`);
  }
  return 0;
}

module.exports = {
  TOOL_NAME,
  TOOL_VERSION,
  MODE_LINE_V1,
  MODE_LINE_V2,
  DETERMINISTIC_ARGS,
  clipRenderArgs,
  renderFinal,
  detectRenderMode,
  determinismDigests,
  resolveTemplate,
  resolveTakePath,
  main,
};

if (require.main === module) {
  process.exit(main(process.argv));
}
