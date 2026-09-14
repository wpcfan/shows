#!/usr/bin/env node
/**
 * render-next.js — 打印下一个待渲染 shot 的完整参数 + 创建不可变任务快照
 *
 * V2.4:
 *   - 先分配 task_id,再冻结参考图到 .task-assets/<task_id>/<NN>-<basename>
 *     (按 task 隔离;NN 为 image 序号,同一 basename 不会互相覆盖)
 *   - task.image_paths = 冻结副本路径(外部生成器实际消费的输入)
 *     task.image_src_paths = 原始路径(展示/追溯)
 *     image_refs = [{ src_path, frozen_path, content_hash }]
 *   - 冻结前先校验全部图片存在;复制后校验副本 hash 与源一致;
 *     任一步失败 → 删除本次 task 的冻结目录后再抛错,不留半成品
 *   - 相对路径按项目 ROOT 解析(不依赖进程 cwd)
 *   - 仅当旧 submitted task 的 input_hash 与当前一致且冻结资产完整时复用;
 *     否则把旧 task 标记 obsolete 并创建新任务
 *   - take_id 取该 shot 已有 takes 与 render_tasks 数字后缀最大值 +1
 *
 * V2.5 (PRD v2.3 §3.5 M1):
 *   - 任务状态模型:active = queued|submitted|running|retry_wait,
 *     terminal = succeeded|failed|cancelled|superseded|blocked
 *   - 唯一性 (shot_id, stage, input_hash) 至多一条 active task;input_hash 变化时
 *     旧 active task 置 superseded(不再写 obsolete)
 *   - task 记录 stage 与 breaker_epoch
 *
 * V2.7 (PRD v2.8 A2/A9/A10):
 *   - 执行状态与有效期分离:input_hash 变化时旧 active task 不再改 status,
 *     只写 superseded_at + superseded_by;新快照 superseded_at=null
 *   - 可调度判定 = isActiveTaskStatus(status) && !isTaskSuperseded(task);
 *     retry_after 到期也不重派/不复用已失效任务
 *   - 每次派发生成/刷新 task.current_attempt_id = 'att-<8hex>'
 *
 * FIX6a:
 *   - 旧 active 任务的 supersede 落点延后到与新任务 append **同一临界区**
 *     (supersedeActiveTasksForShot,唯一一次 atomicWriteJson);tts/参考图冻结/
 *     FIX3-1 指纹核对等任何校验失败路径 manifest 保持原样
 * FIX6c:
 *   - pushAttempt 记录**完整输入 hash**(含 continue_from 上游尾帧),与 task.input_hash
 *     一致;FIX3-1 仍用不含尾帧的 base hash 与 manifest 对齐
 *
 * 用法:
 *   node tools/render-next.js <episode-dir> [--all]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteJson, readJsonFile, isActiveTaskStatus, isTaskSuperseded, computeStagePayloadHash, computeShotKeyframeHash, computeShotVideoHash, resolveStageRefsForShot, styleGuideFileDigest, secondsToFrames, DEFAULT_CONTINUE_FROM_OFFSET_SEC } = require('./build-manifest');
const { ensureLedger, recordOutcome } = require('./quota-ledger');
const { withLock } = require('./lock');
const { extractTailFrame: defaultExtractTailFrame, probeDurationSec: defaultProbeDurationSec } = require('./tail-frame');

const ROOT = path.resolve(__dirname, '..');

/**
 * 计算文件内容 hash(sha256 前 16 字符)
 */
