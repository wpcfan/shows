#!/usr/bin/env node
/**
 * audio.js — PRD v2.13 §3.4 / §3.9 音轨合成（M5-AUD，TECH-DEBT A3 音频层）
 *
 * 把 M5-OVF 在 timeline 上留下的**帧级决策与标记**落地成一条 program 音轨：
 *   - dialogue（TTS 产物，含 trim.keep_ms / dialogue_spill_ms 跨切点延伸）；
 *   - sfx（clip 级 `sfx: [{id, at, gain_db}]`，`at` 为 clip 内帧号）；
 *   - music（集级 `timeline.cues`，`at_ms` 或帧号，帧号优先）；
 *   - 静音基床（anullsrc，48kHz stereo，时长 = program 时长）→ amix → 两遍 loudnorm
 *     （I=-14±1 LUFS，TP≤-1 dB，LRA=11）→ AAC 48k stereo 封装（§3.9）。
 *
 * 纯函数（无 ffmpeg，可离线单测）：
 *   dialogueSegments / cuePlacements / programDurationMs / planProgram /
 *   parseLoudnormJson / loudnormArgs / verifyLoudness
 * ffmpeg 编排（execFileSync 参数数组，无 shell；`FFMPEG_BIN` 可覆盖）：
 *   analyzeLoudness / buildProgramAudio
 *
 * 硬约束（写死）：
 *   - 一律按 clip 实例的 output 帧位计算偏移，不按原始 take 时长累加（§3.6）；
 *   - spill **只动音频**：`keep_ms` 不变、另记 `spill_ms`，program 长度不变；
 *   - 分贝用 `volume=<gain>dB` 显式给定，amix 用 `normalize=0`（不二次归一）；
 *   - loudnorm 两遍：第一遍 `print_format=json` 分析 → 第二遍带 measured_* 应用；
 *   - 任一步失败 fail-closed（抛错 + 清理 tmp），不留半成品；
 *   - tmp 文件写 `outPath` 同目录 `.tmp-*`，`finally` 清理。
 *
 * CLI：`node tools/audio.js <episode-dir> [--timeline <path>] [--out <path>] [--strict] [--json]`
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { readJsonFile } = require('./build-manifest');

const TOOL_NAME = 'audio';
const TOOL_VERSION = '1.0.0';

/** §3.9 音频输出规格（写死） */
const AUDIO_CODEC = 'aac';
const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_CHANNELS = 2;
const AUDIO_BITRATE = '192k';

/** §3.9 loudnorm 目标（写死） */
const LOUDNORM_TARGET = { I: -14, TP: -1, LRA: 11 };

/** cue 源扩展名（解析顺序写死，确定性） */
const SFX_EXTENSIONS = ['.mp3', '.wav', '.m4a'];
const MUSIC_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'];

function ffmpegBin() {
  return process.env.FFMPEG_BIN || 'ffmpeg';
}

function isPositiveInt(v) {
  return Number.isInteger(v) && v > 0;
}

function requireTimelineFps(timeline) {
  const fps = timeline && timeline.fps;
  if (!isPositiveInt(fps)) {
    throw new Error(`timeline.fps must be a positive integer, got ${JSON.stringify(fps)}`);
  }
  return fps;
}

function timelineClips(timeline) {
  return (timeline && Array.isArray(timeline.clips)) ? timeline.clips : [];
}

/**
 * 帧 → 毫秒（写死：四舍五入到最近整数毫秒）。
 * @param {number} frame 非负整数帧
 * @param {number} fps 正整数
 * @returns {number}
 */
function frameToMs(frame, fps) {
  if (!Number.isInteger(frame) || frame < 0) {
    throw new Error(`frame must be a non-negative integer, got ${JSON.stringify(frame)}`);
  }
  if (!isPositiveInt(fps)) {
    throw new Error(`fps must be a positive integer, got ${JSON.stringify(fps)}`);
  }
  return Math.round((frame * 1000) / fps);
}

/** 毫秒 → 秒字符串（固定 3 位小数，避免 locale/精度漂移） */
function msToSecStr(ms) {
  const clamped = Math.max(0, ms);
  return (clamped / 1000).toFixed(3);
}

/** 解析 manifest 中某 shot 的 TTS take 路径（找不到 → null） */
function resolveTtsPath(manifest, shotId, takeId) {
  if (typeof takeId !== 'string' || takeId.length === 0) return null;
  const shot = ((manifest && manifest.shots) || []).find(s => s && s.id === shotId);
  if (!shot) return null;
  const takes = Array.isArray(shot.tts_takes) ? shot.tts_takes : [];
  const take = takes.find(t => t && t.id === takeId);
  if (!take || take.status === 'rejected') return null;
  return typeof take.path === 'string' && take.path.length > 0 ? take.path : null;
}

