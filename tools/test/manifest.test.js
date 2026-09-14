'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { test, throws, mkTempDir, writeManifest, readManifest, shotBase } = require('./helpers');
const { validateTake } = require('../edit-episode');
const { updateManifest } = require('../mark-shot');
const { compareShotList, recoverTakesFromCatalog, deriveStatus } = require('../build-manifest');

test('1. 审核拒绝 + hash 匹配 → 拒绝', () => {
  const shot = shotBase('s01-shot-01', { input_hash: 'h1' });
  const take = { id: 'take-001', status: 'selected', input_hash: 'h1',
    human_review: { conclusion: 'reject', reviewed_input_hash: 'h1', reviewed_at: 'now' } };
  throws(() => validateTake(shot, take), 'rejected');
});

test('2. 审核通过但 input 变了 → 拒绝', () => {
  const shot = shotBase('s01-shot-01', { input_hash: 'h_new' });
  const take = { id: 'take-001', status: 'selected', input_hash: 'h_old',
    human_review: { conclusion: 'accept', reviewed_input_hash: 'h_old', reviewed_at: 'now' } };
  throws(() => validateTake(shot, take), 'input changed after review');
});

test('3a. 无审核 + hash 匹配 → 通过', () => {
  const shot = shotBase('s01-shot-01', { input_hash: 'h1' });
  const take = { id: 'take-001', status: 'candidate', input_hash: 'h1' };
  validateTake(shot, take);
});

test('3b. 无审核 + hash 不匹配 → 拒绝', () => {
  const shot = shotBase('s01-shot-01', { input_hash: 'h_new' });
  const take = { id: 'take-001', status: 'selected', input_hash: 'h_old' };
  throws(() => validateTake(shot, take), 'input_hash mismatch');
});

test('3c. 无审核 + 来源未知(null) → 拒绝', () => {
  const shot = shotBase('s01-shot-01', { input_hash: 'h1' });
  const take = { id: 'take-001', status: 'selected', input_hash: null };
  throws(() => validateTake(shot, take), 'input_hash mismatch');
});

test('4. status=rejected → 拒绝', () => {
  const shot = shotBase('s01-shot-01', { input_hash: 'h1' });
  const take = { id: 'take-001', status: 'rejected', input_hash: 'h1' };
  throws(() => validateTake(shot, take), 'rejected');
});

test('5. 旧时间线重导:被取消选片的 reviewed-accept take 仍可导出', () => {
  const shot = shotBase('s01-shot-01', { input_hash: 'h1', selected_take: 'take-002' });
  const take001 = { id: 'take-001', status: 'candidate', input_hash: 'h1',
    human_review: { conclusion: 'accept', reviewed_input_hash: 'h1', reviewed_at: 'now' } };
  validateTake(shot, take001);
});

test('6. 无 --task → take.input_hash=null(来源未知)', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'x.mp4');
  fs.writeFileSync(vfile, 'x');
  writeManifest(dir, { episode: 'TEST', shots: [shotBase('s01-shot-01')] });
  const { manifest } = updateManifest(dir, 's01-shot-01', {
    action: 'take', path: vfile, model: 'M', taskId: null
  });
  const take = manifest.shots[0].takes[0];
  assert.strictEqual(take.input_hash, null, 'input_hash should be null when no --task');
  assert.strictEqual(take.task_id, null);
});

test('7. --task 绑定错误 shot → 抛错', () => {
  const dir = mkTempDir();
  writeManifest(dir, {
    episode: 'TEST',
    render_tasks: [{ task_id: 'task-aa', shot_id: 's01-shot-02', take_id: 'take-001', input_hash: 'h1', status: 'submitted' }],
    shots: [shotBase('s01-shot-01')]
  });
  throws(() => updateManifest(dir, 's01-shot-01', {
    action: 'take', path: '/tmp/x.mp4', taskId: 'task-aa'
  }), 'is for shot');
});

test('8. 重复回写同一 task → 幂等,不创建新 take', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'a.mp4');
  fs.writeFileSync(vfile, 'a');
  writeManifest(dir, {
    episode: 'TEST',
    render_tasks: [{ task_id: 'task-aa', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: 'h1', status: 'submitted' }],
    shots: [shotBase('s01-shot-01', { input_hash: 'h1' })]
  });
  updateManifest(dir, 's01-shot-01', { action: 'take', path: vfile, taskId: 'task-aa' });
  let m = readManifest(dir);
  assert.strictEqual(m.shots[0].takes.length, 1);
  assert.strictEqual(m.render_tasks[0].status, 'succeeded');
  updateManifest(dir, 's01-shot-01', { action: 'take', path: vfile, taskId: 'task-aa' });
  m = readManifest(dir);
  assert.strictEqual(m.shots[0].takes.length, 1, 'must not create a second take');
});

