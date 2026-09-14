'use strict';
const { test, throws, mkTempDir, writeManifest, readManifest, shotBase } = require('./helpers');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const {
  atomicWriteJson, readJsonFile, readJsonFileOrNull, SimulatedCrashError, CorruptJsonError,
  resolveEpisodeRatio, resolveShotRatio,
  normalizeTaskStatus, ACTIVE_TASK_STATUSES, TERMINAL_TASK_STATUSES, isTaskSuperseded, isActiveTaskStatus,
  classifyError, appendTaskEvent, countAttempts, failedTaskCycles, computeRetryDelay, evaluateBreaker,
  computeInputHash, canonicalJson, computeShotVideoHash,
  styleGuideFileDigest, hardFailureTaskCount,
  resolveSelectionConflict, recoverTakesFromCatalog, deriveStatus
} = require('../build-manifest');
const { validateTake, collectBlockedShotErrors } = require('../edit-episode');
const { updateManifest, appendCatalog } = require('../mark-shot');
const { ROOT } = require('../build-prompt');
const { createRenderTask, fileContentHash, collectRetryWaits } = require('../render-next');
const {
  collectFinalShotProblems, collectFinalValidationErrors,
  schemaFinalNotice: schemaFinalNoticeFromStitch
} = require('../stitch-episode');
const { withLock, acquireLockOnce, tryReclaim, lockPathFor } = require('../lock');
const { migrateEpisode, migrateScriptData, schemaFinalNotice } = require('../migrate-episode');
const { buildReport, DEFAULT_PREPROCESSING } = require('../e1-report');


// ============================================================
// Local helpers
// ============================================================

function tmpResidue(dir) {
  return fs.readdirSync(dir).filter(n => n.endsWith('.tmp'));
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

function seedTakeDir() {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'v.mp4');
  fs.writeFileSync(vfile, 'v');
  return { dir, vfile, catPath: path.join(dir, 'catalog.json') };
}

function taskAssetsDirs(dir) {
  const d = path.join(dir, '.task-assets');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter(n => fs.statSync(path.join(d, n)).isDirectory());
}

function seedTaskDir(overrides = {}) {
  const dir = mkTempDir();
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

function busyWaitMs(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { /* spin */ }
}

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

const MG_CLI = path.resolve(__dirname, '..', 'migrate-episode.js');
const MG_FILES = ['script.yaml', 'manifest.json', 'catalog.json'];

function mgBaseScript(shotLines, extraTop = []) {
  return [
    '# MG header comment (keep)',
    'episode: MGTEST',
    'title: T',
    'defaults:',
    '  duration: 8',
    "  ratio: '16:9'   # episode ratio inline comment",
    "  resolution: '720p'",
    "  model: 'default'",
    ...extraTop,
    'scenes:',
    '  - id: s01',
    '    shots:',
    '      - id: s01-shot-01',
    ...(shotLines || ["        prompt_en: 'a'   # shot inline comment"]),
    ''
  ].join('\n');
}

function mgDefaultManifest(dir) {
  return {
    episode: 'MGTEST',
    version: 1,
    defaults: { ratio: '16:9', resolution: '720p', duration: 8 },
    shots: [
      shotBase('s01-shot-01', {
        input_hash: 'h1', status: 'stale', selected_take: 'take-001',
        takes: [{ id: 'take-001', path: path.join(dir, 'take-001.mp4'), input_hash: 'h1', status: 'selected' }]
      })
    ],
    render_tasks: [{ task_id: 'task-1', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: 'h1', status: 'submitted' }]
  };
}

function mgEpisode(opts = {}) {
  const dir = mkTempDir();
  fs.writeFileSync(path.join(dir, 'script.yaml'), opts.script !== undefined ? opts.script : mgBaseScript());
  if (opts.manifest !== null) writeManifest(dir, opts.manifest || mgDefaultManifest(dir));
  if (opts.catalog !== undefined && opts.catalog !== null) {
    fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(opts.catalog, null, 2));
  }
  return dir;
}

function mgMigrate(dir, opts = {}) {
  return migrateEpisode(Object.assign({
    episodeDir: dir, to: 2, dryRun: false,
    catalogPath: path.join(dir, 'catalog.json'),
    seriesPath: path.join(dir, 'series.yaml')
  }, opts));
}

function mgSnapshot(dir) {
  const out = {};
  for (const n of MG_FILES) {
    const p = path.join(dir, n);
    out[n] = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  }
  return out;
}

function a9Manifest(dir) {
  const vfile = path.join(dir, 'v.mp4');
  fs.writeFileSync(vfile, 'v');
  writeManifest(dir, { episode: 'TEST',
    render_tasks: [{ task_id: 'task-x', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: 'h1', status: 'submitted', stage: 'video', breaker_epoch: 0, current_attempt_id: 'att-aaaa1111',
      attempts: [{ attempt_id: 'att-aaaa1111', at: '2026-01-01T00:00:00.000Z', input_hash: 'h1', request_id: null }] }],
    shots: [shotBase('s01-shot-01', { input_hash: 'h1', breaker_epoch: 0 })] });
  return { dir, vfile };
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

function twoAttemptTask() {
  return {
    task_id: 'task-x', shot_id: 's01-shot-01', take_id: 'take-001',
    input_hash: 'h1', status: 'submitted', stage: 'video', breaker_epoch: 0,
    current_attempt_id: 'att-2',
    attempts: [
      { attempt_id: 'att-1', at: '2026-01-01T00:00:00.000Z', input_hash: 'h1' },
      { attempt_id: 'att-2', at: '2026-01-01T00:01:00.000Z', input_hash: 'h1' }
    ]
  };
}

function legacyTaskNoAttempts() {
  return { task_id: 'task-x', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: 'h1', status: 'submitted', stage: 'video', breaker_epoch: 0 };
}


function ratioScriptWithShotRatio(shotRatio, extraTop = []) {
  return [
    'episode: RTEST', 'title: T', 'defaults:', '  duration: 8', "  ratio: '16:9'", "  resolution: '720p'", "  model: 'default'",
    ...extraTop,
    'scenes:', '  - id: s01', '    shots:',
    '      - id: s01-shot-01', "        style_en: 'cinematic'", "        prompt_en: 'a'", `        ratio: ${shotRatio}`, ''
  ].join('\n');
}


// ============================================================
// [M0-4] Atomic write fault injection + restart read side
// ============================================================

test('M0-4a. 正常原子写:无 tmp 残留、目标有效', () => {
  const dir = mkTempDir();
  const target = path.join(dir, 'manifest.json');
  atomicWriteJson(target, { v: 1 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { v: 1 });
  assert.deepStrictEqual(tmpResidue(dir), [], 'no tmp residue after success');
});

test('M0-4b. 注入 after-tmp-write(rename 前 crash):目标文件仍是旧值、tmp 残留', () => {
  const dir = mkTempDir();
  const target = path.join(dir, 'manifest.json');
  atomicWriteJson(target, { v: 1 });
  throws(() => atomicWriteJson(target, { v: 2 }, { fault: 'after-tmp-write' }), 'after-tmp-write');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { v: 1 }, 'target must keep old content');
  assert.strictEqual(tmpResidue(dir).length, 1, 'crash leaves tmp for inspection');
});

test('M0-4c. 重启读侧:清理崩溃残留 tmp(写者已死)并读到旧值', () => {
  const dir = mkTempDir();
  const target = path.join(dir, 'manifest.json');
  atomicWriteJson(target, { v: 1 });
  throws(() => atomicWriteJson(target, { v: 2 }, { fault: 'after-tmp-write' }), 'after-tmp-write');
  // 把崩溃现场改造成“写者进程已死”的真实重启语义(P1-5:存活写者的 in-flight tmp 不得误删)
  const dead = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  const crashed = tmpResidue(dir)[0];
  const revived = `.manifest.json.${dead.pid}.${Date.now()}.tmp`;
  fs.renameSync(path.join(dir, crashed), path.join(dir, revived));
  const val = readJsonFile(target, { label: 'manifest.json' });
  assert.deepStrictEqual(val, { v: 1 });
  assert.deepStrictEqual(tmpResidue(dir), [], 'reader must clean orphan tmp files from dead writers on restart');
});

test('M0-4d. 损坏 JSON:readJsonFile 抛 CORRUPT_JSON 且带恢复指引;文件保留供检查', () => {
  const dir = mkTempDir();
  const target = path.join(dir, 'manifest.json');
  fs.writeFileSync(target, '{"broken":');
  let err = null;
  try { readJsonFile(target, { label: 'manifest.json' }); } catch (e) { err = e; }
  assert.ok(err, 'must throw on corrupt JSON');
  assert.ok(err instanceof CorruptJsonError, `expected CorruptJsonError, got ${err.name}`);
  assert.ok(/corrupt/i.test(err.message), `message must identify corruption: ${err.message}`);
  assert.ok(/rebuild|restore/i.test(err.message), `message must carry recovery guidance: ${err.message}`);
  assert.ok(fs.existsSync(target), 'corrupt file is left untouched for inspection (not silently deleted)');
  const r = readJsonFileOrNull(target, { label: 'manifest.json' });
  assert.strictEqual(r.corrupt, true);
  assert.strictEqual(r.value, null);
  assert.ok(/rebuild|restore/i.test(r.guidance));
});

test('M0-4e. 注入 before-tmp-write:目标不变且无 tmp 残留', () => {
  const dir = mkTempDir();
  const target = path.join(dir, 'manifest.json');
  atomicWriteJson(target, { v: 1 });
  throws(() => atomicWriteJson(target, { v: 2 }, { fault: 'before-tmp-write' }), 'before-tmp-write');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { v: 1 });
  assert.deepStrictEqual(tmpResidue(dir), []);
});

test('M0-4f. SimulatedCrashError 类型可识别;readJsonFileOrNull 对缺失文件返回 missing', () => {
  const dir = mkTempDir();
  let err = null;
  try { atomicWriteJson(path.join(dir, 'x.json'), {}, { fault: 'after-tmp-write' }); } catch (e) { err = e; }
  assert.ok(err instanceof SimulatedCrashError);
  const r = readJsonFileOrNull(path.join(dir, 'nope.json'));
  assert.strictEqual(r.missing, true);
  assert.strictEqual(r.corrupt, false);
});

test('M0-4g. 集成:损坏 manifest 被识别并丢弃后重建,无 tmp 残留', () => {
  const dir = mkTempDir();
  fs.writeFileSync(path.join(dir, 'script.yaml'), M0_SCRIPT);
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{"broken":');
  const r = runBuildManifest(dir);
  assert.strictEqual(r.status, 0, `rebuild must succeed: ${r.stdout}${r.stderr}`);
  assert.ok(/corrupt/i.test(r.stdout + r.stderr), 'must report database corruption (not silently continue)');
  const m = readManifest(dir);
  assert.ok(Array.isArray(m.shots) && m.shots.length === 1, 'rebuilt manifest must be valid');
  assert.deepStrictEqual(tmpResidue(dir), [], 'no tmp residue after rebuild');
});

test('M0-4h. 集成:env 注入 rename 前 crash → 旧 manifest 不变、tmp 残留;重启重建清理', () => {
  const dir = mkTempDir();
  fs.writeFileSync(path.join(dir, 'script.yaml'), M0_SCRIPT);
  const ok = runBuildManifest(dir);
  assert.strictEqual(ok.status, 0, `${ok.stdout}${ok.stderr}`);
  const before = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');
  const crash = runBuildManifest(dir, Object.assign({}, process.env, { SHOWS_FAULT_ATOMIC_WRITE: 'after-tmp-write' }));
  assert.notStrictEqual(crash.status, 0, 'injected crash must fail the run');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), before, 'target must keep old content after crash');
  assert.strictEqual(tmpResidue(dir).length, 1, 'crash leaves tmp behind (simulated power loss)');
  const restart = runBuildManifest(dir);
  assert.strictEqual(restart.status, 0, `${restart.stdout}${restart.stderr}`);
  assert.deepStrictEqual(tmpResidue(dir), [], 'restart reader must clean orphan tmp');
  assert.ok(readManifest(dir).shots.length === 1);
});

// ============================================================
// [M0-5] Stale callback does not pollute selected state
// ============================================================

test('M0-5a. 旧 task(input 已变更)成功回调 → superseded take,不选中,不影响 current task', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'late.mp4');
  fs.writeFileSync(vfile, 'v');
  writeManifest(dir, { episode: 'TEST',
    render_tasks: [
      { task_id: 'task-old', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: 'h1', status: 'obsolete' },
      { task_id: 'task-new', shot_id: 's01-shot-01', take_id: 'take-002', input_hash: 'h2', status: 'submitted' }
    ],
    shots: [shotBase('s01-shot-01', { input_hash: 'h2' })] });
  const { manifest } = updateManifest(dir, 's01-shot-01', { action: 'take', path: vfile, taskId: 'task-old' });
  const shot = manifest.shots[0];
  const take = shot.takes.find(t => t.id === 'take-001');
  assert.ok(take, 'late artifact must be recorded');
  assert.strictEqual(take.status, 'superseded', 'stale artifact must be superseded, never candidate/selected');
  assert.strictEqual(take.input_hash, 'h1', 'take keeps the fingerprint it was generated from');
  assert.strictEqual(shot.selected_take, null, 'must not auto-select');
  assert.strictEqual(shot.status, 'pending', 'shot status unchanged');
  const oldTask = manifest.render_tasks.find(t => t.task_id === 'task-old');
  assert.strictEqual(oldTask.status, 'succeeded');
  assert.strictEqual(oldTask.completion, 'late', 'late callback marks completion=late');
  const newTask = manifest.render_tasks.find(t => t.task_id === 'task-new');
  assert.strictEqual(newTask.status, 'submitted', 'current task untouched');
  assert.strictEqual(newTask.take_id, 'take-002');
});

test('M0-5b. 重复 stale 回调 → 幂等,不重复登记', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'late.mp4');
  fs.writeFileSync(vfile, 'v');
  writeManifest(dir, { episode: 'TEST',
    render_tasks: [{ task_id: 'task-old', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: 'h1', status: 'obsolete' }],
    shots: [shotBase('s01-shot-01', { input_hash: 'h2' })] });
  const opts = { action: 'take', path: vfile, taskId: 'task-old' };
  updateManifest(dir, 's01-shot-01', opts);
  const { manifest } = updateManifest(dir, 's01-shot-01', opts);
  assert.strictEqual(manifest.shots[0].takes.filter(t => t.id === 'take-001').length, 1);
  assert.strictEqual(manifest.shots[0].takes.length, 1);
});

