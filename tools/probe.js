#!/usr/bin/env node
/**
 * probe.js — PRD v2.11 §4 「final 媒体属性探测 + 完整解码验证」两步（M5b，TECH-DEBT A6）
 *
 * 第一步（媒体属性探测）：ffprobe 读取 streams/format（resolution / FPS / pixel format /
 *   video codec / audio codec / sample rate / channels / duration）；v2 任一项与 §3.9 或
 *   episode 模板不符 → 失败；v1 仅校验「视频流存在 + 容器可识别」（保留 v1 模板口径）。
 * 第二步（完整解码验证）：`ffmpeg -v error -i <final> -f null -`（视频+音频全解码）；
 *   退出码非 0、超时、或任何解码 error 输出 → 失败。两步都通过才计「可解码」。
 *
 * 音频规格（§3.9 固定）：AAC / 48000 Hz / stereo。豁免由 `intent.*` 显式声明决定
 * （写死）：`intentFlags(intent).requires_audio === false`（`audio: none`）或 v1 → 跳过
 * 全部音频规格检查（即使实际存在音轨也不报错）。
 *
 * 硬约束：
 *   - 一律 `execFileSync` 参数数组调用（不拼 shell）；
 *   - ffmpeg/ffprobe 可经 `FFMPEG_BIN` / `FFPROBE_BIN` 覆盖（测试用）；
 *   - 探测/解码失败 fail-closed，不产出半成品结论；
 *   - 纯函数（parseProbeJson / expectedVideoSpec / checkMediaSpec / checkAvLength）可单测，
 *     真实调用（probeMedia / verifyDecode）可经 `opts` 注入以便离线单测。
 *
 * CLI：`node tools/probe.js <file> [--manifest <manifest.json>] [--json]`
 *   打印两步结构（文本或 JSON）；探测/解码失败退出码非零。
 */
'use strict';
const fs = require('fs');
const { execFileSync } = require('child_process');
const { intentFlags } = require('./intent');

const TOOL_NAME = 'probe';
const TOOL_VERSION = '1.0.0';

/** §3.9 音频输出规格（写死） */
const AUDIO_CODEC = 'aac';
const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_CHANNELS = 2;
/** v2 pixel format（写死） */
const PIX_FMT = 'yuv420p';
/** FPS 允许误差（严格小于） */
const FPS_TOLERANCE = 0.5;
/** A/V 流长度允许误差（严格小于，PRD §5 Gate #8 为 100ms） */
const AV_LENGTH_TOLERANCE = 0.1;
/** 解码验证默认超时 */
const DEFAULT_DECODE_TIMEOUT_MS = 600000;

/** 支持的画面比例（宽:高）；不在表内 fail-closed（§3.7 / episode 模板） */
const SUPPORTED_RATIOS = ['16:9', '9:16', '1:1', '4:5', '3:4', '4:3', '21:9'];
/** 支持的短线分辨率；不在表内 fail-closed */
const SUPPORTED_RESOLUTIONS = ['240p', '360p', '480p', '540p', '576p', '720p', '1080p', '1440p', '2160p'];

function ffmpegBin() {
  return process.env.FFMPEG_BIN || 'ffmpeg';
}

function ffprobeBin() {
  return process.env.FFPROBE_BIN || 'ffprobe';
}

/** 数值字符串 → number；null/NaN/Infinity → null */
function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

/** 整数字符串 → int；非法 → null */
function toIntegerOrNull(value) {
  const n = toNumberOrNull(value);
  return n === null || !Number.isInteger(n) ? null : n;
}

/**
 * 解析 ffprobe 的分数帧率（如 `30000/1001`）。`0/0`、非法、缺失 → null。
 * 纯数字字符串按数字解析。
 * @param {*} value
 * @returns {number|null}
 */
