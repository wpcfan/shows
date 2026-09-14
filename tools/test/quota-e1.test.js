#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const { test, throws, mkTempDir, writeManifest, readManifest, shotBase } = require('./helpers');
const {
  emptyLedger, recordOutcome, computeCostPerAcceptedVideoShot, ledgerReport,
  countAcceptedVideoShots, validateCost, ensureLedger
} = require('../quota-ledger');
const {
  buildReport, bootstrapDiffCI, median, buildClusters, checkPreregistration,
  formatReportText, E1RefusalError, MIN_LAYER_SAMPLES,
  DEFAULT_PREPROCESSING, checkMetricMetadata
} = require('../e1-report');
const { ROOT } = require('../build-prompt');
const { updateManifest } = require('../mark-shot');
const { createRenderTask } = require('../render-next');
const {
  computeShotVideoHash, fileContentHash, styleGuideFileDigest, normalizeTaskStatus
} = require('../build-manifest');

const E1M = require('../e1-metrics');
const E1C = require('../e1-collect');
const E1P = require('../../experiments/e1/adapters/pippit');

// ---- M1-F: quota ledger ----

const QUOTA_STAGES = ['image', 'tts', 'video'];
const QUOTA_COUNTERS = ['requests', 'successes', 'cache_hits', 'rejects', 'failed_billed'];

function quotaTimeline(clips) { return { clips }; }

function quotaManifestWithTask(dir, overrides = {}) {
  writeManifest(dir, {
    episode: 'TEST',
    render_tasks: [Object.assign({ task_id: 'task-x', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: 'h1', status: 'submitted', stage: 'video', breaker_epoch: 0 }, overrides)],
    shots: [shotBase('s01-shot-01', { input_hash: 'h1', breaker_epoch: 0 })]
  });
  return dir;
}

function videoLedger(dir) {
  return readManifest(dir).quota_ledger.stages.video;
}

const M0_SCRIPT = [
  'episode: M0TEST', 'title: T', 'defaults:', '  duration: 8', "  ratio: '16:9'", "  resolution: '720p'", "  model: 'default'",
  'scenes:', '  - id: s01', '    shots:',
  '      - id: s01-shot-01', "        style_en: 'cinematic'", "        prompt_en: 'a'", ''
].join('\n');

function runBuildManifest(dir, env) {
  return spawnSync(process.execPath, [path.join(ROOT, 'tools', 'build-manifest.js'), dir], {
    encoding: 'utf8', env: env || process.env
  });
}

function resolvedShotPaths(shot) {
  return (shot.image_paths || []).map(p => (path.isAbsolute(p) ? p : path.resolve(ROOT, p)));
}

function selectedKeyframeFileDigest(shot) {
  if (!shot.selected_keyframe) return null;
  const kf = (shot.keyframe_takes || []).find(t => t && t.id === shot.selected_keyframe);
  if (!kf || kf.status === 'rejected' || kf.status === 'superseded' || !kf.path) return null;
  return fileContentHash(path.isAbsolute(kf.path) ? kf.path : path.resolve(ROOT, kf.path));
}

function hashForShot(shot, schemaVersion = 1) {
  return computeShotVideoHash(
    Object.assign({}, shot, { image_paths: resolvedShotPaths(shot) }),
    { schemaVersion, keyframeDigest: selectedKeyframeFileDigest(shot), styleGuideDigest: styleGuideFileDigest() }
  );
}

test('Q1a. emptyLedger:三阶段 + 全计数 + currency,缺省 USD', () => {
  const l = emptyLedger();
  assert.deepStrictEqual(Object.keys(l.stages).sort(), [...QUOTA_STAGES].sort());
  for (const st of QUOTA_STAGES) {
    for (const c of QUOTA_COUNTERS) assert.strictEqual(l.stages[st][c], 0, `${st}.${c}`);
    assert.strictEqual(l.stages[st].actual_cost, 0, `${st}.actual_cost`);
  }
  assert.strictEqual(l.currency, 'USD');
  assert.strictEqual(emptyLedger('CNY').currency, 'CNY');
});

test('Q1b. ensureLedger:缺省自动初始化(不动已有值;补齐缺失 stage)', () => {
  const holder = {};
  const l = ensureLedger(holder);
  assert.strictEqual(holder.quota_ledger, l);
  assert.deepStrictEqual(l.stages.image, emptyLedger().stages.image);
  recordOutcome(l, 'video', 'success', { cost: 3 });
  const l2 = ensureLedger(holder);
  assert.strictEqual(l2.stages.video.actual_cost, 3, 'existing values preserved');
  // 半初始化 ledger 补齐缺失 stage
  const partial = { currency: 'USD', stages: { video: { requests: 2 } } };
  const fixed = ensureLedger({ quota_ledger: partial });
  assert.strictEqual(fixed.stages.video.requests, 2);
  assert.strictEqual(fixed.stages.image.cache_hits, 0);
});

test('Q2a. recordOutcome 各 outcome 映射到对应计数器', () => {
  const l = emptyLedger();
  recordOutcome(l, 'video', 'request');
  recordOutcome(l, 'video', 'success');
  recordOutcome(l, 'video', 'cache_hit');
  recordOutcome(l, 'video', 'reject');
  recordOutcome(l, 'video', 'failed_billed');
  assert.deepStrictEqual(
    QUOTA_COUNTERS.map(c => l.stages.video[c]),
    [1, 1, 1, 1, 1]
  );
  assert.strictEqual(l.stages.image.requests, 0, 'other stages untouched');
});

test('Q2b. recordOutcome 未知 outcome → 报错(不静默)', () => {
  const l = emptyLedger();
  throws(() => recordOutcome(l, 'video', 'bogus'), 'unknown ledger outcome');
});

test('Q2c. cache_hit 强制不累加成本(即使传入 cost)', () => {
  const l = emptyLedger();
  recordOutcome(l, 'video', 'cache_hit', { cost: 99 });
  assert.strictEqual(l.stages.video.actual_cost, 0, 'cache hit cost is 0');
  recordOutcome(l, 'video', 'success', { cost: 2.5 });
  recordOutcome(l, 'video', 'reject', { cost: 1.5 });
  recordOutcome(l, 'video', 'failed_billed', { cost: 0.5 });
  assert.strictEqual(l.stages.video.actual_cost, 4.5, 'rejected/failed_billed costs count');
});

test('Q2d. validateCost:有限非负;非法报错', () => {
  assert.strictEqual(validateCost(0), 0);
  assert.strictEqual(validateCost(1.25), 1.25);
  assert.strictEqual(validateCost('3'), 3);
  throws(() => validateCost(-1), 'finite non-negative');
  throws(() => validateCost(NaN), 'finite non-negative');
  throws(() => validateCost(Infinity), 'finite non-negative');
  throws(() => validateCost('abc'), 'finite non-negative');
  throws(() => validateCost(null), 'finite non-negative');
  throws(() => validateCost(undefined), 'finite non-negative');
});

test('Q3a. 成本公式固定:三阶段成本之和 / distinct accepted video shot', () => {
  const l = emptyLedger();
  recordOutcome(l, 'image', 'success', { cost: 1 });
  recordOutcome(l, 'tts', 'success', { cost: 2 });
  recordOutcome(l, 'video', 'success', { cost: 3 });
  assert.strictEqual(countAcceptedVideoShots(quotaTimeline([{ shot_id: 's1' }, { shot_id: 's2' }])), 2);
  assert.strictEqual(computeCostPerAcceptedVideoShot(l, quotaTimeline([{ shot_id: 's1' }, { shot_id: 's2' }])), 3);
});

