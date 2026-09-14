const { test, throws, mkTempDir, writeManifest, readManifest, shotBase } = require('./helpers');
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const {
  validateApprovals, collectApprovalProblems, checkApprovalsForEpisode,
  isPassVerdict, isVerdictValue, isApprovalKind, resolveAcceptUpstreamCutFrame
} = require('../approvals');
const { collectEditApprovalProblems } = require('../edit-episode');
const { collectFinalApprovalProblems } = require('../stitch-episode');
const { fileContentHash } = require('../build-manifest');
const { ROOT, loadYaml } = require('../build-prompt');
const {
  detectDialogue, deriveIntent, validateIntent, intentFlags,
} = require('../intent');
const {
  parseProbeJson, probeMedia, expectedVideoSpec, checkMediaSpec, verifyDecode,
  checkAvLength, verifyFinalMedia
} = require('../probe');
const GATE = require('../gate');
const {
  collectGateReport: stitchCollectGateReport,
  gateExitCode: stitchGateExitCode,
} = require('../stitch-episode');

function runBuildManifest(dir, env) {
  return spawnSync(process.execPath, [path.join(ROOT, 'tools', 'build-manifest.js'), dir], {
    encoding: 'utf8', env: env || process.env
  });
}

function ffmpegOk() {
  try {
    const r = spawnSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-version'], { encoding: 'utf8' });
    return !r.error && r.status === 0;
  } catch (_) { return false; }
}
const HAS_FFMPEG = ffmpegOk();

function testFfmpeg(name, fn) {
  if (!HAS_FFMPEG) { console.log(`  - SKIP ${name} (ffmpeg unavailable)`); return; }
  test(name, fn);
}

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
  assert.notStrictEqual(bad.status, 0, 'missing file must exits non-zero');
});

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
