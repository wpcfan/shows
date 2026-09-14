#!/usr/bin/env node
/**
 * quota-ledger.js — §4 配额账本(纯函数 + 集成辅助)
 *
 * manifest 顶层 `quota_ledger` 分阶段记录:
 *   image | tts | video → { requests, successes, cache_hits, rejects, failed_billed, actual_cost }
 *   currency(缺省 'USD')
 *
 * 计数口径(§4 固定公式):
 *   - request       一次真实请求发出
 *   - success       一次成功产物回写
 *   - cache_hit     幂等复用既有产物(缓存命中;成本强制计 0)
 *   - reject        人工/规则拒绝的产物(rejected 生成成本计入分子)
 *   - failed_billed 供应商实扣的失败请求(无法确认时可不加;CLI 支持显式 --billed)
 *
 * 成本指标公式写死:
 *   cost_per_accepted_video_shot =
 *     (image.actual_cost + tts.actual_cost + video.actual_cost)
 *     / count(distinct accepted video shots included in final timeline)
 *   分母按 distinct shot_id(不按 clip 实例,剪辑方式不污染生成成本);
 *   分母为 0 → 返回 null 并附 warning(不除零/NaN)。
 *
 * 本模块不依赖 build-manifest,避免循环依赖;文件读写由调用方负责。
 */
'use strict';

/** 账本阶段(写死) */
const LEDGER_STAGES = ['image', 'tts', 'video'];

/** 计数器名称顺序(报告稳定输出) */
const LEDGER_COUNTERS = ['requests', 'successes', 'cache_hits', 'rejects', 'failed_billed'];

/** outcome → 计数器字段 */
const OUTCOME_COUNTER = {
  request: 'requests',
  success: 'successes',
  cache_hit: 'cache_hits',
  reject: 'rejects',
  failed_billed: 'failed_billed'
};

const OUTCOME_NAMES = Object.keys(OUTCOME_COUNTER);

const DEFAULT_CURRENCY = 'USD';

/** 单个阶段的空计数 */
function emptyStage() {
  return {
    requests: 0,
    successes: 0,
    cache_hits: 0,
    rejects: 0,
    failed_billed: 0,
    actual_cost: 0
  };
}

/**
 * 空账本。
 * @param {string} [currency='USD']
 */
function emptyLedger(currency = DEFAULT_CURRENCY) {
  const stages = {};
  for (const st of LEDGER_STAGES) stages[st] = emptyStage();
  return { stages, currency: currency || DEFAULT_CURRENCY };
}

/** 归一化单个阶段(补齐缺失计数器,缺省 0;保留已有 actual_cost) */
function normalizeStage(raw) {
  const out = emptyStage();
  if (raw && typeof raw === 'object') {
    for (const c of LEDGER_COUNTERS) {
      if (typeof raw[c] === 'number' && Number.isFinite(raw[c])) out[c] = raw[c];
    }
    if (typeof raw.actual_cost === 'number' && Number.isFinite(raw.actual_cost)) {
      out.actual_cost = raw.actual_cost;
    }
  }
  return out;
}

/**
 * 归一化账本(补齐缺失 stage/counter);不改变 currency。
 */
function normalizeLedger(raw) {
  const ledger = raw && typeof raw === 'object' ? raw : {};
  if (!ledger.stages || typeof ledger.stages !== 'object') ledger.stages = {};
  for (const st of LEDGER_STAGES) {
    ledger.stages[st] = normalizeStage(ledger.stages[st]);
  }
  if (!ledger.currency) ledger.currency = DEFAULT_CURRENCY;
  return ledger;
}

/**
 * 在任意容器(通常为 manifest)上取得/初始化 `quota_ledger`。
 * 缺省自动初始化;已有账本原地补齐缺失字段。
 * @param {object} container
 * @param {string} [currency='USD']
 */
function ensureLedger(container, currency = DEFAULT_CURRENCY) {
  if (!container || typeof container !== 'object') {
    throw new Error('ensureLedger requires an object container (e.g. manifest)');
  }
  if (!container.quota_ledger) {
    container.quota_ledger = emptyLedger(currency);
  }
  return normalizeLedger(container.quota_ledger);
}

/** 取得阶段计数器(不存在则按需初始化) */
function ensureStage(ledger, stage) {
  if (!ledger.stages) ledger.stages = {};
  if (!ledger.stages[stage]) ledger.stages[stage] = emptyStage();
  return ledger.stages[stage];
}

/**
 * 校验成本数值:必须为有限非负数。
 * 接受数字或可解析的数字字符串;拒绝 null/undefined/NaN/Infinity/负数/非数字。
 * @param {*} value
 * @returns {number}
 */
function validateCost(value) {
  let n = value;
  if (typeof value === 'string') {
    if (value.trim() === '') throw new Error(`invalid cost: must be a finite non-negative number, got ${JSON.stringify(value)}`);
    n = Number(value);
  }
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
    throw new Error(`invalid cost: must be a finite non-negative number, got ${JSON.stringify(value)}`);
  }
  return n;
}

/**
 * 记录一次 outcome(原地修改 ledger)。
 * @param {object} ledger
 * @param {'image'|'tts'|'video'} stage
 * @param {'request'|'success'|'cache_hit'|'reject'|'failed_billed'} outcome
 * @param {{cost?:number}} [opts] cost 累加到 actual_cost;cache_hit 强制不累加(缓存命中成本计 0)
 * @returns {object} ledger(便于链式调用)
 */
