#!/usr/bin/env node
/**
 * mark-shot.js — Take 管理 + 状态回写 manifest + catalog
 *
 * V2.2 改进:
 *   - --take --task <task-id>: 从 render_task 不可变快照复制 input_hash + prompt + params 到 take
 *     (不再在完成时重新计算 hash,避免"生成期间改稿"导致 take 冒充新输入)
 *   - --review --take-id <id> --conclusion accept|reject: 人工复核记录
 *     绑定审核时的 input_hash + 结论 + 时间;历史素材(input_hash=null)经复核 accept 后可变 done
 *   - --select 调用 deriveStatus,不直接写 done
 *   - catalog 使用本次创建的 take ID
 *
 * V2.3 改进:
 *   - reject 是终态:已 rejected 或 human_review.conclusion=reject 的 take
 *     不可再 --review accept,也不可 --select(W1)
 *   - catalog 按 (episode, shot_id, take_id) 幂等 upsert;同 key 不同 path → 冲突报错(fail-closed)
 *   - review accept 自动选片时,manifest 与 catalog 选片状态同步;
 *     同 shot 至多一条 selected(select/reject 分支同样保证)(W4)
 *   - nextTakeId 取数字后缀最大值 +1,并避让 render_tasks 已预留的 take_id(W8)
 *   - manifest/catalog 原子写(tmp + rename)(W9)
 *
 * V2.4 (PRD v2.3 §3.0 M0-5):
 *   - stale/late callback:task.input_hash != shot.input_hash 时,产物记 superseded take,
 *     不自动 selected、不碰 current task;task 标 completion=late(§3.5)
 *   - 读 manifest/catalog 用 readJsonFile(损坏不静默使用,带恢复指引)
 *
 * V2.5 (PRD v2.3 §3.5 M1):
 *   - task 状态用新名(succeeded/superseded);旧 completed/obsolete 读取时归一化
 *   - --failed --task <id>:先按 task_id 查原任务(查无报错);追加 attempt 事件
 *     (按 (task_id,n) 幂等),--transient/--hard(--kind hard|transient 同义)人工覆盖,retry_after 指数退避;
 *     transient → retry_wait,hard → failed,触发熔断 → blocked
 *   - 熔断三维度(hard>=3 / transient>=10 / 同 shot failed task cycles>=5)+ breaker_epoch
 *   - --unblock:breaker_epoch+1、active task 置 cancelled、清 blocked 状态、历史事件保留
 *   - 回写 take 时 task 置 succeeded + completion;late callback 追加 callback_received 事件
 *
 * 用法:
 *   node tools/mark-shot.js <ep> <shot> --take --task <task-id> --path <mp4> [--model <m>] [--notes "..."] [--cost <n>]
 *   node tools/mark-shot.js <ep> <shot> --select --take-id <take-id>
 *   node tools/mark-shot.js <ep> <shot> --reject --take-id <take-id>
 *   node tools/mark-shot.js <ep> <shot> --review --take-id <take-id> --conclusion accept|reject
 *   node tools/mark-shot.js <ep> <shot> --rendering
 *   node tools/mark-shot.js <ep> <shot> --failed --task <task-id> --error "<msg>" [--transient|--hard] [--attempt <n>] [--billed|--no-billed] [--cost <n>]
 *   node tools/mark-shot.js <ep> <shot> --unblock
 *   node tools/mark-shot.js <ep> <shot> --pending
 *   node tools/mark-shot.js <ep> <shot> --done --path <mp4>  (V1 兼容,不推荐)
 *
 * V2.6 (PRD v2.3 §4 M1b):
 *   - 写入 manifest.quota_ledger:--take → video.successes;
 *     --review --conclusion reject / --reject → video.rejects;
 *     --failed --task(hard/熔断)→ video.failed_billed;
 *     可选 --cost <n> 累加到 video.actual_cost(有限非负数,非法报错);
 *     --billed / --no-billed 显式控制 failed_billed 计数(供应商实扣无法自动确认时)
 *
 * V2.7 (PRD v2.8 A1/A2/A9/A10):
 *   - A1 失败模型:hard/transient 一律先 retry_wait 累计,--terminal 才 failed;
 *     守卫 isTerminalTaskStatus || isTaskSuperseded;事件带 attempt_id/request_id,
 *     按 attempt_id 或 (task_id,n) 幂等;--unblock 取消 active+blocked 任务
 *   - A2 superseded 素材 fingerprint 复现恢复 → manifest.reuse_records[](不改写原任务失效历史)
 *   - A9 成功回调按 (task_id, request_id, content_digest) 幂等;同 task 多 request 各自成 take
 *   - A10 调度集合只含 superseded_at==null 的 active task
 *
 * FIX6b:
 *   - resolveAttempt 的 request-only 路径也强制双向唯一(一 attempt ↔ 一 request):
 *     命中 attempt 已绑别的 request_id / request 已属别的 attempt → 抛错零改动;
 *     仅 request_id==null 的 attempt 允许回填;返回值与持久字段一致。
 *     (移除旧 MK4「单 attempt 依次接受多个 request」兼容)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  computeInputHash, deriveStatus, atomicWriteJson, readJsonFile, readJsonFileOrNull, CorruptJsonError,
  normalizeTaskStatus, isActiveTaskStatus, isTerminalTaskStatus, isTaskSuperseded, fileContentHash, classifyError, appendTaskEvent, nextAttemptN,
  computeRetryDelay, evaluateBreaker
} = require('./build-manifest');
const { ensureLedger, recordOutcome, validateCost } = require('./quota-ledger');
const { withLock } = require('./lock');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const [episodeDir, shotId, ...rest] = argv;
  const opts = {
    episodeDir, shotId,
    action: null, path: null, model: null, notes: null,
    takeId: null, error: null, taskId: null, conclusion: null,
    kindOverride: null, attemptN: null, cost: null, billed: undefined,
    terminal: false, attemptId: null, requestId: null
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--take') opts.action = 'take';
    else if (a === '--select') opts.action = 'select';
    else if (a === '--reject') opts.action = 'reject';
    else if (a === '--review') opts.action = 'review';
    else if (a === '--rendering') opts.action = 'rendering';
    else if (a === '--done') opts.action = 'done';
    else if (a === '--failed') opts.action = 'failed';
    else if (a === '--pending') opts.action = 'pending';
    else if (a === '--unblock') opts.action = 'unblock';
    else if (a === '--transient') opts.kindOverride = 'transient';
    else if (a === '--hard') opts.kindOverride = 'hard';
    else if (a === '--kind') { const v = rest[++i]; if (v === 'hard' || v === 'transient') opts.kindOverride = v; }
    else if (a === '--terminal') opts.terminal = true;
    else if (a === '--billed') opts.billed = true;
    else if (a === '--no-billed') opts.billed = false;
    else if (a === '--cost') opts.cost = rest[++i];
    else if (a === '--path') opts.path = rest[++i];
    else if (a === '--model') opts.model = rest[++i];
    else if (a === '--notes') opts.notes = rest[++i];
    else if (a === '--take-id') opts.takeId = rest[++i];
    else if (a === '--error') opts.error = rest[++i];
    else if (a === '--task') opts.taskId = rest[++i];
    else if (a === '--attempt-id') opts.attemptId = rest[++i];
    else if (a === '--request-id') opts.requestId = rest[++i];
    else if (a === '--conclusion') opts.conclusion = rest[++i];
    else if (a === '--attempt') opts.attemptN = parseInt(rest[++i], 10);
  }
  return opts;
}

/** §3.5 本地 attempt_id */
function genAttemptId() {
  return 'att-' + crypto.randomBytes(4).toString('hex');
}