test('M0-5c. superseded take 不可导出;fingerprint 复现后人工 --select 可恢复', () => {
  const probeDir = mkTempDir();
  const probeFile = path.join(probeDir, 'probe.mp4');
  fs.writeFileSync(probeFile, 'v');
  const shotBefore = shotBase('s01-shot-01', { input_hash: 'h2' });
  const takeBefore = { id: 'take-001', status: 'superseded', input_hash: 'h1', path: probeFile };
  throws(() => validateTake(shotBefore, takeBefore), 'superseded');
  const errs = collectFinalValidationErrors({
    episode: 'TEST',
    shots: [Object.assign(shotBase('s01-shot-01', { input_hash: 'h2', status: 'done', selected_take: 'take-001' }), { takes: [takeBefore] })]
  });
  assert.ok(errs.some(e => /superseded/i.test(e)), `stitch --final must reject superseded: ${errs.join(' | ')}`);

  // fingerprint 复现(h1)== take.input_hash → 人工 select 可恢复
  const dir = mkTempDir();
  const vfile = path.join(dir, 'revived.mp4');
  fs.writeFileSync(vfile, 'v');
  writeManifest(dir, { episode: 'TEST',
    shots: [shotBase('s01-shot-01', { input_hash: 'h1', takes: [
      { id: 'take-001', path: vfile, model: 'M', input_hash: 'h1', status: 'superseded', rendered_at: 't1', notes: '' }
    ] })] });
  const { manifest } = updateManifest(dir, 's01-shot-01', { action: 'select', takeId: 'take-001' });
  const shot = manifest.shots[0];
  assert.strictEqual(shot.selected_take, 'take-001');
  assert.strictEqual(shot.takes[0].status, 'selected');
  assert.strictEqual(shot.status, 'done');
  validateTake(shot, shot.takes[0]);
});

test('M0-5d. 输入匹配的 late success(task 已失效)→ superseded take(经 reuse_records 恢复),不自动选中', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'late2.mp4');
  fs.writeFileSync(vfile, 'v');
  writeManifest(dir, { episode: 'TEST',
    render_tasks: [{ task_id: 'task-old', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: 'h2', status: 'obsolete' }],
    shots: [shotBase('s01-shot-01', { input_hash: 'h2' })] });
  const { manifest } = updateManifest(dir, 's01-shot-01', { action: 'take', path: vfile, taskId: 'task-old' });
  const shot = manifest.shots[0];
  assert.strictEqual(shot.takes[0].status, 'superseded', 'artifact of a superseded task is orphan/superseded even if input matches');
  assert.strictEqual(shot.selected_take, null, 'late callback never auto-selects');
  assert.strictEqual(manifest.render_tasks[0].completion, 'late');
});

// ============================================================
// [M0-3] Manifest/catalog conflict errors carry recovery guidance
// ============================================================

test('M0-3a. catalog 同 key 不同 path 冲突错误含恢复指引', () => {
  const { dir, vfile, catPath } = seedTakeDir();
  writeManifest(dir, { episode: 'TEST',
    render_tasks: [{ task_id: 'task-aa', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: 'h1', status: 'submitted' }],
    shots: [shotBase('s01-shot-01', { input_hash: 'h1' })] });
  const opts = { action: 'take', path: vfile, taskId: 'task-aa' };
  let r = updateManifest(dir, 's01-shot-01', opts);
  appendCatalog(dir, 's01-shot-01', opts, r.manifest, r.createdTakeId, catPath);
  const other = path.join(dir, 'other.mp4');
  fs.writeFileSync(other, 'v');
  r = updateManifest(dir, 's01-shot-01', { action: 'take', path: other, taskId: 'task-aa' });
  let err = null;
  try { appendCatalog(dir, 's01-shot-01', { action: 'take', path: other, taskId: 'task-aa' }, r.manifest, r.createdTakeId, catPath); }
  catch (e) { err = e; }
  assert.ok(err, 'must throw on conflicting path');
  assert.ok(/conflict/i.test(err.message));
  assert.ok(/resolve|inspect|guidance|manual/i.test(err.message), `conflict error must carry recovery guidance: ${err.message}`);
});

test('M0-3b. manifest/catalog selected 冲突提示人工裁决', () => {
  const c = resolveSelectionConflict('s01-shot-01', 'take-A', 'take-B');
  assert.strictEqual(c.length, 1);
  assert.ok(/manual resolve/i.test(c[0]), `must guide manual resolution: ${c[0]}`);
  const rec = recoverTakesFromCatalog('s01-shot-01', [
    { take_id: 'take-001', path: '/tmp/a.mp4', status: 'selected' },
    { take_id: 'take-002', path: '/tmp/b.mp4', status: 'selected' }
  ]);
  assert.ok(rec.conflicts.some(x => /manual resolve/i.test(x)), `recovery conflict must guide manual resolution: ${rec.conflicts.join(' | ')}`);
});

// ============================================================
// [M1-A] Ratio two-level convergence
// ============================================================

test('A1a. resolveEpisodeRatio: series 兜底', () => {
  assert.strictEqual(resolveEpisodeRatio({}, { seedance_defaults: { ratio: '9:16' } }), '9:16');
});

test('A1b. resolveEpisodeRatio: episode 覆盖 series', () => {
  assert.strictEqual(resolveEpisodeRatio({ defaults: { ratio: '4:3' } }, { seedance_defaults: { ratio: '9:16' } }), '4:3');
});

test('A1c. resolveEpisodeRatio: 两者皆无 → 16:9', () => {
  assert.strictEqual(resolveEpisodeRatio({}, {}), '16:9');
});

test('A1d. resolveShotRatio: shot 覆盖 episode', () => {
  assert.strictEqual(resolveShotRatio({ ratio: '9:16' }, '16:9'), '9:16');
  assert.strictEqual(resolveShotRatio({}, '16:9'), '16:9');
});

test('A2a. shot ratio ≠ episode ratio 且无逃生门 → build-manifest 报错退出(含指引)', () => {
  const dir = mkTempDir();
  fs.writeFileSync(path.join(dir, 'script.yaml'), ratioScriptWithShotRatio("'9:16'"));
  const r = runBuildManifest(dir);
  assert.notStrictEqual(r.status, 0, 'mixed ratio must fail the build');
  const out = r.stdout + r.stderr;
  assert.ok(out.includes('allow_mixed_ratio'), `error must mention allow_mixed_ratio: ${out}`);
  assert.ok(out.includes('s01-shot-01'), `error must list violating shot: ${out}`);
  assert.ok(!fs.existsSync(path.join(dir, 'manifest.json')), 'no manifest written on ratio violation');
});

test('A2b. allow_mixed_ratio: true → 混合放行,该 shot 用实际 ratio', () => {
  const dir = mkTempDir();
  fs.writeFileSync(path.join(dir, 'script.yaml'), ratioScriptWithShotRatio("'9:16'", ['allow_mixed_ratio: true']));
  const r = runBuildManifest(dir);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  const m = readManifest(dir);
  assert.strictEqual(m.shots[0].ratio, '9:16');
});

test('A2c. 冗余同值 shot ratio 允许(等于 episode ratio)', () => {
  const dir = mkTempDir();
  fs.writeFileSync(path.join(dir, 'script.yaml'), ratioScriptWithShotRatio("'16:9'"));
  const r = runBuildManifest(dir);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.strictEqual(readManifest(dir).shots[0].ratio, '16:9');
});

test('A4. 现有 16:9 episode 重建 input_hash 不变(与旧逻辑一致)', () => {
  const dir = mkTempDir();
  fs.writeFileSync(path.join(dir, 'script.yaml'), M0_SCRIPT);
  assert.strictEqual(runBuildManifest(dir).status, 0);
  const h1 = readManifest(dir).shots[0].input_hash;
  assert.strictEqual(runBuildManifest(dir).status, 0);
  const h2 = readManifest(dir).shots[0].input_hash;
  assert.strictEqual(h1, h2, 'ratio resolution must not change legacy 16:9 hashes');
  // 解析结果 = 旧逻辑 shot.ratio || defaults.ratio || '16:9'
  const script = { defaults: { ratio: '16:9' } };
  assert.strictEqual(resolveShotRatio({}, resolveEpisodeRatio(script, {})), '16:9');
});

test('A5. 9:16 模板存在、可被 yaml 解析、含竖屏安全区说明', () => {
  const { loadYaml } = require('../build-prompt');
  const tplPath = path.join(ROOT, 'templates', 'episode-script-9x16.template.yaml');
  assert.ok(fs.existsSync(tplPath), '9:16 template must exist');
  const raw = fs.readFileSync(tplPath, 'utf8');
  assert.ok(/15%/.test(raw), 'template must document the 15% safe area');
  assert.ok(/竖屏|safe area|安全区/.test(raw), 'template must document portrait safe area');
  const tpl = loadYaml(tplPath);
  assert.strictEqual(tpl.defaults.ratio, '9:16');
});

// ============================================================
// [M1-B] Task state model + uniqueness
// ============================================================

test('B1a. active/terminal 状态集合写死', () => {
  assert.deepStrictEqual(ACTIVE_TASK_STATUSES, ['queued', 'submitted', 'running', 'retry_wait']);
  assert.deepStrictEqual(TERMINAL_TASK_STATUSES, ['succeeded', 'failed', 'cancelled', 'superseded', 'blocked']);
});

test('B1b. 旧状态名归一化(completed→succeeded, obsolete→superseded)', () => {
  assert.strictEqual(normalizeTaskStatus('completed'), 'succeeded');
  assert.strictEqual(normalizeTaskStatus('obsolete'), 'superseded');
  assert.strictEqual(normalizeTaskStatus('submitted'), 'submitted');
  assert.strictEqual(normalizeTaskStatus('blocked'), 'blocked');
});

test('B2. input_hash 变化 → 旧 active task 移出调度集合(superseded_at)且仅有 1 条可调度', () => {
  const dir = mkTempDir();
  const img = path.join(dir, 'ref.jpg');
  fs.writeFileSync(img, 'x');
  const shot = shotBase('s01-shot-01', { image_paths: [img] });
  shot.input_hash = hashForShot(shot);
  writeManifest(dir, { episode: 'TEST', shots: [shot] });
  const r1 = createRenderTask(dir);
  const m = readManifest(dir); m.shots[0].prompt_final_en = 'p2'; m.shots[0].input_hash = hashForShot(m.shots[0]); writeManifest(dir, m);
  const r2 = createRenderTask(dir);
  assert.notStrictEqual(r2.task.task_id, r1.task.task_id);
  const m2 = readManifest(dir);
  const oldT = m2.render_tasks.find(t => t.task_id === r1.task.task_id);
  assert.ok(oldT.superseded_at, 'old task is moved out of the dispatch set via superseded_at');
  const active = m2.render_tasks.filter(t => isActiveTaskStatus(t.status) && !isTaskSuperseded(t) && t.shot_id === 's01-shot-01');
  assert.strictEqual(active.length, 1, 'at most one dispatchable active task for (shot, stage, input_hash)');
  assert.strictEqual(active[0].stage, 'video');
});

test('B2b. 同 input_hash 幂等复用(不新增 task)', () => {
  const dir = mkTempDir();
  const img = path.join(dir, 'ref.jpg');
  fs.writeFileSync(img, 'x');
  const shot = shotBase('s01-shot-01', { image_paths: [img] });
  shot.input_hash = hashForShot(shot);
  writeManifest(dir, { episode: 'TEST', shots: [shot] });
  const r1 = createRenderTask(dir);
  const r2 = createRenderTask(dir);
  assert.strictEqual(r2.task.task_id, r1.task.task_id);
  assert.strictEqual(readManifest(dir).render_tasks.length, 1);
});

test('B4. deriveStatus: prevStatus=blocked → 保持 blocked', () => {
  const { status } = deriveStatus({ input_hash: 'h1', prev_hash: 'p' }, 'h1', 'blocked');
  assert.strictEqual(status, 'blocked');
});

// ============================================================
// [M1-C] Attempt event stream
// ============================================================

test('C2a. 分类:内置正则表 transient', () => {
  assert.strictEqual(classifyError('429 Too Many Requests').kind, 'transient');
  assert.strictEqual(classifyError('request timed out').kind, 'transient');
  assert.strictEqual(classifyError('503 Service Unavailable').kind, 'transient');
  assert.strictEqual(classifyError('temporarily unavailable').kind, 'transient');
});

test('C2b. 分类:hard 正则', () => {
  assert.strictEqual(classifyError('content policy violation').kind, 'hard');
  assert.strictEqual(classifyError('unsafe content detected').kind, 'hard');
  assert.strictEqual(classifyError('invalid parameter').kind, 'hard');
});

test('C2c. 人工覆盖记 kind_source=manual', () => {
  assert.deepStrictEqual(classifyError('whatever', 'transient'), { kind: 'transient', source: 'manual' });
  assert.deepStrictEqual(classifyError('whatever', 'hard'), { kind: 'hard', source: 'manual' });
  assert.strictEqual(classifyError('429', null).source, 'auto');
});

test('C2d. appendTaskEvent 按 (task_id, n) 幂等', () => {
  const events = [];
  assert.strictEqual(appendTaskEvent(events, { task_id: 't', n: 1, kind: 'hard' }).appended, true);
  assert.strictEqual(appendTaskEvent(events, { task_id: 't', n: 1, kind: 'transient' }).appended, false);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].kind, 'hard', 'first write wins');
});

test('C2e. retry_after 指数序列 60/120/240/480/900 封顶', () => {
  assert.deepStrictEqual([1, 2, 3, 4, 5, 6, 7].map(computeRetryDelay), [60, 120, 240, 480, 900, 900, 900]);
});

test('C2f. mark-shot --failed --task 查无 → 报错(不得重发/新建)', () => {
  const dir = seedTaskDir();
  throws(() => updateManifest(dir, 's01-shot-01', { action: 'failed', taskId: 'task-nope', error: 'x' }), 'not found');
});

test('C2g. transient 失败 → 事件追加 + task retry_wait + retry_after', () => {
  const dir = seedTaskDir();
  const { manifest } = updateManifest(dir, 's01-shot-01', { action: 'failed', taskId: 'task-x', error: '429 rate limit' });
  assert.strictEqual(manifest.task_events.length, 1);
  const ev = manifest.task_events[0];
  assert.strictEqual(ev.kind, 'transient');
  assert.strictEqual(ev.kind_source, 'auto');
  assert.strictEqual(ev.n, 1);
  assert.strictEqual(ev.task_id, 'task-x');
  assert.strictEqual(ev.shot_id, 's01-shot-01');
  assert.strictEqual(ev.stage, 'video');
  assert.strictEqual(ev.epoch, 0);
  assert.ok(ev.at && ev.retry_after, 'event must carry at + retry_after timestamps');
  assert.strictEqual(manifest.render_tasks[0].status, 'retry_wait');
  assert.ok(manifest.render_tasks[0].retry_after);
});

test('C2h. hard 失败 → retry_wait(与 transient 一样先累计,不立即终态)', () => {
  const dir = seedTaskDir();
  const { manifest } = updateManifest(dir, 's01-shot-01', { action: 'failed', taskId: 'task-x', error: 'content policy violation' });
  assert.strictEqual(manifest.task_events[0].kind, 'hard');
  assert.strictEqual(manifest.render_tasks[0].status, 'retry_wait');
  assert.ok(manifest.render_tasks[0].retry_after, 'hard failure also schedules a retry window');
  assert.ok(/^att-/.test(manifest.task_events[0].attempt_id || ''), 'attempt event carries attempt_id');
});

test('C2i. 人工覆盖 --hard 写 kind_source=manual', () => {
  const dir = seedTaskDir();
  const { manifest } = updateManifest(dir, 's01-shot-01', { action: 'failed', taskId: 'task-x', error: 'unknown glitch', kindOverride: 'hard' });
  assert.strictEqual(manifest.task_events[0].kind, 'hard');
  assert.strictEqual(manifest.task_events[0].kind_source, 'manual');
});