function parseFraction(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  if (s.includes('/')) {
    const parts = s.split('/');
    if (parts.length !== 2) return null;
    const num = Number(parts[0].trim());
    const den = Number(parts[1].trim());
    if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
    const v = num / den;
    return Number.isFinite(v) ? v : null;
  }
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

/**
 * 解析 `ffprobe -print_format json -show_format -show_streams` 的输出。
 * @param {string|object} raw JSON 字符串或已解析对象
 * @returns {{video:{codec,width,height,fps,pix_fmt,duration}|null,
 *            audio:{codec,sample_rate,channels,duration}|null,
 *            format:{format_name,duration}}}
 */
function parseProbeJson(raw) {
  let doc = raw;
  if (typeof raw === 'string') {
    try {
      doc = JSON.parse(raw);
    } catch (e) {
      throw new Error(`ffprobe JSON parse failed: ${e.message}`);
    }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`ffprobe JSON must be an object, got ${JSON.stringify(raw)}`);
  }
  const streams = Array.isArray(doc.streams) ? doc.streams : [];
  const videoStream = streams.find((s) => s && s.codec_type === 'video') || null;
  const audioStream = streams.find((s) => s && s.codec_type === 'audio') || null;
  const format = doc.format && typeof doc.format === 'object' ? doc.format : {};

  const avg = videoStream ? videoStream.avg_frame_rate : null;
  let fps = null;
  if (avg !== null && avg !== undefined && avg !== '') {
    fps = parseFraction(avg);
  } else if (videoStream) {
    fps = parseFraction(videoStream.r_frame_rate);
  }

  return {
    video: videoStream ? {
      codec: videoStream.codec_name != null ? videoStream.codec_name : null,
      width: toIntegerOrNull(videoStream.width),
      height: toIntegerOrNull(videoStream.height),
      fps,
      pix_fmt: videoStream.pix_fmt != null ? videoStream.pix_fmt : null,
      duration: toNumberOrNull(videoStream.duration),
    } : null,
    audio: audioStream ? {
      codec: audioStream.codec_name != null ? audioStream.codec_name : null,
      sample_rate: toIntegerOrNull(audioStream.sample_rate),
      channels: toIntegerOrNull(audioStream.channels),
      duration: toNumberOrNull(audioStream.duration),
    } : null,
    format: {
      format_name: format.format_name == null ? null : String(format.format_name),
      duration: toNumberOrNull(format.duration),
    },
  };
}

/**
 * 用 ffprobe 探测本地媒体文件（第一步的原始读取）。
 * 失败（文件缺失 / ffprobe 非零退出 / 输出不可解析）一律抛错（含 stderr 摘要）。
 * @param {string} filePath
 * @param {{ffprobeBin?:string, timeoutMs?:number}} [opts]
 * @returns {{video:object|null, audio:object|null, format:object}}
 */
function probeMedia(filePath, opts = {}) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error(`probeMedia requires a media path, got ${JSON.stringify(filePath)}`);
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`media file not found for probing: ${filePath}`);
  }
  const bin = opts.ffprobeBin || ffprobeBin();
  let out;
  try {
    out = execFileSync(
      bin,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        timeout: opts.timeoutMs || undefined,
      }
    );
  } catch (e) {
    const stderr = String((e && e.stderr) || '').trim();
    const detail = stderr || (e && e.message) || 'unknown error';
    throw new Error(`ffprobe failed for ${filePath}: ${detail}`);
  }
  return parseProbeJson(out);
}

/** 偶数化（Math.round 后），并保证 ≥ 2 */
function evenDimension(value) {
  let v = Math.round(value);
  if (!Number.isFinite(v) || v < 2) v = 2;
  if (v % 2 !== 0) v += 1;
  return v;
}

/** 解析并校验 ratio（fail-closed） */
function resolveRatio(ratio) {
  if (typeof ratio !== 'string' || !SUPPORTED_RATIOS.includes(ratio)) {
    throw new Error(`unsupported template.ratio: ${JSON.stringify(ratio)} (supported: ${SUPPORTED_RATIOS.join(', ')})`);
  }
  const [w, h] = ratio.split(':').map(Number);
  return { width: w, height: h, value: w / h };
}

