const { test, throws, testAsync, mkTempDir, writeManifest, readManifest, shotBase } = require('./helpers');
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const {
  computeStagePayloadHash, computeShotKeyframeHash, computeShotVideoHash,
  styleGuideFileDigest,
  estimateDialogueSeconds, resolveTtsConfig, normalizeDialogue, resolveVoiceId, DEFAULT_TTS_PROVIDER,
  readJsonFile
} = require('../build-manifest');
const { createRenderTask, computeNextTtsTakeId, targetStage } = require('../render-next');
const { recordTaskFailure, parseArgs: markShotParseArgs } = require('../mark-shot');
const { parseDoubaoStream, synthDoubao, classifyTtsError } = require('../tts-api-doubao');
const { runTts, parseArgs: ttsParseArgs, loadEnvFile, listTtsTasks } = require('../tts');
const {
  selectDialogueTake, resolveDialogueTiming, overflowFrames, decideOverflow,
  checkSpillConstraints, trimDialogue, collectUnresolvedOverflow
} = require('../dialogue');
const { buildTimeline, validateTimeline } = require('../build-timeline');
const { ROOT } = require('../build-prompt');
const GATE = require('../gate');

function runBuildManifest(dir, env) {
  return spawnSync(process.execPath, [path.join(ROOT, 'tools', 'build-manifest.js'), dir], {
    encoding: 'utf8', env: env || process.env
  });
}

function resolvedShotPaths(shot) {
  return (shot.image_paths || []).map(p => typeof p === 'string' ? path.resolve(p) : p);
}

function selectedKeyframeFileDigest(shot) {
  const t = (shot.takes || []).find(x => x.id === shot.selected_take);
  return t ? (t.content_digest || null) : null;
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

function gateItem(result, id) {
  const it = (result.items || []).find(x => x.id === id);
  assert.ok(it, `gate item #${id} must exist (have: ${(result.items || []).map(x => x.id).join(',')})`);
  return it;
}

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
// OVF: dialogue overflow
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
