#!/usr/bin/env node
/**
 * tts-api-doubao.js — M5 TTS provider adapter（豆包语音合成模型 2.0 / seed-tts-2.0）
 *
 * PRD v2.13 定版 provider：`{name:'doubao', model:'seed-tts-2.0', version:'2026-09-14'}`。
 * 本模块只做两件事（零新依赖，HTTP 走 node `https`）：
 *   1. `synthDoubao(...)`：V3 unidirectional 接口 POST JSON，解析返回的 SSE/NDJSON 帧，
 *      返回 `{audio:Buffer, requestId, usage}`；
 *   2. `parseDoubaoStream(body, contentType)` / `classifyTtsError(err)`：纯函数，便于离线单测。
 *
 * 请求/响应格式参考 ai-course `tools/py/synthesize_doubao_icl_batch.py::_tts_query_v3` +
 * `common.py::_parse_doubao_stream`（只读参考，不修改 ai-course）：
 *   - 请求体 `{user:{uid}, req_params:{reqid, text, speaker, audio_params:{format:'mp3',
 *     sample_rate:24000, speech_rate}}}`；
 *   - 头 `X-Api-Key` / `X-Api-Resource-Id` / `X-Api-Request-Id` / `Content-Type`；
 *   - 响应为逐帧 JSON（可带 `event:` / `data:` 前缀，base64 音频在 `data`，
 *     usage 在 `usage.text_words`；`code ∈ {0, 20000000}` 为成功）。
 *
 * 硬约束：
 *   - 缺 `DOUBAO_TTS_API_KEY` → 抛错（消息含 env 名），不发请求；
 *   - `TTS_MOCK=1` → 完全不联网，必须给 `TTS_MOCK_AUDIO=<path>`（拒绝伪造静音 mp3）；
 *   - 失败分类 `classifyTtsError`：HTTP 4xx（含 403 resource not granted）→ 'hard'，
 *     5xx/超时/网络 → 'transient'，供调用方按 A1 失败模型上报（不自动记账）。
 */
'use strict';
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

const DEFAULT_API_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const DEFAULT_RESOURCE_ID = 'seed-tts-2.0';
const DEFAULT_TIMEOUT_MS = 90000;
const API_KEY_ENV = 'DOUBAO_TTS_API_KEY';
const MOCK_AUDIO_ENV = 'TTS_MOCK_AUDIO';

/**
 * speed（1.0 = 原速）→ 豆包 `speech_rate`（-50..100 的整数）。
 * speed ≤ 0 / 非法 → 0（原速）。
 */
function speedToSpeechRate(speed) {
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed <= 0) return 0;
  return Math.max(-50, Math.min(100, Math.round((speed - 1.0) * 100)));
}

/**
 * 扫描文本流中的连续 JSON 值（跳过 `event:` 行、剥离 `data:` 前缀、容忍空白/换行）。
 * 用花括号/方括号配平（字符串内感知转义）定位每个 JSON 值的边界。
 * @param {string} text
 * @returns {Array<any>}
 */
function scanJsonValues(text) {
  const values = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    if (i >= n) break;
    if (text.startsWith('event:', i)) {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    if (text.startsWith('data:', i)) {
      i += 5;
      while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
    }
    if (text[i] !== '{' && text[i] !== '[') {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    const start = i;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (; i < n; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        depth--;
        if (depth === 0) { end = i + 1; i++; break; }
      }
    }
    if (end < 0) break;
    try { values.push(JSON.parse(text.slice(start, end))); } catch { /* 跳过坏帧 */ }
  }
  return values;
}

/**
 * 解析豆包 TTS V3 返回体：逐帧 JSON → 合并 base64 音频 + usage。
 * - `contentType` 含 `application/json` → 供应商以 JSON 报错（非音频流），抛错；
 * - `code ∉ {0, 20000000}` → 抛错（含 code/message）；
 * - 无音频 → 抛错。
 * @param {Buffer|string} body
 * @param {string} [contentType]
 * @returns {{audio:Buffer, usage:object|null}}
 */
function parseDoubaoStream(body, contentType) {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(String(body == null ? '' : body), 'utf8');
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('application/json')) {
    let parsed = null;
    try { parsed = JSON.parse(raw.toString('utf8')); } catch { /* 非 JSON 也按报错处理 */ }
    throw new Error(`豆包 TTS 返回 JSON 而非音频流: ${parsed ? JSON.stringify(parsed) : raw.toString('utf8').slice(0, 200)}`);
  }
  const payloads = scanJsonValues(raw.toString('utf8'));
  const audioParts = [];
  let usage = null;
  let lastMessage = '';
  for (const payload of payloads) {
    if (!payload || typeof payload !== 'object') continue;
    const code = Number(payload.code == null ? 0 : payload.code);
    const message = payload.message ? String(payload.message) : '';
    if (message) lastMessage = message;
    if (code !== 0 && code !== 20000000) {
      throw new Error(`豆包 TTS 返回异常: code=${code}, message=${message}`);
    }
    if (typeof payload.data === 'string' && payload.data) {
      let decoded;
      try {
        decoded = Buffer.from(payload.data, 'base64');
      } catch {
        throw new Error('豆包 TTS 音频分片 base64 解析失败');
      }
      if (decoded.length) audioParts.push(decoded);
    }
    if (payload.usage && typeof payload.usage === 'object' && payload.usage.text_words != null) {
      usage = payload.usage;
    }
  }
  const audio = Buffer.concat(audioParts);
  if (!audio.length) {
    throw new Error(`豆包 TTS 未返回音频数据${lastMessage ? `: ${lastMessage}` : ''}`);
  }
  return { audio, usage };
}

