#!/usr/bin/env node
/**
 * mark-keyframe.js — keyframe take 管理 + 状态回写 manifest + catalog
 *
 * PRD v2.11 §3.2（M3a）:与 mark-shot 语义对称,但 keyframe take 独立存放于
 * `shot.keyframe_takes[]`,`shot.selected_keyframe` 是 keyframe 选片指针;
 * video take 仍在 `shot.takes[]` / `shot.selected_take`,互不污染。
 *
 * 数据模型（写死）:
 *   - keyframe take id 前缀 `kf-`(如 `kf-001`),由 render-next 任务预留(task.take_id)
 *     或按该 shot 的 keyframe_takes / stage=keyframe render_tasks 数字最大值 +1 生成;
 *   - 每 (shot, stage=keyframe) 至多一个 selected;改选时原 selected 降为 candidate
 *     (不降 rejected),且绑定旧 keyframe 的下游 video task 失效
 *     (`task.keyframe.take_id === 旧 id` → `superseded_at` + `superseded_by:null`,不改 status);
 *   - `rejected` 是终态:不可 `--select` / `--review accept`。
 *
 * 用法:
 *   node tools/mark-keyframe.js <episode-dir> <shot-id> --take --task <task-id> --path <png> [--attempt-id <id>] [--request-id <id>] [--notes "..."]
 *   node tools/mark-keyframe.js <episode-dir> <shot-id> --select --take-id <kf-id>
 *   node tools/mark-keyframe.js <episode-dir> <shot-id> --reject --take-id <kf-id>
 *   node tools/mark-keyframe.js <episode-dir> <shot-id> --review --take-id <kf-id> --conclusion accept|reject
 *   node tools/mark-keyframe.js <episode-dir> <shot-id> --failed --task <task-id> --error "<msg>" [--transient|--hard|--terminal] [--attempt-id <id>] [--request-id <id>] [--billed|--no-billed] [--cost <n>]
 *   node tools/mark-keyframe.js <episode-dir> <shot-id> --pending
 */
'use strict';
const fs = require('fs');
const path = require('path');
const {
  atomicWriteJson, readJsonFile, isTaskSuperseded, normalizeTaskStatus, fileContentHash,
  appendTaskEvent, nextAttemptN
} = require('./build-manifest');
const {
  parseArgs, getTaskSnapshot, resolveAttempt, recordTaskFailure, appendCatalog
} = require('./mark-shot');
const { ensureLedger, recordOutcome, validateCost } = require('./quota-ledger');
const { withLock } = require('./lock');

const ROOT = path.resolve(__dirname, '..');

