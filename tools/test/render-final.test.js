'use strict';
const { test, throws, mkTempDir, writeManifest, readManifest, shotBase } = require('./helpers');

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const draftYaml = require('js-yaml');

const { ROOT, buildPromptForShot, collectImageRefs } = require('../build-prompt');
const { updateKeyframeManifest, appendKeyframeCatalog } = require('../mark-keyframe');
const { resolveCover, generateCover } = require('../cover');
const SUB = require('../subtitles');
const { createRenderTask, fileContentHash } = require('../render-next');
const { updateManifest, appendCatalog } = require('../mark-shot');
const {
  computeStagePayloadHash, computeShotKeyframeHash, computeShotVideoHash,
  styleGuideFileDigest, verifyManifestFreshness, deriveStatus,
} = require('../build-manifest');
const { buildTimeline } = require('../build-timeline');
const { resolveAttempt: msResolveAttempt } = require('../mark-shot');
const {
  checkDialogueDeclaration,
} = require('../intent');
const { probeMedia } = require('../probe');
const AUD = require('../audio');
const {
  clipRenderArgs: finClipRenderArgs, renderFinal: finRenderFinal,
  detectRenderMode: finDetectRenderMode, determinismDigests: finDeterminismDigests,
  MODE_LINE_V1: FIN_MODE_LINE_V1, MODE_LINE_V2: FIN_MODE_LINE_V2,
} = require('../render-final');
const {
  takeDependencyProblem: gateTakeDependencyProblem,
  evaluateReleaseGate: gateEvaluateReleaseGate,
  collectGateReport: gateCollectGateReport,
  parseSrtCues: gateParseSrtCues,
} = require('../gate');
const { migrateEpisode } = require('../migrate-episode');

// ============================================================
// Local helpers
// ============================================================

function taskAssetsDirs(dir) {
  const d = path.join(dir, '.task-assets');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter(n => fs.statSync(path.join(d, n)).isDirectory());
}

function readCatalog(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

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

function applyShotHashes(shot, schemaVersion = 1) {
  shot.keyframe_hash = keyframeHashForShot(shot, schemaVersion);
  shot.input_hash = hashForShot(shot, schemaVersion);
  return shot;
}

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

function gateItem(result, id) {
  const it = (result.items || []).find(x => x.id === id);
  assert.ok(it, `gate item #${id} must exist (have: ${(result.items || []).map(x => x.id).join(',')})`);
  return it;
}

const GATE_EMPTY_TIMELINE = { fps: 30, clips: [] };

const TTS_INTENT = ['intent:', '  subtitles: burn'];
const TTS_DEFAULTS = ['defaults:', '  duration: 8', "  ratio: '16:9'", "  resolution: '720p'", "  model: 'default'"];

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

// ============================================================
// M3-KF: keyframe pipeline
// ============================================================

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
  const r1 = createRenderTask(dir);
  assert.strictEqual(r1.shot.id, 's01-shot-01');
  assert.strictEqual(r1.task.stage, 'keyframe');
  const r2 = createRenderTask(dir, { videoOnly: true });
  assert.strictEqual(r2.shot.id, 's01-shot-02');
  assert.strictEqual(r2.task.stage, 'video');
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'render-next.js'), dir, '--all'], { encoding: 'utf8' });
  assert.strictEqual(cli.status, 0, cli.stdout + cli.stderr);
  assert.ok(cli.stdout.includes('[stage=keyframe]'), `--all must annotate keyframe stage: ${cli.stdout}`);
  assert.ok(cli.stdout.includes('[stage=video]'), `--all must annotate video stage: ${cli.stdout}`);
  assert.ok(/keyframe:pending/.test(cli.stdout), `--all must annotate pending keyframe: ${cli.stdout}`);
  assert.ok(/keyframe:selected kf-001/.test(cli.stdout), `--all must annotate selected keyframe: ${cli.stdout}`);
});

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

test('MK7. catalog:mark-shot 新条目 stage=video、mark-keyframe 新条目 stage=keyframe', () => {
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

  const dir2 = seedKeyframeTaskDir();
  const kf = path.join(dir2, 'kf.png');
  fs.writeFileSync(kf, 'k');
  const catPath2 = path.join(dir2, 'catalog.json');
  const rk = updateKeyframeManifest(dir2, 's01-shot-01', { action: 'take', taskId: 'task-kf', path: kf, requestId: 'rk' });
  appendKeyframeCatalog(dir2, 's01-shot-01', { action: 'take', taskId: 'task-kf', path: kf, requestId: 'rk' }, rk.manifest, rk.createdTakeId, catPath2);
  const e2 = readCatalog(catPath2).find(e => e.take_id === 'kf-001');
  assert.strictEqual(e2.stage, 'keyframe');
  const selected = updateKeyframeManifest(dir2, 's01-shot-01', { action: 'select', takeId: 'kf-001' });
  appendKeyframeCatalog(dir2, 's01-shot-01', { action: 'select', takeId: 'kf-001' }, selected.manifest, null, catPath2);
  const cat2 = readCatalog(catPath2);
  assert.strictEqual(cat2.find(e => e.take_id === 'kf-001').status, 'selected');
});

test('MK8. resolveCover:clip 绑定 keyframe / 实际首帧 / promo_asset / 缺失报错', () => {
  const kfPath = '/tmp/kf-cover.png';
  const timeline = { fps: 24, clips: [{ clip_id: 'clip-0001', shot_id: 's01-shot-01', take_id: 'take-001', source_in: 0, source_out: 480, deleted_head_frames: 1 }] };

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

  const r2 = resolveCover({
    cover: { clip_id: 'clip-0001' },
    shots: [{ id: 's01-shot-01', takes: [{ id: 'take-001', path: '/tmp/v.mp4' }], keyframe_takes: [] }]
  }, timeline);
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.kind, 'first_frame');
  assert.strictEqual(r2.frame, 1, 'actual first frame = source_in(0) + deleted_head_frames(1)');
  assert.strictEqual(r2.path, '/tmp/v.mp4');

  const r3 = resolveCover({ cover: { promo_asset: '/tmp/promo.png' }, shots: [] }, timeline);
  assert.strictEqual(r3.ok, true);
  assert.strictEqual(r3.kind, 'promo_asset');
  assert.strictEqual(r3.path, '/tmp/promo.png');
  assert.strictEqual(r3.in_hash, false);

  const r4 = resolveCover({ shots: [] }, timeline);
  assert.strictEqual(r4.ok, false);
  assert.ok(/no cover configured/.test(r4.error), r4.error);
});

// ============================================================
// A8: stage payload hash
// ============================================================

function a8Image(dir, name, bytes) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
}

function a8VideoHash(refs, extra = {}) {
  return computeStagePayloadHash(Object.assign({
    stage: 'video', schemaVersion: 2, prompt: 'p', refs, model: 'm',
    params: { ratio: '16:9', resolution: '720p', requested_video_duration: 10 },
    firstFrame: null
  }, extra));
}

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

test('A8b. refs 顺序变化 → hash 变;role 命名空间变化(内容相同)→ hash 变', () => {
  const dir = mkTempDir();
  const a = a8Image(dir, 'a.png', 'AAA');
  const b = a8Image(dir, 'b.png', 'BBB');
  const ab = [{ hash_role: 'character:a', path: a }, { hash_role: 'character:b', path: b }];
  const ba = [{ hash_role: 'character:b', path: b }, { hash_role: 'character:a', path: a }];
  assert.notStrictEqual(a8VideoHash(ab), a8VideoHash(ba), 'order participates in the hash');
  const renamed = [{ hash_role: 'character:a', path: a }, { hash_role: 'character:c', path: b }];
  assert.notStrictEqual(a8VideoHash(ab), a8VideoHash(renamed), 'role namespace must participate even when content is identical');
  assert.strictEqual(a8VideoHash(ab), a8VideoHash(ab));
});

test('A8c. 缺失参考图 → 抛错(fail-closed)且含完整路径', () => {
  const dir = mkTempDir();
  const missing = path.join(dir, 'nope', 'ref.png');
  throws(() => a8VideoHash([{ hash_role: 'character:a', path: missing }]), missing);
  let err = null;
  try { a8VideoHash([{ hash_role: 'character:a', path: missing }]); } catch (e) { err = e; }
  assert.ok(/content digest required/.test(err.message), err.message);
});

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