/**
 * 对白段（纯函数，不跑 ffmpeg）。
 *   - clip.dialogue 存在且 `measured !== false` 且 `dialogue_ms != null` → 产段；
 *   - 否则产 warnings 项（不产段）；
 *   - 段起点 = `clip.output_start` @ fps；时长 = `trim.keep_ms`（有 trim）否则 `dialogue_ms`；
 *   - `dialogue_spill_ms > 0` → 另记 `spill_ms`（keep_ms 不变，仅混音时跨切点延伸）；
 *   - `src_path` 取自 manifest 的 tts take path（缺失 → null，由 planProgram 分类）。
 * @param {{manifest?:object, timeline?:object}} args
 * @returns {{segments:Array<object>, warnings:string[]}}
 */
function dialogueSegments({ manifest, timeline } = {}) {
  const fps = requireTimelineFps(timeline);
  const clips = timelineClips(timeline);
  const segments = [];
  const warnings = [];

  clips.forEach((clip, i) => {
    if (!clip || typeof clip !== 'object') return;
    const dialogue = clip.dialogue;
    if (!dialogue || typeof dialogue !== 'object') return;
    const where = `clip ${clip.clip_id || `clips[${i}]`}`;

    if (dialogue.measured === false || dialogue.dialogue_ms === null || dialogue.dialogue_ms === undefined) {
      warnings.push(
        `${where}: dialogue present but no measured TTS take (measured=false / dialogue_ms=null) — no audio segment produced (§3.4)`
      );
      return;
    }
    if (typeof dialogue.dialogue_ms !== 'number' || !Number.isFinite(dialogue.dialogue_ms) || dialogue.dialogue_ms < 0) {
      warnings.push(`${where}: dialogue.dialogue_ms must be a finite non-negative number, got ${JSON.stringify(dialogue.dialogue_ms)}`);
      return;
    }

    const keepMs = (clip.trim && typeof clip.trim.keep_ms === 'number' && Number.isFinite(clip.trim.keep_ms))
      ? clip.trim.keep_ms
      : dialogue.dialogue_ms;

    const seg = {
      type: 'dialogue',
      clip_id: clip.clip_id || null,
      shot_id: clip.shot_id || null,
      take_id: dialogue.take_id === undefined ? null : dialogue.take_id,
      src_path: resolveTtsPath(manifest, clip.shot_id, dialogue.take_id),
      at_ms: frameToMs(clip.output_start, fps),
      keep_ms: keepMs,
      gain_db: (typeof dialogue.gain_db === 'number' && Number.isFinite(dialogue.gain_db)) ? dialogue.gain_db : 0,
    };
    if (typeof clip.dialogue_spill_ms === 'number' && Number.isFinite(clip.dialogue_spill_ms) && clip.dialogue_spill_ms > 0) {
      seg.spill_ms = clip.dialogue_spill_ms;
    }
    segments.push(seg);
  });

  return { segments, warnings };
}