test('Q3b. 同一 shot 多个 clip 实例 → 分母仍为 1(剪辑方式不污染生成成本)', () => {
  const l = emptyLedger();
  recordOutcome(l, 'video', 'success', { cost: 6 });
  const clips = [{ shot_id: 's1' }, { shot_id: 's1' }, { shot_id: 's1', in_point: 2, out_point: 4 }];
  assert.strictEqual(countAcceptedVideoShots(quotaTimeline(clips)), 1);
  assert.strictEqual(computeCostPerAcceptedVideoShot(l, quotaTimeline(clips)), 6);
});

test('Q3c. rejected / failed_billed 生成成本计入分子', () => {
  const l = emptyLedger();
  recordOutcome(l, 'video', 'reject', { cost: 2 });
  recordOutcome(l, 'video', 'failed_billed', { cost: 3 });
  assert.strictEqual(computeCostPerAcceptedVideoShot(l, quotaTimeline([{ shot_id: 's1' }])), 5);
});

test('Q3d. 分母为 0 → null + warning(不除零/NaN)', () => {
  const l = emptyLedger();
  recordOutcome(l, 'video', 'success', { cost: 9 });
  const warnings = [];
  const v = computeCostPerAcceptedVideoShot(l, quotaTimeline([]), { warnings });
  assert.strictEqual(v, null);
  assert.ok(warnings.some(w => /no accepted video shots/i.test(w)), `warning: ${warnings.join(' | ')}`);
  const report = ledgerReport(l, quotaTimeline([]));
  assert.strictEqual(report.formula.denominator, 0);
  assert.strictEqual(report.cost_per_accepted_video_shot, null);
  assert.ok(report.warnings.some(w => /no accepted video shots/i.test(w)));
});

test('Q3e. 显式 rejected/superseded/非 video clip 不计入分母', () => {
  const clips = [
    { shot_id: 's1' },
    { shot_id: 's2', accepted: false },
    { shot_id: 's3', status: 'rejected' },
    { shot_id: 's4', status: 'superseded' },
    { shot_id: 's5', stage: 'image' }
  ];
  assert.strictEqual(countAcceptedVideoShots(quotaTimeline(clips)), 1);
});

test('Q3g. --reject --cost 计入 video.actual_cost(幂等不重复计)', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'v.mp4');
  fs.writeFileSync(vfile, 'v');
  writeManifest(dir, { episode: 'TEST', shots: [shotBase('s01-shot-01', { input_hash: 'h1', takes: [
    { id: 'take-001', path: vfile, model: 'M', input_hash: 'h1', rendered_at: 't', status: 'candidate', notes: '' }
  ] })] });
  const r = updateManifest(dir, 's01-shot-01', { action: 'reject', takeId: 'take-001', cost: 1.25 });
  assert.strictEqual(r.manifest.quota_ledger.stages.video.rejects, 1);
  assert.strictEqual(r.manifest.quota_ledger.stages.video.actual_cost, 1.25, 'rejected generation cost must be billed into actual_cost');
  const r2 = updateManifest(dir, 's01-shot-01', { action: 'reject', takeId: 'take-001', cost: 1.25 });
  assert.strictEqual(r2.manifest.quota_ledger.stages.video.rejects, 1, 'repeat reject must not double count');
  assert.strictEqual(r2.manifest.quota_ledger.stages.video.actual_cost, 1.25, 'repeat reject must not double bill');
});

test('Q3h. --review reject --cost 计入 video.actual_cost', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'v.mp4');
  fs.writeFileSync(vfile, 'v');
  writeManifest(dir, { episode: 'TEST', shots: [shotBase('s01-shot-01', { input_hash: 'h1', takes: [
    { id: 'take-001', path: vfile, model: 'M', input_hash: 'h1', rendered_at: 't', status: 'candidate', notes: '' }
  ] })] });
  const r = updateManifest(dir, 's01-shot-01', { action: 'review', takeId: 'take-001', conclusion: 'reject', cost: 0.5 });
  assert.strictEqual(r.manifest.quota_ledger.stages.video.rejects, 1);
  assert.strictEqual(r.manifest.quota_ledger.stages.video.actual_cost, 0.5);
});

test('Q3f. ledgerReport 结构化汇总(计数 + 成本 + 公式分子分母)', () => {
  const l = emptyLedger('CNY');
  recordOutcome(l, 'image', 'request');
  recordOutcome(l, 'video', 'success', { cost: 4 });
  const report = ledgerReport(l, quotaTimeline([{ shot_id: 'a' }, { shot_id: 'b' }]));
  assert.strictEqual(report.currency, 'CNY');
  assert.strictEqual(report.stages.video.successes, 1);
  assert.strictEqual(report.stages.image.requests, 1);
  assert.deepStrictEqual(report.formula.components, { image_cost: 0, tts_cost: 0, video_cost: 4 });
  assert.strictEqual(report.formula.numerator, 4);
  assert.strictEqual(report.formula.denominator, 2);
  assert.strictEqual(report.cost_per_accepted_video_shot, 2);
});

test('Q4a. render-next 创建新 task → video.requests += 1', () => {
  const dir = mkTempDir();
  const img = path.join(dir, 'ref.jpg');
  fs.writeFileSync(img, 'x');
  const shot = shotBase('s01-shot-01', { image_paths: [img] });
  shot.input_hash = hashForShot(shot);
  writeManifest(dir, { episode: 'TEST', shots: [shot] });
  createRenderTask(dir);
  const v = videoLedger(dir);
  assert.strictEqual(v.requests, 1);
  assert.strictEqual(v.cache_hits, 0);
});

test('Q4b. render-next 幂等复用既有 task → video.cache_hits += 1(复用即缓存)', () => {
  const dir = mkTempDir();
  const img = path.join(dir, 'ref.jpg');
  fs.writeFileSync(img, 'x');
  const shot = shotBase('s01-shot-01', { image_paths: [img] });
  shot.input_hash = hashForShot(shot);
  writeManifest(dir, { episode: 'TEST', shots: [shot] });
  createRenderTask(dir);
  createRenderTask(dir);
  const v = videoLedger(dir);
  assert.strictEqual(v.requests, 1, 'only the first call creates a task');
  assert.strictEqual(v.cache_hits, 1, 'idempotent reuse is a cache hit');
  assert.strictEqual(v.actual_cost, 0, 'cache hit is cost 0');
});

test('Q4c. mark-shot --take(成功回写)→ video.successes += 1,且重复回写不重复计数', () => {
  const dir = quotaManifestWithTask(mkTempDir());
  const vfile = path.join(dir, 'take.mp4');
  fs.writeFileSync(vfile, 'v');
  const opts = { action: 'take', path: vfile, taskId: 'task-x' };
  updateManifest(dir, 's01-shot-01', opts);
  assert.strictEqual(videoLedger(dir).successes, 1);
  updateManifest(dir, 's01-shot-01', opts);
  assert.strictEqual(videoLedger(dir).successes, 1, 'idempotent re-callback does not double count');
});

