#!/usr/bin/env node
/**
 * e1-metrics.js — §3.1 E1 首帧能力实验的指标核心
 *
 * 主指标:输入图 vs 视频第 0 帧的 SSIM(用 ffmpeg `ssim` 滤镜,写死预处理口径)。
 * 辅指标:pHash 汉明距离(纯 JS 2D DCT-II,不引入依赖)。
 *
 * 预处理口径(PRD §3.1, v2.9 修订):
 *   1) 输入图先按**视频帧的宽高比**做中心 cover-crop(避免宽比不一致时拉伸变形);
 *   2) 两侧再统一 resize 到 512×512 双线性、format=rgb24;
 *   3) 不做锐化/对比度增强。
 *   [0:v]crop=w='min(iw,ih*W/H)':h='min(ih,iw*H/W)',scale=512:512:flags=bilinear,format=rgb24[a];
 *   [1:v]scale=512:512:flags=bilinear,format=rgb24[b];
 *   [a][b]ssim
 *   (W/H = 视频第 0 帧的宽/高,pHash 前处理同口径)
 *
 * 二进制解析:FFMPEG_BIN / FFPROBE_BIN 环境变量可覆盖;首次调用时缓存 `ffmpeg -version`
 * 首行作为 impl_version,供数据集 meta.metrics 记录实现版本。
 *
 * 本模块不联网;所有 ffmpeg 调用使用参数数组(无 shell),不拼接用户输入到命令行。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TOOL_NAME = 'e1-metrics';
const TOOL_VERSION = '1.0.0';

/** 兼容导出:旧口径的 SSIM 滤镜图(无 cover-crop),仅用于对照/回归 */
const SSIM_FILTER_GRAPH =
  '[0:v]scale=512:512:flags=bilinear,format=rgb24[a];' +
  '[1:v]scale=512:512:flags=bilinear,format=rgb24[b];' +
  '[a][b]ssim';

/** SSIM 参数口径(写进数据集 meta.metrics.ssim.params) */
const SSIM_PARAMS = {
  window: '8x8',
  channels: 'rgb24-all',
  resize: '512x512-bilinear',
  cover_crop: 'to_video_aspect'
};

/** 默认预处理协议(与 e1-report.js DEFAULT_PREPROCESSING 对齐) */
const DEFAULT_PREPROCESSING = {
  cover_crop: 'to_video_aspect',
  resize: '512x512-bilinear',
  color_space: 'sRGB',
  sharpen: false
};

function ffmpegBin() {
  return process.env.FFMPEG_BIN || 'ffmpeg';
}

function ffprobeBin() {
  return process.env.FFPROBE_BIN || 'ffprobe';
}

let _ffmpegVersion = null;
let _ffprobeVersion = null;

