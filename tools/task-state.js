#!/usr/bin/env node
/**
 * task-state.js — §3.5 任务状态模型 / attempt 事件流 / 熔断(纯函数)
 *
 * 任务状态集合(写死):
 *   active   = queued | submitted | running | retry_wait
 *   terminal = succeeded | failed | cancelled | superseded | blocked
 *
 * 旧名归一化(向后兼容 M0 数据):
 *   completed → succeeded
 *   obsolete  → superseded
 *
 * attempt 事件流:每请求尝试追加 {task_id, shot_id, stage, n, kind, error, at,
 *   retry_after, epoch};kind ∈ {hard, transient, callback_received};按 (task_id, n) 幂等。
 *
 * 熔断三维度(口径写死):
 *   同 task hard attempts      >= 3  → blocked
 *   同 task transient attempts >= 10 → blocked
 *   同 shot hard-failure 任务快照数 >= 5 → blocked (跨 input_hash,同任务多个 hard 只计 1)
 * 所有统计窗口 = task_events 中 epoch === shot.breaker_epoch 的事件。
 *
 * 状态与有效期分离(§3.5):isTaskSuperseded(task) 读 superseded_at 或旧 status='superseded';
 * 可调度判定 = isActiveTaskStatus(status) && !isTaskSuperseded(task)。
 */
'use strict';

/** active 任务状态(唯一性约束针对这些状态) */
const ACTIVE_TASK_STATUSES = ['queued', 'submitted', 'running', 'retry_wait'];

/** terminal 任务状态 */
const TERMINAL_TASK_STATUSES = ['succeeded', 'failed', 'cancelled', 'superseded', 'blocked'];

/** 熔断阈值(三维度) */
const BREAKER_LIMITS = Object.freeze({
  hard_attempts: 3,
  transient_attempts: 10,
  failed_task_cycles: 5,   // legacy alias(保留导出,不再作为口径)
  hard_failure_tasks: 5    // 第三维:跨 input_hash 的 hard-failure 任务快照数
});

/**
 * 旧任务状态名 → 新状态名;其余原样返回。
 * @param {string} status
 * @returns {string}
 */
function normalizeTaskStatus(status) {
  if (status === 'completed') return 'succeeded';
  if (status === 'obsolete') return 'superseded';
  return status;
}

/**
 * 任务是否已被新版本取代(§3.5:执行状态与有效期分离)。
 * `superseded_at != null` 或旧数据 `normalizeTaskStatus(status) === 'superseded'`。
 * @param {object} task
 * @returns {boolean}
 */
function isTaskSuperseded(task) {
  if (!task) return false;
  if (task.superseded_at !== undefined && task.superseded_at !== null) return true;
  return normalizeTaskStatus(task.status) === 'superseded';
}

/** 是否 active(旧名 completed/obsolete 视为 terminal) */
function isActiveTaskStatus(status) {
  if (status === 'completed' || status === 'obsolete') return false;
  return ACTIVE_TASK_STATUSES.includes(status);
}

/** 是否 terminal */
function isTerminalTaskStatus(status) {
  return TERMINAL_TASK_STATUSES.includes(normalizeTaskStatus(status));
}

// 内置分类正则表(限流/临时性 → 可重试)
const TRANSIENT_PATTERNS = [
  /rate.?limit/i,
  /\b429\b/,
  /timeout/i,
  /timed out/i,
  /\b5\d\d\b/,
  /temporarily/i
];
// 硬失败 → 不可重试
const HARD_PATTERNS = [
  /policy/i,
  /content/i,
  /invalid/i,
  /unsafe/i
];

/**
 * 失败分类:内置正则表 + 人工覆盖。
 * @param {string} error 错误信息
 * @param {'hard'|'transient'|null} [override] 人工覆盖
 * @returns {{kind:'hard'|'transient', source:'auto'|'manual'}}
 */
function classifyError(error, override) {
  if (override === 'hard' || override === 'transient') {
    return { kind: override, source: 'manual' };
  }
  const msg = String(error == null ? '' : error);
  for (const re of TRANSIENT_PATTERNS) if (re.test(msg)) return { kind: 'transient', source: 'auto' };
  for (const re of HARD_PATTERNS) if (re.test(msg)) return { kind: 'hard', source: 'auto' };
  // 未知错误默认按 hard(不静默无限重试)
  return { kind: 'hard', source: 'auto' };
}

/**
 * retry_after 指数退避:60s 起,每次 ×2,上限 900s(15min)。
 * @param {number} n attempt 序号(从 1 开始)
 * @returns {number} 秒
 */
function computeRetryDelay(n) {
  const base = 60;
  const cap = 900;
  const idx = Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
  return Math.min(base * Math.pow(2, idx - 1), cap);
}

/**
 * 追加事件,按 (task_id, n) 幂等(首次写入优先,重复返回已存在事件)。
 * @param {Array} events manifest.task_events(原地 push)
 * @param {object} ev
 * @returns {{appended:boolean, event:object, events:Array}}
 */
function appendTaskEvent(events, ev) {
  const arr = Array.isArray(events) ? events : [];
  const dup = arr.find(e => e && e.task_id === ev.task_id && e.n === ev.n);
  if (dup) return { appended: false, event: dup, events: arr };
  arr.push(ev);
  return { appended: true, event: ev, events: arr };
}