test('Q4d. mark-shot --review --conclusion reject → video.rejects += 1', () => {
  const dir = quotaManifestWithTask(mkTempDir());
  const vfile = path.join(dir, 'take.mp4');
  fs.writeFileSync(vfile, 'v');
  updateManifest(dir, 's01-shot-01', { action: 'take', path: vfile, taskId: 'task-x' });
  updateManifest(dir, 's01-shot-01', { action: 'review', takeId: 'take-001', conclusion: 'reject' });
  assert.strictEqual(videoLedger(dir).rejects, 1);
});

test('Q4e. mark-shot --failed --task:hard/熔断 → failed_billed;transient 默认不计', () => {
  const hardDir = quotaManifestWithTask(mkTempDir());
  const hardRes = updateManifest(hardDir, 's01-shot-01', { action: 'failed', taskId: 'task-x', error: 'content policy violation' });
  assert.strictEqual(normalizeTaskStatus(hardRes.manifest.render_tasks[0].status), 'retry_wait', 'hard failure accumulates in retry_wait (A1)');
  assert.strictEqual(videoLedger(hardDir).failed_billed, 1, 'hard failure is billed by default (ledger semantics unchanged)');

  const transDir = quotaManifestWithTask(mkTempDir());
  updateManifest(transDir, 's01-shot-01', { action: 'failed', taskId: 'task-x', error: '429 rate limit' });
  assert.strictEqual(videoLedger(transDir).failed_billed, 0, 'transient retry is not a terminal billed failure');

  const billedDir = quotaManifestWithTask(mkTempDir());
  updateManifest(billedDir, 's01-shot-01', { action: 'failed', taskId: 'task-x', error: '429 rate limit', billed: true });
  assert.strictEqual(videoLedger(billedDir).failed_billed, 1, '--billed forces counting (vendor actually charged)');

  const notBilledDir = quotaManifestWithTask(mkTempDir());
  updateManifest(notBilledDir, 's01-shot-01', { action: 'failed', taskId: 'task-x', error: 'content policy', billed: false });
  assert.strictEqual(videoLedger(notBilledDir).failed_billed, 0, '--no-billed suppresses counting');
});

test('Q4f. mark-shot --cost 写入 video.actual_cost;非法值报错', () => {
  const dir = quotaManifestWithTask(mkTempDir());
  const vfile = path.join(dir, 'take.mp4');
  fs.writeFileSync(vfile, 'v');
  updateManifest(dir, 's01-shot-01', { action: 'take', path: vfile, taskId: 'task-x', cost: 1.75 });
  assert.strictEqual(videoLedger(dir).actual_cost, 1.75);
  throws(() => updateManifest(dir, 's01-shot-01', { action: 'failed', taskId: 'task-x', error: 'x', cost: -1 }), 'finite non-negative');
  throws(() => updateManifest(dir, 's01-shot-01', { action: 'failed', taskId: 'task-x', error: 'x', cost: 'abc' }), 'finite non-negative');
});

test('Q5a. build-manifest 重建保留 quota_ledger', () => {
  const dir = mkTempDir();
  fs.writeFileSync(path.join(dir, 'script.yaml'), M0_SCRIPT);
  const ledger = emptyLedger('USD');
  recordOutcome(ledger, 'video', 'success', { cost: 12 });
  writeManifest(dir, { episode: 'M0TEST', quota_ledger: ledger });
  const r = runBuildManifest(dir);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  const m = readManifest(dir);
  assert.strictEqual(m.quota_ledger.stages.video.actual_cost, 12);
  assert.strictEqual(m.quota_ledger.stages.video.successes, 1);
});

test('Q5b. build-manifest 缺省自动初始化 quota_ledger', () => {
  const dir = mkTempDir();
  fs.writeFileSync(path.join(dir, 'script.yaml'), M0_SCRIPT);
  const r = runBuildManifest(dir);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  const m = readManifest(dir);
  assert.ok(m.quota_ledger, 'quota_ledger must be initialized by default');
  assert.strictEqual(m.quota_ledger.stages.video.requests, 0);
  assert.strictEqual(m.quota_ledger.currency, 'USD');
});

// ---- M1-G: E1 statistical contract ----

const E1_LAYERS = ['closeup', 'wide', 'empty', 'motion'];

function e1Metrics() {
  return {
    ssim: {
      impl: 'skimage.metrics.structural_similarity',
      version: '0.22.0',
      params: { window: 7, gaussian: true, K1: 0.01, K2: 0.03, data_range: 255 },
      preprocessing: Object.assign({}, DEFAULT_PREPROCESSING)
    },
    secondary: { field: 'phash_distance', impl: 'imagehash.phash', version: '4.3.1' }
  };
}

function e1MetricsWith(overrides = {}) {
  const m = e1Metrics();
  for (const k of Object.keys(overrides)) {
    if (k === 'ssim') m.ssim = Object.assign({}, m.ssim, overrides.ssim);
    else if (k === 'preprocessing') m.ssim.preprocessing = Object.assign({}, m.ssim.preprocessing, overrides.preprocessing);
    else if (k === 'params') m.ssim.params = Object.assign({}, m.ssim.params, overrides.params);
    else m[k] = overrides[k];
  }
  return m;
}

function e1Meta(extra = {}) {
  return Object.assign({
    interface_name: 'TEST-IFACE', interface_version: '1.0.0', params_position: 'first_frame',
    experiment_date: '2025-01-01',
    delta_preregistered: 0.1, delta_frozen_at: '2025-01-01T00:00:00Z',
    ssim_abs_min: 0.8,
    metrics: e1Metrics(),
    bootstrap_iterations: 1000,
    duration_value_range: [5, 10],
    lipsync: { supported: false, source: 'synthetic-placeholder', verified_at: '2025-01-01' },
    synthetic: true
  }, extra);
}

function e1Dataset({ byCluster, layers = E1_LAYERS, scenes = 3, prompts = 2, seeds = 2, metaExtra = {} } = {}) {
  const samples = [];
  for (const layer of layers) {
    for (let s = 0; s < scenes; s++) {
      for (let p = 0; p < prompts; p++) {
        const vals = byCluster(layer, s, p);
        for (let k = 0; k < seeds; k++) {
          const seed = 100 + k;
          for (const g of ['A', 'B', 'C']) {
            samples.push({
              group: g, layer, scene: `scene-${s + 1}`, prompt_id: `prompt-${p + 1}`, seed,
              ssim: vals[g], phash_distance: Number(Math.max(0, (1 - vals[g]) * 64).toFixed(3))
            });
          }
        }
      }
    }
  }
  return { meta: e1Meta(metaExtra), samples };
}

function truncate(s) { return String(s).slice(0, 600); }

test('E1a. median 基础', () => {
  assert.strictEqual(median([3, 1, 2]), 2);
  assert.strictEqual(median([1, 2, 3, 4]), 2.5);
  assert.strictEqual(median([]), null);
});

test('E1b. A 明显优于 B/C(差值 ≥ Δ 且 CI 不跨 0)→ first_frame_bound true', () => {
  const ds = e1Dataset({ byCluster: () => ({ A: 0.9, B: 0.6, C: 0.6 }) });
  const r = buildReport(ds, { generated_at: 'T' });
  assert.strictEqual(r.first_frame_bound, true, JSON.stringify(r.layers.map(l => [l.layer, l.status, l.deltas.a_minus_b])));
  assert.strictEqual(r.verdict, 'first_frame_bound');
  for (const l of r.layers) assert.strictEqual(l.status, 'pass', `${l.layer} should pass`);
  const ab = r.layers[0].deltas.a_minus_b;
  assert.ok(ab.ci_low > 0, `A-B CI must exclude 0 upward: ${JSON.stringify(ab)}`);
});