/** ffmpeg 首行版本号(缓存);不可用则抛错 */
function getFfmpegVersion() {
  if (_ffmpegVersion !== null) return _ffmpegVersion;
  const r = spawnSync(ffmpegBin(), ['-version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    throw new Error(`ffmpeg not available (${ffmpegBin()}): ${r.error ? r.error.message : String(r.stderr || '').trim()}`);
  }
  _ffmpegVersion = String(r.stdout || '').split('\n')[0].trim();
  return _ffmpegVersion;
}

/** ffprobe 首行版本号(缓存);不可用则抛错 */
function getFfprobeVersion() {
  if (_ffprobeVersion !== null) return _ffprobeVersion;
  const r = spawnSync(ffprobeBin(), ['-version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    throw new Error(`ffprobe not available (${ffprobeBin()}): ${r.error ? r.error.message : String(r.stderr || '').trim()}`);
  }
  _ffprobeVersion = String(r.stdout || '').split('\n')[0].trim();
  return _ffprobeVersion;
}

/** ffmpeg 是否可用(不抛错,供测试探测) */
function ffmpegAvailable() {
  try { getFfmpegVersion(); return true; } catch { return false; }
}

function ensureDirFor(filePath) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

/**
 * 抽取视频第 0 帧为图片。
 * ffmpeg -y -v error -i <video> -vf "select=eq(n\,0)" -frames:v 1 <out>
 * @param {string} videoPath
 * @param {string} outPng
 * @returns {string} outPng
 */
function extractFrame0(videoPath, outPng) {
  if (!videoPath) throw new Error('extractFrame0: videoPath required');
  if (!outPng) throw new Error('extractFrame0: outPng required');
  if (!fs.existsSync(videoPath)) throw new Error(`extractFrame0: video not found: ${videoPath}`);
  ensureDirFor(outPng);
  const r = spawnSync(
    ffmpegBin(),
    ['-y', '-v', 'error', '-i', videoPath, '-vf', 'select=eq(n\\,0)', '-frames:v', '1', outPng],
    { encoding: 'utf8' }
  );
  if (r.error) throw new Error(`extractFrame0 failed (${videoPath}): ${r.error.message}`);
  if (r.status !== 0) throw new Error(`extractFrame0 failed (${videoPath}): ${String(r.stderr || '').trim()}`);
  if (!fs.existsSync(outPng)) throw new Error(`extractFrame0 did not produce ${outPng}`);
  return outPng;
}

/** 返回 SSIM 滤镜图字符串;传 targetSize {w,h} 时启用 cover-crop 协议 */
function ssimFilterGraph(targetSize) {
  if (!targetSize || !(targetSize.w > 0) || !(targetSize.h > 0)) return SSIM_FILTER_GRAPH;
  const crop = `crop=w='min(iw\\,ih*${targetSize.w}/${targetSize.h})':h='min(ih\\,iw*${targetSize.h}/${targetSize.w})'`;
  return `[0:v]${crop},scale=512:512:flags=bilinear,format=rgb24[a];` +
    '[1:v]scale=512:512:flags=bilinear,format=rgb24[b];[a][b]ssim';
}

/** ffprobe 读取图片/视频首路视频流的宽高(cover-crop 基准) */
function probeMediaSize(filePath) {
  if (!filePath) throw new Error('probeMediaSize: filePath required');
  if (!fs.existsSync(filePath)) throw new Error(`probeMediaSize: file not found: ${filePath}`);
  const r = spawnSync(
    ffprobeBin(),
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', filePath],
    { encoding: 'utf8' }
  );
  if (r.error) throw new Error(`probeMediaSize failed (${filePath}): ${r.error.message}`);
  if (r.status !== 0) throw new Error(`probeMediaSize failed (${filePath}): ${String(r.stderr || '').trim()}`);
  const m = /^(\d+)\s*,\s*(\d+)/.exec(String(r.stdout || '').trim());
  if (!m) throw new Error(`probeMediaSize: cannot parse dimensions from ${JSON.stringify(String(r.stdout || '').trim())}`);
  return { w: Number(m[1]), h: Number(m[2]) };
}

/**
 * 解析 ffmpeg ssim 滤镜输出中的 `All:` 数值。
 * 例:`... All:0.909548 (10.435797)` → 0.909548;`All:inf` / `All:1.000000 (inf)` 亦支持。
 * 解析失败抛错(不得静默当 0/1)。
 * @param {string} text
 * @returns {number}
 */
function parseSsimOutput(text) {
  const s = String(text == null ? '' : text);
  const m = /All:\s*([0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?|inf(?:inity)?|nan)/i.exec(s);
  if (!m) throw new Error('parseSsimOutput: no "All:" field found in ffmpeg ssim output');
  const tok = m[1].toLowerCase();
  if (tok === 'inf' || tok === 'infinity') return Infinity;
  if (tok === 'nan') return NaN;
  return Number(tok);
}

/**
 * 计算两张图(输入图 vs 抽出的第 0 帧)的 SSIM。
 * cover-crop 协议:按 pathB(视频帧)的宽高比先居中裁切 pathA,再双双 resize。
 * @param {string} pathA 输入图
 * @param {string} pathB 视频第 0 帧
 * @param {{targetSize?:{w:number,h:number}}} [opts]
 * @returns {{value:number, impl:string, version:string, params:object}}
 */
function ssim(pathA, pathB, opts = {}) {
  if (!pathA || !pathB) throw new Error('ssim: two image paths required');
  if (!fs.existsSync(pathA)) throw new Error(`ssim: file not found: ${pathA}`);
  if (!fs.existsSync(pathB)) throw new Error(`ssim: file not found: ${pathB}`);
  const targetSize = opts.targetSize || probeMediaSize(pathB);
  const r = spawnSync(
    ffmpegBin(),
    ['-v', 'info', '-i', pathA, '-i', pathB, '-lavfi', ssimFilterGraph(targetSize), '-f', 'null', '-'],
    { encoding: 'utf8' }
  );
  if (r.error) throw new Error(`ssim failed (${pathA} vs ${pathB}): ${r.error.message}`);
  let value;
  try {
    value = parseSsimOutput(`${r.stdout || ''}${r.stderr || ''}`);
  } catch (e) {
    throw new Error(`ssim failed (${pathA} vs ${pathB}): ${e.message}`);
  }
  return {
    value,
    impl: 'ffmpeg-ssim',
    version: getFfmpegVersion(),
    params: Object.assign({}, SSIM_PARAMS)
  };
}

/**
 * 抽取灰度 raw 像素(默认 32×32 = 1024 字节)。
 * 传 opts.targetSize 时先按该宽高比做 cover-crop(与 SSIM 同口径)。
 * @param {string} imagePath
 * @param {number} [size=32]
 * @param {{targetSize?:{w:number,h:number}}} [opts]
 * @returns {Buffer}
 */
function grayRaw(imagePath, size = 32, opts = {}) {
  if (!imagePath) throw new Error('grayRaw: imagePath required');
  if (!fs.existsSync(imagePath)) throw new Error(`grayRaw: file not found: ${imagePath}`);
  const n = Math.max(1, Math.floor(size));
  const t = opts.targetSize;
  const crop = (t && t.w > 0 && t.h > 0)
    ? `crop=w='min(iw\\,ih*${t.w}/${t.h})':h='min(ih\\,iw*${t.h}/${t.w})',`
    : '';
  const r = spawnSync(
    ffmpegBin(),
    ['-v', 'error', '-i', imagePath, '-vf', `${crop}scale=${n}:${n}:flags=bilinear,format=gray`, '-f', 'rawvideo', '-'],
    { maxBuffer: 8 * 1024 * 1024 }
  );
  if (r.error) throw new Error(`grayRaw failed (${imagePath}): ${r.error.message}`);
  if (r.status !== 0) throw new Error(`grayRaw failed (${imagePath}): ${String(r.stderr || '').trim()}`);
  const buf = Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(r.stdout || []);
  if (buf.length !== n * n) throw new Error(`grayRaw expected ${n * n} bytes, got ${buf.length}`);
  return buf;
}

/** 一维 DCT-II */
function dct1d(vec) {
  const N = vec.length;
  const out = new Float64Array(N);
  const factor = Math.PI / (2 * N);
  for (let k = 0; k < N; k++) {
    let s = 0;
    for (let n = 0; n < N; n++) s += vec[n] * Math.cos((2 * n + 1) * k * factor);
    out[k] = s;
  }
  return out;
}

/** 2D DCT-II(可分离:先逐行,再逐列) */
function dct2d(gray, w, h) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    rows.push(dct1d(gray.subarray ? gray.subarray(y * w, y * w + w) : gray.slice(y * w, y * w + w)));
  }
  const out = new Float64Array(w * h);
  const col = new Float64Array(h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) col[y] = rows[y][x];
    const d = dct1d(col);
    for (let y = 0; y < h; y++) out[y * w + x] = d[y];
  }
  return out;
}