test('C3. countAttempts / failedTaskCycles 纯函数', () => {
  const evs = [
    { task_id: 't', shot_id: 's', kind: 'hard', epoch: 0 },
    { task_id: 't', shot_id: 's', kind: 'transient', epoch: 0 },
    { task_id: 't', shot_id: 's', kind: 'callback_received', late: true, epoch: 0 }
  ];
  assert.strictEqual(countAttempts(evs, { task_id: 't' }), 2, 'attempts exclude callback_received');
  assert.strictEqual(countAttempts(evs, { task_id: 't', kind: 'hard' }), 1);
  assert.strictEqual(countAttempts(evs, { shot_id: 's', epoch: 0 }), 2);
  assert.strictEqual(countAttempts(evs, { shot_id: 's', epoch: 1 }), 0);
  const cycles = failedTaskCycles([
    { shot_id: 'a', status: 'failed' }, { shot_id: 'a', status: 'completed' },
    { shot_id: 'a', status: 'failed' }, { shot_id: 'b', status: 'failed' }
  ]);
  assert.strictEqual(cycles.a, 2);
  assert.strictEqual(cycles.b, 1);
});

test('C1. build-manifest 重建保留 task_events + render_tasks', () => {
  const dir = mkTempDir();
  fs.writeFileSync(path.join(dir, 'script.yaml'), M0_SCRIPT);
  writeManifest(dir, {
    episode: 'M0TEST',
    render_tasks: [{ task_id: 'task-x', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: 'h1', status: 'submitted', stage: 'video' }],
    task_events: [{ task_id: 'task-x', shot_id: 's01-shot-01', stage: 'video', n: 1, kind: 'transient', error: '429', at: 't', retry_after: 'r', epoch: 0 }]
  });
  const r = runBuildManifest(dir);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  const m = readManifest(dir);
  assert.strictEqual(m.task_events.length, 1);
  assert.strictEqual(m.task_events[0].kind, 'transient');
  assert.strictEqual(m.render_tasks.length, 1);
});

test('C4. late callback 追加 callback_received {late:true} 事件', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'late.mp4');
  fs.writeFileSync(vfile, 'v');
  writeManifest(dir, { episode: 'TEST',
    render_tasks: [{ task_id: 'task-old', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: 'h1', status: 'superseded', stage: 'video' }],
    shots: [shotBase('s01-shot-01', { input_hash: 'h2', breaker_epoch: 0 })] });
  const { manifest } = updateManifest(dir, 's01-shot-01', { action: 'take', path: vfile, taskId: 'task-old' });
  const ev = (manifest.task_events || []).find(e => e.kind === 'callback_received');
  assert.ok(ev, 'late callback must be recorded in task_events');
  assert.strictEqual(ev.late, true);
  assert.strictEqual(ev.task_id, 'task-old');
  assert.strictEqual(ev.n, 1);
  assert.strictEqual(ev.epoch, 0);
});

// ============================================================
// [M1-D] Breaker three dimensions + breaker_epoch
// ============================================================

test('D1a. 同一 task 连续 3 次 hard → retry_wait / retry_wait / blocked(中途不 failed)', () => {
  const dir = seedTaskDir();
  const r1 = updateManifest(dir, 's01-shot-01', { action: 'failed', taskId: 'task-x', error: 'content policy', kindOverride: 'hard', attemptN: 1 });
  assert.strictEqual(r1.manifest.render_tasks[0].status, 'retry_wait', '1st hard stays retry_wait (not failed)');
  const r2 = updateManifest(dir, 's01-shot-01', { action: 'failed', taskId: 'task-x', error: 'content policy', kindOverride: 'hard', attemptN: 2 });
  assert.strictEqual(r2.manifest.render_tasks[0].status, 'retry_wait', '2nd hard stays retry_wait (not failed)');
  assert.notStrictEqual(r2.manifest.shots[0].status, 'blocked');
  const r3 = updateManifest(dir, 's01-shot-01', { action: 'failed', taskId: 'task-x', error: 'content policy', kindOverride: 'hard', attemptN: 3 });
  assert.strictEqual(r3.manifest.shots[0].status, 'blocked', '3rd hard trips dimension 1');
  assert.strictEqual(normalizeTaskStatus(r3.manifest.render_tasks[0].status), 'blocked');
  assert.ok(/hard_attempts/.test(r3.manifest.shots[0].blocked_reason), `blocked_reason: ${r3.manifest.shots[0].blocked_reason}`);
});

test('D1b. 10 次 transient(无 hard)→ blocked', () => {
  const dir = seedTaskDir();
  for (let i = 0; i < 9; i++) updateManifest(dir, 's01-shot-01', { action: 'failed', taskId: 'task-x', error: '429 rate limit' });
  const m9 = readManifest(dir);
  assert.notStrictEqual(m9.shots[0].status, 'blocked');
  assert.strictEqual(m9.render_tasks[0].status, 'retry_wait');
  const { manifest } = updateManifest(dir, 's01-shot-01', { action: 'failed', taskId: 'task-x', error: '429 rate limit' });
  assert.strictEqual(manifest.shots[0].status, 'blocked');
  assert.ok(/transient/.test(manifest.shots[0].blocked_reason));
});

test('D1c. 5 个不同 input_hash 的 hard-failure 任务快照 → blocked(第三维)', () => {
  const dir = mkTempDir();
  const tasks = [];
  const events = [];
  for (let i = 0; i < 5; i++) {
    tasks.push({ task_id: `task-f${i}`, shot_id: 's01-shot-01', take_id: `take-00${i + 1}`, input_hash: `h${i + 1}`, status: 'retry_wait', stage: 'video', breaker_epoch: 0 });
    events.push({ task_id: `task-f${i}`, shot_id: 's01-shot-01', stage: 'video', input_hash: `h${i + 1}`, n: 1, kind: 'hard', error: 'e', at: 't', retry_after: null, epoch: 0 });
  }
  tasks.push({ task_id: 'task-active', shot_id: 's01-shot-01', take_id: 'take-099', input_hash: 'hcur', status: 'submitted', stage: 'video', breaker_epoch: 0 });
  writeManifest(dir, { episode: 'TEST', render_tasks: tasks, task_events: events, shots: [shotBase('s01-shot-01', { input_hash: 'hcur', breaker_epoch: 0 })] });
  const { manifest } = updateManifest(dir, 's01-shot-01', { action: 'failed', taskId: 'task-active', error: 'content policy', kindOverride: 'hard' });
  assert.strictEqual(manifest.shots[0].status, 'blocked');
  assert.ok(/hard_failure_tasks/.test(manifest.shots[0].blocked_reason), `reason: ${manifest.shots[0].blocked_reason}`);
});

test('D1d. 同 input_hash 跨任务快照累计 hard attempts → blocked(PRD “同 task(同 input_hash)”)', () => {
  const dir = mkTempDir();
  writeManifest(dir, { episode: 'TEST',
    render_tasks: [
      { task_id: 'task-a', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: 'h1', status: 'failed', stage: 'video', breaker_epoch: 0 },
      { task_id: 'task-b', shot_id: 's01-shot-01', take_id: 'take-002', input_hash: 'h1', status: 'failed', stage: 'video', breaker_epoch: 0 },
      { task_id: 'task-c', shot_id: 's01-shot-01', take_id: 'take-003', input_hash: 'h1', status: 'submitted', stage: 'video', breaker_epoch: 0 }
    ],
    task_events: [
      { task_id: 'task-a', shot_id: 's01-shot-01', stage: 'video', input_hash: 'h1', n: 1, kind: 'hard', error: 'e', at: 't', retry_after: null, epoch: 0 },
      { task_id: 'task-b', shot_id: 's01-shot-01', stage: 'video', input_hash: 'h1', n: 1, kind: 'hard', error: 'e', at: 't', retry_after: null, epoch: 0 }
    ],
    shots: [shotBase('s01-shot-01', { input_hash: 'h1', breaker_epoch: 0 })] });
  const { manifest } = updateManifest(dir, 's01-shot-01', { action: 'failed', taskId: 'task-c', error: 'content policy', kindOverride: 'hard' });
  assert.strictEqual(manifest.shots[0].status, 'blocked', 'hard attempts must accumulate per (shot,stage,input_hash) across recreated task snapshots');
  assert.ok(/hard_attempts/.test(manifest.shots[0].blocked_reason), `reason: ${manifest.shots[0].blocked_reason}`);
});

test('D1e. 换 input_hash 后维度 1/2 窗口清零(单任务窗口);attempt 事件记录 input_hash', () => {
  const dir = mkTempDir();
  writeManifest(dir, { episode: 'TEST',
    render_tasks: [
      { task_id: 'task-old', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: 'h1', status: 'failed', stage: 'video', breaker_epoch: 0 },
      { task_id: 'task-new', shot_id: 's01-shot-01', take_id: 'take-002', input_hash: 'h2', status: 'submitted', stage: 'video', breaker_epoch: 0 }
    ],
    task_events: [
      { task_id: 'task-old', shot_id: 's01-shot-01', stage: 'video', input_hash: 'h1', n: 1, kind: 'hard', error: 'e', at: 't', retry_after: null, epoch: 0 },
      { task_id: 'task-old', shot_id: 's01-shot-01', stage: 'video', input_hash: 'h1', n: 2, kind: 'hard', error: 'e', at: 't', retry_after: null, epoch: 0 }
    ],
    shots: [shotBase('s01-shot-01', { input_hash: 'h2', breaker_epoch: 0 })] });
  const { manifest } = updateManifest(dir, 's01-shot-01', { action: 'failed', taskId: 'task-new', error: 'content policy', kindOverride: 'hard' });
  assert.notStrictEqual(manifest.shots[0].status, 'blocked', 'per-input_hash hard window must reset on new input_hash');
  const ev = manifest.task_events.find(e => e.task_id === 'task-new' && e.kind === 'hard');
  assert.ok(ev, 'attempt event must exist');
  assert.strictEqual(ev.input_hash, 'h2', 'attempt events must record input_hash for windowed counting');
});

test('D1f. 同 input_hash 跨任务快照 transient attempts 累计到 10 → blocked', () => {
  const dir = mkTempDir();
  const renderTasks = [];
  const taskEvents = [];
  // task-a: 5 transient; task-b: 4 transient; task-c 当前提交第 10 次
  for (let i = 0; i < 5; i++) taskEvents.push({ task_id: 'task-a', shot_id: 's01-shot-01', stage: 'video', input_hash: 'h1', n: i + 1, kind: 'transient', error: '429', at: 't', retry_after: null, epoch: 0 });
  for (let i = 0; i < 4; i++) taskEvents.push({ task_id: 'task-b', shot_id: 's01-shot-01', stage: 'video', input_hash: 'h1', n: i + 1, kind: 'transient', error: '429', at: 't', retry_after: null, epoch: 0 });
  renderTasks.push({ task_id: 'task-a', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: 'h1', status: 'retry_wait', stage: 'video', breaker_epoch: 0 });
  renderTasks.push({ task_id: 'task-b', shot_id: 's01-shot-01', take_id: 'take-002', input_hash: 'h1', status: 'retry_wait', stage: 'video', breaker_epoch: 0 });
  renderTasks.push({ task_id: 'task-c', shot_id: 's01-shot-01', take_id: 'take-003', input_hash: 'h1', status: 'submitted', stage: 'video', breaker_epoch: 0 });
  writeManifest(dir, { episode: 'TEST', render_tasks: renderTasks, task_events: taskEvents, shots: [shotBase('s01-shot-01', { input_hash: 'h1', breaker_epoch: 0 })] });
  const { manifest } = updateManifest(dir, 's01-shot-01', { action: 'failed', taskId: 'task-c', error: '429 rate limit' });
  assert.strictEqual(manifest.shots[0].status, 'blocked');
  assert.ok(/transient_attempts/.test(manifest.shots[0].blocked_reason), `reason: ${manifest.shots[0].blocked_reason}`);
});

test('D2/D3. blocked_reason 含维度与计数;事件窗口受 breaker_epoch 约束', () => {
  const shot = { id: 's01-shot-01', breaker_epoch: 0 };
  const task = { task_id: 't', shot_id: 's01-shot-01' };
  const events = [
    { task_id: 't', shot_id: 's01-shot-01', kind: 'hard', epoch: 0 },
    { task_id: 't', shot_id: 's01-shot-01', kind: 'hard', epoch: 0 },
    { task_id: 't', shot_id: 's01-shot-01', kind: 'hard', epoch: 0 },
    { task_id: 't', shot_id: 's01-shot-01', kind: 'hard', epoch: 1 }
  ];
  const v = evaluateBreaker({ task, shot, events, tasks: [] });
  assert.strictEqual(v.blocked, true);
  assert.strictEqual(v.count, 3);
  shot.breaker_epoch = 1;
  assert.strictEqual(evaluateBreaker({ task, shot, events, tasks: [] }).blocked, false, 'epoch 1 window must not see epoch 0 events');
});

test('D4. --unblock:epoch+1、active task 取消、历史事件保留', () => {
  const dir = mkTempDir();
  writeManifest(dir, { episode: 'TEST',
    render_tasks: [
      { task_id: 'task-a', shot_id: 's01-shot-01', status: 'submitted', stage: 'video', breaker_epoch: 0 },
      { task_id: 'task-b', shot_id: 's01-shot-01', status: 'retry_wait', stage: 'video', breaker_epoch: 0 }
    ],
    task_events: [
      { task_id: 'task-a', shot_id: 's01-shot-01', stage: 'video', n: 1, kind: 'hard', error: 'policy', at: 't', retry_after: null, epoch: 0 },
      { task_id: 'task-a', shot_id: 's01-shot-01', stage: 'video', n: 2, kind: 'hard', error: 'policy', at: 't', retry_after: null, epoch: 0 },
      { task_id: 'task-a', shot_id: 's01-shot-01', stage: 'video', n: 3, kind: 'hard', error: 'policy', at: 't', retry_after: null, epoch: 0 }
    ],
    shots: [shotBase('s01-shot-01', { status: 'blocked', blocked_reason: 'hard_attempts count=3 (epoch 0)', breaker_epoch: 0 })] });
  const { manifest } = updateManifest(dir, 's01-shot-01', { action: 'unblock' });
  assert.strictEqual(manifest.shots[0].breaker_epoch, 1);
  assert.notStrictEqual(manifest.shots[0].status, 'blocked');
  assert.strictEqual(manifest.shots[0].blocked_reason, null);
  assert.strictEqual(manifest.render_tasks.find(t => t.task_id === 'task-a').status, 'cancelled');
  assert.strictEqual(manifest.render_tasks.find(t => t.task_id === 'task-b').status, 'cancelled');
  assert.strictEqual(manifest.task_events.length, 3, 'history preserved for audit');
  assert.strictEqual(countAttempts(manifest.task_events, { shot_id: 's01-shot-01', kind: 'hard', epoch: 1 }), 0);
  assert.strictEqual(countAttempts(manifest.task_events, { shot_id: 's01-shot-01', kind: 'hard', epoch: 0 }), 3);
});