/**
 * 合成一段对白。
 *
 * 环境变量（均可由入参覆盖）：
 *   - `DOUBAO_TTS_API_KEY`（必需，缺省抛错；消息含 env 名）
 *   - `DOUBAO_TTS_RESOURCE_ID`（缺省 `seed-tts-2.0`）
 *   - `DOUBAO_TTS_API_URL`（缺省 V3 unidirectional）
 *   - `TTS_MOCK=1` + `TTS_MOCK_AUDIO=<path>`：mock 通道，不联网。
 *
 * @param {{text:string, voiceId:string, resourceId?:string, apiUrl?:string, apiKey?:string,
 *   speechRate?:number, timeoutMs?:number, uid?:string}} input
 * @returns {Promise<{audio:Buffer, requestId:string, usage:object|null}>|{audio:Buffer, requestId:string, usage:object}}
 */
function synthDoubao({ text, voiceId, resourceId, apiUrl, apiKey, speechRate, timeoutMs = DEFAULT_TIMEOUT_MS, uid } = {}) {
  // mock 通道：不联网、不消耗额度，但必须显式提供真实音频夹具。
  if (process.env.TTS_MOCK === '1') {
    const mockPath = process.env[MOCK_AUDIO_ENV];
    if (!mockPath) {
      throw new Error(`TTS_MOCK=1 requires ${MOCK_AUDIO_ENV}=<path> pointing at a local audio fixture (refusing to fabricate a silent mp3)`);
    }
    const audio = fs.readFileSync(mockPath);
    if (!audio.length) throw new Error(`${MOCK_AUDIO_ENV} is empty: ${mockPath}`);
    return {
      audio,
      requestId: `mock-${process.pid}-${Date.now()}`,
      usage: { text_words: typeof text === 'string' ? text.length : 0, mock: true }
    };
  }

  const resolvedApiKey = apiKey || process.env[API_KEY_ENV];
  if (!resolvedApiKey) {
    throw new Error(`${API_KEY_ENV} is required for doubao tts (set it in the environment or pass apiKey); no request was sent`);
  }
  const resolvedResourceId = resourceId || process.env.DOUBAO_TTS_RESOURCE_ID || DEFAULT_RESOURCE_ID;
  const resolvedApiUrl = apiUrl || process.env.DOUBAO_TTS_API_URL || DEFAULT_API_URL;
  const requestId = crypto.randomUUID();
  const rate = (typeof speechRate === 'number' && Number.isFinite(speechRate)) ? Math.trunc(speechRate) : 0;

  const bodyObj = {
    user: { uid: uid || process.env.DOUBAO_TTS_UID || 'shows' },
    req_params: {
      reqid: requestId,
      text,
      speaker: voiceId,
      audio_params: {
        format: 'mp3',
        sample_rate: 24000,
        speech_rate: rate
      }
    }
  };

  return new Promise((resolve, reject) => {
    let urlObj;
    try { urlObj = new URL(resolvedApiUrl); } catch {
      reject(new Error(`invalid tts api url: ${resolvedApiUrl}`));
      return;
    }
    const data = Buffer.from(JSON.stringify(bodyObj), 'utf8');
    const req = https.request({
      method: 'POST',
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        'X-Api-Key': resolvedApiKey,
        'X-Api-Resource-Id': resolvedResourceId,
        'X-Api-Request-Id': requestId
      },
      timeout: timeoutMs
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        const status = res.statusCode;
        if (status < 200 || status >= 300) {
          const err = new Error(`doubao tts HTTP ${status}: ${body.toString('utf8').slice(0, 500)}`);
          err.statusCode = status;
          reject(err);
          return;
        }
        try {
          const { audio, usage } = parseDoubaoStream(body, res.headers['content-type']);
          resolve({ audio, requestId, usage });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('timeout', () => {
      const err = new Error(`doubao tts request timed out after ${timeoutMs}ms`);
      err.code = 'ETIMEDOUT';
      req.destroy(err);
    });
    req.on('error', (e) => reject(e));
    req.write(data);
    req.end();
  });
}

/**
 * 失败分类（A1 失败模型的上报依据，不自动记账）：
 *   - HTTP 4xx（含 403 resource not granted）→ 'hard'（内容/授权失败，重试无意义）
 *   - HTTP 5xx / 超时 / 网络 → 'transient'
 * 未知一律按 'transient'（网络/传输层可重试假设更安全）。
 * @param {Error} err
 * @returns {'hard'|'transient'}
 */
function classifyTtsError(err) {
  if (!err) return 'transient';
  const status = (typeof err.statusCode === 'number') ? err.statusCode
    : (typeof err.status === 'number' ? err.status : null);
  if (status != null) {
    if (status >= 500) return 'transient';
    if (status >= 400) return 'hard';
  }
  const code = err.code || '';
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ECONNABORTED'].includes(code)) {
    return 'transient';
  }
  const msg = String(err.message || '');
  if (/timed out|timeout|socket hang up|network|ECONNRESET|ENOTFOUND/i.test(msg)) return 'transient';
  if (/HTTP 4\d\d|resource not granted|not granted|invalid|unauthor/i.test(msg)) return 'hard';
  return 'transient';
}

module.exports = {
  parseDoubaoStream,
  synthDoubao,
  classifyTtsError,
  speedToSpeechRate,
  scanJsonValues,
  DEFAULT_API_URL,
  DEFAULT_RESOURCE_ID,
  DEFAULT_TIMEOUT_MS,
  API_KEY_ENV,
  MOCK_AUDIO_ENV
};

if (require.main === module) {
  console.error('tts-api-doubao.js is a library module; use tools/tts.js to synthesize dialogue.');
  process.exit(1);
}
