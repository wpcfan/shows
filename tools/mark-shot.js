#!/usr/bin/env node
/**
 * mark-shot.js — Take 管理 + 状态回写 manifest + catalog
 *
 * Orchestrator: imports attempt resolution from mark-shot-attempt,
 * catalog sync from mark-shot-catalog.
 * Retains: parseArgs, updateManifest, recordFingerprintReuse,
 *   nextTakeId, reservedTakeIds, main.
 *
 * 用法:
 *   node tools/mark-shot.js <ep> <shot> --take --task <task-id> --path <mp4> [--model <m>] [--notes "..."] [--cost <n>]
 *   node tools/mark-shot.js <ep> <shot> --select --take-id <take-id>
 *   node tools/mark-shot.js <ep> <shot> --reject --take-id <take-id>
 *   node tools/mark-shot.js <ep> <shot> --review --take-id <take-id> --conclusion accept|reject
 *   node tools/mark-shot.js <ep> <shot> --rendering
 *   node tools/mark-shot.js <ep> <shot> --failed --task <task-id> --error "<msg>" [--transient|--hard] [--attempt <n>] [--billed|--no-billed] [--cost <n>]
 *   node tools/mark-shot.js <ep> <shot> --unblock
 *   node tools/mark-shot.js <ep> <shot> --pending
 *   node tools/mark-shot.js <ep> <shot> --done --path <mp4>  (V1 兼容,不推荐)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const {
  computeInputHash, deriveStatus, atomicWriteJson, readJsonFile,
  normalizeTaskStatus, isActiveTaskStatus, isTaskSuperseded, fileContentHash,
  appendTaskEvent, nextAttemptN
} = require('./build-manifest');
const { ensureLedger, recordOutcome, validateCost } = require('./quota-ledger');
const { withLock } = require('./lock');
const { getTaskSnapshot, resolveAttempt, recordTaskFailure } = require('./mark-shot-attempt');
const { appendCatalog } = require('./mark-shot-catalog');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const [episodeDir, shotId, ...rest] = argv;
  const opts = {
    episodeDir, shotId,
    action: null, path: null, model: null, notes: null,
    takeId: null, error: null, taskId: null, conclusion: null,
    kindOverride: null, attemptN: null, cost: null, billed: undefined,
    terminal: false, attemptId: null, requestId: null
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--take') opts.action = 'take';
    else if (a === '--select') opts.action = 'select';
    else if (a === '--reject') opts.action = 'reject';
    else if (a === '--review') opts.action = 'review';
    else if (a === '--rendering') opts.action = 'rendering';
    else if (a === '--done') opts.action = 'done';
    else if (a === '--failed') opts.action = 'failed';
    else if (a === '--pending') opts.action = 'pending';
    else if (a === '--unblock') opts.action = 'unblock';
    else if (a === '--transient') opts.kindOverride = 'transient';
    else if (a === '--hard') opts.kindOverride = 'hard';
    else if (a === '--kind') { const v = rest[++i]; if (v === 'hard' || v === 'transient') opts.kindOverride = v; }
    else if (a === '--terminal') opts.terminal = true;
    else if (a === '--billed') opts.billed = true;
    else if (a === '--no-billed') opts.billed = false;
    else if (a === '--cost') opts.cost = rest[++i];
    else if (a === '--path') opts.path = rest[++i];
    else if (a === '--model') opts.model = rest[++i];
    else if (a === '--notes') opts.notes = rest[++i];
    else if (a === '--take-id') opts.takeId = rest[++i];
    else if (a === '--error') opts.error = rest[++i];
    else if (a === '--task') opts.taskId = rest[++i];
    else if (a === '--attempt-id') opts.attemptId = rest[++i];
    else if (a === '--request-id') opts.requestId = rest[++i];
    else if (a === '--conclusion') opts.conclusion = rest[++i];
    else if (a === '--attempt') opts.attemptN = parseInt(rest[++i], 10);
  }
  return opts;
}

/**
 * §3.5 superseded 素材的人工恢复:仅当 take 的 fingerprint 与当前 input 复现时,
 * 向 manifest.reuse_records[] 追加恢复记录;**不改写原任务 superseded_at/by**。
 */