test('D5. blocked shot 不进入 render-next 队列', () => {
  const dir = mkTempDir();
  const pending = shotBase('s01-shot-02', { status: 'pending' });
  pending.input_hash = hashForShot(pending);
  writeManifest(dir, { episode: 'TEST', shots: [
    shotBase('s01-shot-01', { status: 'blocked', blocked_reason: 'hard_attempts' }),
    pending
  ] });
  const r = createRenderTask(dir);
  assert.ok(r, 'a pending shot must still be renderable');
  assert.strictEqual(r.shot.id, 's01-shot-02');
});

// ============================================================
// [M1-E] Integration: stitch blocked handling
// ============================================================

test('E1. collectFinalShotProblems 列出 blocked(--final 必须报错)', () => {
  const problems = collectFinalShotProblems({ shots: [
    { id: 's01-shot-01', status: 'blocked' },
    { id: 's01-shot-02', status: 'done' }
  ] });
  assert.ok(problems.some(p => /blocked/.test(p)), `problems: ${problems.join(' | ')}`);
  assert.deepStrictEqual(collectFinalShotProblems({ shots: [{ id: 's01-shot-01', status: 'done' }] }), []);
});

// ============================================================
// [R2] Review fixes batch: P0-1 / P1-1..P1-5 / P2-late
// ============================================================

test('R2-P0-1a. --review accept 打在 superseded take(input 不匹配)→ 抛错且状态不变', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'v.mp4');
  fs.writeFileSync(vfile, 'v');
  writeManifest(dir, { episode: 'TEST', shots: [shotBase('s01-shot-01', { input_hash: 'h2', takes: [
    { id: 'take-001', path: vfile, model: 'M', input_hash: 'h1', status: 'superseded', rendered_at: 't', notes: 'stale callback' }
  ] })] });
  throws(() => updateManifest(dir, 's01-shot-01', { action: 'review', takeId: 'take-001', conclusion: 'accept' }), 'superseded');
  const m = readManifest(dir);
  assert.strictEqual(m.shots[0].takes[0].status, 'superseded');
  assert.strictEqual(m.shots[0].selected_take, null);
  assert.strictEqual(m.shots[0].takes[0].human_review, undefined, 'must not write a review binding');
});

test('R2-P0-1b. validateTake 拒绝 review 绑定与 take 自身 fingerprint 不一致的 accept(防洗白)', () => {
  const shot = shotBase('s01-shot-01', { input_hash: 'h2' });
  const take = { id: 'take-001', status: 'selected', input_hash: 'h1',
    human_review: { conclusion: 'accept', reviewed_input_hash: 'h2', reviewed_at: 'now' } };
  throws(() => validateTake(shot, take), 'inconsistent');
});

test('R2-P0-1c. superseded take 的 fingerprint 复现后,--review accept 允许(人工恢复路径)', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'v.mp4');
  fs.writeFileSync(vfile, 'v');
  writeManifest(dir, { episode: 'TEST', shots: [shotBase('s01-shot-01', { input_hash: 'h1', takes: [
    { id: 'take-001', path: vfile, model: 'M', input_hash: 'h1', status: 'superseded', rendered_at: 't', notes: '' }
  ] })] });
  const { manifest } = updateManifest(dir, 's01-shot-01', { action: 'review', takeId: 'take-001', conclusion: 'accept' });
  assert.strictEqual(manifest.shots[0].takes[0].status, 'selected');
  assert.strictEqual(manifest.shots[0].selected_take, 'take-001');
  validateTake(manifest.shots[0], manifest.shots[0].takes[0]);
});

// ---- R2-P1-1: input_hash 与路径解耦 + canonical JSON ----

test('R2-P1-1a. computeInputHash 与路径无关(同内容不同路径/文件名 → 同 hash)', () => {
  const dirA = mkTempDir();
  const dirB = mkTempDir();
  const a = path.join(dirA, 'reference.png');
  const b = path.join(dirB, 'renamed.jpg');
  fs.writeFileSync(a, 'SAME-CONTENT');
  fs.writeFileSync(b, 'SAME-CONTENT');
  const hA = computeInputHash('p', [a], 8, '16:9', '720p', 'm');
  const hB = computeInputHash('p', [b], 8, '16:9', '720p', 'm');
  assert.strictEqual(hA, hB, 'local path must not enter input_hash (§3.8 exclusion list)');
});

test('R2-P1-1b. 参考图内容变化 → hash 变化', () => {
  const dir = mkTempDir();
  const a = path.join(dir, 'r.png');
  fs.writeFileSync(a, 'X');
  const h1 = computeInputHash('p', [a], 8, '16:9', '720p', 'm');
  fs.writeFileSync(a, 'Y');
  const h2 = computeInputHash('p', [a], 8, '16:9', '720p', 'm');
  assert.notStrictEqual(h1, h2);
});

test('R2-P1-1c. canonicalJson:键排序 + 无空白(§3.8 canonical JSON)', () => {
  assert.strictEqual(canonicalJson({ b: 1, a: { d: 2, c: [1, { z: 1, y: 2 }] } }), '{"a":{"c":[1,{"y":2,"z":1}],"d":2},"b":1}');
  assert.strictEqual(canonicalJson({}), '{}');
  assert.strictEqual(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
});

// ---- R2-P1-2: retry_after 必须被执行 ----

test('R2-P1-2a. retry_wait 未到期不派发;到期后重新提交并计 request', () => {
  const dir = mkTempDir();
  const future = new Date(Date.now() + 120000).toISOString();
  writeManifest(dir, { episode: 'TEST',
    render_tasks: [{ task_id: 'task-r', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: 'h1', status: 'retry_wait', retry_after: future, stage: 'video', breaker_epoch: 0, image_refs: [] }],
    shots: [shotBase('s01-shot-01', { input_hash: 'h1', image_paths: [] })] });
  assert.strictEqual(createRenderTask(dir), null, 'must not dispatch before retry_after');
  const m = readManifest(dir);
  assert.strictEqual(m.render_tasks[0].status, 'retry_wait', 'waiting task must stay retry_wait');
  const r = createRenderTask(dir, { now: Date.parse(future) + 1000 });
  assert.ok(r && r.task, 'due retry must be dispatched');
  assert.strictEqual(r.task.task_id, 'task-r');
  const m2 = readManifest(dir);
  assert.strictEqual(m2.render_tasks[0].status, 'submitted', 'due retry must be re-submitted');
  assert.strictEqual(m2.quota_ledger.stages.video.requests, 1, 're-dispatch is a real provider request');
  assert.strictEqual(m2.quota_ledger.stages.video.cache_hits, 0);
});

test('R2-P1-2b. 等待中的 shot 被跳过,派发下一个可渲染 shot', () => {
  const dir = mkTempDir();
  const future = new Date(Date.now() + 120000).toISOString();
  writeManifest(dir, { episode: 'TEST',
    render_tasks: [{ task_id: 'task-1', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: 'h1', status: 'retry_wait', retry_after: future, stage: 'video', breaker_epoch: 0, image_refs: [] }],
    shots: [
      shotBase('s01-shot-01', { input_hash: 'h1', image_paths: [] }),
      (() => { const s = shotBase('s01-shot-02', { image_paths: [] }); s.input_hash = hashForShot(s); return s; })()
    ] });
  const r = createRenderTask(dir);
  assert.ok(r && r.shot.id === 's01-shot-02', 'must skip waiting shot and dispatch next');
  const m = readManifest(dir);
  assert.strictEqual(m.render_tasks.find(t => t.task_id === 'task-1').status, 'retry_wait');
  assert.ok(m.render_tasks.some(t => t.shot_id === 's01-shot-02' && t.status === 'submitted'));
});

test('R2-P1-2c. --rendering 后 transient 失败 → shot 回到可派发状态,退避到期能重试', () => {
  const dir = mkTempDir();
  writeManifest(dir, { episode: 'TEST',
    render_tasks: [{ task_id: 'task-r', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: 'h1', status: 'submitted', stage: 'video', breaker_epoch: 0, image_refs: [] }],
    shots: [shotBase('s01-shot-01', { input_hash: 'h1', status: 'rendering', image_paths: [] })] });
  const { manifest } = updateManifest(dir, 's01-shot-01', { action: 'failed', taskId: 'task-r', error: '429 rate limit' });
  assert.strictEqual(manifest.render_tasks[0].status, 'retry_wait');
  assert.ok(['pending', 'stale'].includes(manifest.shots[0].status), `shot must become dispatchable again, got ${manifest.shots[0].status}`);
  assert.strictEqual(createRenderTask(dir), null, 'still in backoff — must not dispatch before retry_after');
  const due = Date.parse(manifest.render_tasks[0].retry_after) + 1000;
  const r = createRenderTask(dir, { now: due });
  assert.ok(r && r.task.task_id === 'task-r', 'after backoff the retry must be dispatched');
  assert.strictEqual(readManifest(dir).render_tasks[0].status, 'submitted');
});

// ---- R2-P1-3: --failed 终态守卫 + retries 与事件幂等一致 ----

test('R2-P1-3a. --failed 打在终态 succeeded task → 抛错,事件流与 retries 不变', () => {
  const dir = mkTempDir();
  writeManifest(dir, { episode: 'TEST',
    render_tasks: [{ task_id: 'task-s', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: 'h1', status: 'succeeded', completion: 'normal', stage: 'video', breaker_epoch: 0 }],
    task_events: [],
    shots: [shotBase('s01-shot-01', { input_hash: 'h1', breaker_epoch: 0 })] });
  throws(() => updateManifest(dir, 's01-shot-01', { action: 'failed', taskId: 'task-s', error: 'late failure' }), 'terminal');
  const m = readManifest(dir);
  assert.strictEqual((m.task_events || []).length, 0);
  assert.strictEqual(m.shots[0].retries, 0);
  assert.strictEqual(normalizeTaskStatus(m.render_tasks[0].status), 'succeeded');
});

test('R2-P1-3b. 同一 (task_id,n) 重复上报:事件幂等且 shot.retries 只计一次', () => {
  const dir = mkTempDir();
  writeManifest(dir, { episode: 'TEST',
    render_tasks: [{ task_id: 'task-t', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: 'h1', status: 'submitted', stage: 'video', breaker_epoch: 0 }],
    shots: [shotBase('s01-shot-01', { input_hash: 'h1', breaker_epoch: 0 })] });
  updateManifest(dir, 's01-shot-01', { action: 'failed', taskId: 'task-t', error: '429 rate limit', attemptN: 1 });
  updateManifest(dir, 's01-shot-01', { action: 'failed', taskId: 'task-t', error: '429 rate limit', attemptN: 1 });
  const m = readManifest(dir);
  assert.strictEqual(m.task_events.length, 1, 'event stream must dedupe by (task_id,n)');
  assert.strictEqual(m.shots[0].retries, 1, 'retries must follow appended events (idempotent)');
});

// ---- R2-P1-4: blocked 状态未被 --select / deriveStatus 绕过 ----

test('R2-P1-4a. blocked shot 上 --select / --review accept → 抛错,状态不变', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'v.mp4');
  fs.writeFileSync(vfile, 'v');
  writeManifest(dir, { episode: 'TEST', shots: [shotBase('s01-shot-01', { input_hash: 'h1', status: 'blocked', blocked_reason: 'hard_attempts count=3', takes: [
    { id: 'take-001', path: vfile, model: 'M', input_hash: 'h1', status: 'candidate', rendered_at: 't', notes: '' }
  ] })] });
  throws(() => updateManifest(dir, 's01-shot-01', { action: 'select', takeId: 'take-001' }), 'blocked');
  throws(() => updateManifest(dir, 's01-shot-01', { action: 'review', takeId: 'take-001', conclusion: 'accept' }), 'blocked');
  const m = readManifest(dir);
  assert.strictEqual(m.shots[0].status, 'blocked');
  assert.strictEqual(m.shots[0].selected_take, null);
  assert.strictEqual(m.shots[0].takes[0].status, 'candidate');
});

test('R2-P1-4b. deriveStatus 在 prevStatus=null 时仍保持 shot.status=blocked', () => {
  const shot = { status: 'blocked', input_hash: 'h1', selected_take: null, takes: [] };
  assert.strictEqual(deriveStatus(shot, 'h1', null).status, 'blocked');
});

test('R2-P1-4c. edit-episode 拒绝 blocked shot 进成片(Release Gate #4)', () => {
  const errs = collectBlockedShotErrors({ shots: [
    shotBase('s01-shot-01', { status: 'blocked', blocked_reason: 'hard_attempts count=3' }),
    shotBase('s01-shot-02', { status: 'done' })
  ] });
  assert.strictEqual(errs.length, 1);
  assert.ok(/blocked/.test(errs[0]) && /s01-shot-01/.test(errs[0]), errs.join(' | '));
  assert.ok(/unblock/.test(errs[0]), `must guide --unblock: ${errs[0]}`);
  assert.deepStrictEqual(collectBlockedShotErrors({ shots: [shotBase('s01-shot-02', { status: 'done' })] }), []);
});

// ---- R2-P1-5: tmp 清理不得误删并发写者的 in-flight 文件 ----

test('R2-P1-5a. 存活写者(同 pid)的新鲜 tmp 不被误删(并发安全)', () => {
  const dir = mkTempDir();
  const target = path.join(dir, 'manifest.json');
  atomicWriteJson(target, { v: 1 });
  throws(() => atomicWriteJson(target, { v: 2 }, { fault: 'after-tmp-write' }), 'after-tmp-write');
  readJsonFile(target);
  assert.strictEqual(tmpResidue(dir).length, 1, 'in-flight tmp of a live writer must be kept');
});

test('R2-P1-5b. 已死写者的 tmp 被清理', () => {
  const dir = mkTempDir();
  const target = path.join(dir, 'manifest.json');
  atomicWriteJson(target, { v: 1 });
  const dead = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  fs.writeFileSync(path.join(dir, `.manifest.json.${dead.pid}.${Date.now()}.tmp`), '{}');
  readJsonFile(target);
  assert.deepStrictEqual(tmpResidue(dir), []);
});

test('R2-P1-5c. 超龄 tmp(即使 pid 存活)被清理', () => {
  const dir = mkTempDir();
  const target = path.join(dir, 'manifest.json');
  atomicWriteJson(target, { v: 1 });
  throws(() => atomicWriteJson(target, { v: 2 }, { fault: 'after-tmp-write' }), 'after-tmp-write');
  const tmpPath = path.join(dir, tmpResidue(dir)[0]);
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(tmpPath, old, old);
  readJsonFile(target);
  assert.deepStrictEqual(tmpResidue(dir), []);
});

// ---- R2-P2: completion=late 的状态集合 ----

test('R2-P2-late. running(正常在途)task 的成功回调 → completion=normal,不记 late 事件', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'v.mp4');
  fs.writeFileSync(vfile, 'v');
  writeManifest(dir, { episode: 'TEST',
    render_tasks: [{ task_id: 'task-r', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: 'h1', status: 'running', stage: 'video', breaker_epoch: 0 }],
    shots: [shotBase('s01-shot-01', { input_hash: 'h1' })] });
  const { manifest } = updateManifest(dir, 's01-shot-01', { action: 'take', path: vfile, taskId: 'task-r' });
  const t = manifest.render_tasks[0];
  assert.strictEqual(normalizeTaskStatus(t.status), 'succeeded');
  assert.strictEqual(t.completion, 'normal', 'running callback is on-time, not late');
  assert.ok(!(manifest.task_events || []).some(e => e.kind === 'callback_received'), 'no late callback event');
  assert.strictEqual(manifest.shots[0].takes[0].status, 'candidate');
});