function medNum(arr) {
  const a = arr.slice().sort((x, y) => x - y);
  if (a.length === 0) return 0;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/**
 * 由 32×32 灰度 raw 计算 64-bit pHash(16 位 hex)。
 * 取左上 8×8 DCT 系数,以非 DC 系数中位数为阈值置位(DC 参与置位但不参与求中位数)。
 * @param {Buffer} buf
 * @param {number} [w=32]
 * @param {number} [h=32]
 * @returns {string} 16 字符 hex
 */
function phashFromGray(buf, w = 32, h = 32) {
  if (!buf || typeof buf.length !== 'number') throw new Error('phashFromGray: Buffer required');
  if (buf.length !== w * h) throw new Error(`phashFromGray expected ${w * h} bytes for ${w}x${h}, got ${buf.length}`);
  if (w < 8 || h < 8) throw new Error('phashFromGray: input must be at least 8x8');
  const dct = dct2d(buf, w, h);
  const block = 8;
  const vals = new Array(block * block);
  for (let y = 0; y < block; y++) {
    for (let x = 0; x < block; x++) vals[y * block + x] = dct[y * w + x];
  }
  // 去 DC:DC 是最低频,量级远大于其它系数;求中位数时排除,避免单点主导
  const med = medNum(vals.slice(1));
  let bits = '';
  for (let i = 0; i < block * block; i++) bits += vals[i] > med ? '1' : '0';
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

/** 汉明距离(64-bit hex)。要求两个 16 位 hex。 */
function phashDistance(hexA, hexB) {
  const a = String(hexA == null ? '' : hexA).trim().toLowerCase();
  const b = String(hexB == null ? '' : hexB).trim().toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(a) || !/^[0-9a-f]{16}$/.test(b)) {
    throw new Error(`phashDistance: expected two 16-char hex hashes, got "${hexA}" / "${hexB}"`);
  }
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let count = 0;
  while (x !== 0n) { count += Number(x & 1n); x >>= 1n; }
  return count;
}

/** 便捷:图片路径 → pHash hex(传 opts.targetSize 时与 SSIM 同口径 cover-crop) */
function phash(imagePath, size = 32, opts = {}) {
  return phashFromGray(grayRaw(imagePath, size, opts), size, size);
}

/** 抽取第 0 帧路径(计算指标用;workDir 缺省为临时目录) */
function frame0PathFor(videoPath, workDir) {
  const dir = workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'e1-metrics-'));
  const base = sanitizeFileBase(path.basename(videoPath, path.extname(videoPath)));
  return { dir, outPath: path.join(dir, `${base}.frame0.png`) };
}