function recordFingerprintReuse(manifest, shot, take) {
  const task = (manifest.render_tasks || []).find(t => t.task_id === take.task_id);
  const superseded = take.status === 'superseded' || (task && isTaskSuperseded(task));
  if (!superseded) return false;
  if (take.input_hash === null || take.input_hash === undefined || take.input_hash !== shot.input_hash) return false;
  if (!manifest.reuse_records) manifest.reuse_records = [];
  const digest = take.content_digest != null
    ? take.content_digest
    : (take.path ? fileContentHash(take.path) : null);
  const rec = {
    take_id: take.id,
    source_task_id: take.task_id || null,
    source_artifact_digest: digest,
    bound_input_hash: shot.input_hash,
    reason: 'fingerprint_recurrence',
    at: new Date().toISOString()
  };
  const dup = manifest.reuse_records.find(r => r.take_id === rec.take_id && r.bound_input_hash === rec.bound_input_hash && r.reason === rec.reason);
  if (!dup) manifest.reuse_records.push(rec);
  return true;
}

function nextTakeId(takes, reservedIds) {
  const ids = [
    ...(takes || []).map(t => t.id),
    ...(reservedIds || [])
  ];
  let max = 0;
  for (const id of ids) {
    const m = /^take-(\d+)$/.exec(id || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `take-${String(max + 1).padStart(3, '0')}`;
}

function reservedTakeIds(manifest, shotId) {
  return (manifest.render_tasks || [])
    .filter(t => t.shot_id === shotId && t.take_id)
    .map(t => t.take_id);
}

function updateManifest(absEpDir, shotId, opts) {
  const manifestPath = path.join(absEpDir, 'manifest.json');
  const manifest = readJsonFile(manifestPath, { label: 'manifest.json' });
  const shot = manifest.shots.find(s => s.id === shotId);
  if (!shot) throw new Error(`shot ${shotId} not found in manifest`);

  if (opts.cost != null) validateCost(opts.cost);
  ensureLedger(manifest);

  if (!shot.takes) shot.takes = [];
  let createdTakeId = null;
  let takeStatus = 'candidate';

  switch (opts.action) {
    case 'take': {
      if (!opts.path) throw new Error('--take requires --path');
      let takeInputHash = null;
      let takeModel = opts.model || 'unknown';
      let takeId = null;
      let takeAttemptId = null;
      let contentDigest = null;
      let takeRequestId = opts.requestId || null;
      let takeKeyframe = null;

      if (opts.taskId) {
        const task = getTaskSnapshot(manifest, opts.taskId);
        if (!task) throw new Error(`task ${opts.taskId} not found in manifest.render_tasks`);
        if (task.shot_id !== shotId) {
          throw new Error(`task ${opts.taskId} is for shot ${task.shot_id}, not ${shotId}`);
        }
        contentDigest = fileContentHash(opts.path);
        if (contentDigest === null) {
          throw new Error(`--take requires a readable artifact at --path (content digest unavailable): ${opts.path}`);
        }

        const ident = resolveAttempt(task, opts, manifest);
        takeAttemptId = ident.attempt_id || null;
        takeRequestId = ident.request_id || takeRequestId;

        if (takeRequestId || takeAttemptId) {
          const existing = (shot.takes || []).find(t => t.task_id === opts.taskId
            && (takeRequestId ? t.request_id === takeRequestId : t.attempt_id === takeAttemptId));
          if (existing) {
            if (existing.content_digest === contentDigest) {
              console.log(`  request ${takeRequestId || takeAttemptId} for task ${opts.taskId} already recorded as ${existing.id} (idempotent)`);
              return { manifest, createdTakeId: existing.id };
            }
            throw new Error(`conflict: request ${takeRequestId || takeAttemptId} for task ${opts.taskId} already recorded as ${existing.id} with a different content digest (${existing.content_digest} != ${contentDigest}) — refusing to overwrite; local path is locator-only, only content digest decides conflicts`);
          }
        } else {
          const taskTakes = (shot.takes || []).filter(t => t.task_id === opts.taskId);
          const sameDigest = taskTakes.find(t => t.content_digest === contentDigest);
          if (sameDigest) {
            console.log(`  task ${opts.taskId} already has take ${sameDigest.id} with the same content digest (idempotent)`);
            return { manifest, createdTakeId: sameDigest.id };
          }
          if (taskTakes.length > 0) {
            throw new Error(`callback for task ${opts.taskId} has no request/attempt identity and a different content digest — pass --request-id (or --attempt-id) to record it as an independent request (refusing to silently drop a possibly paid result)`);
          }
        }
        takeInputHash = task.input_hash;
        takeModel = opts.model || task.model || 'unknown';
        takeKeyframe = task.keyframe ? Object.assign({}, task.keyframe) : null;
        takeId = task.take_id;
        if ((shot.takes || []).some(t => t.id === takeId)) {
          takeId = nextTakeId(shot.takes, reservedTakeIds(manifest, shotId));
        }

        const staleArtifact = (task.input_hash !== shot.input_hash) || isTaskSuperseded(task);
        const normStatus = normalizeTaskStatus(task.status);
        const terminalLate = normStatus === 'blocked' || normStatus === 'cancelled';
        const alreadySucceeded = normStatus === 'succeeded';
        const inFlight = ['queued', 'submitted', 'running'].includes(normStatus);
        const lateOutcome = staleArtifact || (!inFlight && !alreadySucceeded && !terminalLate) || terminalLate;
        takeStatus = (staleArtifact || terminalLate) ? 'superseded' : 'candidate';
        if (staleArtifact) {
          console.warn(`WARN: stale callback for task ${opts.taskId} (input_hash ${task.input_hash} != current ${shot.input_hash}) — recording superseded take; NOT selecting it`);
        } else if (terminalLate) {
          console.warn(`WARN: late success for task ${opts.taskId} after terminal status ${normStatus} — recording superseded orphan take; task status NOT revived`);
        } else if (alreadySucceeded) {
          console.warn(`WARN: additional artifact for already-succeeded task ${opts.taskId} (request ${takeRequestId || 'n/a'}) — recording independent candidate take; NOT selecting it`);
        } else if (!inFlight) {
          console.warn(`WARN: late success for task ${opts.taskId} (was ${task.status}) — recording candidate take; NOT selecting it`);
        }
        if (!terminalLate) {
          if (!alreadySucceeded) {
            task.status = 'succeeded';
            task.completion = lateOutcome ? 'late' : 'normal';
          }
        } else {
          task.completion = 'late';
        }

        if (lateOutcome) {
          const events = manifest.task_events || (manifest.task_events = []);
          appendTaskEvent(events, {
            task_id: task.task_id,
            attempt_id: takeAttemptId,
            request_id: takeRequestId,
            shot_id: shot.id,
            stage: task.stage || 'video',
            input_hash: task.input_hash,
            n: nextAttemptN(events, task.task_id),
            kind: 'callback_received',
            late: true,
            after_terminal: terminalLate,
            error: null,
            at: new Date().toISOString(),
            retry_after: null,
            epoch: shot.breaker_epoch || 0
          });
        }
      } else {
        contentDigest = fileContentHash(opts.path);
        if (contentDigest === null) {
          throw new Error(`--take requires a readable artifact at --path (content digest unavailable): ${opts.path}`);
        }
        console.warn('WARN: --take without --task — input_hash set to null (source unknown, requires --review to approve)');
        takeId = opts.takeId || nextTakeId(shot.takes, reservedTakeIds(manifest, shotId));
      }

      if ((shot.takes || []).find(t => t.id === takeId)) {
        throw new Error(`take ${takeId} already exists for ${shotId} (duplicate take_id)`);
      }

      shot.takes.push({
        id: takeId,
        path: opts.path,
        model: takeModel,
        input_hash: takeInputHash,
        task_id: opts.taskId || null,
        request_id: takeRequestId,
        content_digest: contentDigest,
        attempt_id: takeAttemptId,
        rendered_at: new Date().toISOString(),
        status: takeStatus,
        keyframe: takeKeyframe,
        notes: opts.notes || ''
      });
      createdTakeId = takeId;
      recordOutcome(ensureLedger(manifest), 'video', 'success', { cost: opts.cost });
      console.log(`  recorded ${takeId} for ${shotId} (status stays ${shot.status})`);
      break;
    }
    case 'select': {
      if (!opts.takeId) throw new Error('--select requires --take-id');
      if (shot.status === 'blocked') {
        throw new Error(`shot ${shotId} is blocked (${shot.blocked_reason || 'circuit breaker'}) — run --unblock before selecting`);
      }
      const take = shot.takes.find(t => t.id === opts.takeId);
      if (!take) throw new Error(`take ${opts.takeId} not found in ${shotId}`);
      if (take.status === 'rejected') {
        throw new Error(`take ${opts.takeId} is rejected, cannot select`);
      }
      if (take.human_review && take.human_review.conclusion === 'reject') {
        throw new Error(`take ${opts.takeId} was reviewed and rejected, cannot select`);
      }
      if (!take.path || !fs.existsSync(take.path)) {
        throw new Error(`take ${opts.takeId} file missing: ${take.path || '(null)'}`);
      }
      if (take.input_hash != null && take.input_hash !== shot.input_hash) {
        throw new Error(`take ${opts.takeId} input fingerprint mismatch (take ${take.input_hash}, current ${shot.input_hash}) — cannot select a take generated from different input; regenerate or restore the matching input`);
      }
      if (recordFingerprintReuse(manifest, shot, take)) {
        console.log(`  recorded reuse_record for ${take.id} (fingerprint recurrence)`);
      }
      for (const t of shot.takes) {
        if (t.status === 'selected') t.status = 'candidate';
      }
      take.status = 'selected';
      shot.selected_take = take.id;
      const { status, prev_hash } = deriveStatus(shot, shot.input_hash, null);
      shot.status = status;
      shot.prev_hash = prev_hash;
      shot.output_path = take.path;
      shot.rendered_at = take.rendered_at;
      shot.error = null;
      console.log(`  selected ${take.id} for ${shotId} → status: ${status}`);
      break;
    }
    case 'reject': {
      if (!opts.takeId) throw new Error('--reject requires --take-id');
      const take = shot.takes.find(t => t.id === opts.takeId);
      if (!take) throw new Error(`take ${opts.takeId} not found in ${shotId}`);
      const wasRejected = take.status === 'rejected';
      take.status = 'rejected';
      if (shot.selected_take === take.id) {
        shot.selected_take = null;
        shot.output_path = null;
        const { status } = deriveStatus(shot, shot.input_hash, null);
        shot.status = status;
      }
      if (!wasRejected) recordOutcome(ensureLedger(manifest), 'video', 'reject', { cost: opts.cost });
      console.log(`  rejected ${take.id} for ${shotId}`);
      break;
    }
    case 'review': {
      if (!opts.takeId) throw new Error('--review requires --take-id');
      if (!opts.conclusion) throw new Error('--review requires --conclusion accept|reject');
      if (opts.conclusion !== 'accept' && opts.conclusion !== 'reject') {
        throw new Error('--conclusion must be accept or reject');
      }
      const take = shot.takes.find(t => t.id === opts.takeId);
      if (!take) throw new Error(`take ${opts.takeId} not found in ${shotId}`);
      if (opts.conclusion === 'accept') {
        if (shot.status === 'blocked') {
          throw new Error(`shot ${shotId} is blocked (${shot.blocked_reason || 'circuit breaker'}) — run --unblock before approving`);
        }
        if (take.status === 'rejected' || (take.human_review && take.human_review.conclusion === 'reject')) {
          throw new Error(`take ${opts.takeId} is rejected (terminal state) — cannot accept`);
        }
        if (take.status === 'superseded' && take.input_hash !== shot.input_hash) {
          throw new Error(`take ${opts.takeId} is superseded (stale/orphan artifact from input ${take.input_hash}, current ${shot.input_hash}) — cannot be approved; re-select it manually only if the input fingerprint matches again`);
        }
        if (take.input_hash != null && take.input_hash !== shot.input_hash) {
          throw new Error(`take ${opts.takeId} was generated from input ${take.input_hash}, current is ${shot.input_hash} — cannot approve as the current version (write path enforces the same invariant as validateTake)`);
        }
        if (recordFingerprintReuse(manifest, shot, take)) {
          console.log(`  recorded reuse_record for ${take.id} (fingerprint recurrence)`);
        }
      }
      take.human_review = {
        reviewed_input_hash: shot.input_hash,
        conclusion: opts.conclusion,
        reviewed_at: new Date().toISOString(),
        reviewer: process.env.USER || 'unknown'
      };
      if (opts.conclusion === 'reject') {
        const wasRejected = take.status === 'rejected';
        take.status = 'rejected';
        if (!wasRejected) recordOutcome(ensureLedger(manifest), 'video', 'reject', { cost: opts.cost });
        if (shot.selected_take === take.id) {
          shot.selected_take = null;
          shot.output_path = null;
        }
      } else if (opts.conclusion === 'accept' && shot.selected_take !== take.id) {
        if (!shot.selected_take) {
          take.status = 'selected';
          shot.selected_take = take.id;
          shot.output_path = take.path;
        }
      }
      const { status, prev_hash } = deriveStatus(shot, shot.input_hash, null);
      shot.status = status;
      shot.prev_hash = prev_hash;
      console.log(`  reviewed ${take.id} for ${shotId} (${opts.conclusion}) → status: ${status}`);
      break;
    }
    case 'rendering': {
      if (shot.status === 'blocked') {
        throw new Error(`shot ${shotId} is blocked (${shot.blocked_reason || 'circuit breaker'}) — run --unblock before marking rendering`);
      }
      shot.status = 'rendering';
      console.log(`  marked ${shotId} as rendering`);
      break;
    }
    case 'failed': {
      if (opts.taskId) {
        recordTaskFailure({ manifest, shot, shotId, opts });
      } else {
        const schemaVersion = Number(manifest.schema_version || 1) || 1;
        if (schemaVersion >= 2) {
          throw new Error(`--failed without --task is not allowed on schema v${schemaVersion} manifests: run 'node tools/render-next.js <episode-dir>' to create a task snapshot, then use --failed --task <task-id> (no state changed)`);
        }
        console.warn('WARN: legacy --failed without --task (v1 path) — no attempt event; migrate to schema 2');
        shot.status = 'failed';
        shot.error = opts.error;
        shot.retries = (shot.retries || 0) + 1;
        console.log(`  marked ${shotId} as failed: ${opts.error}`);
      }
      break;
    }
    case 'unblock': {
      shot.breaker_epoch = (shot.breaker_epoch || 0) + 1;
      for (const t of (manifest.render_tasks || [])) {
        if (t.shot_id !== shot.id) continue;
        const st = normalizeTaskStatus(t.status);
        if (isActiveTaskStatus(t.status) || st === 'blocked') {
          t.status = 'cancelled';
          t.error = 'cancelled by --unblock (breaker reset)';
        }
      }
      shot.blocked_reason = null;
      shot.error = null;
      shot.status = 'pending';
      const { status, prev_hash } = deriveStatus(shot, shot.input_hash, 'pending');
      shot.status = status;
      shot.prev_hash = prev_hash;
      console.log(`  unblocked ${shotId}: breaker_epoch → ${shot.breaker_epoch}, status → ${status}`);
      break;
    }
    case 'pending': {
      if (shot.status === 'blocked') {
        throw new Error(`shot ${shotId} is blocked (${shot.blocked_reason || 'circuit breaker'}) — run --unblock before resetting to pending`);
      }
      shot.status = 'pending';
      shot.output_path = null;
      shot.rendered_at = null;
      shot.error = null;
      shot.selected_take = null;
      console.log(`  reset ${shotId} to pending (takes preserved)`);
      break;
    }
    case 'done': {
      if (!opts.path) throw new Error('--done requires --path');
      console.warn('WARN: --done is deprecated, use --take --task + --select instead');
      const takeId = nextTakeId(shot.takes, reservedTakeIds(manifest, shotId));
      const inputHash = computeInputHash(
        shot.prompt_final_en, shot.image_paths || [],
        shot.duration || 8, shot.ratio || '16:9', shot.resolution || '720p', shot.model || 'default',
        { schemaVersion: manifest.schema_version || 1 }
      );
      shot.takes.push({
        id: takeId, path: opts.path, model: opts.model || 'unknown',
        input_hash: inputHash, task_id: null,
        rendered_at: new Date().toISOString(), status: 'selected', notes: opts.notes || ''
      });
      shot.selected_take = takeId;
      const { status, prev_hash } = deriveStatus(shot, shot.input_hash, null);
      shot.status = status;
      shot.prev_hash = prev_hash;
      shot.output_path = opts.path;
      shot.rendered_at = new Date().toISOString();
      shot.error = null;
      createdTakeId = takeId;
      console.log(`  marked ${shotId} (take ${takeId}) → status: ${status}`);
      break;
    }
    default:
      throw new Error('no action (--take/--select/--reject/--review/--rendering/--done/--failed/--pending)');
  }

  atomicWriteJson(manifestPath, manifest);
  return { manifest, createdTakeId };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.episodeDir || !opts.shotId || !opts.action) {
    console.error('Usage: node tools/mark-shot.js <ep> <shot> --take --task <task-id> --path <mp4> [--request-id <rid>] [--cost <n>] | --select --take-id <id> | --reject --take-id <id> | --review --take-id <id> --conclusion accept|reject | --rendering | --done --path <mp4> | --failed --task <task-id> --error "<msg>" [--transient|--hard|--kind hard|transient] [--terminal] [--attempt-id <id>] [--request-id <id>] [--billed|--no-billed] [--cost <n>] | --unblock | --pending');
    return 1;
  }
  const absEpDir = path.isAbsolute(opts.episodeDir) ? opts.episodeDir : path.resolve(opts.episodeDir);
  const catalogPath = path.join(ROOT, 'catalog.json');
  try {
    withLock([absEpDir, catalogPath], () => {
      const { manifest, createdTakeId } = updateManifest(absEpDir, opts.shotId, opts);
      appendCatalog(absEpDir, opts.shotId, opts, manifest, createdTakeId, catalogPath);
    });
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    return 3;
  }
  console.log(`marked ${opts.shotId} (action: ${opts.action})`);
}

module.exports = { updateManifest, appendCatalog, nextTakeId, getTaskSnapshot, resolveAttempt, parseArgs, recordTaskFailure };

if (require.main === module) {
  process.exit(main());
}