test('A8g. buildPromptForShot 返回 image_refs(含 hash_role),prompt 人类可读文本不变', () => {
  const dir = mkTempDir();
  const extra = a8Image(dir, 'x.png', 'XX');
  const shot = { id: 's', style_en: 'cinematic', prompt_en: 'a', references: [extra] };
  const r = buildPromptForShot(shot, { id: 'sc' }, { defaults: {} }, {});
  assert.deepStrictEqual(r.image_refs, [{ path: extra, role: 'extra reference', hash_role: 'shot.references[0]' }]);
  assert.strictEqual(r.image_paths[0], extra, 'image_paths 兼容不变');
  assert.ok(r.prompt.includes('<image 1>: extra reference'), `prompt role text unchanged: ${r.prompt}`);
  assert.strictEqual(collectImageRefs(shot, { id: 'sc' })[0].hash_role, 'shot.references[0]');
});

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

  const kfTask = createRenderTask(dir);
  assert.strictEqual(kfTask.task.stage, 'keyframe');
  assert.strictEqual(kfTask.task.input_hash, s0.keyframe_hash, 'keyframe task stores keyframe-stage hash');

  const kfFile = path.join(dir, 'kf.png');
  fs.writeFileSync(kfFile, 'KEYFRAME-BYTES');
  updateKeyframeManifest(dir, 's01-shot-01', { action: 'take', taskId: kfTask.task.task_id, path: kfFile, requestId: 'r1' });
  const sel = updateKeyframeManifest(dir, 's01-shot-01', { action: 'select', takeId: 'kf-001' });
  assert.strictEqual(sel.manifest.shots[0].selected_keyframe, 'kf-001');
  const kfDigest = fileContentHash(kfFile);
  assert.strictEqual(sel.manifest.shots[0].keyframe_takes[0].content_digest, kfDigest);

  const rebuild = runBuildManifest(dir);
  assert.strictEqual(rebuild.status, 0, `${rebuild.stdout}${rebuild.stderr}`);
  const m1 = readManifest(dir);
  const s1 = m1.shots[0];
  assert.notStrictEqual(s1.input_hash, videoHashBefore, 'selected keyframe must change shot.input_hash');
  assert.strictEqual(s1.keyframe_hash, s0.keyframe_hash, 'keyframe-stage hash is independent of keyframe selection');

  const fresh = verifyManifestFreshness(dir);
  assert.strictEqual(fresh.fresh, true, `expected fresh, got ${JSON.stringify(fresh)}`);

  const vTask = createRenderTask(dir);
  assert.strictEqual(vTask.task.stage, 'video');
  assert.strictEqual(vTask.task.input_hash, s1.input_hash);
  assert.ok(vTask.task.keyframe && vTask.task.keyframe.take_id === 'kf-001', 'video task binds selected keyframe');
  assert.strictEqual(vTask.task.keyframe.content_digest, kfDigest);
});

// ============================================================
// AUD: audio
// ============================================================

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

test('AUD1. dialogueSegments:无 trim/有 trim/spill;起点帧→毫秒;measured:false 警告不产段', () => {
  const ttsPath = path.join(mkTempDir(), 'tts-001.mp3');
  const manifest = audManifest([
    { id: 's01', tts_takes: [{ id: 'tts-001', status: 'selected', path: ttsPath }], selected_tts: 'tts-001' },
    { id: 's02', tts_takes: [] },
  ]);
  const timeline = {
    fps: 24,
    cues: [],
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

  assert.strictEqual(AUD.frameToMs(0, 24), 0);
  assert.strictEqual(AUD.frameToMs(1, 24), 42);
  assert.strictEqual(AUD.frameToMs(30, 24), 1250);
  assert.strictEqual(AUD.frameToMs(1, 30), 33);
});

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

  const strict = AUD.cuePlacements({ timeline, epDir: dir, strict: true });
  assert.ok(strict.errors.some(e => /m2/.test(e)), JSON.stringify(strict.errors));

  const bad = AUD.cuePlacements({ timeline: { fps: 24, clips: [], cues: [{ gain_db: 0 }] }, epDir: dir });
  assert.ok(bad.errors.some(e => /id/.test(e)), JSON.stringify(bad.errors));

  const plan = AUD.planProgram({
    manifest: audManifest([]),
    timeline: { fps: 24, clips: [ovfClip({ clip_id: 'clip-0001', output_start: 0, output_end: 24 })], cues: [{ id: 'theme', at: 48 }] },
    epDir: dir,
    strict: false,
  });
  assert.strictEqual(plan.duration_ms, 1000);
  assert.ok(plan.errors.some(e => /exceeds program duration/.test(e)), JSON.stringify(plan.errors));
});

test('AUD3. parseLoudnormJson/loudnormArgs/verifyLoudness 纯函数与边界', () => {
  const raw = '[Parsed_loudnorm_0 @ 0x1]\n{\n"input_i" : "-14.02",\n"input_tp" : "-1.5",\n' +
    '"input_lra" : "0.00",\n"input_thresh" : "-24.30",\n"output_i" : "-14.00",\n"target_offset" : "0.01"\n}\nsize=N/A';
  const parsed = AUD.parseLoudnormJson(raw);
  assert.deepStrictEqual(parsed, { input_i: -14.02, input_tp: -1.5, input_lra: 0, input_thresh: -24.3, target_offset: 0.01 });
  throws(() => AUD.parseLoudnormJson('no json here'), 'not found');
  throws(() => AUD.parseLoudnormJson('{ not json }'), 'parse failed');
  throws(() => AUD.parseLoudnormJson('{"input_i":"-14"}'), 'missing field');
  throws(() => AUD.parseLoudnormJson('{"input_i":"abc","input_tp":"-1","input_lra":"0","input_thresh":"-1","target_offset":"0"}'), 'not a number');

  const first = AUD.loudnormArgs({ input: '/tmp/in.wav' });
  const firstAf = first[first.indexOf('-af') + 1];
  assert.ok(/loudnorm=I=-14:TP=-1:LRA=11/.test(firstAf), firstAf);
  assert.ok(/print_format=json/.test(firstAf), firstAf);
  assert.deepStrictEqual(first.slice(-3), ['-f', 'null', '-']);
  throws(() => AUD.loudnormArgs({ input: '/tmp/in.wav', output: '/tmp/out.wav' }), 'first pass');

  const measured = { input_i: -24, input_tp: -3, input_lra: 6, input_thresh: -34, target_offset: 0.5 };
  const second = AUD.loudnormArgs({ input: '/tmp/in.wav', output: '/tmp/out.m4a', measured });
  const af = second[second.indexOf('-af') + 1];
  assert.ok(/measured_I=-24/.test(af) && /measured_TP=-3/.test(af) && /measured_LRA=6/.test(af), af);
  assert.ok(/measured_thresh=-34/.test(af) && /offset=0.5/.test(af) && /linear=true/.test(af), af);
  assert.ok(second.includes('48000') && second.includes('2'));
  assert.ok(second.includes('aac') && second.includes('192k'));
  assert.strictEqual(second[second.length - 1], '/tmp/out.m4a');
  throws(() => AUD.loudnormArgs({ input: '/tmp/in.wav', measured }), 'requires an output');

  assert.strictEqual(AUD.verifyLoudness({ measured: { input_i: -14, input_tp: -1.5 } }).ok, true);
  assert.strictEqual(AUD.verifyLoudness({ measured: { input_i: -15, input_tp: -1 } }).ok, true, '|-15+14| = 1 恰好达标');
  assert.strictEqual(AUD.verifyLoudness({ measured: { input_i: -13, input_tp: -1 } }).ok, true);
  assert.strictEqual(AUD.verifyLoudness({ measured: { input_i: -15.5, input_tp: -1.5 } }).ok, false);
  assert.strictEqual(AUD.verifyLoudness({ measured: { input_i: -12.5, input_tp: -1.5 } }).ok, false);
  assert.strictEqual(AUD.verifyLoudness({ measured: { input_i: -14, input_tp: -0.8 } }).ok, false, 'TP<=-1');
  const v = AUD.verifyLoudness({ measured: { input_i: -15.5, input_tp: -0.8 } });
  assert.strictEqual(v.problems.length, 2, JSON.stringify(v.problems));
});