test('R2-P2-e1scenes. E1:distinct scene < 3 → incomplete(不允许同素材凑数)', () => {
  const ds = e1Dataset({ byCluster: () => ({ A: 0.9, B: 0.6, C: 0.6 }), scenes: 2 });
  const r = buildReport(ds, { generated_at: 'T' });
  assert.strictEqual(r.incomplete, true, 'PRD requires >= 3 distinct scenes');
  assert.ok((r.incomplete_reasons || []).some(x => /scene/i.test(x)), (r.incomplete_reasons || []).join(' | '));
});

// ============================================================
// [R3] Review batch 2: P1-N1 + P2-N1/N2/N3/N5
// ============================================================

test('R3-P1-N1. --review accept 拒绝 candidate/selected 但 input 不匹配的 take(写入口同款不变量)', () => {
  for (const status of ['candidate', 'selected']) {
    const dir = mkTempDir();
    const vfile = path.join(dir, 'v.mp4');
    fs.writeFileSync(vfile, 'v');
    writeManifest(dir, { episode: 'TEST', shots: [shotBase('s01-shot-01', { input_hash: 'h2', takes: [
      { id: 'take-001', path: vfile, model: 'M', input_hash: 'h1', status, rendered_at: 't', notes: '' }
    ] })] });
    throws(() => updateManifest(dir, 's01-shot-01', { action: 'review', takeId: 'take-001', conclusion: 'accept' }), 'input');
    const m = readManifest(dir);
    assert.strictEqual(m.shots[0].takes[0].human_review, undefined, `must not write a review binding (${status})`);
    assert.strictEqual(m.shots[0].selected_take, null);
    assert.strictEqual(m.shots[0].status, 'pending');
  }
});

test('R3-N5b. null-hash superseded + --review accept → 抛错(superseded 仅 fingerprint 复现可恢复)', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'v.mp4');
  fs.writeFileSync(vfile, 'v');
  writeManifest(dir, { episode: 'TEST', shots: [shotBase('s01-shot-01', { input_hash: 'h2', takes: [
    { id: 'take-001', path: vfile, model: 'M', input_hash: null, status: 'superseded', rendered_at: 't', notes: '' }
  ] })] });
  throws(() => updateManifest(dir, 's01-shot-01', { action: 'review', takeId: 'take-001', conclusion: 'accept' }), 'superseded');
  assert.strictEqual(readManifest(dir).shots[0].takes[0].human_review, undefined);
});

test('R3-N5a. unblock → select 合法路径(解除后恢复选片)', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'v.mp4');
  fs.writeFileSync(vfile, 'v');
  writeManifest(dir, { episode: 'TEST', shots: [shotBase('s01-shot-01', { input_hash: 'h1', status: 'blocked', blocked_reason: 'hard_attempts count=3', breaker_epoch: 1, takes: [
    { id: 'take-001', path: vfile, model: 'M', input_hash: 'h1', status: 'candidate', rendered_at: 't', notes: '' }
  ] })] });
  const r1 = updateManifest(dir, 's01-shot-01', { action: 'unblock' });
  assert.strictEqual(r1.manifest.shots[0].breaker_epoch, 2);
  assert.strictEqual(r1.manifest.shots[0].status, 'pending');
  assert.strictEqual(r1.manifest.shots[0].blocked_reason, null);
  const r2 = updateManifest(dir, 's01-shot-01', { action: 'select', takeId: 'take-001' });
  assert.strictEqual(r2.manifest.shots[0].selected_take, 'take-001');
  assert.strictEqual(r2.manifest.shots[0].status, 'done');
});

test('R3-N1a. blocked shot 上 --pending / --rendering → 抛错,状态不变', () => {
  const dir = mkTempDir();
  writeManifest(dir, { episode: 'TEST', shots: [shotBase('s01-shot-01', { input_hash: 'h1', status: 'blocked', blocked_reason: 'hard_attempts count=3', breaker_epoch: 1 })] });
  throws(() => updateManifest(dir, 's01-shot-01', { action: 'pending' }), 'blocked');
  throws(() => updateManifest(dir, 's01-shot-01', { action: 'rendering' }), 'blocked');
  const m = readManifest(dir);
  assert.strictEqual(m.shots[0].status, 'blocked');
  assert.strictEqual(m.shots[0].blocked_reason, 'hard_attempts count=3');
  assert.strictEqual(m.shots[0].breaker_epoch, 1, 'bypass must not silently reset the breaker epoch');
});

test('R3-N2b. 重复上报同 (task_id,n):retry_after 不顺延、状态不变', () => {
  const dir = mkTempDir();
  writeManifest(dir, { episode: 'TEST',
    render_tasks: [{ task_id: 'task-t', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: 'h1', status: 'submitted', stage: 'video', breaker_epoch: 0 }],
    shots: [shotBase('s01-shot-01', { input_hash: 'h1', breaker_epoch: 0 })] });
  const r1 = updateManifest(dir, 's01-shot-01', { action: 'failed', taskId: 'task-t', error: '429 rate limit', attemptN: 1 });
  const retry1 = r1.manifest.render_tasks[0].retry_after;
  assert.ok(retry1, 'first report must set retry_after');
  busyWaitMs(15);
  const r2 = updateManifest(dir, 's01-shot-01', { action: 'failed', taskId: 'task-t', error: '429 rate limit', attemptN: 1 });
  assert.strictEqual(r2.manifest.render_tasks[0].retry_after, retry1, 'duplicate must not extend the backoff window');
  assert.strictEqual(r2.manifest.render_tasks[0].status, 'retry_wait');
  assert.strictEqual(r2.manifest.shots[0].retries, 1);
});

test('R3-N3. mark-shot --done 的 input_hash 带 schema_version(schema 2 集一致)', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'v.mp4');
  fs.writeFileSync(vfile, 'v');
  const base = shotBase('s01-shot-01', { input_hash: 'old', status: 'stale' });
  writeManifest(dir, { episode: 'TEST', schema_version: 2, shots: [base] });
  const { manifest } = updateManifest(dir, 's01-shot-01', { action: 'done', path: vfile });
  const expected = computeInputHash(base.prompt_final_en, base.image_paths || [], base.duration, base.ratio, base.resolution, base.model, { schemaVersion: 2 });
  assert.strictEqual(manifest.shots[0].takes[0].input_hash, expected, '--done must hash with the episode schema_version');
});

test('R3-N5c. retry_after 不可解析 → fail-open 可派发(不永久卡死)', () => {
  const dir = mkTempDir();
  writeManifest(dir, { episode: 'TEST',
    render_tasks: [{ task_id: 'task-r', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: 'h1', status: 'retry_wait', retry_after: 'not-a-date', stage: 'video', breaker_epoch: 0, image_refs: [] }],
    shots: [shotBase('s01-shot-01', { input_hash: 'h1', image_paths: [] })] });
  const r = createRenderTask(dir);
  assert.ok(r && r.task.task_id === 'task-r', 'unparseable retry_after must not stall the pipeline forever');
  assert.strictEqual(readManifest(dir).render_tasks[0].status, 'submitted');
});


// ============================================================
// [M2-MG] Migrate episode schema 1->2
// ============================================================

test('MG1. 等值 shot ratio → 删除覆盖;其余字段/注释保留;script+manifest+catalog 写 schema 2', () => {
  const script = mgBaseScript(["        ratio: '16:9'   # redundant shot ratio", "        prompt_en: 'a'"]);
  const dir = mgEpisode({ script, catalog: [
    { episode: 'MGTEST', shot_id: 's01-shot-01', take_id: 'take-001', path: 'take-001.mp4', status: 'selected' }
  ] });
  const res = mgMigrate(dir);
  assert.deepStrictEqual(res.errors, []);
  assert.strictEqual(res.from, 1);
  assert.strictEqual(res.to, 2);
  assert.ok(res.changed.length > 0);
  const raw = fs.readFileSync(path.join(dir, 'script.yaml'), 'utf8');
  assert.ok(!/ratio:/.test(raw.split('scenes:')[1] || ''), `shot ratio override must be removed:\n${raw}`);
  assert.ok(raw.includes('episode ratio inline comment'), 'episode ratio inline comment preserved');
  assert.ok(raw.includes('# MG header comment'), 'header comment preserved');
  assert.ok(raw.includes("prompt_en: 'a'"), 'other shot fields preserved');
  assert.ok(fs.existsSync(path.join(dir, 'script.yaml.bak')), 'structural edit writes .bak');
  const m = readManifest(dir);
  assert.strictEqual(m.schema_version, 2);
  assert.strictEqual(m.require_keyframe, false);
  assert.strictEqual(m.shots[0].takes[0].stage, 'video');
  assert.strictEqual(m.render_tasks[0].stage, 'video');
  const cat = JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8'));
  assert.strictEqual(cat[0].stage, 'video');
});

test('MG2. 异值 shot ratio 且无 allow_mixed_ratio → 报错列出 shot,文件零改动', () => {
  const script = mgBaseScript(["        ratio: '9:16'", "        prompt_en: 'a'"]);
  const dir = mgEpisode({ script, catalog: [] });
  const before = mgSnapshot(dir);
  const res = mgMigrate(dir);
  assert.ok(res.errors.length >= 1, JSON.stringify(res));
  const joined = res.errors.join('\n');
  assert.ok(joined.includes('s01-shot-01'), joined);
  assert.ok(joined.includes('allow_mixed_ratio'), joined);
  assert.strictEqual(res.changed.length, 0);
  assert.deepStrictEqual(mgSnapshot(dir), before, 'no file may change on ratio error');
  assert.ok(!fs.existsSync(path.join(dir, 'script.yaml.bak')), 'no backup on aborted migration');
});

test('MG3. allow_mixed_ratio: true → 异值 ratio 保留,迁移成功', () => {
  const script = mgBaseScript(["        ratio: '9:16'", "        prompt_en: 'a'"], ['allow_mixed_ratio: true']);
  const dir = mgEpisode({ script, catalog: [] });
  const res = mgMigrate(dir);
  assert.deepStrictEqual(res.errors, []);
  const raw = fs.readFileSync(path.join(dir, 'script.yaml'), 'utf8');
  assert.ok(raw.includes("ratio: '9:16'"), 'mixed ratio kept');
  assert.strictEqual(readManifest(dir).schema_version, 2);
});

test('MG4. 注释保护:仅补顶层标量,文本级插入不重排其他内容', () => {
  const dir = mgEpisode({ catalog: [] });
  const raw0 = fs.readFileSync(path.join(dir, 'script.yaml'), 'utf8');
  const res = mgMigrate(dir);
  assert.deepStrictEqual(res.errors, []);
  const raw1 = fs.readFileSync(path.join(dir, 'script.yaml'), 'utf8');
  const lines0 = raw0.split('\n');
  const lines1 = raw1.split('\n');
  for (const line of lines0.filter(l => l.trim())) {
    assert.ok(lines1.includes(line), `original line preserved: ${line}`);
  }
  const inserted = lines1.filter(l => !lines0.includes(l));
  assert.deepStrictEqual(inserted.slice().sort(), ['require_keyframe: false', 'schema_version: 2'].sort());
  assert.ok(raw1.indexOf('episode: MGTEST') < raw1.indexOf('scenes:'), 'order preserved');
  assert.ok(raw1.includes('# shot inline comment'), 'shot inline comment preserved');
  assert.ok(!fs.existsSync(path.join(dir, 'script.yaml.bak')), 'scalar-only edit does not need .bak');
});

test('MG5. manifest take/render_task 缺 stage → video;已有 stage 不覆盖', () => {
  const dir = mkTempDir();
  fs.writeFileSync(path.join(dir, 'script.yaml'), mgBaseScript());
  writeManifest(dir, {
    episode: 'MGTEST',
    shots: [
      shotBase('s01-shot-01', { takes: [{ id: 't1' }, { id: 't2', stage: 'keyframe' }] }),
      shotBase('s01-shot-02', { takes: [{ id: 't3', stage: 'keyframe' }] })
    ],
    render_tasks: [
      { task_id: 'r1', shot_id: 's01-shot-01' },
      { task_id: 'r2', shot_id: 's01-shot-02', stage: 'keyframe' }
    ]
  });
  const res = mgMigrate(dir);
  assert.deepStrictEqual(res.errors, []);
  const m = readManifest(dir);
  assert.strictEqual(m.shots[0].takes[0].stage, 'video');
  assert.strictEqual(m.shots[0].takes[1].stage, 'keyframe');
  assert.strictEqual(m.shots[1].takes[0].stage, 'keyframe');
  assert.strictEqual(m.render_tasks[0].stage, 'video');
  assert.strictEqual(m.render_tasks[1].stage, 'keyframe');
});

test('MG6a. catalog 仅本 episode 条目补 stage,其他 episode 原样', () => {
  const dir = mgEpisode({ catalog: [
    { episode: 'MGTEST', shot_id: 'a', take_id: 't', path: 'a.mp4' },
    { episode: 'MGTEST', shot_id: 'b', take_id: 't', path: 'b.mp4', stage: 'keyframe' },
    { episode: 'OTHER', shot_id: 'c', take_id: 't', path: 'c.mp4' }
  ] });
  const res = mgMigrate(dir);
  assert.deepStrictEqual(res.errors, []);
  const cat = JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8'));
  assert.strictEqual(cat[0].stage, 'video');
  assert.strictEqual(cat[1].stage, 'keyframe');
  assert.ok(!('stage' in cat[2]), 'other episode untouched');
});

test('MG6b. catalog 缺失 → 跳过并 warning(不报错)', () => {
  const dir = mgEpisode({ catalog: undefined }); // no catalog.json
  const res = mgMigrate(dir);
  assert.deepStrictEqual(res.errors, []);
  assert.ok(res.warnings.some(w => /catalog/i.test(w)), JSON.stringify(res.warnings));
  assert.strictEqual(readManifest(dir).schema_version, 2, 'manifest still migrated');
});

test('MG7. 幂等:第二次迁移 changed=[] 且文件字节不变', () => {
  const dir = mgEpisode({ catalog: [{ episode: 'MGTEST', shot_id: 's01-shot-01', take_id: 'take-001', path: 'x.mp4' }] });
  const first = mgMigrate(dir);
  assert.ok(first.changed.length > 0);
  const snap = mgSnapshot(dir);
  const second = mgMigrate(dir);
  assert.deepStrictEqual(second.changed, []);
  assert.deepStrictEqual(second.errors, []);
  assert.deepStrictEqual(mgSnapshot(dir), snap, 'second run must not touch files');
});

test('MG8. --dry-run 报告变更但文件零改动', () => {
  const dir = mgEpisode({ catalog: [{ episode: 'MGTEST', shot_id: 's01-shot-01', take_id: 'take-001', path: 'x.mp4' }] });
  const before = mgSnapshot(dir);
  const res = mgMigrate(dir, { dryRun: true });
  assert.ok(res.changed.length > 0, 'dry-run must report planned changes');
  assert.deepStrictEqual(res.errors, []);
  assert.deepStrictEqual(mgSnapshot(dir), before, 'dry-run must not write');
  assert.ok(!fs.existsSync(path.join(dir, 'script.yaml.bak')));
});