/**
 * §3.5 superseded 素材的人工恢复:仅当 take 的 fingerprint 与当前 input 复现时,
 * 向 manifest.reuse_records[] 追加恢复记录;**不改写原任务 superseded_at/by**。
 * @returns {boolean} 是否追加了恢复记录
 */
function recordFingerprintReuse(manifest, shot, take) {
  const task = (manifest.render_tasks || []).find(t => t.task_id === take.task_id);
  const superseded = take.status === 'superseded' || (task && isTaskSuperseded(task));
  if (!superseded) return false;
  if (take.input_hash === null || take.input_hash === undefined || take.input_hash !== shot.input_hash) return false;
  if (!manifest.reuse_records) manifest.reuse_records = [];
  const digest = take.content_digest != null
    ? take.content_digest
    : (take.path ? fileContentHash(take.path) : null);
  const rec = {
    take_id: take.id,
    source_task_id: take.task_id || null,
    source_artifact_digest: digest,
    bound_input_hash: shot.input_hash,
    reason: 'fingerprint_recurrence',
    at: new Date().toISOString()
  };
  const dup = manifest.reuse_records.find(r => r.take_id === rec.take_id && r.bound_input_hash === rec.bound_input_hash && r.reason === rec.reason);
  if (!dup) manifest.reuse_records.push(rec);
  return true;
}

