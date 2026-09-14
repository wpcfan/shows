#!/usr/bin/env node
/**
 * e1-report.js — §3.1 E1 首帧能力实验统计契约(纯函数 + CLI)
 *
 * 主指标:输入图与视频第 0 帧的 SSIM。
 * 辅指标:pHash 汉明距离或 LPIPS(二选一;报告写明实现与参数版本字段)。
 *
 * 实验设计(PRD §3.1):
 *   - A/B/C 三组:首帧参数位 / 参考图位 / 无图;成对实验(同 scene+prompt,仅改变图位置)
 *   - 分层:closeup / wide / empty / motion,每层每 group ≥ 10 样本才可判定
 *   - bootstrap 以 (scene, prompt_id) 为 cluster 重采样(同 scene 不同 seed 是 cluster 内重复观测)
 *   - 阈值预注册:Δ 与 ssim_abs_min 必须先与 delta_frozen_at 一同冻结;缺失 → 工具拒绝出结论
 *
 * 判定「首帧约束成立」需同时满足:
 *   1. A 组 SSIM 中位数较 B、较 C 均提升 ≥ Δ
 *   2. A−B、A−C 的 bootstrap 95% CI 均不跨 0
 *   3. 每层分别满足,或至少人物相关两层(closeup+wide)全部满足且其余层无反向显著
 *   4. A 组绝对质量门槛:中位数 ≥ ssim_abs_min(与 Δ 一同预注册)
 * 未达阈值一律 reference_guidance_only,不允许人工解释为「基本可用」。
 *
 * 预处理与度量口径(PRD §3.1 写死):视频侧取第 0 帧;输入图与首帧统一 resize 到同一边长
 * (默认 512×512,双线性)、色彩空间统一到 sRGB/BT.709;不做锐化/对比度增强。
 * SSIM 实现名+版本+参数(window/gaussian/K1/K2/data_range)与辅指标实现+版本必须记入报告;
 * 缺失 → incomplete(统计照做,但不得声称 E1 验证完成)。
 *
 * 重要:本工具只负责统计。真实 E1 报告需要真实调用生成接口(外部动作)并预注册 Δ;
 * 合成/演示数据必须标注 synthetic,不得当作真实结论。
 *
 * 用法:
 *   node tools/e1-report.js <dataset.json> [--json <out.json>] [--seed <n>] [--iterations <n>]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./build-manifest');

const TOOL_NAME = 'e1-report.js';
const TOOL_VERSION = '1.0.0';

/** 测试层(PRD §3.1) */
const LAYERS = ['closeup', 'wide', 'empty', 'motion'];

/** 人物相关层(判定降级放行的两个层) */
const CHARACTER_LAYERS = ['closeup', 'wide'];

/** 每层每 group 判定所需最少样本数 */
const MIN_LAYER_SAMPLES = 10;

/** bootstrap 最少重采样次数(预注册约束) */
const MIN_BOOTSTRAP_ITERATIONS = 1000;

/** 预处理协议(PRD §3.1 写死):缺失项按此补齐并在报告中回显 */
const DEFAULT_PREPROCESSING = {
  cover_crop: 'to_video_aspect',
  resize: '512x512-bilinear',
  color_space: 'sRGB',
  sharpen: false
};

/** 允许的色彩空间(PRD §3.1) */
const ALLOWED_COLOR_SPACES = ['sRGB', 'BT.709'];

/** 允许的 cover-crop 口径(PRD §3.1 v2.9) */
const ALLOWED_COVER_CROP = ['to_video_aspect'];

/** 判定为「首帧约束成立」的 verdict 字符串 */
const VERDICT_BOUND = 'first_frame_bound';
const VERDICT_REFERENCE_ONLY = 'reference_guidance_only';

const DEFAULT_SEED = 20250101;

/** 预注册缺失 → 拒绝出结论 */
class E1RefusalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'E1RefusalError';
    this.code = 'E1_PREREGISTRATION_MISSING';
  }
}