test('E1c. A 与 B/C 无差异 → reference_guidance_only', () => {
  const ds = e1Dataset({ byCluster: () => ({ A: 0.7, B: 0.7, C: 0.7 }) });
  const r = buildReport(ds, { generated_at: 'T' });
  assert.strictEqual(r.first_frame_bound, false);
  assert.strictEqual(r.verdict, 'reference_guidance_only');
  assert.ok(r.layers.every(l => l.status !== 'pass'));
});

test('E1d. bootstrap CI 跨 0 → 该层不通过', () => {
  const ds = e1Dataset({
    byCluster: (layer, s) => ({ A: 0.7 + [0.2, -0.2, 0][s], B: 0.7, C: 0.7 })
  });
  const r = buildReport(ds, { generated_at: 'T' });
  const ab = r.layers[0].deltas.a_minus_b;
  assert.ok(ab.ci_low < 0 && ab.ci_high > 0, `CI must cross 0: ${JSON.stringify(ab)}`);
  assert.strictEqual(r.layers[0].status !== 'pass', true);
  assert.strictEqual(r.first_frame_bound, false);
});

test('E1e. 某层样本不足 → status=insufficient 且判定降级', () => {
  let ds = e1Dataset({ byCluster: () => ({ A: 0.9, B: 0.6, C: 0.6 }), seeds: 2 });
  ds = Object.assign({}, ds, { samples: ds.samples.filter(s => s.layer !== 'motion' || s.seed < 101) });
  const r = buildReport(ds, { generated_at: 'T' });
  const motion = r.layers.find(l => l.layer === 'motion');
  assert.strictEqual(motion.status, 'insufficient');
  assert.strictEqual(r.first_frame_bound, false, 'insufficient layer must downgrade the verdict');
  assert.strictEqual(r.verdict, 'reference_guidance_only');
  assert.strictEqual(MIN_LAYER_SAMPLES, 10);
});

test('E1f. 缺 delta_frozen_at / delta_preregistered → 工具拒绝出结论', () => {
  const noFrozen = e1Dataset({ byCluster: () => ({ A: 0.9, B: 0.6, C: 0.6 }), metaExtra: { delta_frozen_at: undefined } });
  assert.ok(checkPreregistration(noFrozen.meta).includes('delta_frozen_at'));
  throws(() => buildReport(noFrozen), 'preregist');
  let err = null;
  try { buildReport(noFrozen); } catch (e) { err = e; }
  assert.ok(err instanceof E1RefusalError);
  const noDelta = e1Dataset({ byCluster: () => ({ A: 0.9, B: 0.6, C: 0.6 }), metaExtra: { delta_preregistered: null } });
  throws(() => buildReport(noDelta), 'preregist');
  const dir = mkTempDir();
  const dsPath = path.join(dir, 'ds.json');
  fs.writeFileSync(dsPath, JSON.stringify(noFrozen));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'e1-report.js'), dsPath], { encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0, 'CLI must refuse without preregistration');
  assert.ok(/preregist|delta_frozen_at/i.test(r.stdout + r.stderr));
});

test('E1g. 缺 duration_value_range / lipsync → incomplete(不阻塞统计)', () => {
  const ds = e1Dataset({
    byCluster: () => ({ A: 0.9, B: 0.6, C: 0.6 }),
    metaExtra: { duration_value_range: undefined, lipsync: undefined }
  });
  const r = buildReport(ds, { generated_at: 'T' });
  assert.strictEqual(r.incomplete, true);
  assert.ok(r.incomplete_reasons.some(x => /duration_value_range/.test(x)));
  assert.ok(r.incomplete_reasons.some(x => /lipsync/.test(x)));
  assert.strictEqual(r.first_frame_bound, true, 'statistics still computed');
});

test('E1h. bootstrap 固定种子 → 确定性(两次运行一致)', () => {
  const ds = e1Dataset({ byCluster: (layer, s) => ({ A: 0.8 + s * 0.02, B: 0.6 - s * 0.01, C: 0.55 + s * 0.01 }) });
  const r1 = buildReport(ds, { generated_at: 'T', seed: 4242 });
  const r2 = buildReport(ds, { generated_at: 'T', seed: 4242 });
  assert.deepStrictEqual(r1, r2);
  const r3 = buildReport(ds, { generated_at: 'T', seed: 9999 });
  assert.notStrictEqual(
    JSON.stringify(r1.layers[0].deltas.a_minus_b),
    JSON.stringify(r3.layers[0].deltas.a_minus_b),
    'different seeds should produce different resamples'
  );
});

test('E1i. cluster 重采样:同 scene/prompt 多 seed 不作为独立采样单元', () => {
  const base = e1Dataset({ byCluster: () => ({ A: 0.9, B: 0.6, C: 0.6 }), seeds: 1 });
  const dup = e1Dataset({ byCluster: () => ({ A: 0.9, B: 0.6, C: 0.6 }), seeds: 6 });
  const cb = buildClusters(base.samples.filter(s => s.layer === 'closeup'));
  const cd = buildClusters(dup.samples.filter(s => s.layer === 'closeup'));
  assert.strictEqual(cb.size, 6, '3 scenes x 2 prompts within one layer');
  assert.strictEqual(cd.size, cb.size, 'cluster count independent of seeds-per-cluster');
  assert.strictEqual(cd.get([...cb.keys()][0]).length, 18, '6 seeds x 3 groups inside one cluster');
  const ciBase = bootstrapDiffCI(base.samples, 'A', 'B', { seed: 7, iterations: 1000 });
  const ciDup = bootstrapDiffCI(dup.samples, 'A', 'B', { seed: 7, iterations: 1000 });
  assert.deepStrictEqual(ciDup, ciBase, 'cluster-internal repeats must not change the cluster bootstrap');
});

test('E1j. 报告记录接口名/版本/参数位/日期 + 指标实现版本', () => {
  const ds = e1Dataset({ byCluster: () => ({ A: 0.9, B: 0.6, C: 0.6 }) });
  const r = buildReport(ds, { generated_at: 'T' });
  assert.strictEqual(r.meta.interface_name, 'TEST-IFACE');
  assert.strictEqual(r.meta.interface_version, '1.0.0');
  assert.strictEqual(r.meta.params_position, 'first_frame');
  assert.strictEqual(r.meta.experiment_date, '2025-01-01');
  assert.strictEqual(r.metric.primary, 'ssim');
  assert.strictEqual(r.metric.secondary, 'phash_distance');
  assert.ok(r.metric.implementation);
  assert.ok(r.metric.version);
});

test('E1k. formatReportText 含接口信息、verdict 与降级声明', () => {
  const ds = e1Dataset({ byCluster: () => ({ A: 0.7, B: 0.7, C: 0.7 }) });
  const r = buildReport(ds, { generated_at: 'T' });
  const text = formatReportText(r);
  assert.ok(text.includes('TEST-IFACE'));
  assert.ok(text.includes('reference_guidance_only'));
  assert.ok(/不允许人工解释为/.test(text), truncate(text));
  assert.ok(/SYNTHETIC/i.test(text), 'synthetic datasets must be loudly labeled');
});