function nextTakeId(takes, reservedIds) {
  const ids = [
    ...(takes || []).map(t => t.id),
    ...(reservedIds || [])
  ];
  let max = 0;
  for (const id of ids) {
    const m = /^take-(\d+)$/.exec(id || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `take-${String(max + 1).padStart(3, '0')}`;
}

/** render_tasks 中该 shot 已预留的 take_id(避免手动 --take 重号) */
function reservedTakeIds(manifest, shotId) {
  return (manifest.render_tasks || [])
    .filter(t => t.shot_id === shotId && t.take_id)
    .map(t => t.take_id);
}

/**
 * 从 render_task 获取不可变输入快照
 * @returns {{ input_hash, prompt, model, task_id } | null}
 */
function getTaskSnapshot(manifest, taskId) {
  const tasks = manifest.render_tasks || [];
  return tasks.find(t => t.task_id === taskId) || null;
}

/**
 * §3.5/FIX3 回调身份解析:把 --take / --failed 绑定到具体的派发 attempt。
 * 规则(不得用可变的 current_attempt_id 兜底):
 *   - --attempt-id:必须命中 task.attempts(或 legacy current_attempt_id),否则抛错;
 *   - 仅 --request-id:先按 attempts[].request_id,再按 task_events 同 request_id 的事件;
 *     命中 attempt 未绑定时可将 request_id 回填到该 attempt;
 *     FIX6b:命中 attempt 已绑别的 request_id / request 已属于别的 attempt → 抛错零改动
 *     (一 attempt ↔ 一 request);多 attempt 且无命中 → 抛错要求 --attempt-id;
 *   - 都不提供:仅 attempts.length <= 1(或 legacy 无 attempts 但有 current)允许绑定;
 *     多 attempt → 抛错要求身份。
 * @returns {{attempt_id: string|null, request_id: string|null, attempt: object|null}}
 */
function resolveAttempt(task, opts = {}, manifest = {}) {
  if (!task) throw new Error('resolveAttempt: task is required');
  const attempts = Array.isArray(task.attempts) ? task.attempts : (task.attempts = []);
  const events = manifest.task_events || [];
  const legacyCurrent = task.current_attempt_id || null;
  // FIX5c:建立 request↔attempt 双向唯一映射(task.attempts 优先,manifest.task_events 补全),
  // 在落库前校验,防止同一 request 被绑到两个 attempt / 同一 attempt 被绑两个 request。
  const requestToAttempt = new Map();
  const attemptToRequest = new Map();
  for (const a of attempts) {
    if (a && a.attempt_id && a.request_id && !requestToAttempt.has(a.request_id)) {
      requestToAttempt.set(a.request_id, a.attempt_id);
    }
    if (a && a.attempt_id && a.request_id && !attemptToRequest.has(a.attempt_id)) {
      attemptToRequest.set(a.attempt_id, a.request_id);
    }
  }
  for (const e of events) {
    if (!e || e.task_id !== task.task_id || !e.request_id || !e.attempt_id) continue;
    if (!requestToAttempt.has(e.request_id)) requestToAttempt.set(e.request_id, e.attempt_id);
    if (!attemptToRequest.has(e.attempt_id)) attemptToRequest.set(e.attempt_id, e.request_id);
  }
  /** request→attempt 唯一性冲突则抛错(零改动);一致(幂等重复)或无映射时放行 */
  const assertRequestUnique = (requestId, attemptId) => {
    if (requestId && requestToAttempt.has(requestId) && requestToAttempt.get(requestId) !== attemptId) {
      throw new Error(`request_id ${requestId} is already bound to attempt ${requestToAttempt.get(requestId)} — refusing to bind it to attempt ${attemptId} (one request maps to exactly one attempt)`);
    }
  };
  /**
   * 显式 --attempt-id + --request-id 组合:同时校验 request↔attempt 双向唯一。
   * 仅 request_id 的路径也必须满足同一不变量(见 assertRequestOnlyBinding)。
   */
  const assertUniqueBinding = (requestId, attemptId) => {
    assertRequestUnique(requestId, attemptId);
    if (attemptId && attemptToRequest.has(attemptId) && requestId && attemptToRequest.get(attemptId) !== requestId) {
      throw new Error(`attempt ${attemptId} is already bound to request_id ${attemptToRequest.get(attemptId)} — refusing to bind request_id ${requestId} (one attempt maps to exactly one request)`);
    }
  };
  /**
   * FIX6b:request-only 路径的双向绑定校验(一 attempt ↔ 一 request,FIX5/v2.7 契约;
   * 旧 MK4 兼容「单 attempt 依次接受多个 request」已移除)。
   *  - request_id 已属于别的 attempt → 抛错;
   *  - 命中 attempt 已绑定另一 request_id → 抛错(消息同时点名两个 request_id 与 attempt_id);
   *  - 仅 request_id == null 的 attempt 允许回填。
   */
  const assertRequestOnlyBinding = (requestId, attemptId) => {
    assertRequestUnique(requestId, attemptId || null);
    if (attemptId && attemptToRequest.has(attemptId) && attemptToRequest.get(attemptId) !== requestId) {
      throw new Error(`attempt ${attemptId} is already bound to request_id ${attemptToRequest.get(attemptId)} — refusing to bind request_id ${requestId} (one attempt maps to exactly one request)`);
    }
  };
  // request_id 回填到对应 attempt,供后续成功/失败回调解析
  const backfill = (att, requestId) => {
    if (att && requestId && !att.request_id) att.request_id = requestId;
    return att;
  };

  // 1) 显式 attempt_id
  if (opts.attemptId) {
    let att = attempts.find(a => a && a.attempt_id === opts.attemptId);
    if (!att && legacyCurrent === opts.attemptId) {
      att = { attempt_id: legacyCurrent, at: null, input_hash: task.input_hash, request_id: null };
      attempts.push(att);
    }
    if (!att) {
      throw new Error(`unknown attempt_id ${opts.attemptId} for task ${task.task_id} — refusing to guess`);
    }
    assertUniqueBinding(opts.requestId || null, att.attempt_id || null);
    backfill(att, opts.requestId);
    return { attempt_id: att.attempt_id, request_id: opts.requestId || att.request_id || null, attempt: att };
  }

  // 2) 仅 request_id
  if (opts.requestId) {
    let att = attempts.find(a => a && a.request_id === opts.requestId);
    if (!att) {
      const ev = events.find(e => e && e.task_id === task.task_id && e.request_id === opts.requestId && e.attempt_id);
      if (ev) {
        att = attempts.find(a => a && a.attempt_id === ev.attempt_id)
          || { attempt_id: ev.attempt_id, at: null, input_hash: task.input_hash, request_id: null };
      }
    }
    if (att) {
      assertRequestOnlyBinding(opts.requestId, att.attempt_id || null);
      backfill(att, opts.requestId);
      return { attempt_id: att.attempt_id || null, request_id: att.request_id || opts.requestId, attempt: att };
    }
    if (attempts.length <= 1) {
      const only = attempts[0] || (legacyCurrent ? { attempt_id: legacyCurrent, at: null, input_hash: task.input_hash, request_id: null } : null);
      if (only) {
        assertRequestOnlyBinding(opts.requestId, only.attempt_id || null);
        backfill(only, opts.requestId);
        return { attempt_id: only.attempt_id || null, request_id: only.request_id || opts.requestId, attempt: only };
      }
      return { attempt_id: null, request_id: opts.requestId, attempt: null };
    }
    throw new Error(`cannot resolve request_id ${opts.requestId} for task ${task.task_id} among ${attempts.length} attempts — pass --attempt-id`);
  }

  // 3) 无身份
  if (attempts.length <= 1) {
    const only = attempts[0] || (legacyCurrent ? { attempt_id: legacyCurrent, at: null, input_hash: task.input_hash, request_id: null } : null);
    return { attempt_id: only ? (only.attempt_id || null) : null, request_id: null, attempt: only };
  }
  throw new Error(`task ${task.task_id} has multiple attempts (${attempts.length}) — pass --attempt-id (or --request-id) to identify the callback`);
}

/**
 * §3.5 任务失败模型(hard/transient 先 retry_wait 累计,--terminal 才 failed,三维熔断)。
 * mark-shot(--failed --task) 与 mark-keyframe(--failed --task) 共用,行为完全一致。
 * ledger stage 由 task.stage 决定(keyframe → image,其余 → video)。
 * @param {{manifest:object, shot:object, shotId:string, opts:object}} args
 * @returns {{task:object, kind:string|null, kind_source:string|null, billed:boolean, n:number, attempt_id:string, blocked:boolean, idempotent:boolean}}
 */
function recordTaskFailure({ manifest, shot, shotId, opts }) {
  const task = getTaskSnapshot(manifest, opts.taskId);
  if (!task) {
    throw new Error(`task ${opts.taskId} not found in manifest.render_tasks (query the task by id before reporting a failure — do not blindly re-submit)`);
  }
  if (task.shot_id !== shotId) {
    throw new Error(`task ${opts.taskId} is for shot ${task.shot_id}, not ${shotId}`);
  }
  // A1:终态/失效守卫(不可调度任务不得上报 attempt)
  if (isTaskSuperseded(task)) {
    throw new Error(`task ${opts.taskId} is superseded (moved out of the dispatch set) — cannot record another attempt; create a new task snapshot first (node tools/render-next.js <episode-dir>)`);
  }
  if (isTerminalTaskStatus(task.status)) {
    throw new Error(`task ${opts.taskId} is terminal (${normalizeTaskStatus(task.status)}) — cannot record another attempt; create a new task snapshot first (node tools/render-next.js <episode-dir>)`);
  }
  const events = manifest.task_events || (manifest.task_events = []);
  const epoch = shot.breaker_epoch || 0;
  if (task.breaker_epoch === undefined || task.breaker_epoch === null) {
    task.breaker_epoch = epoch;
  }
  const n = Number.isFinite(opts.attemptN) && opts.attemptN > 0 ? opts.attemptN : nextAttemptN(events, task.task_id);
  // FIX3/Bug2:按 attempt/request 身份解析;无身份且单 attempt 时绑定该 attempt,
  // legacy 无 attempt 时生成一个新的本地 attempt_id(保持既有行为)。
  const ident = resolveAttempt(task, opts, manifest);
  const attemptId = ident.attempt_id || genAttemptId();
  // A1/P2-N2:同 attempt_id 或同 (task_id,n) 已记录 → 完全 no-op:不得重算 retry_after、不得改状态
  if (events.some(e => e && (e.attempt_id === attemptId || (e.task_id === task.task_id && e.n === n)))) {
    console.log(`  attempt #${n} (${attemptId}) for task ${task.task_id} already recorded (idempotent) — no state change`);
    return { task, kind: null, kind_source: null, billed: false, n, attempt_id: attemptId, blocked: false, idempotent: true };
  }
  const { kind, source } = classifyError(opts.error, opts.kindOverride);
  const at = new Date().toISOString();
  const retryAfter = new Date(Date.now() + computeRetryDelay(n) * 1000).toISOString();

  const { appended } = appendTaskEvent(events, {
    task_id: task.task_id,
    attempt_id: attemptId,
    request_id: ident.request_id || opts.requestId || null,
    shot_id: shot.id,
    stage: task.stage || 'video',
    input_hash: task.input_hash, // 熔断维度 1/2 的计数窗口身份
    n,
    kind,
    kind_source: source,
    error: opts.error == null ? null : opts.error,
    at,
    retry_after: retryAfter,
    epoch
  });

  const verdict = evaluateBreaker({ task, shot, events, tasks: manifest.render_tasks || [] });
  // P1-3:retries 必须跟随“实际追加的事件”,重复上报不重复计数
  if (appended) shot.retries = (shot.retries || 0) + 1;
  shot.error = opts.error == null ? null : opts.error;
  if (verdict.blocked) {
    // 熔断:task + shot 置 blocked,记维度与计数;deriveStatus 保持 blocked
    const reason = `${verdict.dimension} count=${verdict.count} (epoch ${verdict.epoch})`;
    task.status = 'blocked';
    task.blocked_reason = reason;
    shot.status = 'blocked';
    shot.blocked_reason = reason;
    console.warn(`  CIRCUIT BREAKER: ${shotId} blocked — ${reason}`);
  } else if (opts.terminal) {
    // A1:只有显式 --terminal 才是终态 failed
    task.status = 'failed';
    task.retry_after = null;
  } else {
    // A1:hard 与 transient 一样先进入 retry_wait 累计(便于同 task 跨尝试熔断)
    task.status = 'retry_wait';
    task.retry_after = retryAfter;
  }
  if (!verdict.blocked) {
    // 失败后 shot 必须回到可派发状态(pending/stale),否则 render-next 只收 pending|stale,
    // 退避到期的 retry_wait 永远接不上(重试循环断链)
    const ds = deriveStatus(shot, shot.input_hash, 'pending');
    shot.status = ds.status;
    shot.prev_hash = ds.prev_hash;
  }
  // §4 failed_billed:供应商实扣的失败请求(缺省 hard/熔断计一次;transient 重试默认不计)。
  // stage 映射:keyframe → image 账本,tts → tts 账本(M5),其余归 video。
  const ledgerStage = (task.stage === 'keyframe') ? 'image' : (task.stage === 'tts' ? 'tts' : 'video');
  const defaultBilled = verdict.blocked || kind === 'hard';
  const billed = opts.billed === undefined ? defaultBilled : opts.billed === true;
  if (billed) recordOutcome(ensureLedger(manifest), ledgerStage, 'failed_billed', { cost: opts.cost });
  console.log(`  recorded attempt #${n} (${kind}/${source}) for task ${task.task_id} → ${task.status}${billed ? ' [billed]' : ''}`);
  return { task, kind, kind_source: source, billed, n, attempt_id: attemptId, blocked: !!verdict.blocked, idempotent: false };
}

function updateManifest(absEpDir, shotId, opts) {
  const manifestPath = path.join(absEpDir, 'manifest.json');
  const manifest = readJsonFile(manifestPath, { label: 'manifest.json' });
  const shot = manifest.shots.find(s => s.id === shotId);
  if (!shot) throw new Error(`shot ${shotId} not found in manifest`);

  // §4 --cost 数值校验(有限非负数;非法一律报错,不静默忽略)
  if (opts.cost != null) validateCost(opts.cost);
  // §4 账本缺省自动初始化(与 render_tasks 同生命周期,写 manifest 时保证存在)
  ensureLedger(manifest);

  if (!shot.takes) shot.takes = [];
  let createdTakeId = null;
  let takeStatus = 'candidate';

  switch (opts.action) {
    case 'take': {
      if (!opts.path) throw new Error('--take requires --path');
      let takeInputHash = null;
      let takeModel = opts.model || 'unknown';
      let takeId = null;
      let takeAttemptId = null;
      let contentDigest = null;
      let takeRequestId = opts.requestId || null;
      let takeKeyframe = null;

      if (opts.taskId) {
        const task = getTaskSnapshot(manifest, opts.taskId);
        if (!task) throw new Error(`task ${opts.taskId} not found in manifest.render_tasks`);
        // 校验 task.shot_id 匹配目标镜头
        if (task.shot_id !== shotId) {
          throw new Error(`task ${opts.taskId} is for shot ${task.shot_id}, not ${shotId}`);
        }
        // A9:内容摘要用于 (request_id, content_digest) 幂等;缺失/不可读 → 抛错
        contentDigest = fileContentHash(opts.path);
        if (contentDigest === null) {
          throw new Error(`--take requires a readable artifact at --path (content digest unavailable): ${opts.path}`);
        }

        // Bug 2/A9:回调按 attempt/request 身份解析(不得用 current 指针兜底)
        const ident = resolveAttempt(task, opts, manifest);
        takeAttemptId = ident.attempt_id || null;
        takeRequestId = ident.request_id || takeRequestId;

        if (takeRequestId || takeAttemptId) {
          // 有身份:按 (task_id, request_id) / (task_id, attempt_id) 幂等键查重
          const existing = (shot.takes || []).find(t => t.task_id === opts.taskId
            && (takeRequestId ? t.request_id === takeRequestId : t.attempt_id === takeAttemptId));
          if (existing) {
            if (existing.content_digest === contentDigest) {
              console.log(`  request ${takeRequestId || takeAttemptId} for task ${opts.taskId} already recorded as ${existing.id} (idempotent)`);
              return { manifest, createdTakeId: existing.id };
            }
            throw new Error(`conflict: request ${takeRequestId || takeAttemptId} for task ${opts.taskId} already recorded as ${existing.id} with a different content digest (${existing.content_digest} != ${contentDigest}) — refusing to overwrite; local path is locator-only, only content digest decides conflicts`);
          }
        } else {
          // Bug 3:无身份回调。同 task 已有 take 且同 digest → 幂等;digest 全不同 → 报错,
          // 绝不静默丢弃可能的实付产物(也不新增)。
          const taskTakes = (shot.takes || []).filter(t => t.task_id === opts.taskId);
          const sameDigest = taskTakes.find(t => t.content_digest === contentDigest);
          if (sameDigest) {
            console.log(`  task ${opts.taskId} already has take ${sameDigest.id} with the same content digest (idempotent)`);
            return { manifest, createdTakeId: sameDigest.id };
          }
          if (taskTakes.length > 0) {
            throw new Error(`callback for task ${opts.taskId} has no request/attempt identity and a different content digest — pass --request-id (or --attempt-id) to record it as an independent request (refusing to silently drop a possibly paid result)`);
          }
        }
        takeInputHash = task.input_hash;
        takeModel = opts.model || task.model || 'unknown';
        // M3a:视频 take 记录其所绑定的 keyframe 绑定(供 resolveCover 使用;不入 input_hash,
        // A8/M3b 再进 stage payload)。
        takeKeyframe = task.keyframe ? Object.assign({}, task.keyframe) : null;
        takeId = task.take_id; // 任务预留的 take_id;同 task 多 request 时另行分配
        if ((shot.takes || []).some(t => t.id === takeId)) {
          takeId = nextTakeId(shot.takes, reservedTakeIds(manifest, shotId));
        }

        // A1/A9:失效产物与终态迟到回调判定
        const staleArtifact = (task.input_hash !== shot.input_hash) || isTaskSuperseded(task);
        const normStatus = normalizeTaskStatus(task.status);
        const terminalLate = normStatus === 'blocked' || normStatus === 'cancelled';
        const alreadySucceeded = normStatus === 'succeeded';
        const inFlight = ['queued', 'submitted', 'running'].includes(normStatus);
        // 迟到口径:失效/终态/非在途且非“已成功同 task 的另一次请求”
        const lateOutcome = staleArtifact || (!inFlight && !alreadySucceeded && !terminalLate) || terminalLate;
        takeStatus = (staleArtifact || terminalLate) ? 'superseded' : 'candidate';
        if (staleArtifact) {
          console.warn(`WARN: stale callback for task ${opts.taskId} (input_hash ${task.input_hash} != current ${shot.input_hash}) — recording superseded take; NOT selecting it`);
        } else if (terminalLate) {
          console.warn(`WARN: late success for task ${opts.taskId} after terminal status ${normStatus} — recording superseded orphan take; task status NOT revived`);
        } else if (alreadySucceeded) {
          console.warn(`WARN: additional artifact for already-succeeded task ${opts.taskId} (request ${takeRequestId || 'n/a'}) — recording independent candidate take; NOT selecting it`);
        } else if (!inFlight) {
          console.warn(`WARN: late success for task ${opts.taskId} (was ${task.status}) — recording candidate take; NOT selecting it`);
        }
        // A1:blocked/cancelled 任务状态不复活;已 succeeded 的任务保持既有 status/completion 不被第二次请求覆盖
        if (!terminalLate) {
          if (!alreadySucceeded) {
            task.status = 'succeeded';
            task.completion = lateOutcome ? 'late' : 'normal';
          }
        } else {
          task.completion = 'late';
        }

        // late callback 事件(§3.5 事件流记 callback_received {late: true})
        if (lateOutcome) {
          const events = manifest.task_events || (manifest.task_events = []);
          appendTaskEvent(events, {
            task_id: task.task_id,
            attempt_id: takeAttemptId,
            request_id: takeRequestId,
            shot_id: shot.id,
            stage: task.stage || 'video',
            input_hash: task.input_hash,
            n: nextAttemptN(events, task.task_id),
            kind: 'callback_received',
            late: true,
            after_terminal: terminalLate,
            error: null,
            at: new Date().toISOString(),
            retry_after: null,
            epoch: shot.breaker_epoch || 0
          });
        }
      } else {
        // 无 --task:来源未知,input_hash=null,需人工复核;仍要求可读 artifact(A9 content digest)
        contentDigest = fileContentHash(opts.path);
        if (contentDigest === null) {
          throw new Error(`--take requires a readable artifact at --path (content digest unavailable): ${opts.path}`);
        }
        console.warn('WARN: --take without --task — input_hash set to null (source unknown, requires --review to approve)');
        takeId = opts.takeId || nextTakeId(shot.takes, reservedTakeIds(manifest, shotId));
      }

      // 检查 take_id 是否已存在(防重复)
      if ((shot.takes || []).find(t => t.id === takeId)) {
        throw new Error(`take ${takeId} already exists for ${shotId} (duplicate take_id)`);
      }

      shot.takes.push({
        id: takeId,
        path: opts.path,
        model: takeModel,
        input_hash: takeInputHash,
        task_id: opts.taskId || null,
        request_id: takeRequestId,
        content_digest: contentDigest,
        attempt_id: takeAttemptId,
        rendered_at: new Date().toISOString(),
        status: takeStatus, // superseded = stale/orphan artifact(不得自动进成片)
        keyframe: takeKeyframe, // {take_id, content_digest, frozen_path} | null
        notes: opts.notes || ''
      });
      createdTakeId = takeId;
      // §4 成功回写 = 一次 success(superseded/late 成功也是供应商实付的成功)
      recordOutcome(ensureLedger(manifest), 'video', 'success', { cost: opts.cost });
      console.log(`  recorded ${takeId} for ${shotId} (status stays ${shot.status})`);
      break;
    }
    case 'select': {
      if (!opts.takeId) throw new Error('--select requires --take-id');
      // blocked 是熔断终态:必须先 --unblock,任何选片路径不得绕过
      if (shot.status === 'blocked') {
        throw new Error(`shot ${shotId} is blocked (${shot.blocked_reason || 'circuit breaker'}) — run --unblock before selecting`);
      }
      const take = shot.takes.find(t => t.id === opts.takeId);
      if (!take) throw new Error(`take ${opts.takeId} not found in ${shotId}`);
      // 不能 select rejected take(rejected 是终态:显式 reject 或人工审核 reject)
      if (take.status === 'rejected') {
        throw new Error(`take ${opts.takeId} is rejected, cannot select`);
      }
      if (take.human_review && take.human_review.conclusion === 'reject') {
        throw new Error(`take ${opts.takeId} was reviewed and rejected, cannot select`);
      }
      if (!take.path || !fs.existsSync(take.path)) {
        throw new Error(`take ${opts.takeId} file missing: ${take.path || '(null)'}`);
      }
      // D7:选中前硬性校验 input fingerprint。select 与 --review accept 是同一不变量:
      // take.input_hash != null 且 ≠ 当前 shot.input_hash 时报错(空 null = 来源未知 legacy 允许)。
      // fingerprint 复现(相等)仍允许,包括 superseded take 的人工恢复。
      if (take.input_hash != null && take.input_hash !== shot.input_hash) {
        throw new Error(`take ${opts.takeId} input fingerprint mismatch (take ${take.input_hash}, current ${shot.input_hash}) — cannot select a take generated from different input; regenerate or restore the matching input`);
      }
      // A2:superseded 素材经 fingerprint 复现恢复 → 追加 reuse_record(不改写原任务失效历史)
      if (recordFingerprintReuse(manifest, shot, take)) {
        console.log(`  recorded reuse_record for ${take.id} (fingerprint recurrence)`);
      }
      for (const t of shot.takes) {
        if (t.status === 'selected') t.status = 'candidate';
      }
      take.status = 'selected';
      shot.selected_take = take.id;
      const { status, prev_hash } = deriveStatus(shot, shot.input_hash, null);
      shot.status = status;
      shot.prev_hash = prev_hash;
      shot.output_path = take.path;
      shot.rendered_at = take.rendered_at;
      shot.error = null;
      console.log(`  selected ${take.id} for ${shotId} → status: ${status}`);
      break;
    }
    case 'reject': {
      if (!opts.takeId) throw new Error('--reject requires --take-id');
      const take = shot.takes.find(t => t.id === opts.takeId);
      if (!take) throw new Error(`take ${opts.takeId} not found in ${shotId}`);
      const wasRejected = take.status === 'rejected';
      take.status = 'rejected';
      if (shot.selected_take === take.id) {
        shot.selected_take = null;
        shot.output_path = null;
        const { status } = deriveStatus(shot, shot.input_hash, null);
        shot.status = status;
      }
      // §4 拒绝计数(幂等:仅首次进入 rejected 终态时计一次);--cost 记 rejected 生成成本
      if (!wasRejected) recordOutcome(ensureLedger(manifest), 'video', 'reject', { cost: opts.cost });
      console.log(`  rejected ${take.id} for ${shotId}`);
      break;
    }
    case 'review': {
      if (!opts.takeId) throw new Error('--review requires --take-id');
      if (!opts.conclusion) throw new Error('--review requires --conclusion accept|reject');
      if (opts.conclusion !== 'accept' && opts.conclusion !== 'reject') {
        throw new Error('--conclusion must be accept or reject');
      }
      const take = shot.takes.find(t => t.id === opts.takeId);
      if (!take) throw new Error(`take ${opts.takeId} not found in ${shotId}`);
      // reject 是终态:已 rejected 或已被人工审核 reject 的 take 不可再 accept(不修改任何字段)
      if (opts.conclusion === 'accept') {
        if (shot.status === 'blocked') {
          throw new Error(`shot ${shotId} is blocked (${shot.blocked_reason || 'circuit breaker'}) — run --unblock before approving`);
        }
        if (take.status === 'rejected' || (take.human_review && take.human_review.conclusion === 'reject')) {
          throw new Error(`take ${opts.takeId} is rejected (terminal state) — cannot accept`);
        }
        // P0-1:superseded(旧 input 的 late/orphan 产物)不得用 --review accept 洗白成当前版本的合法素材
        if (take.status === 'superseded' && take.input_hash !== shot.input_hash) {
          throw new Error(`take ${opts.takeId} is superseded (stale/orphan artifact from input ${take.input_hash}, current ${shot.input_hash}) — cannot be approved; re-select it manually only if the input fingerprint matches again`);
        }
        // P1-N1:写入口必须执行与 validateTake 相同的一致性检查(candidate/selected 且 input 不匹配也拦住),
        // 否则 stitch --preview 会静默混入旧输入产物,到 --final 才暴露。
        // take.input_hash == null 表示来源未知的历史素材,允许人工复核后绑定当前输入。
        if (take.input_hash != null && take.input_hash !== shot.input_hash) {
          throw new Error(`take ${opts.takeId} was generated from input ${take.input_hash}, current is ${shot.input_hash} — cannot approve as the current version (write path enforces the same invariant as validateTake)`);
        }
        // A2:superseded 素材经 fingerprint 复现恢复 → 追加 reuse_record(不改写原任务失效历史)
        if (recordFingerprintReuse(manifest, shot, take)) {
          console.log(`  recorded reuse_record for ${take.id} (fingerprint recurrence)`);
        }
      }
      // 绑定审核时的输入版本 + 结论 + 时间(审核结论独立于选片指针)
      take.human_review = {
        reviewed_input_hash: shot.input_hash,
        conclusion: opts.conclusion,
        reviewed_at: new Date().toISOString(),
        reviewer: process.env.USER || 'unknown'
      };
      if (opts.conclusion === 'reject') {
        // 拒绝 = 终态:status 标记 rejected,若它是当前选片则清除指针
        const wasRejected = take.status === 'rejected';
        take.status = 'rejected';
        // §4 人工拒绝计入 rejects(幂等:已 rejected 的 take 不重复计数);--cost 记 rejected 生成成本
        if (!wasRejected) recordOutcome(ensureLedger(manifest), 'video', 'reject', { cost: opts.cost });
        if (shot.selected_take === take.id) {
          shot.selected_take = null;
          shot.output_path = null;
        }
      } else if (opts.conclusion === 'accept' && shot.selected_take !== take.id) {
        // accept 时不强占选片指针(指针仍由 --select 单独管理);
        // 但若当前无选片,则把它设为默认选片
        if (!shot.selected_take) {
          take.status = 'selected';
          shot.selected_take = take.id;
          shot.output_path = take.path;
        }
      }
      const { status, prev_hash } = deriveStatus(shot, shot.input_hash, null);
      shot.status = status;
      shot.prev_hash = prev_hash;
      console.log(`  reviewed ${take.id} for ${shotId} (${opts.conclusion}) → status: ${status}`);
      break;
    }
    case 'rendering': {
      // P2-N1:blocked 是熔断终态,不得被 --rendering 绕过(否则 epoch/active task/原因全部悬空)
      if (shot.status === 'blocked') {
        throw new Error(`shot ${shotId} is blocked (${shot.blocked_reason || 'circuit breaker'}) — run --unblock before marking rendering`);
      }
      shot.status = 'rendering';
      console.log(`  marked ${shotId} as rendering`);
      break;
    }
    case 'failed': {
      // 任务维度的失败(traceable attempt):--failed --task <id>
      if (opts.taskId) {
        recordTaskFailure({ manifest, shot, shotId, opts });
      } else {
        // D5:legacy shot 级 failed(无 task 追踪)。
        // schema >= 2 的集一律拒绝:必须先 render-next 建任务快照,再用 --failed --task <id>,
        // 保证 attempt 事件流与熔断守卫生效;v1 保留旧行为并警告(迁移前兼容)。
        const schemaVersion = Number(manifest.schema_version || 1) || 1;
        if (schemaVersion >= 2) {
          throw new Error(`--failed without --task is not allowed on schema v${schemaVersion} manifests: run 'node tools/render-next.js <episode-dir>' to create a task snapshot, then use --failed --task <task-id> (no state changed)`);
        }
        console.warn('WARN: legacy --failed without --task (v1 path) — no attempt event; migrate to schema 2');
        shot.status = 'failed';
        shot.error = opts.error;
        shot.retries = (shot.retries || 0) + 1;
        console.log(`  marked ${shotId} as failed: ${opts.error}`);
      }
      break;
    }
    case 'unblock': {
      // §3.5 熔断恢复:epoch+1 开启新计数窗口,取消该 shot 的 active 与 blocked 任务,清除 blocked 状态
      shot.breaker_epoch = (shot.breaker_epoch || 0) + 1;
      for (const t of (manifest.render_tasks || [])) {
        if (t.shot_id !== shot.id) continue;
        const st = normalizeTaskStatus(t.status);
        if (isActiveTaskStatus(t.status) || st === 'blocked') {
          t.status = 'cancelled';
          t.error = 'cancelled by --unblock (breaker reset)';
        }
      }
      shot.blocked_reason = null;
      shot.error = null;
      // 显式解除 blocked 终态,再按常规规则派生(deriveStatus 不再看到 blocked)
      shot.status = 'pending';
      const { status, prev_hash } = deriveStatus(shot, shot.input_hash, 'pending');
      shot.status = status;
      shot.prev_hash = prev_hash;
      console.log(`  unblocked ${shotId}: breaker_epoch → ${shot.breaker_epoch}, status → ${status}`);
      break;
    }
    case 'pending': {
      // P2-N1:blocked 是熔断终态,不得被 --pending 绕过(否则 epoch/active task/原因全部悬空)
      if (shot.status === 'blocked') {
        throw new Error(`shot ${shotId} is blocked (${shot.blocked_reason || 'circuit breaker'}) — run --unblock before resetting to pending`);
      }
      shot.status = 'pending';
      shot.output_path = null;
      shot.rendered_at = null;
      shot.error = null;
      shot.selected_take = null;
      console.log(`  reset ${shotId} to pending (takes preserved)`);
      break;
    }
    case 'done': {
      // V1 兼容:不推荐,用 --take --task + --select 代替
      if (!opts.path) throw new Error('--done requires --path');
      console.warn('WARN: --done is deprecated, use --take --task + --select instead');
      const takeId = nextTakeId(shot.takes, reservedTakeIds(manifest, shotId));
      const inputHash = computeInputHash(
        shot.prompt_final_en, shot.image_paths || [],
        shot.duration || 8, shot.ratio || '16:9', shot.resolution || '720p', shot.model || 'default',
        { schemaVersion: manifest.schema_version || 1 }
      );
      shot.takes.push({
        id: takeId, path: opts.path, model: opts.model || 'unknown',
        input_hash: inputHash, task_id: null,
        rendered_at: new Date().toISOString(), status: 'selected', notes: opts.notes || ''
      });
      shot.selected_take = takeId;
      const { status, prev_hash } = deriveStatus(shot, shot.input_hash, null);
      shot.status = status;
      shot.prev_hash = prev_hash;
      shot.output_path = opts.path;
      shot.rendered_at = new Date().toISOString();
      shot.error = null;
      createdTakeId = takeId;
      console.log(`  marked ${shotId} (take ${takeId}) → status: ${status}`);
      break;
    }
    default:
      throw new Error('no action (--take/--select/--reject/--review/--rendering/--done/--failed/--pending)');
  }

  atomicWriteJson(manifestPath, manifest);
  return { manifest, createdTakeId };
}

function findCatalogEntry(catalog, episode, shotId, takeId) {
  return catalog.find(e =>
    e.episode === episode && e.shot_id === shotId && e.take_id === takeId
  );
}

/**
 * 保证同一 (shot, stage) 在 catalog 中至多一条 selected,并与 manifest 的
 * selected_take / selected_keyframe 对齐:
 * - selectedTakeId 匹配的条目 → selected(已是 rejected 的不复活)
 * - 其他条目若为 selected → 降为 candidate
 * stage 缺省 'video'(legacy 条目无 stage 字段,按 video 处理);keyframe 条目
 * (stage:'keyframe')与 video 条目互不干扰。
 */
function syncCatalogSelection(catalog, episode, shotId, selectedTakeId, stage = 'video') {
  for (const e of catalog) {
    if (e.episode !== episode || e.shot_id !== shotId) continue;
    if ((e.stage || 'video') !== stage) continue; // 只同步同 stage 条目
    if (selectedTakeId && e.take_id === selectedTakeId) {
      if (e.status !== 'rejected') e.status = 'selected';
    } else if (e.status === 'selected') {
      e.status = 'candidate';
    }
  }
}

function appendCatalog(absEpDir, shotId, opts, manifest, createdTakeId, catalogPath) {
  catalogPath = catalogPath || path.join(ROOT, 'catalog.json');
  const catRead = readJsonFileOrNull(catalogPath, { label: 'catalog.json' });
  if (catRead.corrupt) {
    // fail-closed:损坏 catalog 不能当空台账覆盖(会丢恢复历史)
    throw new CorruptJsonError(catRead.guidance);
  }
  let catalog = catRead.value || [];

  // stage 区分:mark-shot 写 video,mark-keyframe 以 opts.stage='keyframe' 写 keyframe
  const stage = opts.stage === 'keyframe' ? 'keyframe' : 'video';
  const takeField = stage === 'keyframe' ? 'keyframe_takes' : 'takes';
  const selectedField = stage === 'keyframe' ? 'selected_keyframe' : 'selected_take';

  const episode = manifest.episode;
  const shot = (manifest.shots || []).find(s => s.id === shotId);
  const shotTakes = shot ? (shot[takeField] || []) : [];
  const manifestSelected = shot ? shot[selectedField] : null;

  if ((opts.action === 'take' || opts.action === 'done') && createdTakeId) {
    // manifest 是 take 状态的唯一权威:镜像其状态(含 superseded/rejected),不自行推导
    const manifestTake = shotTakes.find(t => t.id === createdTakeId);
    const desiredStatus = manifestTake ? manifestTake.status : (opts.action === 'done' ? 'selected' : 'candidate');
    const existing = findCatalogEntry(catalog, episode, shotId, createdTakeId);
    if (existing) {
      // fail-closed:同一 (episode, shot_id, take_id) 不同 path 不允许静默覆盖
      if (existing.path && opts.path && existing.path !== opts.path) {
        throw new Error(`catalog conflict for ${episode}/${shotId}/${createdTakeId}: existing path '${existing.path}', new path '${opts.path}' — refusing to overwrite. Recovery: inspect ${catalogPath} and resolve the duplicate (keep the intended path or remove the stale entry), then re-run.`);
      }
      existing.model = opts.model || existing.model;
      existing.status = desiredStatus; // 镜像 manifest(manifest 侧已保证 rejected 终态)
      existing.rendered_at = new Date().toISOString();
      existing.error = null;
      // 已有条目不动 stage 字段(旧条目可能缺 stage,恢复侧按 video 处理)
    } else {
      catalog.push({
        episode, shot_id: shotId, take_id: createdTakeId, stage,
        model: opts.model || 'unknown', path: opts.path,
        status: desiredStatus,
        rendered_at: new Date().toISOString(), error: null
      });
    }
    syncCatalogSelection(catalog, episode, shotId, manifestSelected, stage);
  } else if (opts.action === 'select' && opts.takeId) {
    const entry = findCatalogEntry(catalog, episode, shotId, opts.takeId);
    if (entry && entry.status !== 'rejected') entry.status = 'selected';
    syncCatalogSelection(catalog, episode, shotId, manifestSelected || opts.takeId, stage);
  } else if (opts.action === 'reject' && opts.takeId) {
    const entry = findCatalogEntry(catalog, episode, shotId, opts.takeId);
    if (entry) entry.status = 'rejected';
    syncCatalogSelection(catalog, episode, shotId, manifestSelected, stage);
  } else if (opts.action === 'review' && opts.takeId) {
    // 同步人工审核结论到 catalog(恢复时保留审核历史)
    const take = shotTakes.find(t => t.id === opts.takeId);
    const entry = findCatalogEntry(catalog, episode, shotId, opts.takeId);
    if (entry) {
      if (take) entry.human_review = take.human_review;
      if (opts.conclusion === 'reject') entry.status = 'rejected';
    }
    // accept:若 manifest 已选此 take → catalog 同步 selected;否则只写 human_review
    syncCatalogSelection(catalog, episode, shotId, manifestSelected, stage);
  } else if (opts.action === 'failed') {
    catalog.push({
      episode, shot_id: shotId, take_id: null, stage,
      model: null, path: null, status: 'failed',
      rendered_at: new Date().toISOString(), error: opts.error
    });
  }

  atomicWriteJson(catalogPath, catalog);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.episodeDir || !opts.shotId || !opts.action) {
    console.error('Usage: node tools/mark-shot.js <ep> <shot> --take --task <task-id> --path <mp4> [--request-id <rid>] [--cost <n>] | --select --take-id <id> | --reject --take-id <id> | --review --take-id <id> --conclusion accept|reject | --rendering | --done --path <mp4> | --failed --task <task-id> --error "<msg>" [--transient|--hard|--kind hard|transient] [--terminal] [--attempt-id <id>] [--request-id <id>] [--billed|--no-billed] [--cost <n>] | --unblock | --pending');
    process.exit(1);
  }
  const absEpDir = path.isAbsolute(opts.episodeDir) ? opts.episodeDir : path.resolve(opts.episodeDir);
  const catalogPath = path.join(ROOT, 'catalog.json');
  try {
    // D6:manifest + catalog 两文件写入是一个事务,按 episode 目录与 catalog 路径加锁
    withLock([absEpDir, catalogPath], () => {
      const { manifest, createdTakeId } = updateManifest(absEpDir, opts.shotId, opts);
      appendCatalog(absEpDir, opts.shotId, opts, manifest, createdTakeId, catalogPath);
    });
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(3);
  }
  console.log(`marked ${opts.shotId} (action: ${opts.action})`);
}

module.exports = { updateManifest, appendCatalog, nextTakeId, getTaskSnapshot, resolveAttempt, parseArgs, recordTaskFailure, findCatalogEntry, syncCatalogSelection };

if (require.main === module) {
  main();
}
