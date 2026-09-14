'use strict';
const { test, throws, mkTempDir, writeManifest, readManifest, shotBase } = require('./helpers');

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { createRenderTask, fileContentHash, computeNextTakeId } = require('../render-next');
const { updateManifest, appendCatalog, nextTakeId } = require('../mark-shot');
const { recoverTakesFromCatalog, computeShotVideoHash, styleGuideFileDigest } = require('../build-manifest');
const { ROOT } = require('../build-prompt');

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

test('9. 连续调用 createRenderTask 同一 shot → 幂等返回同一 task_id', () => {
  const dir = mkTempDir();
  // image_paths 指向真实存在的临时图
  const img = path.join(dir, 'ref.jpg');
  fs.writeFileSync(img, Buffer.from('img-bytes-1'));
  const shot = shotBase('s01-shot-01', { image_paths: [img] });
  shot.input_hash = hashForShot(shot);
  writeManifest(dir, {
    episode: 'TEST',
    shots: [shot]
  });
  const r1 = createRenderTask(dir);
  assert.ok(r1.task.task_id);
  const r2 = createRenderTask(dir);
  assert.strictEqual(r2.task.task_id, r1.task.task_id, 'must reuse same task_id');
});

test('10. 参考图缺失 → 提交被阻止', () => {
  const dir = mkTempDir();
  writeManifest(dir, {
    episode: 'TEST',
    shots: [shotBase('s01-shot-01', { image_paths: ['/nonexistent/ref.jpg'] })]
  });
  throws(() => createRenderTask(dir), 'reference image not found');
});

test('11. 参考图冻结:提交后替换原图,任务记录与冻结副本不变', () => {
  const dir = mkTempDir();
  const img = path.join(dir, 'ref.jpg');
  fs.writeFileSync(img, Buffer.from('ORIGINAL-BYTES'));
  const shot = shotBase('s01-shot-01', { image_paths: [img] });
  shot.input_hash = hashForShot(shot);
  writeManifest(dir, {
    episode: 'TEST',
    shots: [shot]
  });
  const { task } = createRenderTask(dir);
  // 任务快照记录了 content_hash + 冻结副本
  assert.ok(task.image_refs && task.image_refs.length === 1, 'must store image_refs');
  assert.ok(task.image_refs[0].content_hash, 'must record content_hash');
  const frozenPath = task.image_refs[0].frozen_path;
  assert.ok(frozenPath && fs.existsSync(frozenPath), 'must freeze a copy');
  const frozenBefore = fs.readFileSync(frozenPath, 'utf8');
  const hashBefore = task.image_refs[0].content_hash;
  // 替换原图
  fs.writeFileSync(img, Buffer.from('TAMPERED-BYTES'));
  // 任务记录的 hash 不变,冻结副本内容不变
  const m = readManifest(dir);
  const t = m.render_tasks.find(x => x.task_id === task.task_id);
  assert.strictEqual(t.image_refs[0].content_hash, hashBefore, 'recorded hash must not change');
  assert.strictEqual(fs.readFileSync(frozenPath, 'utf8'), frozenBefore, 'frozen copy must not change');
});

function taskAssetsDirs(dir) {
  const d = path.join(dir, '.task-assets');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter(n => fs.statSync(path.join(d, n)).isDirectory());
}

test('W3a. 两张同 basename 参考图 → 冻结路径互异且 content_hash 正确', () => {
  const dir = mkTempDir();
  fs.mkdirSync(path.join(dir, 'a')); fs.mkdirSync(path.join(dir, 'b'));
  const imgA = path.join(dir, 'a', 'reference.jpg');
  const imgB = path.join(dir, 'b', 'reference.jpg');
  fs.writeFileSync(imgA, 'AAA');
  fs.writeFileSync(imgB, 'BBBB');
  const w3aShot = shotBase('s01-shot-01', { image_paths: [imgA, imgB] });
  w3aShot.input_hash = hashForShot(w3aShot);
  writeManifest(dir, { episode: 'TEST', shots: [w3aShot] });
  const { task } = createRenderTask(dir);
  assert.strictEqual(task.image_refs.length, 2);
  const [r1, r2] = task.image_refs;
  assert.notStrictEqual(r1.frozen_path, r2.frozen_path, 'same basename must not overwrite');
  assert.strictEqual(r1.content_hash, fileContentHash(imgA));
  assert.strictEqual(r2.content_hash, fileContentHash(imgB));
  assert.strictEqual(fs.readFileSync(r1.frozen_path, 'utf8'), 'AAA');
  assert.strictEqual(fs.readFileSync(r2.frozen_path, 'utf8'), 'BBBB');
});