function fileContentHash(absPath) {
  try {
    const buf = fs.readFileSync(absPath);
    return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

/** 相对路径按项目 ROOT 解析;绝对路径原样返回 */
function resolveInputPath(p) {
  return path.isAbsolute(p) ? p : path.resolve(ROOT, p);
}

/** 生成派发 attempt_id(§3.5 每次派发一个本地 attempt) */
function genAttemptId() {
  return 'att-' + crypto.randomBytes(4).toString('hex');
}

/**
 * §3.5/FIX3:记录一次派发 attempt。每次派发(新建快照、retry_wait 到期重派)
 * 向 task.attempts[] 追加 {attempt_id, at, input_hash};current_attempt_id 仅作兼容展示。
 */
function pushAttempt(task, attemptId, inputHash, atIso) {
  if (!Array.isArray(task.attempts)) task.attempts = [];
  task.attempts.push({ attempt_id: attemptId, at: atIso, input_hash: inputHash, request_id: null });
  return task.attempts[task.attempts.length - 1];
}

/**
 * 可调度判定(§3.5):执行状态为 active 且未失效(superseded_at == null)。
 * render-next 复用、retry_after 重派、旧 active 清理一律使用它。
 */
function isDispatchableTask(task) {
  return !!task && isActiveTaskStatus(task.status) && !isTaskSuperseded(task);
}

/**
 * FIX6a:把同 shot+stage 的旧可调度 active 任务移出调度集合(纯内存,写
 * superseded_at + superseded_by,**不改写执行状态**;失效历史保留)。
 *
 * 必须在「新任务 append 的同一临界区」调用,保证 supersede 与新任务只由同一次
 * atomicWriteJson 落盘;任何校验失败路径 manifest 保持原样,不会留下
 * 「旧任务已失效、新任务不存在」的损坏态。
 * @returns {number} 被 supersede 的任务数
 */
function supersedeActiveTasksForShot(manifest, shot, stage, taskId, nowIso) {
  let count = 0;
  for (const t of (manifest.render_tasks || [])) {
    if (t.shot_id === shot.id && (t.stage || 'video') === stage && isDispatchableTask(t)) {
      t.superseded_at = nowIso;
      t.superseded_by = taskId;
      console.warn(`  WARN: superseding stale active task ${t.task_id} for ${shot.id} [${stage}] (execution status ${t.status} preserved)`);
      count++;
    }
  }
  return count;
}

/**
 * 纯函数:该 shot 的下一个 take_id。
 * 取 shot.takes 与 render_tasks 中该 shot 已预留的 take_id 的数字后缀最大值 +1。
 */
function computeNextTakeId(shot, renderTasks) {
  const ids = [];
  for (const t of (shot.takes || [])) ids.push(t.id);
  for (const t of (renderTasks || [])) {
    if (t.shot_id === shot.id) ids.push(t.take_id);
  }
  let max = 0;
  for (const id of ids) {
    const m = /^take-(\d+)$/.exec(id || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `take-${String(max + 1).padStart(3, '0')}`;
}

/**
 * 纯函数:该 shot 的下一个 keyframe take_id(前缀 kf-)。
 * 取 shot.keyframe_takes 与该 shot 的 stage='keyframe' render_tasks 数字后缀最大值 +1。
 */
function computeNextKeyframeTakeId(shot, renderTasks) {
  const ids = [];
  for (const t of (shot.keyframe_takes || [])) ids.push(t.id);
  for (const t of (renderTasks || [])) {
    if (t.shot_id === shot.id && (t.stage || 'video') === 'keyframe') ids.push(t.take_id);
  }
  let max = 0;
  for (const id of ids) {
    const m = /^kf-(\d+)$/.exec(id || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `kf-${String(max + 1).padStart(3, '0')}`;
}

/**
 * 纯函数:该 shot 的下一个 tts take_id(前缀 tts-)。
 * 取 shot.tts_takes 与该 shot 的 stage='tts' render_tasks 数字后缀最大值 +1
 * (与 computeNextKeyframeTakeId 同逻辑,避免与已预留 id 重号)。
 */
function computeNextTtsTakeId(shot, renderTasks) {
  const ids = [];
  for (const t of (shot.tts_takes || [])) ids.push(t.id);
  for (const t of (renderTasks || [])) {
    if (t.shot_id === shot.id && (t.stage || 'video') === 'tts') ids.push(t.take_id);
  }
  let max = 0;
  for (const id of ids) {
    const m = /^tts-(\d+)$/.exec(id || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `tts-${String(max + 1).padStart(3, '0')}`;
}

/**
 * shot 是否已有可用的 selected keyframe(rejected/superseded 不算)。
 */
function shotHasSelectedKeyframe(shot) {
  if (!shot || !shot.selected_keyframe) return false;
  const kf = (shot.keyframe_takes || []).find(t => t && t.id === shot.selected_keyframe);
  return !!kf && kf.status !== 'rejected' && kf.status !== 'superseded';
}

/**
 * §3.4 当前选中的 tts take 是否可用:`selected_tts` 指向一个非 rejected
 * 且 `input_hash === shot.tts_hash` 的 take。
 */
function selectedTtsTake(shot) {
  if (!shot || !shot.selected_tts) return null;
  if (shot.tts_hash == null) return null;
  const t = (shot.tts_takes || []).find(x => x && x.id === shot.selected_tts);
  if (!t || t.status === 'rejected') return null;
  if (t.input_hash !== shot.tts_hash) return null;
  return t;
}

/**
 * 产物级缓存:任一同 hash 的非 rejected take(selected_tts 指向时优先)。
 * 命中则说明该 shot 的 TTS 产物已存在,无需再发请求。
 */
function findUsableTtsTake(shot) {
  if (!shot || !shot.dialogue_text || shot.tts_hash == null) return null;
  const sel = selectedTtsTake(shot);
  if (sel) return sel;
  return (shot.tts_takes || []).find(t => t && t.status !== 'rejected' && t.input_hash === shot.tts_hash) || null;
}

/**
 * 该 shot 的目标 stage(§3.4/§3.2):有 dialogue_text 且无已选可用 tts take
 * → tts;否则 → keyframe/video。
 * 注:存在未选中的同 hash take 仍返回 tts——派发时由产物缓存分支认领
 * (selected_tts 落位、记一次 cache_hit),不新建任务。
 */
function targetStage(manifest, shot) {
  if (shot && shot.dialogue_text && !selectedTtsTake(shot)) return 'tts';
  return (manifest.require_keyframe === true && !shotHasSelectedKeyframe(shot)) ? 'keyframe' : 'video';
}

/** 已冻结资产是否完整:所有 frozen_path 存在且内容 hash 与记录一致 */
function frozenAssetsIntact(task) {
  const refs = task.image_refs;
  if (!refs) return false;
  // 无参考图的任务:冻结目录为空,视为完整
  for (const r of refs) {
    if (!r.frozen_path || !fs.existsSync(r.frozen_path)) return false;
    if (fileContentHash(r.frozen_path) !== r.content_hash) return false;
  }
  return true;
}

/**
 * §3.8/A8:该 shot 某 stage 的当前 fingerprint。
 * keyframe 任务用 `shot.keyframe_hash`(keyframe-stage hash);video 任务用 `shot.input_hash`
 * (video-stage hash,含 selected keyframe digest)。
 */
function shotStageHash(shot, stage) {
  if (stage === 'keyframe') return shot.keyframe_hash || null;
  if (stage === 'tts') return shot.tts_hash || null;
  return shot.input_hash;
}

/** 组装返回给调用方的 out 对象 */
function buildOut(shot, task) {
  return {
    shot_id: shot.id,
    status: shot.status,
    stage: task.stage || 'video',
    task_id: task.task_id,
    attempt_id: task.current_attempt_id || null,
    prompt: task.prompt,
    image_paths: task.image_paths,
    image_src_paths: task.image_src_paths || [],
    image_refs: task.image_refs || [],
    keyframe: task.keyframe || null,
    continue_from: task.continue_from || null,
    tts: task.tts || null,
    duration: task.duration,
    ratio: task.ratio,
    resolution: task.resolution,
    model: task.model,
    take_id: task.take_id,
    take_path: task.take_path,
    file_path: task.take_path
  };
}

/**
 * retry_wait 是否仍在退避窗口内(P1-2:retry_after 必须被执行,不得提前重发)
 */
function isTaskRetryWaiting(task, nowMs) {
  if (!task || task.status !== 'retry_wait') return false;
  if (!task.retry_after) return false;
  const t = Date.parse(task.retry_after);
  if (!Number.isFinite(t)) return false;
  return t > nowMs;
}

/** 当前处于退避窗口且未失效的 task(供 CLI 提示) */
function collectRetryWaits(manifest, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  return (manifest.render_tasks || [])
    .filter(t => isTaskRetryWaiting(t, now) && !isTaskSuperseded(t))
    .map(t => ({ task_id: t.task_id, shot_id: t.shot_id, retry_after: t.retry_after }));
}

/**
 * §3.3/M4a:continue_from 的 offset 帧号(canonicalize 权威在 build-manifest)。
 * 优先读 build-manifest 写入的 `continue_from_offset_frames`;
 * 缺失时按 `continue_from_offset` 秒(缺省 -0.1)用 episode FPS 换算。
 */
function resolveContinueFromOffsetFrames(shot, fps) {
  if (shot && Number.isInteger(shot.continue_from_offset_frames)) {
    return shot.continue_from_offset_frames;
  }
  const raw = (shot && shot.continue_from_offset !== undefined && shot.continue_from_offset !== null)
    ? shot.continue_from_offset
    : DEFAULT_CONTINUE_FROM_OFFSET_SEC;
  return secondsToFrames(raw, fps).frames;
}

/**
 * §3.3/M4a:解析 continue_from 上游 shot 的 selected video take。
 * 缺失 take / 文件不存在 → 抛错(弱承诺要求上游先完成)。
 */
function resolveContinueFromUpstream(manifest, shot) {
  if (!shot || typeof shot.continue_from !== 'string' || shot.continue_from.length === 0) return null;
  const upstream = (manifest.shots || []).find(s => s && s.id === shot.continue_from);
  const take = upstream ? (upstream.takes || []).find(t => t && t.id === upstream.selected_take) : null;
  const takePath = take && take.path ? resolveInputPath(take.path) : null;
  if (!upstream || !take || !takePath || !fs.existsSync(takePath)) {
    throw new Error(`continue_from upstream ${shot.continue_from} has no selected video take — finish upstream before keyframe generation`);
  }
  return { upstream_shot_id: upstream.id, upstream_duration: upstream.duration, take_id: take.id, take_path: takePath, take_digest: take.content_digest || fileContentHash(takePath) };
}

/**
 * §3.8/§3.3:复用 continue_from keyframe 任务前，校验其绑定仍与上游当前 selected take 一致。
 * - 内容等价优先（upstream_take_digest 相同，take_id 变了仍可复用）；无 digest 时退回 take_id。
 * - shot 无 continue_from 时，任务也不得带 continue_from（反之同理）。
 */
function continueFromBindingIntact(task, shot, manifest) {
  const upstreamId = shot && shot.continue_from;
  if (!upstreamId) return !(task && task.continue_from);
  if (!task || !task.continue_from) return false;
  if (task.continue_from.upstream_shot_id !== upstreamId) return false;
  let current = null;
  try { current = resolveContinueFromUpstream(manifest, shot); } catch { return false; }
  const recordedDigest = task.continue_from.upstream_take_digest || null;
  const currentDigest = current.take_digest || null;
  if (recordedDigest && currentDigest) return recordedDigest === currentDigest;
  return task.continue_from.take_id === current.take_id;
}

/**
 * 为 pending/stale 的可派发 shot 创建不可变任务快照(stage 感知)。
 * 默认队列顺序:keyframe-pending 优先,再 video-eligible;
 * opts.videoOnly=true 时只考虑 video-eligible(keyframe 已 selected 或 require_keyframe!==true)。
 * 退避窗口内的 retry_wait task 不派发、也不阻塞其它 shot。
 * @param {string} absEpDir
 * @param {{now?:number, videoOnly?:boolean}} [opts] now 便于测试注入
 * @returns {{ shot, task, out } | null}  无待渲染/全部退避中时返回 null
 */
function createRenderTask(absEpDir, opts = {}) {
  const nowMs = Number.isFinite(opts.now) ? opts.now : Date.now();
  const videoOnly = opts.videoOnly === true;
  const extractTailFrame = typeof opts.extractTailFrame === 'function' ? opts.extractTailFrame : defaultExtractTailFrame;
  const probeDurationSec = typeof opts.probeDurationSec === 'function' ? opts.probeDurationSec : defaultProbeDurationSec;
  const manifestPath = path.join(absEpDir, 'manifest.json');
  const manifest = readJsonFile(manifestPath, { label: 'manifest.json' });
  const episodeFps = Number.isInteger(manifest.fps) && manifest.fps > 0 ? manifest.fps : 30;

  const allTodo = manifest.shots.filter(s => s.status === 'pending' || s.status === 'stale');
  if (allTodo.length === 0) return null;
  if (!manifest.render_tasks) manifest.render_tasks = [];

  // stage 判定 + 队列顺序:tts → keyframe-pending → video-eligible(§3.4:TTS 先于视频渲染)
  const tagged = allTodo.map(s => ({ shot: s, stage: targetStage(manifest, s) }));
  const eligible = videoOnly ? tagged.filter(x => x.stage === 'video') : tagged;
  const ordered = eligible.filter(x => x.stage === 'tts')
    .concat(eligible.filter(x => x.stage === 'keyframe'))
    .concat(eligible.filter(x => x.stage === 'video'));
  if (ordered.length === 0) return null;

  // 选择第一个可派发的 shot;匹配的 active task 若在退避窗口内则跳过
  let shot = null;
  let sameHash = null;
  let stage = null;
  for (const cand of ordered) {
    const s = cand.shot;
    const currentHash = shotStageHash(s, cand.stage);
    if (cand.stage === 'tts') {
      // tts 任务无冻结资产/上游尾帧,按 input_hash 直接匹配可调度 active 任务
      const active = manifest.render_tasks.find(
        t => t.shot_id === s.id && (t.stage || 'video') === 'tts'
          && isDispatchableTask(t) && t.input_hash === currentHash
      );
      if (active && isTaskRetryWaiting(active, nowMs)) continue;
      shot = s;
      stage = 'tts';
      sameHash = active || null;
      break;
    }
    const active = manifest.render_tasks.find(
      t => t.shot_id === s.id && (t.stage || 'video') === cand.stage
        && isDispatchableTask(t)
        && (t.input_hash === currentHash || t.base_input_hash === currentHash)
        && frozenAssetsIntact(t)
        && continueFromBindingIntact(t, s, manifest)
    );
    if (active && isTaskRetryWaiting(active, nowMs)) continue;
    shot = s;
    stage = cand.stage;
    sameHash = active || null;
    break;
  }
  if (!shot) {
    const waiting = collectRetryWaits(manifest, nowMs);
    console.warn(`  all pending shots are in retry backoff (${waiting.map(w => `${w.shot_id} until ${w.retry_after}`).join(', ') || 'unknown'}) — not dispatching`);
    return null;
  }

  const ledgerStage = stage === 'keyframe' ? 'image' : (stage === 'tts' ? 'tts' : 'video');

  // §3.4 产物级缓存(TTS):已有同 input_hash 的非 rejected take → 不新建任务;
  // selected_tts 为空(或指向不可用 take)时认领该 take 并记一次 tts cache_hit。
  // 幂等:认领后 selected_tts 已落位,重复派发不再计数(也不回到本分支)。
  if (stage === 'tts') {
    const cached = findUsableTtsTake(shot);
    if (cached) {
      const alreadySelected = shot.selected_tts === cached.id;
      if (!alreadySelected) {
        shot.selected_tts = cached.id;
        recordOutcome(ensureLedger(manifest), 'tts', 'cache_hit');
        atomicWriteJson(manifestPath, manifest);
      }
      console.log(`tts cache hit ${cached.id}`);
      const originTask = manifest.render_tasks.find(t => t.task_id === cached.task_id) || null;
      const taskView = originTask || {
        task_id: cached.task_id || null,
        shot_id: shot.id,
        take_id: cached.id,
        take_path: cached.path,
        stage: 'tts',
        input_hash: cached.input_hash,
        tts: (shot.dialogue_text != null) ? {
          dialogue_text: shot.dialogue_text,
          voice_id: shot.voice_id,
          provider: (manifest.tts && manifest.tts.provider) || null,
          tts_params: (manifest.tts && manifest.tts.params) || {}
        } : null
      };
      return {
        shot,
        task: taskView,
        out: Object.assign(buildOut(shot, taskView), { note: 'tts cache hit' })
      };
    }
  }

  if (sameHash) {
    if (sameHash.status === 'retry_wait') {
      // P1-2:退避到期 → 重新派发,这是一次真实的供应商请求
      sameHash.status = 'submitted';
      sameHash.retry_after = null;
      sameHash.current_attempt_id = genAttemptId(); // §3.5 每次派发刷新 attempt
      pushAttempt(sameHash, sameHash.current_attempt_id, sameHash.input_hash, new Date(nowMs).toISOString());
      recordOutcome(ensureLedger(manifest), ledgerStage, 'request');
      atomicWriteJson(manifestPath, manifest);
      return {
        shot,
        task: sameHash,
        out: Object.assign(buildOut(shot, sameHash), { note: 'retry_after elapsed — re-submitted' })
      };
    }
    // §4 幂等复用 = 缓存命中(不产生新请求,成本计 0);需持久化 ledger 增量。
    // D2:cache_hits 语义固定为「避免的真实请求数」——每个 task 至多计一次,
    // 轮询式反复复用不再线性抬高(仍返回同一 task)。
    if (!sameHash.cache_hit_counted) {
      sameHash.cache_hit_counted = true;
      recordOutcome(ensureLedger(manifest), ledgerStage, 'cache_hit');
      atomicWriteJson(manifestPath, manifest);
    }
    return {
      shot,
      task: sameHash,
      out: Object.assign(buildOut(shot, sameHash), { note: 'reusing existing active task (idempotent)' })
    };
  }
  // FIX6a:唯一约束与调度集合(§3.5/A10)的 supersede 落点延后到与新任务 append
  // 同一临界区(见下方各分支 push 前调用 supersedeActiveTasksForShot);校验失败时
  // manifest 保持原样。
  const nowIso = new Date(nowMs).toISOString();
  const taskId = `task-${crypto.randomUUID().slice(0, 8)}`;

  // §3.4/M5:tts 任务快照。无冻结参考图/上游尾帧;hash 即 shot.tts_hash。
  // FIX3-1 口径:按 manifest.tts(provider/params)+ shot 字段重算并与 shot.tts_hash 核对,
  // 不一致 → 报错指向重建(不写半成品任务)。
  if (stage === 'tts') {
    const schemaVersion = manifest.schema_version || 1;
    const expectedHash = shot.tts_hash;
    if (!expectedHash) {
      throw new Error(`manifest has no tts_hash for ${shot.id} — rebuild manifest before dispatching (node tools/build-manifest.js <episode-dir>)`);
    }
    const provider = (manifest.tts && manifest.tts.provider) || null;
    const ttsParams = (manifest.tts && manifest.tts.params) || {};
    if (!provider || provider.name == null || provider.model == null || provider.version == null) {
      throw new Error(`manifest is missing the resolved tts provider for ${shot.id} — rebuild manifest before dispatching (node tools/build-manifest.js <episode-dir>)`);
    }
    const recomputed = computeStagePayloadHash({
      schemaVersion,
      stage: 'tts',
      dialogueText: shot.dialogue_text,
      voiceId: shot.voice_id,
      provider,
      ttsParams,
      styleGuideDigest: null
    });
    if (recomputed !== expectedHash) {
      throw new Error(`input fingerprint mismatch for ${shot.id} [tts]: manifest stores ${expectedHash}, recomputed ${recomputed} — rebuild manifest before dispatching (node tools/build-manifest.js <episode-dir>)`);
    }
    const ttsTakeId = computeNextTtsTakeId(shot, manifest.render_tasks);
    const ttsTakePath = path.join(absEpDir, 'audio', `${shot.id}-${ttsTakeId}.mp3`);
    const ttsAttemptId = genAttemptId();
    const ttsTask = {
      task_id: taskId,
      shot_id: shot.id,
      take_id: ttsTakeId,
      take_path: ttsTakePath,
      stage: 'tts',
      input_hash: expectedHash,
      tts: {
        dialogue_text: shot.dialogue_text,
        voice_id: shot.voice_id,
        provider,
        tts_params: ttsParams
      },
      breaker_epoch: shot.breaker_epoch || 0,
      current_attempt_id: ttsAttemptId,
      attempts: [],
      superseded_at: null,
      superseded_by: null,
      created_at: new Date().toISOString(),
      status: 'submitted'
    };
    pushAttempt(ttsTask, ttsAttemptId, expectedHash, nowIso);
    // FIX6a:supersede 与新任务同一临界区(仅此一次落盘)
    supersedeActiveTasksForShot(manifest, shot, stage, taskId, nowIso);
    manifest.render_tasks.push(ttsTask);
    // §4 新任务 = 一次真实请求(tts 账本);tts.js 记 success 时不得重复计 request
    recordOutcome(ensureLedger(manifest), 'tts', 'request');
    atomicWriteJson(manifestPath, manifest);
    return { shot, task: ttsTask, out: buildOut(shot, ttsTask) };
  }

  const shotNum = shot.id.replace(/^s\d+-shot-/, '').padStart(3, '0');
  let takeId, takePath;
  if (stage === 'keyframe') {
    takeId = computeNextKeyframeTakeId(shot, manifest.render_tasks);
    takePath = path.join(absEpDir, 'shots', `shot-${shotNum}-${takeId}.png`);
  } else {
    takeId = computeNextTakeId(shot, manifest.render_tasks);
    takePath = path.join(absEpDir, 'shots', `shot-${shotNum}-${takeId}.mp4`);
  }

  // 校验全部参考图存在(解析为绝对路径) — 必须在创建任何冻结目录之前
  // §3.8/A8:refs 带 hash_role,供 stage payload hash 使用
  const hashRefs = resolveStageRefsForShot(shot);
  const srcPaths = hashRefs.map(r => resolveInputPath(r.path));
  for (const p of srcPaths) {
    if (!fs.existsSync(p)) {
      throw new Error(`reference image not found for ${shot.id}: ${p} (submit blocked — fix input before generating)`);
    }
  }

  // §3.3/M4a:keyframe 任务在 continue_from 弱承诺下需引用上游尾帧。
  // 上游缺 selected video take → 在写入任何任务/冻结资产前 fail-closed。
  let continueFromRef = null;
  if (stage === 'keyframe') {
    const upstream = resolveContinueFromUpstream(manifest, shot);
    if (upstream) {
      continueFromRef = Object.assign({}, upstream, {
        offset_frames: resolveContinueFromOffsetFrames(shot, episodeFps)
      });
    }
  }

  // video 任务:若有 selected keyframe → 冻结该 keyframe 并记录绑定
  // (M3b §3.8:keyframe digest 以 keyframe:selected 进 video refs / first_frame)
  let selectedKf = null;
  if (stage === 'video' && shotHasSelectedKeyframe(shot)) {
    selectedKf = (shot.keyframe_takes || []).find(t => t && t.id === shot.selected_keyframe) || null;
  }

  const schemaVersion = manifest.schema_version || 1;
  const styleGuideDigest = styleGuideFileDigest();
  const keyframeMode = manifest.keyframe_mode || 'reference';
  const frozenDir = path.join(absEpDir, '.task-assets', taskId);
  let imageRefs = [];
  let keyframeBinding = null;
  // §3.3/M4a:上游尾帧(仅 keyframe + continue_from),作为生成器输入 ref,
  // 并进入 task.continue_from 与 keyframe-stage hash。
  let upstreamTail = null;

  try {
    if (srcPaths.length || selectedKf || continueFromRef) fs.mkdirSync(frozenDir, { recursive: true });
    for (let i = 0; i < srcPaths.length; i++) {
      const src = srcPaths[i];
      const contentHash = fileContentHash(src);
      if (!contentHash) {
        throw new Error(`cannot hash reference image for ${shot.id}: ${src}`);
      }
      const frozenPath = path.join(frozenDir, `${String(i + 1).padStart(2, '0')}-${path.basename(src)}`);
      fs.copyFileSync(src, frozenPath);
      const copyHash = fileContentHash(frozenPath);
      if (copyHash !== contentHash) {
        throw new Error(`frozen copy hash mismatch for ${shot.id}: ${src}`);
      }
      imageRefs.push({
        src_path: src, frozen_path: frozenPath, content_hash: contentHash,
        role: hashRefs[i] && hashRefs[i].role, hash_role: hashRefs[i] && hashRefs[i].hash_role
      });
    }

    if (selectedKf) {
      const kfSrc = resolveInputPath(selectedKf.path);
      if (!kfSrc || !fs.existsSync(kfSrc)) {
        throw new Error(`selected keyframe ${selectedKf.id} file missing for ${shot.id}: ${selectedKf.path || '(null)'}`);
      }
      const kfDigest = fileContentHash(kfSrc);
      if (!kfDigest) {
        throw new Error(`cannot hash selected keyframe ${selectedKf.id} for ${shot.id}: ${kfSrc}`);
      }
      const frozenPath = path.join(frozenDir, `kf-${path.basename(kfSrc)}`);
      fs.copyFileSync(kfSrc, frozenPath);
      if (fileContentHash(frozenPath) !== kfDigest) {
        throw new Error(`frozen keyframe copy hash mismatch for ${shot.id}: ${kfSrc}`);
      }
      keyframeBinding = { take_id: selectedKf.id, content_digest: kfDigest, frozen_path: frozenPath };
    }

    // FIX3/Bug1:冻结后用**冻结副本**重算 stage fingerprint 并核对 manifest 记录。
    // 不一致说明 manifest 不新鲜(输入图被替换/改稿未重建)→ 拒绝派发,不写半成品任务。
    // §3.8/A8:keyframe 阶段核对 shot.keyframe_hash;video 阶段核对 shot.input_hash
    // (含 selected keyframe digest 与 keyframe_mode)。
    // §3.3/M4a:continue_from 尾帧 + cut_frame 在派发时才可知,因此 FIX3 以
    // **不含尾帧的 base hash** 对齐 manifest,任务记录叠加尾帧后的 stage hash。
    if (continueFromRef) {
      const tailPath = path.join(frozenDir, 'upstream-tail.png');
      const extractResult = extractTailFrame({
        videoPath: continueFromRef.take_path,
        offsetFrames: continueFromRef.offset_frames,
        fps: episodeFps,
        outPath: tailPath
      });
      const tailDigest = fileContentHash(tailPath);
      if (!tailDigest) {
        throw new Error(`cannot hash upstream tail frame for ${shot.id}: ${tailPath}`);
      }
      let durationSec = extractResult && Number.isFinite(extractResult.durationSec) ? extractResult.durationSec : null;
      if (durationSec === null) {
        try { durationSec = probeDurationSec(continueFromRef.take_path); } catch { durationSec = null; }
      }
      const durationFrames = durationSec !== null
        ? secondsToFrames(durationSec, episodeFps).frames
        : secondsToFrames(continueFromRef.upstream_duration || 0, episodeFps).frames;
      const cutFrame = Math.max(0, Math.round(durationFrames + continueFromRef.offset_frames));
      upstreamTail = {
        role: 'upstream_tail:continue_from',
        hash_role: 'upstream_tail:continue_from',
        src_path: continueFromRef.take_path,
        frozen_path: tailPath,
        path: tailPath,             // §3.8 ref 契约别名
        content_hash: tailDigest,
        content_digest: tailDigest, // §3.8 ref 契约别名
        cut_frame: cutFrame
      };
    }

    const frozenShot = {
      prompt_final_en: shot.prompt_final_en,
      image_refs: imageRefs.map((r) => ({
        hash_role: r.hash_role, role: r.role, path: r.frozen_path
      })),
      ratio: shot.ratio,
      resolution: shot.resolution,
      duration: shot.duration,
      model: shot.model,
      selected_keyframe: null,
      keyframe_takes: []
    };
    let expectedHash;
    let frozenHash;
    let taskInputHash;
    if (stage === 'keyframe') {
      expectedHash = shot.keyframe_hash;
      if (!expectedHash) {
        throw new Error(`manifest has no keyframe_hash for ${shot.id} (old manifest) — rebuild manifest before dispatching (node tools/build-manifest.js <episode-dir>)`);
      }
      frozenHash = computeShotKeyframeHash(frozenShot, { schemaVersion, styleGuideDigest });
      taskInputHash = upstreamTail
        ? computeShotKeyframeHash(frozenShot, {
            schemaVersion, styleGuideDigest,
            upstreamTail: { path: upstreamTail.frozen_path, cut_frame: upstreamTail.cut_frame }
          })
        : frozenHash;
    } else {
      expectedHash = shot.input_hash;
      frozenHash = computeShotVideoHash(frozenShot, {
        schemaVersion, styleGuideDigest,
        keyframeDigest: keyframeBinding ? keyframeBinding.content_digest : null,
        keyframeMode
      });
      taskInputHash = frozenHash;
    }
    if (frozenHash !== expectedHash) {
      throw new Error(`input fingerprint mismatch for ${shot.id} [${stage}]: manifest stores ${expectedHash}, frozen inputs hash to ${frozenHash} — rebuild manifest before dispatching (node tools/build-manifest.js <episode-dir>)`);
    }

    const attemptId = genAttemptId();
    const allImageRefs = upstreamTail ? imageRefs.concat([upstreamTail]) : imageRefs;
    const task = {
      task_id: taskId,
      shot_id: shot.id,
      take_id: takeId,
      take_path: takePath,
      prompt: shot.prompt_final_en,
      image_paths: allImageRefs.map(r => r.frozen_path),  // 生成器实际消费的冻结输入
      image_src_paths: allImageRefs.map(r => r.src_path),  // 原始路径(追溯用)
      image_refs: allImageRefs,                            // 冻结版本(路径+内容hash+hash_role)
      duration: shot.duration,
      ratio: shot.ratio,
      resolution: shot.resolution,
      model: shot.model || 'default',
      stage,
      input_hash: taskInputHash,
      breaker_epoch: shot.breaker_epoch || 0,
      current_attempt_id: attemptId,       // §3.5 本次派发的本地 attempt_id(兼容展示)
      attempts: [],                        // §3.5/FIX3 派发 attempt 流(身份解析唯一来源)
      superseded_at: null,                 // §3.5 有效期分离:新快照可调度
      superseded_by: null,
      created_at: new Date().toISOString(),
      status: 'submitted'
    };
    // §3.3/M4a:continue_from 记录(weak commitment:只加参考,不改时长/裁切)
    if (upstreamTail) {
      task.base_input_hash = frozenHash;
      task.continue_from = {
        upstream_shot_id: continueFromRef.upstream_shot_id,
        take_id: continueFromRef.take_id,
        upstream_take_digest: continueFromRef.take_digest || null, // §3.8 内容等价身份
        offset_frames: continueFromRef.offset_frames,
        cut_frame: upstreamTail.cut_frame,
        content_digest: upstreamTail.content_hash
      };
    }
    // §3.2 video 任务记录 keyframe 绑定(§3.8 其 digest 通过 video hash 进入 input_hash)
    if (keyframeBinding) task.keyframe = keyframeBinding;
    // FIX6c:attempt 快照记录完整输入 hash(含 continue_from 上游尾帧),
    // 与 task.input_hash 一致;FIX3-1 仍用 expectedHash(base)对齐 manifest。
    pushAttempt(task, attemptId, taskInputHash, nowIso);

    // FIX6a:supersede 与新任务同一临界区(仅此一次落盘)
    supersedeActiveTasksForShot(manifest, shot, stage, taskId, nowIso);
    manifest.render_tasks.push(task);
    // §4 新任务 = 一次真实请求(keyframe → image 账本,其余 → video)
    recordOutcome(ensureLedger(manifest), ledgerStage, 'request');
    atomicWriteJson(manifestPath, manifest);

    return { shot, task, out: buildOut(shot, task) };
  } catch (e) {
    // 失败清理:删除本次 task 的冻结目录,不留半成品
    fs.rmSync(frozenDir, { recursive: true, force: true });
    throw e;
  }
}

function main() {
  const args = process.argv.slice(2);
  const episodeDir = args[0];
  const allFlag = args.includes('--all');
  const videoFlag = args.includes('--video');
  if (!episodeDir) {
    console.error('Usage: node tools/render-next.js <episode-dir> [--all] [--video]');
    return 1;
  }
  const absEpDir = path.isAbsolute(episodeDir) ? episodeDir : path.resolve(episodeDir);

  if (allFlag) {
    // --all 只读清点,不加锁;标注 stage 与 keyframe 状态
    let manifest;
    try { manifest = readJsonFile(path.join(absEpDir, 'manifest.json'), { label: 'manifest.json' }); }
    catch (e) {
      console.error(e.code === 'CORRUPT_JSON' ? `ERROR: ${e.message}` : `manifest.json not found in ${absEpDir} (run build-manifest.js first)`);
      return 2;
    }
    const todo = manifest.shots.filter(s => s.status === 'pending' || s.status === 'stale');
    if (todo.length === 0) { console.log('no pending or stale shots — all done'); return 0; }
    const waiting = collectRetryWaits(manifest);
    console.log(`Pending/stale shots (${todo.length}):`);
    for (const s of todo) {
      const w = waiting.find(x => x.shot_id === s.id);
      const stage = targetStage(manifest, s);
      const kfStatus = shotHasSelectedKeyframe(s)
        ? `keyframe:selected ${s.selected_keyframe}`
        : (manifest.require_keyframe === true ? 'keyframe:pending' : 'keyframe:n/a');
      console.log(`  ${s.id}  [${s.status}] [stage=${stage}] [${kfStatus}] [${s.duration}s ${s.ratio} ${s.resolution}]${w ? ` (retry_wait until ${w.retry_after})` : ''}  ${s.description_cn.slice(0, 60)}`);
    }
    return 0;
  }

  try {
    // D6:非 --all 的派发会写 manifest,以 episode 为粒度加跨进程锁
    const result = withLock(absEpDir, () => createRenderTask(absEpDir, { videoOnly: videoFlag }));
    if (!result) {
      let manifest = null;
      try { manifest = readJsonFile(path.join(absEpDir, 'manifest.json'), { label: 'manifest.json' }); } catch { /* manifest unreadable */ }
      const waiting = manifest ? collectRetryWaits(manifest) : [];
      if (waiting.length) console.log(`all pending shots are in retry backoff: ${waiting.map(w => `${w.shot_id} until ${w.retry_after}`).join(', ')}`);
      else if (videoFlag) console.log('no video-eligible shots — keyframe selection may be pending (run without --video for keyframes)');
      else console.log('no pending or stale shots — all done');
      return 0;
    }
    console.log(JSON.stringify(result.out, null, 2));
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    return 3;
  }
}

module.exports = { createRenderTask, fileContentHash, computeNextTakeId, computeNextKeyframeTakeId, computeNextTtsTakeId, resolveInputPath, frozenAssetsIntact, isTaskRetryWaiting, collectRetryWaits, isDispatchableTask, supersedeActiveTasksForShot, genAttemptId, pushAttempt, targetStage, shotHasSelectedKeyframe, selectedTtsTake, findUsableTtsTake, shotStageHash, resolveContinueFromOffsetFrames, resolveContinueFromUpstream, continueFromBindingIntact };

if (require.main === module) {
  process.exit(main());
}
