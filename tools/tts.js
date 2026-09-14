#!/usr/bin/env node
/**
 * tts.js — M5 TTS 产物 CLI（PRD §3.4/§3.5/§3.8）
 *
 * 用法：
 *   node tools/tts.js <episode-dir> --task <task_id> [--select] [--env-file <path>]
 *   node tools/tts.js <episode-dir> --task <task_id> --take <audio-path> [--select]   # 记录外部产物
 *   node tools/tts.js <episode-dir> --list                                            # 只读列出待做 tts 任务
 *
 * 语义（写死）：
 *   - 任务来自 render-next 的 stage='tts' 任务快照（可调度 = active 且未 superseded）；
 *   - 真实调用走 `tts-api-doubao.synthDoubao`（缺 `DOUBAO_TTS_API_KEY` 报错；`TTS_MOCK=1`
 *     时不联网，需 `TTS_MOCK_AUDIO`）；`--take` 则记录外部现有音频，不调用 adapter；
 *   - 产物路径 `<episode-dir>/audio/<shot_id>-<take_id>.mp3`（先写 tmp 再 rename，二进制原子写）；
 *   - take 记录 `{id, task_id, status:'proposed', path, input_hash, content_digest,
 *     duration_sec, provider, request_id, at}` 追加 `shot.tts_takes[]`；
 *     `--select` 置 `shot.selected_tts` 并清其他 selected（≤1 选中）；
 *   - 幂等：同 `(task_id, content_digest)` 已存在非 rejected take → no-op，不新增、不重复计 success；
 *   - 账本：成功 `tts.successes += 1`（**不重复计 request**，request 在 render-next 建任务时已计）；
 *     失败不自动记账，打印分类与建议命令并非零退出，且零落盘；
 *   - `--env-file`：极简 KEY=VALUE 解析，仅注入本进程 env，不写盘；
 *   - 写盘全程 `withLock(episodeDir)`；`--list` 只读不加锁。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  atomicWriteJson, readJsonFile, isActiveTaskStatus, isTaskSuperseded
} = require('./build-manifest');
const { computeNextTtsTakeId } = require('./render-next');
const { ensureLedger, recordOutcome, validateCost } = require('./quota-ledger');
const { withLock } = require('./lock');
const { synthDoubao, classifyTtsError, speedToSpeechRate } = require('./tts-api-doubao');
const { probeDurationSec: defaultProbeDurationSec } = require('./tail-frame');

/** 本地入参/状态错误:非 provider 失败,不得按 hard/transient 上报 attempt */
function invalidInput(message) {
  const e = new Error(message);
  e.kind = 'invalid';
  return e;
}

function parseArgs(argv) {
  const [episodeDir, ...rest] = argv;
  const opts = {
    episodeDir,
    taskId: null,
    takePath: null,
    select: false,
    list: false,
    envFile: null,
    cost: null
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--task') opts.taskId = rest[++i];
    else if (a === '--take') opts.takePath = rest[++i];
    else if (a === '--select') opts.select = true;
    else if (a === '--list') opts.list = true;
    else if (a === '--env-file') opts.envFile = rest[++i];
    else if (a === '--cost') opts.cost = rest[++i];
  }
  return opts;
}