test('W3b. 缺图 → 抛错且 manifest 无新 task、无残留冻结目录', () => {
  const dir = mkTempDir();
  const ok = path.join(dir, 'ok.jpg');
  fs.writeFileSync(ok, 'x');
  writeManifest(dir, { episode: 'TEST', shots: [shotBase('s01-shot-01', { image_paths: [ok, path.join(dir, 'missing.jpg')] })] });
  throws(() => createRenderTask(dir), 'reference image not found');
  const m = readManifest(dir);
  assert.deepStrictEqual(m.render_tasks || [], [], 'no task must be created');
  assert.deepStrictEqual(taskAssetsDirs(dir), [], 'no frozen dir left behind');
});

test('W3c. 连续两次调用 → 幂等同 task_id 且不重复冻结', () => {
  const dir = mkTempDir();
  const img = path.join(dir, 'ref.jpg');
  fs.writeFileSync(img, 'x');
  const shot = shotBase('s01-shot-01', { image_paths: [img] });
  shot.input_hash = hashForShot(shot);
  writeManifest(dir, { episode: 'TEST', shots: [shot] });
  const r1 = createRenderTask(dir);
  const r2 = createRenderTask(dir);
  assert.strictEqual(r2.task.task_id, r1.task.task_id);
  assert.strictEqual(readManifest(dir).render_tasks.length, 1, 'must not append duplicate tasks');
  assert.strictEqual(taskAssetsDirs(dir).length, 1, 'must not create duplicate frozen dirs');
});

test('W3d. shot.input_hash 变化 → 新建 task 且旧 active task 记录 superseded_at/by', () => {
  const dir = mkTempDir();
  const img = path.join(dir, 'ref.jpg');
  fs.writeFileSync(img, 'x');
  const shot = shotBase('s01-shot-01', { image_paths: [img] });
  shot.input_hash = hashForShot(shot);
  writeManifest(dir, { episode: 'TEST', shots: [shot] });
  const r1 = createRenderTask(dir);
  const m = readManifest(dir);
  m.shots[0].prompt_final_en = 'p2';
  m.shots[0].input_hash = hashForShot(m.shots[0]);
  writeManifest(dir, m);
  const r2 = createRenderTask(dir);
  assert.notStrictEqual(r2.task.task_id, r1.task.task_id, 'must create a new task');
  const m2 = readManifest(dir);
  const oldTask = m2.render_tasks.find(t => t.task_id === r1.task.task_id);
  assert.strictEqual(oldTask.status, 'submitted', 'execution status unchanged (state/validity separation)');
  assert.ok(oldTask.superseded_at, 'old task must record superseded_at');
  assert.strictEqual(oldTask.superseded_by, r2.task.task_id, 'old task points to the new snapshot');
  assert.strictEqual(m2.render_tasks.length, 2);
});

test('W3e. 相对路径按项目 ROOT 解析(不依赖 cwd)', () => {
  const dir = mkTempDir();
  const shot = shotBase('s01-shot-01', { image_paths: ['package.json'] });
  shot.input_hash = hashForShot(shot);
  writeManifest(dir, { episode: 'TEST', shots: [shot] });
  const { task } = createRenderTask(dir);
  assert.strictEqual(task.image_src_paths[0], path.join(ROOT, 'package.json'));
  assert.ok(path.isAbsolute(task.image_paths[0]));
});