/** 解析并校验 resolution（fail-closed） */
function resolveResolution(resolution) {
  if (typeof resolution !== 'string' || !SUPPORTED_RESOLUTIONS.includes(resolution)) {
    throw new Error(`unsupported template.resolution: ${JSON.stringify(resolution)} (supported: ${SUPPORTED_RESOLUTIONS.join(', ')})`);
  }
  return Number(resolution.replace(/p$/, ''));
}

/**
 * 由 episode 模板算期望视频规格（纯函数，fail-closed）。
 * `resolution` 数字为**短边**：横屏（ratio ≥ 1）→ 高度，竖屏 → 宽度（720p/9:16 → 720×1280）。
 * `template.width`/`template.height` 显式给出时优先（两者都给则直接用，不推算）。
 * @param {{template?:object, fps?:number}} [args]
 * @returns {{width:number, height:number, fps:number|null, pix_fmt:string}}
 */
function expectedVideoSpec({ template, fps } = {}) {
  const t = template || {};
  const explicitW = t.width != null ? t.width : null;
  const explicitH = t.height != null ? t.height : null;
  const hasW = explicitW !== null;
  const hasH = explicitH !== null;

  if (hasW && (!Number.isInteger(explicitW) || explicitW <= 0)) {
    throw new Error(`template.width must be a positive integer, got ${JSON.stringify(explicitW)}`);
  }
  if (hasH && (!Number.isInteger(explicitH) || explicitH <= 0)) {
    throw new Error(`template.height must be a positive integer, got ${JSON.stringify(explicitH)}`);
  }

  let width;
  let height;
  if (hasW && hasH) {
    width = explicitW;
    height = explicitH;
  } else if (hasW) {
    const ratio = resolveRatio(t.ratio);
    width = explicitW;
    height = evenDimension(explicitW / ratio.value);
  } else if (hasH) {
    const ratio = resolveRatio(t.ratio);
    height = explicitH;
    width = evenDimension(explicitH * ratio.value);
  } else {
    const ratio = resolveRatio(t.ratio);
    const res = resolveResolution(t.resolution);
    if (ratio.value >= 1) {
      height = res;
      width = evenDimension(res * ratio.value);
    } else {
      width = res;
      height = evenDimension(res / ratio.value);
    }
  }

  const expectedFps = fps != null ? fps : (t.fps != null ? t.fps : null);
  return { width, height, fps: expectedFps, pix_fmt: PIX_FMT };
}

/**
 * 媒体属性检查（纯函数）。
 * v1（schemaVersion===1 或缺失）：仅要求 video 流存在 + 容器可识别（不校验分辨率/FPS/
 *   pix_fmt/音频）。v2：宽高 = 期望、FPS 差 < 0.5、pix_fmt=yuv420p；`requires_audio` 为真
 *   → 校验 audio 流存在 + AAC/48000/2；为假 → 跳过全部音频规格检查。
 * @param {object} probe parseProbeJson 的产物
 * @param {{schemaVersion?:number, template?:object, intent?:object, fps?:number}} [args]
 * @returns {string[]} problems（空数组 = 通过）
 */