/** 中位数(空数组 → null) */
function median(values) {
  const arr = (values || []).filter(v => typeof v === 'number' && Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (arr.length === 0) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

/** 线性插值 percentile(sortedValues 或未排序值, p ∈ [0,1]) */
function percentile(values, p) {
  const arr = (values || []).filter(v => typeof v === 'number' && Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (arr.length === 0) return null;
  if (arr.length === 1) return arr[0];
  const idx = (arr.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return arr[lo];
  return arr[lo] + (arr[hi] - arr[lo]) * (idx - lo);
}

/** cluster 键:同 scene + prompt_id 视为同一采样单元(不同 seed 是 cluster 内重复) */
function clusterKey(sample) {
  return `${sample.scene}::${sample.prompt_id}`;
}

/** 按 cluster 分组;samples 顺序决定 Map 键顺序(确定性) */
function buildClusters(samples) {
  const map = new Map();
  for (const s of (samples || [])) {
    if (!s) continue;
    const k = clusterKey(s);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(s);
  }
  return map;
}

/** mulberry32 PRNG:固定种子 → 可复现序列 */
function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return function rng() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** CI 是否排除 0(点估计方向不限;用于「不跨 0」判定) */
function ciExcludesZero(ci) {
  if (!ci || ci.ci_low == null || ci.ci_high == null) return false;
  return ci.ci_low > 0 || ci.ci_high < 0;
}

/** 是否反向显著(A 显著低于对照:CI 整段 < 0) */
function ciReverseSignificant(ci) {
  if (!ci || ci.ci_low == null || ci.ci_high == null) return false;
  return ci.ci_high < 0;
}

/**
 * cluster bootstrap:A 组 − B 组的 metric 中位数差 95% CI(percentile 法)。
 * 以 (scene, prompt_id) 为 cluster 有放回重采样;cluster 内重复观测不放大样本量。
 * @param {Array} samples
 * @param {'A'|'B'|'C'} groupA
 * @param {'A'|'B'|'C'} groupB
 * @param {{metric?:string, iterations?:number, seed?:number}} [opts]
 */
function bootstrapDiffCI(samples, groupA, groupB, opts = {}) {
  const metric = opts.metric || 'ssim';
  const iterations = Number.isFinite(opts.iterations) && opts.iterations > 0 ? Math.floor(opts.iterations) : MIN_BOOTSTRAP_ITERATIONS;
  const seed = Number.isFinite(opts.seed) ? opts.seed : DEFAULT_SEED;
  const rng = mulberry32(seed);

  const relevant = (samples || []).filter(s => s && (s.group === groupA || s.group === groupB));
  const clusters = buildClusters(relevant);
  const keys = [...clusters.keys()];

  const observedA = relevant.filter(s => s.group === groupA).map(s => s[metric]);
  const observedB = relevant.filter(s => s.group === groupB).map(s => s[metric]);
  const medianDiff = (median(observedA) == null || median(observedB) == null)
    ? null
    : median(observedA) - median(observedB);

  const result = {
    metric,
    group_a: groupA,
    group_b: groupB,
    median_diff: medianDiff,
    ci_low: null,
    ci_high: null,
    iterations: 0,
    requested_iterations: iterations,
    cluster_count: keys.length,
    seed
  };
  if (keys.length === 0) return result;

  const diffs = [];
  for (let i = 0; i < iterations; i++) {
    const aVals = [];
    const bVals = [];
    for (let j = 0; j < keys.length; j++) {
      const k = keys[Math.floor(rng() * keys.length)];
      for (const s of clusters.get(k)) {
        const v = s[metric];
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        if (s.group === groupA) aVals.push(v);
        else bVals.push(v);
      }
    }
    if (aVals.length === 0 || bVals.length === 0) continue; // 该次重采样缺组,跳过
    diffs.push(median(aVals) - median(bVals));
  }
  result.iterations = diffs.length;
  if (diffs.length) {
    result.ci_low = percentile(diffs, 0.025);
    result.ci_high = percentile(diffs, 0.975);
  }
  return result;
}

/**
 * 预注册校验:返回缺失字段列表。
 * Δ、绝对门槛 ssim_abs_min 与冻结时间缺一不可(防 post-hoc 调阈值)。
 */
function checkPreregistration(meta) {
  const m = meta || {};
  const missing = [];
  if (m.delta_preregistered == null || !Number.isFinite(Number(m.delta_preregistered))) missing.push('delta_preregistered');
  if (m.ssim_abs_min == null || !Number.isFinite(Number(m.ssim_abs_min))) missing.push('ssim_abs_min');
  if (m.delta_frozen_at == null || m.delta_frozen_at === '') missing.push('delta_frozen_at');
  return missing;
}

/**
 * 度量与预处理元数据校验:返回 incomplete 理由数组(缺失 → 不阻塞统计,但不得声称 E1 完成)。
 * @param {object} meta 数据集 meta
 * @param {{field?:string}|null} [secondary] selectSecondaryMetric() 的结果(实际使用的辅指标)
 */
function checkMetricMetadata(meta, secondary) {
  const m = meta || {};
  const reasons = [];
  const metrics = m.metrics;
  if (metrics == null || typeof metrics !== 'object') {
    reasons.push('meta.metrics missing — record SSIM implementation/version/params and the preprocessing protocol (PRD §3.1 写死口径)');
    return reasons;
  }
  const ssim = metrics.ssim;
  if (ssim == null || typeof ssim !== 'object') {
    reasons.push('meta.metrics.ssim missing — record impl/version/params/preprocessing');
  } else {
    if (!ssim.impl) reasons.push('meta.metrics.ssim.impl missing (SSIM implementation name required)');
    if (!ssim.version) reasons.push('meta.metrics.ssim.version missing (SSIM implementation version required)');
    const params = ssim.params;
    if (params == null || typeof params !== 'object') {
      reasons.push('meta.metrics.ssim.params missing — record window/gaussian/K1/K2/data_range');
    } else {
      for (const k of ['window', 'gaussian', 'K1', 'K2', 'data_range']) {
        if (params[k] === undefined || params[k] === null) reasons.push(`meta.metrics.ssim.params.${k} missing`);
      }
    }
    const pre = ssim.preprocessing;
    if (pre == null || typeof pre !== 'object') {
      reasons.push(`meta.metrics.ssim.preprocessing missing — record cover_crop/resize/color_space per protocol ${JSON.stringify(DEFAULT_PREPROCESSING)}`);
    } else {
      if (!pre.cover_crop) reasons.push('meta.metrics.ssim.preprocessing.cover_crop missing (protocol: to_video_aspect)');
      else if (!ALLOWED_COVER_CROP.includes(pre.cover_crop)) reasons.push(`meta.metrics.ssim.preprocessing.cover_crop '${pre.cover_crop}' not supported (protocol: to_video_aspect)`);
      if (!pre.resize) reasons.push('meta.metrics.ssim.preprocessing.resize missing (protocol: 512x512-bilinear)');
      if (!pre.color_space) reasons.push('meta.metrics.ssim.preprocessing.color_space missing (protocol: sRGB/BT.709)');
      else if (!ALLOWED_COLOR_SPACES.includes(pre.color_space)) reasons.push(`meta.metrics.ssim.preprocessing.color_space '${pre.color_space}' not in {sRGB, BT.709}`);
      if (pre.sharpen === true) reasons.push('meta.metrics.ssim.preprocessing.sharpen=true — protocol forbids sharpening/contrast enhancement');
    }
  }
  if (secondary && secondary.field) {
    const sec = metrics.secondary;
    const secObj = (sec != null && typeof sec === 'object') ? sec : null;
    if (!secObj || !secObj.impl) reasons.push(`meta.metrics.secondary.impl missing (auxiliary metric '${secondary.field}' is used — record implementation)`);
    if (!secObj || !secObj.version) reasons.push(`meta.metrics.secondary.version missing (auxiliary metric '${secondary.field}' is used — record version)`);
  }
  return reasons;
}

/** 选择辅指标(取数据集提供的那个) */
function selectSecondaryMetric(samples) {
  const has = (field) => (samples || []).some(s => s && typeof s[field] === 'number' && Number.isFinite(s[field]));
  if (has('phash_distance')) return { field: 'phash_distance', direction: 'lower_is_better' };
  if (has('lpips')) return { field: 'lpips', direction: 'lower_is_better' };
  return { field: null, direction: null };
}

/** 单层判定 */
function computeLayer(samples, layer, delta, opts) {
  const layerSamples = (samples || []).filter(s => s && s.layer === layer);
  const perGroup = {};
  for (const g of ['A', 'B', 'C']) {
    const gs = layerSamples.filter(s => s.group === g);
    perGroup[g] = { n: gs.length, ssim_median: median(gs.map(s => s.ssim)) };
  }
  const judgeable = ['A', 'B', 'C'].every(g => perGroup[g].n >= MIN_LAYER_SAMPLES);
  const out = {
    layer,
    status: judgeable ? 'pending' : 'insufficient',
    samples_per_group: { A: perGroup.A.n, B: perGroup.B.n, C: perGroup.C.n },
    groups: perGroup,
    delta_preregistered: delta,
    deltas: {
      a_minus_b: bootstrapDiffCI(layerSamples, 'A', 'B', opts),
      a_minus_c: bootstrapDiffCI(layerSamples, 'A', 'C', opts)
    }
  };
  if (!judgeable) {
    out.reason = `insufficient samples: need >= ${MIN_LAYER_SAMPLES} per group in layer '${layer}'`;
    return out;
  }
  const ab = out.deltas.a_minus_b;
  const ac = out.deltas.a_minus_c;
  const medianOk = (ab.median_diff != null && ac.median_diff != null &&
    ab.median_diff >= delta && ac.median_diff >= delta);
  const ciOk = ciExcludesZero(ab) && ciExcludesZero(ac);
  const pass = medianOk && ciOk;
  const reverse = ciReverseSignificant(ab) || ciReverseSignificant(ac);
  out.status = pass ? 'pass' : (reverse ? 'fail_reverse' : 'fail');
  out.conditions = {
    median_gain_ge_delta: medianOk,
    median_gain_ab: ab.median_diff,
    median_gain_ac: ac.median_diff,
    ci_ab_excludes_zero: ciExcludesZero(ab),
    ci_ac_excludes_zero: ciExcludesZero(ac)
  };
  return out;
}

/**
 * 生成 E1 报告。缺预注册 → 抛 E1RefusalError(CLI 非零退出)。
 * @param {object} dataset { meta, samples }
 * @param {{seed?:number, iterations?:number, generated_at?:string}} [opts]
 */
function buildReport(dataset, opts = {}) {
  const data = dataset || {};
  const meta = data.meta || {};
  const samples = Array.isArray(data.samples) ? data.samples : [];

  const missing = checkPreregistration(meta);
  if (missing.length) {
    throw new E1RefusalError(
      `preregistration incomplete: missing ${missing.join(', ')}. Freeze Δ (delta_preregistered) + absolute threshold (ssim_abs_min) + delta_frozen_at BEFORE inspecting formal results, then re-run. No verdict may be produced without a frozen threshold.`
    );
  }

  const delta = Number(meta.delta_preregistered);
  const ssimAbsMin = Number(meta.ssim_abs_min);
  const seed = Number.isFinite(opts.seed) ? opts.seed : DEFAULT_SEED;
  const metaIterations = Number.isFinite(Number(meta.bootstrap_iterations)) ? Number(meta.bootstrap_iterations) : MIN_BOOTSTRAP_ITERATIONS;
  const iterations = Math.max(metaIterations, Number.isFinite(opts.iterations) ? opts.iterations : 0, MIN_BOOTSTRAP_ITERATIONS);
  const bootstrapOpts = { metric: 'ssim', iterations, seed };

  const secondary = selectSecondaryMetric(samples);

  const declaredSsim = (meta.metrics && typeof meta.metrics === 'object' && meta.metrics.ssim && typeof meta.metrics.ssim === 'object')
    ? meta.metrics.ssim : {};
  const metricsRecord = {
    ssim: {
      impl: declaredSsim.impl == null ? null : declaredSsim.impl,
      version: declaredSsim.version == null ? null : declaredSsim.version,
      params: declaredSsim.params == null ? null : declaredSsim.params,
      preprocessing: Object.assign({}, DEFAULT_PREPROCESSING, (declaredSsim.preprocessing && typeof declaredSsim.preprocessing === 'object') ? declaredSsim.preprocessing : {})
    },
    secondary: (meta.metrics && typeof meta.metrics === 'object' && meta.metrics.secondary != null) ? meta.metrics.secondary : null
  };

  const groups = {};
  for (const g of ['A', 'B', 'C']) {
    const gs = samples.filter(s => s && s.group === g);
    groups[g] = {
      n: gs.length,
      ssim_median: median(gs.map(s => s.ssim)),
      secondary_metric: secondary.field,
      secondary_median: secondary.field ? median(gs.map(s => s[secondary.field])) : null
    };
  }

  // 判定条件 #4:A 组绝对质量门槛(仅相对提升不足以保证可用首帧能力)
  const aMedian = median(samples.filter(s => s && s.group === 'A').map(s => s.ssim));
  const absolutePass = aMedian != null && aMedian >= ssimAbsMin;
  const absolute = { ssim_abs_min: ssimAbsMin, a_median: aMedian, pass: absolutePass };

  const layerResults = LAYERS.map(layer => computeLayer(samples, layer, delta, bootstrapOpts));
  const insufficientLayers = layerResults.filter(l => l.status === 'insufficient').map(l => l.layer);
  const allPass = layerResults.every(l => l.status === 'pass');
  const characterPass = CHARACTER_LAYERS.every(layer => {
    const r = layerResults.find(x => x.layer === layer);
    return r && r.status === 'pass';
  });
  const othersNoReverse = layerResults
    .filter(l => !CHARACTER_LAYERS.includes(l.layer))
    .every(l => l.status !== 'fail_reverse');

  let relativeBound = false;
  const reasons = [];
  if (insufficientLayers.length) {
    reasons.push(`insufficient samples in layer(s): ${insufficientLayers.join(', ')} — cannot be judged`);
  } else if (allPass) {
    relativeBound = true;
    reasons.push('all four layers satisfy the median-gain and CI conditions');
  } else if (characterPass && othersNoReverse) {
    relativeBound = true;
    reasons.push('closeup+wide satisfy the conditions and remaining layers show no reverse significance');
  } else {
    if (!characterPass) reasons.push('character layers (closeup+wide) do not both satisfy the conditions');
    if (!othersNoReverse) reasons.push('non-character layer(s) show reverse significance (A significantly worse)');
    reasons.push('per-layer conditions are not satisfied');
  }
  if (!absolutePass) {
    reasons.push(`A-group absolute median ${fmt(aMedian)} < ssim_abs_min ${ssimAbsMin}`);
  }
  const firstFrameBound = relativeBound && absolutePass;
  const verdict = firstFrameBound ? VERDICT_BOUND : VERDICT_REFERENCE_ONLY;

  // incomplete:接口能力字段缺失 → 统计照做,但不得声称 E1 验证完成
  const incompleteReasons = [];
  if (meta.duration_value_range == null) incompleteReasons.push('meta.duration_value_range missing (E1 must record the接口-supported duration value range)');
  if (meta.lipsync == null) incompleteReasons.push('meta.lipsync missing (E1 must re-verify lip-sync support with source + verified_at)');
  else if (!meta.lipsync.verified_at) incompleteReasons.push('meta.lipsync.verified_at missing');
  if (!(metaIterations >= MIN_BOOTSTRAP_ITERATIONS)) incompleteReasons.push(`bootstrap_iterations < ${MIN_BOOTSTRAP_ITERATIONS}`);
  // PRD §3.1 测试集分层:至少 3 个不同场景素材(不允许同一素材重复凑数)→ 不满足即不得声称 E1 完成
  const distinctScenes = new Set(samples.map(s => s && s.scene).filter(Boolean));
  if (distinctScenes.size < 3) incompleteReasons.push(`only ${distinctScenes.size} distinct scene(s); PRD requires >= 3 distinct source scenes (no padding with one source)`);
  // PRD §3.1 预处理与度量口径:实现/版本/参数/预处理协议必须记录;缺失只进 incomplete,不触发 refusal
  for (const reason of checkMetricMetadata(meta, secondary)) incompleteReasons.push(reason);

  const warnings = [];
  if (!secondary.field) warnings.push('no auxiliary metric present (phash_distance / lpips) — report is SSIM-only');
  if (meta.synthetic) warnings.push('SYNTHETIC DATA — this dataset is fabricated for tooling tests; it is NOT a real interface result');

  const report = {
    tool: TOOL_NAME,
    tool_version: TOOL_VERSION,
    generated_at: opts.generated_at || new Date().toISOString(),
    synthetic: !!meta.synthetic,
    notice: meta.synthetic
      ? 'SYNTHETIC DEMO DATA — NOT A REAL E1 RESULT. Real E1 requires calling the generation interface (external action) with Δ pre-registered before inspecting formal results.'
      : null,
    meta: {
      interface_name: meta.interface_name == null ? null : meta.interface_name,
      interface_version: meta.interface_version == null ? null : meta.interface_version,
      params_position: meta.params_position == null ? null : meta.params_position,
      experiment_date: meta.experiment_date == null ? null : meta.experiment_date,
      delta_preregistered: delta,
      ssim_abs_min: ssimAbsMin,
      delta_frozen_at: meta.delta_frozen_at,
      bootstrap_iterations: metaIterations,
      duration_value_range: meta.duration_value_range == null ? null : meta.duration_value_range,
      lipsync: meta.lipsync == null ? null : meta.lipsync
    },
    metric: {
      primary: 'ssim',
      primary_direction: 'higher_is_better',
      secondary: secondary.field,
      secondary_direction: secondary.direction,
      implementation: `${TOOL_NAME}@${TOOL_VERSION} (bootstrap percentile CI, cluster = scene::prompt_id)`,
      version: TOOL_VERSION
    },
    metrics: metricsRecord,
    bootstrap: { iterations, seed, cluster_unit: 'scene::prompt_id', ci: '95% percentile' },
    groups,
    layers: layerResults,
    absolute,
    first_frame_bound: firstFrameBound,
    verdict,
    reasons,
    incomplete: incompleteReasons.length > 0,
    incomplete_reasons: incompleteReasons,
    warnings,
    conclusion_disclaimer: firstFrameBound
      ? '首帧约束按预注册统计契约成立;承诺强度受 meta.incomplete 与接口版本一致性约束。'
      : '未达预注册阈值 → 仅参考引导(reference_guidance_only):不允许人工解释为「基本可用」。'
  };
  return report;
}

/** human-readable 文本报告 */
function formatReportText(report) {
  const r = report || {};
  const L = [];
  L.push('='.repeat(72));
  L.push(`E1 首帧能力实验报告 — ${r.tool}@${r.tool_version}`);
  L.push('='.repeat(72));
  if (r.synthetic) {
    L.push('');
    L.push('*** SYNTHETIC DEMO DATA — NOT A REAL E1 RESULT ***');
    L.push(r.notice || 'Synthetic dataset.');
  }
  L.push('');
  L.push(`接口: ${r.meta.interface_name} @ ${r.meta.interface_version}  参数位: ${r.meta.params_position}  日期: ${r.meta.experiment_date}`);
  L.push(`Δ(预注册): ${r.meta.delta_preregistered}  绝对门槛 ssim_abs_min(预注册): ${r.meta.ssim_abs_min}  冻结于: ${r.meta.delta_frozen_at}`);
  L.push(`主指标: ${r.metric.primary}  辅指标: ${r.metric.secondary || '(none)'}  实现: ${r.metric.implementation}`);
  if (r.metrics && r.metrics.ssim) {
    const s = r.metrics.ssim;
    L.push(`SSIM 实现: ${s.impl || '(unrecorded)'} @ ${s.version || '(unrecorded)'}  params: ${s.params ? JSON.stringify(s.params) : '(unrecorded)'}`);
    const pre = s.preprocessing || {};
    L.push(`预处理(preprocessing): resize=${pre.resize}  color_space=${pre.color_space}  sharpen=${pre.sharpen}`);
    if (r.metrics.secondary) L.push(`辅指标实现: ${r.metrics.secondary.impl || '(unrecorded)'} @ ${r.metrics.secondary.version || '(unrecorded)'} (${r.metrics.secondary.field || r.metric.secondary})`);
  }
  L.push(`bootstrap: ${r.bootstrap.iterations} 次, seed=${r.bootstrap.seed}, cluster=${r.bootstrap.cluster_unit}, ${r.bootstrap.ci}`);
  L.push('');
  L.push('分组中位数:');
  for (const g of ['A', 'B', 'C']) {
    const gg = r.groups[g];
    L.push(`  ${g}: n=${gg.n}  ssim_median=${fmt(gg.ssim_median)}${r.metric.secondary ? `  ${r.metric.secondary}=${fmt(gg.secondary_median)}` : ''}`);
  }
  L.push('');
  L.push('分层判定:');
  for (const l of r.layers) {
    L.push(`  [${l.layer}] ${l.status}  (A/B/C n=${l.samples_per_group.A}/${l.samples_per_group.B}/${l.samples_per_group.C})`);
    if (l.deltas) {
      const ab = l.deltas.a_minus_b;
      const ac = l.deltas.a_minus_c;
      L.push(`      A−B: ${fmtDiff(ab)}   A−C: ${fmtDiff(ac)}   Δ=${l.delta_preregistered}`);
    }
    if (l.reason) L.push(`      ${l.reason}`);
  }
  L.push('');
  const abs = r.absolute || {};
  L.push(`A 组绝对质量门槛(absolute): a_median=${fmt(abs.a_median)}  ssim_abs_min=${abs.ssim_abs_min}  pass=${abs.pass}`);
  L.push('');
  L.push(`判定: first_frame_bound=${r.first_frame_bound}  verdict=${r.verdict}`);
  for (const reason of (r.reasons || [])) L.push(`  - ${reason}`);
  L.push('');
  if (r.incomplete) {
    L.push('INCOMPLETE (统计可算,但不得声称 E1 验证完成):');
    for (const x of r.incomplete_reasons) L.push(`  - ${x}`);
  } else {
    L.push('接口能力记录:complete(duration_value_range + lip-sync 已记录)');
  }
  if ((r.warnings || []).length) {
    L.push('');
    L.push('WARNINGS:');
    for (const w of r.warnings) L.push(`  - ${w}`);
  }
  L.push('');
  L.push(`结论声明: ${r.conclusion_disclaimer}`);
  L.push('='.repeat(72));
  return L.join('\n');
}

function fmt(v) {
  return (typeof v === 'number' && Number.isFinite(v)) ? v.toFixed(4) : String(v);
}
function fmtDiff(d) {
  if (!d || d.median_diff == null) return '(n/a)';
  return `${d.median_diff.toFixed(4)} [${fmt(d.ci_low)}, ${fmt(d.ci_high)}]`;
}

function main() {
  const args = process.argv.slice(2);
  const datasetPath = args[0];
  let jsonPath = null;
  let seed;
  let iterations;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--json') jsonPath = args[++i];
    else if (args[i] === '--seed') seed = parseInt(args[++i], 10);
    else if (args[i] === '--iterations') iterations = parseInt(args[++i], 10);
  }
  if (!datasetPath) {
    console.error(`Usage: node tools/${TOOL_NAME} <dataset.json> [--json <out.json>] [--seed <n>] [--iterations <n>]`);
    return 1;
  }
  let dataset;
  try {
    dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
  } catch (e) {
    console.error(`ERROR: cannot read dataset ${datasetPath}: ${e.message}`);
    return 3;
  }
  try {
    const report = buildReport(dataset, {
      seed,
      iterations,
      generated_at: new Date().toISOString()
    });
    console.log(formatReportText(report));
    if (jsonPath) {
      fs.mkdirSync(path.dirname(path.resolve(jsonPath)), { recursive: true });
      atomicWriteJson(jsonPath, report);
      console.log(`JSON report written: ${jsonPath}`);
    }
    return 0;
  } catch (e) {
    if (e instanceof E1RefusalError) {
      console.error(`REFUSED: ${e.message}`);
      return 2;
    }
    console.error(`ERROR: ${e.message}`);
    return 3;
  }
}

module.exports = {
  TOOL_NAME,
  TOOL_VERSION,
  DEFAULT_PREPROCESSING,
  ALLOWED_COLOR_SPACES,
  LAYERS,
  CHARACTER_LAYERS,
  MIN_LAYER_SAMPLES,
  MIN_BOOTSTRAP_ITERATIONS,
  VERDICT_BOUND,
  VERDICT_REFERENCE_ONLY,
  DEFAULT_SEED,
  E1RefusalError,
  median,
  percentile,
  clusterKey,
  buildClusters,
  mulberry32,
  ciExcludesZero,
  ciReverseSignificant,
  bootstrapDiffCI,
  checkPreregistration,
  checkMetricMetadata,
  selectSecondaryMetric,
  computeLayer,
  buildReport,
  formatReportText
};

if (require.main === module) {
  process.exitCode = main();
}
