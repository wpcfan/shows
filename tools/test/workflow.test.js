'use strict';
const { test, throws, mkTempDir, writeManifest, readManifest, shotBase } = require('./helpers');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { validateTimePoint, escapeConcatPath } = require('../edit-episode');
const { updateManifest } = require('../mark-shot');
const { collectFinalValidationErrors } = require('../stitch-episode');
const {
  deriveStatus, compareShotList, recoverTakesFromCatalog,
  verifyManifestFreshness, resolveSelectionConflict
} = require('../build-manifest');

// [W1] reject 终态不可复活

test('W1a. reject 后 accept → 抛错且 manifest 未变', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'a.mp4');
  fs.writeFileSync(vfile, 'v');
  writeManifest(dir, { episode: 'TEST', shots: [shotBase('s01-shot-01', {
    input_hash: 'h1',
    takes: [{ id: 'take-001', path: vfile, input_hash: null, status: 'candidate' }],
    selected_take: null
  })] });
  updateManifest(dir, 's01-shot-01', { action: 'review', takeId: 'take-001', conclusion: 'reject' });
  const before = JSON.stringify(readManifest(dir));
  throws(() => updateManifest(dir, 's01-shot-01', { action: 'review', takeId: 'take-001', conclusion: 'accept' }), 'reject');
  assert.strictEqual(JSON.stringify(readManifest(dir)), before, 'manifest must not change on rejected accept');
});

test('W1b. reviewer reject 结论后 select → 抛错', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'a.mp4');
  fs.writeFileSync(vfile, 'v');
  writeManifest(dir, { episode: 'TEST', shots: [shotBase('s01-shot-01', {
    input_hash: 'h1',
    takes: [{ id: 'take-001', path: vfile, input_hash: null, status: 'candidate' }],
    selected_take: null
  })] });
  updateManifest(dir, 's01-shot-01', { action: 'review', takeId: 'take-001', conclusion: 'reject' });
  throws(() => updateManifest(dir, 's01-shot-01', { action: 'select', takeId: 'take-001' }), 'reject');
});

test('W1c. status 未标记 rejected 但 human_review 为 reject → select 仍拒绝', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'a.mp4');
  fs.writeFileSync(vfile, 'v');
  writeManifest(dir, { episode: 'TEST', shots: [shotBase('s01-shot-01', {
    input_hash: 'h1',
    takes: [{ id: 'take-001', path: vfile, input_hash: 'h1', status: 'candidate',
      human_review: { conclusion: 'reject', reviewed_input_hash: 'h1', reviewed_at: 'now' } }],
    selected_take: null
  })] });
  throws(() => updateManifest(dir, 's01-shot-01', { action: 'select', takeId: 'take-001' }), 'reject');
});

// [W2] stitch --final 复用 validateTake + preview 结构告警

function doneShotWithTake(id, take, extra = {}) {
  return shotBase(id, Object.assign({ status: 'done', selected_take: take.id, takes: [take] }, extra));
}

test('W2a. done + selected take 为 rejected → collectFinalValidationErrors 报错', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'v.mp4');
  fs.writeFileSync(vfile, 'v');
  const m = { shots: [doneShotWithTake('s01-shot-01', { id: 'take-001', status: 'rejected', input_hash: 'h1', path: vfile }, { input_hash: 'h1' })] };
  const errs = collectFinalValidationErrors(m);
  assert.ok(errs.length >= 1, 'expected validation error');
  assert.ok(errs.join(' ').includes('rejected'), `errors: ${errs.join(' | ')}`);
});

test('W2b. done + review reject → 报错', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'v.mp4');
  fs.writeFileSync(vfile, 'v');
  const m = { shots: [doneShotWithTake('s01-shot-01', { id: 'take-001', status: 'selected', input_hash: 'h1', path: vfile,
    human_review: { conclusion: 'reject', reviewed_input_hash: 'h1' } }, { input_hash: 'h1' })] };
  const errs = collectFinalValidationErrors(m);
  assert.ok(errs.join(' ').includes('rejected'), `errors: ${errs.join(' | ')}`);
});

test('W2c. done + take.input_hash 不匹配 → 报错', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'v.mp4');
  fs.writeFileSync(vfile, 'v');
  const m = { shots: [doneShotWithTake('s01-shot-01', { id: 'take-001', status: 'selected', input_hash: 'h_old', path: vfile }, { input_hash: 'h_new' })] };
  const errs = collectFinalValidationErrors(m);
  assert.ok(errs.join(' ').includes('input_hash mismatch'), `errors: ${errs.join(' | ')}`);
});

test('W2d. done + 无 review 且 hash 匹配 → 无错误', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'v.mp4');
  fs.writeFileSync(vfile, 'v');
  const m = { shots: [doneShotWithTake('s01-shot-01', { id: 'take-001', status: 'selected', input_hash: 'h1', path: vfile }, { input_hash: 'h1' })] };
  assert.deepStrictEqual(collectFinalValidationErrors(m), []);
});

test('W2e. done 但 selected take 不存在 → 报错', () => {
  const m = { shots: [doneShotWithTake('s01-shot-01', { id: 'take-001', status: 'selected', input_hash: 'h1' })] };
  m.shots[0].selected_take = 'take-999';
  const errs = collectFinalValidationErrors(m);
  assert.ok(errs.length >= 1, 'expected missing selected take error');
});