function sanitizeFileBase(name) {
  return String(name).replace(/[^A-Za-z0-9._-]+/g, '-') || 'video';
}

/**
 * 计算单个样本指标:抽 frame0 → SSIM(inputImage, frame0) + pHash 汉明距离。
 * inputImage 为 null(C 组无图)→ ssim/phash_distance 均为 null(不伪造数值)。
 * @param {{inputImage?:string|null, videoPath:string, workDir?:string}} opts
 * @returns {{ssim:number|null, phash_distance:number|null, frame0_path:string, metric_meta:object}}
 */
function computeSampleMetrics({ inputImage = null, videoPath, workDir } = {}) {
  if (!videoPath) throw new Error('computeSampleMetrics: videoPath required');
  if (!fs.existsSync(videoPath)) throw new Error(`computeSampleMetrics: video not found: ${videoPath}`);
  const { dir, outPath } = frame0PathFor(videoPath, workDir);
  fs.mkdirSync(dir, { recursive: true });
  extractFrame0(videoPath, outPath);
  const targetSize = probeMediaSize(outPath); // cover-crop 以视频帧宽高比为准

  let ssimValue = null;
  let phashDist = null;
  if (inputImage) {
    if (!fs.existsSync(inputImage)) throw new Error(`computeSampleMetrics: input image not found: ${inputImage}`);
    ssimValue = ssim(inputImage, outPath, { targetSize }).value;
    phashDist = phashDistance(phash(inputImage, 32, { targetSize }), phash(outPath));
  }

  const metric_meta = {
    ssim: {
      impl: 'ffmpeg-ssim',
      version: getFfmpegVersion(),
      params: Object.assign({}, SSIM_PARAMS),
      preprocessing: Object.assign({}, DEFAULT_PREPROCESSING)
    },
    secondary: {
      field: 'phash_distance',
      impl: 'e1-metrics.dct-phash',
      version: TOOL_VERSION
    }
  };

  return { ssim: ssimValue, phash_distance: phashDist, frame0_path: outPath, metric_meta };
}

module.exports = {
  TOOL_NAME,
  TOOL_VERSION,
  SSIM_FILTER_GRAPH,
  SSIM_PARAMS,
  DEFAULT_PREPROCESSING,
  ffmpegBin,
  ffprobeBin,
  getFfmpegVersion,
  getFfprobeVersion,
  ffmpegAvailable,
  extractFrame0,
  probeMediaSize,
  ssimFilterGraph,
  parseSsimOutput,
  ssim,
  grayRaw,
  dct1d,
  dct2d,
  phashFromGray,
  phashDistance,
  phash,
  computeSampleMetrics
};
