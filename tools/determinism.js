#!/usr/bin/env node
/**
 * determinism.js — PRD §5 Gate #14 取证：同 toolchain 下 final 复跑确定性
 *
 * 内部用与 `render-final.js` 完全相同的 `renderFinal()` 渲染两次到不同路径，
 * 比较解码后的视频流 MD5 与音频 PCM SHA256：
 *   - `video_md5`  : `ffmpeg -map 0:v -f md5 -`（解码后逐帧一致）
 *   - `audio_md5`  : `ffmpeg -map 0:a -f s16le -ar 48000 -ac 2 - | sha256`（PCM 样本一致）
 * 不一致 → 非零退出；`--keep` 保留两份产物供排查。
 *
 * CLI：`node tools/determinism.js <episode-dir> [--out <path>] [--keep] [--json]`
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { readJsonFile } = require('./build-manifest');
const { renderFinal, determinismDigests } = require('./render-final');

const ROOT = path.resolve(__dirname, '..');

function printUsage() {
  console.log('usage: node tools/determinism.js <episode-dir> [--out <path>] [--keep] [--json]');
  console.log('  PRD §5 Gate #14：同一 manifest/timeline 复跑 final，比较解码后视频/音频摘要');
  console.log('  default out dir: output/<episode>/；默认不复留产物（--keep 保留）');
}

function main(argv) {
  const args = argv.slice(2);
  const opts = { episodeDir: null, outPath: null, keep: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') { printUsage(); return 0; }
    else if (a === '--keep') opts.keep = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--out') opts.outPath = args[++i];
    else if (a.startsWith('--out=')) opts.outPath = a.slice('--out='.length);
    else if (a.startsWith('-')) { console.error(`unknown option: ${a}`); printUsage(); return 2; }
    else if (opts.episodeDir === null) opts.episodeDir = a;
    else { console.error(`unexpected argument: ${a}`); printUsage(); return 2; }
  }
  if (!opts.episodeDir) { printUsage(); return 2; }

  const absEpDir = path.isAbsolute(opts.episodeDir) ? opts.episodeDir : path.resolve(opts.episodeDir);
  let manifest;
  try {
    manifest = readJsonFile(path.join(absEpDir, 'manifest.json'), { label: 'manifest.json' });
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    return 2;
  }
  const timelinePath = path.join(absEpDir, 'timeline.json');
  if (!fs.existsSync(timelinePath)) {
    console.error(`ERROR: timeline.json not found at ${timelinePath} (Gate #14 determinism requires a built v2 timeline)`);
    return 2;
  }
  let timeline;
  try {
    timeline = readJsonFile(timelinePath, { label: 'timeline.json' });
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    return 2;
  }

  const customOut = opts.outPath
    ? (path.isAbsolute(opts.outPath) ? opts.outPath : path.resolve(opts.outPath))
    : null;
  const baseDir = customOut ? path.dirname(customOut) : path.join(ROOT, 'output', path.basename(absEpDir));
  const baseName = customOut ? path.basename(customOut).replace(/\.mp4$/i, '') : 'episode-determinism';
  fs.mkdirSync(baseDir, { recursive: true });
  const firstPath = customOut || path.join(baseDir, `${baseName}.mp4`);
  const secondPath = path.join(baseDir, `${baseName}-2.mp4`);

  try {
    renderFinal({ absEpDir, manifest, timeline, outPath: firstPath, opts: { skipCover: true } });
    renderFinal({ absEpDir, manifest, timeline, outPath: secondPath, opts: { skipCover: true } });
  } catch (e) {
    console.error(`ERROR: determinism run failed: ${e.message}`);
    try { fs.rmSync(firstPath, { force: true }); } catch { /* best effort */ }
    try { fs.rmSync(secondPath, { force: true }); } catch { /* best effort */ }
    return 3;
  }

  const first = determinismDigests(firstPath);
  const second = determinismDigests(secondPath);
  const video_md5_equal = first.video_md5 != null && first.video_md5 === second.video_md5;
  const audio_md5_equal = first.audio_md5 === second.audio_md5;
  const ok = video_md5_equal && audio_md5_equal;

  const report = {
    ok,
    first: { path: firstPath, ...first },
    second: { path: secondPath, ...second },
    video_md5_equal,
    audio_md5_equal,
  };

  // 产物保留策略：--keep 保留；不 ok 保留供排查；否则清除（用户 --out 指定的第一份保留）
  if (!opts.keep) {
    if (ok) {
      try { fs.rmSync(secondPath, { force: true }); } catch { /* best effort */ }
      if (!customOut) { try { fs.rmSync(firstPath, { force: true }); } catch { /* best effort */ } }
    }
    // !ok → 保留两份
  }

  console.log(JSON.stringify(report, null, 2));
  return ok ? 0 : 1;
}

module.exports = { main, printUsage };

if (require.main === module) {
  process.exit(main(process.argv));
}
