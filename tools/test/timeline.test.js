'use strict';
const { test, throws, mkTempDir, writeManifest, readManifest, shotBase } = require('./helpers');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const { resolveTimelineFps, secondsToFrames, msToFrames, buildTimeline, validateTimeline } = require('../build-timeline');
const {
  resolveEpisodeFps, validateContinueFrom, secondsToFrames: bmSecondsToFrames,
  fileContentHash, computeShotKeyframeHash, computeShotVideoHash, styleGuideFileDigest, readJsonFile
} = require('../build-manifest');
const {
  decideDeletedHeadFrames, extractFrameAt, compareJunctionFrames, cfrNormalizeArgs
} = require('../junction');
const { createRenderTask } = require('../render-next');
const { updateKeyframeManifest } = require('../mark-keyframe');
const { extractTailFrame, probeDurationSec } = require('../tail-frame');
const { ROOT } = require('../build-prompt');

// ── shared helpers ──

const approx = (a, b, eps = 1e-9) => { assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`); };
function tlManifest(shots, extra = {}) { return Object.assign({ episode: 'TEST', shots }, extra); }

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

function taskAssetsDirs(dir) {
  const d = path.join(dir, '.task-assets');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter(n => fs.statSync(path.join(d, n)).isDirectory());
}

function runBuildManifest(dir, env) {
  return spawnSync(process.execPath, [path.join(ROOT, 'tools', 'build-manifest.js'), dir], {
    encoding: 'utf8', env: env || process.env
  });
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

// ============================================================
// M1-TL: timeline core
// ============================================================

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
// M4a: continue_from, fps, offset
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
// M4b: cut_join, junction
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