/** 在 `<epDir>/audio/<kind>/<id><ext>` 中按写死扩展名顺序解析第一个存在的文件 */
function resolveCueSrc(epDir, kind, id) {
  if (!epDir || typeof epDir !== 'string') return null;
  const exts = kind === 'music' ? MUSIC_EXTENSIONS : SFX_EXTENSIONS;
  for (const ext of exts) {
    const candidate = path.join(epDir, 'audio', kind, `${id}${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * SFX / music cue 落位（纯函数 + 文件存在性探测）。
 *   - clip 级 `sfx: [{id, at, gain_db}]`：`at` = clip 内帧号 → `clip.output_start + at`；
 *   - 集级 `timeline.cues`（music）：`at` 帧号优先，其次 `at_ms`；
 *   - `src_path` 缺失 → strict ? errors : warnings（preview 留痕 / final 拒绝）；
 *   - 结构性坏 cue（缺 id / 无 at 信息）→ errors（fail-closed）。
 * @param {{timeline?:object, epDir?:string, strict?:boolean}} args
 * @returns {{segments:Array<object>, warnings:string[], errors:string[]}}
 */
function cuePlacements({ timeline, epDir, strict = false } = {}) {
  const fps = requireTimelineFps(timeline);
  const clips = timelineClips(timeline);
  const segments = [];
  const warnings = [];
  const errors = [];
  const missing = (msg) => { if (strict) errors.push(msg); else warnings.push(msg); };

  clips.forEach((clip, i) => {
    if (!clip || typeof clip !== 'object') return;
    const list = Array.isArray(clip.sfx) ? clip.sfx : [];
    list.forEach((cue, j) => {
      const where = `clip ${clip.clip_id || `clips[${i}]`} sfx[${j}]`;
      if (!cue || typeof cue !== 'object' || Array.isArray(cue)) {
        errors.push(`${where} must be an object {id, at, gain_db}`);
        return;
      }
      if (typeof cue.id !== 'string' || cue.id.length === 0) {
        errors.push(`${where}.id must be a non-empty string`);
        return;
      }
      let atMs;
      if (Number.isInteger(cue.at) && cue.at >= 0) {
        atMs = frameToMs(clip.output_start + cue.at, fps);
      } else if (typeof cue.at_ms === 'number' && Number.isFinite(cue.at_ms) && cue.at_ms >= 0) {
        atMs = Math.round(cue.at_ms);
      } else {
        errors.push(`${where} requires a clip-relative frame \`at\` (integer >= 0)`);
        return;
      }
      const src = resolveCueSrc(epDir, 'sfx', cue.id);
      segments.push({
        type: 'sfx',
        kind: 'sfx',
        id: cue.id,
        clip_id: clip.clip_id || null,
        shot_id: clip.shot_id || null,
        at_ms: atMs,
        gain_db: (typeof cue.gain_db === 'number' && Number.isFinite(cue.gain_db)) ? cue.gain_db : 0,
        src_path: src,
      });
      if (!src) {
        missing(`sfx cue ${cue.id} (${where}) has no local source at ${path.join(epDir || '<episode-dir>', 'audio', 'sfx', `${cue.id}.(mp3|wav|m4a)`)}`);
      }
    });
  });

  const globalCues = Array.isArray(timeline.cues) ? timeline.cues : [];
  globalCues.forEach((cue, j) => {
    const where = `timeline.cues[${j}]`;
    if (!cue || typeof cue !== 'object' || Array.isArray(cue)) {
      errors.push(`${where} must be an object {id, at|at_ms, gain_db}`);
      return;
    }
    if (typeof cue.id !== 'string' || cue.id.length === 0) {
      errors.push(`${where}.id must be a non-empty string`);
      return;
    }
    let atMs;
    if (Number.isInteger(cue.at) && cue.at >= 0) {
      atMs = frameToMs(cue.at, fps);
    } else if (typeof cue.at_ms === 'number' && Number.isFinite(cue.at_ms) && cue.at_ms >= 0) {
      atMs = Math.round(cue.at_ms);
    } else {
      errors.push(`${where} requires an absolute frame \`at\` (integer >= 0) or \`at_ms\``);
      return;
    }
    const src = resolveCueSrc(epDir, 'music', cue.id);
    segments.push({
      type: 'music',
      kind: 'music',
      id: cue.id,
      clip_id: cue.clip_id || null,
      shot_id: cue.shot_id || null,
      at_ms: atMs,
      gain_db: (typeof cue.gain_db === 'number' && Number.isFinite(cue.gain_db)) ? cue.gain_db : 0,
      src_path: src,
    });
    if (!src) {
      missing(`music cue ${cue.id} (${where}) has no local source at ${path.join(epDir || '<episode-dir>', 'audio', 'music', `${cue.id}.*`)}`);
    }
  });

  return { segments, warnings, errors };
}

/**
 * program 时长（毫秒）= 最后一个 clip 的 `output_end` @ fps（§3.6 唯一基准）。
 * @param {object} timeline
 * @returns {number}
 */
function programDurationMs(timeline) {
  const fps = requireTimelineFps(timeline);
  const clips = timelineClips(timeline);
  if (clips.length === 0) return 0;
  const last = clips[clips.length - 1];
  if (!Number.isInteger(last.output_end) || last.output_end < 0) {
    throw new Error(`timeline clip ${last.clip_id || `clips[${clips.length - 1}]`}.output_end must be a non-negative integer`);
  }
  return frameToMs(last.output_end, fps);
}

function segmentDurationMs(seg) {
  const base = (typeof seg.keep_ms === 'number' && Number.isFinite(seg.keep_ms)) ? seg.keep_ms : 0;
  const spill = (typeof seg.spill_ms === 'number' && Number.isFinite(seg.spill_ms)) ? seg.spill_ms : 0;
  return base + spill;
}

