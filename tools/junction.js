#!/usr/bin/env node
/**
 * junction.js — PRD v2.11 §3.3 cut_join 接镜处理核心（M4b）
 *
 * 职责（全部为纯函数 / ffmpeg 参数数组）:
 *   - decideDeletedHeadFrames(ssim, thresholdS, requested = 1):
 *       SSIM ≥ S → requested(删帧),否则 0;参数非法抛错。
 *   - extractFrameAt({videoPath, frame, fps, outPath}):
 *       抽出视频第 `frame` 帧(frame 为 0-based,frame/fps 处 seek)。
 *   - compareJunctionFrames({upstreamPath, cutFrame, downstreamPath, sourceIn, fps, workDir}):
 *       抽 upstream[cutFrame-1](最后保留帧)与 downstream[sourceIn] 做 SSIM;
 *       复用 tools/e1-metrics.js 的 ssim(两侧同尺寸帧 → cover-crop 为 no-op)。
 *       允许 opts.extractFrame 注入以便单测(默认真实抽帧)。
 *   - cfrNormalizeArgs({input, output, fps, width, height}):
 *       返回 CFR 标准化 ffmpeg 参数数组(scale/pad/fps/format=yuv420p + libx264)。
 *
 * 硬约束:
 *   - 一律 `execFileSync` 参数数组调用(不拼 shell);
 *   - ffmpeg 可用 `FFMPEG_BIN` 覆盖(测试用);任一步失败抛错(fail-closed);
 *   - 半开区间语义:upstream 的「最后保留帧」= cut_frame - 1(§3.3/§3.6)。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { ssim } = require('./e1-metrics');

const TOOL_NAME = 'junction';
const TOOL_VERSION = '1.0.0';

/** CFR 标准化输出视频编码口径(与 edit/stitch 一致) */
const CFR_VIDEO_ARGS = ['-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-an', '-movflags', '+faststart'];

function ffmpegBin() {
  return process.env.FFMPEG_BIN || 'ffmpeg';
}

/**
 * 删帧判定(纯函数)。
 * `ssim >= thresholdS` → 删帧 requested(默认 1);否则 0。
 * S 只决定「删不删」,不隐含删几帧(§3.3)。
 * @param {number} ssim
 * @param {number} thresholdS
 * @param {number} [requested=1] 非负整数
 * @returns {number}
 */
function decideDeletedHeadFrames(ssim, thresholdS, requested = 1) {
  if (typeof ssim !== 'number' || !Number.isFinite(ssim)) {
    throw new Error(`ssim must be a finite number, got ${JSON.stringify(ssim)}`);
  }
  if (typeof thresholdS !== 'number' || !Number.isFinite(thresholdS)) {
    throw new Error(`same_frame_ssim_threshold must be a finite number, got ${JSON.stringify(thresholdS)}`);
  }
  if (!Number.isInteger(requested) || requested < 0) {
    throw new Error(`requested deleted_head_frames must be a non-negative integer, got ${JSON.stringify(requested)}`);
  }
  return ssim >= thresholdS ? requested : 0;
}

/**
 * 抽出视频第 `frame` 帧(frame 为 0-based;seek = frame / fps)。
 * ffmpeg -y -v error -ss <frame/fps> -i <video> -frames:v 1 <out>
 * @param {{videoPath:string, frame:number, fps:number, outPath:string}} args
 * @returns {{videoPath:string, frame:number, fps:number, seekSec:number, outPath:string}}
 */