/** 音频字节内容摘要（sha256 前 16 位，与 manifest take 的 content_digest 同口径） */
function bufferContentHash(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

/** 可调度任务 = active 且未 superseded */
function isDispatchable(task) {
  return !!task && isActiveTaskStatus(task.status) && !isTaskSuperseded(task);
}

/** 定位可调度的 tts 任务；非 tts / 不可调度 → 抛错 */
function findTtsTask(manifest, taskId) {
  const task = (manifest.render_tasks || []).find(t => t && t.task_id === taskId);
  if (!task) {
    throw invalidInput(`task ${taskId} not found in manifest.render_tasks — create one with render-next (node tools/render-next.js <episode-dir>)`);
  }
  if ((task.stage || 'video') !== 'tts') {
    throw invalidInput(`task ${taskId} is stage '${task.stage || 'video'}', not 'tts'`);
  }
  if (!isDispatchable(task)) {
    throw invalidInput(`task ${taskId} is not dispatchable (status ${task.status}${isTaskSuperseded(task) ? ', superseded' : ''}) — create a new task snapshot with render-next`);
  }
  return task;
}

/**
 * 极简 .env 解析：跳过注释/空行，允许 `export ` 前缀，KEY=VALUE（可选引号）。
 * 仅写入 process.env（本进程），不落盘。
 * @returns {object} 载入的键值
 */
function loadEnvFile(envFilePath) {
  const loaded = {};
  const text = fs.readFileSync(envFilePath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
    loaded[key] = val;
  }
  return loaded;
}

/** 默认 adapter：把任务快照的 provider/params 映射到 synthDoubao（speech_rate 由 speed 换算） */
function defaultSynth({ text, voiceId, provider, ttsParams }) {
  return synthDoubao({
    text,
    voiceId,
    resourceId: (provider && provider.resource_id) || undefined,
    speechRate: speedToSpeechRate(ttsParams && ttsParams.speed)
  });
}

/** 只读列出待做（可调度）的 tts 任务 */
function listTtsTasks(absEpDir) {
  const manifest = readJsonFile(path.join(absEpDir, 'manifest.json'), { label: 'manifest.json' });
  const all = (manifest.render_tasks || []).filter(t => t && (t.stage || 'video') === 'tts');
  const dispatchable = all.filter(isDispatchable);
  console.log(`TTS tasks (${dispatchable.length} dispatchable / ${all.length} total):`);
  for (const t of dispatchable) {
    const tts = t.tts || {};
    const excerpt = String(tts.dialogue_text || '').slice(0, 40);
    console.log(`  ${t.task_id}  ${t.shot_id}  ${t.take_id || '(no take id)'}  [${t.status}]  voice=${tts.voice_id || '?'}  ${JSON.stringify(excerpt)}`);
  }
  return dispatchable;
}

/**
 * 锁内提交：写音频（tmp + rename）+ 追加 take + 记 success。
 * 幂等命中同 (task_id, content_digest) 非 rejected take → no-op。
 */
function commitTts(absEpDir, { taskId, audio, requestId, provider, select, cost, probeDuration }) {
  if (cost != null) validateCost(cost);
  const manifestPath = path.join(absEpDir, 'manifest.json');
  const manifest = readJsonFile(manifestPath, { label: 'manifest.json' });
  const task = findTtsTask(manifest, taskId);
  const shot = (manifest.shots || []).find(s => s.id === task.shot_id);
  if (!shot) throw invalidInput(`shot ${task.shot_id} not found in manifest`);

  const digest = bufferContentHash(audio);
  if (!Array.isArray(shot.tts_takes)) shot.tts_takes = [];
  const existing = shot.tts_takes.find(t => t && t.task_id === taskId && t.content_digest === digest && t.status !== 'rejected');
  if (existing) {
    console.log(`  tts take ${existing.id} for task ${taskId} already recorded (same content digest) — idempotent no-op`);
    return { take: existing, manifest, idempotent: true };
  }

  let takeId = task.take_id;
  if (!takeId || shot.tts_takes.some(t => t.id === takeId)) {
    takeId = computeNextTtsTakeId(shot, manifest.render_tasks);
  }
  const audioDir = path.join(absEpDir, 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  const outPath = path.join(audioDir, `${shot.id}-${takeId}.mp3`);
  const tmpPath = path.join(audioDir, `.${path.basename(outPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmpPath, audio);
    fs.renameSync(tmpPath, outPath);
  } catch (e) {
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
    throw e;
  }

  let duration = null;
  try {
    duration = probeDuration(outPath);
  } catch (e) {
    // fail-closed：测得时长失败则不留下未登记的半成品产物
    try { fs.rmSync(outPath, { force: true }); } catch { /* best effort */ }
    throw e;
  }

  const take = {
    id: takeId,
    task_id: taskId,
    status: select ? 'selected' : 'proposed',
    path: outPath,
    input_hash: task.input_hash,
    content_digest: digest,
    duration_sec: duration,
    provider: provider || (task.tts && task.tts.provider) || null,
    request_id: requestId || null,
    at: new Date().toISOString()
  };
  if (select) {
    for (const t of shot.tts_takes) {
      if (t && t.status === 'selected' && t.id !== take.id) t.status = 'proposed';
    }
    shot.selected_tts = take.id;
  }
  shot.tts_takes.push(take);
  // request 在 render-next 建任务时已计一次；此处只记 success，不重复计 request。
  recordOutcome(ensureLedger(manifest), 'tts', 'success', { cost });
  atomicWriteJson(manifestPath, manifest);
  console.log(`  recorded tts take ${take.id} for ${shot.id} (duration ${duration}s)`);
  return { take, manifest, idempotent: false };
}

/**
 * 执行一次 TTS 产物记录（可注入 adapter/probe 以便离线测试）。
 *
 * 两阶段：先锁内读取校验任务快照；合成（网络）在锁外进行；再锁内写盘。
 * 网络调用期间不持锁，避免长时间占用；manifest 写入始终受锁保护。
 *
 * @param {string} absEpDir
 * @param {{taskId:string, takePath?:string, select?:boolean, cost?:number|string,
 *   synth?:function, probeDurationSec?:function, requestId?:string}} opts
 * @returns {Promise<{take:object, manifest:object, idempotent:boolean}>}
 */
async function runTts(absEpDir, opts = {}) {
  const synth = typeof opts.synth === 'function' ? opts.synth : defaultSynth;
  const probeDuration = typeof opts.probeDurationSec === 'function' ? opts.probeDurationSec : defaultProbeDurationSec;
  const taskId = opts.taskId;
  if (!taskId) throw invalidInput('--task <task-id> is required');

  // Phase 1（锁内只读）：定位并校验任务快照，取出 tts 参数
  const snapshot = withLock(absEpDir, () => {
    const manifest = readJsonFile(path.join(absEpDir, 'manifest.json'), { label: 'manifest.json' });
    const task = findTtsTask(manifest, taskId);
    const shot = (manifest.shots || []).find(s => s.id === task.shot_id);
    if (!shot) throw invalidInput(`shot ${task.shot_id} not found in manifest`);
    return { task: JSON.parse(JSON.stringify(task)), shotId: shot.id };
  });

  // Phase 2（锁外）：产出音频字节
  let audio;
  let requestId = null;
  let provider = (snapshot.task.tts && snapshot.task.tts.provider) || null;
  if (opts.takePath) {
    const takeAbs = path.resolve(opts.takePath);
    if (!fs.existsSync(takeAbs)) throw invalidInput(`--take file not found: ${takeAbs}`);
    audio = fs.readFileSync(takeAbs);
    requestId = opts.requestId || null;
  } else {
    const tts = snapshot.task.tts || {};
    try {
      const result = await synth({
        text: tts.dialogue_text,
        voiceId: tts.voice_id,
        provider: tts.provider || null,
        ttsParams: tts.tts_params || {}
      });
      if (!result || !Buffer.isBuffer(result.audio)) {
        throw new Error('tts adapter did not return an audio Buffer');
      }
      audio = result.audio;
      requestId = result.requestId || null;
      provider = result.provider || provider;
    } catch (e) {
      e.kind = e.kind || classifyTtsError(e);
      e.ttsTask = snapshot.task;
      throw e;
    }
  }

  // Phase 3（锁内）：写音频 + 追加 take（幂等）
  return withLock(absEpDir, () => commitTts(absEpDir, {
    taskId,
    audio,
    requestId,
    provider,
    select: opts.select === true,
    cost: opts.cost,
    probeDuration
  }));
}

function usage() {
  console.error('Usage: node tools/tts.js <episode-dir> --task <task_id> [--select] [--env-file <path>]');
  console.error('       node tools/tts.js <episode-dir> --task <task_id> --take <audio-path> [--select]');
  console.error('       node tools/tts.js <episode-dir> --list');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.episodeDir) { usage(); return 1; }
  const absEpDir = path.isAbsolute(opts.episodeDir) ? opts.episodeDir : path.resolve(opts.episodeDir);

  if (opts.envFile) {
    try { loadEnvFile(path.resolve(opts.envFile)); }
    catch (e) { console.error(`ERROR: cannot read --env-file: ${e.message}`); return 1; }
  }

  if (opts.list) {
    try { listTtsTasks(absEpDir); }
    catch (e) { console.error(`ERROR: ${e.message}`); return 2; }
    return 0;
  }

  if (!opts.taskId) {
    console.error('ERROR: --task <task-id> is required (or use --list)');
    usage();
    return 1;
  }

  try {
    await runTts(absEpDir, opts);
  } catch (e) {
    const kind = e.kind || classifyTtsError(e);
    if (kind === 'invalid') {
      console.error(`ERROR: tts invalid: ${e.message}`);
      console.error('  (input/state error — nothing was recorded and no attempt should be reported)');
      return 2;
    }
    console.error(`ERROR: tts failed (${kind}): ${e.message}`);
    const t = e.ttsTask;
    if (t) {
      const billed = kind === 'hard' ? ' --billed' : '';
      console.error(`  report it: node tools/mark-shot.js ${opts.episodeDir} ${t.shot_id} --failed --task ${t.task_id} --kind ${kind}${billed}`);
    }
    return 3;
  }
}

module.exports = {
  parseArgs,
  loadEnvFile,
  bufferContentHash,
  findTtsTask,
  listTtsTasks,
  commitTts,
  runTts,
  defaultSynth
};

if (require.main === module) {
  main().then(code => { process.exitCode = code || 0; });
}