/**
 * 汇总 program 音频计划（纯函数）。
 * 合并对白与 cue 段 → 按 `at_ms`（同点按 type、id）稳定排序 → 越界与源缺失检查。
 * 越界判定：`at_ms + duration_ms > program_duration_ms` 且**无 spill** → error（spill 允许跨切点）。
 * @param {{manifest?:object, timeline?:object, epDir?:string, strict?:boolean}} args
 * @returns {{duration_ms:number, segments:Array<object>, warnings:string[], errors:string[]}}
 */
function planProgram({ manifest, timeline, epDir, strict = true } = {}) {
  const durationMs = programDurationMs(timeline);
  const d = dialogueSegments({ manifest, timeline });
  const c = cuePlacements({ timeline, epDir, strict });
  const warnings = [...d.warnings, ...c.warnings];
  const errors = [...c.errors];

  const segments = [...d.segments, ...c.segments].sort((a, b) => {
    if (a.at_ms !== b.at_ms) return a.at_ms - b.at_ms;
    const ta = String(a.type || a.kind || '');
    const tb = String(b.type || b.kind || '');
    if (ta !== tb) return ta < tb ? -1 : 1;
    return String(a.id || a.take_id || '') < String(b.id || b.take_id || '') ? -1 : 1;
  });

  for (const seg of segments) {
    const label = seg.type === 'dialogue'
      ? `dialogue segment for clip ${seg.clip_id} (take ${JSON.stringify(seg.take_id)})`
      : `${seg.kind || seg.type} cue ${seg.id}`;
    const srcOk = typeof seg.src_path === 'string' && seg.src_path.length > 0 && fs.existsSync(seg.src_path);
    if (!srcOk) {
      const msg = `${label}: audio source missing (${JSON.stringify(seg.src_path)}) — expected a local file`;
      if (strict) errors.push(msg); else warnings.push(msg);
    }
    const hasSpill = typeof seg.spill_ms === 'number' && seg.spill_ms > 0;
    const endMs = seg.at_ms + segmentDurationMs(seg);
    if (!hasSpill && endMs > durationMs) {
      errors.push(`${label}: at_ms+duration ${endMs}ms exceeds program duration ${durationMs}ms — shorten the cue or extend the timeline (§3.6)`);
    }
    if (seg.at_ms < 0) {
      errors.push(`${label}: at_ms must be non-negative, got ${seg.at_ms}`);
    }
  }

  return { duration_ms: durationMs, segments, warnings, errors };
}

// ---------------------------------------------------------------------------
// loudnorm 纯函数
// ---------------------------------------------------------------------------

/**
 * 解析 ffmpeg loudnorm `print_format=json` 输出（从 stderr 抓 JSON 块）。
 * 缺字段 / 坏 JSON / 非数值 → 抛错（fail-closed）。
 * @param {string} raw
 * @returns {{input_i:number, input_tp:number, input_lra:number, input_thresh:number, target_offset:number}}
 */