test('W3f. task.image_paths / out.image_paths 指向冻结副本', () => {
  const dir = mkTempDir();
  const img = path.join(dir, 'ref.jpg');
  fs.writeFileSync(img, 'x');
  const shot = shotBase('s01-shot-01', { image_paths: [img] });
  shot.input_hash = hashForShot(shot);
  writeManifest(dir, { episode: 'TEST', shots: [shot] });
  const { task, out } = createRenderTask(dir);
  assert.strictEqual(task.image_paths[0], task.image_refs[0].frozen_path);
  assert.strictEqual(out.image_paths[0], task.image_refs[0].frozen_path);
  assert.ok(fs.existsSync(task.image_paths[0]));
  assert.strictEqual(out.image_src_paths[0], img);
});

test('W3g. take_id 分配取已有 takes + render_tasks 数字后缀最大值 +1', () => {
  const shot = { id: 's01-shot-01', takes: [{ id: 'take-001' }, { id: 'take-003' }] };
  assert.strictEqual(computeNextTakeId(shot, []), 'take-004');
  const reserved = [{ shot_id: 's01-shot-01', take_id: 'take-005' }, { shot_id: 's01-shot-02', take_id: 'take-099' }];
  assert.strictEqual(computeNextTakeId(shot, reserved), 'take-006');
});