test('E1l. CLI 对 example 合成数据集可跑完并输出 --json(虚构标注)', () => {
  const example = path.join(ROOT, 'experiments', 'e1-dataset.example.json');
  assert.ok(fs.existsSync(example), 'experiments/e1-dataset.example.json must exist');
  const out = path.join(mkTempDir(), 'e1.json');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'e1-report.js'), example, '--json', out], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `CLI failed: ${r.stdout}${r.stderr}`);
  const report = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.strictEqual(report.synthetic, true, 'example dataset must be labeled synthetic');
  assert.ok(report.meta.synthetic_notice || report.notice, 'synthetic notice required');
  assert.ok(/SYNTHETIC/i.test(r.stdout), 'text output must label synthetic');
});

// ---- A7: E1 absolute quality threshold ----

test('A7a. 缺 ssim_abs_min → 预注册缺失:checkPreregistration 列出 / buildReport 抛 E1RefusalError / CLI 退出码 2', () => {
  const ds = e1Dataset({ byCluster: () => ({ A: 0.9, B: 0.6, C: 0.6 }), metaExtra: { ssim_abs_min: undefined } });
  assert.ok(checkPreregistration(ds.meta).includes('ssim_abs_min'), 'ssim_abs_min must be part of the frozen preregistration');
  let err = null;
  try { buildReport(ds, { generated_at: 'T' }); } catch (e) { err = e; }
  assert.ok(err instanceof E1RefusalError, `must refuse without a frozen absolute threshold, got ${err && err.message}`);
  assert.ok(/ssim_abs_min/.test(err.message), err.message);
  assert.ok(/delta_preregistered/.test(err.message), 'refusal text must still demand Δ');
  const dir = mkTempDir();
  const dsPath = path.join(dir, 'ds.json');
  fs.writeFileSync(dsPath, JSON.stringify(ds));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'e1-report.js'), dsPath], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2, `CLI must exit 2 without ssim_abs_min: ${r.stdout}${r.stderr}`);
  assert.ok(/ssim_abs_min/.test(r.stdout + r.stderr), r.stdout + r.stderr);
});

test('A7b. 相对条件全过但 A 中位数 < ssim_abs_min → first_frame_bound=false + reference_guidance_only + reason 含 ssim_abs_min', () => {
  const ds = e1Dataset({ byCluster: () => ({ A: 0.7, B: 0.5, C: 0.5 }), metaExtra: { ssim_abs_min: 0.8 } });
  const r = buildReport(ds, { generated_at: 'T' });
  assert.ok(r.layers.every(l => l.status === 'pass'), `relative conditions must all pass: ${JSON.stringify(r.layers.map(l => [l.layer, l.status]))}`);
  assert.strictEqual(r.first_frame_bound, false, 'relative gain alone is not enough (A/B/C all low)');
  assert.strictEqual(r.verdict, 'reference_guidance_only');
  assert.ok(r.reasons.some(x => /ssim_abs_min/.test(x)), `absolute reason required: ${r.reasons.join(' | ')}`);
});

test('A7c. A 中位数 >= ssim_abs_min 且相对条件过 → first_frame_bound=true', () => {
  const ds = e1Dataset({ byCluster: () => ({ A: 0.85, B: 0.6, C: 0.6 }), metaExtra: { ssim_abs_min: 0.8 } });
  const r = buildReport(ds, { generated_at: 'T' });
  assert.strictEqual(r.absolute.pass, true);
  assert.strictEqual(r.first_frame_bound, true);
  assert.strictEqual(r.verdict, 'first_frame_bound');
});

test('A7d. report.absolute = { ssim_abs_min, a_median, pass } 数值正确', () => {
  const ds = e1Dataset({ byCluster: () => ({ A: 0.72, B: 0.5, C: 0.5 }), metaExtra: { ssim_abs_min: 0.8 } });
  const r = buildReport(ds, { generated_at: 'T' });
  assert.deepStrictEqual(r.absolute, { ssim_abs_min: 0.8, a_median: 0.72, pass: false });
});

test('A7e. meta.metrics.ssim.impl 缺失 → incomplete 且理由含 metrics', () => {
  const ds = e1Dataset({
    byCluster: () => ({ A: 0.9, B: 0.6, C: 0.6 }),
    metaExtra: { metrics: e1MetricsWith({ ssim: { impl: undefined } }) }
  });
  const r = buildReport(ds, { generated_at: 'T' });
  assert.strictEqual(r.incomplete, true);
  assert.ok(r.incomplete_reasons.some(x => /metrics/.test(x)), r.incomplete_reasons.join(' | '));
  assert.ok(r.incomplete_reasons.some(x => /impl/.test(x)), r.incomplete_reasons.join(' | '));
  assert.strictEqual(r.first_frame_bound, true, 'metadata gaps must not block the statistics/verdict');
});

test('A7f. preprocessing.sharpen=true → incomplete 且理由含 sharpen', () => {
  const ds = e1Dataset({
    byCluster: () => ({ A: 0.9, B: 0.6, C: 0.6 }),
    metaExtra: { metrics: e1MetricsWith({ preprocessing: { sharpen: true } }) }
  });
  const r = buildReport(ds, { generated_at: 'T' });
  assert.strictEqual(r.incomplete, true);
  assert.ok(r.incomplete_reasons.some(x => /sharpen/.test(x)), r.incomplete_reasons.join(' | '));
});

test('A7g. report.metrics.ssim.preprocessing 含 DEFAULT_PREPROCESSING 缺省补齐值', () => {
  assert.deepStrictEqual(DEFAULT_PREPROCESSING, { cover_crop: 'to_video_aspect', resize: '512x512-bilinear', color_space: 'sRGB', sharpen: false });
  const partial = e1Dataset({
    byCluster: () => ({ A: 0.9, B: 0.6, C: 0.6 }),
    metaExtra: { metrics: e1MetricsWith({ preprocessing: { color_space: 'BT.709' } }) }
  });
  const r = buildReport(partial, { generated_at: 'T' });
  assert.deepStrictEqual(r.metrics.ssim.preprocessing, { cover_crop: 'to_video_aspect', resize: '512x512-bilinear', color_space: 'BT.709', sharpen: false });
  const noPre = e1Dataset({
    byCluster: () => ({ A: 0.9, B: 0.6, C: 0.6 }),
    metaExtra: { metrics: e1MetricsWith({ ssim: { preprocessing: undefined } }) }
  });
  const r2 = buildReport(noPre, { generated_at: 'T' });
  assert.deepStrictEqual(r2.metrics.ssim.preprocessing, DEFAULT_PREPROCESSING);
  assert.ok(r2.incomplete_reasons.some(x => /preprocessing/.test(x)), r2.incomplete_reasons.join(' | '));
  assert.strictEqual(r.metrics.ssim.impl, 'skimage.metrics.structural_similarity');
  assert.strictEqual(r.metrics.ssim.version, '0.22.0');
  assert.strictEqual(r.metrics.secondary.impl, 'imagehash.phash');
  assert.strictEqual(r.metrics.secondary.version, '4.3.1');
});