function parseLoudnormJson(raw) {
  if (typeof raw !== 'string') {
    throw new Error(`parseLoudnormJson requires a string, got ${JSON.stringify(raw)}`);
  }
  const start = raw.lastIndexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error(`loudnorm JSON not found in ffmpeg output: ${JSON.stringify(raw.slice(-200))}`);
  }
  let doc;
  try {
    doc = JSON.parse(raw.slice(start, end + 1));
  } catch (e) {
    throw new Error(`loudnorm JSON parse failed: ${e.message}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`loudnorm JSON must be an object, got ${JSON.stringify(doc)}`);
  }
  const out = {};
  for (const key of ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset']) {
    const value = doc[key];
    if (value === undefined || value === null) {
      throw new Error(`loudnorm JSON missing field ${key}`);
    }
    const n = Number(value);
    if (!Number.isFinite(n)) {
      throw new Error(`loudnorm JSON field ${key} is not a number: ${JSON.stringify(value)}`);
    }
    out[key] = n;
  }
  return out;
}

function normalizeTarget(target) {
  const t = target || {};
  const I = t.I === undefined || t.I === null ? LOUDNORM_TARGET.I : t.I;
  const TP = t.TP === undefined || t.TP === null ? LOUDNORM_TARGET.TP : t.TP;
  const LRA = t.LRA === undefined || t.LRA === null ? LOUDNORM_TARGET.LRA : t.LRA;
  for (const [name, value] of [['I', I], ['TP', TP], ['LRA', LRA]]) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`loudnorm target.${name} must be a finite number, got ${JSON.stringify(value)}`);
    }
  }
  return { I, TP, LRA };
}

/**
 * loudnorm ffmpeg 参数数组（纯函数）。
 *   - 第一遍（无 measured）：`loudnorm=I=-14:TP=-1:LRA=11:print_format=json -f null -`；
 *   - 第二遍（有 measured）：带 `measured_I/TP/LRA/thresh/offset` + `linear=true`，
 *     并统一输出 `-ar 48000 -ac 2`（默认 `-c:a aac -b:a 192k`；`encode:false` 时写 pcm wav）。
 * @param {{input:string, output?:string, measured?:object|null, target?:object, encode?:boolean}} args
 * @returns {string[]}
 */
function loudnormArgs({ input, output, measured, target, encode = true } = {}) {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error(`loudnormArgs requires an input path, got ${JSON.stringify(input)}`);
  }
  const t = normalizeTarget(target);
  const base = `loudnorm=I=${t.I}:TP=${t.TP}:LRA=${t.LRA}`;

  if (!measured) {
    if (output !== undefined && output !== null) {
      throw new Error(`loudnormArgs first pass (analysis) does not take an output, got ${JSON.stringify(output)}`);
    }
    return ['-y', '-hide_banner', '-nostats', '-i', input, '-af', `${base}:print_format=json`, '-f', 'null', '-'];
  }

  if (typeof output !== 'string' || output.length === 0) {
    throw new Error(`loudnormArgs second pass requires an output path, got ${JSON.stringify(output)}`);
  }
  const needs = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'];
  const m = measured;
  if (!m || typeof m !== 'object') {
    throw new Error(`loudnormArgs measured must be an object, got ${JSON.stringify(m)}`);
  }
  for (const k of needs) {
    if (typeof m[k] !== 'number' || !Number.isFinite(m[k])) {
      throw new Error(`loudnormArgs measured.${k} must be a finite number, got ${JSON.stringify(m[k])}`);
    }
  }
  const filter =
    `${base}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}` +
    `:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
  const args = ['-y', '-hide_banner', '-nostats', '-i', input, '-af', filter,
    '-ar', String(AUDIO_SAMPLE_RATE), '-ac', String(AUDIO_CHANNELS)];
  if (encode) args.push('-c:a', AUDIO_CODEC, '-b:a', AUDIO_BITRATE);
  else args.push('-c:a', 'pcm_s16le');
  args.push(output);
  return args;
}

/**
 * loudness 达标校验（纯函数，Gate #10）。
 * `|input_i - target.I| ≤ toleranceI` 且 `input_tp ≤ target.TP`。
 * @param {{measured:object, target?:{I:number,TP:number}, toleranceI?:number}} args
 * @returns {{ok:boolean, problems:string[]}}
 */
function verifyLoudness({ measured, target, toleranceI = 1 } = {}) {
  if (!measured || typeof measured !== 'object' || Array.isArray(measured)) {
    throw new Error(`verifyLoudness requires a measured object, got ${JSON.stringify(measured)}`);
  }
  if (typeof toleranceI !== 'number' || !Number.isFinite(toleranceI) || toleranceI < 0) {
    throw new Error(`verifyLoudness toleranceI must be a finite non-negative number, got ${JSON.stringify(toleranceI)}`);
  }
  const t = target || {};
  const targetI = t.I === undefined || t.I === null ? LOUDNORM_TARGET.I : t.I;
  const targetTP = t.TP === undefined || t.TP === null ? LOUDNORM_TARGET.TP : t.TP;
  const problems = [];

  const i = Number(measured.input_i);
  if (!Number.isFinite(i)) {
    problems.push(`measured input_i is not a finite number: ${JSON.stringify(measured.input_i)}`);
  } else if (!(Math.abs(i - targetI) <= toleranceI + 1e-9)) {
    problems.push(`integrated loudness ${i} LUFS is outside the target ${targetI} ± ${toleranceI} LUFS (PRD §3.9)`);
  }

  const tp = Number(measured.input_tp);
  if (!Number.isFinite(tp)) {
    problems.push(`measured input_tp is not a finite number: ${JSON.stringify(measured.input_tp)}`);
  } else if (!(tp <= targetTP + 1e-9)) {
    problems.push(`true peak ${tp} dBTP exceeds the target ${targetTP} dBTP (PRD §3.9)`);
  }

  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// ffmpeg 编排
// ---------------------------------------------------------------------------

/**
 * 第一遍 loudnorm：分析整条音频的响度。
 * `ffmpeg ... -af loudnorm=I=-14:TP=-1:LRA=11:print_format=json -f null -`
 * stderr 被重定向到临时文件（execFileSync 参数数组，无 shell），读完再解析。
 * @param {string} filePath
 * @param {{ffmpegBin?:string}} [opts]
 * @returns {{input_i:number, input_tp:number, input_lra:number, input_thresh:number, target_offset:number}}
 */
function analyzeLoudness(filePath, opts = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error(`analyzeLoudness requires a file path, got ${JSON.stringify(filePath)}`);
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`analyzeLoudness: audio file not found: ${filePath}`);
  }
  const args = loudnormArgs({ input: filePath });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loudnorm-'));
  const logPath = path.join(tmpDir, 'loudnorm.log');
  let fd = null;
  let raw = '';
  let failure = null;
  try {
    fd = fs.openSync(logPath, 'w');
    execFileSync(opts.ffmpegBin || ffmpegBin(), args, {
      stdio: ['ignore', 'ignore', fd],
      encoding: 'utf8',
    });
  } catch (e) {
    failure = e;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
    try { raw = fs.readFileSync(logPath, 'utf8'); } catch { raw = ''; }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  if (failure) {
    const detail = String(raw || failure.message || '').trim();
    throw new Error(`loudnorm analysis failed (${filePath}): ${detail.slice(-500)}`);
  }
  return parseLoudnormJson(raw);
}

