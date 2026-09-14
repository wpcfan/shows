#!/usr/bin/env node
/**
 * mock.js — E1 采集 runner 的确定性 mock adapter(仅用于演练!)
 *
 * ⚠️ 本 adapter **不是真实生成接口**,产出的视频由本机 ffmpeg 合成。它只用于验证
 *    `tools/e1-collect.js` 的端到端链路(矩阵、断点续跑、记账、指标、数据集 schema)。
 *    **不得以 mock 结果作为接口能力证据,不得据此宣称 E1 结论。**
 *
 * 行为(确定性,同 seed 同输入 → 同产物):
 *   A 组(params_position='first_frame'):frame0 与输入图一致(单帧循环转视频)。
 *   B 组(params_position='reference_image'):输入图先降采样到 64×36 再放大到 512×512
 *       → SSIM 明显低于 A。
 *   C 组(无图):用 seed 决定的纯色测试视频 → SSIM 低(无输入图,dataset 记 null)。
 *
 * Adapter 契约:
 *   module.exports = { name, generate({ sample, outPath }) }   // 可 async
 *   - 必须把产物写到 outPath
 *   - 返回 { request_id }
 *   - 无输入图且组需要图(A/B)→ 抛错(供失败路径测试)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const NAME = 'mock';

function ffmpegBin() {
  return process.env.FFMPEG_BIN || 'ffmpeg';
}

function runFfmpeg(args) {
  const r = spawnSync(ffmpegBin(), args, { encoding: 'utf8' });
  if (r.error) throw new Error(`mock adapter: ffmpeg error: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`mock adapter: ffmpeg failed (${r.status}): ${String(r.stderr || '').trim()}`);
}

/** seed → 确定性颜色 0xRRGGBB */
function seedColor(seed) {
  const s = Math.abs(Math.floor(Number(seed) || 0));
  const r = (s * 73 + 17) % 256;
  const g = (s * 151 + 41) % 256;
  const b = (s * 199 + 89) % 256;
  return '0x' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

/** 保证宽高为偶数(yuv420p 要求) */
const EVEN = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';

async function generate({ sample, outPath } = {}) {
  if (!sample) throw new Error('mock adapter: sample required');
  if (!outPath) throw new Error('mock adapter: outPath required');
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });

  // 组需要图 = 声明了 params_position(A/B);无图直接抛错,暴露采集失败路径
  const needsImage = sample.params_position != null && sample.params_position !== '';
  if (needsImage && (!sample.image || !fs.existsSync(sample.image))) {
    throw new Error(`mock adapter: group ${sample.group} requires an input image but none was provided (${sample.image || 'null'})`);
  }

  if (sample.group === 'A') {
    // frame0 == 输入图
    runFfmpeg(['-y', '-v', 'error', '-loop', '1', '-i', sample.image, '-vf', EVEN, '-t', '1', '-r', '24', '-pix_fmt', 'yuv420p', outPath]);
  } else if (sample.group === 'B') {
    // 降采样再放大 → 质量明显下降
    runFfmpeg(['-y', '-v', 'error', '-loop', '1', '-i', sample.image, '-vf', `scale=64:36:flags=bilinear,scale=512:512:flags=bilinear`, '-t', '1', '-r', '24', '-pix_fmt', 'yuv420p', outPath]);
  } else {
    // C 组:无图 → seed 决定的纯色测试视频
    const color = seedColor(sample.seed);
    runFfmpeg(['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=512x512:d=1:r=24`, '-pix_fmt', 'yuv420p', outPath]);
  }

  if (!fs.existsSync(outPath)) throw new Error(`mock adapter: failed to write ${outPath}`);
  return { request_id: `mock-${sample.sample_id}` };
}

module.exports = { name: NAME, generate };