test('A7h. 文本报告含绝对门槛行与实现/版本行', () => {
  const ds = e1Dataset({ byCluster: () => ({ A: 0.7, B: 0.5, C: 0.5 }), metaExtra: { ssim_abs_min: 0.8 } });
  const text = formatReportText(buildReport(ds, { generated_at: 'T' }));
  assert.ok(/ssim_abs_min/.test(text), truncate(text));
  assert.ok(/absolute/i.test(text) || /绝对/.test(text), truncate(text));
  assert.ok(text.includes('skimage.metrics.structural_similarity'), truncate(text));
  assert.ok(text.includes('0.22.0'), truncate(text));
  assert.ok(/preprocessing|预处理/i.test(text), truncate(text));
});

test('A7i. checkMetricMetadata 直接契约:缺失/非法字段 → incomplete 理由;合法 → 空数组', () => {
  assert.deepStrictEqual(checkMetricMetadata({ metrics: e1Metrics() }, { field: 'phash_distance' }), []);
  const noMetrics = checkMetricMetadata({}, { field: 'phash_distance' });
  assert.ok(noMetrics.some(x => /metrics/.test(x)));
  const badColor = checkMetricMetadata({ metrics: e1MetricsWith({ preprocessing: { color_space: 'AdobeRGB' } }) }, { field: 'phash_distance' });
  assert.ok(badColor.some(x => /color_space/.test(x)), badColor.join(' | '));
  const noParams = checkMetricMetadata({ metrics: e1MetricsWith({ params: { window: undefined } }) }, { field: 'phash_distance' });
  assert.ok(noParams.some(x => /params\.window/.test(x)), noParams.join(' | '));
  const noSecondary = checkMetricMetadata({ metrics: e1MetricsWith({ secondary: undefined }) }, { field: 'phash_distance' });
  assert.ok(noSecondary.some(x => /secondary/.test(x)), noSecondary.join(' | '));
});

// ---- E1-COLLECT: E1 collection and metrics ----

function ffmpegOk() {
  try {
    const r = spawnSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-version'], { encoding: 'utf8' });
    return !r.error && r.status === 0;
  } catch { return false; }
}
const HAS_FFMPEG = ffmpegOk();
function testFfmpeg(name, fn) {
  if (!HAS_FFMPEG) { console.log(`  - SKIP ${name} (ffmpeg unavailable)`); return; }
  test(name, fn);
}

function genImage(dir, name, lavfi) {
  const p = path.join(dir, name);
  const r = spawnSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', lavfi, '-frames:v', '1', p], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`genImage failed (${name}): ${r.stderr || r.stdout}`);
  return p;
}

function runCollectorCli(args, env) {
  return spawnSync(process.execPath, [path.join(ROOT, 'tools', 'e1-collect.js'), ...args], {
    encoding: 'utf8',
    env: env ? Object.assign({}, process.env, env) : process.env
  });
}

function writeMockConfig(dir, opts = {}) {
  const image = opts.image || genImage(dir, 'input.png', 'testsrc2=s=256x144:r=1');
  const cfg = {
    output_dir: path.join(dir, 'data'),
    adapter: path.join(ROOT, 'experiments', 'e1', 'adapters', 'mock.js'),
    delay_ms: 0,
    max_retries: opts.max_retries == null ? 2 : opts.max_retries,
    synthetic: true,
    groups: [
      { id: 'A', params_position: 'first_frame' },
      { id: 'B', params_position: 'reference_image' },
      { id: 'C', params_position: null }
    ],
    cases: [{
      scene: 'scene-01', prompt_id: 'prompt-01', layer: 'closeup', prompt: 'mock rehearsal',
      image, seeds: [1], duration: 8, ratio: '16:9', resolution: '720p', model: 'mock'
    }]
  };
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  return { configPath, config: cfg, image };
}

let e1SharedFixture = null;
function e1Shared() {
  if (e1SharedFixture) return e1SharedFixture;
  const dir = mkTempDir();
  const { configPath, config } = writeMockConfig(dir);
  const datasetPath = path.join(dir, 'dataset.json');
  const r = runCollectorCli(['--config', configPath, '--prereg', path.join(ROOT, 'experiments', 'e1', 'preregistration.template.json'), '--out', datasetPath]);
  if (r.status !== 0) throw new Error(`collector CLI failed (${r.status}): ${r.stdout}${r.stderr}`);
  e1SharedFixture = {
    dir, configPath, config, datasetPath,
    dataset: JSON.parse(fs.readFileSync(datasetPath, 'utf8')),
    stdout: r.stdout
  };
  return e1SharedFixture;
}

test('EC-p1. phashFromGray:相同输入距离 0、不同输入 > 0、输出 16 位 hex', () => {
  const zeros = Buffer.alloc(1024, 0);
  const grad = Buffer.alloc(1024);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) grad[y * 32 + x] = (x * 8) % 256;
  const h0 = E1M.phashFromGray(zeros);
  const h0b = E1M.phashFromGray(Buffer.alloc(1024, 0));
  const hg = E1M.phashFromGray(grad);
  assert.strictEqual(h0.length, 16, 'phash must be a 16-char hex string');
  assert.ok(/^[0-9a-f]{16}$/.test(h0));
  assert.strictEqual(E1M.phashDistance(h0, h0b), 0, 'identical input → distance 0');
  assert.ok(E1M.phashDistance(h0, hg) > 0, 'different input → distance > 0');
  throws(() => E1M.phashFromGray(Buffer.alloc(10)), 'expected');
});

test('EC-p2. parseSsimOutput:解析 All: 数值 / inf / 失败抛错', () => {
  assert.strictEqual(E1M.parseSsimOutput('SSIM R:0.5 (2.0) G:0.6 B:0.7 All:0.909548 (10.4)'), 0.909548);
  assert.strictEqual(E1M.parseSsimOutput('All:1.000000 (inf)'), 1);
  assert.strictEqual(E1M.parseSsimOutput('x All:inf y'), Infinity);
  throws(() => E1M.parseSsimOutput('no ssim here'), 'All:');
});