test('MG9. 已是 v2 → no-op(changed=[],文件不变)', () => {
  const script = mgBaseScript(undefined, ['schema_version: 2', 'require_keyframe: false']);
  const dir = mkTempDir();
  fs.writeFileSync(path.join(dir, 'script.yaml'), script);
  const m = mgDefaultManifest(dir);
  m.schema_version = 2;
  m.require_keyframe = false;
  writeManifest(dir, m);
  const before = mgSnapshot(dir);
  const res = mgMigrate(dir);
  assert.strictEqual(res.from, 2);
  assert.deepStrictEqual(res.changed, []);
  assert.deepStrictEqual(res.errors, []);
  assert.deepStrictEqual(mgSnapshot(dir), before);
});

test('MG10a. 封面报告:有 selected video take → notes 提示取该 take 首帧', () => {
  const dir = mgEpisode({ catalog: [] });
  const res = mgMigrate(dir);
  assert.ok(res.notes.some(n => /cover/i.test(n) && /head frame/i.test(n)), JSON.stringify(res.notes));
});

test('MG10b. 封面报告:无 selected take → notes 警告 final 封面会报错', () => {
  const dir = mkTempDir();
  fs.writeFileSync(path.join(dir, 'script.yaml'), mgBaseScript());
  writeManifest(dir, { episode: 'MGTEST', shots: [
    shotBase('s01-shot-01', { takes: [{ id: 't1', status: 'candidate' }], selected_take: null })
  ] });
  const res = mgMigrate(dir);
  assert.ok(res.notes.some(n => /cover/i.test(n) && /no selected video take|select a .*take/i.test(n)), JSON.stringify(res.notes));
});

test('MG11. 集成:build-manifest 重建后 manifest 含 schema_version/require_keyframe', () => {
  const dir = mkTempDir();
  fs.writeFileSync(path.join(dir, 'script.yaml'), M0_SCRIPT);
  const r = runBuildManifest(dir);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  const m = readManifest(dir);
  assert.ok('schema_version' in m, 'manifest must carry schema_version');
  assert.ok('require_keyframe' in m, 'manifest must carry require_keyframe');
  assert.strictEqual(m.schema_version, 1);
  assert.strictEqual(m.require_keyframe, false);
});

test('MG12. schemaFinalNotice:v1 提示语、v2 空;stitch 导出同一函数', () => {
  const v1Msg = 'v1 final semantics applied. Run migrate-episode --to 2 to adopt v2 publishing requirements.';
  assert.strictEqual(schemaFinalNotice({}), v1Msg);
  assert.strictEqual(schemaFinalNotice({ schema_version: 1 }), v1Msg);
  assert.strictEqual(schemaFinalNotice({ schema_version: 2 }), '');
  assert.strictEqual(schemaFinalNotice(null), v1Msg);
  assert.strictEqual(schemaFinalNoticeFromStitch({ schema_version: 1 }), v1Msg);
  assert.strictEqual(schemaFinalNoticeFromStitch({ schema_version: 2 }), '');
});

test('MG13. migrateScriptData 纯函数(不改入参)+ 等值删除 / 异值报错', () => {
  const script = { episode: 'T', allow_mixed_ratio: false, scenes: [{ id: 's01', shots: [
    { id: 'a', ratio: '16:9' }, { id: 'b', ratio: '9:16' }
  ] }] };
  const original = JSON.parse(JSON.stringify(script));
  const bad = migrateScriptData(script, { episodeRatio: '16:9', allowMixedRatio: false });
  assert.ok(bad.errors.some(e => e.includes("'b'")), JSON.stringify(bad.errors));
  assert.ok(bad.errors.some(e => e.includes('allow_mixed_ratio')));
  assert.deepStrictEqual(script, original, 'must not mutate input');
  const ok = migrateScriptData(
    { episode: 'T', scenes: [{ id: 's01', shots: [{ id: 'a', ratio: '16:9' }] }] },
    { episodeRatio: '16:9', allowMixedRatio: false }
  );
  assert.strictEqual(ok.data.scenes[0].shots[0].ratio, undefined);
  assert.deepStrictEqual(ok.errors, []);
  assert.strictEqual(ok.data.schema_version, 2);
  assert.strictEqual(ok.data.require_keyframe, false);
});

test('MG14. CLI --dry-run 输出摘要且零改动;--to 2 生效', () => {
  const dir = mgEpisode({ catalog: [] });
  const before = mgSnapshot(dir);
  const r = spawnSync(process.execPath, [MG_CLI, dir, '--to', '2', '--dry-run', '--catalog', path.join(dir, 'catalog.json')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.ok(/schema 1 .* 2/.test(r.stdout), r.stdout);
  assert.ok(/dry-run/i.test(r.stdout), r.stdout);
  assert.deepStrictEqual(mgSnapshot(dir), before);
  const r2 = spawnSync(process.execPath, [MG_CLI, dir, '--to', '2', '--catalog', path.join(dir, 'catalog.json')], { encoding: 'utf8' });
  assert.strictEqual(r2.status, 0, `${r2.stdout}${r2.stderr}`);
  assert.strictEqual(readManifest(dir).schema_version, 2);
  assert.ok(!fs.existsSync(path.join(dir, 'script.yaml.bak')), 'scalar-only migration must not create .bak');
});

// ============================================================
// [DEBT] D2/D3/D5/D6/D7/D8 batch
// ============================================================

test('DEBT-D2a. render-next 反复复用同一 task → cache_hits 至多 1、requests 不变', () => {
  const dir = mkTempDir();
  const img = path.join(dir, 'ref.jpg');
  fs.writeFileSync(img, 'x');
  const shot = shotBase('s01-shot-01', { image_paths: [img] });
  shot.input_hash = hashForShot(shot);
  writeManifest(dir, { episode: 'TEST', shots: [shot] });
  createRenderTask(dir);
  createRenderTask(dir);
  createRenderTask(dir);
  const v = videoLedger(dir);
  assert.strictEqual(v.requests, 1, 'only the first call creates the task');
  assert.strictEqual(v.cache_hits, 1, 'polling must not linearly inflate cache_hits');
  assert.strictEqual(readManifest(dir).render_tasks[0].cache_hit_counted, true, 'task must record that its cache_hit was already counted');
});

test('DEBT-D2b. retry_wait 到期重派仍计 request(不受 cache_hit 标记影响)', () => {
  const dir = mkTempDir();
  const future = new Date(Date.now() + 120000).toISOString();
  writeManifest(dir, { episode: 'TEST',
    render_tasks: [{ task_id: 'task-r', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: 'h1', status: 'retry_wait', retry_after: future, stage: 'video', breaker_epoch: 0, image_refs: [] }],
    shots: [shotBase('s01-shot-01', { input_hash: 'h1', image_paths: [] })] });
  const r = createRenderTask(dir, { now: Date.parse(future) + 1000 });
  assert.ok(r && r.task.task_id === 'task-r');
  const v = videoLedger(dir);
  assert.strictEqual(v.requests, 1, 're-dispatch is a real request');
  assert.strictEqual(v.cache_hits, 0);
});

// ---- D3: e1-report --json 原子写 ----

test('DEBT-D3a. e1-report --json 原子写:可解析且无 .tmp 残留', () => {
  const example = path.join(ROOT, 'experiments', 'e1-dataset.example.json');
  const dir = mkTempDir();
  const out = path.join(dir, 'report.json');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'e1-report.js'), example, '--json', out], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  const report = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.ok(report.tool, 'report must be valid JSON');
  assert.deepStrictEqual(fs.readdirSync(dir).filter(n => n.endsWith('.tmp')), [], 'atomic write must not leave tmp');
});

// ---- D5: v2 拒绝 legacy --failed(无 --task) ----

test('DEBT-D5a. v2 manifest:--failed 无 --task → 抛错且 manifest 零改动', () => {
  const dir = mkTempDir();
  writeManifest(dir, { episode: 'TEST', schema_version: 2, shots: [shotBase('s01-shot-01', { input_hash: 'h1', status: 'rendering' })] });
  const before = JSON.stringify(readManifest(dir));
  throws(() => updateManifest(dir, 's01-shot-01', { action: 'failed', error: 'boom' }), '--task');
  assert.strictEqual(JSON.stringify(readManifest(dir)), before, 'must not change any state on rejected legacy path');
});

test('DEBT-D5b. v1 manifest:legacy --failed 仍可用 + 迁移 WARN', () => {
  const dir = mkTempDir();
  writeManifest(dir, { episode: 'TEST', schema_version: 1, shots: [shotBase('s01-shot-01', { input_hash: 'h1' })] });
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => { warns.push(a.join(' ')); };
  let res;
  try { res = updateManifest(dir, 's01-shot-01', { action: 'failed', error: 'legacy' }); }
  finally { console.warn = orig; }
  assert.strictEqual(res.manifest.shots[0].status, 'failed');
  assert.ok(warns.some(w => /legacy --failed without --task \(v1 path\)/.test(w)), `warns: ${warns.join(' | ')}`);
});

// ---- D6: 跨进程锁原语 + stale 回收 ----

test('DEBT-D6a. withLock 返回 fn 结果且结束后锁文件删除;lockPathFor 后缀 .lock', () => {
  const dir = mkTempDir();
  const key = path.join(dir, 'manifest.json');
  const lp = lockPathFor(key);
  assert.strictEqual(lp, key + '.lock');
  const r = withLock(key, () => {
    assert.ok(fs.existsSync(lp), 'lock must exist inside fn');
    return 42;
  });
  assert.strictEqual(r, 42);
  assert.ok(!fs.existsSync(lp), 'lock must be released');
});

test('DEBT-D6b. 手工持锁(存活 pid)→ 超时抛 lock timeout 且保留既有锁', () => {
  const dir = mkTempDir();
  const key = path.join(dir, 'm.json');
  const lp = lockPathFor(key);
  fs.writeFileSync(lp, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  throws(() => withLock(key, () => { throw new Error('must not run'); }, { timeoutMs: 80, retryMs: 10 }), 'lock timeout');
  assert.ok(fs.existsSync(lp), 'pre-existing live lock must not be removed');
  fs.rmSync(lp);
});

test('DEBT-D6c. 死 pid 锁被回收后获取成功', () => {
  const dir = mkTempDir();
  const key = path.join(dir, 'm.json');
  const lp = lockPathFor(key);
  const dead = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  fs.writeFileSync(lp, JSON.stringify({ pid: dead.pid, at: new Date().toISOString() }));
  let ran = false;
  withLock(key, () => { ran = true; });
  assert.ok(ran, 'stale lock from a dead pid must be reclaimed');
  assert.ok(!fs.existsSync(lp));
});

test('DEBT-D6d. 超龄锁(当前 pid + 老 mtime)被回收', () => {
  const dir = mkTempDir();
  const key = path.join(dir, 'm.json');
  const lp = lockPathFor(key);
  fs.writeFileSync(lp, JSON.stringify({ pid: process.pid, at: new Date(Date.now() - 120000).toISOString() }));
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(lp, old, old);
  let ran = false;
  withLock(key, () => { ran = true; }, { staleMs: 60000 });
  assert.ok(ran, 'aged lock must be reclaimed even if pid is alive');
});

test('DEBT-D6e. fn 抛错 → 锁释放且错误上抛', () => {
  const dir = mkTempDir();
  const key = path.join(dir, 'm.json');
  const lp = lockPathFor(key);
  throws(() => withLock(key, () => { throw new Error('boom'); }), 'boom');
  assert.ok(!fs.existsSync(lp), 'lock must be released on error');
});

test('DEBT-D6f. 多 key:fn 内两锁均存在,结束后均删除(逆序释放)', () => {
  const dir = mkTempDir();
  const k1 = path.join(dir, 'a', 'manifest.json');
  const k2 = path.join(dir, 'b', 'catalog.json');
  const locks = [lockPathFor(k1), lockPathFor(k2)];
  let inside = [];
  withLock([k1, k2], () => { inside = locks.map(p => fs.existsSync(p)); });
  assert.deepStrictEqual(inside, [true, true]);
  for (const p of locks) assert.ok(!fs.existsSync(p), `released ${p}`);
});

test('DEBT-D6g. acquireLockOnce 重复获取失败;tryReclaim 回收死 pid 锁', () => {
  const dir = mkTempDir();
  const lp = lockPathFor(path.join(dir, 'm.json'));
  assert.strictEqual(acquireLockOnce(lp), true);
  assert.strictEqual(acquireLockOnce(lp), false, 'second acquire on a live lock must fail');
  fs.rmSync(lp);
  const dead = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  fs.writeFileSync(lp, JSON.stringify({ pid: dead.pid, at: new Date().toISOString() }));
  assert.strictEqual(tryReclaim(lp), true);
  assert.ok(!fs.existsSync(lp));
});

// ---- D7: --select 对 fingerprint 不匹配硬报错 ----

test('DEBT-D7a. --select fingerprint 不匹配 → 抛错且零改动', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'v.mp4');
  fs.writeFileSync(vfile, 'v');
  writeManifest(dir, { episode: 'TEST', shots: [shotBase('s01-shot-01', { input_hash: 'h2', takes: [
    { id: 'take-001', path: vfile, model: 'M', input_hash: 'h1', status: 'candidate', rendered_at: 't', notes: '' }
  ] })] });
  const before = JSON.stringify(readManifest(dir));
  throws(() => updateManifest(dir, 's01-shot-01', { action: 'select', takeId: 'take-001' }), 'fingerprint mismatch');
  assert.strictEqual(JSON.stringify(readManifest(dir)), before, 'no state change on fingerprint mismatch');
});

test('DEBT-D7b. null-hash(来源未知 legacy)select 仍可用', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'v.mp4');
  fs.writeFileSync(vfile, 'v');
  writeManifest(dir, { episode: 'TEST', shots: [shotBase('s01-shot-01', { input_hash: 'h1', takes: [
    { id: 'take-001', path: vfile, model: 'M', input_hash: null, status: 'candidate', rendered_at: 't', notes: '' }
  ] })] });
  const { manifest } = updateManifest(dir, 's01-shot-01', { action: 'select', takeId: 'take-001' });
  assert.strictEqual(manifest.shots[0].selected_take, 'take-001');
});

test('DEBT-D7c. fingerprint 复现的 superseded take 仍可 select', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'v.mp4');
  fs.writeFileSync(vfile, 'v');
  writeManifest(dir, { episode: 'TEST', shots: [shotBase('s01-shot-01', { input_hash: 'h1', takes: [
    { id: 'take-001', path: vfile, model: 'M', input_hash: 'h1', status: 'superseded', rendered_at: 't', notes: '' }
  ] })] });
  const { manifest } = updateManifest(dir, 's01-shot-01', { action: 'select', takeId: 'take-001' });
  assert.strictEqual(manifest.shots[0].takes[0].status, 'selected');
  assert.strictEqual(manifest.shots[0].status, 'done');
});

// ---- D8: 缺失参考图 fail-closed ----