function extractFrameAt({ videoPath, frame, fps, outPath } = {}) {
  if (!videoPath || typeof videoPath !== 'string') {
    throw new Error('extractFrameAt requires videoPath');
  }
  if (!outPath || typeof outPath !== 'string') {
    throw new Error('extractFrameAt requires outPath');
  }
  if (!Number.isInteger(frame) || frame < 0) {
    throw new Error(`extractFrameAt frame must be a non-negative integer, got ${JSON.stringify(frame)}`);
  }
  if (!Number.isInteger(fps) || fps <= 0) {
    throw new Error(`extractFrameAt fps must be a positive integer, got ${JSON.stringify(fps)}`);
  }
  if (!fs.existsSync(videoPath)) {
    throw new Error(`extractFrameAt: video not found: ${videoPath}`);
  }
  const seekSec = frame / fps;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  try {
    execFileSync(
      ffmpegBin(),
      ['-y', '-v', 'error', '-ss', String(seekSec), '-i', videoPath, '-frames:v', '1', outPath],
      { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' }
    );
  } catch (e) {
    throw new Error(`ffmpeg frame extraction failed (${videoPath} @ frame ${frame}): ${e.message}`);
  }
  if (!fs.existsSync(outPath)) {
    throw new Error(`ffmpeg did not produce frame ${frame} for ${videoPath}: ${outPath}`);
  }
  return { videoPath, frame, fps, seekSec, outPath };
}

/**
 * 接头比对:抽 upstream[cutFrame - 1] 与 downstream[sourceIn] 做 SSIM。
 * 两侧为同尺寸视频帧 → e1-metrics.ssim 的 cover-crop 为 no-op;口径与 E1 主指标一致。
 * @param {{upstreamPath:string, cutFrame:number, downstreamPath:string, sourceIn:number, fps:number, workDir?:string}} args
 * @param {{extractFrame?:Function, ssim?:Function, workDir?:string}} [opts]
 *   extractFrame/ssim 可注入以便单测(默认真实抽帧 + e1-metrics.ssim)
 * @returns {{ssim:number, upstream_frame:number, downstream_frame:number, impl:string, version:string, upstream_frame_path:string, downstream_frame_path:string}}
 */
function compareJunctionFrames({ upstreamPath, cutFrame, downstreamPath, sourceIn, fps, workDir } = {}, opts = {}) {
  if (!upstreamPath || typeof upstreamPath !== 'string') {
    throw new Error('compareJunctionFrames requires upstreamPath');
  }
  if (!downstreamPath || typeof downstreamPath !== 'string') {
    throw new Error('compareJunctionFrames requires downstreamPath');
  }
  if (!Number.isInteger(cutFrame) || cutFrame < 1) {
    throw new Error(`compareJunctionFrames cutFrame must be a positive integer, got ${JSON.stringify(cutFrame)}`);
  }
  if (!Number.isInteger(sourceIn) || sourceIn < 0) {
    throw new Error(`compareJunctionFrames sourceIn must be a non-negative integer, got ${JSON.stringify(sourceIn)}`);
  }
  if (!Number.isInteger(fps) || fps <= 0) {
    throw new Error(`compareJunctionFrames fps must be a positive integer, got ${JSON.stringify(fps)}`);
  }
  const extractFrame = typeof opts.extractFrame === 'function' ? opts.extractFrame : extractFrameAt;
  const ssimFn = typeof opts.ssim === 'function' ? opts.ssim : ssim;
  const dir = workDir || opts.workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'junction-'));
  fs.mkdirSync(dir, { recursive: true });

  const upstreamFrame = cutFrame - 1;
  const upstreamFramePath = path.join(dir, `upstream-frame-${upstreamFrame}.png`);
  const downstreamFramePath = path.join(dir, `downstream-frame-${sourceIn}.png`);
  extractFrame({ videoPath: upstreamPath, frame: upstreamFrame, fps, outPath: upstreamFramePath });
  extractFrame({ videoPath: downstreamPath, frame: sourceIn, fps, outPath: downstreamFramePath });

  const res = ssimFn(upstreamFramePath, downstreamFramePath);
  return {
    ssim: res.value,
    upstream_frame: upstreamFrame,
    downstream_frame: sourceIn,
    impl: res.impl,
    version: res.version,
    upstream_frame_path: upstreamFramePath,
    downstream_frame_path: downstreamFramePath
  };
}

/**
 * CFR 标准化参数数组(纯函数):强制帧率 + yuv420p + 统一像素格式,
 * 保证「删 1 帧」的时长确定(§3.3)。
 * @param {{input:string, output:string, fps:number, width:number, height:number}} args
 * @returns {string[]}
 */
function cfrNormalizeArgs({ input, output, fps, width, height } = {}) {
  if (!input || typeof input !== 'string') {
    throw new Error('cfrNormalizeArgs requires input');
  }
  if (!output || typeof output !== 'string') {
    throw new Error('cfrNormalizeArgs requires output');
  }
  if (!Number.isInteger(fps) || fps <= 0) {
    throw new Error(`cfrNormalizeArgs fps must be a positive integer, got ${JSON.stringify(fps)}`);
  }
  for (const [name, value] of [['width', width], ['height', height]]) {
    if (!Number.isInteger(value) || value <= 0 || value % 2 !== 0) {
      throw new Error(`cfrNormalizeArgs ${name} must be a positive even integer, got ${JSON.stringify(value)}`);
    }
  }
  const filter =
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,` +
    `fps=${fps},format=yuv420p`;
  return ['-y', '-i', input, '-vf', filter, ...CFR_VIDEO_ARGS, output];
}

module.exports = {
  TOOL_NAME,
  TOOL_VERSION,
  CFR_VIDEO_ARGS,
  decideDeletedHeadFrames,
  extractFrameAt,
  compareJunctionFrames,
  cfrNormalizeArgs
};
