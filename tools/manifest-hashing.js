'use strict';
const crypto = require('crypto');
const path = require('path');
const { ROOT } = require('./build-prompt');
const { fileContentHash } = require('./manifest-io');

function isPositiveInt(v) {
  return Number.isInteger(v) && v > 0;
}

function resolveEpisodeRatio(script, series) {
  const scriptRatio = script && script.defaults && script.defaults.ratio;
  if (scriptRatio) return scriptRatio;
  const seriesRatio = series && series.seedance_defaults && series.seedance_defaults.ratio;
  if (seriesRatio) return seriesRatio;
  return '16:9';
}

function resolveShotRatio(shot, episodeRatio) {
  if (shot && shot.ratio) return shot.ratio;
  return episodeRatio;
}

function resolveEpisodeFps(script, series) {
  const candidates = [
    script && script.defaults ? script.defaults.fps : undefined,
    series && series.seedance_defaults ? series.seedance_defaults.fps : undefined
  ];
  for (const value of candidates) {
    if (value === undefined || value === null) continue;
    if (!isPositiveInt(value)) {
      throw new Error(`episode fps must be a positive integer, got ${JSON.stringify(value)}`);
    }
    return value;
  }
  return 30;
}

function secondsToFrames(seconds, fps) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    throw new Error(`seconds must be a finite number, got ${JSON.stringify(seconds)}`);
  }
  if (!isPositiveInt(fps)) {
    throw new Error(`fps must be a positive integer, got ${JSON.stringify(fps)}`);
  }
  const frames = Math.round(seconds * fps);
  return { frames, residual: seconds - frames / fps };
}

