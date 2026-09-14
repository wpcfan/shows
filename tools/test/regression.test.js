#!/usr/bin/env node
/**
 * regression.test.js — 隔离回归测试
 *
 * 覆盖用户指出的失败场景:
 *   1. 审核拒绝但 hash 匹配 → validateTake 必须拒绝
 *   2. 审核通过但 input 变了 → 拒绝
 *   3. 无审核 hash 匹配 → 通过;hash 不匹配 → 拒绝
 *   4. status=rejected → 拒绝
 *   5. 旧时间线可重导:被取消选片的 reviewed-accept take 仍可导出(指针与结论分离)
 *   6. mark-shot 无 --task → input_hash=null(来源未知)
 *   7. mark-shot --task 绑定错误 shot → 抛错
 *   8. mark-shot 重复回写同一 task → 幂等,不创建新 take
 *   9. render-next 连续调用同一 shot → 幂等返回同一任务(不重复 take_id)
 *   10. render-next 参考图缺失 → 提交被阻止
 *   11. render-next 参考图冻结:提交后替换原图,任务记录与冻结副本不变
 *   12. compareShotList:删镜/加镜/换序 → 检测
 *   13. recoverTakesFromCatalog:保留 rejected + human_review,报告冲突
 *   14. PRD v2.3 §3.0 M0-4:原子写故障注入(注入点可配)+ 重启读侧清理 tmp + 损坏文件识别
 *   15. PRD v2.3 §3.0 M0-5:stale callback 不污染 selected state,记 superseded take
 *   16. PRD v2.3 §3.0 M0-3:manifest/catalog 冲突报错必须带恢复指引
 *
 * 全程使用 os.tmpdir,不触碰制作数据。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { spawnSync } = require('child_process');

const { validateTake, validateTimePoint, escapeConcatPath, collectBlockedShotErrors, collectEditApprovalProblems } = require('../edit-episode');
const { updateManifest, appendCatalog, nextTakeId, recordTaskFailure, parseArgs: markShotParseArgs } = require('../mark-shot');
const { updateKeyframeManifest, appendKeyframeCatalog, nextKeyframeTakeId } = require('../mark-keyframe');
const { resolveCover, generateCover } = require('../cover');
const SUB = require('../subtitles');
const { createRenderTask, fileContentHash, computeNextTakeId, computeNextTtsTakeId, collectRetryWaits, targetStage } = require('../render-next');
const {
  compareShotList, recoverTakesFromCatalog, deriveStatus, verifyManifestFreshness, resolveSelectionConflict,
  atomicWriteJson, readJsonFile, readJsonFileOrNull, SimulatedCrashError, CorruptJsonError,
  resolveEpisodeRatio, resolveShotRatio, findRatioViolations, normalizeTaskStatus,
  ACTIVE_TASK_STATUSES, TERMINAL_TASK_STATUSES, isTaskSuperseded, isActiveTaskStatus, hardFailureTaskCount,
  classifyError, appendTaskEvent, countAttempts, failedTaskCycles, computeRetryDelay, evaluateBreaker,
  computeInputHash, canonicalJson, computeStagePayloadHash, computeShotKeyframeHash, computeShotVideoHash,
  styleGuideFileDigest, resolveEpisodeFps, validateContinueFrom, secondsToFrames: bmSecondsToFrames,
  estimateDialogueSeconds, resolveTtsConfig, normalizeDialogue, resolveVoiceId, DEFAULT_TTS_PROVIDER
} = require('../build-manifest');
const {
  emptyLedger, recordOutcome, computeCostPerAcceptedVideoShot, ledgerReport,
  countAcceptedVideoShots, validateCost, ensureLedger
} = require('../quota-ledger');
const {
  buildReport, bootstrapDiffCI, median, buildClusters, checkPreregistration,
  formatReportText, E1RefusalError, MIN_LAYER_SAMPLES,
  DEFAULT_PREPROCESSING, checkMetricMetadata
} = require('../e1-report');
const { collectFinalValidationErrors, collectFinalShotProblems, collectFinalApprovalProblems } = require('../stitch-episode');
const {
  validateApprovals, collectApprovalProblems, checkApprovalsForEpisode,
  isPassVerdict, isVerdictValue, isApprovalKind, resolveAcceptUpstreamCutFrame
} = require('../approvals');
const { ROOT, loadYaml } = require('../build-prompt');
const {
  resolveTimelineFps, secondsToFrames, msToFrames, buildTimeline, validateTimeline
} = require('../build-timeline');
const {
  selectDialogueTake, resolveDialogueTiming, overflowFrames, decideOverflow,
  clipOutputFrames, checkSpillConstraints, trimDialogue, collectUnresolvedOverflow
} = require('../dialogue');
const { extractTailFrame, probeDurationSec } = require('../tail-frame');
const {
  decideDeletedHeadFrames, extractFrameAt, compareJunctionFrames, cfrNormalizeArgs
} = require('../junction');
const {
  withLock, acquireLockOnce, tryReclaim, lockPathFor
} = require('../lock');
const {
  detectDialogue, deriveIntent, validateIntent, intentFlags, AUDIO_VALUES, SUBTITLE_VALUES
} = require('../intent');
const {
  parseProbeJson, probeMedia, expectedVideoSpec, checkMediaSpec, verifyDecode,
  checkAvLength, verifyFinalMedia
} = require('../probe');
const { parseDoubaoStream, synthDoubao, classifyTtsError } = require('../tts-api-doubao');
const { runTts, parseArgs: ttsParseArgs, loadEnvFile, listTtsTasks } = require('../tts');
const {
  clipRenderArgs: finClipRenderArgs, renderFinal: finRenderFinal,
  detectRenderMode: finDetectRenderMode, determinismDigests: finDeterminismDigests,
  MODE_LINE_V1: FIN_MODE_LINE_V1, MODE_LINE_V2: FIN_MODE_LINE_V2,
} = require('../render-final');
const determinismCli = require('../determinism');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
function throws(fn, msgSubstr) {
  let threw = false;
  try { fn(); } catch (e) { threw = true; if (msgSubstr && !e.message.includes(msgSubstr)) throw new Error(`expected error containing "${msgSubstr}", got "${e.message}"`); }
  if (!threw) throw new Error(`expected to throw${msgSubstr ? ` containing "${msgSubstr}"` : ''}, but did not`);
}
// 异步用例(TTS adapter / tts.js 走 Promise):在文件末尾统一 await,保证计数与退出码正确。
const asyncTests = [];
function testAsync(name, fn) { asyncTests.push({ name, fn }); }
async function throwsAsync(fn, msgSubstr) {
  let threw = false;
  try { await fn(); } catch (e) { threw = true; if (msgSubstr && !e.message.includes(msgSubstr)) throw new Error(`expected error containing "${msgSubstr}", got "${e.message}"`); }
  if (!threw) throw new Error(`expected to reject${msgSubstr ? ` containing "${msgSubstr}"` : ''}, but did not`);
}

// --- 临时 episode 工厂 ---
function mkTempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shows-test-'));
  return d;
}
function writeManifest(dir, manifest) {
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}
function readManifest(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
}
function shotBase(id, opts = {}) {
  return Object.assign({
    id, scene: 's01', description_cn: 'test',
    prompt_final_en: 'p', input_hash: 'h1', prev_hash: null,
    duration: 10, ratio: '16:9', resolution: '720p', model: 'default',
    image_paths: [], takes: [], selected_take: null,
    output_path: null, status: 'pending', rendered_at: null, error: null, retries: 0
  }, opts);
}

// ============================================================
console.log('\n[validateTake] 审核与 hash 规则');
// ============================================================

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
  validateTake(shot, take); // 不抛即通过
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
  // take-001 审核 accept 且 hash 匹配,但后来选了 take-002,被降为 candidate
  const shot = shotBase('s01-shot-01', { input_hash: 'h1', selected_take: 'take-002' });
  const take001 = { id: 'take-001', status: 'candidate', input_hash: 'h1',
    human_review: { conclusion: 'accept', reviewed_input_hash: 'h1', reviewed_at: 'now' } };
  validateTake(shot, take001); // 不应因 status!=selected 抛错
});

// ============================================================
console.log('\n[mark-shot] 无 task / 绑定 / 幂等');
// ============================================================

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
  // 第一次回写
  updateManifest(dir, 's01-shot-01', { action: 'take', path: vfile, taskId: 'task-aa' });
  let m = readManifest(dir);
  assert.strictEqual(m.shots[0].takes.length, 1);
  assert.strictEqual(m.render_tasks[0].status, 'succeeded');
  // 第二次回写(模拟重复)→ 幂等
  updateManifest(dir, 's01-shot-01', { action: 'take', path: vfile, taskId: 'task-aa' });
  m = readManifest(dir);
  assert.strictEqual(m.shots[0].takes.length, 1, 'must not create a second take');
});

// ============================================================
console.log('\n[render-next] 参考图冻结 + 幂等');
// ============================================================

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

// ============================================================
console.log('\n[compareShotList] 删镜 / 加镜 / 换序');
// ============================================================

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

// ============================================================
console.log('\n[recoverTakesFromCatalog] 保留 rejected + human_review + 冲突');
// ============================================================

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

// ============================================================
console.log('\n[deriveStatus] 审核拒绝不产生 done');
// ============================================================

test('14. selected take 审核 reject → stale(不 done)', () => {
  const shot = {
    input_hash: 'h1', selected_take: 'take-001', prev_hash: null,
    takes: [{ id: 'take-001', input_hash: 'h1', status: 'rejected',
      human_review: { conclusion: 'reject', reviewed_input_hash: 'h1' } }]
  };
  const { status } = deriveStatus(shot, 'h1', null);
  assert.strictEqual(status, 'stale');
});

// ============================================================
console.log('\n[W1] reject 终态不可复活');
// ============================================================

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

// ============================================================
console.log('\n[W2] stitch --final 复用 validateTake + preview 结构告警');
// ============================================================

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

// ============================================================
console.log('\n[W3] render-next 按 task 冻结参考图 + 冻结路径为实际输入');
// ============================================================

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

// ============================================================
console.log('\n[W4] catalog 幂等 upsert + manifest/catalog 状态同步');
// ============================================================

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

// ============================================================
console.log('\n[W5] shell 注入防护:参数校验 + execFileSync');
// ============================================================

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

// ============================================================
console.log('\n[W6] deriveStatus 与 reject 优先级一致');
// ============================================================

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

// ============================================================
console.log('\n[W7] 结构冲突与恢复冲突上报');
// ============================================================

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

// ============================================================
console.log('\n[W8] take_id 分配与保留 ID 避让');
// ============================================================

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

// ============================================================
console.log('\n[M0-4] 原子写故障注入 + 重启读侧(tmp 清理/损坏识别)');
// ============================================================

function tmpResidue(dir) {
  return fs.readdirSync(dir).filter(n => n.endsWith('.tmp'));
}

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
console.log('\n[M0-5] stale callback 不污染 selected state');
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
console.log('\n[M0-3] manifest/catalog 冲突报错带恢复指引');
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
console.log('\n[M1-A] §3.7 画幅两级收敛');
// ============================================================

function ratioScript(extra = [], defaultsRatio = "'16:9'") {
  return [
    'episode: RTEST', 'title: T', 'defaults:', '  duration: 8', `  ratio: ${defaultsRatio}`, "  resolution: '720p'", "  model: 'default'",
    ...extra,
    'scenes:', '  - id: s01', '    shots:',
    '      - id: s01-shot-01', "        style_en: 'cinematic'", "        prompt_en: 'a'", ''
  ].join('\n');
}

function ratioScriptWithShotRatio(shotRatio, extraTop = []) {
  return [
    'episode: RTEST', 'title: T', 'defaults:', '  duration: 8', "  ratio: '16:9'", "  resolution: '720p'", "  model: 'default'",
    ...extraTop,
    'scenes:', '  - id: s01', '    shots:',
    '      - id: s01-shot-01', "        style_en: 'cinematic'", "        prompt_en: 'a'", `        ratio: ${shotRatio}`, ''
  ].join('\n');
}

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
console.log('\n[M1-B] §3.5 任务状态模型 + 唯一性');
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
console.log('\n[M1-C] §3.5 attempt 事件流');
// ============================================================

function seedTaskDir(overrides = {}) {
  const dir = mkTempDir();
  writeManifest(dir, {
    episode: 'TEST',
    render_tasks: [Object.assign({ task_id: 'task-x', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: 'h1', status: 'submitted', stage: 'video', breaker_epoch: 0 }, overrides)],
    shots: [shotBase('s01-shot-01', { input_hash: 'h1', breaker_epoch: 0 })]
  });
  return dir;
}

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
console.log('\n[M1-D] §3.5 熔断三维度 + breaker_epoch');
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
console.log('\n[M1-E] 集成:stitch blocked 处理');
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
console.log('\n[M1-F] §4 配额账本(quota ledger)');
// ============================================================

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

// ============================================================
console.log('\n[M1-G] §3.1 E1 统计契约(合成数据,不造假结论)');
// ============================================================

const E1_LAYERS = ['closeup', 'wide', 'empty', 'motion'];

/** A7:度量与预处理元数据契约(PRD §3.1 写死口径) */
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

/** 深拷贝 metrics 覆盖某个嵌套字段(便于构造缺失/非法元数据) */
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

/**
 * 合成 E1 数据集:byCluster(layer, sceneIdx, promptIdx) → { A, B, C } 的 SSIM 值。
 * 同一 cluster 内不同 seed 使用相同值(cluster 内重复观测),便于断言 cluster 语义。
 */
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
  // motion 层每 group 仅保留 6 条(seed 100)→ 少于 MIN_LAYER_SAMPLES(10)
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
  // CLI 拒绝(非零退出)
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
  assert.strictEqual(cb.size, 6, '3 scenes × 2 prompts within one layer');
  assert.strictEqual(cd.size, cb.size, 'cluster count independent of seeds-per-cluster');
  assert.strictEqual(cd.get([...cb.keys()][0]).length, 18, '6 seeds × 3 groups inside one cluster');
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

function truncate(s) { return String(s).slice(0, 600); }

// ============================================================
console.log('\n[A7] E1 绝对质量门槛 + 预处理/度量口径');
// ============================================================

test('A7a. 缺 ssim_abs_min → 预注册缺失:checkPreregistration 列出 / buildReport 抛 E1RefusalError / CLI 退出码 2', () => {
  const ds = e1Dataset({ byCluster: () => ({ A: 0.9, B: 0.6, C: 0.6 }), metaExtra: { ssim_abs_min: undefined } });
  assert.ok(checkPreregistration(ds.meta).includes('ssim_abs_min'), 'ssim_abs_min must be part of the frozen preregistration');
  let err = null;
  try { buildReport(ds, { generated_at: 'T' }); } catch (e) { err = e; }
  assert.ok(err instanceof E1RefusalError, `must refuse without a frozen absolute threshold, got ${err && err.message}`);
  assert.ok(/ssim_abs_min/.test(err.message), err.message);
  assert.ok(/delta_preregistered/.test(err.message), 'refusal text must still demand Δ');
  // CLI 拒绝(退出码 2)
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
  // 整个 preprocessing 缺失 → 全量缺省补齐
  const noPre = e1Dataset({
    byCluster: () => ({ A: 0.9, B: 0.6, C: 0.6 }),
    metaExtra: { metrics: e1MetricsWith({ ssim: { preprocessing: undefined } }) }
  });
  const r2 = buildReport(noPre, { generated_at: 'T' });
  assert.deepStrictEqual(r2.metrics.ssim.preprocessing, DEFAULT_PREPROCESSING);
  assert.ok(r2.incomplete_reasons.some(x => /preprocessing/.test(x)), r2.incomplete_reasons.join(' | '));
  // 声明的 ssim 与 secondary 照实回显
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

// ============================================================
console.log('\n[R2] 评审修复批次:P0-1 / P1-1..P1-5 / P2-late');
// ============================================================

// ---- R2-P0-1: review accept 不得洗白 superseded 产物 ----

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
console.log('\n[R3] 复核批次 2:P1-N1 + P2-N1/N2/N3/N5');
// ============================================================

function busyWaitMs(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { /* spin */ }
}

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
console.log('\n[M1-TL] timeline core');
// ============================================================

const approx = (a, b, eps = 1e-9) => { assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`); };
function tlManifest(shots, extra = {}) { return Object.assign({ episode: 'TEST', shots }, extra); }

// --- 纯函数: fps 解析 ---

test('TL1. resolveTimelineFps 优先级: edit.timeline.fps > manifest.fps > 30', () => {
  assert.strictEqual(resolveTimelineFps({ timeline: { fps: 24 } }, { fps: 25 }), 24);
  assert.strictEqual(resolveTimelineFps({ timeline: { fps: 24 } }, {}), 24);
  assert.strictEqual(resolveTimelineFps({}, { fps: 25 }), 25);
  assert.strictEqual(resolveTimelineFps({ timeline: [] }, { fps: 25 }), 25, '数组 timeline 无 fps → 用 manifest');
  assert.strictEqual(resolveTimelineFps({}, {}), 30);
  assert.strictEqual(resolveTimelineFps(undefined, undefined), 30);
});

test('TL2. resolveTimelineFps 非法值抛错, null 视为缺省', () => {
  throws(() => resolveTimelineFps({ timeline: { fps: 0 } }, {}), 'positive integer');
  throws(() => resolveTimelineFps({ timeline: { fps: -24 } }, {}), 'positive integer');
  throws(() => resolveTimelineFps({ timeline: { fps: 23.976 } }, {}), 'positive integer');
  throws(() => resolveTimelineFps({ timeline: { fps: '24' } }, {}), 'positive integer');
  throws(() => resolveTimelineFps({}, { fps: 1.5 }), 'positive integer');
  assert.strictEqual(resolveTimelineFps({}, { fps: null }), 30, 'null fps 视为缺省');
  assert.strictEqual(resolveTimelineFps({ timeline: { fps: null } }, { fps: 25 }), 25);
});

// --- 纯函数: 秒/毫秒 → 帧 ---

test('TL3. secondsToFrames 取整与残余(精确 + 非精确)', () => {
  const exact = secondsToFrames(1.5, 24);
  assert.strictEqual(exact.frames, 36);
  approx(exact.residual, 0);
  const inexact = secondsToFrames(1.234, 24);
  assert.strictEqual(inexact.frames, 30);
  approx(inexact.residual, -0.016);
  assert.deepStrictEqual(secondsToFrames(0, 24), { frames: 0, residual: 0 });
  throws(() => secondsToFrames(-0.1, 24), 'finite');
  throws(() => secondsToFrames(NaN, 24), 'finite');
  throws(() => secondsToFrames(Infinity, 24), 'finite');
  throws(() => secondsToFrames(1, 0), 'positive integer');
  throws(() => secondsToFrames(1, 23.976), 'positive integer');
});

test('TL4. msToFrames 换算与残余', () => {
  assert.deepStrictEqual(msToFrames(500, 24), { frames: 12, residual: 0 });
  const r = msToFrames(340, 24);
  assert.strictEqual(r.frames, 8);
  approx(r.residual, 0.34 - 8 / 24);
  throws(() => msToFrames(-1, 24), 'finite');
  throws(() => msToFrames(1, 24.5), 'positive integer');
});

// --- buildTimeline: 秒制 ---

test('TL5. 秒制构建: 半开区间/时长口径/output 连续/记录换算残余', () => {
  const manifest = tlManifest([
    { id: 'shotA', takes: [{ id: 'take-001' }] },
    { id: 'shotB', takes: [{ id: 'take-001' }] }
  ], { fps: 24 });
  const edit = { timeline: [
    { shot_id: 'shotA', take_id: 'take-001', in_point: 0, out_point: 2 },
    { shot_id: 'shotB', take_id: 'take-001', in_point: 0.5, out_point: 3 }
  ] };
  const tl = buildTimeline({ edit, manifest });
  assert.strictEqual(tl.version, 1);
  assert.strictEqual(tl.fps, 24);
  const [c1, c2] = tl.clips;
  assert.strictEqual(c1.source_in, 0);
  assert.strictEqual(c1.source_out, 48);
  assert.strictEqual(c1.output_start, 0);
  assert.strictEqual(c1.output_end, 48);
  assert.strictEqual(c1.output_end - c1.output_start, c1.source_out - c1.source_in);
  assert.ok(c1.conversion_residuals && Number.isFinite(c1.conversion_residuals.source_in_sec));
  assert.strictEqual(c2.source_in, 12);
  assert.strictEqual(c2.source_out, 72);
  assert.strictEqual(c2.output_start, 48);
  assert.strictEqual(c2.output_end, 108);
  assert.strictEqual(c2.output_end - c2.output_start, c2.source_out - c2.source_in);
  assert.ok(c2.conversion_residuals);
  // 缺省 in_point = 0
  const tl2 = buildTimeline({ edit: { timeline: [{ shot_id: 'shotA', take_id: 'take-001', out_point: 1 }] }, manifest });
  assert.strictEqual(tl2.clips[0].source_in, 0);
});

test('TL6. 秒制 out_point 缺省取 sourceDurations, 再缺省抛错', () => {
  const manifest = tlManifest([{ id: 'shotA', takes: [{ id: 'take-001' }] }], { fps: 24 });
  const edit = { timeline: [{ shot_id: 'shotA', take_id: 'take-001', in_point: 0 }] };
  const tl = buildTimeline({ edit, manifest, sourceDurations: { shotA: 2.5 } });
  assert.strictEqual(tl.clips[0].source_out, 60);
  throws(() => buildTimeline({ edit, manifest, sourceDurations: {} }), 'out_point');
});

// --- buildTimeline: 帧原生 ---

test('TL7. 帧原生构建: 精确保留帧号, conversion_residuals 为 null', () => {
  const manifest = tlManifest([{ id: 'shotA', takes: [{ id: 'take-001' }] }], { fps: 24 });
  const tl = buildTimeline({ edit: { timeline: [{ shot_id: 'shotA', take_id: 'take-001', source_in: 10, source_out: 40 }] }, manifest });
  const c = tl.clips[0];
  assert.strictEqual(c.source_in, 10);
  assert.strictEqual(c.source_out, 40);
  assert.strictEqual(c.conversion_residuals, null);
  assert.strictEqual(c.output_start, 0);
  assert.strictEqual(c.output_end, 30);
});

test('TL8. deleted_head_frames / padding_frames 对输出时长的口径', () => {
  const manifest = tlManifest([{ id: 'shotA', takes: [{ id: 'take-001' }] }], { fps: 24 });
  const edit = { timeline: [
    { shot_id: 'shotA', take_id: 'take-001', source_in: 0, source_out: 100, deleted_head_frames: 10, padding_frames: 5 },
    { shot_id: 'shotA', take_id: 'take-001', source_in: 0, source_out: 10, padding_frames: 4 }
  ] };
  const tl = buildTimeline({ edit, manifest });
  assert.strictEqual(tl.clips[0].output_end - tl.clips[0].output_start, 95);
  assert.strictEqual(tl.clips[0].deleted_head_frames, 10);
  assert.strictEqual(tl.clips[0].padding_frames, 5);
  assert.strictEqual(tl.clips[1].output_end - tl.clips[1].output_start, 14);
  assert.strictEqual(tl.clips[1].output_start, 95);
});

test('TL9. 同一 take 两次引用 → 两个独立 clip 实例', () => {
  const manifest = tlManifest([{ id: 'shotA', takes: [{ id: 'take-001' }] }], { fps: 24 });
  const edit = { timeline: [
    { shot_id: 'shotA', take_id: 'take-001', source_in: 0, source_out: 24 },
    { shot_id: 'shotA', take_id: 'take-001', source_in: 0, source_out: 12 }
  ] };
  const tl = buildTimeline({ edit, manifest });
  assert.strictEqual(tl.clips.length, 2);
  assert.strictEqual(tl.clips[0].clip_id, 'clip-0001');
  assert.strictEqual(tl.clips[1].clip_id, 'clip-0002');
  assert.deepStrictEqual([tl.clips[0].output_start, tl.clips[0].output_end], [0, 24]);
  assert.deepStrictEqual([tl.clips[1].output_start, tl.clips[1].output_end], [24, 36]);
  assert.strictEqual(tl.clips[0].source_out, 24);
  assert.strictEqual(tl.clips[1].source_out, 12, '第二个 clip 不得继承第一个');
});

test('TL10. 自定义 clip_id 全表唯一, 重复抛错', () => {
  const manifest = tlManifest([{ id: 'shotA', takes: [{ id: 'take-001' }] }], { fps: 24 });
  const tl = buildTimeline({ edit: { timeline: [
    { clip_id: 'intro', shot_id: 'shotA', take_id: 'take-001', source_in: 0, source_out: 5 },
    { clip_id: 'main', shot_id: 'shotA', take_id: 'take-001', source_in: 0, source_out: 5 }
  ] }, manifest });
  assert.strictEqual(tl.clips[0].clip_id, 'intro');
  assert.strictEqual(tl.clips[1].clip_id, 'main');
  throws(() => buildTimeline({ edit: { timeline: [
    { clip_id: 'dup', shot_id: 'shotA', take_id: 'take-001', source_in: 0, source_out: 5 },
    { clip_id: 'dup', shot_id: 'shotA', take_id: 'take-001', source_in: 0, source_out: 5 }
  ] }, manifest }), 'duplicate');
});

// --- buildTimeline: 错误矩阵 ---

test('TL11. 错误矩阵: 缺 shot/take, 空 timeline, 帧非法, deleted/padding 越界', () => {
  const manifest = tlManifest([{ id: 'shotA', takes: [{ id: 'take-001' }] }], { fps: 24 });
  const build = (timeline) => buildTimeline({ edit: { timeline }, manifest });
  throws(() => build([]), 'non-empty');
  throws(() => buildTimeline({ edit: {}, manifest }), 'non-empty');
  throws(() => build([{ shot_id: 'nope', take_id: 'take-001', source_in: 0, source_out: 5 }]), 'shot_id');
  throws(() => build([{ shot_id: 'shotA', take_id: 'nope', source_in: 0, source_out: 5 }]), 'take_id');
  throws(() => build([{ shot_id: 'shotA', source_in: 0, source_out: 5 }]), 'take_id');
  throws(() => build([{ take_id: 'take-001', source_in: 0, source_out: 5 }]), 'shot_id');
  throws(() => build([{ shot_id: 'shotA', take_id: 'take-001', source_in: -1, source_out: 5 }]), 'non-negative integer');
  throws(() => build([{ shot_id: 'shotA', take_id: 'take-001', source_in: 1.5, source_out: 5 }]), 'non-negative integer');
  throws(() => build([{ shot_id: 'shotA', take_id: 'take-001', source_in: 5, source_out: 5 }]), 'source_in');
  throws(() => build([{ shot_id: 'shotA', take_id: 'take-001', source_in: 6, source_out: 5 }]), 'source_in');
  throws(() => build([{ shot_id: 'shotA', take_id: 'take-001', source_in: 0, source_out: 10, deleted_head_frames: 11 }]), 'deleted_head_frames');
  throws(() => build([{ shot_id: 'shotA', take_id: 'take-001', source_in: 0, source_out: 5, deleted_head_frames: 5 }]), 'duration');
  throws(() => build([{ shot_id: 'shotA', take_id: 'take-001', source_in: 0, source_out: 5, padding_frames: -1 }]), 'padding_frames');
});

test('TL12. spill_in 默认 [] 且结构校验', () => {
  const manifest = tlManifest([{ id: 'shotA', takes: [{ id: 'take-001' }] }], { fps: 24 });
  const base = { shot_id: 'shotA', take_id: 'take-001', source_in: 0, source_out: 10 };
  const build = (entry) => buildTimeline({ edit: { timeline: [entry] }, manifest });
  assert.deepStrictEqual(build(base).clips[0].spill_in, []);
  const tl = build(Object.assign({}, base, { spill_in: [{ dialogue: 'd01', ms: 340 }] }));
  assert.deepStrictEqual(tl.clips[0].spill_in, [{ dialogue: 'd01', ms: 340 }]);
  throws(() => build(Object.assign({}, base, { spill_in: 'x' })), 'spill_in');
  throws(() => build(Object.assign({}, base, { spill_in: [{ ms: 10 }] })), 'dialogue');
  throws(() => build(Object.assign({}, base, { spill_in: [{ dialogue: 'd', ms: -1 }] })), 'ms');
  throws(() => build(Object.assign({}, base, { spill_in: [{ dialogue: 'd', ms: Infinity }] })), 'ms');
});

test('TL13. 确定性: 两次 buildTimeline 结果 deep-equal(无时间戳)', () => {
  const manifest = tlManifest([
    { id: 'shotA', takes: [{ id: 'take-001' }] },
    { id: 'shotB', takes: [{ id: 'take-001' }] }
  ], { fps: 24 });
  const edit = { timeline: [
    { shot_id: 'shotA', take_id: 'take-001', in_point: 0.123, out_point: 1.987 },
    { shot_id: 'shotB', take_id: 'take-001', source_in: 3, source_out: 21, padding_frames: 2 }
  ] };
  assert.deepStrictEqual(buildTimeline({ edit, manifest }), buildTimeline({ edit, manifest }));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(buildTimeline({ edit, manifest }))), buildTimeline({ edit, manifest }));
});

// --- validateTimeline ---

test('TL14. validateTimeline 检出篡改的连续性/时长/重复 clip_id', () => {
  const manifest = tlManifest([{ id: 'shotA', takes: [{ id: 'take-001' }] }], { fps: 24 });
  const edit = { timeline: [
    { shot_id: 'shotA', take_id: 'take-001', source_in: 0, source_out: 24 },
    { shot_id: 'shotA', take_id: 'take-001', source_in: 0, source_out: 12 }
  ] };
  const tl = buildTimeline({ edit, manifest });
  const okRes = validateTimeline(tl);
  assert.strictEqual(okRes.ok, true);
  assert.deepStrictEqual(okRes.errors, []);

  const gap = JSON.parse(JSON.stringify(tl));
  gap.clips[1].output_start = 30;
  gap.clips[1].output_end = 42;
  const r1 = validateTimeline(gap);
  assert.strictEqual(r1.ok, false);
  assert.ok(r1.errors.some(e => e.includes('contiguous')), JSON.stringify(r1.errors));

  const durTamper = JSON.parse(JSON.stringify(tl));
  durTamper.clips[0].output_end = 25;
  const r2 = validateTimeline(durTamper);
  assert.strictEqual(r2.ok, false);
  assert.ok(r2.errors.some(e => e.includes('duration')), JSON.stringify(r2.errors));

  const dup = JSON.parse(JSON.stringify(tl));
  dup.clips[1].clip_id = dup.clips[0].clip_id;
  const r3 = validateTimeline(dup);
  assert.strictEqual(r3.ok, false);
  assert.ok(r3.errors.some(e => e.includes('duplicate clip_id')), JSON.stringify(r3.errors));

  const badFrame = JSON.parse(JSON.stringify(tl));
  badFrame.clips[0].source_in = 1.5;
  assert.strictEqual(validateTimeline(badFrame).ok, false);

  assert.strictEqual(validateTimeline({ version: 1, fps: 24, clips: [] }).ok, false);
  assert.strictEqual(validateTimeline(null).ok, false);
});

// --- CLI 集成(临时 episode 目录, 显式 out_point → 不跑 ffmpeg) ---

const TL_CLI = path.resolve(__dirname, '..', 'build-timeline.js');
const TL_EDIT_YAML = [
  'output:',
  '  fps: 24',
  'timeline:',
  '  - shot_id: s01-shot-01',
  '    take_id: take-001',
  '    in_point: 0.0',
  '    out_point: 2.0',
  '  - shot_id: s01-shot-02',
  '    take_id: take-001',
  '    in_point: 1.0',
  '    out_point: 3.0',
  ''
].join('\n');
const TL_TEST_MANIFEST = { episode: 'TEST', fps: 24, shots: [
  { id: 's01-shot-01', takes: [{ id: 'take-001' }] },
  { id: 's01-shot-02', takes: [{ id: 'take-001' }] }
] };
function mkTimelineEpisode() {
  const dir = mkTempDir();
  writeManifest(dir, TL_TEST_MANIFEST);
  fs.writeFileSync(path.join(dir, 'edit.yaml'), TL_EDIT_YAML);
  return dir;
}

test('TL15. CLI 写出 timeline.json 且与核心一致; --dry-run 不落盘', () => {
  const expected = buildTimeline({ edit: {
    timeline: [
      { shot_id: 's01-shot-01', take_id: 'take-001', in_point: 0, out_point: 2 },
      { shot_id: 's01-shot-02', take_id: 'take-001', in_point: 1, out_point: 3 }
    ]
  }, manifest: TL_TEST_MANIFEST });

  const dir = mkTimelineEpisode();
  const r = spawnSync(process.execPath, [TL_CLI, dir], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const written = readJsonFile(path.join(dir, 'timeline.json'));
  assert.deepStrictEqual(written, expected);

  const dir2 = mkTimelineEpisode();
  const r2 = spawnSync(process.execPath, [TL_CLI, dir2, '--dry-run'], { encoding: 'utf8' });
  assert.strictEqual(r2.status, 0, r2.stderr);
  assert.ok(!fs.existsSync(path.join(dir2, 'timeline.json')), '--dry-run 不得落盘');
  assert.deepStrictEqual(JSON.parse(r2.stdout), expected);
});

test('TL16. CLI --out 覆盖输出路径', () => {
  const dir = mkTimelineEpisode();
  const outPath = path.join(mkTempDir(), 'nested', 'custom-timeline.json');
  const r = spawnSync(process.execPath, [TL_CLI, dir, '--out', outPath], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(outPath));
  assert.ok(!fs.existsSync(path.join(dir, 'timeline.json')), '--out 不得回退到默认路径');
  assert.deepStrictEqual(readJsonFile(outPath), buildTimeline({ edit: {
    timeline: [
      { shot_id: 's01-shot-01', take_id: 'take-001', in_point: 0, out_point: 2 },
      { shot_id: 's01-shot-02', take_id: 'take-001', in_point: 1, out_point: 3 }
    ]
  }, manifest: TL_TEST_MANIFEST }));
});

// ============================================================
console.log('\n[M2-MG] migrate/episode schema 1→2');
// ============================================================

const {
  migrateEpisode, migrateScriptData, migrateManifestData, migrateCatalogData, schemaFinalNotice
} = require('../migrate-episode');
const { schemaFinalNotice: schemaFinalNoticeFromStitch } = require('../stitch-episode');

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
    seriesPath: path.join(dir, 'series.yaml') // nonexistent → episode ratio resolves from the script
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
console.log('\n[DEBT] D2/D3/D5/D6/D7/D8 批次(先红后绿)');
// ============================================================

// ---- D2: cache_hits 每 task 至多一次 ----

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
console.log('\n[A-BATCH] 任务状态批次 A1/A2/A9/A10');
// ============================================================

function a9Manifest(dir) {
  const vfile = path.join(dir, 'v.mp4');
  fs.writeFileSync(vfile, 'v');
  writeManifest(dir, { episode: 'TEST',
    render_tasks: [{ task_id: 'task-x', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: 'h1', status: 'submitted', stage: 'video', breaker_epoch: 0, current_attempt_id: 'att-aaaa1111',
      // FIX6b:真实派发一定落一条 attempt(旧夹具无 attempts 时靠 detached legacy 对象,
      // 会让同一 attempt_id 被多个 request 借用;改为持久化 attempt 以守住一 attempt ↔ 一 request)
      attempts: [{ attempt_id: 'att-aaaa1111', at: '2026-01-01T00:00:00.000Z', input_hash: 'h1', request_id: null }] }],
    shots: [shotBase('s01-shot-01', { input_hash: 'h1', breaker_epoch: 0 })] });
  return { dir, vfile };
}

// ---- A2: 执行状态与有效期分离 + reuse_records ----

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
console.log('\n[FIX3] 溯源/身份复核修复回归(F1/F2/F3)');
// ============================================================

/**
 * [FIX3][A8] 按 shot 的真实输入计算 video-stage fingerprint。
 * §3.8/A8:改用 `computeShotVideoHash`(含 selected keyframe 的文件 digest 与 style-guide digest),
 * 无 keyframe 场景等价于旧的路径输入 hash。
 * 相对路径按项目 ROOT 解析(与 render-next.resolveInputPath 同口径)。
 */
function resolvedShotPaths(shot) {
  return (shot.image_paths || []).map(p => (path.isAbsolute(p) ? p : path.resolve(ROOT, p)));
}

/** selected keyframe 的文件内容 digest(rejected/superseded 不算;无文件返回 null) */
function selectedKeyframeFileDigest(shot) {
  if (!shot.selected_keyframe) return null;
  const kf = (shot.keyframe_takes || []).find(t => t && t.id === shot.selected_keyframe);
  if (!kf || kf.status === 'rejected' || kf.status === 'superseded' || !kf.path) return null;
  return fileContentHash(path.isAbsolute(kf.path) ? kf.path : path.resolve(ROOT, kf.path));
}

function keyframeHashForShot(shot, schemaVersion = 1) {
  return computeShotKeyframeHash(
    Object.assign({}, shot, { image_paths: resolvedShotPaths(shot) }),
    { schemaVersion, styleGuideDigest: styleGuideFileDigest() }
  );
}

function hashForShot(shot, schemaVersion = 1) {
  return computeShotVideoHash(
    Object.assign({}, shot, { image_paths: resolvedShotPaths(shot) }),
    { schemaVersion, keyframeDigest: selectedKeyframeFileDigest(shot), styleGuideDigest: styleGuideFileDigest() }
  );
}

/** 同时写入 keyframe-stage 与 video-stage hash(fixture 便利函数) */
function applyShotHashes(shot, schemaVersion = 1) {
  shot.keyframe_hash = keyframeHashForShot(shot, schemaVersion);
  shot.input_hash = hashForShot(shot, schemaVersion);
  return shot;
}

// ---- F1: 派发前按冻结输入重算并核对 fingerprint ----

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

function legacyTaskNoAttempts() {
  return { task_id: 'task-x', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: 'h1', status: 'submitted', stage: 'video', breaker_epoch: 0 };
}

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

// ============================================================
console.log('\n[E1-COLLECT] E1 采集与指标工具链(mock adapter;先红后绿)');
// ============================================================

const E1M = require('../e1-metrics');
const E1C = require('../e1-collect');

/** ffmpeg 可用性探测:缺失时相关用例打印 SKIP 并按通过处理 */
function ffmpegOk() {
  try {
    const r = spawnSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-version'], { encoding: 'utf8' });
    return !r.error && r.status === 0;
  } catch { return false; }
}
const HAS_FFMPEG = ffmpegOk();
function testFfmpeg(name, fn) {
  if (!HAS_FFMPEG) { passed++; console.log(`  - SKIP ${name} (ffmpeg unavailable)`); return; }
  test(name, fn);
}

/** 用 ffmpeg lavfi 生成确定性图片(测试内) */
function genImage(dir, name, lavfi) {
  const p = path.join(dir, name);
  const r = spawnSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', lavfi, '-frames:v', '1', p], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`genImage failed (${name}): ${r.stderr || r.stdout}`);
  return p;
}

/** 运行 e1-collect CLI(同步) */
function runCollectorCli(args, env) {
  return spawnSync(process.execPath, [path.join(ROOT, 'tools', 'e1-collect.js'), ...args], {
    encoding: 'utf8',
    env: env ? Object.assign({}, process.env, env) : process.env
  });
}

/** 写一个 mock 演练配置(1 case × 3 groups × 1 seed) */
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
/** 共享一次 mock 采集(避免重复 ffmpeg 开销) */
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

// ---- 纯函数(不依赖 ffmpeg) ----

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

test('EC-p3. buildSampleMatrix:cases × groups × seeds,sample_id 路径安全', () => {
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

// ---- ffmpeg 集成:指标 ----

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
  // 旧口径(无 cover-crop)对照:同一对图应明显更低
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

// ---- Runner 端到端(mock adapter) ----

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
  // e1-report schema 必需字段
  for (const s of f.dataset.samples) {
    assert.ok(['A', 'B', 'C'].includes(s.group), `group: ${s.group}`);
    assert.strictEqual(s.layer, 'closeup');
    assert.strictEqual(s.scene, 'scene-01');
    assert.strictEqual(s.prompt_id, 'prompt-01');
    assert.strictEqual(s.seed, 1);
    assert.ok(s.ssim === null || Number.isFinite(s.ssim), 'ssim numeric or null');
    assert.ok(s.phash_distance === null || Number.isFinite(s.phash_distance), 'phash numeric or null');
  }
  // 预注册字段经 --prereg 原样合并
  assert.strictEqual(f.dataset.meta.delta_preregistered, 0.1);
  assert.strictEqual(f.dataset.meta.ssim_abs_min, 0.8);
  assert.ok(f.dataset.meta.delta_frozen_at);
  assert.ok(f.dataset.meta.metrics && f.dataset.meta.metrics.ssim, 'metrics merged from prereg');
  // mock 语义:C 组无输入图 → 复现者仍可对比失败路径(收集器对 case 有图时计算 C 指标)
  const byGroup = Object.fromEntries(f.dataset.samples.map(s => [s.group, s]));
  assert.ok(byGroup.A.ssim >= byGroup.B.ssim, 'mock A should beat degraded B');
});

testFfmpeg('EC-c2. dataset 可被 buildReport 直接消费(--prereg 含 delta/abs_min/frozen_at → 不拒绝)', () => {
  const f = e1Shared();
  const report = buildReport(f.dataset, { generated_at: 'T' }); // may不是首帧约束,但不得抛 E1RefusalError
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

  // 第二次运行:attempts 已达 max_retries → 不再重试
  const r2 = runCollectorCli(['--config', configPath], { E1_CALL_LOG: logPath });
  assert.strictEqual(r2.status, 0, r2.stdout + r2.stderr);
  const calls2 = fs.readFileSync(logPath, 'utf8').trim().split('\n').length;
  assert.strictEqual(calls2, 2, 'exhausted retries must not be retried again');
});

// ---- pippit adapter 契约(纯函数;不起进程/不耗 credits) ----

const E1P = require('../../experiments/e1/adapters/pippit');

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

// ============================================================
console.log('\n[M3-KF] keyframe 阶段管道(§3.2 M3a)');
// ============================================================

/** keyframe take 任务种子(stage='keyframe') */
function seedKeyframeTaskDir(overrides = {}) {
  const dir = mkTempDir();
  writeManifest(dir, {
    episode: 'TEST', schema_version: 2, require_keyframe: true,
    render_tasks: [Object.assign({
      task_id: 'task-kf', shot_id: 's01-shot-01', take_id: 'kf-001', input_hash: 'h1',
      status: 'submitted', stage: 'keyframe', breaker_epoch: 0,
      current_attempt_id: 'att-1', attempts: [{ attempt_id: 'att-1', at: '2026-01-01T00:00:00.000Z', input_hash: 'h1' }]
    }, overrides)],
    shots: [shotBase('s01-shot-01', { input_hash: 'h1', breaker_epoch: 0, keyframe_takes: [], selected_keyframe: null })]
  });
  return dir;
}

// ---- MK1: 无 keyframe 的 shot → keyframe 任务 ----

test('MK1. require_keyframe=true 且无 keyframe → render-next 建 keyframe 任务(stage/take_id/路径)', () => {
  const dir = mkTempDir();
  const shot = shotBase('s01-shot-01', { keyframe_takes: [], selected_keyframe: null });
  applyShotHashes(shot, 2);
  writeManifest(dir, { episode: 'TEST', schema_version: 2, require_keyframe: true, shots: [shot] });
  const r = createRenderTask(dir);
  assert.ok(r, 'must create a keyframe task');
  assert.strictEqual(r.task.stage, 'keyframe');
  assert.strictEqual(r.task.take_id, 'kf-001');
  assert.ok(/shot-001-kf-001\.png$/.test(r.task.take_path), `take_path must be shots/shot-001-kf-001.png, got ${r.task.take_path}`);
  assert.strictEqual(r.out.stage, 'keyframe');
  assert.strictEqual(r.task.superseded_at, null, 'new keyframe snapshot is dispatchable');
  assert.strictEqual(readManifest(dir).quota_ledger.stages.image.requests, 1, 'keyframe request counts on image ledger');
});

// ---- MK2: 有 selected keyframe → video 任务携带 keyframe 绑定 ----

test('MK2. 有 selected keyframe → render-next 建 video 任务且任务含 keyframe 绑定(冻结副本一致)', () => {
  const dir = mkTempDir();
  const kfPath = path.join(dir, 'selected-kf.png');
  fs.writeFileSync(kfPath, 'KEYFRAME-BYTES');
  const shot = shotBase('s01-shot-01', {
    keyframe_takes: [{ id: 'kf-001', path: kfPath, status: 'selected', content_digest: 'd1', input_hash: 'h1' }],
    selected_keyframe: 'kf-001'
  });
  shot.input_hash = hashForShot(shot, 2);
  shot.keyframe_takes[0].input_hash = shot.input_hash;
  writeManifest(dir, { episode: 'TEST', schema_version: 2, require_keyframe: true, shots: [shot] });
  const r = createRenderTask(dir);
  assert.strictEqual(r.task.stage, 'video');
  assert.ok(r.task.keyframe, 'video task must carry keyframe binding');
  assert.strictEqual(r.task.keyframe.take_id, 'kf-001');
  assert.ok(r.task.keyframe.content_digest, 'binding must carry content_digest');
  assert.ok(r.task.keyframe.frozen_path && fs.existsSync(r.task.keyframe.frozen_path), 'frozen keyframe copy must exist');
  assert.strictEqual(fs.readFileSync(r.task.keyframe.frozen_path, 'utf8'), 'KEYFRAME-BYTES');
  assert.strictEqual(fileContentHash(r.task.keyframe.frozen_path), r.task.keyframe.content_digest, 'frozen copy digest must match binding');
  assert.deepStrictEqual(r.task.image_paths, [], 'keyframe must NOT be mixed into image_paths (input_hash unchanged)');
});

// ---- MK3: --video 跳过待 keyframe;--all 标注 ----

test('MK3. --video 跳过待 keyframe 的 shot;--all 标注 stage 与 keyframe 状态', () => {
  const dir = mkTempDir();
  const kfPath = path.join(dir, 'kf.png');
  fs.writeFileSync(kfPath, 'K');
  const shotA = shotBase('s01-shot-01', { keyframe_takes: [], selected_keyframe: null });
  applyShotHashes(shotA, 2);
  const shotB = shotBase('s01-shot-02', {
    keyframe_takes: [{ id: 'kf-001', path: kfPath, status: 'selected', content_digest: 'd', input_hash: null }],
    selected_keyframe: 'kf-001'
  });
  shotB.input_hash = hashForShot(shotB, 2);
  shotB.keyframe_takes[0].input_hash = shotB.input_hash;
  writeManifest(dir, { episode: 'TEST', schema_version: 2, require_keyframe: true, shots: [shotA, shotB] });
  // 默认队列:keyframe-pending 优先
  const r1 = createRenderTask(dir);
  assert.strictEqual(r1.shot.id, 's01-shot-01');
  assert.strictEqual(r1.task.stage, 'keyframe');
  // --video:跳过 A,返回 B 的 video 任务
  const r2 = createRenderTask(dir, { videoOnly: true });
  assert.strictEqual(r2.shot.id, 's01-shot-02');
  assert.strictEqual(r2.task.stage, 'video');
  // --all 标注
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'render-next.js'), dir, '--all'], { encoding: 'utf8' });
  assert.strictEqual(cli.status, 0, cli.stdout + cli.stderr);
  assert.ok(cli.stdout.includes('[stage=keyframe]'), `--all must annotate keyframe stage: ${cli.stdout}`);
  assert.ok(cli.stdout.includes('[stage=video]'), `--all must annotate video stage: ${cli.stdout}`);
  assert.ok(/keyframe:pending/.test(cli.stdout), `--all must annotate pending keyframe: ${cli.stdout}`);
  assert.ok(/keyframe:selected kf-001/.test(cli.stdout), `--all must annotate selected keyframe: ${cli.stdout}`);
});

// ---- MK4: keyframe 状态机 ----

test('MK4. mark-keyframe take→candidate;select→selected 且原 selected 降 candidate(≤1);reject 终态拒绝 select/accept', () => {
  const dir = seedKeyframeTaskDir();
  const kf1 = path.join(dir, 'kf1.png');
  const kf2 = path.join(dir, 'kf2.png');
  fs.writeFileSync(kf1, 'KF1');
  fs.writeFileSync(kf2, 'KF2');

  const r1 = updateKeyframeManifest(dir, 's01-shot-01', { action: 'take', taskId: 'task-kf', path: kf1, requestId: 'req-1' });
  const t1 = r1.manifest.shots[0].keyframe_takes[0];
  assert.strictEqual(t1.id, 'kf-001');
  assert.strictEqual(t1.status, 'candidate', 'take must land as candidate');
  assert.strictEqual(t1.stage, 'keyframe');
  assert.strictEqual(r1.manifest.shots[0].selected_keyframe, null, 'take must NOT auto-select');

  // FIX6b:同 task 多 request = 多 attempt(派发侧每次 pushAttempt);显式构造第二个 attempt 并传 --attempt-id
  const mKf = readManifest(dir);
  mKf.render_tasks[0].attempts.push({ attempt_id: 'att-2', at: '2026-01-01T00:01:00.000Z', input_hash: 'h1', request_id: null });
  writeManifest(dir, mKf);
  const r2 = updateKeyframeManifest(dir, 's01-shot-01', { action: 'take', taskId: 'task-kf', path: kf2, requestId: 'req-2', attemptId: 'att-2' });
  assert.strictEqual(r2.manifest.shots[0].keyframe_takes.length, 2);
  const t2id = r2.manifest.shots[0].keyframe_takes[1].id;
  assert.strictEqual(t2id, 'kf-002');

  const s1 = updateKeyframeManifest(dir, 's01-shot-01', { action: 'select', takeId: 'kf-001' });
  assert.strictEqual(s1.manifest.shots[0].selected_keyframe, 'kf-001');
  assert.strictEqual(s1.manifest.shots[0].keyframe_takes.find(t => t.id === 'kf-001').status, 'selected');

  const s2 = updateKeyframeManifest(dir, 's01-shot-01', { action: 'select', takeId: 'kf-002' });
  const takes = s2.manifest.shots[0].keyframe_takes;
  assert.strictEqual(s2.manifest.shots[0].selected_keyframe, 'kf-002');
  assert.strictEqual(takes.find(t => t.id === 'kf-001').status, 'candidate', 'replaced selected must demote to candidate (not rejected)');
  assert.strictEqual(takes.find(t => t.id === 'kf-002').status, 'selected');
  assert.strictEqual(takes.filter(t => t.status === 'selected').length, 1, 'at most one selected keyframe');

  const rej = updateKeyframeManifest(dir, 's01-shot-01', { action: 'reject', takeId: 'kf-002' });
  assert.strictEqual(rej.manifest.shots[0].selected_keyframe, null, 'rejecting the selected keyframe clears the pointer');
  assert.strictEqual(rej.manifest.shots[0].keyframe_takes.find(t => t.id === 'kf-002').status, 'rejected');
  throws(() => updateKeyframeManifest(dir, 's01-shot-01', { action: 'select', takeId: 'kf-002' }), 'rejected');
  throws(() => updateKeyframeManifest(dir, 's01-shot-01', { action: 'review', takeId: 'kf-002', conclusion: 'accept' }), 'rejected');
});

// ---- MK5: 换 keyframe → 下游 video task 失效 ----

test('MK5. 换 keyframe selected → 绑定旧 keyframe 的 video task 被置 superseded_at;绑定新的不受影响', () => {
  const dir = mkTempDir();
  const kf1 = path.join(dir, 'kf1.png');
  const kf2 = path.join(dir, 'kf2.png');
  fs.writeFileSync(kf1, 'K1');
  fs.writeFileSync(kf2, 'K2');
  writeManifest(dir, { episode: 'TEST', schema_version: 2, require_keyframe: true,
    render_tasks: [
      { task_id: 'task-v1', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: 'h1', status: 'submitted', stage: 'video', breaker_epoch: 0, keyframe: { take_id: 'kf-001', content_digest: 'd1', frozen_path: kf1 } },
      { task_id: 'task-v2', shot_id: 's01-shot-01', take_id: 'take-002', input_hash: 'h1', status: 'submitted', stage: 'video', breaker_epoch: 0, keyframe: { take_id: 'kf-002', content_digest: 'd2', frozen_path: kf2 } }
    ],
    shots: [shotBase('s01-shot-01', { input_hash: 'h1',
      keyframe_takes: [
        { id: 'kf-001', path: kf1, status: 'selected', input_hash: 'h1', content_digest: 'd1' },
        { id: 'kf-002', path: kf2, status: 'candidate', input_hash: 'h1', content_digest: 'd2' }
      ],
      selected_keyframe: 'kf-001' })] });
  const { manifest } = updateKeyframeManifest(dir, 's01-shot-01', { action: 'select', takeId: 'kf-002' });
  const v1 = manifest.render_tasks.find(t => t.task_id === 'task-v1');
  const v2 = manifest.render_tasks.find(t => t.task_id === 'task-v2');
  assert.ok(v1.superseded_at, 'video task bound to the replaced keyframe must be invalidated');
  assert.strictEqual(v1.superseded_by, null, 'superseded_by is null (new task unknown)');
  assert.strictEqual(v1.status, 'submitted', 'execution status preserved (A2 semantics)');
  assert.ok(!v2.superseded_at, 'video task bound to the newly selected keyframe must be unaffected');
});

// ---- MK6: keyframe 失败模型复用 ----

test('MK6. mark-keyframe --failed 复用任务失败模型(hard→retry_wait、--terminal→failed、事件带 attempt_id + image 账本)', () => {
  const dir = seedKeyframeTaskDir();
  const r = updateKeyframeManifest(dir, 's01-shot-01', { action: 'failed', taskId: 'task-kf', error: 'content policy', kindOverride: 'hard' });
  assert.strictEqual(r.manifest.render_tasks[0].status, 'retry_wait');
  const ev = r.manifest.task_events[0];
  assert.strictEqual(ev.stage, 'keyframe');
  assert.strictEqual(ev.kind, 'hard');
  assert.ok(/^att-/.test(ev.attempt_id || ''), 'attempt event carries attempt_id');
  assert.strictEqual(r.manifest.quota_ledger.stages.image.failed_billed, 1, 'keyframe failure billed on image ledger');
  assert.strictEqual(r.manifest.quota_ledger.stages.video.failed_billed, 0);

  const dir2 = seedKeyframeTaskDir();
  const r2 = updateKeyframeManifest(dir2, 's01-shot-01', { action: 'failed', taskId: 'task-kf', error: 'content policy', kindOverride: 'hard', terminal: true });
  assert.strictEqual(r2.manifest.render_tasks[0].status, 'failed');
});

// ---- MK7: catalog stage ----

test('MK7. catalog:mark-shot 新条目 stage=video、mark-keyframe 新条目 stage=keyframe', () => {
  // video
  const dir = mkTempDir();
  const vfile = path.join(dir, 'v.mp4');
  fs.writeFileSync(vfile, 'v');
  const catPath = path.join(dir, 'catalog.json');
  writeManifest(dir, { episode: 'TEST',
    render_tasks: [{ task_id: 'task-v', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: 'h1', status: 'submitted', stage: 'video' }],
    shots: [shotBase('s01-shot-01', { input_hash: 'h1' })] });
  const rv = updateManifest(dir, 's01-shot-01', { action: 'take', path: vfile, taskId: 'task-v', requestId: 'rv' });
  appendCatalog(dir, 's01-shot-01', { action: 'take', path: vfile, taskId: 'task-v', requestId: 'rv' }, rv.manifest, rv.createdTakeId, catPath);
  const e1 = readCatalog(catPath).find(e => e.take_id === 'take-001');
  assert.strictEqual(e1.stage, 'video');

  // keyframe
  const dir2 = seedKeyframeTaskDir();
  const kf = path.join(dir2, 'kf.png');
  fs.writeFileSync(kf, 'k');
  const catPath2 = path.join(dir2, 'catalog.json');
  const rk = updateKeyframeManifest(dir2, 's01-shot-01', { action: 'take', taskId: 'task-kf', path: kf, requestId: 'rk' });
  appendKeyframeCatalog(dir2, 's01-shot-01', { action: 'take', taskId: 'task-kf', path: kf, requestId: 'rk' }, rk.manifest, rk.createdTakeId, catPath2);
  const e2 = readCatalog(catPath2).find(e => e.take_id === 'kf-001');
  assert.strictEqual(e2.stage, 'keyframe');
  // video 条目不因 keyframe select 被误改
  const selected = updateKeyframeManifest(dir2, 's01-shot-01', { action: 'select', takeId: 'kf-001' });
  appendKeyframeCatalog(dir2, 's01-shot-01', { action: 'select', takeId: 'kf-001' }, selected.manifest, null, catPath2);
  const cat2 = readCatalog(catPath2);
  assert.strictEqual(cat2.find(e => e.take_id === 'kf-001').status, 'selected');
});

// ---- MK8: resolveCover ----

test('MK8. resolveCover:clip 绑定 keyframe / 实际首帧 / promo_asset / 缺失报错', () => {
  const kfPath = '/tmp/kf-cover.png';
  const timeline = { fps: 24, clips: [{ clip_id: 'clip-0001', shot_id: 's01-shot-01', take_id: 'take-001', source_in: 0, source_out: 480, deleted_head_frames: 1 }] };

  // 1a. clip 的视频 take 绑定 keyframe → 用绑定的 keyframe take 文件
  const r1 = resolveCover({
    cover: { clip_id: 'clip-0001' },
    shots: [{ id: 's01-shot-01',
      takes: [{ id: 'take-001', path: '/tmp/v.mp4', keyframe: { take_id: 'kf-001', content_digest: 'd1' } }],
      keyframe_takes: [{ id: 'kf-001', path: kfPath }] }]
  }, timeline);
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.kind, 'keyframe');
  assert.strictEqual(r1.path, kfPath);
  assert.strictEqual(r1.keyframe_take_id, 'kf-001');

  // 1b. 无绑定 → 实际首帧 = source_in + deleted_head_frames
  const r2 = resolveCover({
    cover: { clip_id: 'clip-0001' },
    shots: [{ id: 's01-shot-01', takes: [{ id: 'take-001', path: '/tmp/v.mp4' }], keyframe_takes: [] }]
  }, timeline);
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.kind, 'first_frame');
  assert.strictEqual(r2.frame, 1, 'actual first frame = source_in(0) + deleted_head_frames(1)');
  assert.strictEqual(r2.path, '/tmp/v.mp4');

  // 2. promo_asset
  const r3 = resolveCover({ cover: { promo_asset: '/tmp/promo.png' }, shots: [] }, timeline);
  assert.strictEqual(r3.ok, true);
  assert.strictEqual(r3.kind, 'promo_asset');
  assert.strictEqual(r3.path, '/tmp/promo.png');
  assert.strictEqual(r3.in_hash, false);

  // 3. 都没有 → 报错
  const r4 = resolveCover({ shots: [] }, timeline);
  assert.strictEqual(r4.ok, false);
  assert.ok(/no cover configured/.test(r4.error), r4.error);
});

// ============================================================
console.log('\n[A8] stage 输入契约与哈希重构(§3.8 M3b)');
// ============================================================

/** 造一张内容确定的临时参考图,返回绝对路径 */
function a8Image(dir, name, bytes) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
}

/** 显式 refs 的 video-stage hash(直接测 computeStagePayloadHash/computeShotVideoHash) */
function a8VideoHash(refs, extra = {}) {
  return computeStagePayloadHash(Object.assign({
    stage: 'video', schemaVersion: 2, prompt: 'p', refs, model: 'm',
    params: { ratio: '16:9', resolution: '720p', requested_video_duration: 10 },
    firstFrame: null
  }, extra));
}

// ---- A8a: identity 字段不入 hash ----

test('A8a. 同内容不同 take_id → hash 相同;reviewer/时间戳不入 payload', () => {
  const dir = mkTempDir();
  const img = a8Image(dir, 'a.png', 'AAA');
  const base = {
    prompt_final_en: 'p', image_refs: [{ hash_role: 'character:a', path: img }],
    ratio: '16:9', resolution: '720p', duration: 10, model: 'm'
  };
  const h1 = computeShotVideoHash(base, { schemaVersion: 2, keyframeDigest: null, styleGuideDigest: 'sg' });
  const h2 = computeShotVideoHash(Object.assign({}, base, {
    take_id: 'take-999', task_id: 'task-abc', status: 'selected', rendered_at: '2026-99-99T00:00:00.000Z',
    reviewer: 'bob', human_review: { conclusion: 'accept', reviewed_at: 'now' }
  }), { schemaVersion: 2, keyframeDigest: null, styleGuideDigest: 'sg' });
  assert.strictEqual(h1, h2, 'take_id/task_id/reviewer/timestamp must not enter the hash');
});

// ---- A8b: refs 顺序与 role 命名空间 ----

test('A8b. refs 顺序变化 → hash 变;role 命名空间变化(内容相同)→ hash 变', () => {
  const dir = mkTempDir();
  const a = a8Image(dir, 'a.png', 'AAA');
  const b = a8Image(dir, 'b.png', 'BBB');
  const ab = [{ hash_role: 'character:a', path: a }, { hash_role: 'character:b', path: b }];
  const ba = [{ hash_role: 'character:b', path: b }, { hash_role: 'character:a', path: a }];
  assert.notStrictEqual(a8VideoHash(ab), a8VideoHash(ba), 'order participates in the hash');
  const renamed = [{ hash_role: 'character:a', path: a }, { hash_role: 'character:c', path: b }];
  assert.notStrictEqual(a8VideoHash(ab), a8VideoHash(renamed), 'role namespace must participate even when content is identical');
  // 同一内容同一 role → 稳定
  assert.strictEqual(a8VideoHash(ab), a8VideoHash(ab));
});

// ---- A8c: 缺失参考图 fail-closed ----

test('A8c. 缺失参考图 → 抛错(fail-closed)且含完整路径', () => {
  const dir = mkTempDir();
  const missing = path.join(dir, 'nope', 'ref.png');
  throws(() => a8VideoHash([{ hash_role: 'character:a', path: missing }]), missing);
  let err = null;
  try { a8VideoHash([{ hash_role: 'character:a', path: missing }]); } catch (e) { err = e; }
  assert.ok(/content digest required/.test(err.message), err.message);
});

// ---- A8d: keyframe:selected digest 与 keyframe_mode ----

test('A8d. video:keyframe digest 变化 → hash 变;reference 与 first_frame 模式 hash 不同', () => {
  const dir = mkTempDir();
  const img = a8Image(dir, 'a.png', 'AAA');
  const shot = {
    prompt_final_en: 'p', image_refs: [{ hash_role: 'character:a', path: img }],
    ratio: '16:9', resolution: '720p', duration: 10, model: 'm'
  };
  const hKf1 = computeShotVideoHash(shot, { schemaVersion: 2, keyframeDigest: 'digest-1', keyframeMode: 'reference', styleGuideDigest: 'sg' });
  const hKf2 = computeShotVideoHash(shot, { schemaVersion: 2, keyframeDigest: 'digest-2', keyframeMode: 'reference', styleGuideDigest: 'sg' });
  assert.notStrictEqual(hKf1, hKf2, 'selected keyframe digest must enter the video hash');
  const hFirstFrame = computeShotVideoHash(shot, { schemaVersion: 2, keyframeDigest: 'digest-1', keyframeMode: 'first_frame', styleGuideDigest: 'sg' });
  assert.notStrictEqual(hKf1, hFirstFrame, 'reference(first_frame=null + ref) and first_frame mode must differ');
});

// ---- A8e: tts payload ----

test('A8e. tts payload 差异(provider/version/voice/text/params)→ hash 变', () => {
  const baseTts = {
    stage: 'tts', schemaVersion: 2, dialogueText: '你好', voiceId: 'v1',
    provider: { name: 'doubao-icl', model: 'volcano_icl', version: '2026-05-20' },
    ttsParams: { speed: 1.0, emotion: 'neutral' }, styleGuideDigest: 'sg'
  };
  const h0 = computeStagePayloadHash(baseTts);
  assert.strictEqual(h0, computeStagePayloadHash(Object.assign({}, baseTts)), 'tts hash is deterministic');
  assert.notStrictEqual(h0, computeStagePayloadHash(Object.assign({}, baseTts, { dialogueText: '再见' })), 'text enters hash');
  assert.notStrictEqual(h0, computeStagePayloadHash(Object.assign({}, baseTts, { voiceId: 'v2' })), 'voice_id enters hash');
  assert.notStrictEqual(h0, computeStagePayloadHash(Object.assign({}, baseTts, { ttsParams: { speed: 1.2, emotion: 'neutral' } })), 'params enter hash');
  assert.notStrictEqual(h0, computeStagePayloadHash(Object.assign({}, baseTts, { provider: { name: 'other', model: 'volcano_icl', version: '2026-05-20' } })), 'provider name enters hash');
  assert.notStrictEqual(h0, computeStagePayloadHash(Object.assign({}, baseTts, { provider: { name: 'doubao-icl', model: 'other', version: '2026-05-20' } })), 'provider model enters hash');
  assert.notStrictEqual(h0, computeStagePayloadHash(Object.assign({}, baseTts, { provider: { name: 'doubao-icl', model: 'volcano_icl', version: '2026-06-01' } })), 'provider version enters hash');
});

// ---- A8g: collectImageRefs / buildPromptForShot hash_role ----

test('A8g. buildPromptForShot 返回 image_refs(含 hash_role),prompt 人类可读文本不变', () => {
  const { buildPromptForShot, collectImageRefs } = require('../build-prompt');
  const dir = mkTempDir();
  const extra = a8Image(dir, 'x.png', 'XX');
  const shot = { id: 's', style_en: 'cinematic', prompt_en: 'a', references: [extra] };
  const r = buildPromptForShot(shot, { id: 'sc' }, { defaults: {} }, {});
  assert.deepStrictEqual(r.image_refs, [{ path: extra, role: 'extra reference', hash_role: 'shot.references[0]' }]);
  assert.strictEqual(r.image_paths[0], extra, 'image_paths 兼容不变');
  assert.ok(r.prompt.includes('<image 1>: extra reference'), `prompt role text unchanged: ${r.prompt}`);
  assert.strictEqual(collectImageRefs(shot, { id: 'sc' })[0].hash_role, 'shot.references[0]');
});

// ---- A8f: 集成(build-manifest → keyframe → select → rebuild → verify/render) ----

test('A8f. 集成:keyframe select 后重建 → shot.input_hash 变化;freshness=:fresh;render-next 派发 video 且 FIX3-1 通过', () => {
  const dir = mkTempDir();
  fs.writeFileSync(path.join(dir, 'script.yaml'), [
    'episode: A8TEST', 'title: T', 'schema_version: 2', 'require_keyframe: true',
    'defaults:', '  duration: 8', "  ratio: '16:9'", "  resolution: '720p'", "  model: 'default'",
    'scenes:', '  - id: s01', '    shots:',
    '      - id: s01-shot-01', "        style_en: 'cinematic'", "        prompt_en: 'a'", ''
  ].join('\n'));
  const build = runBuildManifest(dir);
  assert.strictEqual(build.status, 0, `${build.stdout}${build.stderr}`);

  const m0 = readManifest(dir);
  const s0 = m0.shots[0];
  assert.ok(s0.keyframe_hash, 'manifest must store keyframe_hash');
  assert.ok(Array.isArray(s0.image_refs), 'manifest must store image_refs');
  const videoHashBefore = s0.input_hash;

  // 1. 派发 keyframe 任务
  const kfTask = createRenderTask(dir);
  assert.strictEqual(kfTask.task.stage, 'keyframe');
  assert.strictEqual(kfTask.task.input_hash, s0.keyframe_hash, 'keyframe task stores keyframe-stage hash');

  // 2. 落 keyframe take + 选中
  const kfFile = path.join(dir, 'kf.png');
  fs.writeFileSync(kfFile, 'KEYFRAME-BYTES');
  updateKeyframeManifest(dir, 's01-shot-01', { action: 'take', taskId: kfTask.task.task_id, path: kfFile, requestId: 'r1' });
  const sel = updateKeyframeManifest(dir, 's01-shot-01', { action: 'select', takeId: 'kf-001' });
  assert.strictEqual(sel.manifest.shots[0].selected_keyframe, 'kf-001');
  const kfDigest = fileContentHash(kfFile);
  assert.strictEqual(sel.manifest.shots[0].keyframe_takes[0].content_digest, kfDigest);

  // 3. 重建 manifest:video-stage hash 现在含 keyframe:selected digest
  const rebuild = runBuildManifest(dir);
  assert.strictEqual(rebuild.status, 0, `${rebuild.stdout}${rebuild.stderr}`);
  const m1 = readManifest(dir);
  const s1 = m1.shots[0];
  assert.notStrictEqual(s1.input_hash, videoHashBefore, 'selected keyframe must change shot.input_hash');
  assert.strictEqual(s1.keyframe_hash, s0.keyframe_hash, 'keyframe-stage hash is independent of keyframe selection');

  // 4. freshness
  const fresh = verifyManifestFreshness(dir);
  assert.strictEqual(fresh.fresh, true, `expected fresh, got ${JSON.stringify(fresh)}`);

  // 5. render-next 派发 video,FIX3-1 通过
  const vTask = createRenderTask(dir);
  assert.strictEqual(vTask.task.stage, 'video');
  assert.strictEqual(vTask.task.input_hash, s1.input_hash);
  assert.ok(vTask.task.keyframe && vTask.task.keyframe.take_id === 'kf-001', 'video task binds selected keyframe');
  assert.strictEqual(vTask.task.keyframe.content_digest, kfDigest);
});

// ============================================================
console.log('\n[M4a] continue_from 校验三件套 + offset 帧号 canonicalize + keyframe 上游尾帧引用(§3.3)');
// ============================================================

function m4aScript(fpsLine, shots) {
  return [
    'episode: M4ATEST', 'title: T', 'defaults:',
    '  duration: 8', "  ratio: '16:9'", "  resolution: '720p'", "  model: 'default'",
    ...(fpsLine ? ['  ' + fpsLine] : []),
    'scenes:', '  - id: s01', '    shots:',
    ...shots,
    ''
  ].join('\n');
}

const M4A_SHOT_1 = [
  '      - id: s01-shot-01', "        style_en: 'cinematic'", "        prompt_en: 'a'"
];
const M4A_SHOT_2 = [
  '      - id: s01-shot-02', "        style_en: 'cinematic'", "        prompt_en: 'b'",
  '        continue_from: s01-shot-01'
];
const M4A_FPS24_SCRIPT = m4aScript('fps: 24', M4A_SHOT_1);
const M4A_TWO_SHOT_SCRIPT = m4aScript(null, M4A_SHOT_1.concat(M4A_SHOT_2));
const M4A_TWO_SHOT_SCRIPT_EXPLICIT = m4aScript(null, M4A_SHOT_1.concat(M4A_SHOT_2).concat(['        continue_from_offset: -0.25']));

// ---- M4a1: episode FPS 解析 ----

test('M4a1a. resolveEpisodeFps 优先级 script.defaults.fps > series.seedance_defaults.fps > 30', () => {
  assert.strictEqual(resolveEpisodeFps({ defaults: { fps: 24 } }, { seedance_defaults: { fps: 25 } }), 24);
  assert.strictEqual(resolveEpisodeFps({ defaults: {} }, { seedance_defaults: { fps: 25 } }), 25);
  assert.strictEqual(resolveEpisodeFps({ defaults: {} }, {}), 30);
  assert.strictEqual(resolveEpisodeFps({}, {}), 30);
  assert.strictEqual(resolveEpisodeFps(undefined, undefined), 30);
  assert.strictEqual(resolveEpisodeFps({ defaults: { fps: null } }, { seedance_defaults: { fps: 25 } }), 25);
});

test('M4a1b. resolveEpisodeFps 非法值(0/小数/字符串)→ 抛错', () => {
  throws(() => resolveEpisodeFps({ defaults: { fps: 0 } }, {}), 'positive integer');
  throws(() => resolveEpisodeFps({ defaults: { fps: -24 } }, {}), 'positive integer');
  throws(() => resolveEpisodeFps({ defaults: { fps: 23.976 } }, {}), 'positive integer');
  throws(() => resolveEpisodeFps({ defaults: { fps: '24' } }, {}), 'positive integer');
  throws(() => resolveEpisodeFps({ defaults: {} }, { seedance_defaults: { fps: 1.5 } }), 'positive integer');
});

test('M4a1c. build-manifest 写入 manifest.fps,resolveTimelineFps 自动采用(链路一致)', () => {
  const dir = mkTempDir();
  fs.writeFileSync(path.join(dir, 'script.yaml'), M4A_FPS24_SCRIPT);
  const r = runBuildManifest(dir);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  const m = readManifest(dir);
  assert.strictEqual(m.fps, 24, 'manifest must store the resolved episode fps');
  assert.strictEqual(resolveTimelineFps({}, m), 24, 'build-timeline must adopt manifest.fps');
  assert.strictEqual(resolveTimelineFps({ timeline: { fps: 25 } }, m), 25, 'edit.timeline.fps still wins');
});

// ---- M4a2: offset canonicalize ----

test('M4a2a. continue_from offset 默认 -0.1 @30fps → -3 帧 + 残差;无 continue_from 不写字段', () => {
  const dir = mkTempDir();
  fs.writeFileSync(path.join(dir, 'script.yaml'), M4A_TWO_SHOT_SCRIPT);
  const r = runBuildManifest(dir);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  const m = readManifest(dir);
  const [s1, s2] = m.shots;
  assert.strictEqual(s1.continue_from_offset_frames, undefined, 'no continue_from → no offset frames field');
  assert.strictEqual(s1.continue_from_residual_sec, undefined, 'no continue_from → no residual field');
  assert.strictEqual(s2.continue_from, 's01-shot-01');
  assert.strictEqual(s2.continue_from_offset_frames, -3);
  approx(s2.continue_from_residual_sec, 0);
});

test('M4a2b. 显式 continue_from_offset 秒 → 帧号 + 换算残差', () => {
  const dir = mkTempDir();
  fs.writeFileSync(path.join(dir, 'script.yaml'), M4A_TWO_SHOT_SCRIPT_EXPLICIT);
  const r = runBuildManifest(dir);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  const s2 = readManifest(dir).shots[1];
  assert.strictEqual(s2.continue_from_offset, -0.25);
  assert.strictEqual(s2.continue_from_offset_frames, -7); // Math.round(-0.25*30) = -7
  approx(s2.continue_from_residual_sec, -0.25 - (-7 / 30));
});

test('M4a2c. secondsToFrames 权威在 build-manifest,与 build-timeline 兼容', () => {
  assert.deepStrictEqual(bmSecondsToFrames(1.234, 24), secondsToFrames(1.234, 24));
  assert.deepStrictEqual(bmSecondsToFrames(1.5, 24), { frames: 36, residual: 0 });
  assert.deepStrictEqual(bmSecondsToFrames(-0.1, 30), { frames: -3, residual: 0 });
  throws(() => bmSecondsToFrames(NaN, 30), 'finite');
  throws(() => bmSecondsToFrames(-0.1, 23.976), 'positive integer');
  // build-timeline 既有权重语义保留:负秒仍抛错(兼容转发)
  throws(() => secondsToFrames(-0.1, 30), 'non-negative');
  throws(() => secondsToFrames(1, 0), 'positive integer');
});

// ---- M4a3: 校验三件套 ----

test('M4a3a. validateContinueFrom:self / unknown / order / cycle / depth / 合法 六类', () => {
  // self-reference
  let r = validateContinueFrom([{ id: 'a', continue_from: 'a' }]);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some(e => /self-reference/.test(e) && e.includes('a')), JSON.stringify(r.errors));
  // unknown(错误列出链路)
  r = validateContinueFrom([{ id: 'a' }, { id: 'b', continue_from: 'nope' }]);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some(e => /unknown/.test(e) && e.includes('nope') && e.includes('b -> nope')), JSON.stringify(r.errors));
  // order(上游在 script 顺序之后)
  r = validateContinueFrom([{ id: 'a', continue_from: 'b' }, { id: 'b' }]);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some(e => /earlier|precede/.test(e) && e.includes('a -> b')), JSON.stringify(r.errors));
  // cycle(错误列出环)
  r = validateContinueFrom([{ id: 'a', continue_from: 'b' }, { id: 'b', continue_from: 'a' }]);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some(e => /cycle/.test(e) && e.includes('a -> b -> a')), JSON.stringify(r.errors));
  // depth > 3 reject(=4)
  const deep = [
    { id: 'e' }, { id: 'd', continue_from: 'e' }, { id: 'c', continue_from: 'd' },
    { id: 'b', continue_from: 'c' }, { id: 'a', continue_from: 'b' }
  ];
  r = validateContinueFrom(deep);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some(e => /depth 4/.test(e) && /max 3/.test(e)), JSON.stringify(r.errors));
  // depth = 3 允许
  const ok3 = [
    { id: 'd' }, { id: 'c', continue_from: 'd' },
    { id: 'b', continue_from: 'c' }, { id: 'a', continue_from: 'b' }
  ];
  r = validateContinueFrom(ok3);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.deepStrictEqual(r.errors, []);
  // 合法单跳 + 无 continue_from
  r = validateContinueFrom([{ id: 'a' }, { id: 'b', continue_from: 'a' }]);
  assert.strictEqual(r.ok, true);
});

test('M4a3b. build-manifest 校验失败 → 非零退出、打印全部错误且不写 manifest', () => {
  const dir = mkTempDir();
  // shot-01 continue_from shot-02(上游在顺序之后)→ order 违规
  const script = m4aScript(null, [
    '      - id: s01-shot-01', "        style_en: 'cinematic'", "        prompt_en: 'a'", '        continue_from: s01-shot-02',
    '      - id: s01-shot-02', "        style_en: 'cinematic'", "        prompt_en: 'b'"
  ]);
  fs.writeFileSync(path.join(dir, 'script.yaml'), script);
  const r = runBuildManifest(dir);
  assert.notStrictEqual(r.status, 0, 'invalid continue_from must fail the build');
  const out = r.stdout + r.stderr;
  assert.ok(/continue_from validation failed/.test(out), out);
  assert.ok(out.includes('s01-shot-01'), out);
  assert.ok(out.includes('->'), 'error must list the chain');
  assert.ok(!fs.existsSync(path.join(dir, 'manifest.json')), 'must not write a manifest on validation failure');
});

// ---- M4a4: keyframe 上游尾帧引用 ----

/** 构造上游已选 video take 的 manifest(下游 shot 带 continue_from) */
function m4aManifest(dir, opts = {}) {
  const upVideo = path.join(dir, 'upstream.mp4');
  fs.writeFileSync(upVideo, opts.upBytes || 'UPSTREAM-VIDEO-BYTES');
  const upDigest = fileContentHash(upVideo);
  const upstreamShot = shotBase('s01-shot-01', {
    status: 'done', selected_take: 'take-001',
    takes: [{ id: 'take-001', path: upVideo, content_digest: upDigest, status: 'selected', input_hash: 'h-up' }]
  });
  const downShot = shotBase('s01-shot-02', {
    continue_from: 's01-shot-01', continue_from_offset: -0.1, status: 'pending'
  });
  downShot.keyframe_hash = keyframeHashForShot(downShot, 2);
  downShot.input_hash = hashForShot(downShot, 2);
  writeManifest(dir, {
    episode: 'M4ATEST', schema_version: 2, require_keyframe: true, keyframe_mode: 'reference',
    fps: 30, shots: [upstreamShot, downShot], render_tasks: []
  });
  return { upVideo, upDigest };
}

test('M4a4a. continue_from keyframe 任务:stub 提取器 + 尾帧 ref + 记录 + hash 变化', () => {
  const dir = mkTempDir();
  const { upVideo } = m4aManifest(dir);
  const calls = [];
  const stub = (args) => {
    calls.push(args);
    fs.writeFileSync(args.outPath, 'TAIL-FRAME-BYTES');
    return { durationSec: 10, durationFrames: 300, cutFrame: 297 };
  };
  const r = createRenderTask(dir, { extractTailFrame: stub });
  assert.ok(r, 'must dispatch a keyframe task');
  assert.strictEqual(r.task.stage, 'keyframe');
  assert.strictEqual(calls.length, 1, 'stub extractor must be called exactly once');
  assert.strictEqual(calls[0].videoPath, upVideo);
  assert.strictEqual(calls[0].offsetFrames, -3);
  assert.strictEqual(calls[0].fps, 30);

  const tailRef = (r.task.image_refs || []).find(x => (x.hash_role || x.role) === 'upstream_tail:continue_from');
  assert.ok(tailRef, 'task must carry the upstream_tail:continue_from ref');
  assert.strictEqual(tailRef.role, 'upstream_tail:continue_from');
  assert.ok(fs.existsSync(tailRef.frozen_path), 'tail frame must be frozen into the task asset dir');
  assert.ok(tailRef.frozen_path.includes(path.join('.task-assets', r.task.task_id)), tailRef.frozen_path);
  assert.strictEqual(tailRef.content_hash, fileContentHash(tailRef.frozen_path));

  assert.ok(r.task.continue_from, 'task must record continue_from');
  assert.strictEqual(r.task.continue_from.upstream_shot_id, 's01-shot-01');
  assert.strictEqual(r.task.continue_from.take_id, 'take-001');
  assert.strictEqual(r.task.continue_from.offset_frames, -3);
  assert.strictEqual(r.task.continue_from.cut_frame, 297);
  assert.strictEqual(r.task.continue_from.content_digest, fileContentHash(tailRef.frozen_path));

  // keyframe-stage hash 因该 ref 变化(相对不含尾帧的 base hash)
  const m = readManifest(dir);
  assert.strictEqual(r.task.base_input_hash, m.shots[1].keyframe_hash, 'base hash aligns with manifest');
  assert.notStrictEqual(r.task.input_hash, m.shots[1].keyframe_hash, 'tail ref must change the stage hash');
  const fullHash = computeShotKeyframeHash(
    { prompt_final_en: m.shots[1].prompt_final_en, image_refs: [], ratio: m.shots[1].ratio, resolution: m.shots[1].resolution, model: m.shots[1].model },
    { schemaVersion: 2, styleGuideDigest: styleGuideFileDigest(), upstreamTail: { path: tailRef.frozen_path, cut_frame: 297 } }
  );
  assert.strictEqual(r.task.input_hash, fullHash, 'task hash must be the keyframe-stage hash including the tail ref');

  // 弱承诺:不改写 shot 时长/裁切,不写 cut 字段
  assert.strictEqual(m.shots[1].duration, 10);
  assert.strictEqual(m.shots[1].source_in, undefined);
  assert.strictEqual(r.task.deleted_head_frames, undefined);
  assert.strictEqual(r.task.source_out, undefined);
});

test('M4a4b. 上游缺 selected video take → 抛错且零改动', () => {
  const dir = mkTempDir();
  m4aManifest(dir);
  const m = readManifest(dir);
  m.shots[0].selected_take = null;
  m.shots[0].takes = [];
  writeManifest(dir, m);
  const before = JSON.stringify(readManifest(dir));
  let called = false;
  throws(() => createRenderTask(dir, { extractTailFrame: () => { called = true; } }), 'has no selected video take');
  assert.strictEqual(called, false, 'extractor must not run when upstream is unfinished');
  assert.strictEqual(JSON.stringify(readManifest(dir)), before, 'manifest must be untouched');
  assert.deepStrictEqual(taskAssetsDirs(dir), [], 'no frozen dir residue');
});

test('M4a4c. continue_from keyframe 重复派发 → 幂等复用(base hash 对齐)', () => {
  const dir = mkTempDir();
  m4aManifest(dir);
  const stub = (args) => { fs.writeFileSync(args.outPath, 'TAIL'); return { durationSec: 10 }; };
  const r1 = createRenderTask(dir, { extractTailFrame: stub });
  const r2 = createRenderTask(dir, { extractTailFrame: stub });
  assert.strictEqual(r2.task.task_id, r1.task.task_id, 'continue_from keyframe task must be reused');
  assert.strictEqual(r2.out.note.includes('reusing'), true, r2.out.note);
});

test('M4a6. 上游 take 内容变更 → 旧 keyframe 任务一跳失效,不得复用', () => {
  const dir = mkTempDir();
  m4aManifest(dir);
  const stub = (args) => { fs.writeFileSync(args.outPath, 'TAIL-1'); return { durationSec: 10 }; };
  const r1 = createRenderTask(dir, { extractTailFrame: stub });
  // 上游改选新 take(内容不同)
  const m = readManifest(dir);
  const newUp = path.join(dir, 'upstream2.mp4');
  fs.writeFileSync(newUp, 'DIFFERENT-UPSTREAM-BYTES');
  m.shots[0].takes.find(t => t.id === 'take-001').status = 'candidate';
  m.shots[0].takes.push({ id: 'take-002', path: newUp, content_digest: fileContentHash(newUp), status: 'selected', input_hash: 'h-up2' });
  m.shots[0].selected_take = 'take-002';
  writeManifest(dir, m);
  const stub2 = (args) => { fs.writeFileSync(args.outPath, 'TAIL-2'); return { durationSec: 10 }; };
  const r2 = createRenderTask(dir, { extractTailFrame: stub2 });
  assert.ok(r2, 'must dispatch a fresh keyframe task');
  assert.notStrictEqual(r2.task.task_id, r1.task.task_id, 'upstream take content change must invalidate the old keyframe task');
  const after = readManifest(dir);
  const oldTask = after.render_tasks.find(t => t.task_id === r1.task.task_id);
  assert.ok(oldTask.superseded_at, 'old task must be superseded (one-hop invalidation)');
});

test('M4a7. 上游 take id 变但内容相同 → 仍可复用(§3.8 内容等价)', () => {
  const dir = mkTempDir();
  m4aManifest(dir);
  const stub = (args) => { fs.writeFileSync(args.outPath, 'TAIL'); return { durationSec: 10 }; };
  const r1 = createRenderTask(dir, { extractTailFrame: stub });
  const m = readManifest(dir);
  const same = path.join(dir, 'upstream-same.mp4');
  fs.writeFileSync(same, 'UPSTREAM-VIDEO-BYTES'); // 与 take-001 相同内容
  m.shots[0].takes.find(t => t.id === 'take-001').status = 'candidate';
  m.shots[0].takes.push({ id: 'take-002', path: same, content_digest: fileContentHash(same), status: 'selected', input_hash: 'h-up' });
  m.shots[0].selected_take = 'take-002';
  writeManifest(dir, m);
  const r2 = createRenderTask(dir, { extractTailFrame: stub });
  assert.strictEqual(r2.task.task_id, r1.task.task_id, 'same content (different take id) must keep the task reusable');
  assert.strictEqual(readManifest(dir).render_tasks.length, 1, 'must not create a duplicate task');
});

test('M4a4d. continue_from keyframe take 记为 candidate 且可 select(base_input_hash 对齐)', () => {
  const dir = mkTempDir();
  m4aManifest(dir);
  const stub = (args) => { fs.writeFileSync(args.outPath, 'TAIL'); return { durationSec: 10 }; };
  const r = createRenderTask(dir, { extractTailFrame: stub });
  const kfFile = path.join(dir, 'kf.png');
  fs.writeFileSync(kfFile, 'KF-BYTES');
  const { manifest } = updateKeyframeManifest(dir, 's01-shot-02', {
    action: 'take', taskId: r.task.task_id, path: kfFile, requestId: 'req-1'
  });
  const take = manifest.shots[1].keyframe_takes[0];
  assert.strictEqual(take.status, 'candidate', 'continue_from take must not be recorded as superseded');
  assert.strictEqual(take.base_input_hash, manifest.shots[1].keyframe_hash);
  const sel = updateKeyframeManifest(dir, 's01-shot-02', { action: 'select', takeId: take.id });
  assert.strictEqual(sel.manifest.shots[1].selected_keyframe, take.id);
});

// ---- M4a5: 无 continue_from 的回归 ----

test('M4a5. 无 continue_from 的 keyframe 任务与 M3b 行为一致(不调用提取器/无 ref/无记录)', () => {
  const dir = mkTempDir();
  const shot = shotBase('s01-shot-01');
  shot.keyframe_hash = keyframeHashForShot(shot, 2);
  shot.input_hash = hashForShot(shot, 2);
  writeManifest(dir, {
    episode: 'TEST', schema_version: 2, require_keyframe: true, keyframe_mode: 'reference',
    fps: 30, shots: [shot], render_tasks: []
  });
  const r = createRenderTask(dir, { extractTailFrame: () => { throw new Error('extractTailFrame must not be called without continue_from'); } });
  assert.strictEqual(r.task.stage, 'keyframe');
  assert.strictEqual(r.task.input_hash, shot.keyframe_hash);
  assert.strictEqual(r.task.base_input_hash, undefined);
  assert.strictEqual(r.task.continue_from, undefined);
  assert.strictEqual(r.out.continue_from, null);
  assert.ok(!(r.task.image_refs || []).some(x => (x.hash_role || x.role) === 'upstream_tail:continue_from'));
});

// ---- 可选 ffmpeg 门控集成 ----

testFfmpeg('M4a-ff. extractTailFrame 真实抽帧为 PNG,尺寸 = 视频尺寸', () => {
  const dir = mkTempDir();
  const video = path.join(dir, 'in.mp4');
  const r0 = spawnSync(process.env.FFMPEG_BIN || 'ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=64x48:r=30', '-t', '1', '-pix_fmt', 'yuv420p', video
  ], { encoding: 'utf8' });
  assert.strictEqual(r0.status, 0, r0.stderr || r0.stdout);
  const out = path.join(dir, 'tail.png');
  const res = extractTailFrame({ videoPath: video, offsetFrames: -1, fps: 30, outPath: out });
  assert.ok(fs.existsSync(out), 'tail frame png must exist');
  assert.ok(res.durationSec > 0 && res.cutFrame >= 0, JSON.stringify(res));
  const probe = spawnSync(process.env.FFPROBE_BIN || 'ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out
  ], { encoding: 'utf8' });
  assert.strictEqual(probe.stdout.trim(), '64,48', `png dims: ${probe.stdout}`);
  assert.ok(probeDurationSec(video) > 0);
});

// ============================================================
console.log('\n[M4b] cut_join 相邻性校验 + 接镜处理(截断/删帧/CFR)(§3.3)');
// ============================================================

/** M4b 测试用 manifest: s01-shot-01(上游) + s01-shot-02(cut_join 下游),两者 take 文件均存在 */
function m4bManifest(dir, opts = {}) {
  const up = path.join(dir, 'up.mp4');
  const down = path.join(dir, 'down.mp4');
  fs.writeFileSync(up, 'UPSTREAM-VIDEO-BYTES');
  fs.writeFileSync(down, 'DOWNSTREAM-VIDEO-BYTES');
  const s1 = shotBase('s01-shot-01', Object.assign({ status: 'done', selected_take: 'take-001',
    takes: [{ id: 'take-001', path: up, status: 'selected', input_hash: 'h1' }] }, opts.up || {}));
  const s2 = shotBase('s01-shot-02', Object.assign({ status: 'done', cut_join: true, continue_from: 's01-shot-01',
    takes: [{ id: 'take-001', path: down, status: 'selected', input_hash: 'h2' }] }, opts.down || {}));
  return { manifest: { episode: 'M4BTEST', fps: 30, shots: [s1, s2], render_tasks: [] }, up, down };
}

/** M4b 测试用 edit:timeline 为对象形式(可携带 same_frame_ssim_threshold) */
function m4bEdit(clips, threshold, extra = {}) {
  const timeline = Object.assign({ fps: 30, clips }, extra);
  if (threshold !== undefined) timeline.same_frame_ssim_threshold = threshold;
  return { timeline };
}

// ---- M4b1: 纯函数 decideDeletedHeadFrames ----

test('M4b1. decideDeletedHeadFrames: ≥S→requested、<S→0、非法参数抛错', () => {
  assert.strictEqual(decideDeletedHeadFrames(0.95, 0.6), 1);
  assert.strictEqual(decideDeletedHeadFrames(0.6, 0.6), 1, 'boundary >= is inclusive');
  assert.strictEqual(decideDeletedHeadFrames(0.2, 0.6), 0);
  assert.strictEqual(decideDeletedHeadFrames(0.95, 0.6, 3), 3);
  assert.strictEqual(decideDeletedHeadFrames(0.95, 0.6, 0), 0, 'requested 0 → 显式不删');
  assert.strictEqual(decideDeletedHeadFrames(0.2, 0.6, 3), 0);
  assert.strictEqual(decideDeletedHeadFrames(0.1, 0), 1);
  throws(() => decideDeletedHeadFrames(NaN, 0.6), 'finite');
  throws(() => decideDeletedHeadFrames(Infinity, 0.6), 'finite');
  throws(() => decideDeletedHeadFrames('0.9', 0.6), 'finite');
  throws(() => decideDeletedHeadFrames(0.9, NaN), 'finite');
  throws(() => decideDeletedHeadFrames(0.9, Infinity), 'finite');
  throws(() => decideDeletedHeadFrames(0.9, 0.6, 1.5), 'non-negative integer');
  throws(() => decideDeletedHeadFrames(0.9, 0.6, -1), 'non-negative integer');
});

// ---- M4b2: 相邻性校验 ----

test('M4b2. cut_join 相邻性: 首 clip 无上游 / 前置非上游 → 报错(含三方 id);正确相邻通过', () => {
  const dir = mkTempDir();
  const { manifest } = m4bManifest(dir);
  const stub = () => ({ ssim: 0.95 });
  const run = (clips, m, threshold) => buildTimeline({
    edit: m4bEdit(clips, threshold === undefined ? 0.6 : threshold),
    manifest: m || manifest,
    options: { junctionCompare: stub }
  });

  // 1) 时间线首 clip 带 cut_join → 无上游,直接报错
  let err = null;
  try {
    run([{ shot_id: 's01-shot-02', take_id: 'take-001', source_in: 0, source_out: 50 }]);
  } catch (e) { err = e.message; }
  assert.ok(err && /adjacency violation/.test(err), err);
  assert.ok(err.includes('s01-shot-02') && /first timeline clip/.test(err), err);

  // 2) 前置 clip 不是上游:shots [s0, s1, s2],s2.continue_from = s0,时间线 [s1, s2]
  const upPath = path.join(dir, 'up.mp4');
  const downPath = path.join(dir, 'down.mp4');
  const m3 = { episode: 'M4BTEST', fps: 30, render_tasks: [], shots: [
    shotBase('s0', { takes: [{ id: 'take-001', path: upPath }] }),
    shotBase('s1', { takes: [{ id: 'take-001', path: upPath }] }),
    shotBase('s2', { cut_join: true, continue_from: 's0', takes: [{ id: 'take-001', path: downPath }] })
  ] };
  err = null;
  try {
    run([
      { shot_id: 's1', take_id: 'take-001', source_in: 0, source_out: 30 },
      { shot_id: 's2', take_id: 'take-001', source_in: 0, source_out: 20 }
    ], m3);
  } catch (e) { err = e.message; }
  assert.ok(err && /adjacency violation/.test(err), err);
  for (const id of ['s2', 's0', 's1']) assert.ok(err.includes(id), `error must mention ${id}: ${err}`);
  assert.ok(/edit\.yaml|remove cut_join/.test(err), `error must hint at the fix: ${err}`);

  // 3) 正确相邻 → 通过
  const tl = run([
    { shot_id: 's01-shot-01', take_id: 'take-001', source_in: 0, source_out: 40 },
    { shot_id: 's01-shot-02', take_id: 'take-001', source_in: 0, source_out: 30 }
  ]);
  assert.strictEqual(tl.clips.length, 2);
  assert.strictEqual(tl.clips[0].cut_join, false);
  assert.strictEqual(tl.clips[1].cut_join, true);
  assert.ok(tl.clips[1].junction, 'cut_join clip must carry junction audit record');
});

// ---- M4b3: stub junctionCompare 驱动的截断 + 删帧 ----

test('M4b3. stub junctionCompare: 截断恒发生,删帧由 S 决定;source_in 不变;输出时长按公式重算', () => {
  const dir = mkTempDir();
  const { manifest } = m4bManifest(dir);
  const baseClips = () => [
    { shot_id: 's01-shot-01', take_id: 'take-001', source_in: 10, source_out: 110, padding_frames: 2 },
    { shot_id: 's01-shot-02', take_id: 'take-001', source_in: 5, source_out: 55 }
  ];
  const build = (ssim, clips) => buildTimeline({
    edit: m4bEdit(clips || baseClips(), 0.6), manifest,
    options: { junctionCompare: () => ({ ssim }) }
  });

  // SSIM ≥ S → 删帧 requested(默认 1);截断恒发生
  const hi = build(0.95);
  const [u1, d1] = hi.clips;
  assert.strictEqual(u1.source_out, 107, 'cutFrame = source_out(110) + offset(-3) → 截断最后保留帧 106');
  assert.strictEqual(u1.deleted_head_frames, 0, 'upstream 自身不因接头删帧');
  assert.strictEqual(d1.source_in, 5, 'source_in 始终保留原裁切点');
  assert.strictEqual(d1.source_out, 55);
  assert.strictEqual(d1.deleted_head_frames, 1);
  assert.deepStrictEqual(d1.junction, { ssim: 0.95, threshold_s: 0.6, cut_frame: 107, deleted_head_frames: 1 });
  assert.deepStrictEqual([u1.output_start, u1.output_end], [0, 99], '(107-10)-0+2 = 99');
  assert.deepStrictEqual([d1.output_start, d1.output_end], [99, 148], '(55-5)-1+0 = 49');

  // SSIM < S → 不删帧,但 cutFrame 仍写入(truncation 是 cut_join 定义的一部分)
  const lo = build(0.2);
  const [u2, d2] = lo.clips;
  assert.strictEqual(u2.source_out, 107, '截断恒发生,与 SSIM 无关');
  assert.strictEqual(d2.deleted_head_frames, 0);
  assert.deepStrictEqual(d2.junction, { ssim: 0.2, threshold_s: 0.6, cut_frame: 107, deleted_head_frames: 0 });
  assert.deepStrictEqual([u2.output_start, u2.output_end], [0, 99]);
  assert.deepStrictEqual([d2.output_start, d2.output_end], [99, 149]);

  // 显式 requested>1 且 SSIM ≥ S → 用 requested(edit.yaml 可显式给出)
  const multi = build(0.9, [
    { shot_id: 's01-shot-01', take_id: 'take-001', source_in: 0, source_out: 100 },
    { shot_id: 's01-shot-02', take_id: 'take-001', source_in: 0, source_out: 50, deleted_head_frames: 3 }
  ]);
  assert.strictEqual(multi.clips[1].deleted_head_frames, 3);
  assert.strictEqual(multi.clips[1].junction.deleted_head_frames, 3);
  assert.strictEqual(multi.clips[1].output_end - multi.clips[1].output_start, 47);

  // cutFrame clamp 到 [source_in+1, source_out]:正 offset 造成向上越界 → clamp 回原 source_out
  const { manifest: mPlus } = m4bManifest(dir, { down: { continue_from_offset_frames: 50 } });
  const up = buildTimeline({
    edit: m4bEdit([
      { shot_id: 's01-shot-01', take_id: 'take-001', source_in: 0, source_out: 100 },
      { shot_id: 's01-shot-02', take_id: 'take-001', source_in: 0, source_out: 20 }
    ], 0.6),
    manifest: mPlus, options: { junctionCompare: () => ({ ssim: 0.95 }) }
  });
  assert.strictEqual(up.clips[0].source_out, 100, 'offset 正越界 → clamp 到原 source_out');
  assert.strictEqual(up.clips[1].junction.cut_frame, 100);
});

// ---- M4b4: continue_from 弱承诺 ----

test('M4b4. continue_from(非 cut_join)即使时间线相邻也不截断/删帧(compare 不被调用)', () => {
  const dir = mkTempDir();
  const { manifest } = m4bManifest(dir, { down: { cut_join: false } });
  let called = 0;
  const tl = buildTimeline({
    edit: m4bEdit([
      { shot_id: 's01-shot-01', take_id: 'take-001', source_in: 0, source_out: 100 },
      { shot_id: 's01-shot-02', take_id: 'take-001', source_in: 5, source_out: 55 }
    ], 0.6, { same_frame_ssim_threshold_marker: true }),
    manifest,
    options: { junctionCompare: () => { called++; return { ssim: 0.99 }; } }
  });
  assert.strictEqual(called, 0, 'compare must not be called for continue_from weak commitment');
  assert.strictEqual(tl.clips[0].source_out, 100, 'upstream source_out must be untouched');
  assert.strictEqual(tl.clips[1].source_in, 5);
  assert.strictEqual(tl.clips[1].deleted_head_frames, 0);
  assert.strictEqual(tl.clips[1].junction, undefined);
  assert.strictEqual(tl.clips[1].cut_join, false);
  assert.strictEqual(tl.clips[1].output_start, tl.clips[0].output_end);

  // 即使没有 same_frame_ssim_threshold 也合法(continue_from 不依赖 S)
  const tl2 = buildTimeline({
    edit: { timeline: { fps: 30, clips: [
      { shot_id: 's01-shot-01', take_id: 'take-001', source_in: 0, source_out: 40 },
      { shot_id: 's01-shot-02', take_id: 'take-001', source_in: 0, source_out: 30 }
    ] } },
    manifest,
    options: { junctionCompare: () => { throw new Error('must not run'); } }
  });
  assert.strictEqual(tl2.clips[1].deleted_head_frames, 0);
});

// ---- M4b5: 缺 S / 缺 take 文件 ----

test('M4b5. 缺 same_frame_ssim_threshold → 报错;缺 take 文件 / path → 报错', () => {
  const dir = mkTempDir();
  const { manifest } = m4bManifest(dir);
  const clips = [
    { shot_id: 's01-shot-01', take_id: 'take-001', source_in: 0, source_out: 100 },
    { shot_id: 's01-shot-02', take_id: 'take-001', source_in: 0, source_out: 50 }
  ];
  const stub = () => ({ ssim: 0.95 });

  // 缺失 S
  throws(() => buildTimeline({
    edit: { timeline: { fps: 30, clips } }, manifest, options: { junctionCompare: stub }
  }), 'cut_join requires timeline.same_frame_ssim_threshold');
  // S 非法(负 / 非有限)
  throws(() => buildTimeline({ edit: m4bEdit(clips, -1), manifest, options: { junctionCompare: stub } }),
    'cut_join requires timeline.same_frame_ssim_threshold');
  throws(() => buildTimeline({ edit: m4bEdit(clips, NaN), manifest, options: { junctionCompare: stub } }),
    'cut_join requires timeline.same_frame_ssim_threshold');

  // 缺 take 文件
  const mMissing = JSON.parse(JSON.stringify(manifest));
  mMissing.shots[0].takes[0].path = path.join(dir, 'does-not-exist.mp4');
  let err = null;
  try { buildTimeline({ edit: m4bEdit(clips, 0.6), manifest: mMissing, options: { junctionCompare: stub } }); }
  catch (e) { err = e.message; }
  assert.ok(err && /take file not found/.test(err), err);

  // 缺 take.path
  const mNoPath = JSON.parse(JSON.stringify(manifest));
  delete mNoPath.shots[1].takes[0].path;
  err = null;
  try { buildTimeline({ edit: m4bEdit(clips, 0.6), manifest: mNoPath, options: { junctionCompare: stub } }); }
  catch (e) { err = e.message; }
  assert.ok(err && /requires a take path/.test(err), err);

  // 非 cut_join 时不校验 take 文件存在性(既有 M1 契约不变)
  const mWeak = JSON.parse(JSON.stringify(manifest));
  mWeak.shots[1].cut_join = false;
  mWeak.shots[1].takes[0].path = path.join(dir, 'still-missing.mp4');
  const tl = buildTimeline({ edit: m4bEdit(clips, 0.6), manifest: mWeak });
  assert.strictEqual(tl.clips.length, 2);
});

// ---- M4b6: CFR 标准化参数(纯函数) ----

test('M4b6. cfrNormalizeArgs: 滤镜链 + 编码参数数组 + 帧率/尺寸校验', () => {
  const argv = cfrNormalizeArgs({ input: '/in.mp4', output: '/out.mp4', fps: 24, width: 720, height: 1280 });
  assert.ok(Array.isArray(argv));
  assert.deepStrictEqual(argv.slice(0, 3), ['-y', '-i', '/in.mp4']);
  assert.strictEqual(argv[argv.length - 1], '/out.mp4');
  const vf = argv[argv.indexOf('-vf') + 1];
  assert.strictEqual(vf,
    'scale=720:1280:force_original_aspect_ratio=decrease,' +
    'pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,fps=24,format=yuv420p', vf);
  for (const pair of [['-c:v', 'libx264'], ['-preset', 'fast'], ['-crf', '22'], ['-movflags', '+faststart']]) {
    const idx = argv.indexOf(pair[0]);
    assert.ok(idx >= 0, `missing ${pair[0]}`);
    assert.strictEqual(argv[idx + 1], pair[1]);
  }
  assert.ok(argv.includes('-an'), 'CFR 标准化不带音轨');
  throws(() => cfrNormalizeArgs({ input: '/i', output: '/o', fps: 0, width: 2, height: 2 }), 'positive integer');
  throws(() => cfrNormalizeArgs({ input: '/i', output: '/o', fps: 24, width: 3, height: 2 }), 'even');
  throws(() => cfrNormalizeArgs({ input: '/i', output: '/o', fps: 24, width: 2, height: 0 }), 'even');
  throws(() => cfrNormalizeArgs({ output: '/o', fps: 24, width: 2, height: 2 }), 'input');
  throws(() => cfrNormalizeArgs({ input: '/i', fps: 24, width: 2, height: 2 }), 'output');
});

// ---- M4b7: 接头比对帧号语义(注入 extractFrame/ssim,不依赖 ffmpeg) ----

test('M4b7. compareJunctionFrames: 注入 extractFrame/ssim → 抽 cutFrame-1 与 sourceIn', () => {
  const calls = [];
  const res = compareJunctionFrames(
    { upstreamPath: '/u.mp4', cutFrame: 2112, downstreamPath: '/d.mp4', sourceIn: 0, fps: 24 },
    {
      workDir: mkTempDir(),
      extractFrame: (args) => { calls.push(args); fs.writeFileSync(args.outPath, 'x'); },
      ssim: () => ({ value: 0.997, impl: 'stub', version: 'test' })
    }
  );
  assert.strictEqual(res.ssim, 0.997);
  assert.strictEqual(res.upstream_frame, 2111, '最后保留帧 = cutFrame - 1');
  assert.strictEqual(res.downstream_frame, 0);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].videoPath, '/u.mp4');
  assert.strictEqual(calls[0].frame, 2111);
  assert.strictEqual(calls[0].fps, 24);
  assert.strictEqual(calls[1].videoPath, '/d.mp4');
  assert.strictEqual(calls[1].frame, 0);
  throws(() => compareJunctionFrames(
    { upstreamPath: '/u', cutFrame: 0, downstreamPath: '/d', sourceIn: 0, fps: 24 },
    { extractFrame: () => {}, ssim: () => ({ value: 1 }) }
  ), 'positive integer');
  throws(() => compareJunctionFrames(
    { upstreamPath: '/u', cutFrame: 5, downstreamPath: '/d', sourceIn: -1, fps: 24 },
    { extractFrame: () => {}, ssim: () => ({ value: 1 }) }
  ), 'non-negative integer');
});

// ---- 可选 ffmpeg 门控集成 ----

testFfmpeg('M4b-ff. compareJunctionFrames: 同内容帧 SSIM ≥0.99;extractFrameAt 真实抽帧', () => {
  const dir = mkTempDir();
  const up = path.join(dir, 'up.mp4');
  const down = path.join(dir, 'down.mp4');
  for (const f of [up, down]) {
    const r = spawnSync(process.env.FFMPEG_BIN || 'ffmpeg', [
      '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=64x48:r=30', '-t', '1', '-pix_fmt', 'yuv420p', f
    ], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  }
  const out = path.join(dir, 'frame14.png');
  extractFrameAt({ videoPath: up, frame: 14, fps: 30, outPath: out });
  assert.ok(fs.existsSync(out), 'extractFrameAt must produce a PNG');
  const res = compareJunctionFrames({
    upstreamPath: up, cutFrame: 15, downstreamPath: down, sourceIn: 14, fps: 30, workDir: dir
  });
  assert.strictEqual(res.upstream_frame, 14);
  assert.strictEqual(res.downstream_frame, 14);
  assert.ok(res.ssim >= 0.99, `identical-content frames must match, got ${res.ssim}`);
});

// ============================================================
console.log('\n[M4c] bound approval record(版本绑定人工验收)(§3.3)');
// ============================================================

/**
 * M4c 测试夹具:上游 s01-shot-01 + cut_join 下游 s01-shot-02(两 take 文件存在)。
 * timeline 里下游 clip 已带 junction 审计记录(cut_frame=107,删 1 帧)。
 */
function m4cFixture(dir, opts = {}) {
  const up = path.join(dir, 'up.mp4');
  const down = path.join(dir, 'down.mp4');
  fs.writeFileSync(up, opts.upBytes || 'UPSTREAM-BYTES');
  fs.writeFileSync(down, opts.downBytes || 'DOWNSTREAM-BYTES');
  const s1 = shotBase('s01-shot-01', { status: 'done', selected_take: 'take-001',
    takes: [{ id: 'take-001', path: up, status: 'selected', input_hash: 'h1' }] });
  const s2 = shotBase('s01-shot-02', { status: 'done', cut_join: true, continue_from: 's01-shot-01', selected_take: 'take-001',
    takes: [{ id: 'take-001', path: down, status: 'selected', input_hash: 'h2' }] });
  const manifest = {
    episode: 'M4CTEST', schema_version: 2, fps: 30,
    shots: [s1, s2], render_tasks: [], approvals: [], approval_history: []
  };
  const timeline = { version: 1, fps: 30, clips: [
    { clip_id: 'clip-0001', shot_id: 's01-shot-01', take_id: 'take-001', source_in: 0, source_out: 107,
      deleted_head_frames: 0, padding_frames: 0, spill_in: [], cut_join: false, output_start: 0, output_end: 107 },
    { clip_id: 'clip-0002', shot_id: 's01-shot-02', take_id: 'take-001', source_in: 5, source_out: 55,
      deleted_head_frames: 1, padding_frames: 0, spill_in: [], cut_join: true,
      junction: { ssim: 0.95, threshold_s: 0.6, cut_frame: 107, deleted_head_frames: 1 },
      output_start: 107, output_end: 156 }
  ] };
  return { up, down, manifest, timeline };
}

/** 正确的 junction_review 记录(digest 取自当前文件) */
function m4cJunctionRecord(upPath, downPath, over = {}) {
  const base = {
    kind: 'junction_review', upstream_clip: 'clip-0001', downstream_clip: 'clip-0002', downstream_shot: null,
    bindings: {
      upstream: { take_id: 'take-001', content_digest: fileContentHash(upPath), source_out: 107 },
      downstream: {
        keyframe: { take_id: null, content_digest: null },
        video: { take_id: 'take-001', content_digest: fileContentHash(downPath) },
        source_in: 5, deleted_head_frames: 1
      }
    },
    verdict: { subject: 'pass', prop: 'pass', action_phase: 'pass', direction: 'pass' },
    reviewer: 'agent', reviewed_at: '2026-01-01T00:00:00.000Z'
  };
  return Object.assign(base, over);
}

// ---- M4c1: 存在性 + verdict 四要素 ----

test('M4c1. validateApprovals: 无 cut_join → ok;有 cut_join 无记录 → problem;verdict 非全 pass → problem', () => {
  const dir = mkTempDir();
  const { up, down, manifest, timeline } = m4cFixture(dir);

  // 无 cut_join → 允许为空(Release Gate #4b/#13 条件豁免)
  const weak = JSON.parse(JSON.stringify(timeline));
  weak.clips[1].cut_join = false;
  delete weak.clips[1].junction;
  let res = validateApprovals(manifest, weak);
  assert.strictEqual(res.ok, true, JSON.stringify(res.problems));
  assert.deepStrictEqual(res.problems, []);

  // 有 cut_join 但无记录 → problem(消息含 clip id)
  res = validateApprovals(manifest, timeline);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.problems.length, 1);
  assert.ok(res.problems[0].includes('clip-0002'), res.problems[0]);
  assert.ok(/no junction_review approval/.test(res.problems[0]), res.problems[0]);

  // 四要素全 pass 且绑定正确 → ok
  const okManifest = JSON.parse(JSON.stringify(manifest));
  okManifest.approvals = [m4cJunctionRecord(up, down)];
  res = validateApprovals(okManifest, timeline);
  assert.strictEqual(res.ok, true, JSON.stringify(res.problems));
  assert.deepStrictEqual(collectApprovalProblems(okManifest, timeline), []);

  // verdict 任一 fail → problem
  const failManifest = JSON.parse(JSON.stringify(okManifest));
  failManifest.approvals[0].verdict.subject = 'fail';
  res = validateApprovals(failManifest, timeline);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.problems.length, 1);
  assert.ok(res.problems[0].includes('clip-0002'), res.problems[0]);
  assert.ok(/verdict is not all-pass/.test(res.problems[0]), res.problems[0]);
  assert.ok(/subject=fail/.test(res.problems[0]), res.problems[0]);

  // 四要素缺一 → problem(列出 missing)
  const missManifest = JSON.parse(JSON.stringify(okManifest));
  delete missManifest.approvals[0].verdict.direction;
  res = validateApprovals(missManifest, timeline);
  assert.strictEqual(res.ok, false);
  assert.ok(/direction=\(missing\)/.test(res.problems[0]), res.problems[0]);

  // 纯函数辅助口径
  assert.strictEqual(isPassVerdict({ subject: 'pass', prop: 'pass', action_phase: 'pass', direction: 'pass' }), true);
  assert.strictEqual(isPassVerdict({ subject: 'pass', prop: 'pass', action_phase: 'pass' }), false);
  assert.strictEqual(isVerdictValue('pass'), true);
  assert.strictEqual(isVerdictValue('yes'), false);
  assert.strictEqual(isApprovalKind('junction_review'), true);
  assert.strictEqual(isApprovalKind('bogus'), false);
});

// ---- M4c2: digest / 语义参数变化 → 失效 ----

test('M4c2. 绑定变化:take 文件内容 / source_out / source_in / deleted_head_frames → invalid', () => {
  const dir = mkTempDir();
  const { up, down, manifest, timeline } = m4cFixture(dir);
  const m = JSON.parse(JSON.stringify(manifest));
  m.approvals = [m4cJunctionRecord(up, down)];
  assert.strictEqual(validateApprovals(m, timeline).ok, true, JSON.stringify(collectApprovalProblems(m, timeline)));

  // 上游 take 文件内容变化
  fs.writeFileSync(up, 'UPSTREAM-CHANGED');
  let res = validateApprovals(m, timeline);
  assert.strictEqual(res.ok, false);
  assert.ok(res.problems[0].includes('clip-0002'), res.problems[0]);
  assert.ok(/upstream content_digest/.test(res.problems[0]), res.problems[0]);
  fs.writeFileSync(up, 'UPSTREAM-BYTES');

  // 下游 take 文件内容变化
  fs.writeFileSync(down, 'DOWNSTREAM-CHANGED');
  res = validateApprovals(m, timeline);
  assert.strictEqual(res.ok, false);
  assert.ok(/downstream video content_digest/.test(res.problems[0]), res.problems[0]);
  fs.writeFileSync(down, 'DOWNSTREAM-BYTES');

  // 语义参数:上游 source_out(=cut_frame)
  const tOut = JSON.parse(JSON.stringify(timeline));
  tOut.clips[0].source_out = 106;
  res = validateApprovals(m, tOut);
  assert.strictEqual(res.ok, false);
  assert.ok(/upstream source_out/.test(res.problems[0]), res.problems[0]);

  // 语义参数:下游 source_in(删帧不改写 source_in)
  const tIn = JSON.parse(JSON.stringify(timeline));
  tIn.clips[1].source_in = 6;
  res = validateApprovals(m, tIn);
  assert.strictEqual(res.ok, false);
  assert.ok(/downstream source_in/.test(res.problems[0]), res.problems[0]);

  // 语义参数:deleted_head_frames
  const tDel = JSON.parse(JSON.stringify(timeline));
  tDel.clips[1].deleted_head_frames = 0;
  res = validateApprovals(m, tDel);
  assert.strictEqual(res.ok, false);
  assert.ok(/downstream deleted_head_frames/.test(res.problems[0]), res.problems[0]);
});

// ---- M4c3: locator 无关性 ----

test('M4c3. locator 无关性:clip_id/take_id 变化但 digest + 语义参数一致 → ok', () => {
  const dir = mkTempDir();
  const { up, down, manifest, timeline } = m4cFixture(dir);
  const m = JSON.parse(JSON.stringify(manifest));
  m.approvals = [m4cJunctionRecord(up, down)];
  assert.strictEqual(validateApprovals(m, timeline).ok, true, JSON.stringify(collectApprovalProblems(m, timeline)));

  // 新 take_id(内容一致,新文件路径)+ 新 clip_id
  const up2 = path.join(dir, 'renamed-up.mp4');
  const down2 = path.join(dir, 'renamed-down.mp4');
  fs.copyFileSync(up, up2);
  fs.copyFileSync(down, down2);
  const m2 = JSON.parse(JSON.stringify(m));
  m2.shots[0].takes[0].id = 'take-777';
  m2.shots[0].selected_take = 'take-777';
  m2.shots[0].takes[0].path = up2;
  m2.shots[1].takes[0].id = 'take-888';
  m2.shots[1].selected_take = 'take-888';
  m2.shots[1].takes[0].path = down2;
  const t2 = JSON.parse(JSON.stringify(timeline));
  t2.clips[0].clip_id = 'clip-A';
  t2.clips[0].take_id = 'take-777';
  t2.clips[1].clip_id = 'clip-B';
  t2.clips[1].take_id = 'take-888';

  const res = validateApprovals(m2, t2);
  assert.strictEqual(res.ok, true, `locator change must NOT invalidate: ${JSON.stringify(res.problems)}`);

  // 记录内 locator 被改写(甚至为 null)也不影响 validity
  const m3 = JSON.parse(JSON.stringify(m2));
  m3.approvals[0].upstream_clip = 'clip-zzz';
  m3.approvals[0].downstream_clip = null;
  m3.approvals[0].bindings.upstream.take_id = 'take-zzz';
  const res3 = validateApprovals(m3, t2);
  assert.strictEqual(res3.ok, true, JSON.stringify(res3.problems));
});

// ---- M4c4: accept_upstream ----

test('M4c4. accept_upstream: 绑 upstream digest + cut_frame;上游内容/cut_frame 变化 → invalid;无记录不强制', () => {
  const dir = mkTempDir();
  const up = path.join(dir, 'up.mp4');
  const down = path.join(dir, 'down.mp4');
  fs.writeFileSync(up, 'WEAK-UP');
  fs.writeFileSync(down, 'WEAK-DOWN');
  const manifest = {
    episode: 'M4CTEST', schema_version: 2, fps: 30, render_tasks: [], approvals: [], approval_history: [],
    shots: [
      shotBase('s01-shot-01', { status: 'done', selected_take: 'take-001',
        takes: [{ id: 'take-001', path: up, status: 'selected', input_hash: 'h1' }] }),
      shotBase('s01-shot-02', { status: 'done', cut_join: false, continue_from: 's01-shot-01', selected_take: 'take-001',
        takes: [{ id: 'take-001', path: down, status: 'selected', input_hash: 'h2' }] })
    ]
  };
  const timeline = { version: 1, fps: 30, clips: [
    { clip_id: 'clip-0001', shot_id: 's01-shot-01', take_id: 'take-001', source_in: 0, source_out: 100,
      deleted_head_frames: 0, padding_frames: 0, spill_in: [], cut_join: false, output_start: 0, output_end: 100 },
    { clip_id: 'clip-0002', shot_id: 's01-shot-02', take_id: 'take-001', source_in: 0, source_out: 50,
      deleted_head_frames: 0, padding_frames: 0, spill_in: [], cut_join: false, output_start: 100, output_end: 150 }
  ] };

  // 无记录 → ok(continue_from 是弱承诺,允许无记录)
  assert.strictEqual(validateApprovals(manifest, timeline).ok, true);

  // cut_frame 解析:时间线上游 clip 的 source_out
  const cut = resolveAcceptUpstreamCutFrame(manifest, timeline, manifest.shots[1]);
  assert.deepStrictEqual(cut, { cut_frame: 100, source: 'timeline.upstream_clip' });

  const record = {
    kind: 'accept_upstream', upstream_clip: null, downstream_clip: 'clip-0002', downstream_shot: 's01-shot-02',
    bindings: {
      upstream: { take_id: 'take-001', content_digest: fileContentHash(up), source_out: 100 },
      downstream: { video: { take_id: 'take-001', content_digest: fileContentHash(down) }, source_in: 0, deleted_head_frames: 0 }
    },
    reviewer: 'agent', reviewed_at: '2026-01-01T00:00:00.000Z'
  };
  const m = JSON.parse(JSON.stringify(manifest));
  m.approvals = [record];
  assert.strictEqual(validateApprovals(m, timeline).ok, true, JSON.stringify(collectApprovalProblems(m, timeline)));

  // 上游 take 内容变化 → invalid
  fs.writeFileSync(up, 'WEAK-UP-CHANGED');
  let res = validateApprovals(m, timeline);
  assert.strictEqual(res.ok, false);
  assert.ok(/accept_upstream/.test(res.problems[0]), res.problems[0]);
  assert.ok(/upstream content_digest changed/.test(res.problems[0]), res.problems[0]);
  fs.writeFileSync(up, 'WEAK-UP');

  // cut_frame 变化(上游 clip source_out)→ invalid
  const t2 = JSON.parse(JSON.stringify(timeline));
  t2.clips[0].source_out = 90;
  res = validateApprovals(m, t2);
  assert.strictEqual(res.ok, false);
  assert.ok(/cut_frame changed/.test(res.problems[0]), res.problems[0]);
});

// ---- M4c5: mark-approval.js 集成(CLI) ----

test('M4c5. mark-approval.js 集成:junction_review 落盘 bindings / 四要素校验 / accept_upstream / 覆盖 + approval_history', () => {
  const dir = mkTempDir();
  const { up, down, manifest, timeline } = m4cFixture(dir);
  writeManifest(dir, manifest);
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(timeline, null, 2));
  const cli = path.join(ROOT, 'tools', 'mark-approval.js');
  const run = (args) => spawnSync(process.execPath, [cli, dir, ...args], { encoding: 'utf8' });

  // 四要素缺失 → 非零退出
  let r = run(['--kind', 'junction_review', '--upstream-clip', 'clip-0001', '--downstream-clip', 'clip-0002', '--subject', 'pass']);
  assert.notStrictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok(/requires --prop/.test(r.stderr), r.stderr);

  // 非法取值 → 非零退出
  r = run(['--kind', 'junction_review', '--upstream-clip', 'clip-0001', '--downstream-clip', 'clip-0002',
    '--subject', 'yes', '--prop', 'pass', '--action-phase', 'pass', '--direction', 'pass']);
  assert.notStrictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok(/must be pass or fail/.test(r.stderr), r.stderr);

  // 未知 kind / 不存在的 clip → 非零退出
  r = run(['--kind', 'bogus']);
  assert.notStrictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok(/--kind must be one of/.test(r.stderr), r.stderr);
  r = run(['--kind', 'junction_review', '--upstream-clip', 'clip-nope', '--downstream-clip', 'clip-0002',
    '--subject', 'pass', '--prop', 'pass', '--action-phase', 'pass', '--direction', 'pass']);
  assert.notStrictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok(/clip-nope not found/.test(r.stderr), r.stderr);

  // 正常写入:bindings 与 timeline/manifest 当前内容一致
  r = run(['--kind', 'junction_review', '--upstream-clip', 'clip-0001', '--downstream-clip', 'clip-0002',
    '--subject', 'pass', '--prop', 'pass', '--action-phase', 'pass', '--direction', 'pass', '--reviewer', 'human']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  let m = readManifest(dir);
  assert.strictEqual(m.approvals.length, 1);
  const rec = m.approvals[0];
  assert.strictEqual(rec.kind, 'junction_review');
  assert.strictEqual(rec.upstream_clip, 'clip-0001');
  assert.strictEqual(rec.downstream_clip, 'clip-0002');
  assert.deepStrictEqual(rec.bindings, {
    upstream: { take_id: 'take-001', content_digest: fileContentHash(up), source_out: 107 },
    downstream: {
      keyframe: { take_id: null, content_digest: null },
      video: { take_id: 'take-001', content_digest: fileContentHash(down) },
      source_in: 5, deleted_head_frames: 1
    }
  });
  assert.deepStrictEqual(rec.verdict, { subject: 'pass', prop: 'pass', action_phase: 'pass', direction: 'pass' });
  assert.strictEqual(rec.reviewer, 'human');
  assert.ok(typeof rec.reviewed_at === 'string' && rec.reviewed_at.length > 0);
  assert.deepStrictEqual(collectApprovalProblems(m, timeline), []);

  // 重复确认 → 覆盖 + 旧记录进 approval_history(附 superseded_at)
  r = run(['--kind', 'junction_review', '--upstream-clip', 'clip-0001', '--downstream-clip', 'clip-0002',
    '--subject', 'pass', '--prop', 'pass', '--action-phase', 'pass', '--direction', 'pass', '--reviewer', 'agent']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  m = readManifest(dir);
  assert.strictEqual(m.approvals.length, 1);
  assert.strictEqual(m.approvals[0].reviewer, 'agent');
  assert.strictEqual(m.approval_history.length, 1);
  assert.strictEqual(m.approval_history[0].reviewer, 'human');
  assert.ok(typeof m.approval_history[0].superseded_at === 'string');

  // accept_upstream
  r = run(['--kind', 'accept_upstream', '--downstream-shot', 's01-shot-02', '--reviewer', 'human']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  m = readManifest(dir);
  assert.strictEqual(m.approvals.length, 2);
  const rec2 = m.approvals.find(x => x.kind === 'accept_upstream');
  assert.ok(rec2, JSON.stringify(m.approvals));
  assert.strictEqual(rec2.downstream_shot, 's01-shot-02');
  assert.strictEqual(rec2.bindings.upstream.content_digest, fileContentHash(up));
  assert.strictEqual(rec2.bindings.upstream.source_out, 107, 'cut_join junction.cut_frame is the authoritative cut_frame');
  assert.strictEqual(rec2.bindings.downstream.video.content_digest, fileContentHash(down));
  assert.deepStrictEqual(collectApprovalProblems(m, timeline), []);

  // 上游 take 内容变化后,同 kind 再次确认会覆盖旧记录
  fs.writeFileSync(up, 'UPSTREAM-MOVED-ON');
  r = run(['--kind', 'accept_upstream', '--downstream-shot', 's01-shot-02', '--reviewer', 'human']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  m = readManifest(dir);
  assert.strictEqual(m.approvals.length, 2);
  assert.strictEqual(m.approval_history.length, 2);
  assert.strictEqual(m.approvals.find(x => x.kind === 'accept_upstream').bindings.upstream.content_digest, fileContentHash(up));
});

// ---- M4c6: 导出入口检查函数 ----

test('M4c6. edit/stitch 导出入口检查函数:非法记录 → problems;合法 → 空;缺 timeline → 跳过', () => {
  const dir = mkTempDir();
  const { up, down, manifest, timeline } = m4cFixture(dir);
  writeManifest(dir, manifest);
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(timeline, null, 2));

  // 有 cut_join 但无 approval → 两个入口都给 problems
  let probs = collectEditApprovalProblems(dir, manifest);
  assert.strictEqual(probs.length, 1);
  assert.ok(probs[0].includes('clip-0002'), probs[0]);
  assert.deepStrictEqual(collectFinalApprovalProblems(dir, manifest), probs);

  // 合法记录 → 空
  const m2 = JSON.parse(JSON.stringify(manifest));
  m2.approvals = [m4cJunctionRecord(up, down)];
  assert.deepStrictEqual(collectEditApprovalProblems(dir, m2), []);
  assert.deepStrictEqual(collectFinalApprovalProblems(dir, m2), []);

  // verdict fail → problems(即使 locator 未变)
  const m3 = JSON.parse(JSON.stringify(m2));
  m3.approvals[0].verdict.direction = 'fail';
  assert.strictEqual(collectEditApprovalProblems(dir, m3).length, 1);
  assert.strictEqual(collectFinalApprovalProblems(dir, m3).length, 1);

  // 绑定失效(take 内容变化)→ problems
  fs.writeFileSync(down, 'DOWNSTREAM-MOVED-ON');
  assert.strictEqual(collectEditApprovalProblems(dir, m2).length, 1);

  // timeline.json 缺失 → 跳过(空)+ WARN
  const emptyDir = mkTempDir();
  writeManifest(emptyDir, manifest);
  const check = checkApprovalsForEpisode(emptyDir, manifest);
  assert.strictEqual(check.skipped, true);
  assert.deepStrictEqual(check.problems, []);
  assert.ok(/timeline.json not found/.test(check.warning), check.warning);
  assert.deepStrictEqual(collectEditApprovalProblems(emptyDir, manifest), []);
  assert.deepStrictEqual(collectFinalApprovalProblems(emptyDir, manifest), []);
});

// ============================================================
console.log('\n[M5a] 制作意图声明与配置校验(§4)');
// ============================================================

// ---- M5a1: detectDialogue 兼容形态 ----

test('M5a1. detectDialogue:非空字符串/数组/{text}/{lines} 即 true;空白与空集不算', () => {
  const mk = (dialogue) => ({ scenes: [{ id: 's01', shots: [{ id: 's01-shot-01', dialogue }] }] });
  assert.strictEqual(detectDialogue(mk('hello')), true);
  assert.strictEqual(detectDialogue(mk(['line 1', { text: 'line 2' }])), true);
  assert.strictEqual(detectDialogue(mk({ text: 'hi' })), true);
  assert.strictEqual(detectDialogue(mk({ lines: ['a', { text: 'b' }] })), true);
  assert.strictEqual(detectDialogue(mk('   \n\t ')), false, 'whitespace-only string is not dialogue');
  assert.strictEqual(detectDialogue(mk([])), false);
  assert.strictEqual(detectDialogue(mk(['', '  '])), false);
  assert.strictEqual(detectDialogue(mk({ lines: [] })), false);
  assert.strictEqual(detectDialogue(mk({ text: '   ' })), false);
  assert.strictEqual(detectDialogue({ scenes: [{ shots: [{ id: 's01-shot-01' }] }] }), false);
  assert.strictEqual(detectDialogue({}), false);
});

// ---- M5a2: 派生规则 ----

test('M5a2. 派生:无 dialogue → audio=music_sfx;有 dialogue → dialogue;全 derived、declared=false', () => {
  let i = deriveIntent({ scenes: [{ shots: [{ id: 'a' }] }] });
  assert.strictEqual(i.dialogue, false);
  assert.strictEqual(i.audio, 'music_sfx', 'derived audio is never none');
  assert.strictEqual(i.subtitles, 'none');
  assert.strictEqual(i.silent, false);
  for (const f of ['dialogue', 'audio', 'subtitles', 'silent']) {
    assert.strictEqual(i.declared[f], false, `${f} must not be declared`);
    assert.strictEqual(i.sources[f], 'derived', `${f} source must be derived`);
  }

  i = deriveIntent({ scenes: [{ shots: [{ id: 'a', dialogue: 'hi' }] }] });
  assert.strictEqual(i.dialogue, true);
  assert.strictEqual(i.audio, 'dialogue');
  assert.strictEqual(i.subtitles, 'none');
  assert.strictEqual(i.silent, false);
  assert.strictEqual(i.declared.dialogue, false, 'detection alone is not a declaration');
});

// ---- M5a3: 显式来源优先级 + 逐字段独立 ----

test('M5a3. 显式优先级:edit 覆盖 script;逐字段独立;edit.timeline.intent 也算 edit 且 edit.intent 优先', () => {
  const script = {
    intent: { dialogue: true, subtitles: 'soft' },
    scenes: [{ shots: [{ id: 'a', dialogue: 'x' }] }],
  };

  // edit.intent 覆盖 dialogue;script.subtitles 保留
  let i = deriveIntent(script, { edit: { intent: { dialogue: false } } });
  assert.strictEqual(i.dialogue, false);
  assert.strictEqual(i.sources.dialogue, 'edit');
  assert.strictEqual(i.declared.dialogue, true);
  assert.strictEqual(i.subtitles, 'soft');
  assert.strictEqual(i.sources.subtitles, 'script');

  // 只声明 subtitles → 不覆盖 dialogue(逐字段独立)
  i = deriveIntent(script, { edit: { intent: { subtitles: 'burn' } } });
  assert.strictEqual(i.dialogue, true);
  assert.strictEqual(i.sources.dialogue, 'script');
  assert.strictEqual(i.subtitles, 'burn');
  assert.strictEqual(i.sources.subtitles, 'edit');

  // edit.timeline.intent 也算 edit 来源
  i = deriveIntent(script, { edit: { timeline: { intent: { silent: true, dialogue: false } } } });
  assert.strictEqual(i.silent, true);
  assert.strictEqual(i.sources.silent, 'edit');
  assert.strictEqual(i.dialogue, false);

  // edit.intent 优先于 edit.timeline.intent
  i = deriveIntent(script, { edit: { intent: { dialogue: true }, timeline: { intent: { dialogue: false } } } });
  assert.strictEqual(i.dialogue, true);
  assert.strictEqual(i.sources.dialogue, 'edit');
});

// ---- M5a4: 三条非法组合 ----

test('M5a4. 非法组合:dialogue+audio=none / dialogue+silent / dialogue+subtitles=none 各报错且含字段', () => {
  const base = { dialogue: true, audio: 'dialogue', subtitles: 'burn', silent: false, declared: { dialogue: true, audio: true, subtitles: true, silent: true } };

  let r = validateIntent(Object.assign({}, base, { audio: 'none' }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some(e => /dialogue/.test(e) && /audio/.test(e) && /none/.test(e)), JSON.stringify(r.errors));

  r = validateIntent(Object.assign({}, base, { silent: true }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some(e => /dialogue/.test(e) && /silent/.test(e)), JSON.stringify(r.errors));

  r = validateIntent(Object.assign({}, base, { subtitles: 'none' }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some(e => /dialogue/.test(e) && /subtitles/.test(e) && /none/.test(e)), JSON.stringify(r.errors));
});

// ---- M5a5: 合法例外 + audio=none 必须显式 ----

test('M5a5. 合法例外:dialogue=false + subtitles!=none;audio=none+silent=true → redundant;audio=none 未声明 → error', () => {
  let r = validateIntent({
    dialogue: false, audio: 'music_sfx', subtitles: 'burn', silent: false,
    declared: { dialogue: false, audio: false, subtitles: true, silent: false },
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));

  r = validateIntent({
    dialogue: false, audio: 'none', subtitles: 'none', silent: true,
    declared: { dialogue: false, audio: true, subtitles: false, silent: true },
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.deepStrictEqual(r.normalized.redundant, ['silent']);
  assert.strictEqual(r.normalized.silent, true, 'redundant declaration is kept, only annotated');

  r = validateIntent({
    dialogue: false, audio: 'none', subtitles: 'none', silent: false,
    declared: { dialogue: false, audio: false, subtitles: false, silent: false },
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some(e => /intent\.audio: none must be explicitly declared/.test(e)), JSON.stringify(r.errors));
});

// ---- M5a6: intentFlags 真值表 ----

test('M5a6. intentFlags 真值表:audio=none → requires_audio=false;silent=true → 跳过 loudnorm', () => {
  const flags = (o) => intentFlags(Object.assign({ dialogue: false, audio: 'music_sfx', subtitles: 'none', silent: false }, o));
  assert.deepStrictEqual(flags({}), {
    requires_subtitles: false, requires_audio: true, requires_loudnorm: true,
    subtitle_exemption: true, audio_exemption: false,
  });
  assert.deepStrictEqual(flags({ dialogue: true, audio: 'dialogue', subtitles: 'none' }), {
    requires_subtitles: true, requires_audio: true, requires_loudnorm: true,
    subtitle_exemption: false, audio_exemption: false,
  });
  assert.deepStrictEqual(flags({ dialogue: false, subtitles: 'burn' }), {
    requires_subtitles: true, requires_audio: true, requires_loudnorm: true,
    subtitle_exemption: false, audio_exemption: false,
  });
  assert.deepStrictEqual(flags({ audio: 'none', silent: true }), {
    requires_subtitles: false, requires_audio: false, requires_loudnorm: false,
    subtitle_exemption: true, audio_exemption: true,
  });
  assert.deepStrictEqual(flags({ audio: 'none' }), {
    requires_subtitles: false, requires_audio: false, requires_loudnorm: false,
    subtitle_exemption: true, audio_exemption: true,
  });
  assert.deepStrictEqual(flags({ silent: true }), {
    requires_subtitles: false, requires_audio: true, requires_loudnorm: false,
    subtitle_exemption: true, audio_exemption: false,
  });
});

// ---- M5a7: build-manifest CLI 集成 ----

test('M5a7. 集成:合法 → manifest.intent 落盘且 flags 正确;非法 → 非零退出且 manifest 未创建/未改动', () => {
  const dir = mkTempDir();
  const script = [
    'episode: M5ATEST', 'title: T',
    'intent:', '  dialogue: false', '  audio: full', '  subtitles: burn',
    'defaults:', '  duration: 8', "  ratio: '16:9'", "  resolution: '720p'", "  model: 'default'",
    'scenes:', '  - id: s01', '    shots:',
    '      - id: s01-shot-01', "        style_en: 'cinematic'", "        prompt_en: 'a'", ''
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'script.yaml'), script);

  let r = runBuildManifest(dir);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  const m = readManifest(dir);
  assert.deepStrictEqual(m.intent, {
    dialogue: false, audio: 'full', subtitles: 'burn', silent: false,
    requires_subtitles: true, requires_audio: true, requires_loudnorm: true,
    declared: { dialogue: true, audio: true, subtitles: true, silent: false },
    sources: { dialogue: 'script', audio: 'script', subtitles: 'script', silent: 'derived' },
  });

  // 合法 manifest 落盘后,edit.yaml 加入矛盾声明 → 非零退出且旧 manifest 原样保留
  const before = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');
  fs.writeFileSync(path.join(dir, 'edit.yaml'), ['intent:', '  dialogue: true', '  audio: none', ''].join('\n'));
  r = runBuildManifest(dir);
  assert.notStrictEqual(r.status, 0, 'conflicting intent must fail the build');
  const out = r.stdout + r.stderr;
  assert.ok(/intent validation failed/.test(out), out);
  assert.ok(out.includes('intent.audio'), out);
  assert.ok(!/none must be explicitly declared/.test(out), 'audio=none was declared, so that specific error must not fire');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), before, 'existing manifest must be unchanged');

  // 空目录非法声明 → 不创建 manifest
  const dir2 = mkTempDir();
  fs.writeFileSync(path.join(dir2, 'script.yaml'), [
    'episode: M5ATEST2', 'title: T',
    'intent:', '  dialogue: true', '  audio: none',
    'defaults:', '  duration: 8', "  ratio: '16:9'", "  resolution: '720p'", "  model: 'default'",
    'scenes:', '  - id: s01', '    shots:',
    '      - id: s01-shot-01', "        style_en: 'cinematic'", "        prompt_en: 'a'", ''
  ].join('\n'));
  const r2 = runBuildManifest(dir2);
  assert.notStrictEqual(r2.status, 0, 'conflicting intent must fail the build');
  assert.ok(!fs.existsSync(path.join(dir2, 'manifest.json')), 'must not write a manifest on intent failure');
});

// ---- M5a8: 真实 episode 回归(只读) ----

test('M5a8. 真实 episode 回归:S01E01-pov 无 dialogue → audio=music_sfx / requires_subtitles=false / requires_audio=true', () => {
  const realScript = loadYaml(path.join(ROOT, 'episodes', 'S01E01-pov', 'script.yaml'));
  assert.ok(realScript && Array.isArray(realScript.scenes), 'real script must load');
  const i = deriveIntent(realScript);
  assert.strictEqual(i.dialogue, false);
  assert.strictEqual(i.audio, 'music_sfx');
  assert.strictEqual(i.subtitles, 'none');
  assert.strictEqual(i.silent, false);
  const v = validateIntent(i);
  assert.strictEqual(v.ok, true, JSON.stringify(v.errors));
  const f = intentFlags(v.normalized);
  assert.strictEqual(f.requires_subtitles, false);
  assert.strictEqual(f.requires_audio, true);
  assert.strictEqual(f.requires_loudnorm, true);
});

// ============================================================
console.log('\n[M5b] final 媒体属性探测 + 完整解码验证(§4/TECH-DEBT A6)');
// ============================================================

/** 媒体探测 fixture(纯函数用例) */
function probeFixture(over = {}) {
  const base = {
    video: { codec: 'h264', width: 1280, height: 720, fps: 30, pix_fmt: 'yuv420p', duration: 8 },
    audio: { codec: 'aac', sample_rate: 48000, channels: 2, duration: 8 },
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: 8 },
  };
  return {
    video: over.video === undefined ? base.video : over.video,
    audio: over.audio === undefined ? base.audio : over.audio,
    format: over.format === undefined ? base.format : over.format,
  };
}
/** v2 模板 + requires_audio=true 的检查参数 */
const V2_MEDIA_CHECK = {
  schemaVersion: 2,
  template: { ratio: '16:9', resolution: '720p' },
  fps: 30,
  intent: { audio: 'full' },
};

// ---- M5b1: parseProbeJson ----

test('M5b1. parseProbeJson:video+audio / 仅 video / 0/0 fps / r_frame_rate 回退 / 坏 JSON 抛错', () => {
  const full = JSON.stringify({ streams: [
    { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, avg_frame_rate: '30000/1001', pix_fmt: 'yuv420p', duration: '8.033000' },
    { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2, duration: '8.033000' },
  ], format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '8.033000' } });
  const p = parseProbeJson(full);
  assert.strictEqual(p.video.codec, 'h264');
  assert.strictEqual(p.video.width, 1280);
  assert.strictEqual(p.video.height, 720);
  assert.ok(Math.abs(p.video.fps - 29.970) < 0.01, String(p.video.fps));
  assert.strictEqual(p.video.pix_fmt, 'yuv420p');
  assert.strictEqual(p.video.duration, 8.033);
  assert.deepStrictEqual(p.audio, { codec: 'aac', sample_rate: 48000, channels: 2, duration: 8.033 });
  assert.strictEqual(p.format.format_name, 'mov,mp4,m4a,3gp,3g2,mj2');
  assert.strictEqual(p.format.duration, 8.033);
  assert.deepStrictEqual(parseProbeJson(JSON.parse(full)), p, '已解析对象入参同样接受');

  // 仅 video → audio=null
  const videoOnly = parseProbeJson({ streams: [
    { codec_type: 'video', codec_name: 'h264', width: 64, height: 48, avg_frame_rate: '30/1', pix_fmt: 'yuv420p', duration: '1' },
  ], format: { format_name: 'mov', duration: '1' } });
  assert.strictEqual(videoOnly.audio, null);

  // 无 video 流 → video=null
  const audioOnly = parseProbeJson({ streams: [
    { codec_type: 'audio', codec_name: 'aac', sample_rate: '44100', channels: 1 },
  ], format: { format_name: 'mp3' } });
  assert.strictEqual(audioOnly.video, null);
  assert.strictEqual(audioOnly.audio.sample_rate, 44100);

  // 0/0 fps → null;avg 缺失 → r_frame_rate 回退
  assert.strictEqual(parseProbeJson({ streams: [{ codec_type: 'video', avg_frame_rate: '0/0', r_frame_rate: '0/0' }], format: {} }).video.fps, null);
  assert.strictEqual(parseProbeJson({ streams: [{ codec_type: 'video', r_frame_rate: '25/1' }], format: {} }).video.fps, 25);

  throws(() => parseProbeJson('{ not json'), 'parse failed');
  throws(() => parseProbeJson('[]'), 'must be an object');
});

// ---- M5b2: expectedVideoSpec ----

test('M5b2. expectedVideoSpec:16:9/9:16/1:1/1080p 换算 + 显式 width/height 优先 + 非法抛错', () => {
  const spec = (o) => expectedVideoSpec({ template: o });
  assert.deepStrictEqual(spec({ ratio: '16:9', resolution: '720p' }), { width: 1280, height: 720, fps: null, pix_fmt: 'yuv420p' });
  assert.deepStrictEqual(spec({ ratio: '9:16', resolution: '720p' }), { width: 720, height: 1280, fps: null, pix_fmt: 'yuv420p' });
  assert.deepStrictEqual(spec({ ratio: '1:1', resolution: '720p' }), { width: 720, height: 720, fps: null, pix_fmt: 'yuv420p' });
  assert.deepStrictEqual(spec({ ratio: '16:9', resolution: '1080p' }), { width: 1920, height: 1080, fps: null, pix_fmt: 'yuv420p' });
  assert.deepStrictEqual(spec({ ratio: '21:9', resolution: '1080p' }), { width: 2520, height: 1080, fps: null, pix_fmt: 'yuv420p' });
  assert.deepStrictEqual(spec({ ratio: '4:5', resolution: '480p' }), { width: 480, height: 600, fps: null, pix_fmt: 'yuv420p' });

  // 显式 width/height 优先(直接用,不推算、不要求 ratio/resolution)
  assert.deepStrictEqual(expectedVideoSpec({ template: { width: 1000, height: 600 }, fps: 24 }), { width: 1000, height: 600, fps: 24, pix_fmt: 'yuv420p' });
  assert.deepStrictEqual(
    expectedVideoSpec({ template: { width: 1000, height: 600, ratio: '16:9', resolution: '720p' } }),
    { width: 1000, height: 600, fps: null, pix_fmt: 'yuv420p' }
  );

  // fps 由参数或 template.fps
  assert.strictEqual(expectedVideoSpec({ template: { ratio: '16:9', resolution: '720p', fps: 30 } }).fps, 30);
  assert.strictEqual(expectedVideoSpec({ template: { ratio: '16:9', resolution: '720p', fps: 30 }, fps: 25 }).fps, 25);

  // 非法 fail-closed,消息含实际值
  throws(() => spec({ ratio: '16:9', resolution: 'foo' }), 'foo');
  throws(() => spec({ ratio: '5:7', resolution: '720p' }), '5:7');
  throws(() => spec({ ratio: '16:9' }), 'undefined');
  throws(() => expectedVideoSpec({ template: { width: -1, height: 600 } }), 'width');
});

// ---- M5b3: checkMediaSpec(v1/v2 + 音频豁免) ----

test('M5b3. checkMediaSpec v2:全匹配无 problem;逐项错各报对应 problem;requires_audio=false 豁免;v1 仅视频流', () => {
  assert.deepStrictEqual(checkMediaSpec(probeFixture(), V2_MEDIA_CHECK), []);

  const vid = (o) => probeFixture({ video: Object.assign({}, probeFixture().video, o) });
  const aud = (o) => probeFixture({ audio: Object.assign({}, probeFixture().audio, o) });

  let probs = checkMediaSpec(vid({ width: 1920 }), V2_MEDIA_CHECK);
  assert.ok(probs.some((p) => /width mismatch/.test(p) && /1920/.test(p) && /1280/.test(p)), JSON.stringify(probs));
  probs = checkMediaSpec(vid({ height: 1080 }), V2_MEDIA_CHECK);
  assert.ok(probs.some((p) => /height mismatch/.test(p) && /1080/.test(p) && /720/.test(p)), JSON.stringify(probs));
  probs = checkMediaSpec(vid({ fps: 24 }), V2_MEDIA_CHECK);
  assert.ok(probs.some((p) => /fps mismatch/.test(p)), JSON.stringify(probs));
  assert.deepStrictEqual(checkMediaSpec(vid({ fps: 30.4 }), V2_MEDIA_CHECK), [], '0.4 < 0.5 容差内');
  probs = checkMediaSpec(vid({ pix_fmt: 'yuv444p' }), V2_MEDIA_CHECK);
  assert.ok(probs.some((p) => /pix_fmt mismatch/.test(p) && /yuv444p/.test(p)), JSON.stringify(probs));

  assert.ok(checkMediaSpec(aud({ codec: 'mp3' }), V2_MEDIA_CHECK).some((p) => /audio codec mismatch/.test(p)));
  assert.ok(checkMediaSpec(aud({ sample_rate: 44100 }), V2_MEDIA_CHECK).some((p) => /sample_rate mismatch/.test(p)));
  assert.ok(checkMediaSpec(aud({ channels: 1 }), V2_MEDIA_CHECK).some((p) => /channels mismatch/.test(p)));
  assert.ok(checkMediaSpec(probeFixture({ audio: null }), V2_MEDIA_CHECK).some((p) => /audio stream missing/.test(p)));

  // requires_audio=false → 全部音频规格检查豁免(音轨缺失/规格错都不报)
  const noAudio = Object.assign({}, V2_MEDIA_CHECK, { intent: { audio: 'none' } });
  assert.deepStrictEqual(checkMediaSpec(probeFixture({ audio: null }), noAudio), []);
  assert.deepStrictEqual(checkMediaSpec(aud({ codec: 'mp3', sample_rate: 32000, channels: 1 }), noAudio), []);
  assert.ok(checkMediaSpec(probeFixture({ video: null }), noAudio).some((p) => /video stream missing/.test(p)), '视频流仍必须存在');

  // v1 → 仅要求 video 流存在 + 容器可识别(错分辨率/FPS/pix_fmt/缺音轨都不报)
  const v1 = Object.assign({}, V2_MEDIA_CHECK, { schemaVersion: 1 });
  assert.deepStrictEqual(
    checkMediaSpec(probeFixture({
      video: Object.assign({}, probeFixture().video, { width: 100, height: 100, fps: 12, pix_fmt: 'yuv444p' }),
      audio: null,
    }), v1),
    []
  );
  assert.ok(checkMediaSpec(probeFixture({ video: null }), v1).some((p) => /video stream missing/.test(p)));
  assert.ok(checkMediaSpec(probeFixture({ format: { format_name: '' } }), v1).some((p) => /container/.test(p)));
});

// ---- M5b4: checkAvLength ----

test('M5b4. checkAvLength:差 0.05 通过、差 0.2 失败、audio=none/无音轨只校验视频时长', () => {
  const full = { schemaVersion: 2, intent: { audio: 'full' } };
  assert.deepStrictEqual(checkAvLength(probeFixture(), full), []);
  assert.deepStrictEqual(
    checkAvLength(probeFixture({ audio: { codec: 'aac', sample_rate: 48000, channels: 2, duration: 8.05 } }), full),
    [],
    '0.05 < 0.1'
  );
  assert.ok(
    checkAvLength(probeFixture({ audio: { codec: 'aac', sample_rate: 48000, channels: 2, duration: 8.2 } }), full)
      .some((p) => /A\/V duration mismatch/.test(p)),
    '0.2 >= 0.1 必须失败'
  );

  // audio=none → 无音轨通过;有音轨也不比较
  const noAudio = { schemaVersion: 2, intent: { audio: 'none' } };
  assert.deepStrictEqual(checkAvLength(probeFixture({ audio: null }), noAudio), []);
  assert.deepStrictEqual(
    checkAvLength(probeFixture({ audio: { codec: 'aac', sample_rate: 48000, channels: 2, duration: 99 } }), noAudio),
    [],
    'audio=none 只校验视频'
  );

  // video duration 缺失/非正 → 失败
  assert.ok(checkAvLength(probeFixture({ video: null }), full).length > 0);
  assert.ok(checkAvLength(probeFixture({ video: Object.assign({}, probeFixture().video, { duration: 0 }) }), full).length > 0);
});

// ---- M5b5: verifyFinalMedia(stub 注入) ----

test('M5b5. verifyFinalMedia(stub):全过 → ok;spec 失败 → decode/av skipped;probe 抛错 → problems 含摘要', () => {
  const manifest = { ratio: '16:9', resolution: '720p', fps: 30, schema_version: 2, intent: { audio: 'full' } };
  const good = probeFixture();
  const okDecode = () => ({ ok: true, exitCode: 0, timedOut: false, stderrTail: '' });

  let r = verifyFinalMedia({
    finalPath: '/tmp/x.mp4', manifest,
    opts: { probeMedia: () => good, verifyDecode: okDecode },
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r.problems));
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(r.steps.probe.ok, true);
  assert.strictEqual(r.steps.spec.ok, true);
  assert.strictEqual(r.steps.decode.ok, true);
  assert.strictEqual(r.steps.av_length.ok, true);

  // spec 失败 → decode/av_length skipped,decode 不被调用
  r = verifyFinalMedia({
    finalPath: '/tmp/x.mp4', manifest,
    opts: {
      probeMedia: () => probeFixture({ video: Object.assign({}, good.video, { width: 1920 }) }),
      verifyDecode: () => { throw new Error('decode must not run after spec failure'); },
    },
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.steps.spec.ok, false);
  assert.strictEqual(r.steps.decode.skipped, true);
  assert.strictEqual(r.steps.av_length.skipped, true);
  assert.ok(r.problems.some((p) => /spec: width mismatch/.test(p)), JSON.stringify(r.problems));

  // probe 抛错 → problems 含摘要,后续步骤 skipped
  r = verifyFinalMedia({
    finalPath: '/tmp/missing.mp4', manifest: { schema_version: 2 },
    opts: {
      probeMedia: () => { throw new Error('media file not found for probing: /tmp/missing.mp4'); },
      verifyDecode: () => { throw new Error('decode must not run after probe failure'); },
    },
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.probe, null);
  assert.strictEqual(r.steps.spec.skipped, true);
  assert.strictEqual(r.steps.decode.skipped, true);
  assert.ok(r.problems.some((p) => /probe failed/.test(p) && /media file not found/.test(p)), JSON.stringify(r.problems));

  // decode 失败 → av_length skipped
  r = verifyFinalMedia({
    finalPath: '/tmp/x.mp4', manifest,
    opts: {
      probeMedia: () => good,
      verifyDecode: () => ({ ok: false, exitCode: 1, timedOut: false, stderrTail: 'moov atom not found' }),
    },
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.steps.decode.ok, false);
  assert.strictEqual(r.steps.av_length.skipped, true);
  assert.ok(r.problems.some((p) => /decode failed/.test(p) && /moov atom not found/.test(p)), JSON.stringify(r.problems));
});

// ---- M5b6/M5b7: 真实 ffmpeg/ffprobe + CLI(门控) ----

let m5bMediaPath = null;
/** 生成 64×48 / 30fps 视频 + 48kHz stereo AAC 音轨(测试内,共享一次) */
function m5bGenMedia(dir) {
  if (m5bMediaPath) return m5bMediaPath;
  const p = path.join(dir, 'm5b-av.mp4');
  const r = spawnSync(process.env.FFMPEG_BIN || 'ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=64x48:r=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2', p,
  ], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`m5b media generation failed: ${r.stderr || r.stdout}`);
  m5bMediaPath = p;
  return p;
}

testFfmpeg('M5b6. 真实 ffmpeg:probeMedia 字段正确 + verifyDecode ok + checkAvLength ok;截断文件 verifyDecode 失败', () => {
  const dir = mkTempDir();
  const file = m5bGenMedia(dir);
  const probe = probeMedia(file);
  assert.strictEqual(probe.video.codec, 'h264');
  assert.strictEqual(probe.video.width, 64);
  assert.strictEqual(probe.video.height, 48);
  assert.ok(Math.abs(probe.video.fps - 30) < 0.5, String(probe.video.fps));
  assert.strictEqual(probe.video.pix_fmt, 'yuv420p');
  assert.ok(probe.video.duration > 0, String(probe.video.duration));
  assert.strictEqual(probe.audio.codec, 'aac');
  assert.strictEqual(probe.audio.sample_rate, 48000);
  assert.strictEqual(probe.audio.channels, 2);
  assert.ok(probe.audio.duration > 0, String(probe.audio.duration));
  assert.ok(typeof probe.format.format_name === 'string' && probe.format.format_name.length > 0);
  assert.ok(probe.format.duration > 0, String(probe.format.duration));

  const dec = verifyDecode(file);
  assert.strictEqual(dec.ok, true, JSON.stringify(dec));
  assert.strictEqual(dec.exitCode, 0);
  assert.strictEqual(dec.timedOut, false);
  assert.deepStrictEqual(checkAvLength(probe, { schemaVersion: 2, intent: { audio: 'full' } }), []);

  // 截断/损坏:写随机半截 mp4 → 解码必须失败
  const broken = path.join(dir, 'broken.mp4');
  const buf = Buffer.alloc(4096);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 37) % 256;
  fs.writeFileSync(broken, buf);
  const decBroken = verifyDecode(broken);
  assert.strictEqual(decBroken.ok, false, 'corrupt file must fail decode');
});

testFfmpeg('M5b7. CLI:probe.js <file> --json 退出 0 且 JSON 可解析;不存在文件非零退出', () => {
  const dir = mkTempDir();
  const file = m5bGenMedia(dir);
  const cli = path.join(ROOT, 'tools', 'probe.js');

  const r = spawnSync(process.execPath, [cli, file, '--json'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.strictEqual(parsed.ok, true, JSON.stringify(parsed));
  assert.strictEqual(parsed.steps.probe.ok, true);
  assert.strictEqual(parsed.steps.decode.ok, true);

  const bad = spawnSync(process.execPath, [cli, path.join(dir, 'nope.mp4'), '--json'], { encoding: 'utf8' });
  assert.notStrictEqual(bad.status, 0, 'missing file must exit non-zero');
});

// ============================================================
console.log('\n[M5c] Final Release Gate 引擎 + 适用矩阵 + 导出入口接入(§5/TECH-DEBT A5)');
// ============================================================

const GATE = require('../gate');
const {
  collectGateReport: stitchCollectGateReport,
  gateExitCode: stitchGateExitCode,
} = require('../stitch-episode');

/** 取单项结果 */
function gateItem(result, id) {
  const it = (result.items || []).find(x => x.id === id);
  assert.ok(it, `gate item #${id} must exist (have: ${(result.items || []).map(x => x.id).join(',')})`);
  return it;
}

/** v2 媒体探测 fixture(注入用) */
function gateProbeFixture(over = {}) {
  const base = {
    video: { codec: 'h264', width: 1280, height: 720, fps: 30, pix_fmt: 'yuv420p', duration: 8 },
    audio: null,
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: 8 },
  };
  return {
    video: over.video === undefined ? base.video : over.video,
    audio: over.audio === undefined ? base.audio : over.audio,
    format: over.format === undefined ? base.format : over.format,
  };
}

function gateOkMedia() {
  return {
    probeMedia: () => gateProbeFixture(),
    verifyDecode: () => ({ ok: true, exitCode: 0, timedOut: false, stderrTail: '' }),
  };
}

/** v2 空时间线(无 clip):让 4a/5 走 clip 分支且无 fail */
const GATE_EMPTY_TIMELINE = { fps: 30, clips: [] };

/** 一个可复制的 v2 take/shot 组合(带真实文件) */
function gateTakeFixture(dir, over = {}) {
  const vfile = path.join(dir, 'gate-take.mp4');
  if (!fs.existsSync(vfile)) fs.writeFileSync(vfile, 'v');
  const take = Object.assign({ id: 'take-001', status: 'selected', input_hash: 'h1', path: vfile }, over.take || {});
  const shot = Object.assign({ id: 's01', status: 'done', input_hash: 'h1', selected_take: take.id, takes: [take] }, over.shot || {});
  return { vfile, take, shot };
}

// ---- M5c1: GATE_ITEMS 元数据 ----

test('M5c1. GATE_ITEMS:§5 表逐行一致(编号 1..14,4 拆 4a/4b → 15 行);v1/v2 适用性写死', () => {
  const expected = [
    ['1', 'applicable', 'applicable'],
    ['2', 'applicable', 'applicable'],
    ['3', 'not_applicable', 'applicable'],
    ['4a', 'applicable', 'applicable'],
    ['4b', 'not_applicable', 'applicable'],
    ['5', 'applicable', 'applicable'],
    ['6', 'not_applicable', 'applicable'],
    ['7', 'applicable', 'applicable'],
    ['8', 'applicable', 'applicable'],
    ['9', 'applicable', 'applicable'],
    ['10', 'not_applicable', 'applicable'],
    ['11', 'not_applicable', 'applicable'],
    ['12', 'not_applicable', 'applicable'],
    ['13', 'not_applicable', 'applicable'],
    ['14', 'applicable', 'applicable'],
  ];
  assert.strictEqual(GATE.GATE_ITEMS.length, expected.length, 'PRD §5 rows (4a/4b are separate rows)');
  assert.deepStrictEqual(GATE.GATE_ITEMS.map(it => [it.id, it.v1, it.v2]), expected);
  for (const it of GATE.GATE_ITEMS) {
    assert.ok(typeof it.title === 'string' && it.title.length > 0, `#${it.id} title`);
    assert.ok(it.v1 === 'applicable' || it.v1 === 'not_applicable');
    assert.strictEqual(it.v2, 'applicable', `#${it.id} v2 is applicable`);
  }
});

// ---- M5c2: v1 矩阵 ----

test('M5c2. v1 矩阵:3/4b/6/10/11/12/13 not_applicable;4a/5/8/9 按 v1 语义(注入 probe 全过 → ok)', () => {
  const dir = mkTempDir();
  const { vfile, shot } = gateTakeFixture(dir);
  const manifest = { ratio: '16:9', resolution: '720p', shots: [shot] };
  const timeline = {
    fps: 30,
    clips: [{ clip_id: 'clip-0001', shot_id: 's01', take_id: 'take-001', source_in: 0, source_out: 30, deleted_head_frames: 0, padding_frames: 0, output_start: 0, output_end: 30, spill_in: [] }],
  };
  const probe = {
    video: { codec: 'h264', width: 100, height: 100, fps: 12, pix_fmt: 'yuv444p', duration: 1 },
    audio: null,
    format: { format_name: 'mp4', duration: 1 },
  };
  const result = GATE.evaluateReleaseGate({
    manifest, timeline, schemaVersion: 1, finalPath: vfile,
    opts: { probeMedia: () => probe, verifyDecode: () => ({ ok: true, exitCode: 0, timedOut: false, stderrTail: '' }) },
  });
  for (const id of ['3', '4b', '6', '10', '11', '12', '13']) {
    const it = gateItem(result, id);
    assert.strictEqual(it.status, 'not_applicable', `#${id}: ${JSON.stringify(it)}`);
    assert.strictEqual(it.applicable, false, `#${id} applicable=false`);
    assert.ok(it.notes.includes('v1 semantics'), `#${id} notes v1 semantics: ${JSON.stringify(it.notes)}`);
  }
  for (const id of ['4a', '5', '8', '9']) {
    const it = gateItem(result, id);
    assert.notStrictEqual(it.status, 'fail', `#${id} must not fail under v1: ${JSON.stringify(it.reasons)}`);
  }
  assert.strictEqual(result.ok, true, JSON.stringify(result.items.filter(i => i.status === 'fail')));
  assert.deepStrictEqual(result.deferred, []);
});

// ---- M5c3: 4a/5 take 依赖 ----

test('M5c3. 4a/5:rejected → fail;superseded 无 reuse → fail;有匹配 reuse_records 且 take==selected → pass', () => {
  const dir = mkTempDir();
  const built = gateTakeFixture(dir);
  const timeline = {
    fps: 30,
    clips: [{ clip_id: 'clip-0001', shot_id: 's01', take_id: 'take-001', source_in: 0, source_out: 30, deleted_head_frames: 0, padding_frames: 0, output_start: 0, output_end: 30, spill_in: [] }],
  };
  const mk = (takeOver) => {
    const { take, shot } = gateTakeFixture(dir, { take: takeOver });
    return {
      schema_version: 2, keyframe_mode: 'reference',
      intent: { dialogue: false, audio: 'none', subtitles: 'none', silent: true },
      cover: { promo_asset: built.vfile },
      shots: [shot], take,
    };
  };

  let m = mk({ status: 'rejected' });
  let r = GATE.evaluateReleaseGate({ manifest: m, timeline, intent: m.intent });
  assert.strictEqual(gateItem(r, '4a').status, 'fail');
  assert.ok(/rejected/.test(gateItem(r, '4a').reasons.join(' ')), JSON.stringify(gateItem(r, '4a').reasons));

  m = mk({ status: 'superseded' });
  r = GATE.evaluateReleaseGate({ manifest: m, timeline, intent: m.intent });
  assert.strictEqual(gateItem(r, '4a').status, 'fail');
  assert.ok(/reuse_record/.test(gateItem(r, '4a').reasons.join(' ')), JSON.stringify(gateItem(r, '4a').reasons));

  // 任务级 superseded_at(即便 take.status 仍是 candidate)→ fail
  m = mk({ status: 'candidate', task_id: 'task-1' });
  m.render_tasks = [{ task_id: 'task-1', stage: 'video', superseded_at: '2026-01-01T00:00:00.000Z' }];
  r = GATE.evaluateReleaseGate({ manifest: m, timeline, intent: m.intent });
  assert.strictEqual(gateItem(r, '4a').status, 'fail');
  assert.ok(/superseded\/stale/.test(gateItem(r, '4a').reasons.join(' ')), JSON.stringify(gateItem(r, '4a').reasons));

  m = mk({ status: 'superseded' });
  m.reuse_records = [{ take_id: 'take-001', reason: 'fingerprint_recurrence', bound_input_hash: 'h1' }];
  r = GATE.evaluateReleaseGate({ manifest: m, timeline, intent: m.intent });
  assert.notStrictEqual(gateItem(r, '4a').status, 'fail', JSON.stringify(gateItem(r, '4a').reasons));
  assert.notStrictEqual(gateItem(r, '5').status, 'fail', JSON.stringify(gateItem(r, '5').reasons));

  // 非 selected 且无 reuse → #5 fail(即便 4a 因 take 是 candidate 不报)
  const dir2 = mkTempDir();
  const f2 = gateTakeFixture(dir2, { take: { status: 'candidate' } });
  f2.shot.selected_take = null;
  const m2 = {
    schema_version: 2, intent: { dialogue: false, audio: 'none', subtitles: 'none', silent: true },
    cover: { promo_asset: f2.vfile }, shots: [f2.shot],
  };
  r = GATE.evaluateReleaseGate({ manifest: m2, timeline, intent: m2.intent });
  assert.strictEqual(gateItem(r, '5').status, 'fail');
  assert.ok(/neither the selected_take/.test(gateItem(r, '5').reasons.join(' ')), JSON.stringify(gateItem(r, '5').reasons));
});

// ---- M5c4: 3 E1 报告 ----

test('M5c4. 3:v2 reference + 无报告 → deferred;first_frame 无报告/未绑定 → fail;bound=true → pass;版本不一致 → fail', () => {
  const base = { schema_version: 2, keyframe_mode: 'reference' };
  const ff = Object.assign({}, base, { keyframe_mode: 'first_frame' });

  let r = GATE.evaluateReleaseGate({ manifest: base, timeline: GATE_EMPTY_TIMELINE });
  assert.strictEqual(gateItem(r, '3').status, 'deferred');
  assert.ok(/E1 formal report not available/.test(gateItem(r, '3').reasons.join(' ')));

  r = GATE.evaluateReleaseGate({ manifest: ff, timeline: GATE_EMPTY_TIMELINE });
  assert.strictEqual(gateItem(r, '3').status, 'fail');

  r = GATE.evaluateReleaseGate({ manifest: ff, timeline: GATE_EMPTY_TIMELINE, e1Report: { first_frame_bound: false } });
  assert.strictEqual(gateItem(r, '3').status, 'fail');
  assert.ok(/first_frame_bound/.test(gateItem(r, '3').reasons.join(' ')));

  r = GATE.evaluateReleaseGate({ manifest: ff, timeline: GATE_EMPTY_TIMELINE, e1Report: { first_frame_bound: true } });
  assert.strictEqual(gateItem(r, '3').status, 'pass', JSON.stringify(gateItem(r, '3').reasons));

  // meta.interface_version 也可读;版本不一致 → fail
  r = GATE.evaluateReleaseGate({
    manifest: Object.assign({}, base, { interface_version: 'v2' }), timeline: GATE_EMPTY_TIMELINE,
    e1Report: { first_frame_bound: true, meta: { interface_version: 'v3' } },
  });
  assert.strictEqual(gateItem(r, '3').status, 'fail');
  assert.ok(/interface_version/.test(gateItem(r, '3').reasons.join(' ')));

  r = GATE.evaluateReleaseGate({
    manifest: Object.assign({}, base, { interface_version: 'v2' }), timeline: GATE_EMPTY_TIMELINE,
    e1Report: { first_frame_bound: true, interface_version: 'v2' },
  });
  assert.strictEqual(gateItem(r, '3').status, 'pass', JSON.stringify(gateItem(r, '3').reasons));
});

// ---- M5c5: 7 字幕 cue ----

test('M5c5. 7:requires_subtitles 缺 srt → fail;cue 超界 → fail;合法 → pass;豁免 → not_applicable', () => {
  const dir = mkTempDir();
  const srt = path.join(dir, 'episode.srt');
  const need = { schema_version: 2, intent: { dialogue: true, audio: 'dialogue', subtitles: 'burn', silent: false } };

  let r = GATE.evaluateReleaseGate({ manifest: need, timeline: GATE_EMPTY_TIMELINE, artifacts: {} });
  assert.strictEqual(gateItem(r, '7').status, 'fail');
  assert.ok(/subtitle artifact/i.test(gateItem(r, '7').reasons.join(' ')));

  fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:05,000\nhello\n');
  r = GATE.evaluateReleaseGate({ manifest: need, timeline: GATE_EMPTY_TIMELINE, artifacts: { srt }, finalDuration: 2 });
  assert.strictEqual(gateItem(r, '7').status, 'fail');
  assert.ok(/cue 1/.test(gateItem(r, '7').reasons.join(' ')), JSON.stringify(gateItem(r, '7').reasons));

  fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:02,000\nhello\n');
  r = GATE.evaluateReleaseGate({ manifest: need, timeline: GATE_EMPTY_TIMELINE, artifacts: { srt }, finalDuration: 2 });
  assert.strictEqual(gateItem(r, '7').status, 'pass', JSON.stringify(gateItem(r, '7').reasons));

  // finalDuration 缺失 → deferred
  r = GATE.evaluateReleaseGate({ manifest: need, timeline: null, artifacts: { srt } });
  assert.strictEqual(gateItem(r, '7').status, 'deferred');

  // 豁免(!requires_subtitles)
  r = GATE.evaluateReleaseGate({ manifest: { schema_version: 2, intent: { dialogue: false, audio: 'music_sfx', subtitles: 'none', silent: false } }, timeline: GATE_EMPTY_TIMELINE });
  assert.strictEqual(gateItem(r, '7').status, 'not_applicable');
});

// ---- M5c6: 10/6 音频 ----

test('M5c6. 10:silent=true → pass + "loudnorm: skipped";audio≠none → 实判(无来源 fail);audio=none → N/A;6:dialogue → 实判 pass', () => {
  const mk = (intent) => ({ schema_version: 2, intent });

  let r = GATE.evaluateReleaseGate({ manifest: mk({ dialogue: false, audio: 'music_sfx', subtitles: 'none', silent: true }), timeline: GATE_EMPTY_TIMELINE });
  assert.strictEqual(gateItem(r, '10').status, 'pass');
  assert.ok(gateItem(r, '10').notes.join(' ').includes('loudnorm: skipped'), JSON.stringify(gateItem(r, '10').notes));

  // §3.4/M5-AUD:#10 由 deferred 改为实判——无 opts.loudness 且无 --final → fail(给提示)
  r = GATE.evaluateReleaseGate({ manifest: mk({ dialogue: false, audio: 'music_sfx', subtitles: 'none', silent: false }), timeline: GATE_EMPTY_TIMELINE });
  assert.strictEqual(gateItem(r, '10').status, 'fail');
  assert.ok(/opts\.loudness|--final/.test(gateItem(r, '10').reasons.join(' ')), JSON.stringify(gateItem(r, '10').reasons));

  // 注入达标 loudness → pass
  r = GATE.evaluateReleaseGate({
    manifest: mk({ dialogue: false, audio: 'music_sfx', subtitles: 'none', silent: false }),
    timeline: GATE_EMPTY_TIMELINE,
    opts: { loudness: { input_i: -14, input_tp: -1.5 } },
  });
  assert.strictEqual(gateItem(r, '10').status, 'pass', JSON.stringify(gateItem(r, '10').reasons));

  r = GATE.evaluateReleaseGate({ manifest: mk({ dialogue: false, audio: 'none', subtitles: 'none', silent: true }), timeline: GATE_EMPTY_TIMELINE });
  assert.strictEqual(gateItem(r, '10').status, 'not_applicable');

  // §3.4/M5-OVF:#6 由 deferred 改为实判——空时间线（无 clip）无未解决溢出 → pass
  r = GATE.evaluateReleaseGate({ manifest: mk({ dialogue: true, audio: 'dialogue', subtitles: 'burn', silent: false }), timeline: GATE_EMPTY_TIMELINE });
  assert.strictEqual(gateItem(r, '6').status, 'pass', JSON.stringify(gateItem(r, '6')));

  r = GATE.evaluateReleaseGate({ manifest: mk({ dialogue: false, audio: 'music_sfx', subtitles: 'none', silent: false }), timeline: GATE_EMPTY_TIMELINE });
  assert.strictEqual(gateItem(r, '6').status, 'not_applicable');
});

// ---- M5c7: 11 cover ----

test('M5c7. 11:promo_asset 存在 → pass;无 cover 配置 → fail;promo 文件缺失 → fail;first_frame 文件缺失 → fail', () => {
  const dir = mkTempDir();
  const promo = path.join(dir, 'promo.png');
  fs.writeFileSync(promo, 'x');

  let r = GATE.evaluateReleaseGate({ manifest: { schema_version: 2, cover: { promo_asset: promo } }, timeline: GATE_EMPTY_TIMELINE });
  assert.strictEqual(gateItem(r, '11').status, 'pass', JSON.stringify(gateItem(r, '11').reasons));
  assert.ok(gateItem(r, '11').notes.join(' ').includes('promo_asset'));

  r = GATE.evaluateReleaseGate({ manifest: { schema_version: 2 }, timeline: GATE_EMPTY_TIMELINE });
  assert.strictEqual(gateItem(r, '11').status, 'fail');

  r = GATE.evaluateReleaseGate({ manifest: { schema_version: 2, cover: { promo_asset: path.join(dir, 'nope.png') } }, timeline: GATE_EMPTY_TIMELINE });
  assert.strictEqual(gateItem(r, '11').status, 'fail');

  // clip cover → first_frame 需 take 文件存在
  const f = gateTakeFixture(dir);
  const clip = { clip_id: 'clip-0001', shot_id: 's01', take_id: 'take-001', source_in: 0, source_out: 30, deleted_head_frames: 0, padding_frames: 0, output_start: 0, output_end: 30, spill_in: [] };
  const m = { schema_version: 2, cover: { clip_id: 'clip-0001' }, shots: [f.shot] };
  let rr = GATE.evaluateReleaseGate({ manifest: m, timeline: { fps: 30, clips: [clip] } });
  assert.strictEqual(gateItem(rr, '11').status, 'pass', JSON.stringify(gateItem(rr, '11').reasons));
  f.take.path = path.join(dir, 'missing.mp4');
  rr = GATE.evaluateReleaseGate({ manifest: m, timeline: { fps: 30, clips: [clip] } });
  assert.strictEqual(gateItem(rr, '11').status, 'fail');
});

// ---- M5c8: 12 账本对账 ----

test('M5c8. 12:ledger 一致 → pass;video.successes 与 takes 不符 → fail;requests=0 且有 takes → deferred', () => {
  const dir = mkTempDir();
  const f = gateTakeFixture(dir);
  const zeros = () => ({ requests: 0, successes: 0, cache_hits: 0, rejects: 0, failed_billed: 0 });
  const mkLedger = (videoOver) => ({ stages: { image: zeros(), tts: zeros(), video: Object.assign(zeros(), videoOver) } });
  const mkManifest = (ledger) => ({
    schema_version: 2, intent: { dialogue: false, audio: 'none', subtitles: 'none', silent: true },
    quota_ledger: ledger, shots: [f.shot],
  });

  let r = GATE.evaluateReleaseGate({ manifest: mkManifest(mkLedger({ requests: 1, successes: 1 })), timeline: GATE_EMPTY_TIMELINE });
  assert.strictEqual(gateItem(r, '12').status, 'pass', JSON.stringify(gateItem(r, '12').reasons));

  r = GATE.evaluateReleaseGate({ manifest: mkManifest(mkLedger({ requests: 1, successes: 0 })), timeline: GATE_EMPTY_TIMELINE });
  assert.strictEqual(gateItem(r, '12').status, 'fail');
  assert.ok(/video\.successes/.test(gateItem(r, '12').reasons.join(' ')), JSON.stringify(gateItem(r, '12').reasons));

  r = GATE.evaluateReleaseGate({ manifest: mkManifest(mkLedger({})), timeline: GATE_EMPTY_TIMELINE });
  assert.strictEqual(gateItem(r, '12').status, 'deferred');
  assert.ok(/ledger not initialized/.test(gateItem(r, '12').reasons.join(' ')));

  // 非负整数校验 + rejects 少于 rejected takes → fail
  r = GATE.evaluateReleaseGate({ manifest: mkManifest(mkLedger({ requests: 1, successes: 1, rejects: -1 })), timeline: GATE_EMPTY_TIMELINE });
  assert.strictEqual(gateItem(r, '12').status, 'fail');

  // 直接测纯函数 reconcileQuotaLedger
  const rec = GATE.reconcileQuotaLedger(mkManifest(mkLedger({ requests: 1, successes: 1 })));
  assert.strictEqual(rec.ok, true, JSON.stringify(rec.problems));
  assert.strictEqual(rec.view.video_takes, 1);
});

// ---- M5c9: ok / releasable 组合 ----

test('M5c9. ok/releasable:仅 deferred → ok=true/releasable=false;含 fail → 两者 false', () => {
  const dir = mkTempDir();
  const promo = path.join(dir, 'promo.png');
  fs.writeFileSync(promo, 'x');
  const manifest = {
    schema_version: 2, ratio: '16:9', resolution: '720p', fps: 30, keyframe_mode: 'reference',
    intent: { dialogue: false, audio: 'none', subtitles: 'none', silent: true },
    cover: { promo_asset: promo }, shots: [],
  };
  let r = GATE.evaluateReleaseGate({ manifest, timeline: GATE_EMPTY_TIMELINE, finalPath: path.join(dir, 'final.mp4'), opts: gateOkMedia() });
  assert.strictEqual(r.ok, true, JSON.stringify(r.items.filter(i => i.status === 'fail')));
  assert.deepStrictEqual(r.deferred, ['3'], JSON.stringify(r.deferred));
  assert.strictEqual(r.releasable, false);

  const noCover = Object.assign({}, manifest, { cover: undefined });
  r = GATE.evaluateReleaseGate({ manifest: noCover, timeline: GATE_EMPTY_TIMELINE, finalPath: path.join(dir, 'final.mp4'), opts: gateOkMedia() });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.releasable, false);
  assert.ok(r.failures.includes('11'), JSON.stringify(r.failures));
});

// ---- M5c10: 注入 probe 集成 + parseSrtCues ----

test('M5c10. 注入 probe:9/8 status;无 final → 8/9 fail(final file required);parseSrtCues BOM/CRLF/坏格式', () => {
  const manifest = {
    schema_version: 2, ratio: '16:9', resolution: '720p', fps: 30, keyframe_mode: 'reference',
    intent: { dialogue: false, audio: 'none', subtitles: 'none', silent: true },
    cover: { promo_asset: __filename }, shots: [],
  };
  const finalPath = '/tmp/gate-m5c10.mp4';

  let r = GATE.evaluateReleaseGate({ manifest, timeline: GATE_EMPTY_TIMELINE, finalPath, opts: gateOkMedia() });
  assert.strictEqual(gateItem(r, '9').status, 'pass', JSON.stringify(gateItem(r, '9').reasons));
  assert.strictEqual(gateItem(r, '8').status, 'pass', JSON.stringify(gateItem(r, '8').reasons));

  // spec 失败 → #9 fail;decode 不得运行;规格失败时 probe 仍可用于 #8
  const specBad = Object.assign({}, gateOkMedia(), {
    probeMedia: () => gateProbeFixture({ video: Object.assign({}, gateProbeFixture().video, { width: 1920 }) }),
    verifyDecode: () => { throw new Error('decode must not run after spec failure'); },
  });
  r = GATE.evaluateReleaseGate({ manifest, timeline: GATE_EMPTY_TIMELINE, finalPath, opts: specBad });
  assert.strictEqual(gateItem(r, '9').status, 'fail');
  assert.ok(/spec: width mismatch/.test(gateItem(r, '9').reasons.join(' ')), JSON.stringify(gateItem(r, '9').reasons));

  // decode 失败 → #9 fail,#8 仍按长度 pass
  const decodeBad = Object.assign({}, gateOkMedia(), {
    verifyDecode: () => ({ ok: false, exitCode: 1, timedOut: false, stderrTail: 'moov atom not found' }),
  });
  r = GATE.evaluateReleaseGate({ manifest, timeline: GATE_EMPTY_TIMELINE, finalPath, opts: decodeBad });
  assert.strictEqual(gateItem(r, '9').status, 'fail');
  assert.strictEqual(gateItem(r, '8').status, 'pass');

  // 无 finalPath → 8/9 fail 且消息含 'final file required'
  r = GATE.evaluateReleaseGate({ manifest, timeline: GATE_EMPTY_TIMELINE });
  assert.strictEqual(gateItem(r, '8').status, 'fail');
  assert.strictEqual(gateItem(r, '9').status, 'fail');
  assert.ok(gateItem(r, '8').reasons.join(' ').includes('final file required'));
  assert.ok(gateItem(r, '9').reasons.join(' ').includes('final file required'));

  // parseSrtCues:BOM + CRLF + '.',毫秒补位
  const cues = GATE.parseSrtCues('\uFEFF1\r\n00:00:01,000 --> 00:00:02,500\r\nhello\r\n\r\n2\r\n00:00:03.000 --> 00:00:04,000\r\nbye');
  assert.strictEqual(cues.length, 2);
  assert.strictEqual(cues[0].index, 1);
  assert.strictEqual(cues[0].start, 1);
  assert.strictEqual(cues[0].end, 2.5);
  assert.strictEqual(cues[1].start, 3);
  assert.strictEqual(cues[1].text, 'bye');
  throws(() => GATE.parseSrtCues('not a srt block'), 'malformed');
  throws(() => GATE.parseSrtCues('1\n00:00:00,000 -> 00:00:01,000\nx'), 'malformed');
});

// ---- M5c11: CLI ----

/** 写一个 stub 可执行脚本(用于替换 ffprobe/ffmpeg) */
function writeGateStub(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

const GATE_FFPROBE_STUB = '#!/bin/sh\nprintf \'%s\' \'{"streams":[{"codec_type":"video","codec_name":"h264","width":1280,"height":720,"avg_frame_rate":"30/1","pix_fmt":"yuv420p","duration":"8.0"}],"format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"8.0"}}\'\n';
const GATE_FFMPEG_STUB = '#!/bin/sh\nexit 0\n';

test('M5c11. CLI:有 fail → 4;仅 deferred → 0(--strict → 4);--json 可解析', () => {
  const dir = mkTempDir();
  const promo = path.join(dir, 'promo.png');
  fs.writeFileSync(promo, 'x');
  const finalFile = path.join(dir, 'final.mp4');
  fs.writeFileSync(finalFile, 'v');
  const manifest = {
    schema_version: 2, ratio: '16:9', resolution: '720p', fps: 30, keyframe_mode: 'reference',
    intent: { dialogue: false, audio: 'none', subtitles: 'none', silent: true },
    cover: { promo_asset: promo }, shots: [],
  };
  writeManifest(dir, manifest);
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(GATE_EMPTY_TIMELINE));
  const cli = path.join(ROOT, 'tools', 'gate.js');

  // 有 fail:无 --final → 8/9 fail → 4
  let r = spawnSync(process.execPath, [cli, dir, '--json'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 4, `${r.stdout}${r.stderr}`);
  let parsed = JSON.parse(r.stdout);
  assert.deepStrictEqual(parsed.failures, ['8', '9'], JSON.stringify(parsed.failures));

  // 仅 deferred:stub 探测/解码 → 只有 #3 deferred → 0
  const stubDir = path.join(dir, 'stubs');
  fs.mkdirSync(stubDir, { recursive: true });
  const env = Object.assign({}, process.env, {
    FFPROBE_BIN: writeGateStub(path.join(stubDir, 'ffprobe'), GATE_FFPROBE_STUB),
    FFMPEG_BIN: writeGateStub(path.join(stubDir, 'ffmpeg'), GATE_FFMPEG_STUB),
  });
  r = spawnSync(process.execPath, [cli, dir, '--final', finalFile, '--json'], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  parsed = JSON.parse(r.stdout);
  assert.deepStrictEqual(parsed.deferred, ['3'], JSON.stringify(parsed.deferred));
  assert.deepStrictEqual(parsed.failures, []);
  assert.strictEqual(parsed.releasable, false);

  // --strict:deferred 也 4
  r = spawnSync(process.execPath, [cli, dir, '--final', finalFile, '--strict', '--json'], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 4, `${r.stdout}${r.stderr}`);
  assert.deepStrictEqual(JSON.parse(r.stdout).deferred, ['3']);
});

// ---- M5c12: stitch 接线 ----

test('M5c12. stitch 接线:v1 fixture collectGateReport 不 fail;deferred → exit 0(--strict → 4);fail → 4', () => {
  const dir = mkTempDir();
  const f = gateTakeFixture(dir);
  const v1 = { ratio: '16:9', resolution: '720p', schema_version: 1, shots: [f.shot] };
  const clip = { clip_id: 'clip-0001', shot_id: 's01', take_id: 'take-001', source_in: 0, source_out: 30, deleted_head_frames: 0, padding_frames: 0, output_start: 0, output_end: 30, spill_in: [] };
  const v1Report = stitchCollectGateReport(dir, v1, { timeline: { fps: 30, clips: [clip] }, phase: 'offline' });
  assert.deepStrictEqual(v1Report.failures, [], JSON.stringify(v1Report.items.filter(i => i.status === 'fail')));
  assert.strictEqual(stitchGateExitCode(v1Report).exitCode, 0);

  // v2 fixture 含 deferred → 桥接政策放行(deferred → 0,strict → 4)
  const v2 = {
    schema_version: 2, ratio: '16:9', resolution: '720p', fps: 30, keyframe_mode: 'reference',
    intent: { dialogue: false, audio: 'none', subtitles: 'none', silent: true },
    cover: { promo_asset: f.vfile }, shots: [],
  };
  const v2Report = stitchCollectGateReport(dir, v2, { timeline: GATE_EMPTY_TIMELINE, phase: 'offline' });
  assert.strictEqual(v2Report.failures.length, 0, JSON.stringify(v2Report.items.filter(i => i.status === 'fail')));
  assert.ok(v2Report.deferred.includes('3'), JSON.stringify(v2Report.deferred));
  assert.strictEqual(stitchGateExitCode(v2Report).exitCode, 0);
  assert.strictEqual(stitchGateExitCode(v2Report, { strict: true }).exitCode, 4);

  // 含 fail → 4
  const noCover = Object.assign({}, v2, { cover: undefined });
  const failReport = stitchCollectGateReport(dir, noCover, { timeline: GATE_EMPTY_TIMELINE, phase: 'offline' });
  assert.ok(failReport.failures.includes('11'), JSON.stringify(failReport.failures));
  assert.strictEqual(stitchGateExitCode(failReport).exitCode, 4);
  assert.strictEqual(stitchGateExitCode(failReport, { strict: true }).exitCode, 4);
});

// ============================================================
console.log('\n[TTS] M5 TTS 接线(dialogue/voice/tts_hash/缓存/账本;全程离线)');
// ============================================================

const TTS_PROVIDER = { name: 'doubao', model: 'seed-tts-2.0', version: '2026-09-14' };
const TTS_PARAMS = { speed: 0.95 };
const TTS_INTENT = ['intent:', '  subtitles: burn'];
const TTS_DEFAULTS = ['defaults:', '  duration: 8', "  ratio: '16:9'", "  resolution: '720p'", "  model: 'default'"];

/** tts payload hash(与 build-manifest 内部同口径) */
function ttsHashFor(text, voiceId, provider = TTS_PROVIDER, params = TTS_PARAMS, schemaVersion = 2) {
  return computeStagePayloadHash({
    schemaVersion, stage: 'tts', dialogueText: text, voiceId,
    provider, ttsParams: params, styleGuideDigest: null
  });
}

function writeTtsScript(dir, extra) {
  fs.writeFileSync(path.join(dir, 'script.yaml'), [
    'episode: TTSTEST', 'title: T', 'schema_version: 2',
    ...TTS_INTENT, ...TTS_DEFAULTS,
    'scenes:', '  - id: s01', '    shots:',
    ...extra, ''
  ].join('\n'));
}

// ---- TTS1: dialogue / voice 解析 ----

test('TTS1a. dialogue 字符串 + 无任何 voice → exit 4 且 manifest 未写', () => {
  const dir = mkTempDir();
  writeTtsScript(dir, [
    '      - id: s01-shot-01', "        style_en: 'cinematic'", "        prompt_en: 'a'",
    "        dialogue: '你好世界'"
  ]);
  const r = runBuildManifest(dir);
  assert.strictEqual(r.status, 4, `${r.stdout}${r.stderr}`);
  const out = r.stdout + r.stderr;
  assert.ok(out.includes('s01-shot-01'), out);
  assert.ok(/voice_id/.test(out), out);
  assert.ok(!fs.existsSync(path.join(dir, 'manifest.json')), 'must not write a manifest on voice resolution failure');
});

test('TTS1b. {text,voice_id} → 落 dialogue_text/voice_id/tts_hash/tts_takes/selected_tts', () => {
  const dir = mkTempDir();
  writeTtsScript(dir, [
    '      - id: s01-shot-01', "        style_en: 'cinematic'", "        prompt_en: 'a'",
    '        dialogue:', "          text: '你好世界'", "          voice_id: 'zh_male_v1'"
  ]);
  const r = runBuildManifest(dir);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  const m = readManifest(dir);
  const s = m.shots[0];
  assert.strictEqual(s.dialogue_text, '你好世界');
  assert.strictEqual(s.voice_id, 'zh_male_v1');
  assert.strictEqual(s.tts_hash, ttsHashFor('你好世界', 'zh_male_v1'));
  assert.deepStrictEqual(s.tts_takes, []);
  assert.strictEqual(s.selected_tts, null);
  assert.deepStrictEqual(m.tts.provider, TTS_PROVIDER);
  assert.deepStrictEqual(m.tts.params, TTS_PARAMS);
});

test('TTS1c. 空白 dialogue 不算;无对白 manifest/shot 不新增任何 tts 字段', () => {
  assert.strictEqual(normalizeDialogue({ dialogue: '   \n\t ' }), null);
  assert.strictEqual(normalizeDialogue({ dialogue: { text: '  ' } }), null);
  assert.strictEqual(normalizeDialogue({}), null);
  assert.strictEqual(normalizeDialogue({ dialogue: { text: 'hi' } }).text, 'hi');
  assert.strictEqual(normalizeDialogue({ dialogue: { text: 'hi', voice_id: ' v ' } }).voiceId, 'v');

  const dir = mkTempDir();
  writeTtsScript(dir, ['      - id: s01-shot-01', "        style_en: 'cinematic'", "        prompt_en: 'a'"]);
  const r = runBuildManifest(dir);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  const m = readManifest(dir);
  const s = m.shots[0];
  for (const f of ['dialogue_text', 'voice_id', 'tts_hash', 'tts_takes', 'selected_tts']) {
    assert.ok(!(f in s), `no-dialogue shot must not gain '${f}'`);
  }
  assert.ok(!('tts' in m), 'no-dialogue episode manifest must not gain manifest.tts');
});

test('TTS1d. voice 优先级:shot.dialogue > shot > scene > script.tts > series.tts', () => {
  const scene = { id: 's01', voice_id: 'scene-v' };
  const shot = { id: 'x', voice_id: 'shot-v' };
  const script = { tts: { voice_id: 'script-v' } };
  const series = { tts: { voice_id: 'series-v' } };
  assert.strictEqual(resolveVoiceId({ dialogue: { voiceId: 'dialogue-v' }, shot, scene, script, series }).voiceId, 'dialogue-v');
  assert.strictEqual(resolveVoiceId({ dialogue: { voiceId: null }, shot, scene, script, series }).voiceId, 'shot-v');
  assert.strictEqual(resolveVoiceId({ dialogue: null, shot: { id: 'x' }, scene, script, series }).voiceId, 'scene-v');
  assert.strictEqual(resolveVoiceId({ dialogue: null, shot: { id: 'x' }, scene: { id: 's01' }, script, series }).voiceId, 'script-v');
  assert.strictEqual(resolveVoiceId({ dialogue: null, shot: { id: 'x' }, scene: { id: 's01' }, script: {}, series }).voiceId, 'series-v');
  const none = resolveVoiceId({ dialogue: null, shot: { id: 'x' }, scene: { id: 's01' }, script: {}, series: {} });
  assert.strictEqual(none.voiceId, null);
  assert.ok(none.checked.length === 5, 'error hint must list all checked locations');
});

test('TTS1e. scene.voice_id 生效(build-manifest 集成)', () => {
  const dir = mkTempDir();
  fs.writeFileSync(path.join(dir, 'script.yaml'), [
    'episode: TTSTEST', 'title: T', 'schema_version: 2',
    ...TTS_INTENT, ...TTS_DEFAULTS,
    'scenes:', '  - id: s01', "    voice_id: 'scene-v'", '    shots:',
    '      - id: s01-shot-01', "        style_en: 'cinematic'", "        prompt_en: 'a'", '        dialogue: \'hi\'', ''
  ].join('\n'));
  const r = runBuildManifest(dir);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.strictEqual(readManifest(dir).shots[0].voice_id, 'scene-v');
});

test('TTS1f. 重建保留 tts_takes / selected_tts', () => {
  const dir = mkTempDir();
  writeTtsScript(dir, [
    '      - id: s01-shot-01', "        style_en: 'cinematic'", "        prompt_en: 'a'",
    '        dialogue:', "          text: '你好世界'", "          voice_id: 'v1'"
  ]);
  assert.strictEqual(runBuildManifest(dir).status, 0);
  const m = readManifest(dir);
  m.shots[0].tts_takes = [{ id: 'tts-001', task_id: 'task-x', status: 'selected', input_hash: m.shots[0].tts_hash, content_digest: 'd', path: '/tmp/a.mp3' }];
  m.shots[0].selected_tts = 'tts-001';
  writeManifest(dir, m);
  assert.strictEqual(runBuildManifest(dir).status, 0);
  const m2 = readManifest(dir);
  assert.strictEqual(m2.shots[0].tts_takes.length, 1);
  assert.strictEqual(m2.shots[0].tts_takes[0].id, 'tts-001');
  assert.strictEqual(m2.shots[0].selected_tts, 'tts-001');
});

// ---- TTS2: tts_hash ----

test('TTS2a. tts_hash 稳定;text/voice/params/provider.version 变化 → hash 变;style_guide_digest:null 入 payload', () => {
  const h1 = ttsHashFor('你好', 'v1');
  assert.strictEqual(h1, ttsHashFor('你好', 'v1'));
  const withoutNull = computeStagePayloadHash({
    schemaVersion: 2, stage: 'tts', dialogueText: '你好', voiceId: 'v1',
    provider: TTS_PROVIDER, ttsParams: TTS_PARAMS
  });
  assert.notStrictEqual(h1, withoutNull, 'style_guide_digest:null must be part of the payload');
  assert.notStrictEqual(h1, ttsHashFor('再见', 'v1'));
  assert.notStrictEqual(h1, ttsHashFor('你好', 'v2'));
  assert.notStrictEqual(h1, ttsHashFor('你好', 'v1', TTS_PROVIDER, { speed: 1.2 }));
  assert.notStrictEqual(h1, ttsHashFor('你好', 'v1', { name: 'doubao', model: 'seed-tts-2.0', version: '2026-09-15' }));
  assert.notStrictEqual(h1, ttsHashFor('你好', 'v1', { name: 'other', model: 'seed-tts-2.0', version: '2026-09-14' }));
});

test('TTS2b. provider 缺 version → exit 4 且不写盘;错误含 shot id 与配置位点', () => {
  const dir = mkTempDir();
  fs.writeFileSync(path.join(dir, 'script.yaml'), [
    'episode: TTSTEST', 'title: T', 'schema_version: 2', ...TTS_INTENT,
    'tts:', '  provider:', '    name: doubao', '    model: seed-tts-2.0', "  voice_id: 'v1'",
    ...TTS_DEFAULTS,
    'scenes:', '  - id: s01', '    shots:',
    '      - id: s01-shot-01', "        style_en: 'cinematic'", "        prompt_en: 'a'", '        dialogue: \'hi\'', ''
  ].join('\n'));
  const r = runBuildManifest(dir);
  assert.strictEqual(r.status, 4, `${r.stdout}${r.stderr}`);
  const out = r.stdout + r.stderr;
  assert.ok(/s01-shot-01/.test(out), out);
  assert.ok(/version/.test(out), out);
  assert.ok(/script\.tts\.provider/.test(out), out);
  assert.ok(!fs.existsSync(path.join(dir, 'manifest.json')));
});

test('TTS2c. script.tts 自定义 provider/params/chars_per_second → 落盘并参与 hash', () => {
  const dir = mkTempDir();
  fs.writeFileSync(path.join(dir, 'script.yaml'), [
    'episode: TTSTEST', 'title: T', 'schema_version: 2', ...TTS_INTENT,
    'tts:', '  provider:', '    name: doubao', '    model: seed-tts-2.0', "    version: '2026-09-15'",
    "  voice_id: 'v9'", '  params:', '    speed: 1.1', '  chars_per_second: 4',
    ...TTS_DEFAULTS,
    'scenes:', '  - id: s01', '    shots:',
    '      - id: s01-shot-01', "        style_en: 'cinematic'", "        prompt_en: 'a'", '        dialogue: \'hi\'', ''
  ].join('\n'));
  const r = runBuildManifest(dir);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  const m = readManifest(dir);
  assert.strictEqual(m.tts.chars_per_second, 4);
  assert.deepStrictEqual(m.tts.params, { speed: 1.1 });
  assert.strictEqual(m.shots[0].voice_id, 'v9');
  assert.strictEqual(m.shots[0].tts_hash, ttsHashFor('hi', 'v9', { name: 'doubao', model: 'seed-tts-2.0', version: '2026-09-15' }, { speed: 1.1 }));
});

// ---- TTS2d/TTS2e: 逐字段回落(script.tts 只覆盖显式字段,不得整体遮蔽 provider) ----

test('TTS2d. resolveTtsConfig 逐字段回落:script.tts 只给 voice_id 时仍用 series/默认 provider+params', () => {
  const series = { tts: { provider: { name: 'series-p', model: 'm', version: 'v1' }, params: { speed: 1.2 }, chars_per_second: 4 } };
  const a = resolveTtsConfig({ tts: { voice_id: 'v' } }, series);
  assert.deepStrictEqual(a.provider, { name: 'series-p', model: 'm', version: 'v1' });
  assert.strictEqual(a.providerSource, 'series.tts.provider');
  assert.deepStrictEqual(a.params, { speed: 1.2 });
  assert.strictEqual(a.charsPerSecond, 4);
  const b = resolveTtsConfig({ tts: { voice_id: 'v' } }, {});
  assert.deepStrictEqual(b.provider, DEFAULT_TTS_PROVIDER);
  assert.strictEqual(b.providerSource, 'default.provider');
  const c = resolveTtsConfig({ tts: { provider: { name: 'sp', model: 'sm', version: 'sv' }, voice_id: 'v' } }, series);
  assert.deepStrictEqual(c.provider, { name: 'sp', model: 'sm', version: 'sv' }, 'script provider wins when explicitly given');
  assert.strictEqual(c.providerSource, 'script.tts.provider');
});

test('TTS2e. 集成:script.tts 只给 voice_id + 有对白 → exit 0,落默认 provider', () => {
  const dir = mkTempDir();
  fs.writeFileSync(path.join(dir, 'script.yaml'), [
    'episode: TTSTEST', 'title: T', 'schema_version: 2', ...TTS_INTENT,
    'tts:', "  voice_id: 'v7'",
    ...TTS_DEFAULTS,
    'scenes:', '  - id: s01', '    shots:',
    '      - id: s01-shot-01', "        style_en: 'cinematic'", "        prompt_en: 'a'", '        dialogue: \'hi\'', ''
  ].join('\n'));
  const r = runBuildManifest(dir);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  const m = readManifest(dir);
  assert.deepStrictEqual(m.tts.provider, DEFAULT_TTS_PROVIDER);
  assert.strictEqual(m.shots[0].voice_id, 'v7');
});

// ---- TTS3: 估时仅预警 ----

test('TTS3a. estimateDialogueSeconds 边界(空文本/自定义速率/空白不计数)', () => {
  assert.strictEqual(estimateDialogueSeconds('', {}), 0);
  assert.strictEqual(estimateDialogueSeconds(null, {}), 0);
  assert.strictEqual(estimateDialogueSeconds('你', {}), 1 / 5);
  assert.strictEqual(estimateDialogueSeconds('你好世界', { charsPerSecond: 2 }), 2);
  assert.strictEqual(estimateDialogueSeconds(' 你好 ', {}), 2 / 5);
  assert.strictEqual(estimateDialogueSeconds('你好', { charsPerSecond: 0 }), 2 / 5, 'invalid cps falls back to default 5');
});

test('TTS3b. 估时超过 duration 仅 WARN,不阻断(exit 0)', () => {
  const dir = mkTempDir();
  fs.writeFileSync(path.join(dir, 'script.yaml'), [
    'episode: TTSTEST', 'title: T', 'schema_version: 2', ...TTS_INTENT,
    'defaults:', '  duration: 1', "  ratio: '16:9'", "  resolution: '720p'", "  model: 'default'",
    'scenes:', '  - id: s01', '    shots:',
    '      - id: s01-shot-01', "        style_en: 'cinematic'", "        prompt_en: 'a'", "        voice_id: 'v1'",
    "        dialogue: '这是一段远远超过一秒钟时长的对白文本'", ''
  ].join('\n'));
  const r = runBuildManifest(dir);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.ok(/WARN/.test(r.stderr), `expected WARN on stderr: ${r.stderr}`);
  assert.ok(/estimate/.test(r.stderr), r.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'manifest.json')), 'WARN must not block manifest write');
});

// ---- TTS4: render-next tts stage ----

/** 造一个 tts-ready manifest(shot 已有 dialogue/tts_hash) */
function makeTtsShot(overrides = {}) {
  const text = overrides.dialogueText || '你好世界';
  const voiceId = overrides.voiceId || 'v1';
  const provider = overrides.provider || TTS_PROVIDER;
  const params = overrides.params || TTS_PARAMS;
  const shot = shotBase('s01-shot-01', {
    dialogue_text: text, voice_id: voiceId, tts_hash: ttsHashFor(text, voiceId, provider, params),
    tts_takes: overrides.tts_takes || [], selected_tts: overrides.selected_tts || null
  });
  applyShotHashes(shot, 2);
  return shot;
}

function makeTtsManifest(shots, overrides = {}) {
  return Object.assign({
    episode: 'TTSTEST', schema_version: 2,
    tts: { provider: TTS_PROVIDER, params: TTS_PARAMS, chars_per_second: 5 },
    render_tasks: [], shots
  }, overrides);
}

test('TTS4a. targetStage:有对白且无已选可用 take → tts;选中可用 take → video', () => {
  const shot = makeTtsShot();
  assert.strictEqual(targetStage({ require_keyframe: false }, shot), 'tts');
  shot.tts_takes = [{ id: 'tts-001', status: 'proposed', input_hash: shot.tts_hash }];
  assert.strictEqual(targetStage({ require_keyframe: false }, shot), 'tts', 'unselected take still needs claiming');
  shot.selected_tts = 'tts-001';
  assert.strictEqual(targetStage({ require_keyframe: false }, shot), 'video');
  shot.tts_takes[0].status = 'rejected';
  assert.strictEqual(targetStage({ require_keyframe: false }, shot), 'tts', 'rejected selected take is not usable');
});

test('TTS4b. 有对白无 take → render-next 建 tts 任务(字段/take_id/路径/账本 request)', () => {
  const dir = mkTempDir();
  writeManifest(dir, makeTtsManifest([makeTtsShot()]));
  const r = createRenderTask(dir);
  assert.strictEqual(r.task.stage, 'tts');
  assert.strictEqual(r.task.take_id, 'tts-001');
  assert.strictEqual(r.task.input_hash, r.shot.tts_hash);
  assert.deepStrictEqual(r.task.tts, {
    dialogue_text: '你好世界', voice_id: 'v1', provider: TTS_PROVIDER, tts_params: TTS_PARAMS
  });
  assert.ok(r.task.take_path.endsWith(`audio/s01-shot-01-tts-001.mp3`), r.task.take_path);
  assert.strictEqual(r.out.stage, 'tts');
  assert.strictEqual(readManifest(dir).quota_ledger.stages.tts.requests, 1);
  assert.strictEqual(readManifest(dir).quota_ledger.stages.video.requests, 0);
});

test('TTS4c. 同 hash 非 rejected take → 产物缓存命中(不建任务/cache_hit+1/selected_tts 落位/重复不重复计)', () => {
  const dir = mkTempDir();
  const shot = makeTtsShot({
    tts_takes: [{ id: 'tts-001', task_id: 'task-old', status: 'proposed', input_hash: null, content_digest: 'd', path: '/tmp/x.mp3' }]
  });
  shot.tts_takes[0].input_hash = shot.tts_hash;
  writeManifest(dir, makeTtsManifest([shot]));
  const r = createRenderTask(dir);
  assert.strictEqual(r.task.stage, 'tts');
  let m = readManifest(dir);
  assert.strictEqual(m.render_tasks.length, 0, 'cache hit must not create a task');
  assert.strictEqual(m.quota_ledger.stages.tts.cache_hits, 1);
  assert.strictEqual(m.quota_ledger.stages.tts.requests, 0);
  assert.strictEqual(m.shots[0].selected_tts, 'tts-001');
  // 第二次派发:selected 已落位 → 前往 keyframe/video;tts.cache_hits 不重复计
  createRenderTask(dir);
  m = readManifest(dir);
  assert.strictEqual(m.quota_ledger.stages.tts.cache_hits, 1, 'repeated dispatch must not recount');
});

test('TTS4d. tts-NNN 预留避让(与 computeNextKeyframeTakeId 同逻辑)', () => {
  assert.strictEqual(computeNextTtsTakeId({ id: 's', tts_takes: [] }, []), 'tts-001');
  assert.strictEqual(computeNextTtsTakeId({ id: 's', tts_takes: [{ id: 'tts-001' }] }, []), 'tts-002');
  assert.strictEqual(computeNextTtsTakeId({ id: 's', tts_takes: [{ id: 'tts-001' }] }, [{ shot_id: 's', stage: 'tts', take_id: 'tts-002' }]), 'tts-003');
});

test('TTS4e. 派发顺序 tts → keyframe → video', () => {
  // dir1: shots 数组把 keyframe 候选放前面,tts 候选放后面 → 仍先派 tts
  const dir1 = mkTempDir();
  const kfShot = shotBase('s01-shot-01', { keyframe_takes: [], selected_keyframe: null });
  applyShotHashes(kfShot, 2);
  const ttsShot = makeTtsShot();
  ttsShot.id = 's01-shot-02';
  writeManifest(dir1, makeTtsManifest([kfShot, ttsShot], { require_keyframe: true }));
  const r1 = createRenderTask(dir1);
  assert.strictEqual(r1.shot.id, 's01-shot-02');
  assert.strictEqual(r1.task.stage, 'tts');

  // dir2: video 候选放前面,keyframe 候选放后面 → 仍先派 keyframe
  const dir2 = mkTempDir();
  const kfPath = path.join(dir2, 'kf.png');
  fs.writeFileSync(kfPath, 'KF');
  const videoShot = shotBase('s01-shot-01', {
    keyframe_takes: [{ id: 'kf-001', path: kfPath, status: 'selected', content_digest: 'd', input_hash: null }],
    selected_keyframe: 'kf-001'
  });
  applyShotHashes(videoShot, 2);
  videoShot.keyframe_takes[0].input_hash = videoShot.keyframe_hash;
  const kfShot2 = shotBase('s01-shot-02', { keyframe_takes: [], selected_keyframe: null });
  applyShotHashes(kfShot2, 2);
  writeManifest(dir2, makeTtsManifest([videoShot, kfShot2], { require_keyframe: true }));
  const r2 = createRenderTask(dir2);
  assert.strictEqual(r2.shot.id, 's01-shot-02');
  assert.strictEqual(r2.task.stage, 'keyframe');
});

// ---- TTS5: provider adapter ----

test('TTS5a. parseDoubaoStream:事件流/裸 JSON 帧解析音频+usage;无音频/code 异常/JSON 响应抛错', () => {
  const a1 = Buffer.from('AUDIO-1');
  const a2 = Buffer.from('AUDIO-2');
  const stream = [
    'event: message',
    'data: ' + JSON.stringify({ code: 0, data: a1.toString('base64'), usage: { text_words: 7 } }),
    '',
    'event: message',
    'data: ' + JSON.stringify({ code: 20000000, data: a2.toString('base64') }),
    ''
  ].join('\n');
  const r = parseDoubaoStream(Buffer.from(stream), 'text/event-stream');
  assert.deepStrictEqual(r.audio, Buffer.concat([a1, a2]));
  assert.deepStrictEqual(r.usage, { text_words: 7 });

  const raw = JSON.stringify({ code: 0, data: a1.toString('base64') })
    + JSON.stringify({ code: 0, data: a2.toString('base64') });
  assert.deepStrictEqual(parseDoubaoStream(Buffer.from(raw), 'application/octet-stream').audio, Buffer.concat([a1, a2]));

  throws(() => parseDoubaoStream(Buffer.from('event: message\ndata: {"code":0}\n'), 'text/event-stream'), '未返回音频');
  throws(() => parseDoubaoStream(Buffer.from('data: {"code":40000000,"message":"bad"}\n'), 'text/event-stream'), 'code=40000000');
  throws(() => parseDoubaoStream(Buffer.from('{"code":1,"message":"denied"}'), 'application/json'), 'JSON');
});

test('TTS5b. classifyTtsError:4xx→hard(403 resource not granted)/5xx·超时·网络→transient', () => {
  const e403 = new Error('doubao tts HTTP 403: {"error":"resource not granted"}');
  e403.statusCode = 403;
  assert.strictEqual(classifyTtsError(e403), 'hard');
  const e500 = new Error('doubao tts HTTP 500: oops');
  e500.statusCode = 500;
  assert.strictEqual(classifyTtsError(e500), 'transient');
  const eTimeout = new Error('doubao tts request timed out after 90000ms');
  eTimeout.code = 'ETIMEDOUT';
  assert.strictEqual(classifyTtsError(eTimeout), 'transient');
  const eNet = new Error('socket hang up');
  eNet.code = 'ECONNRESET';
  assert.strictEqual(classifyTtsError(eNet), 'transient');
  assert.strictEqual(classifyTtsError(new Error('HTTP 401: invalid token')), 'hard');
});

test('TTS5c. 缺 apiKey → 同步抛错且消息含 env 名(不发请求)', () => {
  const savedKey = process.env.DOUBAO_TTS_API_KEY;
  const savedMock = process.env.TTS_MOCK;
  delete process.env.DOUBAO_TTS_API_KEY;
  delete process.env.TTS_MOCK;
  try {
    throws(() => synthDoubao({ text: 'hi', voiceId: 'v1' }), 'DOUBAO_TTS_API_KEY');
  } finally {
    if (savedKey !== undefined) process.env.DOUBAO_TTS_API_KEY = savedKey;
    if (savedMock !== undefined) process.env.TTS_MOCK = savedMock;
  }
});

test('TTS5d. TTS_MOCK=1 缺 TTS_MOCK_AUDIO → 抛错(拒绝伪造静音)', () => {
  const savedMock = process.env.TTS_MOCK;
  const savedAudio = process.env.TTS_MOCK_AUDIO;
  process.env.TTS_MOCK = '1';
  delete process.env.TTS_MOCK_AUDIO;
  try {
    throws(() => synthDoubao({ text: 'hi', voiceId: 'v1' }), 'TTS_MOCK_AUDIO');
  } finally {
    if (savedMock !== undefined) process.env.TTS_MOCK = savedMock; else delete process.env.TTS_MOCK;
    if (savedAudio !== undefined) process.env.TTS_MOCK_AUDIO = savedAudio; else delete process.env.TTS_MOCK_AUDIO;
  }
});

testAsync('TTS5e. TTS_MOCK=1 + TTS_MOCK_AUDIO → 无网络返回夹具字节(无需 apiKey)', async () => {
  const dir = mkTempDir();
  const p = path.join(dir, 'mock.mp3');
  fs.writeFileSync(p, 'MOCK-AUDIO-BYTES');
  const saved = { mock: process.env.TTS_MOCK, audio: process.env.TTS_MOCK_AUDIO, key: process.env.DOUBAO_TTS_API_KEY };
  process.env.TTS_MOCK = '1';
  process.env.TTS_MOCK_AUDIO = p;
  delete process.env.DOUBAO_TTS_API_KEY;
  try {
    const r = await synthDoubao({ text: '你好', voiceId: 'v1' });
    assert.strictEqual(r.audio.toString('utf8'), 'MOCK-AUDIO-BYTES');
    assert.ok(/^mock-/.test(r.requestId));
    assert.strictEqual(r.usage.mock, true);
  } finally {
    if (saved.mock !== undefined) process.env.TTS_MOCK = saved.mock; else delete process.env.TTS_MOCK;
    if (saved.audio !== undefined) process.env.TTS_MOCK_AUDIO = saved.audio; else delete process.env.TTS_MOCK_AUDIO;
    if (saved.key !== undefined) process.env.DOUBAO_TTS_API_KEY = saved.key; else delete process.env.DOUBAO_TTS_API_KEY;
  }
});

// ---- TTS6: tts.js CLI 核心 ----

/** 造一个含可调度 tts 任务的 episode */
function seedTtsTaskDir(overrides = {}) {
  const dir = mkTempDir();
  const text = overrides.text || '你好世界';
  const voiceId = overrides.voiceId || 'v1';
  const provider = overrides.provider || TTS_PROVIDER;
  const params = overrides.params || TTS_PARAMS;
  const hash = ttsHashFor(text, voiceId, provider, params);
  const shot = shotBase('s01-shot-01', {
    dialogue_text: text, voice_id: voiceId, tts_hash: hash,
    tts_takes: overrides.tts_takes || [], selected_tts: overrides.selected_tts || null
  });
  applyShotHashes(shot, 2);
  writeManifest(dir, {
    episode: 'TTSTEST', schema_version: 2,
    tts: { provider, params, chars_per_second: 5 },
    render_tasks: [{
      task_id: 'task-tts', shot_id: 's01-shot-01', take_id: 'tts-001', stage: 'tts',
      input_hash: hash, status: 'submitted', superseded_at: null, breaker_epoch: 0,
      tts: { dialogue_text: text, voice_id: voiceId, provider, tts_params: params }
    }],
    shots: [shot]
  });
  return dir;
}

test('TTS6a. tts.js parseArgs / loadEnvFile 极简解析', () => {
  let o = ttsParseArgs(['ep', '--task', 't1', '--select', '--env-file', '.env']);
  assert.strictEqual(o.taskId, 't1');
  assert.strictEqual(o.select, true);
  assert.strictEqual(o.envFile, '.env');
  o = ttsParseArgs(['ep', '--list']);
  assert.strictEqual(o.list, true);
  o = ttsParseArgs(['ep', '--task', 't1', '--take', '/tmp/a.mp3']);
  assert.strictEqual(o.takePath, '/tmp/a.mp3');

  const dir = mkTempDir();
  const envPath = path.join(dir, 'x.env');
  fs.writeFileSync(envPath, '# comment\n\nFOO_KEY=bar\nexport BAZ_KEY="qux"\n');
  const savedFoo = process.env.FOO_KEY;
  const savedBaz = process.env.BAZ_KEY;
  try {
    const loaded = loadEnvFile(envPath);
    assert.deepStrictEqual(loaded, { FOO_KEY: 'bar', BAZ_KEY: 'qux' });
    assert.strictEqual(process.env.FOO_KEY, 'bar');
    assert.strictEqual(process.env.BAZ_KEY, 'qux');
  } finally {
    if (savedFoo === undefined) delete process.env.FOO_KEY; else process.env.FOO_KEY = savedFoo;
    if (savedBaz === undefined) delete process.env.BAZ_KEY; else process.env.BAZ_KEY = savedBaz;
  }

  // --list 只读加锁检查:不应生成 .lock
  const listDir = seedTtsTaskDir();
  const tasks = listTtsTasks(listDir);
  assert.strictEqual(tasks.length, 1);
  assert.ok(!fs.existsSync(listDir + '.lock'), '--list must not lock');
});

testAsync('TTS6b. stub adapter → 产物落 audio/、take 记录完整、tts.success+1 且不重复计 request', async () => {
  const dir = seedTtsTaskDir();
  let called = 0;
  const stub = async (args) => {
    called++;
    assert.strictEqual(args.text, '你好世界');
    assert.strictEqual(args.voiceId, 'v1');
    return { audio: Buffer.from('SYNTH-AUDIO'), requestId: 'req-1' };
  };
  const r = await runTts(dir, { taskId: 'task-tts', synth: stub, probeDurationSec: () => 1.5 });
  assert.strictEqual(called, 1);
  assert.strictEqual(r.idempotent, false);
  const outPath = path.join(dir, 'audio', 's01-shot-01-tts-001.mp3');
  assert.ok(fs.existsSync(outPath));
  assert.strictEqual(fs.readFileSync(outPath, 'utf8'), 'SYNTH-AUDIO');
  const m = readManifest(dir);
  const t = m.shots[0].tts_takes[0];
  assert.strictEqual(t.id, 'tts-001');
  assert.strictEqual(t.task_id, 'task-tts');
  assert.strictEqual(t.status, 'proposed');
  assert.strictEqual(t.input_hash, m.shots[0].tts_hash);
  assert.strictEqual(t.duration_sec, 1.5);
  assert.strictEqual(t.provider.name, 'doubao');
  assert.strictEqual(t.request_id, 'req-1');
  assert.ok(t.content_digest, 'take must record content_digest');
  assert.strictEqual(m.quota_ledger.stages.tts.successes, 1);
  assert.strictEqual(m.quota_ledger.stages.tts.requests, 0, 'tts.js must not double-count request');
  assert.ok(!fs.existsSync(outPath + '.lock'));
});

testAsync('TTS6c. --select 落 selected_tts 并清其他 selected 标记(≤1)', async () => {
  const dir = seedTtsTaskDir({
    tts_takes: [{ id: 'tts-001', task_id: 'task-other', status: 'selected', input_hash: 'old', content_digest: 'x', path: '/tmp/old.mp3' }],
    selected_tts: 'tts-001'
  });
  await runTts(dir, { taskId: 'task-tts', select: true, synth: async () => ({ audio: Buffer.from('NEW-AUDIO'), requestId: 'req-2' }), probeDurationSec: () => 2 });
  const m = readManifest(dir);
  assert.strictEqual(m.shots[0].selected_tts, 'tts-002');
  assert.strictEqual(m.shots[0].tts_takes.find(t => t.id === 'tts-002').status, 'selected');
  assert.strictEqual(m.shots[0].tts_takes.find(t => t.id === 'tts-001').status, 'proposed', 'other selected demoted');
  assert.strictEqual(m.shots[0].tts_takes.filter(t => t.status === 'selected').length, 1);
});

testAsync('TTS6d. 幂等:重复调用(同 task+digest)不新增 take、不重复计 success', async () => {
  const dir = seedTtsTaskDir();
  const stub = async () => ({ audio: Buffer.from('SAME'), requestId: 'r' });
  await runTts(dir, { taskId: 'task-tts', synth: stub, probeDurationSec: () => 1 });
  const r2 = await runTts(dir, { taskId: 'task-tts', synth: async () => ({ audio: Buffer.from('SAME'), requestId: 'r2' }), probeDurationSec: () => 1 });
  assert.strictEqual(r2.idempotent, true);
  const m = readManifest(dir);
  assert.strictEqual(m.shots[0].tts_takes.length, 1);
  assert.strictEqual(m.quota_ledger.stages.tts.successes, 1);
});

testAsync('TTS6e. --take 记录外部产物且不调用 adapter(--select 生效)', async () => {
  const dir = seedTtsTaskDir();
  const ext = path.join(dir, 'external.mp3');
  fs.writeFileSync(ext, 'EXT-AUDIO');
  let called = 0;
  await runTts(dir, {
    taskId: 'task-tts', takePath: ext, select: true,
    synth: async () => { called++; return { audio: Buffer.from('NOPE') }; },
    probeDurationSec: () => 3
  });
  assert.strictEqual(called, 0, '--take must not call the adapter');
  const m = readManifest(dir);
  assert.strictEqual(m.shots[0].tts_takes[0].duration_sec, 3);
  assert.strictEqual(m.shots[0].tts_takes[0].request_id, null);
  assert.strictEqual(m.shots[0].selected_tts, 'tts-001');
});

testAsync('TTS6f. 失败:分类 + 零落盘 + 不自动记账', async () => {
  const dir = seedTtsTaskDir();
  const before = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');
  const boom = new Error('doubao tts HTTP 403: {"error":"resource not granted"}');
  boom.statusCode = 403;
  let caught = null;
  try {
    await runTts(dir, { taskId: 'task-tts', synth: async () => { throw boom; }, probeDurationSec: () => 1 });
  } catch (e) { caught = e; }
  assert.ok(caught, 'runTts must reject on adapter failure');
  assert.strictEqual(caught.kind || classifyTtsError(caught), 'hard');
  assert.strictEqual(caught.ttsTask.task_id, 'task-tts');
  assert.ok(!fs.existsSync(path.join(dir, 'audio')), 'failed run must not leave artifacts');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), before, 'failed run must not touch manifest');
});

test('TTS6g. CLI 失败(mock 夹具缺失)→ 分类 + 建议命令 + 非零退出 + 零落盘', () => {
  const dir = seedTtsTaskDir();
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'tts.js'), dir, '--task', 'task-tts'], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { TTS_MOCK: '1', TTS_MOCK_AUDIO: path.join(dir, 'nope.mp3') })
  });
  assert.notStrictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.ok(/tts failed \((hard|transient)\)/.test(r.stderr), r.stderr);
  assert.ok(/mark-shot\.js/.test(r.stderr), r.stderr);
  assert.ok(/--kind (hard|transient)/.test(r.stderr), r.stderr);
  assert.ok(!fs.existsSync(path.join(dir, 'audio')));
});

test('TTS6h. CLI 本地入参/状态错误(任务不存在)→ invalid/exit 2,不给 attempt 建议、零落盘', () => {
  const dir = seedTtsTaskDir();
  const before = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'tts.js'), dir, '--task', 'nope'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.ok(/tts invalid/.test(r.stderr), r.stderr);
  assert.ok(!/mark-shot\.js/.test(r.stderr), 'invalid input must not suggest reporting an attempt');
  assert.ok(!fs.existsSync(path.join(dir, 'audio')));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), before);
});

// ---- TTS7: mark-shot 账本 stage 映射 ----

test('TTS7a. tts 任务 --failed → quota_ledger.tts.failed_billed(不是 video)', () => {
  const dir = seedTtsTaskDir();
  const manifest = readManifest(dir);
  const shot = manifest.shots[0];
  const r = recordTaskFailure({ manifest, shot, shotId: 's01-shot-01', opts: { taskId: 'task-tts', error: 'content policy', kindOverride: 'hard' } });
  assert.strictEqual(r.kind, 'hard');
  assert.strictEqual(manifest.quota_ledger.stages.tts.failed_billed, 1);
  assert.strictEqual(manifest.quota_ledger.stages.video.failed_billed, 0);
  assert.strictEqual(manifest.quota_ledger.stages.image.failed_billed, 0);
});

test('TTS7b. mark-shot --kind hard|transient 可用(建议命令可直接执行)', () => {
  assert.strictEqual(markShotParseArgs(['ep', 's', '--failed', '--task', 't', '--kind', 'transient']).kindOverride, 'transient');
  assert.strictEqual(markShotParseArgs(['ep', 's', '--failed', '--task', 't', '--kind', 'hard']).kindOverride, 'hard');
});

// ---- TTS8: 生产不漂移 ----

test('TTS8. 无对白 episode:重建两次 shot 字段集合不变且无 tts 字段', () => {
  const dir = mkTempDir();
  writeTtsScript(dir, ['      - id: s01-shot-01', "        style_en: 'cinematic'", "        prompt_en: 'a'"]);
  assert.strictEqual(runBuildManifest(dir).status, 0);
  const keys1 = Object.keys(readManifest(dir).shots[0]).sort();
  assert.strictEqual(runBuildManifest(dir).status, 0);
  const keys2 = Object.keys(readManifest(dir).shots[0]).sort();
  assert.deepStrictEqual(keys2, keys1, 'no-dialogue rebuild must not drift shot fields');
  for (const f of ['dialogue_text', 'voice_id', 'tts_hash', 'tts_takes', 'selected_tts']) {
    assert.ok(!keys2.includes(f), f);
  }
});

// ============================================================
console.log('\n[OVF] 时长四量与溢出策略(PRD §3.4,M5-OVF;帧级决策,不跑 ffmpeg)')
// ============================================================

// ---- 夹具 ----
function ovfTtsTake(id, durationSec, over = {}) {
  const t = { id, status: 'candidate', input_hash: 'h1' };
  if (durationSec !== undefined) t.duration_sec = durationSec;
  return Object.assign(t, over);
}
function ovfShot(id, opts = {}) {
  const shot = { id, takes: [{ id: 'take-001' }] };
  if (opts.text !== undefined) shot.dialogue_text = opts.text;
  if (opts.ttsTakes !== undefined) shot.tts_takes = opts.ttsTakes;
  if (opts.selected !== undefined) shot.selected_tts = opts.selected;
  return shot;
}
function ovfManifest(shots, extra = {}) {
  return Object.assign({ episode: 'OVF', schema_version: 2, fps: 24, shots }, extra);
}
function ovfEdit(entries, extra = {}) {
  return { timeline: Object.assign({ fps: 24 }, extra, { clips: entries }) };
}
function ovfClip(over = {}) {
  return Object.assign({
    clip_id: 'clip-0001', shot_id: 's01', take_id: 'take-001',
    source_in: 0, source_out: 24, deleted_head_frames: 0, padding_frames: 0,
    spill_in: [], output_start: 0, output_end: 24, dialogue: null,
  }, over);
}

// ---- OVF1: 四量 / 溢出计算 ----

test('OVF1a. resolveDialogueTiming:实测/缺失/selected 优先;绝不以估时代替实测', () => {
  const shot = ovfShot('s01', {
    text: '你好',
    ttsTakes: [ovfTtsTake('tts-001', 1.234), ovfTtsTake('tts-002', 2, { status: 'rejected' })],
    selected: 'tts-001',
  });
  const t = resolveDialogueTiming({ shot, fps: 24 });
  assert.strictEqual(t.measured, true);
  assert.strictEqual(t.dialogue_ms, 1234);
  assert.strictEqual(t.dialogue_frames, 30);
  assert.strictEqual(t.tts_take_id, 'tts-001');

  // 显式 ttsTake 优先
  const t2 = resolveDialogueTiming({ shot, ttsTake: ovfTtsTake('tts-009', 0.5), fps: 24 });
  assert.strictEqual(t2.tts_take_id, 'tts-009');
  assert.strictEqual(t2.dialogue_ms, 500);

  // 无 take(有对白文字)→ measured:false,不得用估时
  const none = resolveDialogueTiming({ shot: ovfShot('s02', { text: '你好' }), fps: 24 });
  assert.strictEqual(none.measured, false);
  assert.strictEqual(none.dialogue_ms, null);
  assert.strictEqual(none.dialogue_frames, null);
  assert.strictEqual(none.tts_take_id, null);

  // take 无 duration_sec → measured:false(仍记 take_id)
  const noDur = resolveDialogueTiming({
    shot: ovfShot('s03', { text: 'x', ttsTakes: [{ id: 'tts-003', status: 'candidate' }], selected: 'tts-003' }),
    fps: 24,
  });
  assert.strictEqual(noDur.measured, false);
  assert.strictEqual(noDur.tts_take_id, 'tts-003');
  assert.strictEqual(noDur.dialogue_ms, null);

  // selected 指向 rejected → 不采用;显式 rejected take → measured:false
  assert.strictEqual(selectDialogueTake(ovfShot('s04', { ttsTakes: [ovfTtsTake('r1', 1, { status: 'rejected' })], selected: 'r1' })), null);
  assert.strictEqual(resolveDialogueTiming({ shot: null, ttsTake: ovfTtsTake('r1', 1, { status: 'rejected' }), fps: 24 }).measured, false);

  throws(() => resolveDialogueTiming({ shot, fps: 0 }), 'fps');
  throws(() => resolveDialogueTiming({ shot, fps: -24 }), 'fps');
  throws(() => resolveDialogueTiming({ shot, fps: NaN }), 'fps');
});

test('OVF1b. overflowFrames:毫秒向上进位;输出足够时不溢出', () => {
  assert.strictEqual(overflowFrames(1000, 24, 24), 0);
  assert.strictEqual(overflowFrames(1000, 30, 24), 0, '输出更长 → 0(向下不溢出)');
  assert.strictEqual(overflowFrames(1001, 24, 24), 1, '毫秒进位 → 1 帧');
  assert.strictEqual(overflowFrames(1042, 24, 24), 2);
  assert.strictEqual(overflowFrames(1500, 24, 24), 12);
  assert.strictEqual(overflowFrames(0, 0, 24), 0);
  throws(() => overflowFrames(-1, 24, 24), 'dialogueMs');
  throws(() => overflowFrames(1000, -1, 24), 'outputDurationFrames');
  throws(() => overflowFrames(1000, 1.5, 24), 'outputDurationFrames');
  throws(() => overflowFrames(1000, 24, 0), 'fps');
});

// ---- OVF2: 策略优先级 ----

test('OVF2. decideOverflow 优先级:none/pad(0 不生效)/trim/spill/error;pad 上限 clamp', () => {
  // none
  assert.deepStrictEqual(decideOverflow({ overflowFrames: 0, allowTrim: true, maxFreezePaddingFrames: 10 }), { strategy: 'none' });
  // pad:溢出 ≤ 上限
  assert.deepStrictEqual(decideOverflow({ overflowFrames: 5, maxFreezePaddingFrames: 5 }), { strategy: 'pad_freeze', padding_frames: 5 });
  // pad clamp:padding_frames 只取溢出量,不取上限
  assert.deepStrictEqual(decideOverflow({ overflowFrames: 3, maxFreezePaddingFrames: 10 }), { strategy: 'pad_freeze', padding_frames: 3 });
  // pad 优先于 trim(即使 allow_trim 开启)
  assert.deepStrictEqual(decideOverflow({ overflowFrames: 3, maxFreezePaddingFrames: 3, allowTrim: true }), { strategy: 'pad_freeze', padding_frames: 3 });
  // 上限 0 默认不生效 → trim 未开启 → error
  assert.strictEqual(decideOverflow({ overflowFrames: 5, maxFreezePaddingFrames: 0 }).strategy, 'error');
  // trim(仅 allow_trim:true)
  assert.deepStrictEqual(decideOverflow({ overflowFrames: 5, maxFreezePaddingFrames: 0, allowTrim: true }), { strategy: 'trim' });
  // trim 优先于 spill
  assert.deepStrictEqual(decideOverflow({ overflowFrames: 5, allowTrim: true, spill: { ok: true } }), { strategy: 'trim' });
  // spill(allow_trim=false,spill.ok)
  assert.deepStrictEqual(decideOverflow({ overflowFrames: 5, spill: { ok: true, reason: '' } }), { strategy: 'dialogue_spill' });
  // error:列明三种否决原因
  const err = decideOverflow({ overflowFrames: 5, spill: { ok: false, reason: 'next clip does not exist' } });
  assert.strictEqual(err.strategy, 'error');
  assert.ok(/pad_freeze/.test(err.reason) && /allow_trim/.test(err.reason) && /next clip does not exist/.test(err.reason), err.reason);
  throws(() => decideOverflow({ overflowFrames: -1 }), 'overflowFrames');
  throws(() => decideOverflow({ overflowFrames: 1, maxFreezePaddingFrames: -1 }), 'maxFreezePaddingFrames');
});

// ---- OVF3: spill 五条约束 ----

test('OVF3. checkSpillConstraints:下一 clip 缺失/下游有对白/超时长/cut_join/重复 spill 全拒绝;合法通过', () => {
  const up = ovfClip({ dialogue: { take_id: 'tts-001', dialogue_ms: 1500, measured: true, text: '你好' } });
  const down = ovfClip({ clip_id: 'clip-0002', shot_id: 's02', output_start: 24, output_end: 48 });

  assert.deepStrictEqual(checkSpillConstraints({ clip: up, nextClip: down, overflowFrames: 12, fps: 24 }), { ok: true });

  const noNext = checkSpillConstraints({ clip: up, nextClip: null, overflowFrames: 12, fps: 24 });
  assert.strictEqual(noNext.ok, false);
  assert.ok(/no next clip/.test(noNext.reason), noNext.reason);

  const downDialogue = Object.assign({}, down, { dialogue: { take_id: 'tts-009', dialogue_ms: 500, measured: true, text: 'x' } });
  const withDialogue = checkSpillConstraints({ clip: up, nextClip: downDialogue, overflowFrames: 12, fps: 24 });
  assert.strictEqual(withDialogue.ok, false);
  assert.ok(/non-empty dialogue/.test(withDialogue.reason), withDialogue.reason);

  const shortDown = Object.assign({}, down, { source_out: 6, output_start: 0, output_end: 6 });
  const tooLong = checkSpillConstraints({ clip: up, nextClip: shortDown, overflowFrames: 12, fps: 24 });
  assert.strictEqual(tooLong.ok, false);
  assert.ok(/exceeds next clip/.test(tooLong.reason), tooLong.reason);

  const upCutJoin = checkSpillConstraints({ clip: Object.assign({}, up, { cut_join: true }), nextClip: down, overflowFrames: 12, fps: 24 });
  assert.strictEqual(upCutJoin.ok, false);
  assert.ok(/cut_join/.test(upCutJoin.reason), upCutJoin.reason);

  const downCutJoin = checkSpillConstraints({ clip: up, nextClip: Object.assign({}, down, { cut_join: true }), overflowFrames: 12, fps: 24 });
  assert.strictEqual(downCutJoin.ok, false);
  assert.ok(/cut_join/.test(downCutJoin.reason), downCutJoin.reason);

  const repeat = checkSpillConstraints({ clip: Object.assign({}, up, { dialogue_spill_ms: 500 }), nextClip: down, overflowFrames: 12, fps: 24 });
  assert.strictEqual(repeat.ok, false);
  assert.ok(/at most once/.test(repeat.reason), repeat.reason);
});

// ---- OVF4: trim ----

test('OVF4. trimDialogue:标点断句/硬切/已含 …/keep≥总长/空文本', () => {
  // 标点断句优先(比例 3 字,落在「，」)
  assert.deepStrictEqual(trimDialogue({ text: '你好，世界再见', dialogueMs: 2000, keepMs: 1000 }), { text: '你好，…', truncated: true });
  // 无标点 → 硬切
  assert.deepStrictEqual(trimDialogue({ text: '你好世界再见', dialogueMs: 2000, keepMs: 1000 }), { text: '你好世…', truncated: true });
  // 已含 … 不重复
  assert.deepStrictEqual(trimDialogue({ text: '你好…世界', dialogueMs: 2000, keepMs: 1000 }), { text: '你好…', truncated: true });
  // keepMs ≥ dialogueMs → 原文
  assert.deepStrictEqual(trimDialogue({ text: '你好世界', dialogueMs: 1000, keepMs: 1000 }), { text: '你好世界', truncated: false });
  assert.deepStrictEqual(trimDialogue({ text: '你好世界', dialogueMs: 1000, keepMs: 1500 }), { text: '你好世界', truncated: false });
  // 空文本
  assert.deepStrictEqual(trimDialogue({ text: '', dialogueMs: 1000, keepMs: 100 }), { text: '', truncated: false });
  assert.deepStrictEqual(trimDialogue({ text: null, dialogueMs: 1000, keepMs: 100 }), { text: '', truncated: false });
  // 去尾空白
  assert.deepStrictEqual(trimDialogue({ text: '你好世界   ', dialogueMs: 2000, keepMs: 1000 }), { text: '你好世…', truncated: true });
});

// ---- OVF5: build-timeline 集成 ----

test('OVF5a. 无溢出 → 原文/overflow none/dialogue.measured;v1 不接入', () => {
  const manifest = ovfManifest([ovfShot('s01', { text: '你好世界', ttsTakes: [ovfTtsTake('tts-001', 1.0)], selected: 'tts-001' })]);
  const tl = buildTimeline({ edit: ovfEdit([{ shot_id: 's01', take_id: 'take-001', source_in: 0, source_out: 24 }]), manifest });
  const c = tl.clips[0];
  assert.strictEqual(c.dialogue.measured, true);
  assert.strictEqual(c.dialogue.dialogue_ms, 1000);
  assert.strictEqual(c.dialogue.take_id, 'tts-001');
  assert.strictEqual(c.dialogue.text, '你好世界');
  assert.strictEqual(c.overflow.strategy, 'none');
  assert.strictEqual(c.output_end, 24);
  assert.strictEqual(validateTimeline(tl).ok, true, JSON.stringify(validateTimeline(tl).errors));

  // v1(无 schema_version)→ 不接对白,字段不漂移
  const m1 = ovfManifest([ovfShot('s01', { text: '你好世界', ttsTakes: [ovfTtsTake('tts-001', 3)], selected: 'tts-001' })], { schema_version: undefined });
  const tl1 = buildTimeline({ edit: ovfEdit([{ shot_id: 's01', take_id: 'take-001', source_in: 0, source_out: 24 }]), manifest: m1 });
  assert.ok(!Object.prototype.hasOwnProperty.call(tl1.clips[0], 'dialogue'), 'v1 不得新增 dialogue 字段');
  assert.ok(!Object.prototype.hasOwnProperty.call(tl1.clips[0], 'overflow'), 'v1 不得新增 overflow 字段');
});

test('OVF5b. pad_freeze → padding_frames 落位且输出时长变化(edit.timeline 与 edit.overflow 均可配)', () => {
  const manifest = ovfManifest([ovfShot('s01', { text: '你好', ttsTakes: [ovfTtsTake('tts-001', 1.5)], selected: 'tts-001' })]);
  const entry = { shot_id: 's01', take_id: 'take-001', source_in: 0, source_out: 24 };

  let tl = buildTimeline({ edit: ovfEdit([entry], { max_freeze_padding_frames: 12 }), manifest });
  let c = tl.clips[0];
  assert.strictEqual(c.padding_frames, 12);
  assert.strictEqual(c.output_end, 36);
  assert.strictEqual(c.overflow.strategy, 'pad_freeze');
  assert.strictEqual(c.overflow.overflow_frames, 12);
  assert.strictEqual(validateTimeline(tl).ok, true, JSON.stringify(validateTimeline(tl).errors));

  // edit 顶层 overflow 配置亦接受
  tl = buildTimeline({ edit: { overflow: { max_freeze_padding_frames: 12 }, timeline: { fps: 24, clips: [entry] } }, manifest });
  c = tl.clips[0];
  assert.strictEqual(c.padding_frames, 12);
  assert.strictEqual(c.output_end, 36);

  // 上限不足(溢出 12 > 上限 5)→ 无 trim/spill → 抛错
  throws(() => buildTimeline({ edit: ovfEdit([entry], { max_freeze_padding_frames: 5 }), manifest }), 'overflow unresolved');
});

test('OVF5c. trim(allow_trim) → clip.trim + dialogue.text 截断 + 输出不变', () => {
  const manifest = ovfManifest([ovfShot('s01', { text: '你好世界再见', ttsTakes: [ovfTtsTake('tts-001', 2.0)], selected: 'tts-001' })]);
  const tl = buildTimeline({
    edit: ovfEdit([{ shot_id: 's01', take_id: 'take-001', source_in: 0, source_out: 24 }], { allow_trim: true }),
    manifest,
  });
  const c = tl.clips[0];
  assert.deepStrictEqual(c.trim, { dialogue_ms: 2000, keep_ms: 1000, text_truncated: true });
  assert.strictEqual(c.dialogue.text, '你好世…');
  assert.strictEqual(c.dialogue.dialogue_ms, 1000);
  assert.strictEqual(c.padding_frames, 0);
  assert.strictEqual(c.output_end, 24);
  assert.strictEqual(c.overflow.strategy, 'trim');
  assert.strictEqual(validateTimeline(tl).ok, true, JSON.stringify(validateTimeline(tl).errors));
});

test('OVF5d. dialogue_spill → 上游 dialogue_spill_ms + 下游 spill_in;视频时长不变', () => {
  const manifest = ovfManifest([
    ovfShot('s01', { text: '你好', ttsTakes: [ovfTtsTake('tts-001', 1.5)], selected: 'tts-001' }),
    ovfShot('s02', { ttsTakes: [] }),
  ]);
  const tl = buildTimeline({
    edit: ovfEdit([
      { shot_id: 's01', take_id: 'take-001', source_in: 0, source_out: 24 },
      { shot_id: 's02', take_id: 'take-001', source_in: 0, source_out: 24 },
    ]),
    manifest,
  });
  const [a, b] = tl.clips;
  assert.strictEqual(a.dialogue_spill_ms, 500);
  assert.strictEqual(a.overflow.strategy, 'dialogue_spill');
  assert.strictEqual(a.padding_frames, 0);
  assert.deepStrictEqual(a.spill_in, []);
  assert.deepStrictEqual(b.spill_in, [{ dialogue: 'tts-001', take_id: 'tts-001', ms: 500 }]);
  assert.strictEqual(b.dialogue, null);
  assert.deepStrictEqual([a.output_start, a.output_end, b.output_start, b.output_end], [0, 24, 24, 48]);
  assert.strictEqual(validateTimeline(tl).ok, true, JSON.stringify(validateTimeline(tl).errors));
});

test('OVF5e. error → 抛错且 CLI 不写 timeline.json(消息含 clip id/溢出帧数/否决原因)', () => {
  const manifest = ovfManifest([ovfShot('s01', { text: '你好', ttsTakes: [ovfTtsTake('tts-001', 1.5)], selected: 'tts-001' })]);
  const entry = { shot_id: 's01', take_id: 'take-001', source_in: 0, source_out: 24 };
  let msg = '';
  try { buildTimeline({ edit: ovfEdit([entry]), manifest }); } catch (e) { msg = e.message; }
  assert.ok(/clip-0001/.test(msg), msg);
  assert.ok(/overflow 12 frame/.test(msg), msg);
  assert.ok(/pad_freeze/.test(msg) && /allow_trim/.test(msg) && /dialogue_spill/.test(msg), msg);

  const dir = mkTempDir();
  fs.writeFileSync(path.join(dir, 'edit.yaml'), [
    'timeline:', '  fps: 24', '  clips:',
    '    - shot_id: s01', '      take_id: take-001', '      source_in: 0', '      source_out: 24', ''
  ].join('\n'));
  writeManifest(dir, manifest);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'build-timeline.js'), dir], { encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.ok(/overflow unresolved/.test(r.stderr), r.stderr);
  assert.ok(!fs.existsSync(path.join(dir, 'timeline.json')), 'error 时不得写 timeline.json');
});

test('OVF5f. measured:false → WARN 但 timeline 仍生成(带标记,不阻断)', () => {
  const warnings = [];
  const manifest = ovfManifest([ovfShot('s01', { text: '你好', ttsTakes: [] })]);
  const tl = buildTimeline({
    edit: ovfEdit([{ shot_id: 's01', take_id: 'take-001', source_in: 0, source_out: 24 }]),
    manifest,
    options: { warn: (m) => warnings.push(m) },
  });
  const c = tl.clips[0];
  assert.strictEqual(c.dialogue.measured, false);
  assert.strictEqual(c.dialogue.dialogue_ms, null);
  assert.strictEqual(c.dialogue.take_id, null);
  assert.strictEqual(c.overflow, undefined);
  assert.ok(warnings.some(w => /measured/.test(w) && /clip-0001/.test(w)), JSON.stringify(warnings));
  assert.strictEqual(validateTimeline(tl).ok, true, JSON.stringify(validateTimeline(tl).errors));
});

test('OVF5g. SFX/music cue 落入 spill 段 → WARN(允许但留痕)', () => {
  const manifest = ovfManifest([
    ovfShot('s01', { text: '你好', ttsTakes: [ovfTtsTake('tts-001', 1.5)], selected: 'tts-001' }),
    ovfShot('s02', { ttsTakes: [] }),
  ]);
  const warnings = [];
  buildTimeline({
    edit: ovfEdit([
      { shot_id: 's01', take_id: 'take-001', source_in: 0, source_out: 24 },
      { shot_id: 's02', take_id: 'take-001', source_in: 0, source_out: 24, sfx: [{ id: 'hit', at: 4, gain_db: -3 }] },
    ], { cues: [{ clip_id: 'clip-0002', at: 2 }] }),
    manifest,
    options: { warn: (m) => warnings.push(m) },
  });
  assert.ok(warnings.some(w => /spill segment/.test(w) && /hit/.test(w)), JSON.stringify(warnings));
  assert.ok(warnings.some(w => /timeline\.cues/.test(w)), JSON.stringify(warnings));
});

// ---- OVF6: Gate #6 接线 ----

test('OVF6. Gate #6:未声明豁免/声明未解决 fail/全部解决 pass/未声明但有对白 fail/v1 N/A/无 timeline fail', () => {
  const declaredIntent = { dialogue: true, audio: 'dialogue', subtitles: 'burn', silent: false };

  // intent.dialogue=false 且无字幕需求 → not_applicable
  let r = GATE.evaluateReleaseGate({
    manifest: { schema_version: 2, intent: { dialogue: false, audio: 'music_sfx', subtitles: 'none', silent: false } },
    timeline: { fps: 24, clips: [ovfClip()] },
  });
  assert.strictEqual(gateItem(r, '6').status, 'not_applicable');

  // 声明 dialogue + 未解决溢出 → fail(消息含 clip)
  r = GATE.evaluateReleaseGate({
    manifest: { schema_version: 2, intent: declaredIntent },
    timeline: { fps: 24, clips: [ovfClip({ dialogue: { take_id: 'tts-001', dialogue_ms: 1500, measured: true, text: '你好' } })] },
  });
  assert.strictEqual(gateItem(r, '6').status, 'fail');
  assert.ok(gateItem(r, '6').reasons.some(x => /clip-0001/.test(x)), JSON.stringify(gateItem(r, '6').reasons));

  // 全部解决 → pass
  r = GATE.evaluateReleaseGate({
    manifest: { schema_version: 2, intent: declaredIntent },
    timeline: { fps: 24, clips: [ovfClip({ dialogue: { take_id: 'tts-001', dialogue_ms: 1000, measured: true, text: '你好' }, overflow: { strategy: 'none', overflow_frames: 0 } })] },
  });
  assert.strictEqual(gateItem(r, '6').status, 'pass', JSON.stringify(gateItem(r, '6')));

  // 未声明 dialogue 但 manifest 有对白 → fail
  r = GATE.evaluateReleaseGate({
    manifest: {
      schema_version: 2,
      intent: { dialogue: false, audio: 'music_sfx', subtitles: 'burn', silent: false },
      shots: [{ id: 's01', dialogue_text: '你好', takes: [{ id: 'take-001' }] }],
    },
    timeline: { fps: 24, clips: [ovfClip()] },
  });
  assert.strictEqual(gateItem(r, '6').status, 'fail');
  assert.ok(gateItem(r, '6').reasons.some(x => /s01/.test(x) && /dialogue_text/.test(x)), JSON.stringify(gateItem(r, '6').reasons));

  // v1 → not_applicable
  r = GATE.evaluateReleaseGate({ manifest: { schema_version: 1, intent: declaredIntent }, timeline: { fps: 24, clips: [ovfClip()] } });
  assert.strictEqual(gateItem(r, '6').status, 'not_applicable');

  // 无 timeline → fail + build-timeline 提示
  r = GATE.evaluateReleaseGate({ manifest: { schema_version: 2, intent: declaredIntent }, timeline: null });
  assert.strictEqual(gateItem(r, '6').status, 'fail');
  assert.ok(/build-timeline/.test(gateItem(r, '6').reasons.join(' ')), JSON.stringify(gateItem(r, '6').reasons));

  // requires_audio=false(audio:none)→ collectUnresolvedOverflow 返回 []
  assert.deepStrictEqual(collectUnresolvedOverflow({ fps: 24, clips: [ovfClip({ dialogue: { take_id: 't', dialogue_ms: 99999, measured: true, text: 'x' } })] }, { intent: { dialogue: true, audio: 'none', subtitles: 'burn', silent: false } }), []);
});

test('OVF6b. collectUnresolvedOverflow 问题分类:measured=false/未落地溢出/spill_in 下游有对白/无下一个 clip', () => {
  const intent = { dialogue: true, audio: 'dialogue', subtitles: 'burn', silent: false };

  // measured:false
  let ps = collectUnresolvedOverflow({ fps: 24, clips: [ovfClip({ dialogue: { take_id: null, dialogue_ms: null, measured: false, text: 'x' } })] }, { intent });
  assert.ok(ps.some(p => /measured=false/.test(p)), JSON.stringify(ps));

  // 未落地溢出(无 pad/trim/spill)
  ps = collectUnresolvedOverflow({ fps: 24, clips: [ovfClip({ dialogue: { take_id: 't', dialogue_ms: 1500, measured: true, text: 'x' } })] }, { intent });
  assert.ok(ps.some(p => /unresolved/.test(p)), JSON.stringify(ps));

  // pad 已落地 → 输出覆盖对白 → 无问题
  ps = collectUnresolvedOverflow({ fps: 24, clips: [ovfClip({ padding_frames: 12, output_end: 36, dialogue: { take_id: 't', dialogue_ms: 1500, measured: true, text: 'x' } })] }, { intent });
  assert.deepStrictEqual(ps, []);

  // spill_in 但下游非空 dialogue → problem
  ps = collectUnresolvedOverflow({
    fps: 24,
    clips: [
      ovfClip({ dialogue: { take_id: 'tts-009', dialogue_ms: 500, measured: true, text: 'y' }, spill_in: [{ dialogue: 'tts-001', take_id: 'tts-001', ms: 500 }], output_start: 24, output_end: 48 }),
    ],
  }, { intent });
  assert.ok(ps.some(p => /spill_in present/.test(p)), JSON.stringify(ps));

  // dialogue_spill 但无下一个 clip → problem
  ps = collectUnresolvedOverflow({ fps: 24, clips: [ovfClip({ dialogue_spill_ms: 500, dialogue: { take_id: 't', dialogue_ms: 1500, measured: true, text: 'x' } })] }, { intent });
  assert.ok(ps.some(p => /no next clip/.test(p)), JSON.stringify(ps));
});

// ---- OVF7: 回归/不漂移 ----

test('OVF7. 回归:v2 确定性;v1/v2 语义互不污染;生产 S01E01(v1)不新增字段', () => {
  const manifest = ovfManifest([
    ovfShot('s01', { text: '你好', ttsTakes: [ovfTtsTake('tts-001', 1.0)], selected: 'tts-001' }),
    ovfShot('s02', { ttsTakes: [] }),
  ]);
  const edit = ovfEdit([
    { shot_id: 's01', take_id: 'take-001', source_in: 0, source_out: 24 },
    { shot_id: 's02', take_id: 'take-001', source_in: 0, source_out: 12 },
  ]);
  assert.deepStrictEqual(buildTimeline({ edit, manifest }), buildTimeline({ edit, manifest }));
  assert.strictEqual(buildTimeline({ edit, manifest }).clips[1].dialogue, null);

  // 生产 episode(S01E01-pov, v1)manifest 不含 dialogue_text;核心不写盘
  const prodManifest = readJsonFile(path.join(ROOT, 'episodes', 'S01E01-pov', 'manifest.json'));
  assert.ok(!(prodManifest.shots || []).some(s => typeof s.dialogue_text === 'string' && s.dialogue_text.length > 0), 'v1 生产 manifest 不应出现 dialogue_text');
});

// ============================================================
console.log('\n[AUD] 音轨合成 / 两遍 loudnorm / Gate #10(PRD §3.4/§3.9,M5-AUD)');
// ============================================================

const AUD = require('../audio');

/** 用 ffmpeg lavfi 生成确定性音频夹具(wav) */
function genAudio(dir, name, lavfi, extraArgs = []) {
  const p = path.join(dir, name);
  const r = spawnSync(process.env.FFMPEG_BIN || 'ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', lavfi,
    '-ar', '48000', '-ac', '2', ...extraArgs, '-c:a', 'pcm_s16le', p,
  ], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`genAudio failed (${name}): ${r.stderr || r.stdout}`);
  return p;
}

function audManifest(shots) {
  return { schema_version: 2, fps: 24, shots };
}

// ---- AUD1: dialogueSegments ----

test('AUD1. dialogueSegments:无 trim/有 trim/spill;起点帧→毫秒;measured:false 警告不产段', () => {
  const ttsPath = path.join(mkTempDir(), 'tts-001.mp3');
  const manifest = audManifest([
    { id: 's01', tts_takes: [{ id: 'tts-001', status: 'selected', path: ttsPath }], selected_tts: 'tts-001' },
    { id: 's02', tts_takes: [] },
  ]);
  const timeline = {
    fps: 24,
    clips: [
      ovfClip({
        clip_id: 'clip-0001', shot_id: 's01', take_id: 'take-001', output_start: 0, output_end: 30,
        dialogue: { take_id: 'tts-001', dialogue_ms: 1200, measured: true, text: '你好' },
      }),
      ovfClip({
        clip_id: 'clip-0002', shot_id: 's02', take_id: 'take-001', output_start: 30, output_end: 60,
        dialogue: { take_id: null, dialogue_ms: null, measured: false, text: '喂' },
      }),
      ovfClip({
        clip_id: 'clip-0003', shot_id: 's01', take_id: 'take-001', output_start: 60, output_end: 90,
        trim: { dialogue_ms: 1200, keep_ms: 800, text_truncated: true },
        dialogue: { take_id: 'tts-001', dialogue_ms: 1200, measured: true, text: '你好' },
        dialogue_spill_ms: 300,
      }),
    ],
  };

  const { segments, warnings } = AUD.dialogueSegments({ manifest, timeline });
  assert.strictEqual(segments.length, 2, JSON.stringify(segments));

  const a = segments.find(s => s.clip_id === 'clip-0001');
  assert.strictEqual(a.shot_id, 's01');
  assert.strictEqual(a.take_id, 'tts-001');
  assert.strictEqual(a.src_path, ttsPath);
  assert.strictEqual(a.at_ms, 0);
  assert.strictEqual(a.keep_ms, 1200);
  assert.strictEqual(a.gain_db, 0);
  assert.strictEqual(a.spill_ms, undefined);

  const b = segments.find(s => s.clip_id === 'clip-0003');
  assert.strictEqual(b.at_ms, AUD.frameToMs(60, 24));
  assert.strictEqual(b.keep_ms, 800, 'trim.keep_ms 优先');
  assert.strictEqual(b.spill_ms, 300, 'spill 另记,不并入 keep_ms');

  assert.ok(warnings.some(w => /clip-0002/.test(w) && /measured/.test(w)), JSON.stringify(warnings));

  // frame→ms 取整规则写死:round(frame*1000/fps)
  assert.strictEqual(AUD.frameToMs(0, 24), 0);
  assert.strictEqual(AUD.frameToMs(1, 24), 42);
  assert.strictEqual(AUD.frameToMs(30, 24), 1250);
  assert.strictEqual(AUD.frameToMs(1, 30), 33);
});

// ---- AUD2: cuePlacements ----

test('AUD2. cuePlacements:clip 内 sfx 帧号→绝对毫秒/music/src 解析/缺失分类/越界 error', () => {
  const dir = mkTempDir();
  fs.mkdirSync(path.join(dir, 'audio', 'sfx'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'audio', 'music'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'audio', 'sfx', 'hit.mp3'), 'x');
  fs.writeFileSync(path.join(dir, 'audio', 'music', 'theme.wav'), 'x');

  const timeline = {
    fps: 24,
    cues: [{ id: 'theme', at: 48, gain_db: -6 }, { id: 'm2', at_ms: 1500, gain_db: -3 }],
    clips: [ovfClip({ clip_id: 'clip-0001', output_start: 24, output_end: 48, sfx: [{ id: 'hit', at: 6, gain_db: -3 }] })],
  };
  const r = AUD.cuePlacements({ timeline, epDir: dir });
  assert.deepStrictEqual(r.errors, []);

  const sfx = r.segments.find(s => s.id === 'hit');
  assert.strictEqual(sfx.kind, 'sfx');
  assert.strictEqual(sfx.at_ms, 1250, 'clip.output_start(24)+at(6) @24fps = 1250ms');
  assert.strictEqual(sfx.gain_db, -3);
  assert.strictEqual(sfx.src_path, path.join(dir, 'audio', 'sfx', 'hit.mp3'));

  const music = r.segments.find(s => s.id === 'theme');
  assert.strictEqual(music.kind, 'music');
  assert.strictEqual(music.at_ms, 2000, '全局帧号 48 @24fps = 2000ms');
  assert.strictEqual(music.src_path, path.join(dir, 'audio', 'music', 'theme.wav'));

  const m2 = r.segments.find(s => s.id === 'm2');
  assert.strictEqual(m2.at_ms, 1500, 'at_ms 回退');
  assert.strictEqual(m2.src_path, null, 'audio/music/m2.* 不存在');
  assert.ok(r.warnings.some(w => /m2/.test(w)), JSON.stringify(r.warnings));

  // strict → 缺失转 error
  const strict = AUD.cuePlacements({ timeline, epDir: dir, strict: true });
  assert.ok(strict.errors.some(e => /m2/.test(e)), JSON.stringify(strict.errors));

  // 结构性坏 cue → error(即使 preview)
  const bad = AUD.cuePlacements({ timeline: { fps: 24, clips: [], cues: [{ gain_db: 0 }] }, epDir: dir });
  assert.ok(bad.errors.some(e => /id/.test(e)), JSON.stringify(bad.errors));

  // 越界(无 spill)→ planProgram error
  const plan = AUD.planProgram({
    manifest: audManifest([]),
    timeline: { fps: 24, clips: [ovfClip({ clip_id: 'clip-0001', output_start: 0, output_end: 24 })], cues: [{ id: 'theme', at: 48 }] },
    epDir: dir,
    strict: false,
  });
  assert.strictEqual(plan.duration_ms, 1000);
  assert.ok(plan.errors.some(e => /exceeds program duration/.test(e)), JSON.stringify(plan.errors));
});

// ---- AUD3: loudnorm 纯函数 ----

test('AUD3. parseLoudnormJson/loudnormArgs/verifyLoudness 纯函数与边界', () => {
  const raw = '[Parsed_loudnorm_0 @ 0x1]\n{\n"input_i" : "-14.02",\n"input_tp" : "-1.5",\n' +
    '"input_lra" : "0.00",\n"input_thresh" : "-24.30",\n"output_i" : "-14.00",\n"target_offset" : "0.01"\n}\nsize=N/A';
  const parsed = AUD.parseLoudnormJson(raw);
  assert.deepStrictEqual(parsed, { input_i: -14.02, input_tp: -1.5, input_lra: 0, input_thresh: -24.3, target_offset: 0.01 });
  throws(() => AUD.parseLoudnormJson('no json here'), 'not found');
  throws(() => AUD.parseLoudnormJson('{ not json }'), 'parse failed');
  throws(() => AUD.parseLoudnormJson('{"input_i":"-14"}'), 'missing field');
  throws(() => AUD.parseLoudnormJson('{"input_i":"abc","input_tp":"-1","input_lra":"0","input_thresh":"-1","target_offset":"0"}'), 'not a number');

  // 第一遍:分析
  const first = AUD.loudnormArgs({ input: '/tmp/in.wav' });
  const firstAf = first[first.indexOf('-af') + 1];
  assert.ok(/loudnorm=I=-14:TP=-1:LRA=11/.test(firstAf), firstAf);
  assert.ok(/print_format=json/.test(firstAf), firstAf);
  assert.deepStrictEqual(first.slice(-3), ['-f', 'null', '-']);
  throws(() => AUD.loudnormArgs({ input: '/tmp/in.wav', output: '/tmp/out.wav' }), 'first pass');

  // 第二遍:应用 + 编码
  const measured = { input_i: -24, input_tp: -3, input_lra: 6, input_thresh: -34, target_offset: 0.5 };
  const second = AUD.loudnormArgs({ input: '/tmp/in.wav', output: '/tmp/out.m4a', measured });
  const af = second[second.indexOf('-af') + 1];
  assert.ok(/measured_I=-24/.test(af) && /measured_TP=-3/.test(af) && /measured_LRA=6/.test(af), af);
  assert.ok(/measured_thresh=-34/.test(af) && /offset=0.5/.test(af) && /linear=true/.test(af), af);
  assert.ok(second.includes('48000') && second.includes('2'));
  assert.ok(second.includes('aac') && second.includes('192k'));
  assert.strictEqual(second[second.length - 1], '/tmp/out.m4a');
  throws(() => AUD.loudnormArgs({ input: '/tmp/in.wav', measured }), 'requires an output');

  // verifyLoudness:边界
  assert.strictEqual(AUD.verifyLoudness({ measured: { input_i: -14, input_tp: -1.5 } }).ok, true);
  assert.strictEqual(AUD.verifyLoudness({ measured: { input_i: -15, input_tp: -1 } }).ok, true, '|−15+14| = 1 恰好达标');
  assert.strictEqual(AUD.verifyLoudness({ measured: { input_i: -13, input_tp: -1 } }).ok, true);
  assert.strictEqual(AUD.verifyLoudness({ measured: { input_i: -15.5, input_tp: -1.5 } }).ok, false);
  assert.strictEqual(AUD.verifyLoudness({ measured: { input_i: -12.5, input_tp: -1.5 } }).ok, false);
  assert.strictEqual(AUD.verifyLoudness({ measured: { input_i: -14, input_tp: -0.8 } }).ok, false, 'TP≤-1');
  const v = AUD.verifyLoudness({ measured: { input_i: -15.5, input_tp: -0.8 } });
  assert.strictEqual(v.problems.length, 2, JSON.stringify(v.problems));
});

// ---- AUD4: analyzeLoudness(真实 ffmpeg) ----

testFfmpeg('AUD4. analyzeLoudness:正弦 440Hz 字段齐全;超响信号 fail、达标信号 pass', () => {
  const dir = mkTempDir();
  const hot = genAudio(dir, 'hot.wav', 'sine=frequency=440:sample_rate=48000:duration=3');
  const m = AUD.analyzeLoudness(hot);
  for (const k of ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset']) {
    assert.ok(Number.isFinite(m[k]), `${k} must be a finite number, got ${JSON.stringify(m[k])}`);
  }
  assert.strictEqual(AUD.verifyLoudness({ measured: m }).ok, false, 'full-scale sine is far from -14 LUFS');

  // 用 volume 抬到 ≈ -14 LUFS(input_i ≈ -14.05 实测)→ 达标
  const target = genAudio(dir, 'target.wav', 'sine=frequency=440:sample_rate=48000:duration=3', ['-af', 'volume=7.75dB']);
  const m2 = AUD.analyzeLoudness(target);
  assert.strictEqual(AUD.verifyLoudness({ measured: m2 }).ok, true, JSON.stringify(m2));

  throws(() => AUD.analyzeLoudness(path.join(dir, 'does-not-exist.wav')), 'not found');
});

// ---- AUD5: buildProgramAudio 端到端(真实 ffmpeg) ----

testFfmpeg('AUD5. buildProgramAudio:时长/响度/AAC 48k stereo;spill 不改长度;缺 sfx + strict 抛错且无输出', () => {
  const dir = mkTempDir();
  const tts = genAudio(dir, 's01-tts-001.wav', 'sine=frequency=440:sample_rate=48000:duration=1.2');
  const manifest = audManifest([
    { id: 's01', tts_takes: [{ id: 'tts-001', status: 'selected', path: tts, duration_sec: 1.2 }], selected_tts: 'tts-001' },
    { id: 's02', tts_takes: [] },
  ]);
  const mkTl = () => ({
    fps: 24,
    clips: [
      ovfClip({
        clip_id: 'clip-0001', shot_id: 's01', take_id: 'take-001', source_in: 0, source_out: 24,
        output_start: 0, output_end: 24,
        dialogue: { take_id: 'tts-001', dialogue_ms: 1200, measured: true, text: '你好世界' },
      }),
      ovfClip({
        clip_id: 'clip-0002', shot_id: 's02', take_id: 'take-001', source_in: 0, source_out: 24,
        output_start: 24, output_end: 48,
      }),
    ],
  });

  const out = path.join(dir, 'audio', 'program.m4a');
  const r = AUD.buildProgramAudio({ manifest, timeline: mkTl(), epDir: dir, outPath: out });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.duration_ms, 2000);
  assert.strictEqual(AUD.programDurationMs(mkTl()), 2000);
  assert.ok(fs.existsSync(out));
  assert.strictEqual(AUD.verifyLoudness({ measured: r.measured }).ok, true, JSON.stringify(r.measured));

  const p = probeMedia(out);
  assert.ok(p.audio, 'program must have an audio stream');
  assert.strictEqual(p.audio.codec, 'aac');
  assert.strictEqual(p.audio.sample_rate, 48000);
  assert.strictEqual(p.audio.channels, 2);
  assert.ok(Math.abs(p.format.duration - 2) < 0.1, `duration ${p.format.duration} ≈ 2s`);

  // spill:clip1 对白跨入 clip2,program 长度不变
  const spillTl = mkTl();
  spillTl.clips[0].dialogue_spill_ms = 200;
  const spillOut = path.join(dir, 'audio', 'spill.m4a');
  const r2 = AUD.buildProgramAudio({ manifest, timeline: spillTl, epDir: dir, outPath: spillOut });
  assert.strictEqual(r2.duration_ms, 2000, 'spill 只动音频,不改 program 时长');
  const p2 = probeMedia(spillOut);
  assert.ok(Math.abs(p2.format.duration - 2) < 0.1, `spill duration ${p2.format.duration} ≈ 2s`);

  // 缺 sfx 源 + strict → 抛错且不留输出
  const badDir = mkTempDir();
  const badTl = mkTl();
  badTl.clips[0].sfx = [{ id: 'ghost', at: 3, gain_db: 0 }];
  const badOut = path.join(badDir, 'audio', 'program.m4a');
  throws(() => AUD.buildProgramAudio({ manifest, timeline: badTl, epDir: badDir, outPath: badOut, opts: { strict: true } }), 'source missing');
  assert.ok(!fs.existsSync(badOut), 'strict 缺源不得留半成品');

  // 同一 timeline 非 strict → 跳过缺失 cue 仍出片(留 WARN)
  const soft = AUD.buildProgramAudio({ manifest, timeline: badTl, epDir: badDir, outPath: path.join(badDir, 'audio', 'soft.m4a'), opts: { strict: false } });
  assert.strictEqual(soft.ok, true);
  assert.ok(soft.warnings.some(w => /ghost/.test(w)), JSON.stringify(soft.warnings));
});

// ---- AUD6: Gate #10 接线 ----

test('AUD6. Gate #10:silent/audio none/opts.loudness 达标与不达标/无来源 fail/注入 analyzeLoudness/offline external', () => {
  const mk = (intent) => ({ schema_version: 2, ratio: '16:9', resolution: '720p', fps: 30, intent });
  const active = { dialogue: false, audio: 'music_sfx', subtitles: 'none', silent: false };

  let r = GATE.evaluateReleaseGate({ manifest: mk({ dialogue: false, audio: 'music_sfx', subtitles: 'none', silent: true }), timeline: GATE_EMPTY_TIMELINE });
  assert.strictEqual(gateItem(r, '10').status, 'pass');
  assert.ok(gateItem(r, '10').notes.join(' ').includes('loudnorm: skipped'), JSON.stringify(gateItem(r, '10').notes));

  r = GATE.evaluateReleaseGate({ manifest: mk({ dialogue: false, audio: 'none', subtitles: 'none', silent: false }), timeline: GATE_EMPTY_TIMELINE });
  assert.strictEqual(gateItem(r, '10').status, 'not_applicable');

  r = GATE.evaluateReleaseGate({ manifest: mk(active), timeline: GATE_EMPTY_TIMELINE, opts: { loudness: { input_i: -14, input_tp: -1.2 } } });
  assert.strictEqual(gateItem(r, '10').status, 'pass', JSON.stringify(gateItem(r, '10').reasons));

  r = GATE.evaluateReleaseGate({ manifest: mk(active), timeline: GATE_EMPTY_TIMELINE, opts: { loudness: { input_i: -15.5, input_tp: -0.8 } } });
  assert.strictEqual(gateItem(r, '10').status, 'fail');
  assert.strictEqual(gateItem(r, '10').reasons.length, 2, JSON.stringify(gateItem(r, '10').reasons));

  // 无来源 → fail + 提示
  r = GATE.evaluateReleaseGate({ manifest: mk(active), timeline: GATE_EMPTY_TIMELINE });
  assert.strictEqual(gateItem(r, '10').status, 'fail');
  assert.ok(/opts\.loudness/.test(gateItem(r, '10').reasons.join(' ')) && /--final/.test(gateItem(r, '10').reasons.join(' ')), JSON.stringify(gateItem(r, '10').reasons));

  // 注入 analyzeLoudness(有 finalPath)→ 走通
  let calls = 0;
  const mediaResult = {
    ok: true,
    probe: {
      video: { codec: 'h264', width: 1280, height: 720, fps: 30, pix_fmt: 'yuv420p', duration: 8 },
      audio: { codec: 'aac', sample_rate: 48000, channels: 2, duration: 8 },
      format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: 8 },
    },
    steps: { probe: { ok: true }, spec: { ok: true }, decode: { ok: true }, av_length: { ok: true } },
    problems: [],
  };
  r = GATE.evaluateReleaseGate({
    manifest: mk(active), timeline: GATE_EMPTY_TIMELINE, finalPath: '/tmp/aud6-final.mp4', mediaResult,
    opts: { analyzeLoudness: () => { calls += 1; return { input_i: -14, input_tp: -2, input_lra: 0, input_thresh: -24, target_offset: 0 }; } },
  });
  assert.strictEqual(gateItem(r, '10').status, 'pass', JSON.stringify(gateItem(r, '10').reasons));
  assert.strictEqual(calls, 1);

  // 注入 analyzeLoudness 抛错 → fail
  r = GATE.evaluateReleaseGate({
    manifest: mk(active), timeline: GATE_EMPTY_TIMELINE, finalPath: '/tmp/aud6-final.mp4', mediaResult,
    opts: { analyzeLoudness: () => { throw new Error('boom'); } },
  });
  assert.strictEqual(gateItem(r, '10').status, 'fail');
  assert.ok(/analysis failed/.test(gateItem(r, '10').reasons.join(' ')), JSON.stringify(gateItem(r, '10').reasons));

  // offline phase → external(不阻塞 stitch 前检查)
  r = GATE.evaluateReleaseGate({ manifest: mk(active), timeline: GATE_EMPTY_TIMELINE, opts: { phase: 'offline' } });
  assert.strictEqual(gateItem(r, '10').status, 'external');

  // v1 → N/A
  r = GATE.evaluateReleaseGate({ manifest: { schema_version: 1, intent: active }, timeline: GATE_EMPTY_TIMELINE });
  assert.strictEqual(gateItem(r, '10').status, 'not_applicable');
});

// ---- AUD7: build-timeline 落位 cues/sfx ----

test('AUD7. build-timeline 落位 clip.sfx 与 timeline.cues(供 audio.js 消费);缺省不漂移;非法 sfx 报错', () => {
  const manifest = ovfManifest([ovfShot('s01', { ttsTakes: [ovfTtsTake('tts-001', 1.0)], selected: 'tts-001' })]);
  const tl = buildTimeline({
    edit: ovfEdit([
      { shot_id: 's01', take_id: 'take-001', source_in: 0, source_out: 24, sfx: [{ id: 'hit', at: 4, gain_db: -3 }] },
    ], { cues: [{ id: 'theme', at: 48 }] }),
    manifest,
  });
  assert.deepStrictEqual(tl.clips[0].sfx, [{ id: 'hit', at: 4, gain_db: -3 }]);
  assert.deepStrictEqual(tl.cues, [{ id: 'theme', at: 48 }]);

  // 缺省不新增字段(既有 fixture/生产集不漂移)
  const tlPlain = buildTimeline({ edit: ovfEdit([{ shot_id: 's01', take_id: 'take-001', source_in: 0, source_out: 24 }]), manifest });
  assert.ok(!Object.prototype.hasOwnProperty.call(tlPlain.clips[0], 'sfx'));
  assert.ok(!Object.prototype.hasOwnProperty.call(tlPlain, 'cues'));

  throws(() => buildTimeline({
    edit: ovfEdit([{ shot_id: 's01', take_id: 'take-001', source_in: 0, source_out: 24, sfx: [{ id: 'hit', at: -1 }] }]),
    manifest,
  }), 'at');
  throws(() => buildTimeline({ edit: ovfEdit([{ shot_id: 's01', take_id: 'take-001', source_in: 0, source_out: 24 }], { cues: [{ at: -1 }] }), manifest }), 'at');
  // 遗留无 id 的 cue 透传(不阻断 build;audio.js 混音时拒绝)
  const tlLegacy = buildTimeline({ edit: ovfEdit([{ shot_id: 's01', take_id: 'take-001', source_in: 0, source_out: 24 }], { cues: [{ at: 1 }] }), manifest });
  assert.deepStrictEqual(tlLegacy.cues, [{ at: 1 }]);
});

// ---- AUD8: CLI 端到端 ----

testFfmpeg('AUD8. CLI:默认 timeline/输出;--json 退出 0 且规格达标;缺 timeline → 非零', () => {
  const dir = mkTempDir();
  const tts = genAudio(dir, 's01-tts-001.wav', 'sine=frequency=440:sample_rate=48000:duration=1.0');
  const manifest = ovfManifest([
    { id: 's01', takes: [{ id: 'take-001' }], tts_takes: [{ id: 'tts-001', status: 'selected', path: tts, duration_sec: 1.0 }], selected_tts: 'tts-001' },
    { id: 's02', takes: [{ id: 'take-001' }], tts_takes: [] },
  ]);
  writeManifest(dir, manifest);
  const tl = buildTimeline({
    edit: { timeline: { fps: 24, clips: [
      { shot_id: 's01', take_id: 'take-001', source_in: 0, source_out: 24, sfx: [{ id: 'hit', at: 3, gain_db: -6 }] },
      { shot_id: 's02', take_id: 'take-001', source_in: 0, source_out: 24 },
    ] } },
    manifest,
  });
  fs.mkdirSync(path.join(dir, 'audio', 'sfx'), { recursive: true });
  const hit = genAudio(path.join(dir, 'audio', 'sfx'), 'hit.wav', 'sine=frequency=900:sample_rate=48000:duration=0.2');
  assert.ok(fs.existsSync(hit));
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(tl, null, 2));

  const cli = path.join(ROOT, 'tools', 'audio.js');
  const r = spawnSync(process.execPath, [cli, dir, '--json'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.strictEqual(parsed.duration_ms, 2000);
  assert.strictEqual(parsed.outPath, path.join(dir, 'audio', 'program.m4a'));
  assert.ok(fs.existsSync(parsed.outPath));
  assert.strictEqual(AUD.verifyLoudness({ measured: parsed.measured }).ok, true, JSON.stringify(parsed.measured));
  const p = probeMedia(parsed.outPath);
  assert.strictEqual(p.audio.codec, 'aac');
  assert.strictEqual(p.audio.sample_rate, 48000);
  assert.strictEqual(p.audio.channels, 2);

  // 缺 timeline → 非零退出
  const dir2 = mkTempDir();
  writeManifest(dir2, ovfManifest([]));
  const r2 = spawnSync(process.execPath, [cli, dir2], { encoding: 'utf8' });
  assert.notStrictEqual(r2.status, 0, `${r2.stdout}${r2.stderr}`);
  assert.ok(/timeline\.json not found/.test(r2.stderr), r2.stderr);
  assert.ok(!fs.existsSync(path.join(dir2, 'audio', 'program.m4a')));
});

// ============================================================
console.log('\n[SUB] 字幕产物 + 封面帧提取(PRD §4/§5 #7/#11,M5-SUB)');
// ============================================================

// ---- SUB 夹具 ----

/** 生成确定性的两帧视频:frame 0 = 红, frame 1 = 蓝(geq 按帧号 N 着色) */
function subColorFramesVideo(dir, name, { fps = 24 } = {}) {
  const p = path.join(dir, name);
  const r = spawnSync(process.env.FFMPEG_BIN || 'ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=black:s=32x32:r=${fps}:d=1`,
    '-vf', `geq=r='if(eq(N,0),255,0)':g='if(eq(N,0),0,0)':b='if(eq(N,1),255,0)'`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', p,
  ], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`subColorFramesVideo failed: ${r.stderr || r.stdout}`);
  return p;
}

/** 用 ffmpeg 把一张图缩到 1×1 并读回 RGB(用于断言抽到的帧色) */
function readPixelRgb(file) {
  const r = spawnSync(process.env.FFMPEG_BIN || 'ffmpeg', [
    '-v', 'error', '-i', file, '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ]);
  if (r.status !== 0 || !r.stdout || r.stdout.length < 3) {
    throw new Error(`readPixelRgb failed: ${String(r.stderr || '')}`);
  }
  return [r.stdout[0], r.stdout[1], r.stdout[2]];
}

function ffprobeStreams(file) {
  const bin = process.env.FFPROBE_BIN || 'ffprobe';
  const r = spawnSync(bin, ['-v', 'error', '-show_streams', '-of', 'json', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffprobe failed: ${r.stderr || r.stdout}`);
  return (JSON.parse(r.stdout).streams) || [];
}

/** ffmpeg 是否编入某 filter(仅 ffmpeg 可用时才探测) */
function ffmpegHasFilter(name) {
  if (!HAS_FFMPEG) return false;
  const r = spawnSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' });
  if (r.status !== 0) return false;
  return new RegExp(`(^|\\s)${name}(\\s|$)`, 'm').test(r.stdout);
}
const HAS_SUBTITLES_FILTER = ffmpegHasFilter('subtitles');

// ---- SUB1: subtitleCues ----

test('SUB1. subtitleCues:实测→cue/trim/spill/measured:false/越界/重叠/空文本;帧→ms 量化口径', () => {
  const tl = { fps: 24, clips: [
    ovfClip({ clip_id: 'c1', output_start: 0, output_end: 24, dialogue: { take_id: 't1', dialogue_ms: 1000, measured: true, text: '第一句' } }),
    ovfClip({ clip_id: 'c2', output_start: 24, output_end: 48, trim: { dialogue_ms: 1200, keep_ms: 800 }, dialogue_spill_ms: 400,
      dialogue: { take_id: 't2', dialogue_ms: 1200, measured: true, text: '第二句' } }),
    ovfClip({ clip_id: 'c3', output_start: 48, output_end: 72, dialogue: { take_id: null, dialogue_ms: null, measured: false, text: '未实测' } }),
  ] };
  const r = SUB.subtitleCues({ timeline: tl, finalDurationMs: 3000 });
  assert.strictEqual(r.cues.length, 2, JSON.stringify(r.cues));
  assert.deepStrictEqual(r.cues[0], { index: 1, start_ms: 0, end_ms: 1000, text: '第一句', clip_id: 'c1', take_id: 't1' });
  // dur = trim.keep_ms(800) + spill(400) = 1200ms → round(1200/1000*24)=29 帧; start 24 → end 53 帧
  assert.strictEqual(r.cues[1].start_ms, 1000);
  assert.strictEqual(r.cues[1].end_ms, 2208, 'round(53*1000/24)');
  assert.ok(r.cues[1].end_ms > r.cues[1].start_ms + 800, 'spill 延伸字幕(超过 keep_ms)');
  assert.deepStrictEqual(r.problems, []);
  assert.ok(r.warnings.some(w => /c3/.test(w) && /measured/.test(w)), JSON.stringify(r.warnings));

  // 帧→ms 量化口径:round(frame*1000/fps)
  const r30 = SUB.subtitleCues({ timeline: { fps: 30, clips: [
    ovfClip({ output_start: 1, output_end: 2, dialogue: { take_id: 't', dialogue_ms: 100, measured: true, text: 'x' } }),
  ] } });
  assert.strictEqual(r30.cues[0].start_ms, 33, 'round(1*1000/30)');
  assert.strictEqual(SUB.frameToMs(1, 30), 33);
  assert.strictEqual(SUB.frameToMs(0, 24), 0);

  // 越界
  const out = SUB.subtitleCues({ timeline: { fps: 24, clips: [
    ovfClip({ output_start: 0, output_end: 24, dialogue: { take_id: 't', dialogue_ms: 2000, measured: true, text: 'x' } }),
  ] }, finalDurationMs: 1000 });
  assert.ok(out.problems.some(p => /outside/.test(p)), JSON.stringify(out.problems));

  // 重叠
  const ov = SUB.subtitleCues({ timeline: { fps: 24, clips: [
    ovfClip({ clip_id: 'a', output_start: 0, output_end: 24, dialogue: { take_id: 't', dialogue_ms: 2000, measured: true, text: 'a' } }),
    ovfClip({ clip_id: 'b', output_start: 24, output_end: 48, dialogue: { take_id: 't', dialogue_ms: 200, measured: true, text: 'b' } }),
  ] }, finalDurationMs: 5000 });
  assert.ok(ov.problems.some(p => /overlap/.test(p)), JSON.stringify(ov.problems));

  // 空文本
  const empty = SUB.subtitleCues({ timeline: { fps: 24, clips: [
    ovfClip({ output_start: 0, output_end: 24, dialogue: { take_id: 't', dialogue_ms: 500, measured: true, text: '   ' } }),
  ] }, finalDurationMs: 1000 });
  assert.ok(empty.problems.some(p => /empty/.test(p)), JSON.stringify(empty.problems));

  throws(() => SUB.subtitleCues({ timeline: { fps: 0, clips: [] } }), 'fps');
});

// ---- SUB2: wrapCueText ----

test('SUB2. wrapCueText:竖屏 15 字/横屏 22 字、中文标点优先、行首无标点、超长硬切、空文本', () => {
  const long = '一二三四五六七八九十一二三四五六七八九十'; // 20 字,无标点
  assert.deepStrictEqual(SUB.wrapCueText(long, { ratio: '9:16' }), ['一二三四五六七八九十一二三四五', '六七八九十']);
  assert.ok(SUB.wrapCueText(long, { ratio: '9:16' }).every(l => l.length <= 15));
  assert.deepStrictEqual(SUB.wrapCueText(long, { ratio: '16:9' }), [long], '横屏 ≤22 字不换行');

  // 中文标点优先断行(窗口内最后一个标点之后)
  const punct = '一二三四五六七八九十，十一十二十三十四十五';
  assert.deepStrictEqual(SUB.wrapCueText(punct, { ratio: '9:16' }), ['一二三四五六七八九十，', '十一十二十三十四十五']);

  // 硬切落在标点前 → 标点并入本行,不以标点起行
  const hardPunct = '一二三四五六七八九十一二三四五，六';
  const hp = SUB.wrapCueText(hardPunct, { ratio: '9:16' });
  assert.deepStrictEqual(hp, ['一二三四五六七八九十一二三四五，', '六']);
  assert.ok(hp.every(l => !SUB.BREAK_PUNCTUATION.has(l[0])), JSON.stringify(hp));

  // 空格/标签边界
  const spaced = 'aaaa bbbb cccc dddd eeee';
  const sp = SUB.wrapCueText(spaced, { ratio: '9:16' });
  assert.ok(sp.length >= 2 && sp.every(l => l.length <= 15 && l.trim() === l), JSON.stringify(sp));
  assert.deepStrictEqual(SUB.wrapCueText('<i>hello</i> world', { ratio: '9:16' }), ['<i>hello</i>', 'world'], '标签边界断行');
  assert.deepStrictEqual(SUB.wrapCueText('<i>hello</i> world', { ratio: '16:9' }), ['<i>hello</i> world']);

  // 空文本
  assert.deepStrictEqual(SUB.wrapCueText(''), []);
  assert.deepStrictEqual(SUB.wrapCueText('   '), []);
  assert.deepStrictEqual(SUB.wrapCueText('\n\n'), []);
  throws(() => SUB.wrapCueText(123), 'string');
});

// ---- SUB3: formatSrt / checkCueAlignment ----

test('SUB3. formatSrt/checkCueAlignment:HH:MM:SS,mmm 与边界(0/1h+);非帧对齐问题提示', () => {
  const srt = SUB.formatSrt([
    { index: 1, start_ms: 0, end_ms: 1000, text: 'a\nb' },
    { index: 2, start_ms: 3661000, end_ms: 3662500, text: 'c' },
  ]);
  assert.ok(srt.startsWith('1\n00:00:00,000 --> 00:00:01,000\na\nb\n\n'), JSON.stringify(srt));
  assert.ok(srt.includes('01:01:01,000 --> 01:01:02,500'), JSON.stringify(srt));
  assert.ok(srt.endsWith('\n'));

  // 与 gate 已有的 parseSrtCues 往返一致(不重复实现解析)
  const cues = GATE.parseSrtCues(srt);
  assert.strictEqual(cues.length, 2);
  assert.strictEqual(cues[1].start, 3661);
  assert.strictEqual(cues[1].end, 3662.5);
  assert.strictEqual(SUB.msToSrtStamp(0), '00:00:00,000');
  assert.strictEqual(SUB.msToSrtStamp(3661000), '01:01:01,000');

  // 帧对齐(写死口径)
  assert.strictEqual(SUB.checkCueAlignment([{ index: 1, start_ms: 0, end_ms: 1000 }], { fps: 24 }).ok, true);
  const bad = SUB.checkCueAlignment([{ index: 1, start_ms: 0, end_ms: 1005 }], { fps: 24 });
  assert.strictEqual(bad.ok, false);
  assert.ok(/frame-aligned/.test(bad.problems.join(' ')) && /24/.test(bad.problems.join(' ')), bad.problems.join(' '));

  // subtitleCues 产物天然帧对齐
  const r = SUB.subtitleCues({ timeline: { fps: 24, clips: [
    ovfClip({ output_start: 24, output_end: 48, dialogue: { take_id: 't', dialogue_ms: 733, measured: true, text: 'x' } }),
  ] }, finalDurationMs: 2000 });
  assert.strictEqual(SUB.checkCueAlignment(r.cues, { fps: 24 }).ok, true, JSON.stringify(r.cues));
  throws(() => SUB.checkCueAlignment([], { fps: 0 }), 'fps');
});

// ---- SUB4: writeSrt + Gate #7 集成 ----

test('SUB4. writeSrt:原子写/默认 episode.srt/fail-closed;Gate #7 用该 srt + finalDuration 判 pass', () => {
  const dir = mkTempDir();
  const manifest = { schema_version: 2, intent: { dialogue: true, audio: 'dialogue', subtitles: 'burn', silent: false } };
  const timeline = { fps: 24, clips: [
    ovfClip({ clip_id: 'c1', output_start: 0, output_end: 24, dialogue: { take_id: 't1', dialogue_ms: 1000, measured: true, text: '第一句对白' } }),
    ovfClip({ clip_id: 'c2', output_start: 24, output_end: 48, dialogue: { take_id: 't2', dialogue_ms: 800, measured: true, text: '第二句对白' } }),
  ] };
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(timeline));

  const res = SUB.writeSrt({ epDir: dir, manifest, timeline, finalDurationMs: 2000 });
  assert.strictEqual(res.outPath, path.join(dir, 'episode.srt'));
  assert.ok(fs.existsSync(res.outPath));
  assert.strictEqual(res.cueCount, 2);
  assert.ok(!fs.readdirSync(dir).some(f => f.startsWith('.episode.srt')), 'no tmp residue');
  const parsed = GATE.parseSrtCues(fs.readFileSync(res.outPath, 'utf8'));
  assert.strictEqual(parsed.length, 2);
  assert.deepStrictEqual(
    SUB.checkCueAlignment(parsed.map(c => ({ index: c.index, start_ms: Math.round(c.start * 1000), end_ms: Math.round(c.end * 1000) })), { fps: 24 }).problems,
    []
  );

  // Gate #7 默认发现 <episode-dir>/episode.srt
  const g = GATE.collectGateReport(dir, manifest);
  assert.strictEqual(gateItem(g, '7').status, 'pass', JSON.stringify(gateItem(g, '7').reasons));

  // fail-closed:越界 / 空文本 → 抛错,不落半成品
  const bad = { fps: 24, clips: [ovfClip({ output_start: 0, output_end: 24, dialogue: { take_id: 't', dialogue_ms: 2000, measured: true, text: 'x' } })] };
  throws(() => SUB.writeSrt({ epDir: dir, manifest, timeline: bad, finalDurationMs: 1000 }), 'fail-closed');
  const bad2 = { fps: 24, clips: [ovfClip({ output_start: 0, output_end: 24, dialogue: { take_id: 't', dialogue_ms: 500, measured: true, text: '' } })] };
  throws(() => SUB.writeSrt({ epDir: dir, manifest, timeline: bad2, finalDurationMs: 1000 }), 'empty');
});

// ---- SUB5: burnSubtitles(ffmpeg 门控;burn/both 另需 libass subtitles filter) ----

testFfmpeg('SUB5. burnSubtitles:soft → mov_text 字慕流;burn 无字慕流且尺寸不变;both;失败清理半成品', () => {
  const dir = mkTempDir();
  const video = path.join(dir, 'v.mp4');
  let r0 = spawnSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:d=1:r=24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video], { encoding: 'utf8' });
  assert.strictEqual(r0.status, 0, r0.stderr);
  const srt = path.join(dir, 'a.srt');
  fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:00,500\nHello\n\n');

  // soft:mov_text 字慕流
  const soft = path.join(dir, 'soft.mp4');
  const rs = SUB.burnSubtitles({ input: video, srtPath: srt, output: soft, mode: 'soft' });
  assert.strictEqual(rs.ok, true);
  assert.ok(fs.existsSync(soft));
  const softStreams = ffprobeStreams(soft);
  assert.ok(softStreams.some(s => s.codec_type === 'subtitle' && s.codec_name === 'mov_text'), JSON.stringify(softStreams));
  const softArgs = SUB.softSubtitlesArgs({ input: video, srtPath: srt, output: soft });
  assert.ok(softArgs.includes('copy') && softArgs.includes('mov_text'));

  // 失败清理:输入缺失 → 抛错且不产半成品
  const nope = path.join(dir, 'nope.mp4');
  const half = path.join(dir, 'half.mp4');
  throws(() => SUB.burnSubtitles({ input: nope, srtPath: srt, output: half, mode: 'burn' }), 'input not found');
  assert.ok(!fs.existsSync(half));
  throws(() => SUB.burnSubtitles({ input: video, srtPath: srt, output: half, mode: 'bogus' }), 'mode');

  // burn/both 需 libass:无则只验参数构造(不 faill 套件)
  if (!HAS_SUBTITLES_FILTER) {
    console.log('    (burn/both skipped: ffmpeg lacks the subtitles filter / libass)');
    const args = SUB.burnSubtitlesArgs({ input: video, srtPath: srt, output: 'x.mp4', font: 'PingFang SC', videoHeight: 1920, ratio: '9:16' });
    assert.ok(args.join(' ').includes("subtitles=filename='") && args.join(' ').includes('MarginV=288'), args.join(' '));
    return;
  }

  const burned = path.join(dir, 'burned.mp4');
  SUB.burnSubtitles({ input: video, srtPath: srt, output: burned, mode: 'burn', font: 'DejaVu Sans', videoHeight: 240 });
  const bs = ffprobeStreams(burned);
  assert.ok(!bs.some(s => s.codec_type === 'subtitle'), 'burn 不产生字慕流');
  const v = bs.find(s => s.codec_type === 'video');
  assert.strictEqual(v.width, 320);
  assert.strictEqual(v.height, 240);

  const both = path.join(dir, 'both.mp4');
  SUB.burnSubtitles({ input: video, srtPath: srt, output: both, mode: 'both', videoHeight: 240 });
  const bss = ffprobeStreams(both);
  assert.ok(bss.some(s => s.codec_type === 'subtitle' && s.codec_name === 'mov_text'), JSON.stringify(bss));
});

testFfmpeg('SUB5c. hasSubtitlesFilter 探测;缺 libass 的 ffmpeg → 硬烧录给出可执行提示(mode=soft)', () => {
  const dir = mkTempDir();
  const fake = path.join(dir, 'ffmpeg-nolibass.sh');
  fs.writeFileSync(fake, '#!/bin/sh\necho "No such filter: \'subtitles\'" >&2\nexit 1\n', { mode: 0o755 });
  assert.strictEqual(SUB.hasSubtitlesFilter(fake), false, 'fake ffmpeg must report no subtitles filter');
  const video = path.join(dir, 'v.mp4');
  const r0 = spawnSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=0.2:r=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video], { encoding: 'utf8' });
  assert.strictEqual(r0.status, 0, r0.stderr);
  const srt = path.join(dir, 'a.srt');
  fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:00,100\nHi\n');
  let caught = null;
  try {
    SUB.burnSubtitles({ input: video, srtPath: srt, output: path.join(dir, 'b.mp4'), mode: 'burn', ffmpegBin: fake, videoHeight: 64, videoWidth: 64 });
  } catch (e) { caught = e; }
  assert.ok(caught, 'burn must fail when libass is missing');
  assert.strictEqual(caught.kind, 'missing_libass');
  assert.ok(/libass/.test(caught.message), caught.message);
  assert.ok(/mode=soft/.test(caught.message), caught.message);
  assert.ok(!fs.existsSync(path.join(dir, 'b.mp4')), 'failed burn must not leave a half-written output');
});

// ---- SUB6: generateCover(ffmpeg 门控) ----

testFfmpeg('SUB6. generateCover:keyframe/first_frame(source_in+deleted_head_frames)/promo_asset;缺失抛错', () => {
  const dir = mkTempDir();
  const kf = genImage(dir, 'kf.png', 'color=c=green:s=32x32');
  const twoFrame = subColorFramesVideo(dir, 'two.mp4', { fps: 24 }); // frame0 红 / frame1 蓝
  const promoJpg = genImage(dir, 'promo.jpg', 'color=c=0x0000ff:s=32x32');
  const clip = (over = {}) => Object.assign({
    clip_id: 'clip-0001', shot_id: 's01', take_id: 'take-001', source_in: 0, source_out: 24,
    deleted_head_frames: 1, padding_frames: 0, output_start: 0, output_end: 24,
  }, over);

  // 1a. keyframe 绑定 → keyframe 文件转 PNG
  const mKf = { fps: 24, cover: { clip_id: 'clip-0001' }, shots: [{ id: 's01',
    takes: [{ id: 'take-001', path: twoFrame, keyframe: { take_id: 'kf-001', content_digest: 'd' } }],
    keyframe_takes: [{ id: 'kf-001', path: kf }] }] };
  const outKf = path.join(dir, 'cover-kf.png');
  let g = generateCover({ manifest: mKf, timeline: { fps: 24, clips: [clip()] }, outPath: outKf });
  assert.strictEqual(g.ok, true);
  assert.strictEqual(g.kind, 'keyframe');
  assert.ok(fs.existsSync(outKf));
  let px = readPixelRgb(outKf);
  assert.ok(px[1] > 100 && px[1] > px[0] && px[1] > px[2], `keyframe should be green, got ${px}`);

  // 1b. 无 keyframe 绑定 → 实际首帧 = source_in(0) + deleted_head_frames(1) = frame 1 → 蓝色
  const mFf = { fps: 24, cover: { clip_id: 'clip-0001' }, shots: [{ id: 's01', takes: [{ id: 'take-001', path: twoFrame }], keyframe_takes: [] }] };
  const outFf = path.join(dir, 'cover-ff.png');
  g = generateCover({ manifest: mFf, timeline: { fps: 24, clips: [clip()] }, outPath: outFf });
  assert.strictEqual(g.kind, 'first_frame');
  assert.strictEqual(g.frame, 1);
  assert.ok(fs.existsSync(outFf));
  px = readPixelRgb(outFf);
  assert.ok(px[2] > 128 && px[2] > px[0] && px[2] > px[1], `frame 1 should be blue, got ${px}`);

  // 2. promo_asset(非 png → 转码为 png)
  const mPromo = { fps: 24, cover: { promo_asset: promoJpg }, shots: [] };
  const outPromo = path.join(dir, 'cover-promo.png');
  g = generateCover({ manifest: mPromo, timeline: { fps: 24, clips: [] }, outPath: outPromo });
  assert.strictEqual(g.kind, 'promo_asset');
  assert.ok(fs.existsSync(outPromo));
  px = readPixelRgb(outPromo);
  assert.ok(px[2] > 128 && px[2] > px[1], `promo should be blue, got ${px}`);

  // 3. 缺失 → 抛错且清理半成品
  const mMiss = { fps: 24, cover: { promo_asset: path.join(dir, 'no.png') }, shots: [] };
  const outMiss = path.join(dir, 'cover-miss.png');
  throws(() => generateCover({ manifest: mMiss, timeline: { fps: 24, clips: [] }, outPath: outMiss }), 'missing/unreadable');
  assert.ok(!fs.existsSync(outMiss));
  // 无 cover 配置 → 抛错
  throws(() => generateCover({ manifest: { fps: 24, shots: [] }, timeline: { fps: 24, clips: [] }, outPath: outMiss }), 'no cover configured');
});

// ---- SUB7: Gate #11 + opts.artifacts.cover ----

test('SUB7. Gate #11:opts.artifacts.cover 存在 pass/缺失 fail;不传保持现有(resolveCover)', () => {
  const dir = mkTempDir();
  const cover = path.join(dir, 'cover.png');
  fs.writeFileSync(cover, 'x');
  const manifest = { schema_version: 2 };

  let r = GATE.evaluateReleaseGate({ manifest, timeline: GATE_EMPTY_TIMELINE, artifacts: { cover } });
  assert.strictEqual(gateItem(r, '11').status, 'pass', JSON.stringify(gateItem(r, '11')));
  assert.ok(/cover artifact/.test(gateItem(r, '11').notes.join(' ')));

  r = GATE.evaluateReleaseGate({ manifest, timeline: GATE_EMPTY_TIMELINE, artifacts: { cover: path.join(dir, 'nope.png') } });
  assert.strictEqual(gateItem(r, '11').status, 'fail');
  assert.ok(/cover artifact not found/.test(gateItem(r, '11').reasons.join(' ')), JSON.stringify(gateItem(r, '11').reasons));

  // 不传 artifacts.cover → 保持现状(无 cover 配置 → fail)
  r = GATE.evaluateReleaseGate({ manifest, timeline: GATE_EMPTY_TIMELINE, artifacts: {} });
  assert.strictEqual(gateItem(r, '11').status, 'fail');
});

// ---- SUB8: 生产不漂移(只读) ----

test('SUB8. 生产不漂移:只读校验(不写生产目录/不改 manifest 字节)', () => {
  const epDir = path.join(ROOT, 'episodes', 'S01E01-pov');
  const manifestPath = path.join(epDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) { console.log('    (production fixture absent — skipped)'); return; }
  const before = fs.readFileSync(manifestPath);
  const srtBefore = fs.existsSync(path.join(epDir, 'episode.srt'));
  const coverBefore = fs.existsSync(path.join(epDir, 'cover.png'));
  const manifest = JSON.parse(before.toString('utf8'));

  // 纯函数只读:无 cover 配置 → 报错(不写盘);空 timeline → 不产 cue
  const rc = resolveCover(manifest, { fps: 24, clips: [] });
  assert.strictEqual(rc.ok, false);
  const cues = SUB.subtitleCues({ manifest, timeline: { fps: 24, clips: [] }, finalDurationMs: 0 });
  assert.deepStrictEqual(cues.cues, []);
  assert.deepStrictEqual(cues.problems, []);

  // 生产目录未被改写/新增
  assert.ok(before.equals(fs.readFileSync(manifestPath)), 'manifest.json must not change');
  assert.strictEqual(fs.existsSync(path.join(epDir, 'episode.srt')), srtBefore);
  assert.strictEqual(fs.existsSync(path.join(epDir, 'cover.png')), coverBefore);
});

// ============================================================
console.log('\n[FIN] v2 帧口径最终出片（M5-EDIT/D4）');
// ============================================================

const FIN_BASE_CLIP = {
  clip_id: 'c1', shot_id: 's01', take_id: 'take-001',
  source_in: 30, source_out: 60, deleted_head_frames: 0, padding_frames: 0,
};

// ---- FIN1: clipRenderArgs 纯函数 ----

test('FIN1. clipRenderArgs 纯函数:入点/删帧右移/-frames:v/tpad/确定性参数/CFR 链', () => {
  const argv = finClipRenderArgs({ clip: FIN_BASE_CLIP, takePath: '/in.mp4', fps: 30, width: 240, height: 240, srcDurationFrames: 90, outPath: '/out.mp4' });
  assert.ok(Array.isArray(argv));
  assert.strictEqual(argv[argv.length - 1], '/out.mp4');
  // 入点 = source_in/fps
  assert.strictEqual(Number(argv[argv.indexOf('-ss') + 1]), 1, 'base in-point must be source_in/fps');
  assert.strictEqual(argv[argv.indexOf('-frames:v') + 1], '30');
  const vf = argv[argv.indexOf('-vf') + 1];
  assert.ok(/^scale=240:240:force_original_aspect_ratio=decrease,pad=240:240:\(ow-iw\)\/2:\(oh-ih\)\/2:black,fps=30,format=yuv420p$/.test(vf), vf);
  assert.ok(!/tpad/.test(vf));
  for (const flag of ['-fflags', '+bitexact', '-flags', '-map_metadata', '-threads']) assert.ok(argv.includes(flag), `missing ${flag}`);
  assert.strictEqual(argv[argv.indexOf('-map_metadata') + 1], '-1');
  assert.strictEqual(argv[argv.indexOf('-threads') + 1], '1');
  for (const pair of [['-c:v', 'libx264'], ['-preset', 'fast'], ['-crf', '22']]) {
    const i = argv.indexOf(pair[0]);
    assert.ok(i >= 0 && argv[i + 1] === pair[1], `missing ${pair[0]} ${pair[1]}`);
  }
  assert.ok(argv.includes('-an'), 'clip render must be video-only');

  // 删帧右移, source_in 不改写
  const argv2 = finClipRenderArgs({ clip: Object.assign({}, FIN_BASE_CLIP, { deleted_head_frames: 15 }), takePath: '/in.mp4', fps: 30, width: 240, height: 240, outPath: '/o2.mp4' });
  assert.strictEqual(Number(argv2[argv2.indexOf('-ss') + 1]), 1.5, 'deleted_head_frames must shift the in-point');
  assert.strictEqual(argv2[argv2.indexOf('-frames:v') + 1], '15');

  // padding → tpad 静帧 + output_len
  const argv3 = finClipRenderArgs({ clip: Object.assign({}, FIN_BASE_CLIP, { padding_frames: 15 }), takePath: '/in.mp4', fps: 30, width: 240, height: 240, outPath: '/o3.mp4' });
  assert.ok(/tpad=stop_mode=clone:stop_duration=0\.5/.test(argv3[argv3.indexOf('-vf') + 1]), argv3[argv3.indexOf('-vf') + 1]);
  assert.strictEqual(argv3[argv3.indexOf('-frames:v') + 1], '45');

  // fail-closed 校验
  throws(() => finClipRenderArgs({ clip: FIN_BASE_CLIP, takePath: '/i', fps: 30, width: 240, height: 240, srcDurationFrames: 45, outPath: '/o' }), 'exceeds source duration');
  throws(() => finClipRenderArgs({ clip: Object.assign({}, FIN_BASE_CLIP, { deleted_head_frames: 30 }), takePath: '/i', fps: 30, width: 240, height: 240, outPath: '/o' }), 'output length');
  throws(() => finClipRenderArgs({ clip: FIN_BASE_CLIP, takePath: '/i', fps: 0, width: 240, height: 240, outPath: '/o' }), 'positive integer');
  throws(() => finClipRenderArgs({ clip: FIN_BASE_CLIP, takePath: '/i', fps: 30, width: 3, height: 240, outPath: '/o' }), 'even');
});

// ---- ffmpeg 夹具/断言助手 ----

function finColorSource(dir, name, size) {
  const p = path.join(dir, name);
  const bin = process.env.FFMPEG_BIN || 'ffmpeg';
  const r = spawnSync(bin, ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `color=c=red:s=${size}x${size}:r=30:d=1`,
    '-f', 'lavfi', '-i', `color=c=green:s=${size}x${size}:r=30:d=1`,
    '-f', 'lavfi', '-i', `color=c=blue:s=${size}x${size}:r=30:d=1`,
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[out]', '-map', '[out]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', p], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`finColorSource failed: ${r.stderr || r.stdout}`);
  return p;
}

function finFrameRGB(file, n) {
  const bin = process.env.FFMPEG_BIN || 'ffmpeg';
  const r = spawnSync(bin, ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${n})`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 20 });
  if (r.status !== 0 || !r.stdout || r.stdout.length < 3) throw new Error(`finFrameRGB failed (${file} @ ${n}): ${r.stderr}`);
  return [r.stdout[0], r.stdout[1], r.stdout[2]];
}

function finIsGreen(px) {
  return px[1] > px[0] + 40 && px[1] > px[2] + 40;
}

function finProbeFrames(file) {
  const r = spawnSync(process.env.FFPROBE_BIN || 'ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v', '-show_entries', 'stream=nb_read_frames', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`finProbeFrames failed: ${r.stderr}`);
  const n = parseInt(String(r.stdout).trim(), 10);
  if (!Number.isFinite(n)) throw new Error(`finProbeFrames: cannot parse ${JSON.stringify(r.stdout)}`);
  return n;
}

function finSubtitleCodec(file) {
  const r = spawnSync(process.env.FFPROBE_BIN || 'ffprobe', ['-v', 'error', '-select_streams', 's', '-show_entries', 'stream=codec_name', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`finSubtitleCodec failed: ${r.stderr}`);
  const t = String(r.stdout).trim();
  return t.length > 0 ? t : null;
}

function finManifest(dir, src, opts = {}) {
  return {
    episode: 'FIN', schema_version: 2, fps: 30, ratio: '1:1', resolution: '240p',
    intent: opts.intent || { dialogue: false, audio: 'none', subtitles: 'none', silent: false },
    shots: [{ id: 's01', input_hash: 'h1', takes: [{ id: 'take-001', status: 'selected', input_hash: 'h1', path: src }] }],
    cover: opts.cover === null ? undefined : { promo_asset: opts.promo },
  };
}

// ---- FIN2: 帧精确 ----

testFfmpeg('FIN2. 帧精确:入点/删帧右移/静帧补长(单像素取值)', () => {
  const dir = mkTempDir();
  const src = finColorSource(dir, 'src.mp4', 240);
  const promo = genImage(dir, 'promo.png', 'color=c=yellow:s=240x240');
  const manifest = finManifest(dir, src, { promo });
  const mkClip = (over) => Object.assign({ clip_id: 'c1', shot_id: 's01', take_id: 'take-001', source_in: 30, source_out: 60, deleted_head_frames: 0, padding_frames: 0 }, over);

  // 绿段 [30,60) → 1s
  let out = path.join(dir, 'a.mp4');
  finRenderFinal({ absEpDir: dir, manifest, timeline: { version: 1, fps: 30, clips: [mkClip({ output_start: 0, output_end: 30 })] }, outPath: out, opts: { skipCover: true } });
  assert.strictEqual(finProbeFrames(out), 30);
  assert.ok(finIsGreen(finFrameRGB(out, 0)), 'first frame must be green');
  assert.ok(finIsGreen(finFrameRGB(out, 29)), 'last frame must be green');

  // deleted_head_frames=15 → 0.5s, 从绿段中段起
  out = path.join(dir, 'b.mp4');
  finRenderFinal({ absEpDir: dir, manifest, timeline: { version: 1, fps: 30, clips: [mkClip({ deleted_head_frames: 15, output_start: 0, output_end: 15 })] }, outPath: out, opts: { skipCover: true } });
  assert.strictEqual(finProbeFrames(out), 15);
  assert.ok(finIsGreen(finFrameRGB(out, 0)), 'deleted head must start green (frames 45..59)');

  // padding_frames=15 → 1.5s, 末帧为绿(冻结)
  out = path.join(dir, 'c.mp4');
  finRenderFinal({ absEpDir: dir, manifest, timeline: { version: 1, fps: 30, clips: [mkClip({ padding_frames: 15, output_start: 0, output_end: 45 })] }, outPath: out, opts: { skipCover: true } });
  assert.strictEqual(finProbeFrames(out), 45);
  assert.ok(finIsGreen(finFrameRGB(out, 44)), 'padding must freeze the last in-range frame (green, not blue)');
});

// ---- FIN3: 多 clip + padding + A/V ----

testFfmpeg('FIN3. 多 clip + padding 混合:总帧数 == Σ output_len;A/V <100ms(program 静音基床)', () => {
  const dir = mkTempDir();
  const src = finColorSource(dir, 'src.mp4', 240);
  const promo = genImage(dir, 'promo.png', 'color=c=yellow:s=240x240');
  const clips = [
    { clip_id: 'c1', shot_id: 's01', take_id: 'take-001', source_in: 0, source_out: 30, deleted_head_frames: 0, padding_frames: 0, output_start: 0, output_end: 30 },
    { clip_id: 'c2', shot_id: 's01', take_id: 'take-001', source_in: 30, source_out: 60, deleted_head_frames: 15, padding_frames: 0, output_start: 30, output_end: 45 },
    { clip_id: 'c3', shot_id: 's01', take_id: 'take-001', source_in: 60, source_out: 90, deleted_head_frames: 0, padding_frames: 10, output_start: 45, output_end: 85 },
  ];
  const manifest = finManifest(dir, src, { promo, intent: { dialogue: false, audio: 'music_sfx', subtitles: 'none', silent: false } });
  const timeline = { version: 1, fps: 30, clips };
  const { buildProgramAudio } = require('../audio');
  fs.mkdirSync(path.join(dir, 'audio'), { recursive: true });
  buildProgramAudio({ manifest, timeline, epDir: dir, outPath: path.join(dir, 'audio', 'program.m4a') });

  const out = path.join(dir, 'out.mp4');
  const r = finRenderFinal({ absEpDir: dir, manifest, timeline, outPath: out, opts: { skipCover: true } });
  const expected = clips.reduce((s, c) => s + (c.output_end - c.output_start), 0);
  assert.strictEqual(expected, 85);
  assert.strictEqual(finProbeFrames(out), expected, 'total frames must equal the sum of output_len');
  assert.strictEqual(r.audio, true);
  const p = probeMedia(out);
  const diff = Math.abs(p.video.duration - p.audio.duration);
  assert.ok(diff < 0.1, `A/V diff ${diff} must be < 0.1s`);
});

// ---- FIN4: 字幕接入 ----

testFfmpeg('FIN4. 字幕接入:soft / burn 无 libass 降级 / none', () => {
  const dir = mkTempDir();
  const src = finColorSource(dir, 'src.mp4', 240);
  const promo = genImage(dir, 'promo.png', 'color=c=yellow:s=240x240');
  fs.writeFileSync(path.join(dir, 'episode.srt'), '1\n00:00:00,000 --> 00:00:00,500\nHello\n\n');
  const timeline = { version: 1, fps: 30, clips: [{ clip_id: 'c1', shot_id: 's01', take_id: 'take-001', source_in: 30, source_out: 60, deleted_head_frames: 0, padding_frames: 0, output_start: 0, output_end: 30 }] };
  const mk = (subtitles) => finManifest(dir, src, { promo, intent: { dialogue: false, audio: 'none', subtitles, silent: false } });
  const hasLibass = SUB.hasSubtitlesFilter();

  // soft
  let out = path.join(dir, 'soft.mp4');
  let r = finRenderFinal({ absEpDir: dir, manifest: mk('soft'), timeline, outPath: out, opts: { skipCover: true } });
  assert.strictEqual(r.subtitles, 'soft');
  assert.strictEqual(finSubtitleCodec(out), 'mov_text');

  // burn / both
  for (const mode of ['burn', 'both']) {
    out = path.join(dir, `${mode}.mp4`);
    r = finRenderFinal({ absEpDir: dir, manifest: mk(mode), timeline, outPath: out, opts: { skipCover: true } });
    if (hasLibass) {
      assert.strictEqual(r.subtitles, 'burn');
    } else {
      assert.strictEqual(r.subtitles, 'soft', 'no-libass burn/both must degrade to soft');
      assert.ok(r.warnings.join(' ').includes('libass'), `expected a libass degrade WARN: ${r.warnings.join(' | ')}`);
    }
    assert.strictEqual(finSubtitleCodec(out), 'mov_text');
  }

  // none → 无字幕流
  out = path.join(dir, 'none.mp4');
  r = finRenderFinal({ absEpDir: dir, manifest: mk('none'), timeline, outPath: out, opts: { skipCover: true } });
  assert.strictEqual(r.subtitles, null);
  assert.strictEqual(finSubtitleCodec(out), null);
});

// ---- FIN5: 封面 ----

testFfmpeg('FIN5. 封面:cover.png 生成且尺寸=期望;skipCover 不生成', () => {
  const dir = mkTempDir();
  const src = finColorSource(dir, 'src.mp4', 240);
  const promo = genImage(dir, 'promo.png', 'color=c=yellow:s=240x240');
  const manifest = finManifest(dir, src, { promo });
  const timeline = { version: 1, fps: 30, clips: [{ clip_id: 'c1', shot_id: 's01', take_id: 'take-001', source_in: 30, source_out: 60, deleted_head_frames: 0, padding_frames: 0, output_start: 0, output_end: 30 }] };
  const out = path.join(dir, 'out.mp4');
  const r = finRenderFinal({ absEpDir: dir, manifest, timeline, outPath: out });
  assert.strictEqual(r.cover, path.join(dir, 'cover.png'));
  assert.ok(fs.existsSync(r.cover));
  const cp = probeMedia(r.cover);
  assert.strictEqual(cp.video.width, 240);
  assert.strictEqual(cp.video.height, 240);

  // skipCover
  const dir2 = mkTempDir();
  const src2 = finColorSource(dir2, 'src.mp4', 240);
  const manifest2 = finManifest(dir2, src2, { promo: genImage(dir2, 'promo.png', 'color=c=yellow:s=240x240') });
  const r2 = finRenderFinal({ absEpDir: dir2, manifest: manifest2, timeline, outPath: path.join(dir2, 'out.mp4'), opts: { skipCover: true } });
  assert.strictEqual(r2.cover, null);
  assert.ok(!fs.existsSync(path.join(dir2, 'cover.png')), 'skipCover must not write cover.png');
});

// ---- FIN6: 缺件 fail-closed ----

test('FIN6. 缺件 fail-closed:audio/srt/take;失败后 outPath 不存在', () => {
  const dir = mkTempDir();
  const takeFile = path.join(dir, 'take.mp4');
  fs.writeFileSync(takeFile, 'x');
  const clip = { clip_id: 'c1', shot_id: 's01', take_id: 'take-001', source_in: 0, source_out: 30, deleted_head_frames: 0, padding_frames: 0, output_start: 0, output_end: 30 };
  const timeline = { version: 1, fps: 30, clips: [clip] };
  const mk = (intent, takePath) => finManifest(dir, takePath, { promo: path.join(dir, 'p.png'), intent });

  // requires_audio 但无 program.m4a
  let out = path.join(dir, 'a.mp4');
  throws(() => finRenderFinal({ absEpDir: dir, manifest: mk({ dialogue: false, audio: 'music_sfx', subtitles: 'none', silent: false }, takeFile), timeline, outPath: out, opts: { skipCover: true } }), 'tools/audio.js');
  assert.ok(!fs.existsSync(out), 'failed render must not leave outPath');

  // requires_subtitles 但无 episode.srt
  out = path.join(dir, 'b.mp4');
  throws(() => finRenderFinal({ absEpDir: dir, manifest: mk({ dialogue: true, audio: 'none', subtitles: 'burn', silent: false }, takeFile), timeline, outPath: out, opts: { skipCover: true } }), 'tools/subtitles.js');
  assert.ok(!fs.existsSync(out));

  // take 缺失
  out = path.join(dir, 'c.mp4');
  throws(() => finRenderFinal({ absEpDir: dir, manifest: mk({ dialogue: false, audio: 'none', subtitles: 'none', silent: false }, path.join(dir, 'missing.mp4')), timeline, outPath: out, opts: { skipCover: true } }), 'take file missing');
  assert.ok(!fs.existsSync(out));

  // rejected take
  out = path.join(dir, 'd.mp4');
  const mRej = mk({ dialogue: false, audio: 'none', subtitles: 'none', silent: false }, takeFile);
  mRej.shots[0].takes[0].status = 'rejected';
  throws(() => finRenderFinal({ absEpDir: dir, manifest: mRej, timeline, outPath: out, opts: { skipCover: true } }), 'rejected');
  assert.ok(!fs.existsSync(out));

  // fps 不一致
  out = path.join(dir, 'e.mp4');
  throws(() => finRenderFinal({ absEpDir: dir, manifest: mk({ dialogue: false, audio: 'none', subtitles: 'none', silent: false }, takeFile), timeline: { version: 1, fps: 24, clips: [clip] }, outPath: out, opts: { skipCover: true } }), 'does not match');
  assert.ok(!fs.existsSync(out));
});

// ---- FIN7: 确定性（Gate #14） ----

testFfmpeg('FIN7. 确定性:两次出片视频/音频摘要相等;determinism.js CLI 退出 0', () => {
  const dir = mkTempDir();
  const src = finColorSource(dir, 'src.mp4', 240);
  const promo = genImage(dir, 'promo.png', 'color=c=yellow:s=240x240');
  const manifest = finManifest(dir, src, { promo, intent: { dialogue: false, audio: 'music_sfx', subtitles: 'none', silent: false } });
  const timeline = { version: 1, fps: 30, clips: [{ clip_id: 'c1', shot_id: 's01', take_id: 'take-001', source_in: 30, source_out: 60, deleted_head_frames: 0, padding_frames: 0, output_start: 0, output_end: 30 }] };
  const { buildProgramAudio } = require('../audio');
  fs.mkdirSync(path.join(dir, 'audio'), { recursive: true });
  buildProgramAudio({ manifest, timeline, epDir: dir, outPath: path.join(dir, 'audio', 'program.m4a') });
  writeManifest(dir, manifest);
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(timeline, null, 2));

  const cliOut = path.join(dir, 'det.mp4');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'determinism.js'), dir, '--keep', '--out', cliOut], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const report = JSON.parse(r.stdout);
  assert.strictEqual(report.ok, true);
  assert.strictEqual(report.video_md5_equal, true);
  assert.strictEqual(report.audio_md5_equal, true);
  assert.ok(fs.existsSync(report.first.path) && fs.existsSync(report.second.path), '--keep must retain both artifacts');

  const da = finDeterminismDigests(report.first.path);
  const db = finDeterminismDigests(report.second.path);
  assert.ok(da.video_md5 && da.video_md5 === db.video_md5, 'decoded video stream md5 must match');
  assert.ok(da.audio_md5 && da.audio_md5 === db.audio_md5, 'decoded audio PCM sha256 must match');
});

// ---- FIN8: v1/v2 兼容与入口接线 ----

test('FIN8a. detectRenderMode:v2+timeline → v2;缺 timeline / v1 → v1', () => {
  const dir = mkTempDir();
  fs.writeFileSync(path.join(dir, 'timeline.json'), '{}');
  const v2 = finDetectRenderMode({ absEpDir: dir, manifest: { schema_version: 2 } });
  assert.strictEqual(v2.mode, 'v2');
  assert.strictEqual(v2.modeLine, FIN_MODE_LINE_V2);

  const dir2 = mkTempDir();
  assert.strictEqual(finDetectRenderMode({ absEpDir: dir2, manifest: { schema_version: 2 } }).mode, 'v1');
  fs.writeFileSync(path.join(dir2, 'timeline.json'), '{}');
  const v1 = finDetectRenderMode({ absEpDir: dir2, manifest: { schema_version: 1 } });
  assert.strictEqual(v1.mode, 'v1');
  assert.strictEqual(v1.modeLine, FIN_MODE_LINE_V1);
});

function finWriteV1Episode(dir) {
  fs.writeFileSync(path.join(dir, 'script.yaml'), [
    'episode: FINV1', 'title: T', 'defaults:', '  duration: 8', "  ratio: '16:9'",
    "  resolution: '720p'", "  model: 'default'", 'scenes:', '  - id: s01', '    shots:',
    '      - id: s01-shot-01', "        style_en: 'cinematic'", "        prompt_en: 'a test shot'", ''
  ].join('\n'));
  const bm = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'build-manifest.js'), dir], { encoding: 'utf8' });
  if (bm.status !== 0) throw new Error(`build-manifest failed: ${bm.stdout}${bm.stderr}`);
  const video = path.join(dir, 'shot.mp4');
  const g = spawnSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=256x144:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video], { encoding: 'utf8' });
  if (g.status !== 0) throw new Error(`test video failed: ${g.stderr}`);
  const m = readManifest(dir);
  const shot = m.shots[0];
  shot.status = 'done';
  shot.selected_take = 'take-001';
  shot.takes = [{ id: 'take-001', status: 'selected', input_hash: shot.input_hash, path: video, human_review: null }];
  writeManifest(dir, m);
  return m;
}

testFfmpeg('FIN8b. CLI:v1 episode --final 走 legacy 秒制且退出 0', () => {
  const dir = mkTempDir();
  finWriteV1Episode(dir);
  const out = path.join(dir, 'episode.mp4');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'stitch-episode.js'), dir, '--final', '--out', out], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.ok(r.stdout.includes(FIN_MODE_LINE_V1), `expected legacy mode line: ${r.stdout}`);
  assert.ok(fs.existsSync(out), 'legacy render must produce the final file');
});

testFfmpeg('FIN8c. CLI:v2 episode + timeline --final 走 v2 帧口径且退出 0', () => {
  const dir = mkTempDir();
  fs.writeFileSync(path.join(dir, 'script.yaml'), [
    'episode: FINV2', 'title: T', 'schema_version: 2', 'defaults:', '  duration: 8',
    "  ratio: '1:1'", "  resolution: '240p'", "  model: 'default'", 'scenes:',
    '  - id: s01', '    shots:', '      - id: s01-shot-01', "        style_en: 'cinematic'",
    "        prompt_en: 'a test shot'", ''
  ].join('\n'));
  const bm = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'build-manifest.js'), dir], { encoding: 'utf8' });
  assert.strictEqual(bm.status, 0, `${bm.stdout}${bm.stderr}`);
  const src = finColorSource(dir, 'src.mp4', 240);
  const promo = genImage(dir, 'promo.png', 'color=c=yellow:s=240x240');
  const m = readManifest(dir);
  const shot = m.shots[0];
  shot.status = 'done';
  shot.selected_take = 'take-001';
  shot.takes = [{ id: 'take-001', status: 'selected', input_hash: shot.input_hash, path: src }];
  // 显式 audio=none（避免需要 program.m4a），cover 用 promo
  m.intent = { dialogue: false, audio: 'none', subtitles: 'none', silent: false, requires_subtitles: false, requires_audio: false, requires_loudnorm: false, declared: { audio: true }, sources: { audio: 'edit' } };
  m.cover = { promo_asset: promo };
  writeManifest(dir, m);
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify({ version: 1, fps: 30, clips: [{ clip_id: 'clip-0001', shot_id: 's01-shot-01', take_id: 'take-001', source_in: 30, source_out: 60, deleted_head_frames: 0, padding_frames: 0, output_start: 0, output_end: 30 }] }, null, 2));
  const out = path.join(dir, 'episode.mp4');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'stitch-episode.js'), dir, '--final', '--out', out], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.ok(r.stdout.includes(FIN_MODE_LINE_V2), `expected v2 mode line: ${r.stdout}`);
  assert.ok(fs.existsSync(out), 'v2 render must produce the final file');
});

// ============================================================
console.log('\n[FIX5] v2 导出/绑定/意图/调度/迁移 P1 复核回归(A–E)');
// ============================================================

const {
  takeDependencyProblem: gateTakeDependencyProblem,
  evaluateReleaseGate: gateEvaluateReleaseGate,
} = require('../gate');
const { checkDialogueDeclaration } = require('../intent');
const { resolveAttempt: msResolveAttempt } = require('../mark-shot');

// ---- FIX5a: v2 导出必须走完整素材校验 ----

test('FIX5a1. takeDependencyProblem:hash 失配/rejected/human reject/blocked/superseded 无 reuse → problem;reuse/human accept 豁免', () => {
  const shot = shotBase('s01-shot-01', { input_hash: 'h_new' });
  const where = 'clip c1';
  // fingerprint 失配
  assert.ok(gateTakeDependencyProblem({}, shot, { id: 'take-001', status: 'selected', input_hash: 'h_old' }, where).length > 0, 'hash mismatch must be a problem');
  // rejected
  assert.ok(gateTakeDependencyProblem({}, shot, { id: 'take-001', status: 'rejected', input_hash: 'h_new' }, where).length > 0, 'rejected take must be a problem');
  // human reject
  assert.ok(gateTakeDependencyProblem({}, shot, { id: 'take-001', status: 'selected', input_hash: 'h_new', human_review: { conclusion: 'reject', reviewed_input_hash: 'h_new' } }, where).length > 0, 'human reject must be a problem');
  // blocked shot
  const blockedShot = shotBase('s01-shot-01', { status: 'blocked', input_hash: 'h_new' });
  assert.ok(gateTakeDependencyProblem({}, blockedShot, { id: 'take-001', status: 'selected', input_hash: 'h_new' }, where).length > 0, 'blocked shot must be a problem');
  // superseded task without reuse_record
  const manifestSup = { render_tasks: [{ task_id: 't1', shot_id: shot.id, status: 'submitted', superseded_at: '2026-01-01T00:00:00.000Z' }] };
  assert.ok(gateTakeDependencyProblem(manifestSup, shot, { id: 'take-001', status: 'candidate', task_id: 't1', input_hash: 'h_new' }, where).length > 0, 'superseded task without reuse_record must be a problem');
  // valid reuse_record exempts the fingerprint mismatch
  const manifestReuse = { reuse_records: [{ take_id: 'take-001', reason: 'fingerprint_recurrence', bound_input_hash: 'h_new' }] };
  assert.strictEqual(gateTakeDependencyProblem(manifestReuse, shot, { id: 'take-001', status: 'candidate', input_hash: 'h_old' }, where).length, 0, 'valid reuse_record must be exempt');
  // human accept bound to the current input exempts the fingerprint mismatch
  assert.strictEqual(gateTakeDependencyProblem({}, shot, { id: 'take-001', status: 'candidate', input_hash: 'h_old', human_review: { conclusion: 'accept', reviewed_input_hash: 'h_new' } }, where).length, 0, 'human accept must be exempt');
});

testFfmpeg('FIX5a2. renderFinal pre-flight:take.input_hash 失配 → 抛错且无输出;改为一致 → 正常出片', () => {
  const dir = mkTempDir();
  const src = finColorSource(dir, 'src.mp4', 240);
  const timeline = { version: 1, fps: 30, clips: [{ clip_id: 'c1', shot_id: 's01', take_id: 'take-001', source_in: 30, source_out: 60, deleted_head_frames: 0, padding_frames: 0, output_start: 0, output_end: 30 }] };
  const manifest = finManifest(dir, src);
  manifest.shots[0].takes[0].input_hash = 'h_mismatch';
  const badOut = path.join(dir, 'bad.mp4');
  throws(() => finRenderFinal({ absEpDir: dir, manifest, timeline, outPath: badOut, opts: { skipCover: true } }), 'renderFinal: unusable take');
  assert.ok(!fs.existsSync(badOut), 'unusable take must not produce any output');
  manifest.shots[0].takes[0].input_hash = 'h1';
  const goodOut = path.join(dir, 'good.mp4');
  finRenderFinal({ absEpDir: dir, manifest, timeline, outPath: goodOut, opts: { skipCover: true } });
  assert.ok(fs.existsSync(goodOut), 'matching fingerprint must render');
});

const FIX5_SCRIPT = [
  'episode: FIX5', 'title: T', 'schema_version: 2',
  'defaults:', '  duration: 1', "  ratio: '1:1'", "  resolution: '240p'", "  model: 'default'",
  'scenes:', '  - id: s01', '    shots:', '      - id: s01-shot-01',
  "        style_en: 'cinematic'", "        prompt_en: 'a test shot'", ''
].join('\n');

function fix5EditYaml() {
  return ['output:', '  fps: 30', 'timeline:', '  - shot_id: s01-shot-01', '    take_id: take-001', ''].join('\n');
}

function fix5V2Timeline() {
  return { version: 1, fps: 30, clips: [{ clip_id: 'clip-0001', shot_id: 's01-shot-01', take_id: 'take-001', source_in: 30, source_out: 60, deleted_head_frames: 0, padding_frames: 0, output_start: 0, output_end: 30 }] };
}

/** 写一个 v2 episode:build-manifest + done/selected take + intent audio=none + promo cover + edit.yaml + timeline.json */
function fix5V2Episode(dir, { src, promo, takeHash }) {
  fs.writeFileSync(path.join(dir, 'script.yaml'), FIX5_SCRIPT);
  const bm = runBuildManifest(dir);
  assert.strictEqual(bm.status, 0, `${bm.stdout}${bm.stderr}`);
  const m = readManifest(dir);
  m.intent = { dialogue: false, audio: 'none', subtitles: 'none', silent: false, requires_subtitles: false, requires_audio: false, requires_loudnorm: false, declared: { audio: true }, sources: { audio: 'edit' } };
  m.cover = { promo_asset: promo };
  m.shots[0].status = 'done';
  m.shots[0].selected_take = 'take-001';
  m.shots[0].takes = [{ id: 'take-001', status: 'selected', input_hash: takeHash, path: src }];
  writeManifest(dir, m);
  fs.writeFileSync(path.join(dir, 'edit.yaml'), fix5EditYaml());
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(fix5V2Timeline(), null, 2));
  return m;
}

testFfmpeg('FIX5a3. edit-episode CLI v2:坏素材 → exit 4 无输出;好素材 → exit 0 且打印 v2 timeline render', () => {
  const dir = mkTempDir();
  const src = finColorSource(dir, 'src.mp4', 240);
  const promo = genImage(dir, 'promo.png', 'color=c=yellow:s=240x240');
  const m = fix5V2Episode(dir, { src, promo, takeHash: 'h_bad' });
  const badOut = path.join(dir, 'bad.mp4');
  const bad = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'edit-episode.js'), dir, '--out', badOut], { encoding: 'utf8' });
  assert.strictEqual(bad.status, 4, `${bad.stdout}\n${bad.stderr}`);
  assert.ok(!fs.existsSync(badOut), 'offline gate failure must not produce output');

  const m2 = readManifest(dir);
  m2.shots[0].takes[0].input_hash = m2.shots[0].input_hash;
  writeManifest(dir, m2);
  const goodOut = path.join(dir, 'good.mp4');
  const good = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'edit-episode.js'), dir, '--out', goodOut], { encoding: 'utf8' });
  assert.strictEqual(good.status, 0, `${good.stdout}\n${good.stderr}`);
  assert.ok(good.stdout.includes(FIN_MODE_LINE_V2), `expected v2 mode line: ${good.stdout}`);
  assert.ok(fs.existsSync(goodOut), 'good material must render');
});

// ---- FIX5c: request 不得绑定到两个 attempt ----

function fix5TwoAttemptTask() {
  return {
    task_id: 'task-x', shot_id: 's01-shot-01', input_hash: 'h1', status: 'submitted', stage: 'video', breaker_epoch: 0,
    current_attempt_id: 'a2',
    attempts: [
      { attempt_id: 'a1', at: '2026-01-01T00:00:00.000Z', input_hash: 'h1', request_id: 'r1' },
      { attempt_id: 'a2', at: '2026-01-01T00:01:00.000Z', input_hash: 'h1' }
    ]
  };
}

test('FIX5c1. resolveAttempt 双向唯一映射:(a2,r1)/(a1,r2) 抛错;(a1,r1)/(a2,r2) ok', () => {
  const manifest = { task_events: [] };
  throws(() => msResolveAttempt(fix5TwoAttemptTask(), { attemptId: 'a2', requestId: 'r1' }, manifest), 'r1');
  let msg = '';
  try { msResolveAttempt(fix5TwoAttemptTask(), { attemptId: 'a2', requestId: 'r1' }, manifest); } catch (e) { msg = e.message; }
  assert.ok(msg.includes('a1') && msg.includes('a2'), `message must name both attempts: ${msg}`);
  throws(() => msResolveAttempt(fix5TwoAttemptTask(), { attemptId: 'a1', requestId: 'r2' }, manifest), 'r2');
  const ok1 = msResolveAttempt(fix5TwoAttemptTask(), { attemptId: 'a1', requestId: 'r1' }, manifest);
  assert.strictEqual(ok1.attempt_id, 'a1');
  assert.strictEqual(ok1.request_id, 'r1');
  const ok2 = msResolveAttempt(fix5TwoAttemptTask(), { attemptId: 'a2', requestId: 'r2' }, manifest);
  assert.strictEqual(ok2.attempt_id, 'a2');
  assert.strictEqual(ok2.request_id, 'r2');
});

test('FIX5c2. resolveAttempt 冲突抛错时零改动', () => {
  const task = fix5TwoAttemptTask();
  const manifest = { task_events: [{ task_id: 'task-x', attempt_id: 'a1', request_id: 'r1', n: 1 }] };
  const before = JSON.stringify({ task, manifest });
  throws(() => msResolveAttempt(task, { attemptId: 'a2', requestId: 'r1' }, manifest), 'r1');
  assert.strictEqual(JSON.stringify({ task, manifest }), before, 'conflict must not mutate task/manifest');
});

test('FIX5c3. CLI mark-shot --take 冲突 → 非零退出且 manifest 不变', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'v.mp4');
  fs.writeFileSync(vfile, 'v');
  writeManifest(dir, { episode: 'TEST', render_tasks: [fix5TwoAttemptTask()], shots: [shotBase('s01-shot-01', { input_hash: 'h1' })] });
  const before = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'mark-shot.js'), dir, 's01-shot-01', '--take', '--task', 'task-x', '--attempt-id', 'a2', '--request-id', 'r1', '--path', vfile], { encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), before, 'conflict must leave manifest unchanged');
});

// ---- FIX5b: dialogue=false 不得隐藏真实对白 ----

test('FIX5b1. checkDialogueDeclaration:false+有对白 → error;true+无对白 / 一致 → ok', () => {
  const bad = checkDialogueDeclaration({ dialogue: false }, { hasDialogue: true });
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.errors.length > 0);
  assert.strictEqual(checkDialogueDeclaration({ dialogue: true }, { hasDialogue: false }).ok, true, 'dialogue:true without dialogue must not error (legacy fixtures)');
  assert.strictEqual(checkDialogueDeclaration({ dialogue: true }, { hasDialogue: true }).ok, true);
  assert.strictEqual(checkDialogueDeclaration({ dialogue: false }, { hasDialogue: false }).ok, true);
});

const FIX5B_SCRIPT = [
  'episode: FIX5B', 'title: T', 'schema_version: 2',
  'intent:', '  dialogue: false',
  'defaults:', '  duration: 8', "  ratio: '16:9'", "  resolution: '720p'", "  model: 'default'",
  'scenes:', '  - id: s01', '    shots:', '      - id: s01-shot-01',
  "        style_en: 'cinematic'", "        prompt_en: 'a test shot'",
  '        dialogue: "hello there"', ''
].join('\n');

test('FIX5b2. build-manifest CLI:dialogue:false + 实际有对白 → exit 4 且不写 manifest', () => {
  const dir = mkTempDir();
  fs.writeFileSync(path.join(dir, 'script.yaml'), FIX5B_SCRIPT);
  const r = runBuildManifest(dir);
  assert.strictEqual(r.status, 4, `${r.stdout}${r.stderr}`);
  assert.ok(/dialogue/i.test(`${r.stdout}${r.stderr}`), 'error must mention dialogue');
  assert.ok(!fs.existsSync(path.join(dir, 'manifest.json')), 'no manifest may be written');
});

function fix5GateManifest(withDialogue) {
  const shot = shotBase('s01', {
    input_hash: 'h1', selected_take: 'take-001',
    takes: [{ id: 'take-001', status: 'selected', input_hash: 'h1' }]
  });
  if (withDialogue) shot.dialogue_text = 'hello there';
  return { episode: 'FIX5B', schema_version: 2, fps: 30, intent: { dialogue: false, audio: 'none', subtitles: 'none', silent: false }, shots: [shot] };
}

function fix5GateTimeline(withDialogue) {
  return { version: 1, fps: 30, clips: [{ clip_id: 'clip-0001', shot_id: 's01', take_id: 'take-001', source_in: 0, source_out: 30, deleted_head_frames: 0, padding_frames: 0, output_start: 0, output_end: 30, dialogue: withDialogue ? { take_id: 'tts-1', dialogue_ms: 1000, measured: true, text: 'hello there' } : null }] };
}

test('FIX5b3. gate:intent.dialogue=false + 有对白 → #6/#7 均 fail;无对白 → 仍 n/a', () => {
  const hidden = gateEvaluateReleaseGate({ manifest: fix5GateManifest(true), timeline: fix5GateTimeline(true), schemaVersion: 2, opts: { phase: 'offline' } });
  const it6 = hidden.items.find(i => i.id === '6');
  const it7 = hidden.items.find(i => i.id === '7');
  assert.strictEqual(it6.status, 'fail', JSON.stringify(it6));
  assert.strictEqual(it7.status, 'fail', JSON.stringify(it7));
  assert.ok(it6.reasons.join(' ').includes('s01') || it6.reasons.join(' ').includes('clip-0001'), 'message must name the offending shot/clip');
  const clean = gateEvaluateReleaseGate({ manifest: fix5GateManifest(false), timeline: fix5GateTimeline(false), schemaVersion: 2, opts: { phase: 'offline' } });
  assert.strictEqual(clean.items.find(i => i.id === '6').status, 'not_applicable');
  assert.strictEqual(clean.items.find(i => i.id === '7').status, 'not_applicable');
});

// ---- FIX5d: 改稿后 rendering 镜头可重新调度 ----

function fix5DRenderStatusCase() {
  const dir = mkTempDir();
  fs.writeFileSync(path.join(dir, 'script.yaml'), FIX5_SCRIPT.replace('episode: FIX5', 'episode: FIX5D'));
  const r = runBuildManifest(dir);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  return dir;
}

function fix5DSeed(dir, taskHash) {
  const m = readManifest(dir);
  m.shots[0].status = 'rendering';
  m.shots[0].selected_take = 'take-001';
  m.shots[0].takes = [{ id: 'take-001', status: 'selected', input_hash: 'older_hash', path: 'x.mp4' }];
  m.render_tasks = taskHash === null ? [] : [{ task_id: 'task-v', shot_id: 's01-shot-01', take_id: 'take-001', input_hash: taskHash, status: 'submitted', stage: 'video', breaker_epoch: 0 }];
  writeManifest(dir, m);
  return m.shots[0].input_hash;
}

test('FIX5d1. deriveStatus rendering 四例:hash 匹配→rendering;hash 变/无 task→stale/pending', () => {
  const shotSelected = { id: 's01', prev_hash: null, selected_take: 'take-001', takes: [{ id: 'take-001', status: 'selected', input_hash: 'old' }] };
  const shotEmpty = { id: 's01', prev_hash: null, selected_take: null, takes: [] };
  assert.strictEqual(deriveStatus(shotSelected, 'H', 'rendering', { activeTask: { input_hash: 'H' } }).status, 'rendering');
  assert.strictEqual(deriveStatus(shotSelected, 'H', 'rendering', { activeTask: { input_hash: 'OLD' } }).status, 'stale');
  assert.strictEqual(deriveStatus(shotEmpty, 'H', 'rendering', { activeTask: null }).status, 'pending');
  assert.strictEqual(deriveStatus(shotSelected, 'H', 'rendering', { activeTask: { input_hash: null, base_input_hash: 'H' } }).status, 'rendering');
});

test('FIX5d2. build-manifest:rendering + active task hash 变化→stale;hash 不变→rendering;无 task→stale', () => {
  const dir = fix5DRenderStatusCase();
  const H = fix5DSeed(dir, 'different_hash');
  let r = runBuildManifest(dir);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.strictEqual(readManifest(dir).shots[0].status, 'stale', 'changed input must fall through to stale');

  fix5DSeed(dir, H);
  r = runBuildManifest(dir);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.strictEqual(readManifest(dir).shots[0].status, 'rendering', 'unchanged active task input must keep rendering');

  fix5DSeed(dir, null);
  r = runBuildManifest(dir);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.strictEqual(readManifest(dir).shots[0].status, 'stale', 'no active task must fall through to stale');
});

test('FIX5d3. 重建后 render-next 能为该 shot 建新任务且旧任务被 supersede(集成,无网络)', () => {
  const dir = fix5DRenderStatusCase();
  fix5DSeed(dir, 'different_hash');
  let r = runBuildManifest(dir);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.strictEqual(readManifest(dir).shots[0].status, 'stale');
  const created = createRenderTask(dir);
  assert.ok(created && created.task, 'render-next must dispatch the stale shot again');
  const after = readManifest(dir);
  const oldTask = after.render_tasks.find(t => t.task_id === 'task-v');
  assert.ok(oldTask && oldTask.superseded_at, 'old active task must be superseded');
  assert.strictEqual(oldTask.superseded_by, created.task.task_id);
  assert.ok(after.render_tasks.some(t => t.task_id === created.task.task_id), 'new task must be recorded');
});

// ---- FIX5e: 迁移按文件独立判定 ----

test('FIX5e1. script=2/manifest=1 → 仅迁移 manifest;script 内容不变', () => {
  const script = mgBaseScript(undefined, ['schema_version: 2']);
  const dir = mgEpisode({ script, catalog: [] });
  const scriptPath = path.join(dir, 'script.yaml');
  const scriptBefore = fs.readFileSync(scriptPath, 'utf8');
  const res = mgMigrate(dir);
  assert.deepStrictEqual(res.errors, []);
  assert.strictEqual(readManifest(dir).schema_version, 2);
  assert.strictEqual(fs.readFileSync(scriptPath, 'utf8'), scriptBefore, 'script must not be touched');
  assert.strictEqual(res.files.script.changed, false);
  assert.strictEqual(res.files.manifest.from, 1);
  assert.strictEqual(res.files.manifest.changed, true);
});

test('FIX5e2. manifest=2/script=1 → 仅迁移 script;manifest 内容不变', () => {
  const dir = mkTempDir();
  const script = mgBaseScript();
  const m = mgDefaultManifest(dir);
  m.schema_version = 2;
  m.require_keyframe = false;
  fs.writeFileSync(path.join(dir, 'script.yaml'), script);
  writeManifest(dir, m);
  const manifestBefore = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');
  const res = mgMigrate(dir);
  assert.deepStrictEqual(res.errors, []);
  assert.ok(/schema_version: 2/.test(fs.readFileSync(path.join(dir, 'script.yaml'), 'utf8')), 'script must migrate to schema 2');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), manifestBefore, 'manifest must not be touched');
  assert.strictEqual(res.files.script.changed, true);
  assert.strictEqual(res.files.manifest.changed, false);
});

test('FIX5e3. 任一版本 > to → 报错且两文件都不变', () => {
  for (const which of ['script', 'manifest']) {
    const dir = mkTempDir();
    const script = which === 'script' ? mgBaseScript(undefined, ['schema_version: 3']) : mgBaseScript();
    const m = mgDefaultManifest(dir);
    if (which === 'manifest') m.schema_version = 3;
    fs.writeFileSync(path.join(dir, 'script.yaml'), script);
    writeManifest(dir, m);
    const before = mgSnapshot(dir);
    const res = mgMigrate(dir);
    assert.ok(res.errors.length >= 1, `expected downgrade error for ${which}: ${JSON.stringify(res)}`);
    assert.ok(res.errors.join(' ').includes(String(3)), 'error must name the newer version');
    assert.deepStrictEqual(mgSnapshot(dir), before, 'downgrade must write nothing');
  }
});

test('FIX5e4. 两文件=2 → no-op 且内容/mtime 不变', () => {
  const dir = mkTempDir();
  const script = mgBaseScript(undefined, ['schema_version: 2', 'require_keyframe: false']);
  const m = mgDefaultManifest(dir);
  m.schema_version = 2;
  m.require_keyframe = false;
  fs.writeFileSync(path.join(dir, 'script.yaml'), script);
  writeManifest(dir, m);
  const before = mgSnapshot(dir);
  const sp = fs.statSync(path.join(dir, 'script.yaml')).mtimeMs;
  const mp = fs.statSync(path.join(dir, 'manifest.json')).mtimeMs;
  const res = mgMigrate(dir);
  assert.deepStrictEqual(res.errors, []);
  assert.deepStrictEqual(res.changed, []);
  assert.strictEqual(res.files.script.changed, false);
  assert.strictEqual(res.files.manifest.changed, false);
  assert.deepStrictEqual(mgSnapshot(dir), before, 'no-op must not change content');
  assert.strictEqual(fs.statSync(path.join(dir, 'script.yaml')).mtimeMs, sp);
  assert.strictEqual(fs.statSync(path.join(dir, 'manifest.json')).mtimeMs, mp);
});

// ============================================================
console.log('\n[FIX6] 复核确认 3 个 P1(supersede 临界区 / 一对一绑定 / attempt 完整 hash)');
// ============================================================

function runRenderNextCli(dir, args = []) {
  return spawnSync(process.execPath, [path.join(ROOT, 'tools', 'render-next.js'), dir, ...args], { encoding: 'utf8' });
}

// ---- FIX6a: 派发失败不得永久 supersede 旧任务 ----

function fix6TtsScript(dialogue) {
  return [
    'episode: FIX6A', 'title: T', 'schema_version: 2',
    ...TTS_INTENT,
    'tts:', '  provider:', '    name: doubao', '    model: seed-tts-2.0', "    version: '2026-09-14'",
    "  voice_id: 'v1'", '  params:', '    speed: 0.95', '  chars_per_second: 5',
    ...TTS_DEFAULTS,
    'scenes:', '  - id: s01', '    shots:',
    '      - id: s01-shot-01', "        style_en: 'cinematic'", "        prompt_en: 'a'",
    `        dialogue: '${dialogue}'`, ''
  ].join('\n');
}

/** 写一个带参考图的 FIX6 video shot manifest,返回参考图绝对路径 */
function fix6VideoFixture(dir, prompt = 'p', imgBytes = 'A') {
  const img = path.join(dir, 'ref.jpg');
  fs.writeFileSync(img, imgBytes);
  const shot = shotBase('s01-shot-01', { image_paths: [img] });
  shot.prompt_final_en = prompt;
  shot.input_hash = hashForShot(shot);
  writeManifest(dir, { episode: 'TEST', shots: [shot] });
  return img;
}

test('FIX6a1. tts 派发校验失败不得 supersede 旧任务/不改盘', () => {
  const dir = mkTempDir();
  fs.writeFileSync(path.join(dir, 'script.yaml'), fix6TtsScript('hi'));
  let r = runBuildManifest(dir);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);

  r = runRenderNextCli(dir);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  const m1 = readManifest(dir);
  assert.strictEqual(m1.render_tasks.length, 1, 'first dispatch must create exactly one task');
  const A = m1.render_tasks[0];
  assert.strictEqual(A.stage, 'tts');
  assert.strictEqual(A.superseded_at, null, 'A must be dispatchable after first dispatch');

  // 改稿 → 重建:shot.tts_hash 变化,render_tasks 原样保留
  fs.writeFileSync(path.join(dir, 'script.yaml'), fix6TtsScript('hello world, changed'));
  r = runBuildManifest(dir);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  const snapshot = readManifest(dir);
  assert.strictEqual(snapshot.render_tasks.length, 1);
  assert.strictEqual(snapshot.render_tasks[0].superseded_at, null, 'rebuild must not supersede the task');
  assert.notStrictEqual(snapshot.shots[0].tts_hash, A.input_hash, 'fixture must change the tts fingerprint');

  // 篡改 provider.version → FIX3-1 tts 指纹核对失败
  snapshot.tts.provider.version = '9999-09-09';
  writeManifest(dir, snapshot);
  const before = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');

  r = runRenderNextCli(dir);
  assert.notStrictEqual(r.status, 0, `fingerprint mismatch must fail the dispatch: ${r.stdout}${r.stderr}`);
  assert.ok(!/superseding stale active task/.test(r.stderr), `failed dispatch must not attempt to supersede: ${r.stderr}`);

  const after = readManifest(dir);
  assert.strictEqual(after.render_tasks.length, snapshot.render_tasks.length, 'failed dispatch must not add a task');
  const A2 = after.render_tasks.find(t => t.task_id === A.task_id);
  assert.ok(A2, 'old task must still exist');
  assert.strictEqual(A2.superseded_at, null, 'failed dispatch must NOT supersede the old task');
  assert.strictEqual(A2.superseded_by, null, 'failed dispatch must NOT set superseded_by');
  assert.deepStrictEqual(after, snapshot, 'manifest must only differ by the tampered provider');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), before, 'manifest must be byte-identical');
});

test('FIX6a2. 参考图冻结/FIX3-1 失败不得 supersede 旧任务/不改盘', () => {
  const dir = mkTempDir();
  const img = fix6VideoFixture(dir, 'p', 'A');
  let r = runRenderNextCli(dir);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  const m1 = readManifest(dir);
  assert.strictEqual(m1.render_tasks.length, 1);
  const A = m1.render_tasks[0];
  assert.strictEqual(A.stage, 'video');
  assert.strictEqual(A.superseded_at, null);
  const frozenBefore = taskAssetsDirs(dir).slice().sort();

  // 改稿重建:input_hash 变化(A stale),参考图仍为旧内容
  const m2 = readManifest(dir);
  m2.shots[0].prompt_final_en = 'p2';
  m2.shots[0].input_hash = hashForShot(m2.shots[0]);
  writeManifest(dir, m2);

  // 篡改参考图内容 → 冻结副本 hash 与 manifest 记录不一致 → FIX3-1 失败
  fs.writeFileSync(img, 'B');
  const before = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');

  r = runRenderNextCli(dir);
  assert.notStrictEqual(r.status, 0, `frozen-input mismatch must fail the dispatch: ${r.stdout}${r.stderr}`);
  assert.ok(!/superseding stale active task/.test(r.stderr), `failed dispatch must not attempt to supersede: ${r.stderr}`);
  const after = readManifest(dir);
  assert.strictEqual(after.render_tasks.length, m2.render_tasks.length, 'failed dispatch must not add a task');
  const A2 = after.render_tasks.find(t => t.task_id === A.task_id);
  assert.strictEqual(A2.superseded_at, null, 'old task must not be superseded by a failed dispatch');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), before, 'manifest must be byte-identical');
  assert.deepStrictEqual(taskAssetsDirs(dir).slice().sort(), frozenBefore, 'failed dispatch must not leave frozen dir residue');
});

test('FIX6a3. 修好输入后成功派发:旧任务 supersede + 新任务在同一份落盘文件', () => {
  const dir = mkTempDir();
  const img = fix6VideoFixture(dir, 'p', 'A');
  let r = runRenderNextCli(dir);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  const A = readManifest(dir).render_tasks[0];

  const m2 = readManifest(dir);
  m2.shots[0].prompt_final_en = 'p2';
  m2.shots[0].input_hash = hashForShot(m2.shots[0]);
  writeManifest(dir, m2);

  // 先失败一次(参考图篡改),确认不 supersede
  fs.writeFileSync(img, 'B');
  r = runRenderNextCli(dir);
  assert.notStrictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.ok(!/superseding stale active task/.test(r.stderr), `failed dispatch must not attempt to supersede: ${r.stderr}`);
  assert.strictEqual(readManifest(dir).render_tasks.find(t => t.task_id === A.task_id).superseded_at, null, 'failed attempt must leave A intact');

  // 修好输入 → 成功派发
  fs.writeFileSync(img, 'A');
  r = runRenderNextCli(dir);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  const m3 = readManifest(dir);
  const oldA = m3.render_tasks.find(t => t.task_id === A.task_id);
  const newTask = m3.render_tasks.find(t => t.task_id !== A.task_id);
  assert.ok(newTask, 'a new task must exist after the input is fixed');
  assert.ok(oldA.superseded_at, 'old task must be superseded by the successful dispatch');
  assert.strictEqual(oldA.superseded_by, newTask.task_id, 'superseded_by must point at the new task');
  assert.strictEqual(newTask.superseded_at, null, 'new task must be dispatchable');
  assert.strictEqual(m3.render_tasks.length, 2, 'supersede + new task must be written in the same file');
});

// ---- FIX6b: 一对一绑定(含 request-only 单 attempt 分支) ----

function fix6BoundTask() {
  return {
    task_id: 'task-x', shot_id: 's01-shot-01', input_hash: 'h1', status: 'submitted', stage: 'video', breaker_epoch: 0,
    current_attempt_id: 'a1',
    attempts: [{ attempt_id: 'a1', at: '2026-01-01T00:00:00.000Z', input_hash: 'h1', request_id: 'r1' }]
  };
}

test('FIX6b1. request-only 命中已绑别的 request 的 attempt → 抛错、消息含两个 request 与 attempt、零改动', () => {
  const task = fix6BoundTask();
  const manifest = { task_events: [] };
  const before = JSON.stringify({ task, manifest });
  let msg = '';
  try { msResolveAttempt(task, { requestId: 'r2' }, manifest); } catch (e) { msg = e.message; }
  assert.ok(msg.length > 0, 'must throw');
  assert.ok(msg.includes('r1') && msg.includes('r2') && msg.includes('a1'), `message must name both requests and the attempt: ${msg}`);
  assert.strictEqual(JSON.stringify({ task, manifest }), before, 'refusal must not mutate task/manifest');
});

test('FIX6b2. 未绑定 attempt 回填成功且返回值 == 持久值;(a1,r1) 幂等', () => {
  const task = { task_id: 'task-x', input_hash: 'h1', attempts: [{ attempt_id: 'a1', at: 't', input_hash: 'h1', request_id: null }] };
  const r = msResolveAttempt(task, { requestId: 'r1' }, { task_events: [] });
  assert.strictEqual(r.attempt_id, 'a1');
  assert.strictEqual(r.request_id, 'r1');
  assert.strictEqual(task.attempts[0].request_id, 'r1', 'backfill must be persisted on the attempt');
  assert.strictEqual(r.request_id, task.attempts[0].request_id, 'return value must match the persisted field');

  const r2 = msResolveAttempt(task, { requestId: 'r1' }, { task_events: [] });
  assert.strictEqual(r2.attempt_id, 'a1');
  assert.strictEqual(r2.request_id, 'r1');
  assert.strictEqual(task.attempts[0].request_id, 'r1', 'idempotent re-resolve must not change the binding');
});

test('FIX6b3. task_events 命中但 attempt 已绑不同 request → 抛错零改动', () => {
  const task = fix6BoundTask();
  // 事件把 a1 关联到 r2,但 attempts 中 a1 已持久绑定 r1
  const manifest = { task_events: [{ task_id: 'task-x', attempt_id: 'a1', request_id: 'r2', n: 1 }] };
  const before = JSON.stringify({ task, manifest });
  let msg = '';
  try { msResolveAttempt(task, { requestId: 'r2' }, manifest); } catch (e) { msg = e.message; }
  assert.ok(msg.length > 0, 'must throw');
  assert.ok(msg.includes('r1') && msg.includes('r2') && msg.includes('a1'), `message must name both requests and the attempt: ${msg}`);
  assert.strictEqual(JSON.stringify({ task, manifest }), before, 'refusal must not mutate task/manifest');
});

test('FIX6b4. CLI mark-shot --take request-only 冲突 → 非零退出且 manifest 不变', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'v.mp4');
  fs.writeFileSync(vfile, 'v');
  writeManifest(dir, { episode: 'TEST', render_tasks: [fix6BoundTask()], shots: [shotBase('s01-shot-01', { input_hash: 'h1' })] });
  const before = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'mark-shot.js'), dir, 's01-shot-01', '--take', '--task', 'task-x', '--request-id', 'r2', '--path', vfile], { encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.ok(`${r.stdout}${r.stderr}`.includes('r2'), 'error must name the refused request');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), before, 'conflict must leave manifest unchanged');
});

// ---- FIX6c: continue_from 的 attempt 快照须记录完整输入 hash ----

test('FIX6c1. continue_from keyframe 任务:attempt.input_hash == task.input_hash == 含尾帧 hash', () => {
  const dir = mkTempDir();
  m4aManifest(dir);
  const stub = (args) => { fs.writeFileSync(args.outPath, 'TAIL-FRAME-BYTES'); return { durationSec: 10, durationFrames: 300, cutFrame: 297 }; };
  const r = createRenderTask(dir, { extractTailFrame: stub });
  assert.ok(r && r.task.stage === 'keyframe');
  const task = r.task;
  assert.ok(Array.isArray(task.attempts) && task.attempts.length === 1, 'dispatch must append exactly one attempt');
  const m = readManifest(dir);
  const baseHash = m.shots[1].keyframe_hash;
  assert.strictEqual(task.base_input_hash, baseHash, 'base_input_hash is the tail-less keyframe hash');
  assert.notStrictEqual(baseHash, task.input_hash, 'tail ref must change the full hash');
  assert.strictEqual(task.attempts[0].input_hash, task.input_hash, 'attempt must record the full (tail-inclusive) input hash');

  const tailRef = (task.image_refs || []).find(x => (x.hash_role || x.role) === 'upstream_tail:continue_from');
  assert.ok(tailRef, 'task must carry the upstream tail ref');
  const fullHash = computeShotKeyframeHash(
    { prompt_final_en: m.shots[1].prompt_final_en, image_refs: [], ratio: m.shots[1].ratio, resolution: m.shots[1].resolution, model: m.shots[1].model },
    { schemaVersion: 2, styleGuideDigest: styleGuideFileDigest(), upstreamTail: { path: tailRef.frozen_path, cut_frame: tailRef.cut_frame } }
  );
  assert.strictEqual(task.input_hash, fullHash, 'task.input_hash must be the tail-inclusive hash');
  assert.strictEqual(task.attempts[0].input_hash, fullHash, 'attempt.input_hash must be the tail-inclusive hash');
});

test('FIX6c2. 无 continue_from 的普通任务:attempt.input_hash == task.input_hash == expectedHash', () => {
  // keyframe 分支
  const dir = mkTempDir();
  const shot = shotBase('s01-shot-01');
  shot.keyframe_hash = keyframeHashForShot(shot, 2);
  shot.input_hash = hashForShot(shot, 2);
  writeManifest(dir, { episode: 'TEST', schema_version: 2, require_keyframe: true, keyframe_mode: 'reference', fps: 30, shots: [shot], render_tasks: [] });
  const r = createRenderTask(dir, { extractTailFrame: () => { throw new Error('extractTailFrame must not run without continue_from'); } });
  assert.strictEqual(r.task.stage, 'keyframe');
  assert.strictEqual(r.task.input_hash, shot.keyframe_hash);
  assert.strictEqual(r.task.attempts[0].input_hash, r.task.input_hash);
  assert.strictEqual(r.task.attempts[0].input_hash, shot.keyframe_hash);

  // video 分支
  const dir2 = mkTempDir();
  const shot2 = shotBase('s01-shot-01', { image_paths: [] });
  shot2.input_hash = hashForShot(shot2, 2);
  writeManifest(dir2, { episode: 'TEST', schema_version: 2, shots: [shot2] });
  const r2 = createRenderTask(dir2);
  assert.strictEqual(r2.task.stage, 'video');
  assert.strictEqual(r2.task.input_hash, shot2.input_hash);
  assert.strictEqual(r2.task.attempts[0].input_hash, r2.task.input_hash);
  assert.strictEqual(r2.task.attempts[0].input_hash, shot2.input_hash);
});

// ============================================================
console.log('\n[DRAFT] 新集草稿脚手架 + 零成本剧本校验(零 credits)');
// ============================================================
// 全程 os.tmpdir 隔离;真实 episodes/ 目录只读比对(见 DRAFT5)。
const draftYaml = require('js-yaml');
const toolsDir = path.join(ROOT, 'tools');
function runTool(script, args) {
  return spawnSync(process.execPath, [path.join(toolsDir, script), ...args], { encoding: 'utf8' });
}
function draftBaseScript() {
  return {
    schema_version: 2,
    episode: 'E1',
    title: 'T',
    intent: { audio: 'music_sfx', subtitles: 'none' },
    tts: {
      provider: { name: 'doubao', model: 'seed-tts-2.0', version: '2026-09-14' },
      voice_id: 'zh_male_jieshuoxiaoming_uranus_bigtts',
    },
    defaults: { ratio: '16:9', resolution: '720p', duration: 8 },
    scenes: [{
      id: 's01',
      shots: [{ id: 's01-shot-01', style_en: 'x', prompt_en: 'y', description_cn: 'z', duration: 8 }],
    }],
  };
}
function writeDraftScript(dir, obj) {
  fs.writeFileSync(path.join(dir, 'script.yaml'), draftYaml.dump(obj));
}
// 真实 episodes/ 递归清单基线(后续 DRAFT5 比对,确认零生产写入)
const realEpisodesDir = path.join(ROOT, 'episodes');
function listTree(dir) {
  const out = [];
  const walk = (d, prefix) => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      out.push(rel);
      if (fs.statSync(full).isDirectory()) walk(full, rel);
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out;
}
const realEpisodesBaseline = listTree(realEpisodesDir);

// ---- DRAFT1: new-episode 脚手架 ----
console.log('\n[DRAFT1] new-episode 脚手架');
test('DRAFT1a: --draft 生成 3 件产物且模板直接通过 validate-script', () => {
  const root = mkTempDir();
  const r = runTool('new-episode.js', ['--draft', 'demo-episode', '--root', root, '--title', '示例标题']);
  assert.strictEqual(r.status, 0, `new-episode exit ${r.status}: ${r.stderr}`);
  const target = path.join(root, 'episodes', '_drafts', 'demo-episode');
  assert.ok(fs.existsSync(path.join(target, 'script.yaml')), 'script.yaml missing');
  assert.ok(fs.existsSync(path.join(target, 'README.md')), 'README.md missing');
  assert.ok(fs.existsSync(path.join(target, 'shots')) && fs.statSync(path.join(target, 'shots')).isDirectory(), 'shots/ missing');
  const v = runTool('validate-script.js', [target]);
  assert.strictEqual(v.status, 0, `validate-script exit ${v.status}: ${v.stdout}${v.stderr}`);
  assert.ok(!/\[ERROR\]/.test(v.stdout), `template must have no ERROR: ${v.stdout}`);
  assert.ok(r.stdout.includes(target), 'success output must print target path');
  const template = fs.readFileSync(path.join(target, 'script.yaml'), 'utf8');
  assert.ok(/zh_male_[a-z]+_uranus_bigtts/.test(template), 'template voice_id must be a real 2.0 voice (…_uranus_bigtts), not an invented id');
});
test('DRAFT1b: --episode 目标路径为 episodes/<EPISODE-ID>', () => {
  const root = mkTempDir();
  const r = runTool('new-episode.js', ['--episode', 'S99E01', '--root', root]);
  assert.strictEqual(r.status, 0, r.stderr);
  const target = path.join(root, 'episodes', 'S99E01');
  assert.ok(fs.existsSync(path.join(target, 'script.yaml')));
  assert.ok(fs.existsSync(path.join(target, 'README.md')));
  const v = runTool('validate-script.js', [target]);
  assert.strictEqual(v.status, 0, v.stdout + v.stderr);
});
test('DRAFT1c: 目标已存在且非空 → 非零退出且零改动', () => {
  const root = mkTempDir();
  assert.strictEqual(runTool('new-episode.js', ['--draft', 'dup', '--root', root]).status, 0);
  const target = path.join(root, 'episodes', '_drafts', 'dup');
  const before = fs.readFileSync(path.join(target, 'script.yaml'), 'utf8');
  const r = runTool('new-episode.js', ['--draft', 'dup', '--root', root]);
  assert.notStrictEqual(r.status, 0);
  assert.strictEqual(fs.readFileSync(path.join(target, 'script.yaml'), 'utf8'), before, 'must not modify existing target');
});
test('DRAFT1d: 非法 slug(a/b、..、空白)→ 非零退出', () => {
  const root = mkTempDir();
  for (const bad of ['a/b', '..', 'a b', '']) {
    const r = runTool('new-episode.js', ['--draft', bad, '--root', root]);
    assert.notStrictEqual(r.status, 0, `slug ${JSON.stringify(bad)} must be rejected`);
  }
  assert.ok(!fs.existsSync(path.join(root, 'episodes', '_drafts', 'a')), 'no partial dir for illegal slug');
});

// ---- DRAFT2: validate-script 错误面 ----
console.log('\n[DRAFT2] validate-script 错误面');
function expectScriptError(name, mutate, mustMatch) {
  test(name, () => {
    const dir = mkTempDir();
    const s = draftBaseScript();
    mutate(s);
    writeDraftScript(dir, s);
    const r = runTool('validate-script.js', [dir]);
    assert.strictEqual(r.status, 4, `expected exit 4, got ${r.status}: ${r.stdout}${r.stderr}`);
    const out = r.stdout + r.stderr;
    assert.ok(mustMatch.test(out), `message must match ${mustMatch}: ${out}`);
  });
}
expectScriptError('DRAFT2a: 重复 shot id', s => { s.scenes[0].shots.push({ ...s.scenes[0].shots[0] }); }, /duplicate shot id/);
expectScriptError('DRAFT2b: 缺 prompt_en', s => { delete s.scenes[0].shots[0].prompt_en; }, /s01-shot-01.*prompt_en/);
expectScriptError('DRAFT2c: duration=0', s => { s.scenes[0].shots[0].duration = 0; }, /s01-shot-01\.duration/);
expectScriptError('DRAFT2d: shot ratio 与集级不一致', s => { s.scenes[0].shots[0].ratio = '9:16'; }, /s01-shot-01.*ratio/);
expectScriptError('DRAFT2e: continue_from cycle', s => {
  s.scenes[0].shots = [
    { id: 's01-shot-01', style_en: 'x', prompt_en: 'y', description_cn: 'z', duration: 8, continue_from: 's01-shot-02' },
    { id: 's01-shot-02', style_en: 'x', prompt_en: 'y', description_cn: 'z', duration: 8, continue_from: 's01-shot-01' },
  ];
}, /cycle/);
expectScriptError('DRAFT2f: 有对白但 voice 解析不到', s => {
  delete s.tts.voice_id;
  s.intent = { dialogue: true, audio: 'dialogue', subtitles: 'soft' };
  s.scenes[0].shots[0].dialogue = '你好。';
}, /voice_id/);
expectScriptError('DRAFT2g: intent.dialogue=false 但剧本有对白', s => {
  s.intent = { dialogue: false, audio: 'dialogue', subtitles: 'soft' };
  s.scenes[0].shots[0].dialogue = '你好。';
}, /dialogue=false/);
expectScriptError('DRAFT2h: 不支持的 resolution', s => { s.defaults.resolution = '4k'; }, /resolution/);

// ---- DRAFT3: validate-script 警告面(exit 0) ----
console.log('\n[DRAFT3] validate-script 警告面');
function expectScriptWarnings(name, mutate) {
  test(name, () => {
    const dir = mkTempDir();
    const s = draftBaseScript();
    mutate(s);
    writeDraftScript(dir, s);
    const r = runTool('validate-script.js', [dir, '--json']);
    assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}: ${r.stdout}${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(parsed.ok, true);
    assert.ok(parsed.errors.length === 0, `no errors expected: ${JSON.stringify(parsed.errors)}`);
    assert.ok(parsed.warnings.length > 0, 'warnings must be non-empty');
  });
}
expectScriptWarnings('DRAFT3a: duration=45(>30s)', s => { s.scenes[0].shots[0].duration = 45; });
expectScriptWarnings('DRAFT3b: 缺 description_cn', s => { delete s.scenes[0].shots[0].description_cn; });
expectScriptWarnings('DRAFT3c: 对白估时超过 shot duration', s => {
  s.intent = { dialogue: true, audio: 'dialogue', subtitles: 'soft' };
  s.scenes[0].shots[0].duration = 2;
  s.scenes[0].shots[0].dialogue = '这是一段非常长的对白文字内容超过了时长限制';
});
expectScriptWarnings('DRAFT3d: intent.dialogue=true 但无对白', s => {
  s.intent = { dialogue: true, audio: 'music_sfx', subtitles: 'soft' };
});

// ---- DRAFT4: --json 结构 + --build 接线 ----
console.log('\n[DRAFT4] --json 结构 + --build 接线');
test('DRAFT4a: --json 结构稳定(ok/errors/warnings/stats)', () => {
  const dir = mkTempDir();
  writeDraftScript(dir, draftBaseScript());
  const r = runTool('validate-script.js', [dir, '--json']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepStrictEqual(Object.keys(j).sort(), ['errors', 'ok', 'stats', 'warnings']);
  assert.strictEqual(typeof j.ok, 'boolean');
  assert.ok(Array.isArray(j.errors) && Array.isArray(j.warnings));
  assert.strictEqual(typeof j.stats.shots, 'number');
  assert.strictEqual(typeof j.stats.estimated_seconds, 'number');
  assert.strictEqual(typeof j.stats.dialogue_shots, 'number');
});
test('DRAFT4b: --build 在 tmp draft 上生成 manifest.json(退出 0)', () => {
  const root = mkTempDir();
  assert.strictEqual(runTool('new-episode.js', ['--draft', 'build-me', '--root', root]).status, 0);
  const target = path.join(root, 'episodes', '_drafts', 'build-me');
  const r = runTool('validate-script.js', [target, '--build']);
  assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stdout}${r.stderr}`);
  assert.ok(fs.existsSync(path.join(target, 'manifest.json')), 'manifest.json must be generated');
});
test('DRAFT4c: 坏稿 --build 不得写 manifest', () => {
  const dir = mkTempDir();
  const s = draftBaseScript();
  delete s.scenes[0].shots[0].prompt_en;
  writeDraftScript(dir, s);
  const r = runTool('validate-script.js', [dir, '--build']);
  assert.strictEqual(r.status, 4, `expected exit 4, got ${r.status}: ${r.stdout}${r.stderr}`);
  assert.ok(!fs.existsSync(path.join(dir, 'manifest.json')), 'bad script must not produce manifest.json');
});

// ---- DRAFT5: 生产隔离 ----
test('DRAFT5: 全程未在真实 episodes/ 下创建任何文件', () => {
  assert.deepStrictEqual(listTree(realEpisodesDir), realEpisodesBaseline, 'real episodes/ tree must be untouched');
});

// ============================================================
(async () => {
  for (const t of asyncTests) {
    try { await t.fn(); passed++; console.log(`  ✓ ${t.name}`); }
    catch (e) { failed++; console.error(`  ✗ ${t.name}\n    ${e.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