/** 该 task 下一个 attempt 序号(当前最大 n + 1) */
function nextAttemptN(events, taskId) {
  let max = 0;
  for (const e of (events || [])) {
    if (e && e.task_id === taskId && typeof e.n === 'number') max = Math.max(max, e.n);
  }
  return max + 1;
}

/**
 * 统计 attempt 数(kind 未指定时只计 hard|transient,不含 callback_received)。
 * 计时窗口可按 task_id 或“同一输入身份”(shot_id + stage + input_hash)过滤:
 * PRD §3.5 的「同 task(同 input_hash)」维度必须跨重建的任务快照累计,
 * 因此 input_hash 过滤是熔断维度 1/2 的正确口径。
 * @param {Array} events
 * @param {{task_id?:string, shot_id?:string, stage?:string, input_hash?:string, kind?:string, epoch?:number}} [filter]
 * @returns {number}
 */
function countAttempts(events, filter = {}) {
  return (events || []).filter(e => {
    if (!e) return false;
    if (filter.task_id && e.task_id !== filter.task_id) return false;
    if (filter.shot_id && e.shot_id !== filter.shot_id) return false;
    if (filter.stage && (e.stage || 'video') !== filter.stage) return false;
    if (filter.input_hash !== undefined && filter.input_hash !== null) {
      if (e.input_hash !== filter.input_hash) return false;
    }
    if (filter.kind) {
      if (e.kind !== filter.kind) return false;
    } else if (e.kind !== 'hard' && e.kind !== 'transient') {
      return false;
    }
    if (filter.epoch !== undefined && filter.epoch !== null) {
      const ep = (e.epoch === undefined || e.epoch === null) ? 0 : e.epoch;
      if (ep !== filter.epoch) return false;
    }
    return true;
  }).length;
}

/**
 * 按 shot 统计「终态 failed 的任务快照数」(第三维熔断;跨 input_hash)。
 * @param {Array} tasks render_tasks
 * @param {{shot_id?:string, epoch?:number}} [opts]
 * @returns {Object<string, number>}
 */
function failedTaskCycles(tasks, opts = {}) {
  const out = {};
  for (const t of (tasks || [])) {
    if (!t) continue;
    if (normalizeTaskStatus(t.status) !== 'failed') continue;
    if (opts.shot_id && t.shot_id !== opts.shot_id) continue;
    if (opts.epoch !== undefined && opts.epoch !== null) {
      const ep = (t.breaker_epoch === undefined || t.breaker_epoch === null) ? 0 : t.breaker_epoch;
      if (ep !== opts.epoch) continue;
    }
    out[t.shot_id] = (out[t.shot_id] || 0) + 1;
  }
  return out;
}

/**
 * 按 (shot_id, epoch) 统计「发生过 >=1 次 hard attempt 的任务快照数」(第三维熔断)。
 * 同一任务的多个 hard attempt 只计 1 次;transient 不计。
 * @param {Array} events task_events
 * @param {{shot_id?:string, epoch?:number}} [opts]
 * @returns {number} distinct task_id 数
 */
function hardFailureTaskCount(events, opts = {}) {
  const ids = new Set();
  for (const e of (events || [])) {
    if (!e || e.kind !== 'hard') continue;
    if (opts.shot_id && e.shot_id !== opts.shot_id) continue;
    if (opts.epoch !== undefined && opts.epoch !== null) {
      const ep = (e.epoch === undefined || e.epoch === null) ? 0 : e.epoch;
      if (ep !== opts.epoch) continue;
    }
    if (e.task_id) ids.add(e.task_id);
  }
  return ids.size;
}

/**
 * 评估三维度熔断。
 * @returns {{blocked:boolean, dimension?:string, count?:number, epoch:number}}
 */
function evaluateBreaker({ task, shot, events, tasks: _tasks }) {
  const epoch = (shot && shot.breaker_epoch) || 0;
  // 维度 1/2 的口径 = “同 task(同 input_hash)”:按 (shot_id, stage, input_hash) 统计
  // 同一 input 身份跨任务快照(重建 task_id)的 attempt,否则 hard→终态 failed 后
  // 重试新建快照会把计数清零,维度永远无法触发。
  const identity = { shot_id: shot.id, stage: task.stage || 'video', input_hash: task.input_hash, epoch };
  const hard = countAttempts(events, Object.assign({ kind: 'hard' }, identity));
  if (hard >= BREAKER_LIMITS.hard_attempts) {
    return { blocked: true, dimension: 'hard_attempts', count: hard, epoch };
  }
  const transient = countAttempts(events, Object.assign({ kind: 'transient' }, identity));
  if (transient >= BREAKER_LIMITS.transient_attempts) {
    return { blocked: true, dimension: 'transient_attempts', count: transient, epoch };
  }
  const cycles = hardFailureTaskCount(events, { shot_id: shot.id, epoch });
  if (cycles >= BREAKER_LIMITS.hard_failure_tasks) {
    return { blocked: true, dimension: 'hard_failure_tasks', count: cycles, epoch };
  }
  return { blocked: false, epoch };
}

module.exports = {
  ACTIVE_TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
  BREAKER_LIMITS,
  normalizeTaskStatus,
  isTaskSuperseded,
  isActiveTaskStatus,
  isTerminalTaskStatus,
  classifyError,
  computeRetryDelay,
  appendTaskEvent,
  nextAttemptN,
  countAttempts,
  failedTaskCycles,
  hardFailureTaskCount,
  evaluateBreaker
};