/** keyframe take_id 自增(前缀 kf-);避让 reservedIds(均由 render-next 预留) */
function nextKeyframeTakeId(takes, reservedIds) {
  const ids = [
    ...((takes || []).map(t => t.id)),
    ...(reservedIds || [])
  ];
  let max = 0;
  for (const id of ids) {
    const m = /^kf-(\d+)$/.exec(id || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `kf-${String(max + 1).padStart(3, '0')}`;
}

/** render_tasks 中该 shot 已预留的 keyframe take_id */
function reservedKeyframeIds(manifest, shotId) {
  return (manifest.render_tasks || [])
    .filter(t => t.shot_id === shotId && (t.stage || 'video') === 'keyframe' && t.take_id)
    .map(t => t.take_id);
}

/**
 * §3.8/A8:keyframe 阶段的当前 fingerprint。
 * 新 manifest 用 `shot.keyframe_hash`;旧 manifest 缺该字段时回退 `shot.input_hash`
 * (保持 M3a 旧数据可读写)。take/task 的 input_hash 与它同口径。
 */
function shotStageHash(shot) {
  return shot.keyframe_hash != null ? shot.keyframe_hash : shot.input_hash;
}

/**
 * keyframe 版 updateManifest(与 mark-shot 语义对称)。
 * @returns {{ manifest: object, createdTakeId: string|null }}
 */
function updateKeyframeManifest(absEpDir, shotId, opts) {
  const manifestPath = path.join(absEpDir, 'manifest.json');
  const manifest = readJsonFile(manifestPath, { label: 'manifest.json' });
  const shot = manifest.shots.find(s => s.id === shotId);
  if (!shot) throw new Error(`shot ${shotId} not found in manifest`);

  if (opts.cost != null) validateCost(opts.cost);
  ensureLedger(manifest);

  if (!shot.keyframe_takes) shot.keyframe_takes = [];
  let createdTakeId = null;

  switch (opts.action) {
    case 'take': {
      if (!opts.path) throw new Error('--take requires --path');
      if (!opts.taskId) {
        throw new Error('--take requires --task <task-id> (keyframe takes must bind to a render task snapshot; create one with render-next)');
      }
      const contentDigest = fileContentHash(opts.path);
      if (contentDigest === null) {
        throw new Error(`--take requires a readable artifact at --path (content digest unavailable): ${opts.path}`);
      }
      const task = getTaskSnapshot(manifest, opts.taskId);
      if (!task) throw new Error(`task ${opts.taskId} not found in manifest.render_tasks`);
      if (task.shot_id !== shotId) {
        throw new Error(`task ${opts.taskId} is for shot ${task.shot_id}, not ${shotId}`);
      }
      if (task.stage !== 'keyframe') {
        throw new Error(`task ${opts.taskId} is stage '${task.stage || 'video'}', not 'keyframe' — use mark-shot.js for video takes`);
      }

      // 回调身份解析 + A9 幂等/冲突
      const ident = resolveAttempt(task, opts, manifest);
      const takeAttemptId = ident.attempt_id || null;
      const takeRequestId = ident.request_id || opts.requestId || null;

      if (takeRequestId || takeAttemptId) {
        const existing = shot.keyframe_takes.find(t => t.task_id === opts.taskId
          && (takeRequestId ? t.request_id === takeRequestId : t.attempt_id === takeAttemptId));
        if (existing) {
          if (existing.content_digest === contentDigest) {
            console.log(`  request ${takeRequestId || takeAttemptId} for task ${opts.taskId} already recorded as ${existing.id} (idempotent)`);
            return { manifest, createdTakeId: existing.id };
          }
          throw new Error(`conflict: request ${takeRequestId || takeAttemptId} for task ${opts.taskId} already recorded as ${existing.id} with a different content digest (${existing.content_digest} != ${contentDigest}) — refusing to overwrite; local path is locator-only, only content digest decides conflicts`);
        }
      } else {
        const taskTakes = shot.keyframe_takes.filter(t => t.task_id === opts.taskId);
        const sameDigest = taskTakes.find(t => t.content_digest === contentDigest);
        if (sameDigest) {
          console.log(`  task ${opts.taskId} already has keyframe take ${sameDigest.id} with the same content digest (idempotent)`);
          return { manifest, createdTakeId: sameDigest.id };
        }
        if (taskTakes.length > 0) {
          throw new Error(`callback for task ${opts.taskId} has no request/attempt identity and a different content digest — pass --request-id (or --attempt-id) to record it as an independent request (refusing to silently drop a possibly paid result)`);
        }
      }

      let takeId = task.take_id;
      if (!takeId || (shot.keyframe_takes || []).some(t => t.id === takeId)) {
        takeId = nextKeyframeTakeId(shot.keyframe_takes, reservedKeyframeIds(manifest, shotId));
      }

      // 失效产物与终态迟到回调判定(与 mark-shot 同口径);keyframe 永不自动 selected
      const stageHash = shotStageHash(shot);
      // M4a:continue_from keyframe take 的 task.input_hash 叠加了上游尾帧 ref,
      // 与当前 base stage hash 对齐的是 task.base_input_hash(存在时以它为准)。
      const taskHashForStage = (task.base_input_hash != null) ? task.base_input_hash : task.input_hash;
      const staleArtifact = (taskHashForStage !== stageHash) || isTaskSuperseded(task);
      const normStatus = normalizeTaskStatus(task.status);
      const terminalLate = normStatus === 'blocked' || normStatus === 'cancelled';
      const alreadySucceeded = normStatus === 'succeeded';
      const inFlight = ['queued', 'submitted', 'running'].includes(normStatus);
      const lateOutcome = staleArtifact || (!inFlight && !alreadySucceeded && !terminalLate) || terminalLate;
      const takeStatus = (staleArtifact || terminalLate) ? 'superseded' : 'candidate';
      if (staleArtifact) {
        console.warn(`WARN: stale callback for task ${opts.taskId} (input_hash ${task.input_hash} != current ${stageHash}) — recording superseded keyframe take; NOT selecting it`);
      } else if (terminalLate) {
        console.warn(`WARN: late success for task ${opts.taskId} after terminal status ${normStatus} — recording superseded orphan keyframe take; task status NOT revived`);
      } else if (alreadySucceeded) {
        console.warn(`WARN: additional keyframe artifact for already-succeeded task ${opts.taskId} (request ${takeRequestId || 'n/a'}) — recording independent candidate take; NOT selecting it`);
      } else if (!inFlight) {
        console.warn(`WARN: late success for task ${opts.taskId} (was ${task.status}) — recording candidate keyframe take; NOT selecting it`);
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
          stage: 'keyframe',
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

      if ((shot.keyframe_takes || []).some(t => t.id === takeId)) {
        throw new Error(`keyframe take ${takeId} already exists for ${shotId} (duplicate take_id)`);
      }
      shot.keyframe_takes.push({
        id: takeId,
        path: opts.path,
        model: opts.model || task.model || 'unknown',
        input_hash: task.input_hash,
        task_id: opts.taskId,
        request_id: takeRequestId,
        content_digest: contentDigest,
        attempt_id: takeAttemptId,
        rendered_at: new Date().toISOString(),
        status: takeStatus,            // candidate(正常)/ superseded(stale/orphan)
        stage: 'keyframe',
        base_input_hash: task.base_input_hash || null, // M4a:不含上游尾帧的 base keyframe hash
        notes: opts.notes || ''
      });
      createdTakeId = takeId;
      // §4 keyframe 成功回写 = 一次 image success
      recordOutcome(ensureLedger(manifest), 'image', 'success', { cost: opts.cost });
      console.log(`  recorded keyframe ${takeId} for ${shotId} (status stays ${shot.status})`);
      break;
    }
    case 'select': {
      if (!opts.takeId) throw new Error('--select requires --take-id');
      if (shot.status === 'blocked') {
        throw new Error(`shot ${shotId} is blocked (${shot.blocked_reason || 'circuit breaker'}) — run --unblock before selecting`);
      }
      const take = shot.keyframe_takes.find(t => t.id === opts.takeId);
      if (!take) throw new Error(`keyframe take ${opts.takeId} not found in ${shotId}`);
      if (take.status === 'rejected') {
        throw new Error(`keyframe take ${opts.takeId} is rejected (terminal state), cannot select`);
      }
      if (take.human_review && take.human_review.conclusion === 'reject') {
        throw new Error(`keyframe take ${opts.takeId} was reviewed and rejected, cannot select`);
      }
      if (!take.path || !fs.existsSync(take.path)) {
        throw new Error(`keyframe take ${opts.takeId} file missing: ${take.path || '(null)'}`);
      }
      // D7 同口径:选中前硬性校验 input fingerprint(null = 来源未知 legacy 允许)
      // M4a:continue_from 尾帧使 take.input_hash 叠加了上游尾帧;
      // 此时 take.base_input_hash 与当前 base stage hash 对齐即视为同源。
      const stageHash = shotStageHash(shot);
      if (take.input_hash != null && take.input_hash !== stageHash && take.base_input_hash !== stageHash) {
        throw new Error(`keyframe take ${opts.takeId} input fingerprint mismatch (take ${take.input_hash}, current ${stageHash}) — cannot select a keyframe generated from different input; regenerate or restore the matching input`);
      }
      const prevSelected = shot.selected_keyframe;
      // 至多一个 selected:原 selected 降为 candidate(不降 rejected)
      for (const t of shot.keyframe_takes) {
        if (t.status === 'selected' && t.id !== take.id) t.status = 'candidate';
      }
      take.status = 'selected';
      shot.selected_keyframe = take.id;
      // §3.2 下游 video task 失效:绑定被替换旧 keyframe 的 video task 移出调度集合
      if (prevSelected && prevSelected !== take.id) {
        const nowIso = new Date().toISOString();
        for (const t of (manifest.render_tasks || [])) {
          if (t.shot_id !== shot.id) continue;
          if ((t.stage || 'video') !== 'video') continue;
          if (isTaskSuperseded(t)) continue;
          if (t.keyframe && t.keyframe.take_id === prevSelected) {
            t.superseded_at = nowIso;
            t.superseded_by = null;
            console.warn(`  WARN: superseding video task ${t.task_id} for ${shot.id} — keyframe ${prevSelected} replaced by ${take.id} (execution status ${t.status} preserved)`);
          }
        }
      }
      console.log(`  selected keyframe ${take.id} for ${shotId}`);
      break;
    }
    case 'reject': {
      if (!opts.takeId) throw new Error('--reject requires --take-id');
      const take = shot.keyframe_takes.find(t => t.id === opts.takeId);
      if (!take) throw new Error(`keyframe take ${opts.takeId} not found in ${shotId}`);
      const wasRejected = take.status === 'rejected';
      take.status = 'rejected';
      if (shot.selected_keyframe === take.id) shot.selected_keyframe = null;
      if (!wasRejected) recordOutcome(ensureLedger(manifest), 'image', 'reject', { cost: opts.cost });
      console.log(`  rejected keyframe ${take.id} for ${shotId}`);
      break;
    }
    case 'review': {
      if (!opts.takeId) throw new Error('--review requires --take-id');
      if (!opts.conclusion) throw new Error('--review requires --conclusion accept|reject');
      if (opts.conclusion !== 'accept' && opts.conclusion !== 'reject') {
        throw new Error('--conclusion must be accept or reject');
      }
      const take = shot.keyframe_takes.find(t => t.id === opts.takeId);
      if (!take) throw new Error(`keyframe take ${opts.takeId} not found in ${shotId}`);
      if (opts.conclusion === 'accept') {
        if (shot.status === 'blocked') {
          throw new Error(`shot ${shotId} is blocked (${shot.blocked_reason || 'circuit breaker'}) — run --unblock before approving`);
        }
        if (take.status === 'rejected' || (take.human_review && take.human_review.conclusion === 'reject')) {
          throw new Error(`keyframe take ${opts.takeId} is rejected (terminal state) — cannot accept`);
        }
        if (take.status === 'superseded' && take.input_hash !== shotStageHash(shot) && take.base_input_hash !== shotStageHash(shot)) {
          throw new Error(`keyframe take ${opts.takeId} is superseded (stale/orphan artifact from input ${take.input_hash}, current ${shotStageHash(shot)}) — cannot be approved`);
        }
        if (take.input_hash != null && take.input_hash !== shotStageHash(shot) && take.base_input_hash !== shotStageHash(shot)) {
          throw new Error(`keyframe take ${opts.takeId} was generated from input ${take.input_hash}, current is ${shotStageHash(shot)} — cannot approve as the current version`);
        }
      }
      take.human_review = {
        reviewed_input_hash: shotStageHash(shot),
        conclusion: opts.conclusion,
        reviewed_at: new Date().toISOString(),
        reviewer: process.env.USER || 'unknown'
      };
      if (opts.conclusion === 'reject') {
        const wasRejected = take.status === 'rejected';
        take.status = 'rejected';
        if (!wasRejected) recordOutcome(ensureLedger(manifest), 'image', 'reject', { cost: opts.cost });
        if (shot.selected_keyframe === take.id) shot.selected_keyframe = null;
      } else if (opts.conclusion === 'accept' && shot.selected_keyframe !== take.id) {
        if (!shot.selected_keyframe) {
          take.status = 'selected';
          shot.selected_keyframe = take.id;
        }
      }
      console.log(`  reviewed keyframe ${take.id} for ${shotId} (${opts.conclusion})`);
      break;
    }
    case 'failed': {
      if (!opts.taskId) {
        throw new Error('--failed requires --task <task-id> for keyframe tasks (create a task snapshot with render-next)');
      }
      recordTaskFailure({ manifest, shot, shotId, opts });
      break;
    }
    case 'pending': {
      if (shot.status === 'blocked') {
        throw new Error(`shot ${shotId} is blocked (${shot.blocked_reason || 'circuit breaker'}) — run --unblock before resetting to pending`);
      }
      shot.status = 'pending';
      shot.error = null;
      console.log(`  reset ${shotId} to pending (takes/keyframe_takes preserved)`);
      break;
    }
    default:
      throw new Error('no action (--take/--select/--reject/--review/--failed/--pending)');
  }

  atomicWriteJson(manifestPath, manifest);
  return { manifest, createdTakeId };
}

/** keyframe catalog 写入:复用 mark-shot 的 appendCatalog,以 stage='keyframe' 区分 */
function appendKeyframeCatalog(absEpDir, shotId, opts, manifest, createdTakeId, catalogPath) {
  return appendCatalog(absEpDir, shotId, Object.assign({}, opts, { stage: 'keyframe' }), manifest, createdTakeId, catalogPath);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.episodeDir || !opts.shotId || !opts.action) {
    console.error('Usage: node tools/mark-keyframe.js <episode-dir> <shot-id> --take --task <task-id> --path <png> [--attempt-id <id>] [--request-id <id>] [--notes "..."] | --select --take-id <kf-id> | --reject --take-id <kf-id> | --review --take-id <kf-id> --conclusion accept|reject | --failed --task <task-id> --error "<msg>" [--transient|--hard|--terminal] | --pending');
    return 1;
  }
  const absEpDir = path.isAbsolute(opts.episodeDir) ? opts.episodeDir : path.resolve(opts.episodeDir);
  const catalogPath = path.join(ROOT, 'catalog.json');
  try {
    withLock([absEpDir, catalogPath], () => {
      const { manifest, createdTakeId } = updateKeyframeManifest(absEpDir, opts.shotId, opts);
      appendKeyframeCatalog(absEpDir, opts.shotId, opts, manifest, createdTakeId, catalogPath);
    });
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    return 3;
  }
  console.log(`marked ${opts.shotId} (keyframe action: ${opts.action})`);
}

module.exports = { updateKeyframeManifest, appendKeyframeCatalog, nextKeyframeTakeId, reservedKeyframeIds, shotStageHash };

if (require.main === module) {
  process.exitCode = main();
}