function checkMediaSpec(probe, { schemaVersion, template, intent, fps } = {}) {
  const problems = [];
  const p = probe || {};
  const video = p.video || null;
  const isV1 = schemaVersion == null || Number(schemaVersion) === 1;

  if (!video) {
    problems.push('video stream missing: final must contain a decodable video stream');
  }
  const formatName = p.format && p.format.format_name;
  if (typeof formatName !== 'string' || formatName.trim() === '') {
    problems.push(`unrecognized container: format.format_name is ${JSON.stringify(formatName)}`);
  }

  if (isV1) return problems;

  if (video) {
    let expected = null;
    try {
      expected = expectedVideoSpec({ template, fps });
    } catch (e) {
      problems.push(`cannot derive expected video spec: ${e.message}`);
    }
    if (expected) {
      if (video.width !== expected.width) {
        problems.push(`width mismatch: measured ${JSON.stringify(video.width)}, expected ${expected.width}`);
      }
      if (video.height !== expected.height) {
        problems.push(`height mismatch: measured ${JSON.stringify(video.height)}, expected ${expected.height}`);
      }
      if (expected.fps != null) {
        if (video.fps == null || !(Math.abs(video.fps - expected.fps) < FPS_TOLERANCE)) {
          problems.push(`fps mismatch: measured ${JSON.stringify(video.fps)}, expected ${expected.fps} (±${FPS_TOLERANCE})`);
        }
      }
      if (video.pix_fmt !== PIX_FMT) {
        problems.push(`pix_fmt mismatch: measured ${JSON.stringify(video.pix_fmt)}, expected ${PIX_FMT}`);
      }
    }
  }

  if (intentFlags(intent).requires_audio === true) {
    const audio = p.audio || null;
    if (!audio) {
      problems.push(`audio stream missing: requires_audio is true (${JSON.stringify(intent && intent.audio)})`);
    } else {
      if (audio.codec !== AUDIO_CODEC) {
        problems.push(`audio codec mismatch: measured ${JSON.stringify(audio.codec)}, expected ${AUDIO_CODEC}`);
      }
      if (audio.sample_rate !== AUDIO_SAMPLE_RATE) {
        problems.push(`audio sample_rate mismatch: measured ${JSON.stringify(audio.sample_rate)}, expected ${AUDIO_SAMPLE_RATE}`);
      }
      if (audio.channels !== AUDIO_CHANNELS) {
        problems.push(`audio channels mismatch: measured ${JSON.stringify(audio.channels)}, expected ${AUDIO_CHANNELS}`);
      }
    }
  }

  return problems;
}

/**
 * 第二步：完整解码验证（视频+音频全解码）。
 * `ffmpeg -v error -i <file> -f null -`；退出码非 0、超时、或任何 error 输出 → ok=false。
 * 不抛错（失败以返回值表达）。
 * @param {string} filePath
 * @param {{timeoutMs?:number, ffmpegBin?:string}} [opts]
 * @returns {{ok:boolean, exitCode:number|null, timedOut:boolean, stderrTail:string}}
 */
function verifyDecode(filePath, { timeoutMs = DEFAULT_DECODE_TIMEOUT_MS, ffmpegBin: bin } = {}) {
  let exitCode = null;
  let stderr = '';
  let timedOut = false;
  try {
    const out = execFileSync(
      bin || ffmpegBin(),
      ['-v', 'error', '-i', filePath, '-f', 'null', '-'],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: timeoutMs }
    );
    exitCode = 0;
    stderr = out == null ? '' : String(out);
  } catch (e) {
    exitCode = e && typeof e.status === 'number' ? e.status : null;
    timedOut = !!(e && (e.code === 'ETIMEDOUT' || e.signal != null));
    stderr = e && e.stderr != null ? String(e.stderr) : '';
  }
  const trimmed = stderr.trim();
  const ok = !timedOut && exitCode === 0 && trimmed === '';
  const stderrTail = trimmed.length > 2000 ? trimmed.slice(-2000) : trimmed;
  return { ok, exitCode, timedOut, stderrTail };
}

/**
 * A/V 最终流长度误差（纯函数，PRD §5 Gate #8，严格 < 0.1s）。
 * `requires_audio` 为真且 audio 存在 → 比较视频/音频时长；否则只要求 video duration > 0
 * （`audio: none` 或 v1 无音轨 → 只校验视频流）。
 * @param {object} probe
 * @param {{schemaVersion?:number, intent?:object}} [args]
 * @returns {string[]}
 */