test('W2f. preview 结构告警:verifyManifestFreshness 检测删镜 structure_issues', () => {
  const dir = mkTempDir();
  fs.writeFileSync(path.join(dir, 'script.yaml'), [
    'episode: TEST',
    'title: T',
    'defaults:',
    '  duration: 8',
    "  ratio: '16:9'",
    "  resolution: '720p'",
    "  model: 'default'",
    'scenes:',
    '  - id: s01',
    '    shots:',
    '      - id: s01-shot-01',
    "        style_en: 'cinematic'",
    "        prompt_en: 'test shot'",
    ''
  ].join('\n'));
  writeManifest(dir, { episode: 'TEST', shots: [
    shotBase('s01-shot-01', { input_hash: 'x' }),
    shotBase('s01-shot-99', { input_hash: 'x' })
  ] });
  const { structure_issues } = verifyManifestFreshness(dir);
  assert.ok(structure_issues.some(s => s.includes('s01-shot-99')), `structure_issues: ${structure_issues.join(' | ')}`);
});

// [W5] shell 注入防护:参数校验 + execFileSync

test('W5a. validateTimePoint 接受有限非负数', () => {
  assert.strictEqual(validateTimePoint(0, 'in_point'), 0);
  assert.strictEqual(validateTimePoint(2.5, 'out_point'), 2.5);
});

test('W5b. validateTimePoint 拒绝负数 / 非有限数 / 字符串', () => {
  for (const bad of [-1, NaN, Infinity, -Infinity, '0; touch /tmp/pwn', '1', null, undefined, {}]) {
    throws(() => validateTimePoint(bad, 'in_point'), 'finite non-negative');
  }
});

test('W5c. escapeConcatPath 转义单引号', () => {
  assert.strictEqual(escapeConcatPath("/tmp/a'b.mp4"), "'/tmp/a'\\''b.mp4'");
  assert.strictEqual(escapeConcatPath('/tmp/plain.mp4'), "'/tmp/plain.mp4'");
});

test('W5d. edit-episode / stitch-episode 不再使用 execSync 字符串命令', () => {
  for (const f of ['../edit-episode.js', '../stitch-episode.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    assert.ok(!/execSync\s*\(/.test(src), `${f} must not use execSync`);
    assert.ok(/execFileSync\s*\(/.test(src), `${f} must use execFileSync`);
  }
});

// [W6] deriveStatus 与 reject 优先级一致

test('W6a. review accept + status rejected → stale(不 done)', () => {
  const shot = {
    input_hash: 'h1', selected_take: 'take-001', prev_hash: null,
    takes: [{ id: 'take-001', input_hash: 'h1', status: 'rejected',
      human_review: { conclusion: 'accept', reviewed_input_hash: 'h1' } }]
  };
  const { status } = deriveStatus(shot, 'h1', null);
  assert.strictEqual(status, 'stale');
});

test('W6b. review reject(即使 status=selected)→ stale', () => {
  const shot = {
    input_hash: 'h1', selected_take: 'take-001', prev_hash: null,
    takes: [{ id: 'take-001', input_hash: 'h1', status: 'selected',
      human_review: { conclusion: 'reject', reviewed_input_hash: 'h1' } }]
  };
  const { status } = deriveStatus(shot, 'h1', null);
  assert.strictEqual(status, 'stale');
});

// [W7] 结构冲突与恢复冲突上报

test('W7a. compareShotList 检测任一列表内重复 shot id', () => {
  const r1 = compareShotList(['A', 'A', 'B'], ['A', 'B']);
  assert.ok((r1.duplicates || []).some(d => d.includes('A')), `duplicates: ${JSON.stringify(r1.duplicates)}`);
  const r2 = compareShotList(['A', 'B'], ['A', 'B', 'B']);
  assert.ok((r2.duplicates || []).some(d => d.includes('B')), `duplicates: ${JSON.stringify(r2.duplicates)}`);
});

test('W7a2. verifyManifestFreshness 把重复 id 计入 structure_issues', () => {
  const dir = mkTempDir();
  fs.writeFileSync(path.join(dir, 'script.yaml'), [
    'episode: TEST', 'title: T', 'defaults:', '  duration: 8', "  ratio: '16:9'", "  resolution: '720p'", "  model: 'default'",
    'scenes:', '  - id: s01', '    shots:',
    '      - id: s01-shot-01', "        style_en: 'cinematic'", "        prompt_en: 'a'",
    '      - id: s01-shot-01', "        style_en: 'cinematic'", "        prompt_en: 'b'", ''
  ].join('\n'));
  writeManifest(dir, { episode: 'TEST', shots: [shotBase('s01-shot-01', { input_hash: 'x' })] });
  const { structure_issues } = verifyManifestFreshness(dir);
  assert.ok(structure_issues.some(s => /duplicate/i.test(s)), `structure_issues: ${structure_issues.join(' | ')}`);
});

test('W7b. 同一 shot 多条 selected → 报告冲突(不静默取最后)', () => {
  const entries = [
    { take_id: 'take-001', path: '/tmp/a.mp4', model: 'M', status: 'selected', rendered_at: 't1' },
    { take_id: 'take-002', path: '/tmp/b.mp4', model: 'M', status: 'selected', rendered_at: 't2' }
  ];
  const { selected_take, conflicts } = recoverTakesFromCatalog('s01-shot-01', entries);
  assert.ok(conflicts.some(c => /multiple selected/i.test(c)), `conflicts: ${conflicts.join(' | ')}`);
  assert.strictEqual(selected_take, 'take-001', 'must be deterministic (first), not last');
});

test('W7c. manifest 指针与 catalog 恢复 selected 冲突 → 报告', () => {
  const c = resolveSelectionConflict('s01-shot-01', 'take-A', 'take-B');
  assert.ok(c.length >= 1 && c[0].includes('conflict'), `conflicts: ${c.join(' | ')}`);
  assert.deepStrictEqual(resolveSelectionConflict('s01-shot-01', 'take-A', 'take-A'), []);
  assert.deepStrictEqual(resolveSelectionConflict('s01-shot-01', 'take-A', null), []);
});

module.exports = {};
