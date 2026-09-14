#!/usr/bin/env node
/**
 * build-manifest.js — script.yaml → manifest.json
 *
 * Orchestrator: imports I/O and hashing from manifest-io / manifest-hashing.
 * Retains: validateContinueFrom, findRatioViolations, deriveStatus,
 *   selectActiveTaskForShot, catalog recovery, compareShotList,
 *   verifyManifestFreshness, main/buildEpisode.
 *
 * Barrel re-exports everything from manifest-io and manifest-hashing so that
 * existing consumers (`require('./build-manifest')`) keep working unchanged.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const {
  loadYaml, loadScript, parseStyleGuide, readText,
  buildPromptForShot, ROOT
} = require('./build-prompt');
const taskState = require('./task-state');
const { deriveIntent, validateIntent, intentFlags, detectDialogue, checkDialogueDeclaration } = require('./intent');
const { emptyLedger, normalizeLedger } = require('./quota-ledger');
const { withLock } = require('./lock');
const {
  readJsonFile, readJsonFileOrNull, atomicWriteJson,
} = require('./manifest-io');
const {
  resolveEpisodeRatio, resolveShotRatio, resolveEpisodeFps, secondsToFrames,
  styleGuideFileDigest,
  computeStagePayloadHash, computeShotKeyframeHash, computeShotVideoHash,
  selectedKeyframeDigest,
  resolveTtsConfig, normalizeDialogue, resolveVoiceId,
  missingTtsProviderFields, estimateDialogueSeconds,
} = require('./manifest-hashing');

const DEFAULT_CONTINUE_FROM_OFFSET_SEC = -0.1;
const CONTINUE_FROM_MAX_DEPTH = 3;

/**
 * §3.3 continue_from 校验三件套(构建期 fail-closed)。纯函数。
 * 规则:
 *   1. self-reference:continue_from === 自身 id → reject;
 *   2. unknown / order:上游 id 不存在 → reject;上游在 script 顺序中位于本 shot 之后 → reject
 *   3. cycle:沿 continue_from 链追溯回到已访问 shot → reject
 *   4. depth:链跳数 > 3 → reject(=3 允许)。
 */