testFfmpeg('AUD4. analyzeLoudness:正弦 440Hz 字段齐全;超响信号 fail、达标信号 pass', () => {
  const dir = mkTempDir();
  const hot = genAudio(dir, 'hot.wav', 'sine=frequency=440:sample_rate=48000:duration=3');
  const m = AUD.analyzeLoudness(hot);
  for (const k of ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset']) {
    assert.ok(Number.isFinite(m[k]), `${k} must be a finite number, got ${JSON.stringify(m[k])}`);
  }
  assert.strictEqual(AUD.verifyLoudness({ measured: m }).ok, false, 'full-scale sine is far from -14 LUFS');

  const target = genAudio(dir, 'target.wav', 'sine=frequency=440:sample_rate=48000:duration=3', ['-af', 'volume=7.75dB']);
  const m2 = AUD.analyzeLoudness(target);
  assert.strictEqual(AUD.verifyLoudness({ measured: m2 }).ok, true, JSON.stringify(m2));

  throws(() => AUD.analyzeLoudness(path.join(dir, 'does-not-exist.wav')), 'not found');
});

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

  const spillTl = mkTl();
  spillTl.clips[0].dialogue_spill_ms = 200;
  const spillOut = path.join(dir, 'audio', 'spill.m4a');
  const r2 = AUD.buildProgramAudio({ manifest, timeline: spillTl, epDir: dir, outPath: spillOut });
  assert.strictEqual(r2.duration_ms, 2000, 'spill 只动音频,不改 program 时长');
  const p2 = probeMedia(spillOut);
  assert.ok(Math.abs(p2.format.duration - 2) < 0.1, `spill duration ${p2.format.duration} ≈ 2s`);

  const badDir = mkTempDir();
  const badTl = mkTl();
  badTl.clips[0].sfx = [{ id: 'ghost', at: 3, gain_db: 0 }];
  const badOut = path.join(badDir, 'audio', 'program.m4a');
  throws(() => AUD.buildProgramAudio({ manifest, timeline: badTl, epDir: badDir, outPath: badOut, opts: { strict: true } }), 'source missing');
  assert.ok(!fs.existsSync(badOut), 'strict 缺源不得留半成品');

  const soft = AUD.buildProgramAudio({ manifest, timeline: badTl, epDir: badDir, outPath: path.join(badDir, 'audio', 'soft.m4a'), opts: { strict: false } });
  assert.strictEqual(soft.ok, true);
  assert.ok(soft.warnings.some(w => /ghost/.test(w)), JSON.stringify(soft.warnings));
});

test('AUD6. Gate #10:silent/audio none/opts.loudness 达标与不达标/无来源 fail/注入 analyzeLoudness/offline external', () => {
  const mk = (intent) => ({ schema_version: 2, ratio: '16:9', resolution: '720p', fps: 30, intent });
  const active = { dialogue: false, audio: 'music_sfx', subtitles: 'none', silent: false };

  let r = gateEvaluateReleaseGate({ manifest: mk({ dialogue: false, audio: 'music_sfx', subtitles: 'none', silent: true }), timeline: GATE_EMPTY_TIMELINE });
  assert.strictEqual(gateItem(r, '10').status, 'pass');
  assert.ok(gateItem(r, '10').notes.join(' ').includes('loudnorm: skipped'), JSON.stringify(gateItem(r, '10').notes));

  r = gateEvaluateReleaseGate({ manifest: mk({ dialogue: false, audio: 'none', subtitles: 'none', silent: false }), timeline: GATE_EMPTY_TIMELINE });
  assert.strictEqual(gateItem(r, '10').status, 'not_applicable');

  r = gateEvaluateReleaseGate({ manifest: mk(active), timeline: GATE_EMPTY_TIMELINE, opts: { loudness: { input_i: -14, input_tp: -1.2 } } });
  assert.strictEqual(gateItem(r, '10').status, 'pass', JSON.stringify(gateItem(r, '10').reasons));

  r = gateEvaluateReleaseGate({ manifest: mk(active), timeline: GATE_EMPTY_TIMELINE, opts: { loudness: { input_i: -15.5, input_tp: -0.8 } } });
  assert.strictEqual(gateItem(r, '10').status, 'fail');
  assert.strictEqual(gateItem(r, '10').reasons.length, 2, JSON.stringify(gateItem(r, '10').reasons));

  r = gateEvaluateReleaseGate({ manifest: mk(active), timeline: GATE_EMPTY_TIMELINE });
  assert.strictEqual(gateItem(r, '10').status, 'fail');
  assert.ok(/opts\.loudness/.test(gateItem(r, '10').reasons.join(' ')) && /--final/.test(gateItem(r, '10').reasons.join(' ')), JSON.stringify(gateItem(r, '10').reasons));

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
  r = gateEvaluateReleaseGate({
    manifest: mk(active), timeline: GATE_EMPTY_TIMELINE, finalPath: '/tmp/aud6-final.mp4', mediaResult,
    opts: { analyzeLoudness: () => { calls += 1; return { input_i: -14, input_tp: -2, input_lra: 0, input_thresh: -24, target_offset: 0 }; } },
  });
  assert.strictEqual(gateItem(r, '10').status, 'pass', JSON.stringify(gateItem(r, '10').reasons));
  assert.strictEqual(calls, 1);

  r = gateEvaluateReleaseGate({
    manifest: mk(active), timeline: GATE_EMPTY_TIMELINE, finalPath: '/tmp/aud6-final.mp4', mediaResult,
    opts: { analyzeLoudness: () => { throw new Error('boom'); } },
  });
  assert.strictEqual(gateItem(r, '10').status, 'fail');
  assert.ok(/analysis failed/.test(gateItem(r, '10').reasons.join(' ')), JSON.stringify(gateItem(r, '10').reasons));

  r = gateEvaluateReleaseGate({ manifest: mk(active), timeline: GATE_EMPTY_TIMELINE, opts: { phase: 'offline' } });
  assert.strictEqual(gateItem(r, '10').status, 'external');

  r = gateEvaluateReleaseGate({ manifest: { schema_version: 1, intent: active }, timeline: GATE_EMPTY_TIMELINE });
  assert.strictEqual(gateItem(r, '10').status, 'not_applicable');
});

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

  const tlPlain = buildTimeline({ edit: ovfEdit([{ shot_id: 's01', take_id: 'take-001', source_in: 0, source_out: 24 }]), manifest });
  assert.ok(!Object.prototype.hasOwnProperty.call(tlPlain.clips[0], 'sfx'));
  assert.ok(!Object.prototype.hasOwnProperty.call(tlPlain, 'cues'));

  throws(() => buildTimeline({
    edit: ovfEdit([{ shot_id: 's01', take_id: 'take-001', source_in: 0, source_out: 24, sfx: [{ id: 'hit', at: -1 }] }]),
    manifest,
  }), 'at');
  throws(() => buildTimeline({ edit: ovfEdit([{ shot_id: 's01', take_id: 'take-001', source_in: 0, source_out: 24 }], { cues: [{ at: -1 }] }), manifest }), 'at');
  const tlLegacy = buildTimeline({ edit: ovfEdit([{ shot_id: 's01', take_id: 'take-001', source_in: 0, source_out: 24 }], { cues: [{ at: 1 }] }), manifest });
  assert.deepStrictEqual(tlLegacy.cues, [{ at: 1 }]);
});

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

  const dir2 = mkTempDir();
  writeManifest(dir2, ovfManifest([]));
  const r2 = spawnSync(process.execPath, [cli, dir2], { encoding: 'utf8' });
  assert.notStrictEqual(r2.status, 0, `${r2.stdout}${r2.stderr}`);
  assert.ok(/timeline\.json not found/.test(r2.stderr), r2.stderr);
  assert.ok(!fs.existsSync(path.join(dir2, 'audio', 'program.m4a')));
});

// ============================================================
// SUB: subtitles + cover
// ============================================================

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