function seedTakeDir() {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'v.mp4');
  fs.writeFileSync(vfile, 'v');
  return { dir, vfile, catPath: path.join(dir, 'catalog.json') };
}
function readCatalog(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

test('W4a. 同一 task 连续两次 --take → catalog 只有 1 条', () => {
  const { dir, vfile, catPath } = seedTakeDir();
  writeManifest(dir, { episode: 'TEST',
    render_tasks: [{ task_id: 'task-aa', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: 'h1', status: 'submitted' }],
    shots: [shotBase('s01-shot-01', { input_hash: 'h1' })] });
  const opts = { action: 'take', path: vfile, taskId: 'task-aa' };
  let r = updateManifest(dir, 's01-shot-01', opts);
  appendCatalog(dir, 's01-shot-01', opts, r.manifest, r.createdTakeId, catPath);
  r = updateManifest(dir, 's01-shot-01', opts);
  appendCatalog(dir, 's01-shot-01', opts, r.manifest, r.createdTakeId, catPath);
  const cat = readCatalog(catPath).filter(e => e.shot_id === 's01-shot-01');
  assert.strictEqual(cat.length, 1, 'catalog must not duplicate on repeated callback');
});

test('W4b. 同 task 不同 path 二次回写 → 抛冲突', () => {
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
  throws(() => appendCatalog(dir, 's01-shot-01', { action: 'take', path: other, taskId: 'task-aa' }, r.manifest, r.createdTakeId, catPath), 'conflict');
});

test('W4c. review accept 自动选片 → manifest 与 catalog 均 selected,可恢复', () => {
  const { dir, vfile, catPath } = seedTakeDir();
  writeManifest(dir, { episode: 'TEST', shots: [shotBase('s01-shot-01', { input_hash: 'h1' })] });
  const r1 = updateManifest(dir, 's01-shot-01', { action: 'take', path: vfile });
  appendCatalog(dir, 's01-shot-01', { action: 'take', path: vfile }, r1.manifest, r1.createdTakeId, catPath);
  const r2 = updateManifest(dir, 's01-shot-01', { action: 'review', takeId: r1.createdTakeId, conclusion: 'accept' });
  appendCatalog(dir, 's01-shot-01', { action: 'review', takeId: r1.createdTakeId, conclusion: 'accept' }, r2.manifest, null, catPath);
  // manifest 侧
  assert.strictEqual(r2.manifest.shots[0].selected_take, r1.createdTakeId);
  assert.strictEqual(r2.manifest.shots[0].takes[0].status, 'selected');
  // catalog 侧
  const entries = readCatalog(catPath).filter(e => e.shot_id === 's01-shot-01');
  assert.strictEqual(entries[0].status, 'selected', 'catalog must sync selected');
  assert.ok(entries[0].human_review && entries[0].human_review.conclusion === 'accept');
  // 恢复
  const { selected_take } = recoverTakesFromCatalog('s01-shot-01', entries);
  assert.strictEqual(selected_take, r1.createdTakeId, 'recovery must restore selection');
});

test('W4d. review reject → catalog 置 rejected', () => {
  const { dir, vfile, catPath } = seedTakeDir();
  writeManifest(dir, { episode: 'TEST', shots: [shotBase('s01-shot-01', { input_hash: 'h1' })] });
  const r1 = updateManifest(dir, 's01-shot-01', { action: 'take', path: vfile });
  appendCatalog(dir, 's01-shot-01', { action: 'take', path: vfile }, r1.manifest, r1.createdTakeId, catPath);
  const r2 = updateManifest(dir, 's01-shot-01', { action: 'review', takeId: r1.createdTakeId, conclusion: 'reject' });
  appendCatalog(dir, 's01-shot-01', { action: 'review', takeId: r1.createdTakeId, conclusion: 'reject' }, r2.manifest, null, catPath);
  const entries = readCatalog(catPath).filter(e => e.shot_id === 's01-shot-01');
  assert.strictEqual(entries[0].status, 'rejected');
});

test('W4e. accept 但另有 selected → 只写 human_review,不抢选片', () => {
  const { dir, vfile, catPath } = seedTakeDir();
  const vfile2 = path.join(dir, 'v2.mp4');
  fs.writeFileSync(vfile2, 'v2');
  writeManifest(dir, { episode: 'TEST', shots: [shotBase('s01-shot-01', {
    input_hash: 'h1', selected_take: 'take-002',
    takes: [
      { id: 'take-001', path: vfile, input_hash: null, status: 'candidate' },
      { id: 'take-002', path: vfile2, input_hash: null, status: 'selected' }
    ]
  })] });
  fs.writeFileSync(catPath, JSON.stringify([
    { episode: 'TEST', shot_id: 's01-shot-01', take_id: 'take-001', path: vfile, status: 'candidate' },
    { episode: 'TEST', shot_id: 's01-shot-01', take_id: 'take-002', path: vfile2, status: 'selected' }
  ]));
  const r = updateManifest(dir, 's01-shot-01', { action: 'review', takeId: 'take-001', conclusion: 'accept' });
  appendCatalog(dir, 's01-shot-01', { action: 'review', takeId: 'take-001', conclusion: 'accept' }, r.manifest, null, catPath);
  const entries = readCatalog(catPath).filter(e => e.shot_id === 's01-shot-01');
  const e1 = entries.find(e => e.take_id === 'take-001');
  const e2 = entries.find(e => e.take_id === 'take-002');
  assert.strictEqual(e1.status, 'candidate', 'accepted-but-not-selected stays candidate');
  assert.ok(e1.human_review && e1.human_review.conclusion === 'accept');
  assert.strictEqual(e2.status, 'selected');
  assert.strictEqual(entries.filter(e => e.status === 'selected').length, 1);
});

test('W8a. nextTakeId 取数字后缀最大值 +1', () => {
  assert.strictEqual(nextTakeId([{ id: 'take-001' }, { id: 'take-003' }]), 'take-004');
  assert.strictEqual(nextTakeId([]), 'take-001');
  assert.strictEqual(nextTakeId([{ id: 'legacy-name' }]), 'take-001');
});

test('W8b. --take 避让 render_tasks 预留的 take_id', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'x.mp4');
  fs.writeFileSync(vfile, 'x');
  writeManifest(dir, { episode: 'TEST',
    render_tasks: [{ task_id: 'task-aa', shot_id: 's01-shot-01', take_id: 'take-002', input_hash: 'h1', status: 'submitted' }],
    shots: [shotBase('s01-shot-01')] });
  const { manifest, createdTakeId } = updateManifest(dir, 's01-shot-01', { action: 'take', path: vfile });
  assert.notStrictEqual(createdTakeId, 'take-002', 'must not reuse reserved take_id');
  assert.strictEqual(createdTakeId, 'take-003');
  assert.ok(manifest.shots[0].takes.some(t => t.id === 'take-003'));
});