/** 创建 outPath 同目录下的 `.tmp-*` 文件路径并登记清理（带扩展名以便 ffmpeg 选 muxer） */
function makeTmpFile(dir, tag, cleanup, ext = '') {
  const name = `.tmp-audio-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
  const p = path.join(dir, name);
  cleanup.push(p);
  return p;
}

/**
 * 生成 program 音轨（ffmpeg 编排，fail-closed）。
 *   1. planProgram（strict 默认 true）；
 *   2. anullsrc 静音基床（48k stereo，时长 = program 时长）→ tmp wav；
 *   3. 每个 dialogue/sfx/music 段 `atrim + adelay + volume` 后 `amix=normalize=0` 混入；
 *   4. 两遍 loudnorm（analyze → apply），第二遍直接封装 AAC 48k stereo 到 outPath；
 *   5. 返回 `{ok, outPath, duration_ms, measured, warnings, errors}`；失败抛错并清理 tmp。
 * @param {{manifest?:object, timeline?:object, epDir?:string, outPath:string, opts?:object}} args
 * @returns {{ok:boolean, outPath:string, duration_ms:number, measured:object, warnings:string[], errors:string[]}}
 */
function buildProgramAudio({ manifest, timeline, epDir, outPath, opts = {} } = {}) {
  if (typeof outPath !== 'string' || outPath.length === 0) {
    throw new Error(`buildProgramAudio requires an outPath, got ${JSON.stringify(outPath)}`);
  }
  const strict = opts.strict !== false;
  const plan = planProgram({ manifest, timeline, epDir, strict });
  if (plan.errors.length > 0) {
    throw new Error(`program audio plan failed:\n  - ${plan.errors.join('\n  - ')}`);
  }
  if (plan.duration_ms <= 0) {
    throw new Error(`program audio duration must be > 0, got ${plan.duration_ms}ms (timeline has no clips?)`);
  }

  const outDir = path.dirname(outPath);
  fs.mkdirSync(outDir, { recursive: true });
  const cleanup = [];
  const warnings = [...plan.warnings];

  try {
    // 2. 静音基床
    const baseWav = makeTmpFile(outDir, 'base', cleanup, '.wav');
    runFfmpeg(opts, [
      '-y', '-hide_banner', '-nostats',
      '-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=${AUDIO_SAMPLE_RATE}`,
      '-t', msToSecStr(plan.duration_ms),
      '-c:a', 'pcm_s16le', baseWav,
    ], `silence bed (${plan.duration_ms}ms)`);

    // 3. 混音（静音基床 + 每个段）
    const segments = plan.segments.filter((seg) => {
      const ok = typeof seg.src_path === 'string' && seg.src_path.length > 0 && fs.existsSync(seg.src_path);
      if (!ok) warnings.push(`${describeSegment(seg)}: audio source missing — skipped in the mix`);
      return ok;
    });

    // 无有效非静音样本 → 跳过 loudnorm 并 WARN（§3.6/§3.9），直接封装静音基床
    if (segments.length === 0) {
      warnings.push('loudnorm: skipped (no non-silent audio samples in the program)');
      runFfmpeg(opts, [
        '-y', '-hide_banner', '-nostats', '-i', baseWav,
        '-t', msToSecStr(plan.duration_ms),
        '-ar', String(AUDIO_SAMPLE_RATE), '-ac', String(AUDIO_CHANNELS),
        '-c:a', AUDIO_CODEC, '-b:a', AUDIO_BITRATE, outPath,
      ], `silent program → ${outPath}`);
      return {
        ok: true,
        outPath,
        duration_ms: plan.duration_ms,
        measured: { input_i: null, input_tp: null, input_lra: null, input_thresh: null, target_offset: null },
        loudnorm_skipped: true,
        warnings,
        errors: [],
      };
    }

    const mixedWav = makeTmpFile(outDir, 'mixed', cleanup, '.wav');
    mixSegments({ opts, baseWav, segments, mixedWav, durationMs: plan.duration_ms });

    // 4. 两遍 loudnorm：第一遍分析混音床 → 第二遍带 measured_* 应用（直接封装 AAC 到 outPath）
    const analysis = analyzeLoudness(mixedWav, { ffmpegBin: opts.ffmpegBin });
    const finalArgs = loudnormArgs({ input: mixedWav, output: outPath, measured: analysis, target: opts.target });
    // 夹住输出时长，抵消 AAC priming/decoder delay（program 长度不变）
    finalArgs.splice(finalArgs.length - 1, 0, '-t', msToSecStr(plan.duration_ms));
    runFfmpeg(opts, finalArgs, `loudnorm + AAC encode → ${outPath}`);

    if (!fs.existsSync(outPath)) {
      throw new Error(`ffmpeg did not produce the program audio: ${outPath}`);
    }

    // 5. 复测**最终产物**的响度（Gate #10 / verifyLoudness 的唯一数据源）
    const measured = analyzeLoudness(outPath, { ffmpegBin: opts.ffmpegBin });

    return {
      ok: true,
      outPath,
      duration_ms: plan.duration_ms,
      measured,
      warnings,
      errors: [],
    };
  } catch (e) {
    // fail-closed：不留半成品
    try { fs.rmSync(outPath, { force: true }); } catch { /* best effort */ }
    throw e;
  } finally {
    for (const p of cleanup) {
      try { fs.rmSync(p, { force: true }); } catch { /* best effort */ }
    }
  }
}