function ffmpegHasFilter(name) {
  if (!HAS_FFMPEG) return false;
  const r = spawnSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' });
  if (r.status !== 0) return false;
  return new RegExp(`(^|\\s)${name}(\\s|$)`, 'm').test(r.stdout);
}
const HAS_SUBTITLES_FILTER = ffmpegHasFilter('subtitles');

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
  assert.strictEqual(r.cues[1].start_ms, 1000);
  assert.strictEqual(r.cues[1].end_ms, 2208, 'round(53*1000/24)');
  assert.ok(r.cues[1].end_ms > r.cues[1].start_ms + 800, 'spill 延伸字幕(超过 keep_ms)');
  assert.deepStrictEqual(r.problems, []);
  assert.ok(r.warnings.some(w => /c3/.test(w) && /measured/.test(w)), JSON.stringify(r.warnings));

  const r30 = SUB.subtitleCues({ timeline: { fps: 30, clips: [
    ovfClip({ output_start: 1, output_end: 2, dialogue: { take_id: 't', dialogue_ms: 100, measured: true, text: 'x' } }),
  ] } });
  assert.strictEqual(r30.cues[0].start_ms, 33, 'round(1*1000/30)');
  assert.strictEqual(SUB.frameToMs(1, 30), 33);
  assert.strictEqual(SUB.frameToMs(0, 24), 0);

  const out = SUB.subtitleCues({ timeline: { fps: 24, clips: [
    ovfClip({ output_start: 0, output_end: 24, dialogue: { take_id: 't', dialogue_ms: 2000, measured: true, text: 'x' } }),
  ] }, finalDurationMs: 1000 });
  assert.ok(out.problems.some(p => /outside/.test(p)), JSON.stringify(out.problems));

  const ov = SUB.subtitleCues({ timeline: { fps: 24, clips: [
    ovfClip({ clip_id: 'a', output_start: 0, output_end: 24, dialogue: { take_id: 't', dialogue_ms: 2000, measured: true, text: 'a' } }),
    ovfClip({ clip_id: 'b', output_start: 24, output_end: 48, dialogue: { take_id: 't', dialogue_ms: 200, measured: true, text: 'b' } }),
  ] }, finalDurationMs: 5000 });
  assert.ok(ov.problems.some(p => /overlap/.test(p)), JSON.stringify(ov.problems));

  const empty = SUB.subtitleCues({ timeline: { fps: 24, clips: [
    ovfClip({ output_start: 0, output_end: 24, dialogue: { take_id: 't', dialogue_ms: 500, measured: true, text: '   ' } }),
  ] }, finalDurationMs: 1000 });
  assert.ok(empty.problems.some(p => /empty/.test(p)), JSON.stringify(empty.problems));

  throws(() => SUB.subtitleCues({ timeline: { fps: 0, clips: [] } }), 'fps');
});

test('SUB2. wrapCueText:竖屏 15 字/横屏 22 字、中文标点优先、行首无标点、超长硬切、空文本', () => {
  const long = '一二三四五六七八九十一二三四五六七八九十';
  assert.deepStrictEqual(SUB.wrapCueText(long, { ratio: '9:16' }), ['一二三四五六七八九十一二三四五', '六七八九十']);
  assert.ok(SUB.wrapCueText(long, { ratio: '9:16' }).every(l => l.length <= 15));
  assert.deepStrictEqual(SUB.wrapCueText(long, { ratio: '16:9' }), [long], '横屏 <=22 字不换行');

  const punct = '一二三四五六七八九十，十一十二十三十四十五';
  assert.deepStrictEqual(SUB.wrapCueText(punct, { ratio: '9:16' }), ['一二三四五六七八九十，', '十一十二十三十四十五']);

  const hardPunct = '一二三四五六七八九十一二三四五，六';
  const hp = SUB.wrapCueText(hardPunct, { ratio: '9:16' });
  assert.deepStrictEqual(hp, ['一二三四五六七八九十一二三四五，', '六']);
  assert.ok(hp.every(l => !SUB.BREAK_PUNCTUATION.has(l[0])), JSON.stringify(hp));

  const spaced = 'aaaa bbbb cccc dddd eeee';
  const sp = SUB.wrapCueText(spaced, { ratio: '9:16' });
  assert.ok(sp.length >= 2 && sp.every(l => l.length <= 15 && l.trim() === l), JSON.stringify(sp));
  assert.deepStrictEqual(SUB.wrapCueText('<i>hello</i> world', { ratio: '9:16' }), ['<i>hello</i>', 'world'], '标签边界断行');
  assert.deepStrictEqual(SUB.wrapCueText('<i>hello</i> world', { ratio: '16:9' }), ['<i>hello</i> world']);

  assert.deepStrictEqual(SUB.wrapCueText(''), []);
  assert.deepStrictEqual(SUB.wrapCueText('   '), []);
  assert.deepStrictEqual(SUB.wrapCueText('\n\n'), []);
  throws(() => SUB.wrapCueText(123), 'string');
});

test('SUB3. formatSrt/checkCueAlignment:HH:MM:SS,mmm 与边界(0/1h+);非帧对齐问题提示', () => {
  const srt = SUB.formatSrt([
    { index: 1, start_ms: 0, end_ms: 1000, text: 'a\nb' },
    { index: 2, start_ms: 3661000, end_ms: 3662500, text: 'c' },
  ]);
  assert.ok(srt.startsWith('1\n00:00:00,000 --> 00:00:01,000\na\nb\n\n'), JSON.stringify(srt));
  assert.ok(srt.includes('01:01:01,000 --> 01:01:02,500'), JSON.stringify(srt));
  assert.ok(srt.endsWith('\n'));

  const cues = gateParseSrtCues(srt);
  assert.strictEqual(cues.length, 2);
  assert.strictEqual(cues[1].start, 3661);
  assert.strictEqual(cues[1].end, 3662.5);
  assert.strictEqual(SUB.msToSrtStamp(0), '00:00:00,000');
  assert.strictEqual(SUB.msToSrtStamp(3661000), '01:01:01,000');

  assert.strictEqual(SUB.checkCueAlignment([{ index: 1, start_ms: 0, end_ms: 1000 }], { fps: 24 }).ok, true);
  const bad = SUB.checkCueAlignment([{ index: 1, start_ms: 0, end_ms: 1005 }], { fps: 24 });
  assert.strictEqual(bad.ok, false);
  assert.ok(/frame-aligned/.test(bad.problems.join(' ')) && /24/.test(bad.problems.join(' ')), bad.problems.join(' '));

  const r = SUB.subtitleCues({ timeline: { fps: 24, clips: [
    ovfClip({ output_start: 24, output_end: 48, dialogue: { take_id: 't', dialogue_ms: 733, measured: true, text: 'x' } }),
  ] }, finalDurationMs: 2000 });
  assert.strictEqual(SUB.checkCueAlignment(r.cues, { fps: 24 }).ok, true, JSON.stringify(r.cues));
  throws(() => SUB.checkCueAlignment([], { fps: 0 }), 'fps');
});

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
  const parsed = gateParseSrtCues(fs.readFileSync(res.outPath, 'utf8'));
  assert.strictEqual(parsed.length, 2);
  assert.deepStrictEqual(
    SUB.checkCueAlignment(parsed.map(c => ({ index: c.index, start_ms: Math.round(c.start * 1000), end_ms: Math.round(c.end * 1000) })), { fps: 24 }).problems,
    []
  );

  const g = gateCollectGateReport(dir, manifest);
  assert.strictEqual(gateItem(g, '7').status, 'pass', JSON.stringify(gateItem(g, '7').reasons));

  const bad = { fps: 24, clips: [ovfClip({ output_start: 0, output_end: 24, dialogue: { take_id: 't', dialogue_ms: 2000, measured: true, text: 'x' } })] };
  throws(() => SUB.writeSrt({ epDir: dir, manifest, timeline: bad, finalDurationMs: 1000 }), 'fail-closed');
  const bad2 = { fps: 24, clips: [ovfClip({ output_start: 0, output_end: 24, dialogue: { take_id: 't', dialogue_ms: 500, measured: true, text: '' } })] };
  throws(() => SUB.writeSrt({ epDir: dir, manifest, timeline: bad2, finalDurationMs: 1000 }), 'empty');
});

testFfmpeg('SUB5. burnSubtitles:soft → mov_text 字慕流;burn 无字慕流且尺寸不变;both;失败清理半成品', () => {
  const dir = mkTempDir();
  const video = path.join(dir, 'v.mp4');
  let r0 = spawnSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:d=1:r=24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video], { encoding: 'utf8' });
  assert.strictEqual(r0.status, 0, r0.stderr);
  const srt = path.join(dir, 'a.srt');
  fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:00,500\nHello\n\n');

  const soft = path.join(dir, 'soft.mp4');
  const rs = SUB.burnSubtitles({ input: video, srtPath: srt, output: soft, mode: 'soft' });
  assert.strictEqual(rs.ok, true);
  assert.ok(fs.existsSync(soft));
  const softStreams = ffprobeStreams(soft);
  assert.ok(softStreams.some(s => s.codec_type === 'subtitle' && s.codec_name === 'mov_text'), JSON.stringify(softStreams));
  const softArgs = SUB.softSubtitlesArgs({ input: video, srtPath: srt, output: soft });
  assert.ok(softArgs.includes('copy') && softArgs.includes('mov_text'));

  const nope = path.join(dir, 'nope.mp4');
  const half = path.join(dir, 'half.mp4');
  throws(() => SUB.burnSubtitles({ input: nope, srtPath: srt, output: half, mode: 'burn' }), 'input not found');
  assert.ok(!fs.existsSync(half));
  throws(() => SUB.burnSubtitles({ input: video, srtPath: srt, output: half, mode: 'bogus' }), 'mode');

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

