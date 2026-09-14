#!/usr/bin/env node
/**
 * cover.js — PRD §4 封面帧解析与生成（M3 纯函数 + M5-SUB 产物）
 *
 * `resolveCover(manifest, timeline)` 按写死优先级返回封面来源：
 *   1. `cover.clip_id` 指定最终时间线中的 clip：
 *      a. 该 clip 的 video take 记录了 `keyframe` 绑定(take.keyframe.take_id)
 *         → 用绑定的 selected keyframe take 文件(不得用 shot 当前 selected keyframe)；
 *      b. 否则取该 clip 的**实际首帧** = `source_in + deleted_head_frames`(clip 实例口径)；
 *   2. `cover.promo_asset` → 直接使用该路径(不入 input_hash / 时间线)；
 *   3. 都没有 → `{ ok:false, error }`(final 时失败,Release Gate #11)。
 *
 * `generateCover({manifest, timeline, epDir, outPath, opts})`（M5-SUB）按 `resolveCover` 结果产 PNG：
 *   - `keyframe`    → keyframe 文件转 PNG（ffmpeg 单帧）；
 *   - `first_frame` → 从 take 视频按 `frame = source_in + deleted_head_frames` 抽帧（`-ss frame/fps`，fps 取 manifest.fps）；
 *   - `promo_asset` → 拷贝/转码为 PNG。
 *   失败抛错并清理半成品；`opts.extractFrame` / `opts.runFfmpeg` 可注入以便单测。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { absTakePath } = require('./approvals');
const { extractFrameAt } = require('./junction');

const TOOL_NAME = 'cover';
const TOOL_VERSION = '1.1.0';

function extractClips(timeline) {
  if (!timeline) return [];
  if (Array.isArray(timeline)) return timeline;
  if (Array.isArray(timeline.clips)) return timeline.clips;
  return [];
}

/**
 * @param {object} manifest
 * @param {object|Array} timeline  timeline.json(含 clips[])或 clip 数组
 * @returns {{ok:true, kind:string, path:string|null, [k:string]:any}|{ok:false, error:string}}
 */
function resolveCover(manifest, timeline) {
  const cover = (manifest && manifest.cover) || {};
  const clips = extractClips(timeline);

  if (cover.clip_id) {
    const clip = clips.find(c => c && c.clip_id === cover.clip_id);
    if (!clip) {
      return { ok: false, error: `cover.clip_id ${cover.clip_id} not found in timeline — fix the cover config or rebuild the timeline` };
    }
    const shot = ((manifest && manifest.shots) || []).find(s => s && s.id === clip.shot_id);
    if (!shot) {
      return { ok: false, error: `cover clip ${clip.clip_id} references unknown shot ${clip.shot_id}` };
    }
    const take = (shot.takes || []).find(t => t && t.id === clip.take_id);
    if (!take) {
      return { ok: false, error: `cover clip ${clip.clip_id} references unknown video take ${clip.take_id} for shot ${clip.shot_id}` };
    }
    // 1a. 该 video take 绑定的 keyframe(生成该视频时的 first_frame 来源)
    if (take.keyframe && take.keyframe.take_id) {
      const kf = (shot.keyframe_takes || []).find(t => t && t.id === take.keyframe.take_id);
      const kfPath = (kf && kf.path) || take.keyframe.frozen_path || null;
      if (!kfPath) {
        return { ok: false, error: `cover clip ${clip.clip_id}: keyframe binding ${take.keyframe.take_id} has no usable file` };
      }
      return {
        ok: true,
        kind: 'keyframe',
        path: kfPath,
        clip_id: clip.clip_id,
        take_id: take.id,
        keyframe_take_id: take.keyframe.take_id,
        content_digest: take.keyframe.content_digest || null
      };
    }
    // 1b. 实际首帧(source_in + deleted_head_frames;删帧不改写 source_in)
    const frame = (Number.isInteger(clip.source_in) ? clip.source_in : 0)
      + (Number.isInteger(clip.deleted_head_frames) ? clip.deleted_head_frames : 0);
    return {
      ok: true,
      kind: 'first_frame',
      path: take.path || null,
      clip_id: clip.clip_id,
      take_id: take.id,
      frame
    };
  }

  if (cover.promo_asset) {
    return { ok: true, kind: 'promo_asset', path: cover.promo_asset, in_hash: false };
  }

  return { ok: false, error: 'no cover configured: set cover.clip_id (timeline clip) or cover.promo_asset (standalone promo asset) — PRD §4/§5 gate 11' };
}

// ---------------------------------------------------------------------------
// 生成（M5-SUB）
// ---------------------------------------------------------------------------

function ffmpegBin(opts = {}) {
  return opts.ffmpegBin || process.env.FFMPEG_BIN || 'ffmpeg';
}

/** 执行 ffmpeg（`opts.runFfmpeg` 可注入；默认 execFileSync 参数数组，无 shell） */
function runFfmpegImpl(opts, args, label, outPath) {
  if (typeof opts.runFfmpeg === 'function') {
    opts.runFfmpeg({ args, label, outPath, ffmpegBin: ffmpegBin(opts) });
    return;
  }
  try {
    execFileSync(ffmpegBin(opts), args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      encoding: 'utf8',
    });
  } catch (e) {
    const stderr = String((e && e.stderr) || '').trim();
    throw new Error(`ffmpeg failed (${label}): ${(stderr || (e && e.message) || 'unknown error').slice(-500)}`);
  }
}