function checkAvLength(probe, { schemaVersion: _schemaVersion, intent } = {}) {
  const problems = [];
  const p = probe || {};
  const video = p.video || null;
  const audio = p.audio || null;
  const requiresAudio = intentFlags(intent).requires_audio === true;

  if (!video || video.duration == null || !(video.duration > 0)) {
    problems.push(`video duration must be a positive number, got ${JSON.stringify(video && video.duration)}`);
    return problems;
  }

  if (requiresAudio && audio) {
    if (audio.duration == null) {
      problems.push('audio duration missing: cannot verify A/V length');
      return problems;
    }
    const diff = Math.abs(video.duration - audio.duration);
    if (!(diff < AV_LENGTH_TOLERANCE)) {
      problems.push(
        `A/V duration mismatch: video ${video.duration}s, audio ${audio.duration}s, ` +
        `diff ${diff.toFixed(3)}s >= ${AV_LENGTH_TOLERANCE}s`
      );
    }
  }

  return problems;
}

/**
 * 完整 two-step 校验：probe → spec → decode → av_length。
 * 任一步失败短路后续（后续步骤 `{ok:false, skipped:true}`）并汇总 problems。
 * @param {{finalPath:string, manifest?:object, template?:object, intent?:object,
 *          schemaVersion?:number, opts?:object}} [args]
 * @returns {{ok:boolean, probe:object|null, steps:object, problems:string[]}}
 */
function verifyFinalMedia({ finalPath, manifest, template, intent, schemaVersion, opts = {} } = {}) {
  const m = manifest || {};
  const resolvedTemplate = template != null
    ? template
    : { ratio: m.ratio, resolution: m.resolution, ...(m.fps != null ? { fps: m.fps } : {}) };
  const resolvedIntent = intent != null ? intent : m.intent;
  const resolvedSchemaVersion = schemaVersion != null
    ? schemaVersion
    : (m.schema_version != null ? m.schema_version : 1);
  const resolvedFps = opts.fps != null
    ? opts.fps
    : (m.fps != null ? m.fps : (resolvedTemplate && resolvedTemplate.fps != null ? resolvedTemplate.fps : null));

  const probeFn = typeof opts.probeMedia === 'function' ? opts.probeMedia : probeMedia;
  const decodeFn = typeof opts.verifyDecode === 'function' ? opts.verifyDecode : verifyDecode;

  const steps = {
    probe: { ok: false, error: null },
    spec: { ok: false, problems: [] },
    decode: { ok: false },
    av_length: { ok: false, problems: [] },
  };
  const problems = [];

  let probe = null;
  try {
    probe = probeFn(finalPath, opts.probeOpts || {});
    steps.probe = { ok: true, error: null };
  } catch (e) {
    const message = (e && e.message) || String(e);
    steps.probe = { ok: false, error: message };
    steps.spec = { ok: false, skipped: true, problems: [] };
    steps.decode = { ok: false, skipped: true };
    steps.av_length = { ok: false, skipped: true, problems: [] };
    problems.push(`probe failed: ${message}`);
    return { ok: false, probe: null, steps, problems };
  }

  const specProblems = checkMediaSpec(probe, {
    schemaVersion: resolvedSchemaVersion,
    template: resolvedTemplate,
    intent: resolvedIntent,
    fps: resolvedFps,
  });
  steps.spec = { ok: specProblems.length === 0, problems: specProblems };
  if (specProblems.length > 0) {
    for (const p of specProblems) problems.push(`spec: ${p}`);
    steps.decode = { ok: false, skipped: true };
    steps.av_length = { ok: false, skipped: true, problems: [] };
    return { ok: false, probe, steps, problems };
  }

  const decoded = decodeFn(finalPath, opts.decodeOpts || {});
  steps.decode = Object.assign({ ok: !!decoded.ok }, decoded);
  if (!steps.decode.ok) {
    const detail = decoded.timedOut
      ? 'timed out'
      : `exitCode=${JSON.stringify(decoded.exitCode)}${decoded.stderrTail ? ` stderr=${JSON.stringify(decoded.stderrTail)}` : ''}`;
    problems.push(`decode failed: ${detail}`);
    steps.av_length = { ok: false, skipped: true, problems: [] };
    return { ok: false, probe, steps, problems };
  }

  const avProblems = checkAvLength(probe, { schemaVersion: resolvedSchemaVersion, intent: resolvedIntent });
  steps.av_length = { ok: avProblems.length === 0, problems: avProblems };
  if (avProblems.length > 0) {
    for (const p of avProblems) problems.push(`av_length: ${p}`);
    return { ok: false, probe, steps, problems };
  }

  return { ok: true, probe, steps, problems };
}