test('EC-p3. buildSampleMatrix:cases x groups x seeds,sample_id 路径安全', () => {
  const samples = E1C.buildSampleMatrix({
    groups: [{ id: 'A', params_position: 'first_frame' }],
    cases: [{ scene: 'a/b c', prompt_id: 'p#1', layer: 'close up', seeds: [7, 8] }]
  });
  assert.strictEqual(samples.length, 2);
  for (const s of samples) {
    assert.ok(!/[/#\s]/.test(s.sample_id), `sample_id must be path-safe: ${s.sample_id}`);
    assert.ok(s.sample_id.includes('seed-'), 'sample_id must encode the seed');
  }
  const plan = E1C.summarizePlan(samples, ['A']);
  assert.strictEqual(plan.total, 2);
  assert.strictEqual(plan.by_group.A, 2);
});

testFfmpeg('EC-m1. ssim:同图 ≥0.99、黑/灰 <0.9、异尺寸经预处理仍可算', () => {
  const dir = mkTempDir();
  const a = genImage(dir, 'a.png', 'testsrc2=s=256x144:r=1');
  const a2 = genImage(dir, 'a2.png', 'testsrc2=s=256x144:r=1');
  const black = genImage(dir, 'black.png', 'color=c=black:s=256x144:r=1');
  const gray = genImage(dir, 'gray.png', 'color=c=gray:s=256x144:r=1');
  const small = genImage(dir, 'small.png', 'testsrc2=s=128x96:r=1');
  const same = E1M.ssim(a, a2);
  assert.ok(same.value >= 0.99, `same image SSIM should be >= 0.99, got ${same.value}`);
  assert.strictEqual(same.impl, 'ffmpeg-ssim');
  assert.ok(typeof same.version === 'string' && same.version.length > 0);
  assert.strictEqual(same.params.window, '8x8');
  assert.ok(E1M.ssim(black, gray).value < 0.9, 'black vs gray should be < 0.9');
  assert.ok(Number.isFinite(E1M.ssim(a, small).value), 'mixed-size inputs must still be computable via preprocessing');
});

testFfmpeg('EC-m3. cover-crop 协议:方图输入 vs 其中心 16:9 裁切帧 → 高 SSIM,且优于旧口径', () => {
  const dir = mkTempDir();
  const sq = genImage(dir, 'sq.png', 'testsrc2=s=720x720:r=1');
  const f = genImage(dir, 'f.png', 'testsrc2=s=720x720:r=1,crop=720:404');
  const size = E1M.probeMediaSize(f);
  assert.deepStrictEqual(size, { w: 720, h: 404 });
  assert.ok(/crop=w=/.test(E1M.ssimFilterGraph(size)), 'cover-crop graph expected');
  const covered = E1M.ssim(sq, f);
  assert.ok(covered.value >= 0.95, `cover-crop SSIM should be >= 0.95, got ${covered.value}`);
  assert.strictEqual(covered.params.cover_crop, 'to_video_aspect');
  const legacyRun = spawnSync(process.env.FFMPEG_BIN || 'ffmpeg',
    ['-v', 'info', '-i', sq, '-i', f, '-lavfi', E1M.SSIM_FILTER_GRAPH, '-f', 'null', '-'], { encoding: 'utf8' });
  const legacy = E1M.parseSsimOutput(`${legacyRun.stdout || ''}${legacyRun.stderr || ''}`);
  assert.ok(legacy < covered.value, `legacy (${legacy}) should be lower than cover-crop (${covered.value})`);
});

testFfmpeg('EC-m2. grayRaw 长度 1024;pHash 同图距离 0、异图 > 0', () => {
  const dir = mkTempDir();
  const a = genImage(dir, 'a.png', 'testsrc2=s=256x144:r=1');
  const a2 = genImage(dir, 'a2.png', 'testsrc2=s=256x144:r=1');
  const other = genImage(dir, 'other.png', 'testsrc=s=256x144:r=1');
  const buf = E1M.grayRaw(a);
  assert.strictEqual(buf.length, 1024);
  const h1 = E1M.phashFromGray(buf);
  const h2 = E1M.phashFromGray(E1M.grayRaw(a2));
  const h3 = E1M.phashFromGray(E1M.grayRaw(other));
  assert.strictEqual(E1M.phashDistance(h1, h2), 0, 'same image → pHash distance 0');
  assert.ok(E1M.phashDistance(h1, h3) > 0, 'different image → pHash distance > 0');
});

testFfmpeg('EC-c1. mock 端到端:3 done 记录 / dataset 3 samples / synthetic=true / schema 一致', () => {
  const f = e1Shared();
  const recordsPath = path.join(f.config.output_dir, 'records.jsonl');
  const records = fs.readFileSync(recordsPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.strictEqual(records.filter(r => r.status === 'done').length, 3);
  for (const r of records) assert.ok(r.artifact_path && fs.existsSync(r.artifact_path), 'artifact must exist');
  assert.strictEqual(f.dataset.samples.length, 3);
  assert.strictEqual(f.dataset.meta.synthetic, true);
  assert.strictEqual(f.dataset.meta.collection.tool, 'e1-collect');
  assert.strictEqual(f.dataset.meta.collection.adapter, 'mock');
  assert.strictEqual(f.dataset.meta.collection.records, 'records.jsonl');
  for (const s of f.dataset.samples) {
    assert.ok(['A', 'B', 'C'].includes(s.group), `group: ${s.group}`);
    assert.strictEqual(s.layer, 'closeup');
    assert.strictEqual(s.scene, 'scene-01');
    assert.strictEqual(s.prompt_id, 'prompt-01');
    assert.strictEqual(s.seed, 1);
    assert.ok(s.ssim === null || Number.isFinite(s.ssim), 'ssim numeric or null');
    assert.ok(s.phash_distance === null || Number.isFinite(s.phash_distance), 'phash numeric or null');
  }
  assert.strictEqual(f.dataset.meta.delta_preregistered, 0.1);
  assert.strictEqual(f.dataset.meta.ssim_abs_min, 0.8);
  assert.ok(f.dataset.meta.delta_frozen_at);
  assert.ok(f.dataset.meta.metrics && f.dataset.meta.metrics.ssim, 'metrics merged from prereg');
  const byGroup = Object.fromEntries(f.dataset.samples.map(s => [s.group, s]));
  assert.ok(byGroup.A.ssim >= byGroup.B.ssim, 'mock A should beat degraded B');
});

testFfmpeg('EC-c2. dataset 可被 buildReport 直接消费(--prereg 含 delta/abs_min/frozen_at → 不拒绝)', () => {
  const f = e1Shared();
  const report = buildReport(f.dataset, { generated_at: 'T' });
  assert.ok(report.verdict === 'first_frame_bound' || report.verdict === 'reference_guidance_only');
  assert.strictEqual(report.synthetic, true);
  assert.strictEqual(report.meta.interface_name, 'REPLACE_ME-interface-name');
});

testFfmpeg('EC-c3. 断点续跑幂等:第二次运行 adapter 调用次数 / ledger.requests 不增加', () => {
  const dir = mkTempDir();
  const { configPath, config } = writeMockConfig(dir);
  const datasetPath = path.join(dir, 'dataset.json');
  const r1 = runCollectorCli(['--config', configPath, '--out', datasetPath]);
  assert.strictEqual(r1.status, 0, r1.stdout + r1.stderr);
  const ledgerPath = path.join(config.output_dir, 'ledger.json');
  const recordsPath = path.join(config.output_dir, 'records.jsonl');
  const req1 = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')).requests;
  const lines1 = fs.readFileSync(recordsPath, 'utf8').trim().split('\n').length;
  assert.strictEqual(req1, 3);
  const r2 = runCollectorCli(['--config', configPath, '--out', datasetPath]);
  assert.strictEqual(r2.status, 0, r2.stdout + r2.stderr);
  const req2 = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')).requests;
  const lines2 = fs.readFileSync(recordsPath, 'utf8').trim().split('\n').length;
  assert.strictEqual(req2, req1, 'rerun must not call the adapter again');
  assert.strictEqual(lines2, lines1, 'rerun must not append new records');
  assert.strictEqual(JSON.parse(fs.readFileSync(datasetPath, 'utf8')).samples.length, 3);
});

testFfmpeg('EC-c4. --dry-run 不产生 records/artifacts;--limit 生效', () => {
  const dir = mkTempDir();
  const { configPath, config } = writeMockConfig(dir);
  const outDir = config.output_dir;
  const dry = runCollectorCli(['--config', configPath, '--dry-run']);
  assert.strictEqual(dry.status, 0, dry.stdout + dry.stderr);
  assert.ok(/DRY-RUN/.test(dry.stdout));
  assert.ok(/planned samples: 3/.test(dry.stdout), dry.stdout);
  assert.ok(!fs.existsSync(path.join(outDir, 'records.jsonl')), 'dry-run must not write records');
  assert.ok(!fs.existsSync(path.join(outDir, 'artifacts')), 'dry-run must not write artifacts');
  const lim = runCollectorCli(['--config', configPath, '--limit', '1']);
  assert.strictEqual(lim.status, 0, lim.stdout + lim.stderr);
  const records = fs.readFileSync(path.join(outDir, 'records.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.strictEqual(records.length, 1, '--limit 1 must process exactly one unfinished sample');
  assert.strictEqual(records[0].status, 'done');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(outDir, 'dataset.json'), 'utf8')).samples.length, 1);
});

test('EC-c5. 失败重试:adapter 连续抛错 → failed/attempts + ledger.failures;超过 max_retries 不再重试', () => {
  const dir = mkTempDir();
  const adapterPath = path.join(dir, 'failing-adapter.js');
  fs.writeFileSync(adapterPath, [
    "'use strict';",
    "const fs = require('fs');",
    "let calls = 0;",
    'module.exports = {',
    "  name: 'failing',",
    '  async generate({ sample, outPath }) {',
    '    calls++;',
    "    if (process.env.E1_CALL_LOG) fs.appendFileSync(process.env.E1_CALL_LOG, sample.sample_id + '\\n');",
    "    throw new Error('synthetic adapter failure #' + calls);",
    '  }',
    '};'
  ].join('\n'));
  const cfg = {
    output_dir: path.join(dir, 'data'),
    adapter: adapterPath,
    delay_ms: 0,
    max_retries: 2,
    synthetic: true,
    groups: [{ id: 'A', params_position: 'first_frame' }],
    cases: [{ scene: 'scene-01', prompt_id: 'prompt-01', layer: 'closeup', seeds: [1] }]
  };
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  const logPath = path.join(dir, 'calls.log');
  const recordsPath = path.join(cfg.output_dir, 'records.jsonl');
  const ledgerPath = path.join(cfg.output_dir, 'ledger.json');

  const r1 = runCollectorCli(['--config', configPath], { E1_CALL_LOG: logPath });
  assert.strictEqual(r1.status, 0, r1.stdout + r1.stderr);
  const calls1 = fs.readFileSync(logPath, 'utf8').trim().split('\n').length;
  assert.strictEqual(calls1, 2, 'max_retries=2 → exactly two attempts');
  const recs = fs.readFileSync(recordsPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const last = recs[recs.length - 1];
  assert.strictEqual(last.status, 'failed');
  assert.strictEqual(last.attempts, 2);
  assert.ok(/synthetic adapter failure/.test(last.error));
  const led = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  assert.strictEqual(led.requests, 2);
  assert.strictEqual(led.failures, 2);
  assert.strictEqual(led.successes, 0);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(cfg.output_dir, 'dataset.json'), 'utf8')).samples.length, 0);

  const r2 = runCollectorCli(['--config', configPath], { E1_CALL_LOG: logPath });
  assert.strictEqual(r2.status, 0, r2.stdout + r2.stderr);
  const calls2 = fs.readFileSync(logPath, 'utf8').trim().split('\n').length;
  assert.strictEqual(calls2, 2, 'exhausted retries must not be retried again');
});