test('DEBT-D8a. computeInputHash 缺失参考图 → 抛错含完整路径;正常路径不抛', () => {
  const dir = mkTempDir();
  const good = path.join(dir, 'r.png');
  fs.writeFileSync(good, 'x');
  assert.ok(computeInputHash('p', [good], 8, '16:9', '720p', 'm'));
  const missing = path.join(dir, 'nope', 'ref.png');
  throws(() => computeInputHash('p', [missing], 8, '16:9', '720p', 'm'), missing);
  let err = null;
  try { computeInputHash('p', [missing], 8, '16:9', '720p', 'm'); } catch (e) { err = e; }
  assert.ok(/content digest required/.test(err.message), err.message);
});

test('DEBT-D8b. build-manifest 集成:缺失 references → 非零退出且错误含路径', () => {
  const dir = mkTempDir();
  const script = [
    'episode: D8TEST', 'title: T', 'defaults:', '  duration: 8', "  ratio: '16:9'", "  resolution: '720p'", "  model: 'default'",
    'scenes:', '  - id: s01', '    shots:',
    '      - id: s01-shot-01', "        style_en: 'cinematic'", "        prompt_en: 'a'",
    "        references: ['/nonexistent/ref.png']", ''
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'script.yaml'), script);
  const r = runBuildManifest(dir);
  assert.notStrictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.ok((r.stdout + r.stderr).includes('/nonexistent/ref.png'), `${r.stdout}${r.stderr}`);
});

// ============================================================
// [A-BATCH] Task state batch A1/A2/A9/A10
// ============================================================

test('A-BATCH-A2a. input_hash 变化 → 旧任务 status 不变且新增 superseded_at/by', () => {
  const dir = mkTempDir();
  const img = path.join(dir, 'ref.jpg');
  fs.writeFileSync(img, 'x');
  const shot = shotBase('s01-shot-01', { image_paths: [img] });
  shot.input_hash = hashForShot(shot);
  writeManifest(dir, { episode: 'TEST', shots: [shot] });
  const r1 = createRenderTask(dir);
  const m = readManifest(dir); m.shots[0].prompt_final_en = 'p2'; m.shots[0].input_hash = hashForShot(m.shots[0]); writeManifest(dir, m);
  const r2 = createRenderTask(dir);
  const m2 = readManifest(dir);
  const oldT = m2.render_tasks.find(t => t.task_id === r1.task.task_id);
  assert.strictEqual(oldT.status, 'submitted', '执行状态保留(仅移出调度集合)');
  assert.ok(oldT.superseded_at, 'superseded_at must be set');
  assert.strictEqual(oldT.superseded_by, r2.task.task_id);
  assert.strictEqual(r2.task.superseded_at, null, 'new snapshot is dispatchable');
});

test('A-BATCH-A2b. A→B→A:hash 复现后 render-next 新建任务快照(不复用/不重派发旧 A)', () => {
  const dir = mkTempDir();
  const img = path.join(dir, 'ref.jpg');
  fs.writeFileSync(img, 'x');
  const baseShot = shotBase('s01-shot-01', { image_paths: [img] });
  baseShot.input_hash = hashForShot(baseShot);
  const hashA = baseShot.input_hash;
  writeManifest(dir, { episode: 'TEST', shots: [baseShot] });
  const rA = createRenderTask(dir);
  let m = readManifest(dir); m.shots[0].prompt_final_en = 'p2'; m.shots[0].input_hash = hashForShot(m.shots[0]); writeManifest(dir, m);
  createRenderTask(dir); // B
  m = readManifest(dir); m.shots[0].prompt_final_en = 'p'; m.shots[0].input_hash = hashA; writeManifest(dir, m);
  const rA2 = createRenderTask(dir);
  assert.notStrictEqual(rA2.task.task_id, rA.task.task_id, 'hash recurrence must create a new snapshot');
  const m2 = readManifest(dir);
  assert.strictEqual(m2.render_tasks.filter(t => t.input_hash === hashA && !isTaskSuperseded(t)).length, 1);
  assert.ok(m2.render_tasks.find(t => t.task_id === rA.task.task_id).superseded_at, 'old A keeps its invalidation history');
});

test('A-BATCH-A2c. --select 恢复 superseded 素材 → reuse_record 落盘 + selected,旧任务失效历史不变', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'v.mp4');
  fs.writeFileSync(vfile, 'v');
  writeManifest(dir, { episode: 'TEST',
    shots: [shotBase('s01-shot-01', { input_hash: 'h1', takes: [
      { id: 'take-001', path: vfile, model: 'M', input_hash: 'h1', status: 'superseded', task_id: 'task-old', content_digest: 'd1', rendered_at: 't', notes: '' }
    ] })],
    render_tasks: [
      { task_id: 'task-old', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: 'h1', status: 'retry_wait', superseded_at: '2026-01-01T00:00:00.000Z', superseded_by: 'task-new', stage: 'video' }
    ] });
  const { manifest } = updateManifest(dir, 's01-shot-01', { action: 'select', takeId: 'take-001' });
  assert.strictEqual(manifest.shots[0].selected_take, 'take-001');
  assert.strictEqual(manifest.shots[0].takes[0].status, 'selected');
  const rec = (manifest.reuse_records || []).find(r => r.take_id === 'take-001');
  assert.ok(rec, 'reuse_record must be appended');
  assert.strictEqual(rec.reason, 'fingerprint_recurrence');
  assert.strictEqual(rec.source_task_id, 'task-old');
  assert.strictEqual(rec.source_artifact_digest, 'd1');
  assert.strictEqual(rec.bound_input_hash, 'h1');
  assert.ok(rec.at, 'reuse_record must be timestamped');
  assert.strictEqual(manifest.render_tasks[0].superseded_at, '2026-01-01T00:00:00.000Z', '失效历史不得改写');
  assert.strictEqual(manifest.render_tasks[0].superseded_by, 'task-new');
});

test('A-BATCH-A2d. validateTake 对未恢复的 superseded take 仍拒绝', () => {
  const dir = mkTempDir();
  const probe = path.join(dir, 'p.mp4');
  fs.writeFileSync(probe, 'p');
  const shot = shotBase('s01-shot-01', { input_hash: 'h1' });
  throws(() => validateTake(shot, { id: 'take-001', status: 'superseded', input_hash: 'h1', path: probe }), 'superseded');
});

// ---- A1: 失败模型 ----

test('A-BATCH-A1a. 同 task 连续 3 次 hard → retry_wait/retry_wait/blocked', () => {
  const dir = seedTaskDir();
  const s1 = updateManifest(dir, 's01-shot-01', { action: 'failed', taskId: 'task-x', error: 'content policy', kindOverride: 'hard', attemptN: 1 });
  const s2 = updateManifest(dir, 's01-shot-01', { action: 'failed', taskId: 'task-x', error: 'content policy', kindOverride: 'hard', attemptN: 2 });
  const s3 = updateManifest(dir, 's01-shot-01', { action: 'failed', taskId: 'task-x', error: 'content policy', kindOverride: 'hard', attemptN: 3 });
  assert.strictEqual(s1.manifest.render_tasks[0].status, 'retry_wait');
  assert.strictEqual(s2.manifest.render_tasks[0].status, 'retry_wait');
  assert.strictEqual(s3.manifest.shots[0].status, 'blocked');
});

test('A-BATCH-A1b. --terminal 显式上报 → 终态 failed', () => {
  const dir = seedTaskDir();
  const { manifest } = updateManifest(dir, 's01-shot-01', { action: 'failed', taskId: 'task-x', error: 'content policy', kindOverride: 'hard', terminal: true });
  assert.strictEqual(manifest.render_tasks[0].status, 'failed');
  assert.strictEqual(manifest.task_events[0].kind, 'hard');
  throws(() => updateManifest(dir, 's01-shot-01', { action: 'failed', taskId: 'task-x', error: 'again', kindOverride: 'hard' }), 'terminal');
});

test('A-BATCH-A1c. failed 后 late success → succeeded+late 且不自动 selected', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'late.mp4');
  fs.writeFileSync(vfile, 'v');
  writeManifest(dir, { episode: 'TEST',
    render_tasks: [{ task_id: 'task-f', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: 'h1', status: 'failed', stage: 'video', breaker_epoch: 0 }],
    shots: [shotBase('s01-shot-01', { input_hash: 'h1' })] });
  const { manifest } = updateManifest(dir, 's01-shot-01', { action: 'take', path: vfile, taskId: 'task-f', requestId: 'req-9' });
  const t = manifest.render_tasks[0];
  assert.strictEqual(normalizeTaskStatus(t.status), 'succeeded');
  assert.strictEqual(t.completion, 'late');
  assert.strictEqual(manifest.shots[0].selected_take, null, 'late success never auto-selects');
  assert.strictEqual(manifest.shots[0].takes[0].request_id, 'req-9');
  assert.strictEqual(manifest.task_events.filter(e => e.kind === 'callback_received').length, 1);
});

test('A-BATCH-A1d. blocked → --unblock → active+blocked 任务 cancelled 且 shot 回可调度', () => {
  const dir = mkTempDir();
  writeManifest(dir, { episode: 'TEST',
    render_tasks: [
      { task_id: 'task-b', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: 'h1', status: 'blocked', stage: 'video', breaker_epoch: 0 },
      { task_id: 'task-r', shot_id: 's01-shot-01', take_id: 'take-002', input_hash: 'h1', status: 'retry_wait', stage: 'video', breaker_epoch: 0 },
      { task_id: 'task-s', shot_id: 's01-shot-01', take_id: 'take-003', input_hash: 'h1', status: 'succeeded', stage: 'video', breaker_epoch: 0 }
    ],
    shots: [shotBase('s01-shot-01', { input_hash: 'h1', status: 'blocked', blocked_reason: 'hard_attempts count=3', breaker_epoch: 0 })] });
  const { manifest } = updateManifest(dir, 's01-shot-01', { action: 'unblock' });
  assert.strictEqual(manifest.shots[0].breaker_epoch, 1);
  assert.ok(['pending', 'stale'].includes(manifest.shots[0].status), `dispatchable again, got ${manifest.shots[0].status}`);
  assert.strictEqual(manifest.render_tasks.find(t => t.task_id === 'task-b').status, 'cancelled');
  assert.strictEqual(manifest.render_tasks.find(t => t.task_id === 'task-r').status, 'cancelled');
  assert.strictEqual(manifest.render_tasks.find(t => t.task_id === 'task-s').status, 'succeeded', 'terminal success preserved');
});

// ---- A9: (request_id, content_digest) 幂等 ----

test('A-BATCH-A9a. 同 request_id + 同 digest 两次 → 1 条 take、successes 只计 1', () => {
  const { dir, vfile } = a9Manifest(mkTempDir());
  const opts = { action: 'take', path: vfile, taskId: 'task-x', requestId: 'req-1' };
  updateManifest(dir, 's01-shot-01', opts);
  const r2 = updateManifest(dir, 's01-shot-01', opts);
  const m = readManifest(dir);
  assert.strictEqual(m.shots[0].takes.length, 1);
  assert.strictEqual(r2.createdTakeId, m.shots[0].takes[0].id);
  assert.strictEqual(videoLedger(dir).successes, 1, 'idempotent callback must not double count');
});

test('A-BATCH-A9b. 同 request_id + 异 digest → 冲突抛错且零改动', () => {
  const { dir, vfile } = a9Manifest(mkTempDir());
  updateManifest(dir, 's01-shot-01', { action: 'take', path: vfile, taskId: 'task-x', requestId: 'req-1' });
  const before = JSON.stringify(readManifest(dir));
  const other = path.join(dir, 'other.mp4');
  fs.writeFileSync(other, 'DIFFERENT-CONTENT');
  throws(() => updateManifest(dir, 's01-shot-01', { action: 'take', path: other, taskId: 'task-x', requestId: 'req-1' }), 'conflict');
  assert.strictEqual(JSON.stringify(readManifest(dir)), before, 'conflict must not change state');
  assert.strictEqual(videoLedger(dir).successes, 1);
});

test('A-BATCH-A9c. 同 task、两个 request_id → 2 条 take、successes=2、都不自动 selected', () => {
  const { dir, vfile } = a9Manifest(mkTempDir());
  updateManifest(dir, 's01-shot-01', { action: 'take', path: vfile, taskId: 'task-x', requestId: 'req-1' });
  // FIX6b:同 task 多 request = 多 attempt(派发侧每次 pushAttempt);显式构造第二个 attempt 并传 --attempt-id
  const mRes = readManifest(dir);
  mRes.render_tasks[0].attempts.push({ attempt_id: 'att-bbbb2222', at: '2026-01-01T00:01:00.000Z', input_hash: 'h1', request_id: null });
  writeManifest(dir, mRes);
  const other = path.join(dir, 'v2.mp4');
  fs.writeFileSync(other, 'SECOND');
  const { manifest } = updateManifest(dir, 's01-shot-01', { action: 'take', path: other, taskId: 'task-x', requestId: 'req-2', attemptId: 'att-bbbb2222' });
  const takes = manifest.shots[0].takes;
  assert.strictEqual(takes.length, 2);
  assert.deepStrictEqual(takes.map(t => t.request_id).sort(), ['req-1', 'req-2']);
  assert.deepStrictEqual(takes.map(t => t.attempt_id).sort(), ['att-aaaa1111', 'att-bbbb2222'], 'each request binds a distinct attempt');
  assert.strictEqual(takes.filter(t => t.status === 'selected').length, 0);
  assert.strictEqual(videoLedger(dir).successes, 2);
  assert.strictEqual(manifest.shots[0].selected_take, null);
});

test('A-BATCH-A9d. 本地路径不同但 digest 相同 → 幂等(不算冲突)', () => {
  const { dir, vfile } = a9Manifest(mkTempDir());
  updateManifest(dir, 's01-shot-01', { action: 'take', path: vfile, taskId: 'task-x', requestId: 'req-1' });
  const copy = path.join(dir, 'copy.mp4');
  fs.writeFileSync(copy, 'v'); // same bytes as vfile
  const r = updateManifest(dir, 's01-shot-01', { action: 'take', path: copy, taskId: 'task-x', requestId: 'req-1' });
  assert.strictEqual(readManifest(dir).shots[0].takes.length, 1);
  assert.strictEqual(r.createdTakeId, 'take-001');
});

test('A-BATCH-A9e. blocked 后 late success → take.status=superseded 且任务状态不变', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'v.mp4');
  fs.writeFileSync(vfile, 'v');
  writeManifest(dir, { episode: 'TEST',
    render_tasks: [{ task_id: 'task-b', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: 'h1', status: 'blocked', stage: 'video', breaker_epoch: 0 }],
    shots: [shotBase('s01-shot-01', { input_hash: 'h1', status: 'blocked', blocked_reason: 'hard_attempts count=3' })] });
  const { manifest } = updateManifest(dir, 's01-shot-01', { action: 'take', path: vfile, taskId: 'task-b', requestId: 'req-late' });
  assert.strictEqual(manifest.render_tasks[0].status, 'blocked', 'task must not be revived by a callback');
  assert.strictEqual(manifest.shots[0].takes[0].status, 'superseded');
  const ev = manifest.task_events.find(e => e.kind === 'callback_received');
  assert.ok(ev && ev.after_terminal === true, 'event must record after_terminal');
});