function recordOutcome(ledger, stage, outcome, opts = {}) {
  if (!ledger || typeof ledger !== 'object') {
    throw new Error('recordOutcome requires a ledger object');
  }
  const counter = OUTCOME_COUNTER[outcome];
  if (!counter) {
    throw new Error(`unknown ledger outcome '${outcome}' (expected one of ${OUTCOME_NAMES.join('|')})`);
  }
  const s = ensureStage(ledger, stage);
  s[counter] += 1;
  // cache_hit 成本强制计 0(即使调用方误传 cost)
  if (outcome !== 'cache_hit' && opts.cost != null) {
    s.actual_cost += validateCost(opts.cost);
  }
  return ledger;
}

/** 归一化为 clip 数组(接受数组、{clips:[]} 或 {timeline:[]}) */
function extractClips(timelineOrClips) {
  if (!timelineOrClips) return [];
  if (Array.isArray(timelineOrClips)) return timelineOrClips;
  if (Array.isArray(timelineOrClips.clips)) return timelineOrClips.clips;
  if (Array.isArray(timelineOrClips.timeline)) return timelineOrClips.timeline;
  return [];
}

/**
 * 统计最终时间线中 distinct accepted video shot 数(成本公式分母)。
 * - 只计 video stage 的 clip
 * - 显式 accepted=false / status ∈ {rejected, superseded} 的 clip 不计
 * - 同一 shot 的多个 clip 实例只算一次
 * @param {Array|{clips:Array}|{timeline:Array}} timelineOrClips
 * @returns {number}
 */
function countAcceptedVideoShots(timelineOrClips) {
  const seen = new Set();
  for (const clip of extractClips(timelineOrClips)) {
    if (!clip || typeof clip !== 'object') continue;
    if (clip.accepted === false) continue;
    if (clip.status === 'rejected' || clip.status === 'superseded') continue;
    if (clip.stage && clip.stage !== 'video') continue;
    const shotId = clip.shot_id || clip.shot;
    if (!shotId) continue;
    seen.add(String(shotId));
  }
  return seen.size;
}

/** 各阶段实际成本 + 总分子 */
function ledgerTotals(ledger) {
  const stages = (ledger && ledger.stages) || {};
  const cost = (st) => {
    const s = stages[st];
    return (s && typeof s.actual_cost === 'number' && Number.isFinite(s.actual_cost)) ? s.actual_cost : 0;
  };
  const image = cost('image');
  const tts = cost('tts');
  const video = cost('video');
  return { image, tts, video, total: image + tts + video };
}

/**
 * §4 固定公式:cost_per_accepted_video_shot。
 * @param {object} ledger
 * @param {Array|object} timelineOrClips
 * @param {{warnings?: Array}} [opts] 传入 warnings 数组会在分母为 0 时 push 说明
 * @returns {number|null} 分母为 0 → null(不除零/NaN)
 */
function computeCostPerAcceptedVideoShot(ledger, timelineOrClips, opts = {}) {
  const totals = ledgerTotals(ledger);
  const denominator = countAcceptedVideoShots(timelineOrClips);
  if (denominator === 0) {
    const warning = 'no accepted video shots in final timeline — cost_per_accepted_video_shot is undefined (null); refusing to divide by zero';
    if (Array.isArray(opts.warnings)) opts.warnings.push(warning);
    return null;
  }
  return totals.total / denominator;
}

/**
 * 结构化账本报告:计数器 + 成本 + 公式分子/分母 + warnings。
 * @param {object} ledger
 * @param {Array|object} timelineOrClips
 */
function ledgerReport(ledger, timelineOrClips) {
  const warnings = [];
  const norm = normalizeLedger(ledger);
  const stages = {};
  for (const st of LEDGER_STAGES) {
    stages[st] = Object.assign({}, norm.stages[st]);
  }
  const totals = ledgerTotals(norm);
  const denominator = countAcceptedVideoShots(timelineOrClips);
  let value = null;
  if (denominator === 0) {
    warnings.push('no accepted video shots in final timeline — cost_per_accepted_video_shot is undefined (null); refusing to divide by zero');
  } else {
    value = totals.total / denominator;
  }
  return {
    currency: norm.currency || DEFAULT_CURRENCY,
    stages,
    costs: { image: totals.image, tts: totals.tts, video: totals.video, total: totals.total },
    formula: {
      name: 'cost_per_accepted_video_shot',
      expression: '(image.actual_cost + tts.actual_cost + video.actual_cost) / count(distinct accepted video shots included in final timeline)',
      numerator: totals.total,
      denominator,
      denominator_unit: 'distinct_shot_id',
      components: { image_cost: totals.image, tts_cost: totals.tts, video_cost: totals.video },
      value
    },
    cost_per_accepted_video_shot: value,
    warnings
  };
}

module.exports = {
  LEDGER_STAGES,
  LEDGER_COUNTERS,
  OUTCOME_NAMES,
  DEFAULT_CURRENCY,
  emptyStage,
  emptyLedger,
  normalizeStage,
  normalizeLedger,
  ensureLedger,
  ensureStage,
  validateCost,
  recordOutcome,
  extractClips,
  countAcceptedVideoShots,
  ledgerTotals,
  computeCostPerAcceptedVideoShot,
  ledgerReport
};