test('EC-p4. buildSampleMatrix 透传 groups[].adapter_params 且不共享引用', () => {
  const dir = mkTempDir();
  const cfg = {
    groups: [{ id: 'P', params_position: 'first_frame', adapter_params: { generate_type: 1, image_mode: 'first_last_same' } }],
    cases: [{ scene: 's1', prompt_id: 'p1', layer: 'closeup', prompt: 'x', image: null, seeds: [1] }]
  };
  const m = E1C.buildSampleMatrix(cfg, dir);
  assert.strictEqual(m.length, 1);
  assert.deepStrictEqual(m[0].adapter_params, { generate_type: 1, image_mode: 'first_last_same' });
  m[0].adapter_params.generate_type = 99;
  assert.strictEqual(cfg.groups[0].adapter_params.generate_type, 1, 'sample must not share the config object');
});

test('EC-pp1. pippit.buildArgs:A′ 首尾帧同图 / B 参考图 / C 无图 / 探测 generate_type', () => {
  const dir = mkTempDir();
  const img = path.join(dir, 'ref.png');
  fs.writeFileSync(img, 'x');
  const base = { group: 'G', prompt: 'p', model: 'Seedance_2.0_mini_lite', image: img, duration: 5, ratio: '16:9', resolution: '720p' };
  const count = (arr, v) => arr.filter(x => x === v).length;

  const a = E1P.buildArgs(Object.assign({}, base, { adapter_params: { generate_type: 1, image_mode: 'first_last_same' } }));
  assert.strictEqual(a[0], 'generate-video');
  assert.strictEqual(count(a, '--image'), 2, 'A′ must pass the same image twice (first,last)');
  assert.deepStrictEqual(a.slice(a.indexOf('--generate-type'), a.indexOf('--generate-type') + 2), ['--generate-type', '1']);
  assert.deepStrictEqual(a.slice(a.indexOf('--duration'), a.indexOf('--duration') + 2), ['--duration', '5']);

  const b = E1P.buildArgs(Object.assign({}, base, { adapter_params: { image_mode: 'single' } }));
  assert.strictEqual(count(b, '--image'), 1);
  assert.ok(!b.includes('--generate-type'));

  const c = E1P.buildArgs(Object.assign({}, base, { adapter_params: { image_mode: 'none' } }));
  assert.strictEqual(count(c, '--image'), 0);

  const probe = E1P.buildArgs(Object.assign({}, base, { adapter_params: { generate_type: 2, image_mode: 'single' } }));
  assert.deepStrictEqual(probe.slice(probe.indexOf('--generate-type'), probe.indexOf('--generate-type') + 2), ['--generate-type', '2']);

  throws(() => E1P.buildArgs(Object.assign({}, base, { image: path.join(dir, 'missing.png'), adapter_params: { image_mode: 'single' } })), 'not found');
  throws(() => E1P.buildArgs({ prompt: '', model: 'm', adapter_params: { image_mode: 'none' } }), 'prompt');
});

test('EC-pp2. pippit.parseCliJson 容忍日志行、报错可识别;pickVideoPath 取首条且缺产物抛错', () => {
  assert.deepStrictEqual(E1P.parseCliJson('log line\n{"thread_id":"t","run_id":"r"}'), { thread_id: 't', run_id: 'r' });
  assert.deepStrictEqual(E1P.parseCliJson('{"completed":true}'), { completed: true });
  throws(() => E1P.parseCliJson('not json at all'), 'cannot parse');
  throws(() => E1P.parseCliJson(''), 'empty CLI output');
  assert.strictEqual(E1P.pickVideoPath({ videos: [{ output_path: '/tmp/a.mp4' }] }), '/tmp/a.mp4');
  assert.strictEqual(E1P.pickVideoPath({ videos: [{ download_url: 'https://x/a.mp4' }] }), 'https://x/a.mp4');
  throws(() => E1P.pickVideoPath({ videos: [] }), 'no videos');
});
