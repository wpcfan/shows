#!/usr/bin/env node
/**
 * tail-frame.js — PRD v2.11 §3.3/M4a 上游尾帧抽取(continue_from 的视觉参考)
 *
 * 纯工具模块(无 CLI):
 *   - probeDurationSec(videoPath):ffprobe 取视频时长(秒);
 *   - extractTailFrame({videoPath, offsetFrames, fps, outPath}):
 *       seek = max(0, duration + offsetFrames / fps)
 *       ffmpeg -y -v error -ss <seek> -i <video> -frames:v 1 <out>
 *
 * 硬约束:
 *   - 一律 `execFileSync` 参数数组调用(不拼 shell);
 *   - ffprobe/ffmpeg 可用 `FFPROBE_BIN` / `FFMPEG_BIN` 覆盖(测试用);
 *   - 任一步失败抛错(fail-closed),不产出半成品路径。
 *
 * continue_from 是**弱承诺**:尾帧只作为 keyframe 的参考输入,
 * 不触发任何截断/删帧/时长调整(截断仅由 cut_join 接头决定)。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function ffmpegBin() {
  return process.env.FFMPEG_BIN || 'ffmpeg';
}

function ffprobeBin() {
  return process.env.FFPROBE_BIN || 'ffprobe';
}

/**
 * 用 ffprobe 读取视频时长(秒)。失败或非有限正数 → 抛错。
 * @param {string} videoPath
 * @returns {number}
 */
function probeDurationSec(videoPath) {
  if (!videoPath || typeof videoPath !== 'string') {
    throw new Error(`probeDurationSec requires a video path, got ${JSON.stringify(videoPath)}`);
  }
  if (!fs.existsSync(videoPath)) {
    throw new Error(`video not found for tail-frame extraction: ${videoPath}`);
  }
  let out;
  try {
    out = execFileSync(
      ffprobeBin(),
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }
    );
  } catch (e) {
    throw new Error(`ffprobe failed for ${videoPath}: ${e.message}`);
  }
  const raw = String(out).trim();
  const duration = parseFloat(raw);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`cannot determine video duration for ${videoPath} (ffprobe returned ${JSON.stringify(raw)})`);
  }
  return duration;
}

/**
 * 抽取上游视频尾帧为 PNG。
 * @param {{videoPath:string, offsetFrames?:number, fps?:number, outPath:string}} args
 * @returns {{durationSec:number, durationFrames:number, seekSec:number, cutFrame:number, outPath:string}}
 */
function extractTailFrame({ videoPath, offsetFrames = 0, fps = 30, outPath } = {}) {
  if (!videoPath || typeof videoPath !== 'string') {
    throw new Error('extractTailFrame requires videoPath');
  }
  if (!outPath || typeof outPath !== 'string') {
    throw new Error('extractTailFrame requires outPath');
  }
  if (!Number.isInteger(offsetFrames)) {
    throw new Error(`extractTailFrame offsetFrames must be an integer, got ${JSON.stringify(offsetFrames)}`);
  }
  if (!Number.isInteger(fps) || fps <= 0) {
    throw new Error(`extractTailFrame fps must be a positive integer, got ${JSON.stringify(fps)}`);
  }
  const durationSec = probeDurationSec(videoPath);
  const seekSec = Math.max(0, durationSec + offsetFrames / fps);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  try {
    execFileSync(
      ffmpegBin(),
      ['-y', '-v', 'error', '-ss', String(seekSec), '-i', videoPath, '-frames:v', '1', outPath],
      { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' }
    );
  } catch (e) {
    throw new Error(`ffmpeg tail-frame extraction failed (${videoPath} @ ${seekSec}s): ${e.message}`);
  }
  if (!fs.existsSync(outPath)) {
    throw new Error(`ffmpeg did not produce a tail frame for ${videoPath}: ${outPath}`);
  }
  const durationFrames = Math.round(durationSec * fps);
  const cutFrame = Math.max(0, durationFrames + offsetFrames);
  return { durationSec, durationFrames, seekSec, cutFrame, outPath };
}

module.exports = { extractTailFrame, probeDurationSec };