testFfmpeg('SUB6. generateCover:keyframe/first_frame(source_in+deleted_head_frames)/promo_asset;缺失抛错', () => {
  const dir = mkTempDir();
  const kf = genImage(dir, 'kf.png', 'color=c=green:s=32x32');
  const twoFrame = subColorFramesVideo(dir, 'two.mp4', { fps: 24 });
  const promoJpg = genImage(dir, 'promo.jpg', 'color=c=0x0000ff:s=32x32');
  const clip = (over = {}) => Object.assign({
    clip_id: 'clip-0001', shot_id: 's01', take_id: 'take-001', source_in: 0, source_out: 24,
    deleted_head_frames: 1, padding_frames: 0, output_start: 0, output_end: 24,
  }, over);

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

  const mFf = { fps: 24, cover: { clip_id: 'clip-0001' }, shots: [{ id: 's01', takes: [{ id: 'take-001', path: twoFrame }], keyframe_takes: [] }] };
  const outFf = path.join(dir, 'cover-ff.png');
  g = generateCover({ manifest: mFf, timeline: { fps: 24, clips: [clip()] }, outPath: outFf });
  assert.strictEqual(g.kind, 'first_frame');
  assert.strictEqual(g.frame, 1);
  assert.ok(fs.existsSync(outFf));
  px = readPixelRgb(outFf);
  assert.ok(px[2] > 128 && px[2] > px[0] && px[2] > px[1], `frame 1 should be blue, got ${px}`);

  const mPromo = { fps: 24, cover: { promo_asset: promoJpg }, shots: [] };
  const outPromo = path.join(dir, 'cover-promo.png');
  g = generateCover({ manifest: mPromo, timeline: { fps: 24, clips: [] }, outPath: outPromo });
  assert.strictEqual(g.kind, 'promo_asset');
  assert.ok(fs.existsSync(outPromo));
  px = readPixelRgb(outPromo);
  assert.ok(px[2] > 128 && px[2] > px[1], `promo should be blue, got ${px}`);

  const mMiss = { fps: 24, cover: { promo_asset: path.join(dir, 'no.png') }, shots: [] };
  const outMiss = path.join(dir, 'cover-miss.png');
  throws(() => generateCover({ manifest: mMiss, timeline: { fps: 24, clips: [] }, outPath: outMiss }), 'missing/unreadable');
  assert.ok(!fs.existsSync(outMiss));
  throws(() => generateCover({ manifest: { fps: 24, shots: [] }, timeline: { fps: 24, clips: [] }, outPath: outMiss }), 'no cover configured');
});

test('SUB7. Gate #11:opts.artifacts.cover 存在 pass/缺失 fail;不传保持现有(resolveCover)', () => {
  const dir = mkTempDir();
  const cover = path.join(dir, 'cover.png');
  fs.writeFileSync(cover, 'x');
  const manifest = { schema_version: 2 };

  let r = gateEvaluateReleaseGate({ manifest, timeline: GATE_EMPTY_TIMELINE, artifacts: { cover } });
  assert.strictEqual(gateItem(r, '11').status, 'pass', JSON.stringify(gateItem(r, '11')));
  assert.ok(/cover artifact/.test(gateItem(r, '11').notes.join(' ')));

  r = gateEvaluateReleaseGate({ manifest, timeline: GATE_EMPTY_TIMELINE, artifacts: { cover: path.join(dir, 'nope.png') } });
  assert.strictEqual(gateItem(r, '11').status, 'fail');
  assert.ok(/cover artifact not found/.test(gateItem(r, '11').reasons.join(' ')), JSON.stringify(gateItem(r, '11').reasons));

  r = gateEvaluateReleaseGate({ manifest, timeline: GATE_EMPTY_TIMELINE, artifacts: {} });
  assert.strictEqual(gateItem(r, '11').status, 'fail');
});

test('SUB8. 生产不漂移:只读校验(不写生产目录/不改 manifest 字节)', () => {
  const epDir = path.join(ROOT, 'episodes', 'S01E01-pov');
  const manifestPath = path.join(epDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) { console.log('    (production fixture absent -- skipped)'); return; }
  const before = fs.readFileSync(manifestPath);
  const srtBefore = fs.existsSync(path.join(epDir, 'episode.srt'));
  const coverBefore = fs.existsSync(path.join(epDir, 'cover.png'));
  const manifest = JSON.parse(before.toString('utf8'));

  const rc = resolveCover(manifest, { fps: 24, clips: [] });
  assert.strictEqual(rc.ok, false);
  const cues = SUB.subtitleCues({ manifest, timeline: { fps: 24, clips: [] }, finalDurationMs: 0 });
  assert.deepStrictEqual(cues.cues, []);
  assert.deepStrictEqual(cues.problems, []);

  assert.ok(before.equals(fs.readFileSync(manifestPath)), 'manifest.json must not change');
  assert.strictEqual(fs.existsSync(path.join(epDir, 'episode.srt')), srtBefore);
  assert.strictEqual(fs.existsSync(path.join(epDir, 'cover.png')), coverBefore);
});

// ============================================================
// FIN: render-final
// ============================================================

const FIN_BASE_CLIP = {
  clip_id: 'c1', shot_id: 's01', take_id: 'take-001',
  source_in: 30, source_out: 60, deleted_head_frames: 0, padding_frames: 0,
};

test('FIN1. clipRenderArgs 纯函数:入点/删帧右移/-frames:v/tpad/确定性参数/CFR 链', () => {
  const argv = finClipRenderArgs({ clip: FIN_BASE_CLIP, takePath: '/in.mp4', fps: 30, width: 240, height: 240, srcDurationFrames: 90, outPath: '/out.mp4' });
  assert.ok(Array.isArray(argv));
  assert.strictEqual(argv[argv.length - 1], '/out.mp4');
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

  const argv2 = finClipRenderArgs({ clip: Object.assign({}, FIN_BASE_CLIP, { deleted_head_frames: 15 }), takePath: '/in.mp4', fps: 30, width: 240, height: 240, outPath: '/o2.mp4' });
  assert.strictEqual(Number(argv2[argv2.indexOf('-ss') + 1]), 1.5, 'deleted_head_frames must shift the in-point');
  assert.strictEqual(argv2[argv2.indexOf('-frames:v') + 1], '15');

  const argv3 = finClipRenderArgs({ clip: Object.assign({}, FIN_BASE_CLIP, { padding_frames: 15 }), takePath: '/in.mp4', fps: 30, width: 240, height: 240, outPath: '/o3.mp4' });
  assert.ok(/tpad=stop_mode=clone:stop_duration=0\.5/.test(argv3[argv3.indexOf('-vf') + 1]), argv3[argv3.indexOf('-vf') + 1]);
  assert.strictEqual(argv3[argv3.indexOf('-frames:v') + 1], '45');

  throws(() => finClipRenderArgs({ clip: FIN_BASE_CLIP, takePath: '/i', fps: 30, width: 240, height: 240, srcDurationFrames: 45, outPath: '/o' }), 'exceeds source duration');
  throws(() => finClipRenderArgs({ clip: Object.assign({}, FIN_BASE_CLIP, { deleted_head_frames: 30 }), takePath: '/i', fps: 30, width: 240, height: 240, outPath: '/o' }), 'output length');
  throws(() => finClipRenderArgs({ clip: FIN_BASE_CLIP, takePath: '/i', fps: 0, width: 240, height: 240, outPath: '/o' }), 'positive integer');
  throws(() => finClipRenderArgs({ clip: FIN_BASE_CLIP, takePath: '/i', fps: 30, width: 3, height: 240, outPath: '/o' }), 'even');
});

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