function validateContinueFrom(shots) {
  const list = Array.isArray(shots) ? shots.filter(s => s && s.id !== undefined && s.id !== null) : [];
  const order = new Map();
  const byId = new Map();
  list.forEach((s, i) => {
    if (!order.has(s.id)) order.set(s.id, i);
    if (!byId.has(s.id)) byId.set(s.id, s);
  });
  const errors = [];
  for (const shot of list) {
    const id = shot.id;
    const first = shot.continue_from;
    if (first === undefined || first === null || first === '') continue;
    if (first === id) {
      errors.push(`${id}: self-reference in continue_from (points to itself) [${id} -> ${first}]`);
      continue;
    }
    const chain = [id];
    const visited = new Set([id]);
    let prevPos = order.get(id);
    let cur = first;
    let depth = 0;
    let done = false;
    while (!done) {
      if (!byId.has(cur)) {
        chain.push(cur);
        errors.push(`${id}: unknown continue_from upstream ${JSON.stringify(cur)} [${chain.join(' -> ')}]`);
        break;
      }
      if (order.get(cur) >= prevPos) {
        errors.push(`${id}: continue_from upstream ${JSON.stringify(cur)} must precede this shot in script order (upstream must be earlier) [${[...chain, cur].join(' -> ')}]`);
      }
      depth += 1;
      if (visited.has(cur)) {
        chain.push(cur);
        errors.push(`${id}: cycle detected in continue_from chain [${chain.join(' -> ')}]`);
        break;
      }
      visited.add(cur);
      chain.push(cur);
      prevPos = order.get(cur);
      const next = byId.get(cur).continue_from;
      if (next === undefined || next === null || next === '') done = true;
      else cur = next;
    }
    if (depth > CONTINUE_FROM_MAX_DEPTH) {
      errors.push(`${id}: continue_from depth ${depth} exceeds max ${CONTINUE_FROM_MAX_DEPTH} [${chain.join(' -> ')}]`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 返回未经 allow_mixed_ratio 放行的 shot 级 ratio 覆盖(违规列表)。
 * 冗余同值(shot.ratio === episodeRatio)不算违规。
 */
function findRatioViolations(script, episodeRatio) {
  const violations = [];
  if (script && script.allow_mixed_ratio === true) return violations;
  for (const scene of (script && script.scenes) || []) {
    for (const shot of (scene.shots || [])) {
      if (shot.ratio && shot.ratio !== episodeRatio) {
        violations.push({ shot_id: shot.id, ratio: shot.ratio });
      }
    }
  }
  return violations;
}

/**
 * 统一状态派生规则。
 *
 * 优先级:
 *   1. rendering:有 activeTask 且 input 未变 → 保持;否则落到常规规则
 *   2. failed: transient 状态,保持
 *   3. blocked: 熔断终态,保持
 *   4. 无 selected take → pending
 *   5. selected take 为 rejected 或 human_review.conclusion=reject → stale(终态优先)
 *   6. selected take 有 human_review:
 *      - reviewed_input_hash === currentInputHash + conclusion=accept → done
 *      - reviewed_input_hash !== currentInputHash → stale
 *   7. selected take 的 input_hash === currentInputHash → done
 *   8. selected take 的 input_hash === null 或 != currentInputHash → stale
 */
function deriveStatus(shot, currentInputHash, prevStatus, opts = {}) {
  if (prevStatus === 'rendering') {
    const activeTask = opts.activeTask || null;
    const hashMatches = !!activeTask && (
      (activeTask.input_hash != null && activeTask.input_hash === currentInputHash)
      || (activeTask.base_input_hash != null && activeTask.base_input_hash === currentInputHash)
    );
    if (hashMatches) return { status: 'rendering', prev_hash: shot.prev_hash || null };
  }
  if (prevStatus === 'failed') return { status: 'failed', prev_hash: shot.prev_hash || null };
  if (prevStatus === 'blocked' || shot.status === 'blocked') {
    return { status: 'blocked', prev_hash: shot.prev_hash || null };
  }

  const takes = shot.takes || [];
  const selectedId = shot.selected_take;

  if (!selectedId) return { status: 'pending', prev_hash: null };

  const selTake = takes.find(t => t.id === selectedId);
  if (!selTake) return { status: 'pending', prev_hash: null };

  if (selTake.status === 'superseded') {
    return { status: 'stale', prev_hash: selTake.input_hash || null };
  }

  if (selTake.status === 'rejected') {
    return { status: 'stale', prev_hash: selTake.input_hash || (selTake.human_review && selTake.human_review.reviewed_input_hash) || null };
  }
  if (selTake.human_review && selTake.human_review.conclusion === 'reject') {
    return { status: 'stale', prev_hash: selTake.human_review.reviewed_input_hash || selTake.input_hash || null };
  }

  if (selTake.human_review) {
    const rev = selTake.human_review;
    if (rev.reviewed_input_hash === currentInputHash && rev.conclusion === 'accept') {
      return { status: 'done', prev_hash: null };
    }
    if (rev.reviewed_input_hash !== currentInputHash) {
      return { status: 'stale', prev_hash: rev.reviewed_input_hash };
    }
    return { status: 'stale', prev_hash: rev.reviewed_input_hash };
  }

  const takeHash = selTake.input_hash;
  if (takeHash === null || takeHash === undefined) {
    return { status: 'stale', prev_hash: null };
  }
  if (takeHash === currentInputHash) {
    return { status: 'done', prev_hash: null };
  }
  return { status: 'stale', prev_hash: takeHash };
}

/**
 * FIX5d:从 render_tasks 中选取该 shot 当前可调度任务
 */
function selectActiveTaskForShot(tasks, shotId) {
  const candidates = (tasks || []).filter(t => t
    && t.shot_id === shotId
    && taskState.isActiveTaskStatus(t.status)
    && !taskState.isTaskSuperseded(t));
  if (candidates.length === 0) return null;
  return candidates.find(t => (t.stage || 'video') === 'video') || candidates[0];
}

/**
 * 从 catalog.json 恢复全部历史 take 记录
 */
function loadCatalogForEpisode(episodeId) {
  const catalogPath = path.join(ROOT, 'catalog.json');
  const read = readJsonFileOrNull(catalogPath, { label: 'catalog.json' });
  if (read.corrupt) {
    console.warn(`WARN: ${read.guidance}`);
    console.warn('  -> catalog discarded for recovery; existing manifest takes (if any) are preserved');
    return new Map();
  }
  const catalog = read.value || [];

  const map = new Map();
  for (const entry of catalog) {
    if (entry.episode !== episodeId) continue;
    if (!entry.path || entry.path.includes('/tmp/')) continue;
    if (!entry.take_id) continue;
    if (!map.has(entry.shot_id)) map.set(entry.shot_id, []);
    map.get(entry.shot_id).push(entry);
  }
  return map;
}

/**
 * 纯函数:把 catalog 条目映射为 manifest take 对象。
 */
function recoverTakesFromCatalog(shotId, entries) {
  const takes = [];
  const conflicts = [];
  const seenIds = new Set();
  let selectedTake = null;
  for (const rec of entries) {
    if (seenIds.has(rec.take_id)) {
      const existing = takes.find(t => t.id === rec.take_id);
      const sameStatus = (existing.status === (rec.status || 'candidate'));
      const sameReview = JSON.stringify(existing.human_review || null) === JSON.stringify(rec.human_review || null);
      if (!sameStatus || !sameReview) {
        conflicts.push(`${shotId}/${rec.take_id}: duplicate take_id with divergent status/review — keeping first (${existing.status})`);
      }
      continue;
    }
    seenIds.add(rec.take_id);
    const status = rec.status || 'candidate';
    takes.push({
      id: rec.take_id,
      path: rec.path,
      model: rec.model || 'unknown',
      input_hash: null,
      rendered_at: rec.rendered_at || null,
      status,
      human_review: rec.human_review || null,
      notes: 'recovered from catalog (source unknown)'
    });
    if (status === 'selected') {
      if (selectedTake === null) {
        selectedTake = rec.take_id;
      } else if (selectedTake !== rec.take_id) {
        conflicts.push(`${shotId}: multiple selected takes in catalog (${selectedTake}, ${rec.take_id}) — keeping first (manual resolve required)`);
      }
    }
  }
  return { takes, conflicts, selected_take: selectedTake };
}

/**
 * manifest 已有 selected_take 与 catalog 恢复出的 selected 不一致 → 报告冲突
 */
function resolveSelectionConflict(shotId, manifestSelectedTake, recoveredSelectedTake) {
  const conflicts = [];
  if (manifestSelectedTake && recoveredSelectedTake && manifestSelectedTake !== recoveredSelectedTake) {
    conflicts.push(`${shotId}: manifest selected_take=${manifestSelectedTake} conflicts with catalog recovered selected=${recoveredSelectedTake} — keeping manifest (fail-closed, manual resolve required)`);
  }
  return conflicts;
}

/**
 * 比较脚本镜头与 manifest 镜头的结构差异(集合 + 顺序)
 */
function compareShotList(scriptShotIds, manifestShotIds) {
  const scriptSet = new Set(scriptShotIds);
  const manifestSet = new Set(manifestShotIds);
  const removed = manifestShotIds.filter(id => !scriptSet.has(id));
  const added = scriptShotIds.filter(id => !manifestSet.has(id));
  const reordered =
    scriptShotIds.length === manifestShotIds.length &&
    scriptShotIds.every((id, i) => manifestShotIds[i] === id) === false &&
    removed.length === 0 && added.length === 0;
  const mismatches = [...removed, ...added];
  const duplicates = [];
  const collectDups = (ids, label) => {
    const seen = new Set();
    const reported = new Set();
    for (const id of ids) {
      if (seen.has(id) && !reported.has(id)) {
        duplicates.push(`${label} has duplicate shot id '${id}' (ambiguous mapping — deduplicate the script/manifest)`);
        reported.add(id);
      }
      seen.add(id);
    }
  };
  collectDups(scriptShotIds, 'script');
  collectDups(manifestShotIds, 'manifest');
  return { removed, added, reordered, mismatches, duplicates };
}

/**
 * 验证 manifest 是否与当前源输入一致
 */
function verifyManifestFreshness(absEpDir) {
  const manifestPath = path.join(absEpDir, 'manifest.json');
  const manifest = readJsonFile(manifestPath, { label: 'manifest.json' });
  const script = loadScript(absEpDir);
  if (!script) throw new Error('script.yaml not found');

  const sgText = readText(path.join(ROOT, 'style-guide.md'));
  const styleGuide = parseStyleGuide(sgText);
  const sgDigest = styleGuideFileDigest();
  const keyframeMode = manifest.keyframe_mode || 'reference';
  const defaults = script.defaults || {};
  const series = loadYaml(path.join(ROOT, 'series.yaml'));
  const episodeRatio = resolveEpisodeRatio(script, series);
  const staleShots = [];
  const structureIssues = [];

  const scriptShotIds = [];
  for (const scene of (script.scenes || [])) {
    for (const shot of (scene.shots || [])) {
      scriptShotIds.push(shot.id);
      const { prompt, image_refs } = buildPromptForShot(shot, scene, script, styleGuide);
      const ratio = resolveShotRatio(shot, episodeRatio);
      const model = shot.model || defaults.model || 'default';
      const mShot = manifest.shots.find(s => s.id === shot.id);
      const keyframeDigest = mShot ? selectedKeyframeDigest(mShot) : null;
      const currentHash = computeShotVideoHash(
        {
          prompt_final_en: prompt,
          image_refs,
          ratio,
          resolution: shot.resolution || defaults.resolution || '720p',
          duration: shot.duration || defaults.duration || 8,
          model
        },
        { schemaVersion: script.schema_version || 1, styleGuideDigest: sgDigest, keyframeDigest, keyframeMode }
      );

      if (!mShot || mShot.input_hash !== currentHash) {
        staleShots.push(shot.id);
      }
    }
  }

  const manifestShotIds = (manifest.shots || []).map(s => s.id);
  const { removed, added, reordered, duplicates } = compareShotList(scriptShotIds, manifestShotIds);
  for (const id of removed) structureIssues.push(`${id}: removed from script but still in manifest (rebuild required)`);
  for (const id of added) structureIssues.push(`${id}: in script but missing from manifest (rebuild required)`);
  if (reordered) structureIssues.push(`shot order changed: script=[${scriptShotIds.join(',')}] vs manifest=[${manifestShotIds.join(',')}]`);
  for (const d of (duplicates || [])) structureIssues.push(d);

  const fresh = staleShots.length === 0 && structureIssues.length === 0;
  return { fresh, stale_shots: staleShots, structure_issues: structureIssues };
}

function main() {
  const [episodeDir] = process.argv.slice(2);
  if (!episodeDir) {
    console.error('Usage: node tools/build-manifest.js <episode-dir>');
    process.exit(1);
  }
  const absEpDir = path.isAbsolute(episodeDir) ? episodeDir : path.resolve(episodeDir);
  withLock(absEpDir, () => buildEpisode(absEpDir));
}

function buildEpisode(absEpDir) {
  const script = loadScript(absEpDir);
  if (!script) { console.error(`script.yaml not found in ${absEpDir}`); process.exit(2); }

  const manifestPath = path.join(absEpDir, 'manifest.json');
  const legacyManifest = readJsonFileOrNull(manifestPath, { label: 'manifest.json' });
  if (legacyManifest.corrupt) {
    console.warn(`WARN: ${legacyManifest.guidance}`);
    console.warn('  -> discarding corrupt manifest; rebuilding from script.yaml (+ catalog recovery where takes are missing)');
  }
  const oldManifest = legacyManifest.value;
  const oldShots = new Map();
  if (oldManifest && Array.isArray(oldManifest.shots)) {
    for (const s of oldManifest.shots) oldShots.set(s.id, s);
  }
  const oldRenderTasks = oldManifest?.render_tasks || [];
  const oldTaskEvents = oldManifest?.task_events || [];
  const oldQuotaLedger = oldManifest?.quota_ledger
    ? normalizeLedger(oldManifest.quota_ledger)
    : emptyLedger('USD');

  const catalogRecovery = loadCatalogForEpisode(script.episode);

  const sgText = readText(path.join(ROOT, 'style-guide.md'));
  const styleGuide = parseStyleGuide(sgText);

  const defaults = script.defaults || {};
  const series = loadYaml(path.join(ROOT, 'series.yaml'));
  const episodeRatio = resolveEpisodeRatio(script, series);
  const episodeFps = resolveEpisodeFps(script, series);
  const sgDigest = styleGuideFileDigest();

  const scriptShotRefs = [];
  for (const scene of (script.scenes || [])) {
    for (const shot of (scene.shots || [])) {
      scriptShotRefs.push({ id: shot.id, continue_from: shot.continue_from });
    }
  }
  const cfValidation = validateContinueFrom(scriptShotRefs);
  if (!cfValidation.ok) {
    console.error('ERROR: continue_from validation failed (§3.3):');
    for (const err of cfValidation.errors) console.error(`  ${err}`);
    console.error('  continue_from is reference-only (weak commitment): the upstream shot must exist, precede this shot in script order, form no cycle, and a chain may be at most 3 hops deep.');
    process.exit(4);
  }

  const editPath = path.join(absEpDir, 'edit.yaml');
  const edit = fs.existsSync(editPath) ? loadYaml(editPath) : null;
  const intent = deriveIntent(script, { edit });
  const intentValidation = validateIntent(intent);
  const dialogueDeclaration = checkDialogueDeclaration(intent, { hasDialogue: detectDialogue(script) });
  const intentErrors = [...intentValidation.errors, ...dialogueDeclaration.errors];
  if (intentErrors.length) {
    console.error('ERROR: intent validation failed (§4):');
    for (const err of intentErrors) console.error(`  ${err}`);
    console.error('  fix the intent declaration in script.yaml (script.intent) or edit.yaml (edit.intent / edit.timeline.intent) — no manifest was written.');
    process.exit(4);
  }
  const resolvedIntent = intentValidation.normalized;
  const resolvedIntentFlags = intentFlags(resolvedIntent);

  const keyframeMode = script.keyframe_mode || oldManifest?.keyframe_mode || 'reference';

  const ratioViolations = findRatioViolations(script, episodeRatio);
  if (ratioViolations.length) {
    console.error(`ERROR: shot-level ratio override is not allowed (episode ratio is ${episodeRatio}):`);
    for (const v of ratioViolations) {
      console.error(`  ${v.shot_id}: ratio '${v.ratio}' != episode ratio '${episodeRatio}'`);
    }
    console.error(`  ratio is an episode-level setting (§3.7). Fix the shots, or set 'allow_mixed_ratio: true' in script.yaml to explicitly opt in to mixed-ratio output.`);
    process.exit(3);
  }

  const newShots = [];
  const ttsConfig = resolveTtsConfig(script, series);
  const ttsErrors = [];
  let hasDialogue = false;
  for (const scene of (script.scenes || [])) {
    for (const shot of (scene.shots || [])) {
      const { prompt, image_paths, image_refs } = buildPromptForShot(shot, scene, script, styleGuide);
      const duration = shot.duration || defaults.duration || 8;
      const ratio = resolveShotRatio(shot, episodeRatio);
      const resolution = shot.resolution || defaults.resolution || '720p';
      const model = shot.model || defaults.model || 'default';
      const schemaVersion = script.schema_version || 1;

      const old = oldShots.get(shot.id);

      const dialogue = normalizeDialogue(shot);
      let ttsFields = {};
      if (dialogue) {
        hasDialogue = true;
        const voice = resolveVoiceId({ dialogue, shot, scene, script, series });
        const missingProvider = missingTtsProviderFields(ttsConfig.provider);
        if (!voice.voiceId) {
          ttsErrors.push(`${shot.id}: dialogue present but no voice_id could be resolved — checked ${voice.checked.join(' > ')}; set one of these before building`);
        }
        if (missingProvider.length) {
          ttsErrors.push(`${shot.id}: tts provider is missing required field(s): ${missingProvider.join(', ')} (source: ${ttsConfig.providerSource}) — provider must include name/model/version (§3.8)`);
        }
        if (voice.voiceId && !missingProvider.length) {
          const ttsHash = computeStagePayloadHash({
            schemaVersion,
            stage: 'tts',
            dialogueText: dialogue.text,
            voiceId: voice.voiceId,
            provider: ttsConfig.provider,
            ttsParams: ttsConfig.params,
            styleGuideDigest: null
          });
          ttsFields = {
            dialogue_text: dialogue.text,
            voice_id: voice.voiceId,
            tts_hash: ttsHash,
            tts_takes: old?.tts_takes ? old.tts_takes.map(t => ({ ...t })) : [],
            selected_tts: old?.selected_tts || null
          };
          const est = estimateDialogueSeconds(dialogue.text, { charsPerSecond: ttsConfig.charsPerSecond });
          if (est > duration) {
            console.warn(`WARN: ${shot.id} dialogue estimate ${est.toFixed(2)}s exceeds shot duration ${duration}s (chars_per_second=${ttsConfig.charsPerSecond}) — overflow policy is not implemented yet (M5); continuing without blocking`);
          }
        }
      }

      const cfFields = {};
      const hasContinueFrom = typeof shot.continue_from === 'string' && shot.continue_from.length > 0;
      if (hasContinueFrom) {
        const rawOffset = (shot.continue_from_offset === undefined || shot.continue_from_offset === null)
          ? DEFAULT_CONTINUE_FROM_OFFSET_SEC
          : shot.continue_from_offset;
        if (typeof rawOffset !== 'number' || !Number.isFinite(rawOffset)) {
          console.error(`ERROR: ${shot.id}.continue_from_offset must be a finite number, got ${JSON.stringify(rawOffset)}`);
          process.exit(5);
        }
        const conv = secondsToFrames(rawOffset, episodeFps);
        cfFields.continue_from = shot.continue_from;
        cfFields.continue_from_offset_frames = conv.frames;
        cfFields.continue_from_residual_sec = conv.residual;
        if (shot.continue_from_offset !== undefined && shot.continue_from_offset !== null) {
          cfFields.continue_from_offset = rawOffset;
        }
      }

      let takes = old?.takes ? old.takes.map(t => ({ ...t })) : [];
      let selectedTake = old?.selected_take || null;
      let keyframeTakes = old?.keyframe_takes ? old.keyframe_takes.map(t => ({ ...t })) : [];
      let selectedKeyframe = old?.selected_keyframe || null;

      if (old && (old.status === 'done' || old.status === 'stale') && old.output_path && takes.length === 0) {
        takes = [{
          id: 'take-001',
          path: old.output_path,
          model: 'unknown',
          input_hash: null,
          rendered_at: old.rendered_at || null,
          status: 'selected',
          notes: 'migrated from v1 (source unknown)'
        }];
        selectedTake = 'take-001';
      }

      if (takes.length === 0 && catalogRecovery.has(shot.id)) {
        const recs = catalogRecovery.get(shot.id);
        const { takes: recTakes, conflicts, selected_take: recSel } = recoverTakesFromCatalog(shot.id, recs);
        takes = recTakes;
        for (const c of conflicts) console.warn(`  WARN: ${c}`);
        for (const c of resolveSelectionConflict(shot.id, selectedTake, recSel)) console.warn(`  WARN: ${c}`);
        if (recSel && !selectedTake) selectedTake = recSel;
        const rejectedCount = takes.filter(t => t.status === 'rejected').length;
        console.log(`  recovered ${shot.id}: ${takes.length} take(s) from catalog (${rejectedCount} rejected)`);
      }

      const shotForHash = {
        prompt_final_en: prompt, image_refs, ratio, resolution, duration, model,
        selected_keyframe: selectedKeyframe, keyframe_takes: keyframeTakes
      };
      const keyframeHash = computeShotKeyframeHash(shotForHash, { schemaVersion, styleGuideDigest: sgDigest });
      const keyframeDigest = selectedKeyframeDigest(shotForHash);
      const inputHash = computeShotVideoHash(shotForHash, {
        schemaVersion, styleGuideDigest: sgDigest, keyframeDigest, keyframeMode
      });

      const prevStatus = old?.status || 'pending';
      const { status, prev_hash } = deriveStatus(
        { takes, selected_take: selectedTake, prev_hash: old?.prev_hash },
        inputHash,
        prevStatus,
        { activeTask: selectActiveTaskForShot(oldRenderTasks, shot.id) }
      );

      const outputPath = selectedTake
        ? (takes.find(t => t.id === selectedTake)?.path || null)
        : null;

      newShots.push({
        id: shot.id,
        scene: scene.id,
        description_cn: (shot.description_cn || '').trim(),
        prompt_final_en: prompt,
        input_hash: inputHash,
        keyframe_hash: keyframeHash,
        prev_hash,
        duration,
        ratio,
        resolution,
        model,
        image_paths,
        image_refs,
        takes,
        selected_take: selectedTake,
        keyframe_takes: keyframeTakes,
        selected_keyframe: selectedKeyframe,
        output_path: outputPath,
        status,
        rendered_at: old?.rendered_at || null,
        error: old?.error || null,
        retries: old?.retries || 0,
        breaker_epoch: old?.breaker_epoch || 0,
        blocked_reason: old?.blocked_reason || null,
        ...cfFields,
        ...ttsFields
      });
    }
  }

  if (ttsErrors.length) {
    console.error('ERROR: tts configuration validation failed (§3.4/§3.8):');
    for (const err of ttsErrors) console.error(`  ${err}`);
    console.error('  no manifest was written; fix the dialogue/voice/provider configuration and rebuild.');
    process.exit(4);
  }

  const manifest = {
    episode: script.episode,
    title: script.title,
    schema_version: script.schema_version || 1,
    require_keyframe: script.require_keyframe === true,
    keyframe_mode: keyframeMode,
    version: (oldManifest?.version || 0) + 1,
    generated_at: new Date().toISOString(),
    fps: episodeFps,
    intent: {
      dialogue: resolvedIntent.dialogue,
      audio: resolvedIntent.audio,
      subtitles: resolvedIntent.subtitles,
      silent: resolvedIntent.silent,
      requires_subtitles: resolvedIntentFlags.requires_subtitles,
      requires_audio: resolvedIntentFlags.requires_audio,
      requires_loudnorm: resolvedIntentFlags.requires_loudnorm,
      declared: resolvedIntent.declared || {},
      sources: resolvedIntent.sources || {},
    },
    defaults,
    render_tasks: oldRenderTasks,
    task_events: oldTaskEvents,
    ...(hasDialogue ? {
      tts: {
        provider: ttsConfig.provider,
        params: ttsConfig.params,
        chars_per_second: ttsConfig.charsPerSecond
      }
    } : {}),
    reuse_records: oldManifest?.reuse_records || [],
    approvals: oldManifest?.approvals || [],
    approval_history: oldManifest?.approval_history || [],
    quota_ledger: oldQuotaLedger,
    shots: newShots
  };
  atomicWriteJson(manifestPath, manifest);
  const done = newShots.filter(s => s.status === 'done').length;
  const stale = newShots.filter(s => s.status === 'stale').length;
  const pending = newShots.filter(s => s.status === 'pending').length;
  const rendering = newShots.filter(s => s.status === 'rendering').length;
  const failed = newShots.filter(s => s.status === 'failed').length;
  console.log(`manifest written: ${manifestPath}`);
  console.log(`  total: ${newShots.length}, done: ${done}, stale: ${stale}, pending: ${pending}, rendering: ${rendering}, failed: ${failed}`);
}

module.exports = {
  ...require('./manifest-io'),
  ...require('./manifest-hashing'),
  deriveStatus, verifyManifestFreshness,
  selectActiveTaskForShot,
  compareShotList, recoverTakesFromCatalog, resolveSelectionConflict,
  findRatioViolations, validateContinueFrom,
  DEFAULT_CONTINUE_FROM_OFFSET_SEC, CONTINUE_FROM_MAX_DEPTH,
  ...taskState
};

if (require.main === module) {
  main();
}