test('12a. 删镜(manifest 多出)→ removed 非空 + fresh=false', () => {
  const r = compareShotList(['A', 'B'], ['A', 'B', 'C']);
  assert.deepStrictEqual(r.removed, ['C']);
  assert.deepStrictEqual(r.added, []);
  assert.strictEqual(r.reordered, false);
});

test('12b. 加镜(script 多出)→ added 非空', () => {
  const r = compareShotList(['A', 'B', 'C'], ['A', 'B']);
  assert.deepStrictEqual(r.added, ['C']);
  assert.deepStrictEqual(r.removed, []);
});

test('12c. 换序(同集合)→ reordered=true', () => {
  const r = compareShotList(['C', 'B', 'A'], ['A', 'B', 'C']);
  assert.strictEqual(r.reordered, true);
  assert.deepStrictEqual(r.removed, []);
  assert.deepStrictEqual(r.added, []);
});

test('12d. 一致 → 全空', () => {
  const r = compareShotList(['A', 'B', 'C'], ['A', 'B', 'C']);
  assert.strictEqual(r.removed.length, 0);
  assert.strictEqual(r.added.length, 0);
  assert.strictEqual(r.reordered, false);
});

test('13a. 保留 rejected 状态(不降级为 candidate)', () => {
  const entries = [
    { take_id: 'take-001', path: '/tmp/a.mp4', model: 'M', status: 'selected', rendered_at: 't1' },
    { take_id: 'take-002', path: '/tmp/b.mp4', model: 'M', status: 'rejected', rendered_at: 't2' }
  ];
  const { takes } = recoverTakesFromCatalog('s01-shot-01', entries);
  assert.strictEqual(takes.length, 2);
  const rej = takes.find(t => t.id === 'take-002');
  assert.strictEqual(rej.status, 'rejected', 'rejected must be preserved');
  assert.strictEqual(takes.find(t => t.id === 'take-001').status, 'selected');
});

test('13b. 恢复 human_review 审核历史', () => {
  const review = { conclusion: 'accept', reviewed_input_hash: 'h1', reviewed_at: 'now', reviewer: 'u' };
  const entries = [
    { take_id: 'take-001', path: '/tmp/a.mp4', model: 'M', status: 'selected', rendered_at: 't1', human_review: review }
  ];
  const { takes } = recoverTakesFromCatalog('s01-shot-01', entries);
  assert.deepStrictEqual(takes[0].human_review, review, 'human_review must be restored');
});

test('13c. 同 take_id 冲突(状态不一致)→ 报告 conflict,取第一条', () => {
  const entries = [
    { take_id: 'take-001', path: '/tmp/a.mp4', model: 'M', status: 'candidate', rendered_at: 't1' },
    { take_id: 'take-001', path: '/tmp/a.mp4', model: 'M', status: 'selected', rendered_at: 't2' }
  ];
  const { takes, conflicts } = recoverTakesFromCatalog('s01-shot-01', entries);
  assert.strictEqual(takes.length, 1, 'dedupe to one');
  assert.ok(conflicts.length >= 1, 'must report conflict');
  assert.ok(conflicts[0].includes('divergent'), `conflict msg: ${conflicts[0]}`);
});

test('13d. 同 take_id 一致重复 → 静默去重,无冲突', () => {
  const entries = [
    { take_id: 'take-001', path: '/tmp/a.mp4', model: 'M', status: 'candidate', rendered_at: 't1' },
    { take_id: 'take-001', path: '/tmp/a.mp4', model: 'M', status: 'candidate', rendered_at: 't1' }
  ];
  const { takes, conflicts } = recoverTakesFromCatalog('s01-shot-01', entries);
  assert.strictEqual(takes.length, 1);
  assert.strictEqual(conflicts.length, 0);
});

test('14. selected take 审核 reject → stale(不 done)', () => {
  const shot = {
    input_hash: 'h1', selected_take: 'take-001', prev_hash: null,
    takes: [{ id: 'take-001', input_hash: 'h1', status: 'rejected',
      human_review: { conclusion: 'reject', reviewed_input_hash: 'h1' } }]
  };
  const { status } = deriveStatus(shot, 'h1', null);
  assert.strictEqual(status, 'stale');
});