testFfmpeg('FIN2. 帧精确:入点/删帧右移/静帧补长(单像素取值)', () => {
  const dir = mkTempDir();
  const src = finColorSource(dir, 'src.mp4', 240);
  const promo = genImage(dir, 'promo.png', 'color=c=yellow:s=240x240');
  const manifest = finManifest(dir, src, { promo });
  const mkClip = (over) => Object.assign({ clip_id: 'c1', shot_id: 's01', take_id: 'take-001', source_in: 30, source_out: 60, deleted_head_frames: 0, padding_frames: 0 }, over);

  let out = path.join(dir, 'a.mp4');
  finRenderFinal({ absEpDir: dir, manifest, timeline: { version: 1, fps: 30, clips: [mkClip({ output_start: 0, output_end: 30 })] }, outPath: out, opts: { skipCover: true } });
  assert.strictEqual(finProbeFrames(out), 30);
  assert.ok(finIsGreen(finFrameRGB(out, 0)), 'first frame must be green');
  assert.ok(finIsGreen(finFrameRGB(out, 29)), 'last frame must be green');

  out = path.join(dir, 'b.mp4');
  finRenderFinal({ absEpDir: dir, manifest, timeline: { version: 1, fps: 30, clips: [mkClip({ deleted_head_frames: 15, output_start: 0, output_end: 15 })] }, outPath: out, opts: { skipCover: true } });
  assert.strictEqual(finProbeFrames(out), 15);
  assert.ok(finIsGreen(finFrameRGB(out, 0)), 'deleted head must start green (frames 45..59)');

  out = path.join(dir, 'c.mp4');
  finRenderFinal({ absEpDir: dir, manifest, timeline: { version: 1, fps: 30, clips: [mkClip({ padding_frames: 15, output_start: 0, output_end: 45 })] }, outPath: out, opts: { skipCover: true } });
  assert.strictEqual(finProbeFrames(out), 45);
  assert.ok(finIsGreen(finFrameRGB(out, 44)), 'padding must freeze the last in-range frame (green, not blue)');
});

testFfmpeg('FIN3. 多 clip + padding 混合:总帧数 == sum output_len;A/V <100ms(program 静音基床)', () => {
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
  fs.mkdirSync(path.join(dir, 'audio'), { recursive: true });
  AUD.buildProgramAudio({ manifest, timeline, epDir: dir, outPath: path.join(dir, 'audio', 'program.m4a') });

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

testFfmpeg('FIN4. 字幕接入:soft / burn 无 libass 降级 / none', () => {
  const dir = mkTempDir();
  const src = finColorSource(dir, 'src.mp4', 240);
  const promo = genImage(dir, 'promo.png', 'color=c=yellow:s=240x240');
  fs.writeFileSync(path.join(dir, 'episode.srt'), '1\n00:00:00,000 --> 00:00:00,500\nHello\n\n');
  const timeline = { version: 1, fps: 30, clips: [{ clip_id: 'c1', shot_id: 's01', take_id: 'take-001', source_in: 30, source_out: 60, deleted_head_frames: 0, padding_frames: 0, output_start: 0, output_end: 30 }] };
  const mk = (subtitles) => finManifest(dir, src, { promo, intent: { dialogue: false, audio: 'none', subtitles, silent: false } });
  const hasLibass = SUB.hasSubtitlesFilter();

  let out = path.join(dir, 'soft.mp4');
  let r = finRenderFinal({ absEpDir: dir, manifest: mk('soft'), timeline, outPath: out, opts: { skipCover: true } });
  assert.strictEqual(r.subtitles, 'soft');
  assert.strictEqual(finSubtitleCodec(out), 'mov_text');

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

  out = path.join(dir, 'none.mp4');
  r = finRenderFinal({ absEpDir: dir, manifest: mk('none'), timeline, outPath: out, opts: { skipCover: true } });
  assert.strictEqual(r.subtitles, null);
  assert.strictEqual(finSubtitleCodec(out), null);
});

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

  const dir2 = mkTempDir();
  const src2 = finColorSource(dir2, 'src.mp4', 240);
  const manifest2 = finManifest(dir2, src2, { promo: genImage(dir2, 'promo.png', 'color=c=yellow:s=240x240') });
  const r2 = finRenderFinal({ absEpDir: dir2, manifest: manifest2, timeline, outPath: path.join(dir2, 'out.mp4'), opts: { skipCover: true } });
  assert.strictEqual(r2.cover, null);
  assert.ok(!fs.existsSync(path.join(dir2, 'cover.png')), 'skipCover must not write cover.png');
});

test('FIN6. 缺件 fail-closed:audio/srt/take;失败后 outPath 不存在', () => {
  const dir = mkTempDir();
  const takeFile = path.join(dir, 'take.mp4');
  fs.writeFileSync(takeFile, 'x');
  const clip = { clip_id: 'c1', shot_id: 's01', take_id: 'take-001', source_in: 0, source_out: 30, deleted_head_frames: 0, padding_frames: 0, output_start: 0, output_end: 30 };
  const timeline = { version: 1, fps: 30, clips: [clip] };
  const mk = (intent, takePath) => finManifest(dir, takePath, { promo: path.join(dir, 'p.png'), intent });

  let out = path.join(dir, 'a.mp4');
  throws(() => finRenderFinal({ absEpDir: dir, manifest: mk({ dialogue: false, audio: 'music_sfx', subtitles: 'none', silent: false }, takeFile), timeline, outPath: out, opts: { skipCover: true } }), 'tools/audio.js');
  assert.ok(!fs.existsSync(out), 'failed render must not leave outPath');

  out = path.join(dir, 'b.mp4');
  throws(() => finRenderFinal({ absEpDir: dir, manifest: mk({ dialogue: true, audio: 'none', subtitles: 'burn', silent: false }, takeFile), timeline, outPath: out, opts: { skipCover: true } }), 'tools/subtitles.js');
  assert.ok(!fs.existsSync(out));

  out = path.join(dir, 'c.mp4');
  throws(() => finRenderFinal({ absEpDir: dir, manifest: mk({ dialogue: false, audio: 'none', subtitles: 'none', silent: false }, path.join(dir, 'missing.mp4')), timeline, outPath: out, opts: { skipCover: true } }), 'take file missing');
  assert.ok(!fs.existsSync(out));

  out = path.join(dir, 'd.mp4');
  const mRej = mk({ dialogue: false, audio: 'none', subtitles: 'none', silent: false }, takeFile);
  mRej.shots[0].takes[0].status = 'rejected';
  throws(() => finRenderFinal({ absEpDir: dir, manifest: mRej, timeline, outPath: out, opts: { skipCover: true } }), 'rejected');
  assert.ok(!fs.existsSync(out));

  out = path.join(dir, 'e.mp4');
  throws(() => finRenderFinal({ absEpDir: dir, manifest: mk({ dialogue: false, audio: 'none', subtitles: 'none', silent: false }, takeFile), timeline: { version: 1, fps: 24, clips: [clip] }, outPath: out, opts: { skipCover: true } }), 'does not match');
  assert.ok(!fs.existsSync(out));
});