function describeSegment(seg) {
  return seg.type === 'dialogue'
    ? `dialogue segment for clip ${seg.clip_id} (take ${JSON.stringify(seg.take_id)})`
    : `${seg.kind || seg.type} cue ${seg.id}`;
}

function runFfmpeg(opts, args, label) {
  try {
    execFileSync(opts.ffmpegBin || ffmpegBin(), args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      encoding: 'utf8',
    });
  } catch (e) {
    const stderr = String((e && e.stderr) || '').trim();
    throw new Error(`ffmpeg failed (${label}): ${(stderr || (e && e.message) || 'unknown error').slice(-500)}`);
  }
}

/**
 * 把静音基床与全部段混成一条 wav（一个 ffmpeg 调用）。
 * 每段：`aformat(48k stereo) → atrim → [apad] → asetpts → adelay → volume`。
 * amix 用 `normalize=0`（按 §3.4/§3.6：不做二次归一，交叠由显式 gain 控制）。
 */
function mixSegments({ opts, baseWav, segments, mixedWav, durationMs }) {
  if (segments.length === 0) {
    runFfmpeg(opts, ['-y', '-hide_banner', '-nostats', '-i', baseWav, '-c:a', 'pcm_s16le', mixedWav], 'copy silence bed');
    return;
  }

  const inputs = ['-i', baseWav];
  const filters = [];
  const mixLabels = ['[0:a]'];
  segments.forEach((seg, idx) => {
    inputs.push('-i', seg.src_path);
    const inputIndex = idx + 1;
    const label = `[a${inputIndex}]`;
    const totalSec = msToSecStr(segmentDurationMs(seg));
    const delay = Math.max(0, Math.round(seg.at_ms));
    const gain = Number.isFinite(seg.gain_db) ? seg.gain_db : 0;
    let chain = `[${inputIndex}:a]aformat=sample_rates=${AUDIO_SAMPLE_RATE}:channel_layouts=stereo`;
    chain += `,atrim=0:${totalSec}`;
    if (typeof seg.spill_ms === 'number' && seg.spill_ms > 0) {
      // spill：尾部补静音保证跨切点后仍有确定长度的音频（program 长度仍由基床/amix 决定）
      chain += `,apad=pad_dur=${msToSecStr(seg.spill_ms)}`;
    }
    chain += `,asetpts=PTS-STARTPTS,adelay=${delay}|${delay},volume=${gain}dB${label}`;
    filters.push(chain);
    mixLabels.push(label);
  });
  filters.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:normalize=0:duration=first[aout]`);

  runFfmpeg(opts, [
    '-y', '-hide_banner', '-nostats',
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[aout]',
    '-c:a', 'pcm_s16le',
    '-t', msToSecStr(durationMs),
    mixedWav,
  ], `mix ${segments.length} segment(s) into the program bed`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage() {
  console.log('usage: node tools/audio.js <episode-dir> [--timeline <path>] [--out <path>] [--strict] [--json]');
  console.log('  §3.4/§3.9 program 音轨合成：对白/sfx/music + 两遍 loudnorm + AAC 48k stereo');
  console.log('  default timeline: <episode-dir>/timeline.json (required for v2)');
  console.log('  default out:      <episode-dir>/audio/program.m4a');
}

function main(argv) {
  const args = argv.slice(2);
  let episodeDir = null;
  let timelinePath = null;
  let outPath = null;
  let strict = false;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') json = true;
    else if (a === '--strict') strict = true;
    else if (a === '--timeline') timelinePath = args[++i];
    else if (a.startsWith('--timeline=')) timelinePath = a.slice('--timeline='.length);
    else if (a === '--out') outPath = args[++i];
    else if (a.startsWith('--out=')) outPath = a.slice('--out='.length);
    else if (a === '--help' || a === '-h') { printUsage(); return 0; }
    else if (a.startsWith('-')) { console.error(`unknown option: ${a}`); printUsage(); return 2; }
    else if (episodeDir === null) episodeDir = a;
    else { console.error(`unexpected argument: ${a}`); printUsage(); return 2; }
  }

  if (!episodeDir) { printUsage(); return 2; }
  const absEpDir = path.isAbsolute(episodeDir) ? episodeDir : path.resolve(episodeDir);

  let manifest;
  try {
    manifest = readJsonFile(path.join(absEpDir, 'manifest.json'), { label: 'manifest.json' });
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    return 2;
  }

  const resolvedTimelinePath = timelinePath
    ? (path.isAbsolute(timelinePath) ? timelinePath : path.resolve(timelinePath))
    : path.join(absEpDir, 'timeline.json');
  if (!fs.existsSync(resolvedTimelinePath)) {
    console.error(`ERROR: timeline.json not found at ${resolvedTimelinePath} (v2 program audio requires a built timeline — run tools/build-timeline.js)`);
    return 2;
  }
  let timeline;
  try {
    timeline = readJsonFile(resolvedTimelinePath, { label: 'timeline.json' });
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    return 2;
  }

  const resolvedOut = outPath
    ? (path.isAbsolute(outPath) ? outPath : path.resolve(outPath))
    : path.join(absEpDir, 'audio', 'program.m4a');

  let result;
  try {
    result = buildProgramAudio({ manifest, timeline, epDir: absEpDir, outPath: resolvedOut, opts: { strict } });
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    return 3;
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`program audio: ${result.outPath}`);
    console.log(`  duration_ms: ${result.duration_ms}`);
    console.log(`  measured: I=${result.measured.input_i} LUFS, TP=${result.measured.input_tp} dBTP, LRA=${result.measured.input_lra}`);
    console.log(`  warnings: ${result.warnings.length}`);
    for (const w of result.warnings) console.warn(`  WARN: ${w}`);
  }

  const verdict = result.loudnorm_skipped ? { ok: true, problems: [] } : verifyLoudness({ measured: result.measured });
  if (!verdict.ok) {
    console.error(`ERROR: loudness out of spec (PRD §3.9): ${verdict.problems.join('; ')}`);
    return 4;
  }
  return 0;
}

module.exports = {
  TOOL_NAME,
  TOOL_VERSION,
  AUDIO_CODEC,
  AUDIO_SAMPLE_RATE,
  AUDIO_CHANNELS,
  AUDIO_BITRATE,
  LOUDNORM_TARGET,
  SFX_EXTENSIONS,
  MUSIC_EXTENSIONS,
  frameToMs,
  dialogueSegments,
  cuePlacements,
  programDurationMs,
  planProgram,
  parseLoudnormJson,
  loudnormArgs,
  verifyLoudness,
  analyzeLoudness,
  buildProgramAudio,
  main,
};

if (require.main === module) {
  process.exitCode = main(process.argv);
}