function canonicalJson(value) {
  if (value === null || value === undefined) return 'null';
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (t === 'boolean' || t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (t === 'object') {
    const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }
  return 'null';
}

function styleGuideFileDigest() {
  return fileContentHash(path.join(ROOT, 'style-guide.md'));
}

function resolveStageRefsForShot(shot) {
  if (Array.isArray(shot.image_refs) && shot.image_refs.length) {
    return shot.image_refs.map(r => ({
      hash_role: r.hash_role || r.role,
      role: r.role || r.hash_role,
      path: r.path
    }));
  }
  const paths = shot.image_paths || [];
  const references = shot.references || [];
  const prefixCount = Math.max(0, paths.length - references.length);
  return paths.map((p, i) => {
    if (i >= prefixCount) return { hash_role: `shot.references[${i - prefixCount}]`, role: 'extra reference', path: p };
    return { hash_role: `ref[${i}]`, role: 'extra reference', path: p };
  });
}

function normalizeStageRefs(refs) {
  const out = [];
  const missing = [];
  for (const ref of (refs || [])) {
    const role = ref.hash_role || ref.role;
    let digest = ref.content_digest !== undefined ? ref.content_digest : fileContentHash(ref.path);
    if (digest === null || digest === undefined) missing.push(ref.path || role || '(unknown ref)');
    const entry = { role, content_digest: digest === undefined ? null : digest };
    if (ref.cut_frame !== undefined) entry.cut_frame = ref.cut_frame;
    out.push(entry);
  }
  if (missing.length) {
    throw new Error(`missing reference image(s) for input_hash: ${missing.join(', ')} — fix inputs before building (content digest required)`);
  }
  return out;
}

function computeStagePayloadHash(input = {}) {
  const schemaVersion = input.schemaVersion || 1;
  const stage = input.stage;
  let payload;
  if (stage === 'tts') {
    payload = {
      schema_version: schemaVersion,
      stage: 'tts',
      dialogue_text: input.dialogueText,
      voice_id: input.voiceId,
      provider: input.provider,
      tts_params: input.ttsParams
    };
    if (input.styleGuideDigest !== undefined) payload.style_guide_digest = input.styleGuideDigest;
  } else {
    payload = {
      schema_version: schemaVersion,
      stage,
      resolved_prompt: input.prompt,
      refs: normalizeStageRefs(input.refs),
      model: input.model,
      params: input.params
    };
    if (input.firstFrame !== undefined) payload.first_frame = input.firstFrame;
    if (stage === 'video' && input.firstFrame === undefined) payload.first_frame = null;
    if (input.continueFrom !== undefined && input.continueFrom !== null) {
      payload.continue_from = {
        content_digest: input.continueFrom.content_digest,
        cut_frame: input.continueFrom.cut_frame
      };
    }
    if (input.styleGuideDigest !== undefined) payload.style_guide_digest = input.styleGuideDigest;
  }
  return crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex').slice(0, 16);
}

function selectedKeyframeDigest(shot) {
  if (!shot || !shot.selected_keyframe) return null;
  const kf = (shot.keyframe_takes || []).find(t => t && t.id === shot.selected_keyframe);
  if (!kf || kf.status === 'rejected' || kf.status === 'superseded') return null;
  return kf.content_digest || null;
}

function computeShotKeyframeHash(shot, opts = {}) {
  const refs = resolveStageRefsForShot(shot);
  if (opts.upstreamTail && opts.upstreamTail.path) {
    refs.push({
      hash_role: 'upstream_tail:continue_from',
      role: 'upstream_tail:continue_from',
      path: opts.upstreamTail.path,
      content_digest: opts.upstreamTail.content_digest,
      cut_frame: opts.upstreamTail.cut_frame
    });
  }
  return computeStagePayloadHash({
    schemaVersion: opts.schemaVersion || 1,
    stage: 'keyframe',
    prompt: shot.prompt_final_en,
    refs,
    model: shot.model || 'default',
    params: { ratio: shot.ratio, resolution: shot.resolution },
    styleGuideDigest: opts.styleGuideDigest
  });
}

function computeShotVideoHash(shot, opts = {}) {
  const keyframeMode = opts.keyframeMode || 'reference';
  const keyframeDigest = opts.keyframeDigest || null;
  const refs = resolveStageRefsForShot(shot);
  if (keyframeDigest && keyframeMode !== 'first_frame') {
    refs.push({ hash_role: 'keyframe:selected', content_digest: keyframeDigest });
  }
  return computeStagePayloadHash({
    schemaVersion: opts.schemaVersion || 1,
    stage: 'video',
    prompt: shot.prompt_final_en,
    refs,
    model: shot.model || 'default',
    params: {
      ratio: shot.ratio,
      resolution: shot.resolution,
      requested_video_duration: shot.duration
    },
    firstFrame: (keyframeDigest && keyframeMode === 'first_frame') ? keyframeDigest : null,
    styleGuideDigest: opts.styleGuideDigest
  });
}

function computeInputHash(prompt, imagePaths, duration, ratio, resolution, model, opts = {}) {
  const refs = [];
  const missing = [];
  for (const p of (imagePaths || [])) {
    const contentHash = fileContentHash(p);
    if (contentHash === null) missing.push(p);
    refs.push({ content_hash: contentHash });
  }
  if (missing.length) {
    throw new Error(`missing reference image(s) for input_hash: ${missing.join(', ')} — fix inputs before building (content digest required)`);
  }
  const payload = {
    schema_version: opts.schemaVersion || 1,
    prompt,
    refs,
    duration,
    ratio,
    resolution,
    model: model || 'default'
  };
  return crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex').slice(0, 16);
}

const DEFAULT_TTS_PROVIDER = Object.freeze({ name: 'doubao', model: 'seed-tts-2.0', version: '2026-09-14' });
const DEFAULT_TTS_PARAMS = Object.freeze({ speed: 0.95 });
const DEFAULT_TTS_CHARS_PER_SECOND = 5;
const TTS_PROVIDER_FIELDS = ['name', 'model', 'version'];

function resolveTtsConfig(script, series) {
  const scriptTts = (script && typeof script.tts === 'object' && !Array.isArray(script.tts)) ? script.tts : null;
  const seriesTts = (series && typeof series.tts === 'object' && !Array.isArray(series.tts)) ? series.tts : null;
  const src = scriptTts || seriesTts;
  const providerEntry = (scriptTts && scriptTts.provider) ? { value: scriptTts.provider, source: 'script.tts.provider' }
    : (seriesTts && seriesTts.provider) ? { value: seriesTts.provider, source: 'series.tts.provider' }
      : { value: DEFAULT_TTS_PROVIDER, source: 'default.provider' };
  const paramsEntry = (scriptTts && scriptTts.params) ? scriptTts.params
    : (seriesTts && seriesTts.params) ? seriesTts.params
      : DEFAULT_TTS_PARAMS;
  const cpsRaw = scriptTts && scriptTts.chars_per_second !== undefined ? scriptTts.chars_per_second
    : (seriesTts && seriesTts.chars_per_second !== undefined ? seriesTts.chars_per_second : undefined);
  return {
    provider: Object.assign({}, providerEntry.value),
    providerSource: providerEntry.source,
    params: Object.assign({}, paramsEntry),
    charsPerSecond: (typeof cpsRaw === 'number' && Number.isFinite(cpsRaw) && cpsRaw > 0) ? cpsRaw : DEFAULT_TTS_CHARS_PER_SECOND,
    source: src ? (scriptTts ? 'script.tts' : 'series.tts') : 'default'
  };
}

function normalizeDialogue(shot) {
  const d = shot && shot.dialogue;
  if (typeof d === 'string') {
    const text = d.trim();
    return text ? { text, voiceId: null } : null;
  }
  if (d && typeof d === 'object' && !Array.isArray(d) && typeof d.text === 'string') {
    const text = d.text.trim();
    if (!text) return null;
    const v = (typeof d.voice_id === 'string' && d.voice_id.trim()) ? d.voice_id.trim() : null;
    return { text, voiceId: v };
  }
  return null;
}

function resolveVoiceId({ dialogue, shot, scene, script, series } = {}) {
  const sceneLoc = (scene && scene.id) ? `scene ${scene.id}.voice_id` : 'scene.voice_id';
  const candidates = [
    ['shot.dialogue.voice_id', dialogue && dialogue.voiceId],
    ['shot.voice_id', shot && shot.voice_id],
    [sceneLoc, scene && scene.voice_id],
    ['script.tts.voice_id', script && script.tts && script.tts.voice_id],
    ['series.tts.voice_id', series && series.tts && series.tts.voice_id]
  ];
  for (const [location, value] of candidates) {
    if (typeof value === 'string' && value.trim()) {
      return { voiceId: value.trim(), location, checked: candidates.map(c => c[0]) };
    }
  }
  return { voiceId: null, location: null, checked: candidates.map(c => c[0]) };
}

function missingTtsProviderFields(provider) {
  return TTS_PROVIDER_FIELDS.filter(f => !provider || provider[f] === undefined || provider[f] === null || provider[f] === '');
}

function estimateDialogueSeconds(text, { charsPerSecond } = {}) {
  const cps = (typeof charsPerSecond === 'number' && Number.isFinite(charsPerSecond) && charsPerSecond > 0)
    ? charsPerSecond : DEFAULT_TTS_CHARS_PER_SECOND;
  const raw = text == null ? '' : String(text);
  return raw.trim().length / cps;
}

module.exports = {
  isPositiveInt,
  resolveEpisodeRatio, resolveShotRatio, resolveEpisodeFps, secondsToFrames,
  canonicalJson, styleGuideFileDigest,
  resolveStageRefsForShot, normalizeStageRefs,
  computeStagePayloadHash, selectedKeyframeDigest,
  computeShotKeyframeHash, computeShotVideoHash, computeInputHash,
  DEFAULT_TTS_PROVIDER, DEFAULT_TTS_PARAMS, DEFAULT_TTS_CHARS_PER_SECOND, TTS_PROVIDER_FIELDS,
  resolveTtsConfig, normalizeDialogue, resolveVoiceId,
  missingTtsProviderFields, estimateDialogueSeconds,
};
