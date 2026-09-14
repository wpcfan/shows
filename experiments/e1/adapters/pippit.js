#!/usr/bin/env node
/**
 * pippit.js — E1 真实 adapter：小云雀 CLI（pippit-tool-cli generate-video）
 *
 * 通道事实（Pippit-dev/cli v1.0.21 源码）：
 *   - generate-video 产出 {thread_id, run_id, web_thread_link}；
 *   - 结果用 query-result --thread-id --run-id --download-dir 轮询，completed 后
 *     videos[].output_path 为本地下载路径；
 *   - `--generate-type 1` = 首尾帧生成（两次 --image，首帧、尾帧顺序）；
 *   - 无“仅首帧”参数位；无 seed 字段（E1 以重复观测代替 seed 配对）。
 *
 * E1 组映射（由 config.groups[].adapter_params 驱动）：
 *   A′（首帧位替代）：{generate_type:1, image_mode:'first_last_same'} → --image X --image X
 *   B（参考图位）  ：{image_mode:'single'}                          → --image X
 *   C（无图）      ：{image_mode:'none'}                            → 无 --image
 *   探测          ：{generate_type:N, image_mode:'single'}          → --generate-type N --image X
 *
 * Adapter 契约：module.exports = { name, generate({ sample, outPath }) }（可 async）
 * 环境变量：PIPPIT_CLI_BIN（默认 pippit-tool-cli）、E1_PIPPIT_POLL_MS（默认 10000）、
 *          E1_PIPPIT_TIMEOUT_MS（默认 900000）、E1_PIPPIT_MODEL（model 缺省时的兜底）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const NAME = 'pippit-tool-cli generate-video';

function cliBin() {
  return process.env.PIPPIT_CLI_BIN || 'pippit-tool-cli';
}

function pollMs() {
  const v = Number(process.env.E1_PIPPIT_POLL_MS);
  return Number.isFinite(v) && v >= 0 ? v : 10000;
}

function timeoutMs() {
  const v = Number(process.env.E1_PIPPIT_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 900000;
}

/** 从一组 group 配置推断图片模式（显式优先，其次按 params_position） */
function resolveImageMode(sample) {
  const ap = (sample && sample.adapter_params) || {};
  if (ap.image_mode) return ap.image_mode;
  const pos = sample && sample.params_position;
  if (pos === 'first_frame') return 'first_last_same';
  if (pos === 'reference_image') return 'single';
  return 'none';
}

/** 构造 CLI 参数（纯函数，便于单测；不读文件、不起进程） */
function buildArgs(sample) {
  if (!sample || typeof sample !== 'object') throw new Error('pippit adapter: sample required');
  const prompt = sample.prompt == null ? '' : String(sample.prompt).trim();
  if (!prompt) throw new Error('pippit adapter: sample.prompt is required');
  const model = sample.model || process.env.E1_PIPPIT_MODEL || '';
  if (!model) throw new Error('pippit adapter: sample.model (or E1_PIPPIT_MODEL) is required');

  const ap = sample.adapter_params || {};
  const mode = resolveImageMode(sample);
  const args = ['generate-video', '--prompt', prompt, '--model', model];

  if (sample.duration != null) args.push('--duration', String(sample.duration));
  if (sample.ratio) args.push('--ratio', String(sample.ratio));
  if (sample.resolution) args.push('--resolution', String(sample.resolution));

  if (mode !== 'none') {
    const img = sample.image;
    if (!img) throw new Error(`pippit adapter: group ${sample.group} image_mode=${mode} requires sample.image`);
    if (!fs.existsSync(img)) throw new Error(`pippit adapter: input image not found: ${img}`);
    args.push('--image', img);
    if (mode === 'first_last_same') args.push('--image', img);
    else if (mode !== 'single') throw new Error(`pippit adapter: unsupported image_mode ${JSON.stringify(mode)}`);
  }

  if (ap.generate_type != null) {
    const n = Number(ap.generate_type);
    if (!Number.isInteger(n)) throw new Error(`pippit adapter: adapter_params.generate_type must be an integer, got ${JSON.stringify(ap.generate_type)}`);
    args.push('--generate-type', String(n));
  }
  return args;
}

/** 解析 CLI 的 JSON 输出（容忍前置日志行，取最后一个可解析的 JSON 对象） */
function parseCliJson(stdout) {
  const text = String(stdout == null ? '' : stdout).trim();
  if (!text) throw new Error('pippit adapter: empty CLI output');
  try { return JSON.parse(text); } catch { /* fallthrough */ }
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try { return JSON.parse(lines[i]); } catch { /* keep scanning */ }
  }
  throw new Error(`pippit adapter: cannot parse CLI JSON output: ${text.slice(0, 300)}`);
}

/** 从 query-result 结果中取第一个视频的本地路径 */
function pickVideoPath(queryResult) {
  const videos = (queryResult && queryResult.videos) || [];
  if (!videos.length) throw new Error('pippit adapter: query-result returned no videos');
  const p = videos[0].output_path || videos[0].download_url;
  if (!p) throw new Error('pippit adapter: video entry has no output_path/download_url');
  return p;
}

function runCli(args) {
  const r = spawnSync(cliBin(), args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.error) throw new Error(`pippit adapter: failed to run ${cliBin()}: ${r.error.message}`);
  if (r.status !== 0) {
    const detail = String(r.stderr || r.stdout || '').trim().slice(0, 500);
    throw new Error(`pippit adapter: ${cliBin()} ${args[0]} failed (exit ${r.status}): ${detail}`);
  }
  return r.stdout;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function generate({ sample, outPath } = {}) {
  if (!sample) throw new Error('pippit adapter: sample required');
  if (!outPath) throw new Error('pippit adapter: outPath required');

  const args = buildArgs(sample);
  const submit = parseCliJson(runCli(args));
  const threadId = submit.thread_id;
  const runId = submit.run_id;
  if (!threadId || !runId) throw new Error(`pippit adapter: submit response missing thread_id/run_id: ${JSON.stringify(submit)}`);

  const downloadDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'e1-pippit-'));
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });

  const deadline = Date.now() + timeoutMs();
  try {
    for (;;) {
      const q = parseCliJson(runCli([
        'query-result', '--thread-id', threadId, '--run-id', runId, '--download-dir', downloadDir
      ]));
      if (q.error_message) throw new Error(`pippit adapter: run failed: ${q.error_message} (thread ${threadId}, run ${runId})`);
      if (q.completed) {
        const src = pickVideoPath(q);
        if (!fs.existsSync(src)) throw new Error(`pippit adapter: downloaded video not found: ${src}`);
        if (path.resolve(src) !== path.resolve(outPath)) fs.copyFileSync(src, outPath);
        return { request_id: `${threadId}/${runId}`, web_thread_link: submit.web_thread_link || null };
      }
      if (Date.now() >= deadline) {
        throw new Error(`pippit adapter: timeout after ${timeoutMs()}ms waiting for thread ${threadId} run ${runId}`);
      }
      await sleep(pollMs());
    }
  } finally {
    // 清理 CLI 的临时下载目录，只保留 runner 的 artifacts/<sample_id>.mp4
    try { fs.rmSync(downloadDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

module.exports = { name: NAME, generate, buildArgs, parseCliJson, pickVideoPath, resolveImageMode };
