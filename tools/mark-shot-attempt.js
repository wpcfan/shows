'use strict';
const crypto = require('crypto');
const {
  deriveStatus,
  normalizeTaskStatus, isTerminalTaskStatus, isTaskSuperseded,
  classifyError, appendTaskEvent, nextAttemptN,
  computeRetryDelay, evaluateBreaker
} = require('./build-manifest');
const { ensureLedger, recordOutcome } = require('./quota-ledger');

function genAttemptId() {
  return 'att-' + crypto.randomBytes(4).toString('hex');
}

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
 *     FIX6b:命中 attempt 已绑别的 request_id / request 已属别的 attempt → 抛错零改动
 *     (一 attempt ↔ 一 request);多 attempt 且无命中 → 抛错要求 --attempt-id;
 *   - 都不提供:仅 attempts.length <= 1(或 legacy 无 attempts 但有 current)允许绑定;
 *     多 attempt → 抛错要求身份。
 */
function resolveAttempt(task, opts = {}, manifest = {}) {
  if (!task) throw new Error('resolveAttempt: task is required');
  const attempts = Array.isArray(task.attempts) ? task.attempts : (task.attempts = []);
  const events = manifest.task_events || [];
  const legacyCurrent = task.current_attempt_id || null;
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
  const assertRequestUnique = (requestId, attemptId) => {
    if (requestId && requestToAttempt.has(requestId) && requestToAttempt.get(requestId) !== attemptId) {
      throw new Error(`request_id ${requestId} is already bound to attempt ${requestToAttempt.get(requestId)} — refusing to bind it to attempt ${attemptId} (one request maps to exactly one attempt)`);
    }
  };
  const assertUniqueBinding = (requestId, attemptId) => {
    assertRequestUnique(requestId, attemptId);
    if (attemptId && attemptToRequest.has(attemptId) && requestId && attemptToRequest.get(attemptId) !== requestId) {
      throw new Error(`attempt ${attemptId} is already bound to request_id ${attemptToRequest.get(attemptId)} — refusing to bind request_id ${requestId} (one attempt maps to exactly one request)`);
    }
  };
  const assertRequestOnlyBinding = (requestId, attemptId) => {
    assertRequestUnique(requestId, attemptId || null);
    if (attemptId && attemptToRequest.has(attemptId) && attemptToRequest.get(attemptId) !== requestId) {
      throw new Error(`attempt ${attemptId} is already bound to request_id ${attemptToRequest.get(attemptId)} — refusing to bind request_id ${requestId} (one attempt maps to exactly one request)`);
    }
  };
  const backfill = (att, requestId) => {
    if (att && requestId && !att.request_id) att.request_id = requestId;
    return att;
  };

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

  if (attempts.length <= 1) {
    const only = attempts[0] || (legacyCurrent ? { attempt_id: legacyCurrent, at: null, input_hash: task.input_hash, request_id: null } : null);
    return { attempt_id: only ? (only.attempt_id || null) : null, request_id: null, attempt: only };
  }
  throw new Error(`task ${task.task_id} has multiple attempts (${attempts.length}) — pass --attempt-id (or --request-id) to identify the callback`);
}

/**
 * §3.5 任务失败模型(hard/transient 先 retry_wait 累计,--terminal 才 failed,三维熔断)。
 * ledger stage 由 task.stage 决定(keyframe → image,其余 → video)。
 */
function recordTaskFailure({ manifest, shot, shotId, opts }) {
  const task = getTaskSnapshot(manifest, opts.taskId);
  if (!task) {
    throw new Error(`task ${opts.taskId} not found in manifest.render_tasks (query the task by id before reporting a failure — do not blindly re-submit)`);
  }
  if (task.shot_id !== shotId) {
    throw new Error(`task ${opts.taskId} is for shot ${task.shot_id}, not ${shotId}`);
  }
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
  const ident = resolveAttempt(task, opts, manifest);
  const attemptId = ident.attempt_id || genAttemptId();
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
    input_hash: task.input_hash,
    n,
    kind,
    kind_source: source,
    error: opts.error == null ? null : opts.error,
    at,
    retry_after: retryAfter,
    epoch
  });

  const verdict = evaluateBreaker({ task, shot, events, tasks: manifest.render_tasks || [] });
  if (appended) shot.retries = (shot.retries || 0) + 1;
  shot.error = opts.error == null ? null : opts.error;
  if (verdict.blocked) {
    const reason = `${verdict.dimension} count=${verdict.count} (epoch ${verdict.epoch})`;
    task.status = 'blocked';
    task.blocked_reason = reason;
    shot.status = 'blocked';
    shot.blocked_reason = reason;
    console.warn(`  CIRCUIT BREAKER: ${shotId} blocked — ${reason}`);
  } else if (opts.terminal) {
    task.status = 'failed';
    task.retry_after = null;
  } else {
    task.status = 'retry_wait';
    task.retry_after = retryAfter;
  }
  if (!verdict.blocked) {
    const ds = deriveStatus(shot, shot.input_hash, 'pending');
    shot.status = ds.status;
    shot.prev_hash = ds.prev_hash;
  }
  const ledgerStage = (task.stage === 'keyframe') ? 'image' : (task.stage === 'tts' ? 'tts' : 'video');
  const defaultBilled = verdict.blocked || kind === 'hard';
  const billed = opts.billed === undefined ? defaultBilled : opts.billed === true;
  if (billed) recordOutcome(ensureLedger(manifest), ledgerStage, 'failed_billed', { cost: opts.cost });
  console.log(`  recorded attempt #${n} (${kind}/${source}) for task ${task.task_id} → ${task.status}${billed ? ' [billed]' : ''}`);
  return { task, kind, kind_source: source, billed, n, attempt_id: attemptId, blocked: !!verdict.blocked, idempotent: false };
}

module.exports = {
  genAttemptId, getTaskSnapshot, resolveAttempt, recordTaskFailure,
};