function resolveFps(manifest, timeline) {
  const candidates = [manifest && manifest.fps, timeline && timeline.fps];
  for (const c of candidates) {
    if (Number.isInteger(c) && c > 0) return c;
  }
  return null;
}

/**
 * 按 `resolveCover` 结果生成封面 PNG（PRD §4/§5 #11）。
 * @param {{manifest?:object, timeline?:object, epDir?:string, outPath?:string, opts?:object}} args
 *   opts.extractFrame({videoPath, frame, fps, outPath}) 注入 first_frame 抽帧
 *   opts.runFfmpeg({args, label, outPath, ffmpegBin})    注入 keyframe/promo 转码
 * @returns {{ok:boolean, outPath:string, kind:string, frame?:number, warnings:string[]}}
 */
function generateCover({ manifest, timeline, epDir, outPath, opts = {} } = {}) {
  const dest = outPath || (epDir ? path.join(epDir, 'cover.png') : null);
  if (typeof dest !== 'string' || dest.length === 0) {
    throw new Error('generateCover requires outPath (or epDir for the default <episode-dir>/cover.png)');
  }
  const res = resolveCover(manifest, timeline);
  if (!res || !res.ok) {
    throw new Error(res && res.error ? res.error : 'cover could not be resolved (no cover configured)');
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const warnings = [];
  try {
    if (res.kind === 'keyframe') {
      const src = absTakePath(res.path);
      if (!src || !fs.existsSync(src)) throw new Error(`cover keyframe file missing/unreadable: ${res.path || '(null)'}`);
      runFfmpegImpl(opts, ['-y', '-i', src, '-frames:v', '1', '-update', '1', dest], `cover keyframe → ${dest}`, dest);
    } else if (res.kind === 'first_frame') {
      const src = absTakePath(res.path);
      if (!src || !fs.existsSync(src)) throw new Error(`cover first_frame video missing/unreadable: ${res.path || '(null)'}`);
      const fps = resolveFps(manifest, timeline);
      if (!fps) throw new Error('generateCover first_frame requires fps (manifest.fps or timeline.fps)');
      const extractor = typeof opts.extractFrame === 'function' ? opts.extractFrame : extractFrameAt;
      extractor({ videoPath: src, frame: res.frame, fps, outPath: dest });
    } else if (res.kind === 'promo_asset') {
      const src = absTakePath(res.path);
      if (!src || !fs.existsSync(src)) throw new Error(`cover promo_asset file missing/unreadable: ${res.path || '(null)'}`);
      if (path.extname(src).toLowerCase() === '.png') {
        fs.copyFileSync(src, dest);
      } else {
        runFfmpegImpl(opts, ['-y', '-i', src, '-frames:v', '1', '-update', '1', dest], `cover promo_asset → ${dest}`, dest);
      }
    } else {
      throw new Error(`unknown cover kind: ${res.kind}`);
    }

    if (!fs.existsSync(dest)) {
      throw new Error(`cover generation did not produce: ${dest}`);
    }
    const out = { ok: true, outPath: dest, kind: res.kind, warnings };
    if (res.frame !== undefined) out.frame = res.frame;
    return out;
  } catch (e) {
    try { fs.rmSync(dest, { force: true }); } catch { /* best effort */ }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage() {
  console.log('usage: node tools/cover.js <episode-dir> [--timeline <path>] [--out <path>] [--json]');
  console.log('  PRD §4/§5 #11 封面帧生成：keyframe → PNG / 实际首帧 source_in+deleted_head_frames / promo_asset');
  console.log('  default timeline: <episode-dir>/timeline.json');
  console.log('  default out:      <episode-dir>/cover.png');
}

function main(argv) {
  const args = argv.slice(2);
  let episodeDir = null;
  let timelinePath = null;
  let outPath = null;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') json = true;
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
    manifest = JSON.parse(fs.readFileSync(path.join(absEpDir, 'manifest.json'), 'utf8'));
  } catch (e) {
    console.error(`ERROR: cannot read manifest.json: ${e.message}`);
    return 2;
  }

  const resolvedTimelinePath = timelinePath
    ? (path.isAbsolute(timelinePath) ? timelinePath : path.resolve(timelinePath))
    : path.join(absEpDir, 'timeline.json');
  let timeline = null;
  if (fs.existsSync(resolvedTimelinePath)) {
    try {
      timeline = JSON.parse(fs.readFileSync(resolvedTimelinePath, 'utf8'));
    } catch (e) {
      console.error(`ERROR: cannot read timeline.json: ${e.message}`);
      return 2;
    }
  }

  const resolvedOut = outPath
    ? (path.isAbsolute(outPath) ? outPath : path.resolve(outPath))
    : path.join(absEpDir, 'cover.png');

  let result;
  try {
    result = generateCover({ manifest, timeline, epDir: absEpDir, outPath: resolvedOut });
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    return 3;
  }

  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(`cover (${result.kind}): ${result.outPath}`);
  return 0;
}

module.exports = {
  TOOL_NAME,
  TOOL_VERSION,
  resolveCover,
  generateCover,
  main,
};

if (require.main === module) {
  process.exitCode = main(process.argv);
}