testFfmpeg('FIN7. 确定性:两次出片视频/音频摘要相等;determinism.js CLI 退出 0', () => {
  const dir = mkTempDir();
  const src = finColorSource(dir, 'src.mp4', 240);
  const promo = genImage(dir, 'promo.png', 'color=c=yellow:s=240x240');
  const manifest = finManifest(dir, src, { promo, intent: { dialogue: false, audio: 'music_sfx', subtitles: 'none', silent: false } });
  const timeline = { version: 1, fps: 30, clips: [{ clip_id: 'c1', shot_id: 's01', take_id: 'take-001', source_in: 30, source_out: 60, deleted_head_frames: 0, padding_frames: 0, output_start: 0, output_end: 30 }] };
  fs.mkdirSync(path.join(dir, 'audio'), { recursive: true });
  AUD.buildProgramAudio({ manifest, timeline, epDir: dir, outPath: path.join(dir, 'audio', 'program.m4a') });
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
// FIX5: v2 export/bind/intent/scheduling/migration
// ============================================================

// ---- FIX5a: v2 export must go through full asset verification ----

test('FIX5a1. takeDependencyProblem:hash mismatch/rejected/human reject/blocked/superseded without reuse -> problem;reuse/human accept exempt', () => {
  const shot = shotBase('s01-shot-01', { input_hash: 'h_new' });
  const where = 'clip c1';
  assert.ok(gateTakeDependencyProblem({}, shot, { id: 'take-001', status: 'selected', input_hash: 'h_old' }, where).length > 0, 'hash mismatch must be a problem');
  assert.ok(gateTakeDependencyProblem({}, shot, { id: 'take-001', status: 'rejected', input_hash: 'h_new' }, where).length > 0, 'rejected take must be a problem');
  assert.ok(gateTakeDependencyProblem({}, shot, { id: 'take-001', status: 'selected', input_hash: 'h_new', human_review: { conclusion: 'reject', reviewed_input_hash: 'h_new' } }, where).length > 0, 'human reject must be a problem');
  const blockedShot = shotBase('s01-shot-01', { status: 'blocked', input_hash: 'h_new' });
  assert.ok(gateTakeDependencyProblem({}, blockedShot, { id: 'take-001', status: 'selected', input_hash: 'h_new' }, where).length > 0, 'blocked shot must be a problem');
  const manifestSup = { render_tasks: [{ task_id: 't1', shot_id: shot.id, status: 'submitted', superseded_at: '2026-01-01T00:00:00.000Z' }] };
  assert.ok(gateTakeDependencyProblem(manifestSup, shot, { id: 'take-001', status: 'candidate', task_id: 't1', input_hash: 'h_new' }, where).length > 0, 'superseded task without reuse_record must be a problem');
  const manifestReuse = { reuse_records: [{ take_id: 'take-001', reason: 'fingerprint_recurrence', bound_input_hash: 'h_new' }] };
  assert.strictEqual(gateTakeDependencyProblem(manifestReuse, shot, { id: 'take-001', status: 'candidate', input_hash: 'h_old' }, where).length, 0, 'valid reuse_record must be exempt');
  assert.strictEqual(gateTakeDependencyProblem({}, shot, { id: 'take-001', status: 'candidate', input_hash: 'h_old', human_review: { conclusion: 'accept', reviewed_input_hash: 'h_new' } }, where).length, 0, 'human accept must be exempt');
});

testFfmpeg('FIX5a2. renderFinal pre-flight:take.input_hash mismatch -> throw + no output;consistent -> render OK', () => {
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

testFfmpeg('FIX5a3. edit-episode CLI v2:bad material -> exit 4 no output;good -> exit 0 + v2 timeline render', () => {
  const dir = mkTempDir();
  const src = finColorSource(dir, 'src.mp4', 240);
  const promo = genImage(dir, 'promo.png', 'color=c=yellow:s=240x240');
  fix5V2Episode(dir, { src, promo, takeHash: 'h_bad' });
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

// ---- FIX5c: request must not bind to two attempts ----

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

test('FIX5c1. resolveAttempt bidirectional unique mapping:(a2,r1)/(a1,r2) throw;(a1,r1)/(a2,r2) ok', () => {
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

test('FIX5c2. resolveAttempt conflict throw -> zero mutations', () => {
  const task = fix5TwoAttemptTask();
  const manifest = { task_events: [{ task_id: 'task-x', attempt_id: 'a1', request_id: 'r1', n: 1 }] };
  const before = JSON.stringify({ task, manifest });
  throws(() => msResolveAttempt(task, { attemptId: 'a2', requestId: 'r1' }, manifest), 'r1');
  assert.strictEqual(JSON.stringify({ task, manifest }), before, 'conflict must not mutate task/manifest');
});

test('FIX5c3. CLI mark-shot --take conflict -> non-zero exit + manifest unchanged', () => {
  const dir = mkTempDir();
  const vfile = path.join(dir, 'v.mp4');
  fs.writeFileSync(vfile, 'v');
  writeManifest(dir, { episode: 'TEST', render_tasks: [fix5TwoAttemptTask()], shots: [shotBase('s01-shot-01', { input_hash: 'h1' })] });
  const before = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'mark-shot.js'), dir, 's01-shot-01', '--take', '--task', 'task-x', '--attempt-id', 'a2', '--request-id', 'r1', '--path', vfile], { encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), before, 'conflict must leave manifest unchanged');
});

// ---- FIX5b: dialogue=false must not hide real dialogue ----

test('FIX5b1. checkDialogueDeclaration:false+has dialogue -> error;true+no dialogue / consistent -> ok', () => {
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

test('FIX5b2. build-manifest CLI:dialogue:false + actual dialogue -> exit 4 + no manifest written', () => {
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

test('FIX5b3. gate:intent.dialogue=false + dialogue -> #6/#7 both fail;no dialogue -> still n/a', () => {
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

// ---- FIX5d: re-scripted rendering shots can be rescheduled ----

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

test('FIX5d1. deriveStatus rendering four cases:hash match->rendering;hash changed/no task->stale/pending', () => {
  const shotSelected = { id: 's01', prev_hash: null, selected_take: 'take-001', takes: [{ id: 'take-001', status: 'selected', input_hash: 'old' }] };
  const shotEmpty = { id: 's01', prev_hash: null, selected_take: null, takes: [] };
  assert.strictEqual(deriveStatus(shotSelected, 'H', 'rendering', { activeTask: { input_hash: 'H' } }).status, 'rendering');
  assert.strictEqual(deriveStatus(shotSelected, 'H', 'rendering', { activeTask: { input_hash: 'OLD' } }).status, 'stale');
  assert.strictEqual(deriveStatus(shotEmpty, 'H', 'rendering', { activeTask: null }).status, 'pending');
  assert.strictEqual(deriveStatus(shotSelected, 'H', 'rendering', { activeTask: { input_hash: null, base_input_hash: 'H' } }).status, 'rendering');
});

test('FIX5d2. build-manifest:rendering + active task hash changed->stale;unchanged->rendering;no task->stale', () => {
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

test('FIX5d3. after rebuild render-next can create new task for the shot and old task is superseded (integrated, no network)', () => {
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

// ---- FIX5e: migration judges per file independently ----

test('FIX5e1. script=2/manifest=1 -> only migrate manifest;script content unchanged', () => {
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

test('FIX5e2. manifest=2/script=1 -> only migrate script;manifest content unchanged', () => {
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

test('FIX5e3. any version > to -> error and both files unchanged', () => {
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

test('FIX5e4. both files=2 -> no-op and content/mtime unchanged', () => {
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
// FIX6: supersede/binding/attempt
// ============================================================

function runRenderNextCli(dir, args = []) {
  return spawnSync(process.execPath, [path.join(ROOT, 'tools', 'render-next.js'), dir, ...args], { encoding: 'utf8' });
}

// ---- FIX6a: dispatch failure must not permanently supersede old task ----

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

function fix6VideoFixture(dir, prompt = 'p', imgBytes = 'A') {
  const img = path.join(dir, 'ref.jpg');
  fs.writeFileSync(img, imgBytes);
  const shot = shotBase('s01-shot-01', { image_paths: [img] });
  shot.prompt_final_en = prompt;
  shot.input_hash = hashForShot(shot);
  writeManifest(dir, { episode: 'TEST', shots: [shot] });
  return img;
}

test('FIX6a1. tts dispatch validation failure must not supersede old task / no disk change', () => {
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

  fs.writeFileSync(path.join(dir, 'script.yaml'), fix6TtsScript('hello world, changed'));
  r = runBuildManifest(dir);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  const snapshot = readManifest(dir);
  assert.strictEqual(snapshot.render_tasks.length, 1);
  assert.strictEqual(snapshot.render_tasks[0].superseded_at, null, 'rebuild must not supersede the task');
  assert.notStrictEqual(snapshot.shots[0].tts_hash, A.input_hash, 'fixture must change the tts fingerprint');

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

test('FIX6a2. frozen ref image / FIX3-1 failure must not supersede old task / no disk change', () => {
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

  const m2 = readManifest(dir);
  m2.shots[0].prompt_final_en = 'p2';
  m2.shots[0].input_hash = hashForShot(m2.shots[0]);
  writeManifest(dir, m2);

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

test('FIX6a3. after fixing input, dispatch succeeds:old task superseded + new task in same file', () => {
  const dir = mkTempDir();
  const img = fix6VideoFixture(dir, 'p', 'A');
  let r = runRenderNextCli(dir);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  const A = readManifest(dir).render_tasks[0];

  const m2 = readManifest(dir);
  m2.shots[0].prompt_final_en = 'p2';
  m2.shots[0].input_hash = hashForShot(m2.shots[0]);
  writeManifest(dir, m2);

  fs.writeFileSync(img, 'B');
  r = runRenderNextCli(dir);
  assert.notStrictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.ok(!/superseding stale active task/.test(r.stderr), `failed dispatch must not attempt to supersede: ${r.stderr}`);
  assert.strictEqual(readManifest(dir).render_tasks.find(t => t.task_id === A.task_id).superseded_at, null, 'failed attempt must leave A intact');

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

// ---- FIX6b: one-to-one binding (including request-only single attempt branch) ----

function fix6BoundTask() {
  return {
    task_id: 'task-x', shot_id: 's01-shot-01', input_hash: 'h1', status: 'submitted', stage: 'video', breaker_epoch: 0,
    current_attempt_id: 'a1',
    attempts: [{ attempt_id: 'a1', at: '2026-01-01T00:00:00.000Z', input_hash: 'h1', request_id: 'r1' }]
  };
}

test('FIX6b1. request-only hitting attempt bound to another request -> throw, message names both requests and attempt, zero mutations', () => {
  const task = fix6BoundTask();
  const manifest = { task_events: [] };
  const before = JSON.stringify({ task, manifest });
  let msg = '';
  try { msResolveAttempt(task, { requestId: 'r2' }, manifest); } catch (e) { msg = e.message; }
  assert.ok(msg.length > 0, 'must throw');
  assert.ok(msg.includes('r1') && msg.includes('r2') && msg.includes('a1'), `message must name both requests and the attempt: ${msg}`);
  assert.strictEqual(JSON.stringify({ task, manifest }), before, 'refusal must not mutate task/manifest');
});

test('FIX6b2. unbound attempt backfill succeeds and return value == persisted value;(a1,r1) idempotent', () => {
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

test('FIX6b3. task_events hits but attempt already bound to different request -> throw zero mutations', () => {
  const task = fix6BoundTask();
  const manifest = { task_events: [{ task_id: 'task-x', attempt_id: 'a1', request_id: 'r2', n: 1 }] };
  const before = JSON.stringify({ task, manifest });
  let msg = '';
  try { msResolveAttempt(task, { requestId: 'r2' }, manifest); } catch (e) { msg = e.message; }
  assert.ok(msg.length > 0, 'must throw');
  assert.ok(msg.includes('r1') && msg.includes('r2') && msg.includes('a1'), `message must name both requests and the attempt: ${msg}`);
  assert.strictEqual(JSON.stringify({ task, manifest }), before, 'refusal must not mutate task/manifest');
});

test('FIX6b4. CLI mark-shot --take request-only conflict -> non-zero exit + manifest unchanged', () => {
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

// ---- FIX6c: continue_from attempt snapshot must record complete input hash ----

test('FIX6c1. continue_from keyframe task:attempt.input_hash == task.input_hash == tail-inclusive hash', () => {
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

test('FIX6c2. normal task without continue_from:attempt.input_hash == task.input_hash == expectedHash', () => {
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
// DRAFT: new-episode scaffold + zero-cost script validation
// ============================================================

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

// ---- DRAFT1: new-episode scaffold ----

test('DRAFT1a: --draft generates 3 artifacts and template passes validate-script', () => {
  const root = mkTempDir();
  const r = runTool('new-episode.js', ['--draft', 'demo-episode', '--root', root, '--title', 'example title']);
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
  assert.ok(/zh_male_[a-z]+_uranus_bigtts/.test(template), 'template voice_id must be a real 2.0 voice (..._uranus_bigtts), not an invented id');
});
test('DRAFT1b: --episode target path is episodes/<EPISODE-ID>', () => {
  const root = mkTempDir();
  const r = runTool('new-episode.js', ['--episode', 'S99E01', '--root', root]);
  assert.strictEqual(r.status, 0, r.stderr);
  const target = path.join(root, 'episodes', 'S99E01');
  assert.ok(fs.existsSync(path.join(target, 'script.yaml')));
  assert.ok(fs.existsSync(path.join(target, 'README.md')));
  const v = runTool('validate-script.js', [target]);
  assert.strictEqual(v.status, 0, v.stdout + v.stderr);
});
test('DRAFT1c: target exists and non-empty -> non-zero exit + zero changes', () => {
  const root = mkTempDir();
  assert.strictEqual(runTool('new-episode.js', ['--draft', 'dup', '--root', root]).status, 0);
  const target = path.join(root, 'episodes', '_drafts', 'dup');
  const before = fs.readFileSync(path.join(target, 'script.yaml'), 'utf8');
  const r = runTool('new-episode.js', ['--draft', 'dup', '--root', root]);
  assert.notStrictEqual(r.status, 0);
  assert.strictEqual(fs.readFileSync(path.join(target, 'script.yaml'), 'utf8'), before, 'must not modify existing target');
});
test('DRAFT1d: illegal slug (a/b, .., whitespace, empty) -> non-zero exit', () => {
  const root = mkTempDir();
  for (const bad of ['a/b', '..', 'a b', '']) {
    const r = runTool('new-episode.js', ['--draft', bad, '--root', root]);
    assert.notStrictEqual(r.status, 0, `slug ${JSON.stringify(bad)} must be rejected`);
  }
  assert.ok(!fs.existsSync(path.join(root, 'episodes', '_drafts', 'a')), 'no partial dir for illegal slug');
});

// ---- DRAFT2: validate-script error surface ----

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
expectScriptError('DRAFT2a: duplicate shot id', s => { s.scenes[0].shots.push({ ...s.scenes[0].shots[0] }); }, /duplicate shot id/);
expectScriptError('DRAFT2b: missing prompt_en', s => { delete s.scenes[0].shots[0].prompt_en; }, /s01-shot-01.*prompt_en/);
expectScriptError('DRAFT2c: duration=0', s => { s.scenes[0].shots[0].duration = 0; }, /s01-shot-01\.duration/);
expectScriptError('DRAFT2d: shot ratio differs from episode-level', s => { s.scenes[0].shots[0].ratio = '9:16'; }, /s01-shot-01.*ratio/);
expectScriptError('DRAFT2e: continue_from cycle', s => {
  s.scenes[0].shots = [
    { id: 's01-shot-01', style_en: 'x', prompt_en: 'y', description_cn: 'z', duration: 8, continue_from: 's01-shot-02' },
    { id: 's01-shot-02', style_en: 'x', prompt_en: 'y', description_cn: 'z', duration: 8, continue_from: 's01-shot-01' },
  ];
}, /cycle/);
expectScriptError('DRAFT2f: has dialogue but voice not parseable', s => {
  delete s.tts.voice_id;
  s.intent = { dialogue: true, audio: 'dialogue', subtitles: 'soft' };
  s.scenes[0].shots[0].dialogue = 'hello.';
}, /voice_id/);
expectScriptError('DRAFT2g: intent.dialogue=false but script has dialogue', s => {
  s.intent = { dialogue: false, audio: 'dialogue', subtitles: 'soft' };
  s.scenes[0].shots[0].dialogue = 'hello.';
}, /dialogue=false/);
expectScriptError('DRAFT2h: unsupported resolution', s => { s.defaults.resolution = '4k'; }, /resolution/);

// ---- DRAFT3: validate-script warning surface (exit 0) ----

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
expectScriptWarnings('DRAFT3a: duration=45 (>30s)', s => { s.scenes[0].shots[0].duration = 45; });
expectScriptWarnings('DRAFT3b: missing description_cn', s => { delete s.scenes[0].shots[0].description_cn; });
expectScriptWarnings('DRAFT3c: dialogue estimate exceeds shot duration', s => {
  s.intent = { dialogue: true, audio: 'dialogue', subtitles: 'soft' };
  s.scenes[0].shots[0].duration = 2;
  s.scenes[0].shots[0].dialogue = 'this is a very long dialogue text that exceeds the duration limit';
});
expectScriptWarnings('DRAFT3d: intent.dialogue=true but no dialogue', s => {
  s.intent = { dialogue: true, audio: 'music_sfx', subtitles: 'soft' };
});

// ---- DRAFT4: --json structure + --build integration ----

test('DRAFT4a: --json structure stable (ok/errors/warnings/stats)', () => {
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
test('DRAFT4b: --build on tmp draft generates manifest.json (exit 0)', () => {
  const root = mkTempDir();
  assert.strictEqual(runTool('new-episode.js', ['--draft', 'build-me', '--root', root]).status, 0);
  const target = path.join(root, 'episodes', '_drafts', 'build-me');
  const r = runTool('validate-script.js', [target, '--build']);
  assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stdout}${r.stderr}`);
  assert.ok(fs.existsSync(path.join(target, 'manifest.json')), 'manifest.json must be generated');
});
test('DRAFT4c: bad script --build must not write manifest', () => {
  const dir = mkTempDir();
  const s = draftBaseScript();
  delete s.scenes[0].shots[0].prompt_en;
  writeDraftScript(dir, s);
  const r = runTool('validate-script.js', [dir, '--build']);
  assert.strictEqual(r.status, 4, `expected exit 4, got ${r.status}: ${r.stdout}${r.stderr}`);
  assert.ok(!fs.existsSync(path.join(dir, 'manifest.json')), 'bad script must not produce manifest.json');
});

// ---- DRAFT5: production isolation ----

test('DRAFT5: never created any file under real episodes/', () => {
  assert.deepStrictEqual(listTree(realEpisodesDir), realEpisodesBaseline, 'real episodes/ tree must be untouched');
});