function printUsage() {
  console.log('usage: node tools/probe.js <file> [--manifest <manifest.json>] [--json]');
  console.log('  final 两步校验：媒体属性探测（§4）+ 完整解码验证（§4，M5b）');
}

function formatText(result, filePath) {
  const lines = [];
  lines.push(`final: ${filePath}`);
  lines.push(`probe: ${result.steps.probe.ok ? 'ok' : `FAILED (${result.steps.probe.error})`}`);
  if (result.steps.spec.skipped) {
    lines.push('spec: skipped');
  } else {
    lines.push(`spec: ${result.steps.spec.ok ? 'ok' : 'FAILED'}`);
    for (const p of result.steps.spec.problems) lines.push(`  - ${p}`);
  }
  if (result.steps.decode.skipped) {
    lines.push('decode: skipped');
  } else {
    lines.push(`decode: ${result.steps.decode.ok ? 'ok' : `FAILED (exitCode=${result.steps.decode.exitCode}, timedOut=${result.steps.decode.timedOut})`}`);
    if (result.steps.decode.stderrTail) lines.push(`  stderr: ${result.steps.decode.stderrTail}`);
  }
  if (result.steps.av_length.skipped) {
    lines.push('av_length: skipped');
  } else {
    lines.push(`av_length: ${result.steps.av_length.ok ? 'ok' : 'FAILED'}`);
    for (const p of result.steps.av_length.problems) lines.push(`  - ${p}`);
  }
  lines.push(`result: ${result.ok ? 'OK (decodable)' : 'FAILED'}`);
  return lines.join('\n');
}

function main(argv) {
  const args = argv.slice(2);
  let file = null;
  let manifestPath = null;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') json = true;
    else if (a === '--manifest') manifestPath = args[++i];
    else if (a.startsWith('--manifest=')) manifestPath = a.slice('--manifest='.length);
    else if (a === '--help' || a === '-h') { printUsage(); return 0; }
    else if (a.startsWith('-')) { console.error(`unknown option: ${a}`); printUsage(); return 2; }
    else if (file === null) file = a;
    else { console.error(`unexpected argument: ${a}`); printUsage(); return 2; }
  }
  if (!file) { printUsage(); return 2; }

  let manifest = null;
  if (manifestPath) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      console.error(`cannot read manifest ${manifestPath}: ${e.message}`);
      return 2;
    }
  }

  const result = verifyFinalMedia({ finalPath: file, manifest: manifest || {} });
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatText(result, file));
  return result.ok ? 0 : 1;
}

module.exports = {
  TOOL_NAME,
  TOOL_VERSION,
  AUDIO_CODEC,
  AUDIO_SAMPLE_RATE,
  AUDIO_CHANNELS,
  PIX_FMT,
  FPS_TOLERANCE,
  AV_LENGTH_TOLERANCE,
  DEFAULT_DECODE_TIMEOUT_MS,
  SUPPORTED_RATIOS,
  SUPPORTED_RESOLUTIONS,
  parseProbeJson,
  probeMedia,
  expectedVideoSpec,
  checkMediaSpec,
  verifyDecode,
  checkAvLength,
  verifyFinalMedia,
  formatText,
  main,
};

if (require.main === module) {
  process.exit(main(process.argv));
}