test('A-BATCH-A9f. render-next 每次派发生成/刷新 current_attempt_id', () => {
  const dir = mkTempDir();
  const shot = shotBase('s01-shot-01', { image_paths: [] });
  shot.input_hash = hashForShot(shot);
  writeManifest(dir, { episode: 'TEST', shots: [shot] });
  const r1 = createRenderTask(dir);
  assert.ok(/^att-[0-9a-f]{8}$/.test(r1.task.current_attempt_id), `got ${r1.task.current_attempt_id}`);
  const m = readManifest(dir);
  m.render_tasks[0].status = 'retry_wait';
  m.render_tasks[0].retry_after = new Date(Date.now() - 1000).toISOString();
  writeManifest(dir, m);
  const r2 = createRenderTask(dir);
  assert.ok(/^att-[0-9a-f]{8}$/.test(r2.task.current_attempt_id));
  assert.notStrictEqual(r2.task.current_attempt_id, r1.task.current_attempt_id, 'each dispatch refreshes attempt_id');
  assert.strictEqual(r2.task.attempts.length, 2, 'retry re-dispatch must append another attempt');
  assert.strictEqual(r2.task.attempts[1].attempt_id, r2.task.current_attempt_id);
  assert.strictEqual(r2.task.attempts[0].attempt_id, r1.task.current_attempt_id, 'first attempt is preserved');
});

// ---- A10: 调度集合与唯一约束 ----

test('A-BATCH-A10a. superseded retry_wait 到期不派发、不复用', () => {
  const dir = mkTempDir();
  const past = new Date(Date.now() - 1000).toISOString();
  writeManifest(dir, { episode: 'TEST',
    render_tasks: [
      { task_id: 'task-old', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: 'h1', status: 'retry_wait', retry_after: past, stage: 'video', breaker_epoch: 0, superseded_at: '2026-01-01T00:00:00.000Z', superseded_by: 'task-new', image_refs: [] },
      { task_id: 'task-new', shot_id: 's01-shot-01', take_id: 'take-002', input_hash: 'h1', status: 'submitted', stage: 'video', breaker_epoch: 0, superseded_at: null, image_refs: [] }
    ],
    shots: [shotBase('s01-shot-01', { input_hash: 'h1', image_paths: [] })] });
  const r = createRenderTask(dir);
  assert.ok(r, 'must reuse the dispatchable snapshot');
  assert.strictEqual(r.task.task_id, 'task-new', 'must not resurrect the superseded retry_wait task');
  const m = readManifest(dir);
  assert.strictEqual(m.render_tasks.find(t => t.task_id === 'task-old').status, 'retry_wait', 'execution fact preserved');
  assert.deepStrictEqual(collectRetryWaits(m, Date.now() + 1000).map(w => w.task_id), [], 'superseded task excluded from retry wait set');
});

test('A-BATCH-A10b. 同 hash 新建任务成功且与旧(superseded)任务并存', () => {
  const dir = mkTempDir();
  const img = path.join(dir, 'ref.jpg');
  fs.writeFileSync(img, 'x');
  const shot = shotBase('s01-shot-01', { image_paths: [img] });
  shot.input_hash = hashForShot(shot);
  const h = shot.input_hash;
  writeManifest(dir, { episode: 'TEST', shots: [shot],
    render_tasks: [{ task_id: 'task-old', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: h, status: 'retry_wait', retry_after: new Date(Date.now() - 1000).toISOString(), stage: 'video', breaker_epoch: 0, superseded_at: '2026-01-01T00:00:00.000Z', superseded_by: null }] });
  const r = createRenderTask(dir);
  assert.ok(r && r.task.task_id !== 'task-old');
  assert.strictEqual(r.task.input_hash, h);
  const m = readManifest(dir);
  assert.strictEqual(m.render_tasks.length, 2, 'old superseded snapshot coexists');
  assert.strictEqual(m.render_tasks.find(t => t.task_id === 'task-old').superseded_at, '2026-01-01T00:00:00.000Z');
  assert.strictEqual(m.render_tasks.filter(t => isTaskSuperseded(t)).length, 1);
});

test('A-BATCH-A10c. hardFailureTaskCount 按 (shot_id, epoch) 统计 distinct hard-failure task', () => {
  const events = [
    { task_id: 't1', shot_id: 's', kind: 'hard', epoch: 0 },
    { task_id: 't1', shot_id: 's', kind: 'hard', epoch: 0 },
    { task_id: 't2', shot_id: 's', kind: 'hard', epoch: 0 },
    { task_id: 't3', shot_id: 's', kind: 'transient', epoch: 0 },
    { task_id: 't4', shot_id: 's', kind: 'hard', epoch: 1 },
    { task_id: 't5', shot_id: 'other', kind: 'hard', epoch: 0 }
  ];
  assert.strictEqual(hardFailureTaskCount(events, { shot_id: 's', epoch: 0 }), 2);
  assert.strictEqual(hardFailureTaskCount(events, { shot_id: 's', epoch: 1 }), 1);
  assert.strictEqual(hardFailureTaskCount(events, {}), 4);
});

test('A-BATCH-A9g. 已 succeeded 的同 task 第二次请求:completion 不被覆盖为 late、不记 late 事件', () => {
  const dir = mkTempDir();
  const v1 = path.join(dir, 'v1.mp4');
  const v2 = path.join(dir, 'v2.mp4');
  fs.writeFileSync(v1, 'SAME');
  fs.writeFileSync(v2, 'DIFF');
  const { fileContentHash } = require('../render-next');
  writeManifest(dir, { episode: 'T',
    render_tasks: [{ task_id: 'task-x', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: 'h1', status: 'succeeded', completion: 'normal', stage: 'video', breaker_epoch: 0, current_attempt_id: 'att-2',
      attempts: [
        { attempt_id: 'att-2', at: '2026-01-01T00:00:00.000Z', input_hash: 'h1', request_id: 'req-1' },
        { attempt_id: 'att-3', at: '2026-01-01T00:01:00.000Z', input_hash: 'h1', request_id: null }
      ] }],
    task_events: [],
    shots: [shotBase('s01-shot-01', { input_hash: 'h1', takes: [
      { id: 'take-001', task_id: 'task-x', request_id: 'req-1', content_digest: fileContentHash(v1), path: v1, model: 'm', input_hash: 'h1', status: 'candidate', rendered_at: 't', notes: '' }
    ] })] });
  const { manifest } = updateManifest(dir, 's01-shot-01', { action: 'take', taskId: 'task-x', path: v2, requestId: 'req-2', attemptId: 'att-3' });
  const task = manifest.render_tasks[0];
  assert.strictEqual(task.status, 'succeeded');
  assert.strictEqual(task.completion, 'normal', 'second request must not overwrite completion=normal with late');
  assert.strictEqual(manifest.shots[0].takes.length, 2, 'second request produces an independent take');
  assert.strictEqual(manifest.shots[0].selected_take, null, 'never auto-selected');
  assert.ok(!(manifest.task_events || []).some(e => e.kind === 'callback_received'), 'on-time second request must not emit a late callback event');
});

// ============================================================
// [FIX3] Traceability/identity review fixes (F1/F2/F3)
// ============================================================

test('F1a. 输入与 shot.input_hash 一致 → 建任务成功且 task.input_hash 一致', () => {
  const dir = mkTempDir();
  const img = path.join(dir, 'ref.jpg');
  fs.writeFileSync(img, 'A');
  const shot = shotBase('s01-shot-01', { image_paths: [img] });
  shot.input_hash = hashForShot(shot);
  writeManifest(dir, { episode: 'TEST', shots: [shot] });
  const { task } = createRenderTask(dir);
  assert.ok(task.task_id);
  assert.strictEqual(task.input_hash, shot.input_hash, 'task must record the manifest fingerprint');
  assert.ok(Array.isArray(task.attempts) && task.attempts.length === 1, 'dispatch must append an attempt');
  assert.strictEqual(task.attempts[0].attempt_id, task.current_attempt_id);
});

test('F1b. 原图内容被替换 → fingerprint mismatch 抛错、无新 task、无残留冻结目录', () => {
  const dir = mkTempDir();
  const img = path.join(dir, 'ref.jpg');
  fs.writeFileSync(img, 'A');
  const shot = shotBase('s01-shot-01', { image_paths: [img] });
  shot.input_hash = hashForShot(shot); // 按图 A 计算并写入 manifest
  writeManifest(dir, { episode: 'TEST', shots: [shot] });
  fs.writeFileSync(img, 'B'); // 原路径内容替换为 B
  throws(() => createRenderTask(dir), 'fingerprint mismatch');
  let err = null;
  try { createRenderTask(dir); } catch (e) { err = e; }
  assert.ok(/rebuild/.test(err.message), `message must guide rebuild: ${err.message}`);
  const m = readManifest(dir);
  assert.deepStrictEqual(m.render_tasks || [], [], 'manifest must not gain a task on mismatch');
  assert.deepStrictEqual(taskAssetsDirs(dir), [], 'no frozen dir residue after cleanup');
});

test('F1c. 多张参考图一致 → 建任务成功', () => {
  const dir = mkTempDir();
  const a = path.join(dir, 'a.jpg');
  const b = path.join(dir, 'b.jpg');
  fs.writeFileSync(a, 'A');
  fs.writeFileSync(b, 'B');
  const shot = shotBase('s01-shot-01', { image_paths: [a, b] });
  shot.input_hash = hashForShot(shot);
  writeManifest(dir, { episode: 'TEST', shots: [shot] });
  const { task } = createRenderTask(dir);
  assert.strictEqual(task.image_refs.length, 2);
  assert.strictEqual(task.input_hash, shot.input_hash);
});

// ---- F2: 回调按 attempt 身份解析(不得用 current 指针兜底) ----

test('F2a. --take --attempt-id 命中指定 attempt(忽略 current)', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'v.mp4');
  fs.writeFileSync(vfile, 'v');
  writeManifest(dir, { episode: 'TEST', render_tasks: [twoAttemptTask()], shots: [shotBase('s01-shot-01', { input_hash: 'h1' })] });
  const { manifest } = updateManifest(dir, 's01-shot-01', { action: 'take', path: vfile, taskId: 'task-x', attemptId: 'att-1', requestId: 'req-1' });
  assert.strictEqual(manifest.shots[0].takes[0].attempt_id, 'att-1', 'must bind the attempt named by --attempt-id, not current');
});

test('F2b. --attempt-id 未知 → 抛错且零改动', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'v.mp4');
  fs.writeFileSync(vfile, 'v');
  writeManifest(dir, { episode: 'TEST', render_tasks: [twoAttemptTask()], shots: [shotBase('s01-shot-01', { input_hash: 'h1' })] });
  const before = JSON.stringify(readManifest(dir));
  throws(() => updateManifest(dir, 's01-shot-01', { action: 'take', path: vfile, taskId: 'task-x', attemptId: 'att-9' }), 'unknown attempt_id');
  assert.strictEqual(JSON.stringify(readManifest(dir)), before, 'unknown attempt_id must not change state');
});

test('F2c. --failed 回填 request_id → 后续 --take 按 request_id 解析到同 attempt', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'v.mp4');
  fs.writeFileSync(vfile, 'v');
  writeManifest(dir, { episode: 'TEST', render_tasks: [twoAttemptTask()], shots: [shotBase('s01-shot-01', { input_hash: 'h1' })] });
  updateManifest(dir, 's01-shot-01', { action: 'failed', taskId: 'task-x', error: '429 rate limit', attemptId: 'att-1', requestId: 'req-1' });
  const m = readManifest(dir);
  const att1 = m.render_tasks[0].attempts.find(a => a.attempt_id === 'att-1');
  assert.strictEqual(att1.request_id, 'req-1', 'failed callback must backfill request_id onto the attempt');
  const { manifest } = updateManifest(dir, 's01-shot-01', { action: 'take', path: vfile, taskId: 'task-x', requestId: 'req-1' });
  assert.strictEqual(manifest.shots[0].takes[0].attempt_id, 'att-1', 'success callback must resolve via the backfilled request_id');
});

test('F2d. 多 attempt 无身份回调 → 抛错(不用 current 兜底)', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'v.mp4');
  fs.writeFileSync(vfile, 'v');
  writeManifest(dir, { episode: 'TEST', render_tasks: [twoAttemptTask()], shots: [shotBase('s01-shot-01', { input_hash: 'h1' })] });
  const before = JSON.stringify(readManifest(dir));
  throws(() => updateManifest(dir, 's01-shot-01', { action: 'take', path: vfile, taskId: 'task-x' }), 'multiple attempts');
  assert.strictEqual(JSON.stringify(readManifest(dir)), before, 'ambiguous callback must not change state');
});

// ---- F3: 无身份回调不得静默吞掉不同产物 ----

test('F3a. 无身份 + 不同内容回写 → 抛错、takes 仍 1、ledger 不变', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'v.mp4');
  fs.writeFileSync(vfile, 'X');
  writeManifest(dir, { episode: 'TEST', render_tasks: [legacyTaskNoAttempts()], shots: [shotBase('s01-shot-01', { input_hash: 'h1' })] });
  updateManifest(dir, 's01-shot-01', { action: 'take', path: vfile, taskId: 'task-x' });
  const before = readManifest(dir);
  const other = path.join(dir, 'other.mp4');
  fs.writeFileSync(other, 'Y');
  throws(() => updateManifest(dir, 's01-shot-01', { action: 'take', path: other, taskId: 'task-x' }), 'no request/attempt identity');
  const after = readManifest(dir);
  assert.strictEqual(after.shots[0].takes.length, 1, 'must not silently add a second take');
  assert.deepStrictEqual(after.quota_ledger, before.quota_ledger, 'ledger must be unchanged on refusal');
});

test('F3b. 无身份 + 同内容 → 幂等返回既有 take', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'v.mp4');
  fs.writeFileSync(vfile, 'X');
  writeManifest(dir, { episode: 'TEST', render_tasks: [legacyTaskNoAttempts()], shots: [shotBase('s01-shot-01', { input_hash: 'h1' })] });
  const r1 = updateManifest(dir, 's01-shot-01', { action: 'take', path: vfile, taskId: 'task-x' });
  const r2 = updateManifest(dir, 's01-shot-01', { action: 'take', path: vfile, taskId: 'task-x' });
  const m = readManifest(dir);
  assert.strictEqual(m.shots[0].takes.length, 1);
  assert.strictEqual(r2.createdTakeId, r1.createdTakeId);
  assert.strictEqual(m.quota_ledger.stages.video.successes, 1, 'idempotent callback must not double count');
});

test('F3c. 新任务单 attempt、无身份 → 新增并绑定该 attempt', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'v.mp4');
  fs.writeFileSync(vfile, 'v');
  writeManifest(dir, { episode: 'TEST',
    render_tasks: [{ task_id: 'task-x', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: 'h1', status: 'submitted', stage: 'video', breaker_epoch: 0,
      current_attempt_id: 'att-1', attempts: [{ attempt_id: 'att-1', at: '2026-01-01T00:00:00.000Z', input_hash: 'h1' }] }],
    shots: [shotBase('s01-shot-01', { input_hash: 'h1' })] });
  const { manifest } = updateManifest(dir, 's01-shot-01', { action: 'take', path: vfile, taskId: 'task-x' });
  assert.strictEqual(manifest.shots[0].takes[0].attempt_id, 'att-1');
});
