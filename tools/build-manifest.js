#!/usr/bin/env node
/**
 * build-manifest.js — script.yaml → manifest.json
 *
 * V2.2 改进:
 *   - input_hash 包含 model(从 script.defaults.model 或 shot.model)
 *   - 参考图使用内容 hash(sha256 of file bytes),不再用 mtime/size
 *   - render_tasks: render-next.js 创建不可变任务快照,mark-shot --task 引用
 *   - deriveStatus: 支持 human_review 记录(人工复核)
 *   - catalog 恢复:按原 take_id 恢复全部记录,不只取第一条
 *   - freshness check: verifyManifestFresh() 供 edit-episode/stitch 调用
 *
 * V2.3 改进:
 *   - deriveStatus:selected take 为 rejected 或 human_review.conclusion=reject 时
 *     直接 stale(优先级高于 accept/hash,与 validateTake 一致)(W6)
 *   - compareShotList:报告任一列表内重复 shot id(W7)
 *   - recoverTakesFromCatalog:同一 shot 多条 selected 报告冲突,不再静默取最后(W7)
 *   - resolveSelectionConflict:manifest 已有 selected_take 与 catalog 恢复不一致时报告
 *   - manifest 原子写(tmp + rename)(W9)
 *
 * V2.4 (PRD v2.3 §3.0 M0):
 *   - atomicWriteJson 支持故障注入(SHOWS_FAULT_ATOMIC_WRITE / opts.fault),模拟
 *     rename 前 crash;读侧 readJsonFile/readJsonFileOrNull 清理残留 tmp 并识别
 *     损坏 JSON(不静默使用半写文件,带恢复指引)
 *   - deriveStatus:superseded(旧 input_hash 的成功产物)→ stale,不得进成片
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  loadYaml, loadScript, parseStyleGuide, readText,
  buildPromptForShot, ROOT
} = require('./build-prompt');
const taskState = require('./task-state');
const { deriveIntent, validateIntent, intentFlags, detectDialogue, checkDialogueDeclaration } = require('./intent');
const { emptyLedger, normalizeLedger } = require('./quota-ledger');
const { withLock } = require('./lock');

/**
 * §3.7 画幅两级收敛:series → episode → '16:9'。
 * episode script.defaults.ratio 覆盖 series.seedance_defaults.ratio。
 */
function resolveEpisodeRatio(script, series) {
  const scriptRatio = script && script.defaults && script.defaults.ratio;
  if (scriptRatio) return scriptRatio;
  const seriesRatio = series && series.seedance_defaults && series.seedance_defaults.ratio;
  if (seriesRatio) return seriesRatio;
  return '16:9';
}

/** shot 级 ratio 覆盖 episode ratio(仅在逃生门放行时可达) */
function resolveShotRatio(shot, episodeRatio) {
  if (shot && shot.ratio) return shot.ratio;
  return episodeRatio;
}

function isPositiveInt(v) {
  return Number.isInteger(v) && v > 0;
}

/**
 * §3.3 episode 统一 FPS:script.defaults.fps → series.seedance_defaults.fps → 30。
 * build-manifest 是 fps 权威入口;解析结果必须为有限正整数,否则抛错。
 * @param {object} script
 * @param {object} series
 * @returns {number}
 */
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

/**
 * 秒 → 帧:frames = round(seconds * fps);residual = seconds - frames / fps。
 * §3.3 offset canonicalize 的权威换算入口(build-timeline 转发本函数)。
 * 允许负秒(continue_from_offset 默认 -0.1);fps 必须为正整数。
 * @returns {{frames:number, residual:number}}
 */
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

const DEFAULT_CONTINUE_FROM_OFFSET_SEC = -0.1;
const CONTINUE_FROM_MAX_DEPTH = 3;

/**
 * §3.3 continue_from 校验三件套(构建期 fail-closed)。纯函数。
 * 规则:
 *   1. self-reference:continue_from === 自身 id → reject;
 *   2. unknown / order:上游 id 不存在 → reject;上游在 script 顺序中位于本 shot 之后 → reject
 *      (PRD 仅要求上游顺序在前);
 *   3. cycle:沿 continue_from 链追溯回到已访问 shot → reject(错误中列出环);
 *   4. depth:链跳数 > 3 → reject(=3 允许)。
 * @param {Array<{id:string, continue_from?:string}>} shots script 顺序的镜头
 * @returns {{ok:boolean, errors:string[]}}
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

/**
 * 模拟 crash 的故障注入错误(PRD §3.0 M0-4):抛出后不得清理 tmp,
 * 以复现“进程在 tmp 写入与 rename 之间死亡”的现场。
 */
class SimulatedCrashError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SimulatedCrashError';
    this.code = 'SIMULATED_CRASH';
  }
}

/** 读到损坏 JSON(半写文件)时抛出:文件保持原样供检查,调用方决定丢弃/恢复 */
class CorruptJsonError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CorruptJsonError';
    this.code = 'CORRUPT_JSON';
  }
}

/**
 * 原子写 JSON:同目录 tmp 文件 + rename,避免写到一半损坏。
 * 故障注入(注入点可配):opts.fault 或环境变量 SHOWS_FAULT_ATOMIC_WRITE
 *   - 'before-tmp-write' → 写 tmp 前抛 SimulatedCrashError(无 tmp 残留)
 *   - 'after-tmp-write'  → 写 tmp 后、rename 前抛 SimulatedCrashError(模拟崩溃,故意留 tmp)
 *   - 非模拟故障仍抛原始错误并清理 tmp。
 */
function atomicWriteJson(filePath, obj, opts = {}) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  const fault = opts.fault || process.env.SHOWS_FAULT_ATOMIC_WRITE || null;
  try {
    if (fault === 'before-tmp-write') {
      throw new SimulatedCrashError(`fault injected: before-tmp-write (${filePath})`);
    }
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    if (fault === 'after-tmp-write') {
      // 模拟进程在 rename 前崩溃:不清 tmp、不改目标文件
      throw new SimulatedCrashError(`fault injected: after-tmp-write (${filePath}) — simulated crash, tmp left behind`);
    }
    fs.renameSync(tmp, filePath);
  } catch (e) {
    if (!(e instanceof SimulatedCrashError)) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort cleanup */ }
    }
    throw e;
  }
}

const TMP_MAX_AGE_MS = 60 * 1000;

/** 进程是否存活(EPERM = 存在但不属于当前用户,仍视为存活) */
function defaultIsPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!(e && e.code === 'EPERM'); }
}

/** 解析 .<base>.<pid>.<ts>.tmp */
function parseTmpFileName(name) {
  if (!name.startsWith('.') || !name.endsWith('.tmp')) return null;
  const core = name.slice(1, -4);
  const parts = core.split('.');
  if (parts.length < 3) return null;
  const pid = Number(parts[parts.length - 2]);
  const ts = Number(parts[parts.length - 1]);
  if (!Number.isInteger(pid) || !Number.isFinite(ts)) return null;
  return { pid, ts };
}

/**
 * 清理该文件对应的崩溃残留 tmp(只删本工具命名模式的 .<name>.*.tmp)。
 * P1-5 并发安全:存活写者的新鲜 tmp 视为 in-flight 保留;写者已死或超龄才清理。
 * @param {string} filePath
 * @param {{maxAgeMs?:number, now?:number, isAlive?:function}} [opts]
 */
function cleanupStaleTmpFiles(filePath, opts = {}) {
  const dir = path.dirname(filePath);
  const prefix = `.${path.basename(filePath)}.`;
  const maxAgeMs = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : TMP_MAX_AGE_MS;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const isAlive = typeof opts.isAlive === 'function' ? opts.isAlive : defaultIsPidAlive;
  const removed = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
      const full = path.join(dir, name);
      const parsed = parseTmpFileName(name);
      let ageMs = Infinity;
      try { ageMs = now - fs.statSync(full).mtimeMs; } catch { /* stat failed, keep Infinity */ }
      const alive = parsed ? isAlive(parsed.pid) : false;
      if (alive && ageMs <= maxAgeMs) continue; // 存活写者的 in-flight 文件,不得误删
      try { fs.rmSync(full, { force: true }); removed.push(name); } catch { /* best-effort cleanup */ }
    }
  } catch { /* dir unreadable, nothing to clean */ }
  return removed;
}

/**
 * 非严格读 JSON:先清理崩溃残留 tmp,再解析。
 * 损坏(半写/非法 JSON)不静默吞掉,返回 corrupt 标记 + 恢复指引。
 * @returns {{ value: any|null, corrupt: boolean, missing: boolean, guidance: string|null, cleaned_tmp: string[] }}
 */
function readJsonFileOrNull(filePath, opts = {}) {
  const label = opts.label || path.basename(filePath);
  const cleanedTmp = cleanupStaleTmpFiles(filePath, opts.cleanup);
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return { value: null, corrupt: false, missing: true, guidance: null, cleaned_tmp: cleanedTmp };
    throw e;
  }
  try {
    return { value: JSON.parse(raw), corrupt: false, missing: false, guidance: null, cleaned_tmp: cleanedTmp };
  } catch (e) {
    return {
      value: null, corrupt: true, missing: false,
      guidance: `${label} is corrupt (invalid JSON: ${e.message}). The corrupt file is NOT used and was left untouched for inspection; recover with: node tools/build-manifest.js <episode-dir> to rebuild (takes are recoverable from catalog.json), or restore a backup.`,
      cleaned_tmp: cleanedTmp
    };
  }
}

/** 严格读 JSON:损坏即抛 CorruptJsonError(带恢复指引);缺失抛 ENOENT */
function readJsonFile(filePath, opts = {}) {
  const r = readJsonFileOrNull(filePath, opts);
  if (r.corrupt) throw new CorruptJsonError(r.guidance);
  if (r.missing) {
    const e = new Error(`${opts.label || filePath} not found`);
    e.code = 'ENOENT';
    throw e;
  }
  return r.value;
}

/**
 * 规范化图片引用为 repo-relative 路径 + 内容 hash
 */
function normalizeImageRef(absPath, root) {
  let rel = path.relative(root, absPath);
  if (rel.startsWith('..')) rel = absPath;
  return { path: rel, content_hash: fileContentHash(absPath) };
}

/**
 * §3.8 canonical JSON:键排序、无空白、UTF-8;数值用 JSON.stringify 最简形式(无尾零)。
 * 作为 input_hash 的唯一序列化入口(排除本地路径/task_id/时间戳等非确定字段)。
 */
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

/**
 * §3.8 stage 输入契约:文件内容 digest(sha256 前 16 位)或 fail-closed 抛错。
 * 纯本地路径/take_id/task_id 不入 payload。
 */
function styleGuideFileDigest() {
  return fileContentHash(path.join(ROOT, 'style-guide.md'));
}

/**
 * 把 shot 的引用图解析为 `[{hash_role, role, path}]`。
 * - 优先使用 build-manifest 写入的 `shot.image_refs`(含 hash_role)
 * - legacy 回退:`shot.image_paths` 按位置合成 `shot.references[i]`(references 永远在末尾,
 *   与 collectImageRefs 的顺序一致)
 */
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

/**
 * §3.8 refs[] 规范化:每项只入 `{role, content_digest}`(顺序保留,顺序参与 hash)。
 * - `role` 取 `hash_role`(写死命名空间)优先,回退 `role`
 * - digest 可由 ref.content_digest 显式提供(keyframe:selected 等无本地路径的引用),
 *   否则 = fileContentHash(ref.path)
 * - `cut_frame` 仅在显式提供时保留(§3.8 upstream_tail ref: `{role, content_digest, cut_frame}`)
 * - 任一 digest 为 null/undefined → fail-closed 抛错(与 D8 一致),列出完整路径
 */
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

/**
 * §3.8 stage payload hash:`input_hash = SHA256(canonical_json(payload))` 前 16 位。
 * 三个 stage 互不继承,未出现的字段一律不入 hash。
 *
 * keyframe / video:
 *   `{schema_version, stage, resolved_prompt, refs[{role, content_digest}], model, params}`
 *   按存在性追加:`first_frame`(video 恒有:digest 或 null)、`continue_from{content_digest, cut_frame}`、
 *   `style_guide_digest`
 * tts(字段名写死):
 *   `{schema_version, stage:'tts', dialogue_text, voice_id, provider{name,model,version}, tts_params, style_guide_digest?}`
 *
 * @param {{schemaVersion?:number, stage:string, prompt?:string, refs?:Array, model?:object|string,
 *   params?:object, firstFrame?:string|null, continueFrom?:{content_digest:string, cut_frame:number},
 *   styleGuideDigest?:string|null, dialogueText?:string, voiceId?:string, provider?:object,
 *   ttsParams?:object}} input
 * @returns {string} 16 位 hex input_hash
 */
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
    // §3.8:video 阶段 first_frame 恒有(digest 或 null)
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

/**
 * 该 shot 当前可用 selected keyframe 的内容 digest(rejected/superseded 不算)。
 * 从 `shot.keyframe_takes[]` / `shot.selected_keyframe` 取 **存储的** content_digest。
 * @returns {string|null}
 */
function selectedKeyframeDigest(shot) {
  if (!shot || !shot.selected_keyframe) return null;
  const kf = (shot.keyframe_takes || []).find(t => t && t.id === shot.selected_keyframe);
  if (!kf || kf.status === 'rejected' || kf.status === 'superseded') return null;
  return kf.content_digest || null;
}

/**
 * §3.8 keyframe stage hash:params `{ratio, resolution}`,无 first_frame。
 * refs 来自 `shot.image_refs || shot.image_paths`。
 *
 * §3.3/M4a:可选 `opts.upstreamTail = {path, cut_frame, content_digest?}` 把上游尾帧
 * 以 `{role:'upstream_tail:continue_from', content_digest, cut_frame}` 追加进 refs
 * (PRD §3.8 refs 契约);digest 缺省 = fileContentHash(path)。
 */
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

/**
 * §3.8 video stage hash:params `{ratio, resolution, requested_video_duration}`。
 * - keyframe_mode='reference'(缺省):`first_frame=null` + keyframe 以 `keyframe:selected` 进 refs
 * - keyframe_mode='first_frame':`first_frame=keyframeDigest`,refs 不含该图
 */
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

/**
 * 计算输入指纹(§3.8):canonical JSON + SHA256。
 * - refs 只入参考图 content_hash,不得入本地路径(同图迁移/改名不产生假失效)
 * - schema_version 入 hash(§6:缺省 1);task_id/时间戳/take_id 等不入
 */
function computeInputHash(prompt, imagePaths, duration, ratio, resolution, model, opts = {}) {
  // D8:缺失/不可读参考图 fail-closed —— 绝不为不存在的图写入 content_hash: null
  // (两张不同的缺失图无法区分,会污染 fingerprint)。列出完整路径供修复。
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

// ============================================================
// §3.4/§3.8 TTS 接线(M5):dialogue 解析 / voice 解析 / provider 配置 / tts_hash / 字数估时
// ============================================================

/** 默认 TTS provider(PRD v2.13 定版:豆包语音合成模型 2.0 标准音色) */
const DEFAULT_TTS_PROVIDER = Object.freeze({ name: 'doubao', model: 'seed-tts-2.0', version: '2026-09-14' });
/** 默认 TTS 参数(仅 provider 配置缺省时落默认;payload 与请求一一对应) */
const DEFAULT_TTS_PARAMS = Object.freeze({ speed: 0.95 });
/** 默认字数估时速率(字/秒);`script.tts.chars_per_second` 可覆盖 */
const DEFAULT_TTS_CHARS_PER_SECOND = 5;
/** provider 必含字段(§3.8:缓存键含引擎/版本,缺失必须 fail-closed) */
const TTS_PROVIDER_FIELDS = ['name', 'model', 'version'];

/**
 * §3.4 TTS 配置解析(写死优先级):`script.tts` → `series.tts` → 默认。
 * - provider:所选配置的 provider 原样使用(不逐字段合并默认);整段缺失才落默认 provider。
 *   provider 缺 name/model/version 由调用方校验并 fail-closed。
 * - params:缺省 → 默认 `{speed:0.95}`。
 * - charsPerSecond:`script.tts.chars_per_second` 覆盖,缺省 5。
 * @returns {{provider:object|null, params:object, charsPerSecond:number, source:string}}
 */
function resolveTtsConfig(script, series) {
  const scriptTts = (script && typeof script.tts === 'object' && !Array.isArray(script.tts)) ? script.tts : null;
  const seriesTts = (series && typeof series.tts === 'object' && !Array.isArray(series.tts)) ? series.tts : null;
  const src = scriptTts || seriesTts;
  // 逐字段回落:高优先级源只覆盖它显式给出的字段,不得整体遮蔽 provider/params/chars_per_second
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

/**
 * `shot.dialogue` 归一化(§3.4):支持字符串或 `{text, voice_id}`。
 * trim 后为空一律视为无对白(`null`)。
 * @returns {{text:string, voiceId:string|null}|null}
 */
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

/**
 * §3.4 voice_id fail-closed 解析优先级:
 *   shot.dialogue.voice_id → shot.voice_id → scene.voice_id → script.tts.voice_id → series.tts.voice_id
 * @returns {{voiceId:string|null, location:string|null, checked:string[]}}
 */
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

/** provider 缺失的必填字段列表(缺任一即视为不合法) */
function missingTtsProviderFields(provider) {
  return TTS_PROVIDER_FIELDS.filter(f => !provider || provider[f] === undefined || provider[f] === null || provider[f] === '');
}

/**
 * §3.4 字数估时(仅预警,绝不用作阻断):`字符数 / charsPerSecond`,缺省 5 字/秒。
 * 空白不计数;空文本 → 0。
 * @param {string} text
 * @param {{charsPerSecond?:number}} [opts]
 * @returns {number}
 */
function estimateDialogueSeconds(text, { charsPerSecond } = {}) {
  const cps = (typeof charsPerSecond === 'number' && Number.isFinite(charsPerSecond) && charsPerSecond > 0)
    ? charsPerSecond : DEFAULT_TTS_CHARS_PER_SECOND;
  const raw = text == null ? '' : String(text);
  return raw.trim().length / cps;
}

/**
 * 统一状态派生规则。
 *
 * @param {object} shot
 * @param {string} currentInputHash
 * @param {string|null} prevStatus
 * @param {{activeTask?:object}} [opts]
 *   activeTask = 该 shot 当前可调度任务(isActiveTaskStatus && !isTaskSuperseded)。
 *   FIX5d:改稿重建后 rendering 镜头必须重新可调度——仅当存在 activeTask 且其 hash
 *   与当前输入一致时才保持 rendering,否则按常规规则派生(通常 stale / 无选片 pending)。
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
    // 输入已变 / 无 active task → 不再保持 rendering,落到常规派生(通常 stale;无选片 pending)
  }
  if (prevStatus === 'failed') return { status: 'failed', prev_hash: shot.prev_hash || null };
  // blocked 是熔断终态:除非显式 --unblock(调用方先清 shot.status),任何入口不得自行解除
  if (prevStatus === 'blocked' || shot.status === 'blocked') {
    return { status: 'blocked', prev_hash: shot.prev_hash || null };
  }

  const takes = shot.takes || [];
  const selectedId = shot.selected_take;

  if (!selectedId) return { status: 'pending', prev_hash: null };

  const selTake = takes.find(t => t.id === selectedId);
  if (!selTake) return { status: 'pending', prev_hash: null };

  // superseded(旧 input_hash 的成功产物,late/stale callback)→ 不得进成片
  if (selTake.status === 'superseded') {
    return { status: 'stale', prev_hash: selTake.input_hash || null };
  }

  // reject 是终态,优先级高于 accept/hash 判定(与 validateTake 一致)
  if (selTake.status === 'rejected') {
    return { status: 'stale', prev_hash: selTake.input_hash || (selTake.human_review && selTake.human_review.reviewed_input_hash) || null };
  }
  if (selTake.human_review && selTake.human_review.conclusion === 'reject') {
    return { status: 'stale', prev_hash: selTake.human_review.reviewed_input_hash || selTake.input_hash || null };
  }

  // 人工复核记录优先
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
 * (`isActiveTaskStatus(status) && !isTaskSuperseded(task)`;任 stage 命中即可,优先 video)。
 * @param {Array} tasks render_tasks
 * @param {string} shotId
 * @returns {object|null}
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
 * 保留 rejected 状态 + human_review;不静默去重(冲突在 recoverTakesFromCatalog 报告)
 * 返回 Map<shot_id, Array<catalog entry>>
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

  const map = new Map(); // shot_id → array of catalog entries
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
 * - 保留 rejected 状态(不再降级为 candidate)
 * - 恢复 human_review(审核历史不丢失)
 * - 检测同 take_id 冲突(同一 take_id 多条记录且状态/审核不一致 → 报告,取第一条但打印警告)
 * @returns {{ takes: array, conflicts: string[], selected_take: string|null }}
 */
function recoverTakesFromCatalog(shotId, entries) {
  const takes = [];
  const conflicts = [];
  const seenIds = new Set();
  let selectedTake = null;
  for (const rec of entries) {
    if (seenIds.has(rec.take_id)) {
      // 冲突:同一 take_id 多条记录
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
      input_hash: null, // catalog 来源未知
      rendered_at: rec.rendered_at || null,
      status,                       // 保留 rejected
      human_review: rec.human_review || null,  // 恢复审核历史
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
 * manifest 已有 selected_take 与 catalog 恢复出的 selected 不一致 → 报告冲突(fail-closed,保留 manifest 指针)
 * @returns {string[]}
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
 * @returns {{ removed: string[], added: string[], reordered: boolean, mismatches: string[] }}
 */
function compareShotList(scriptShotIds, manifestShotIds) {
  const scriptSet = new Set(scriptShotIds);
  const manifestSet = new Set(manifestShotIds);
  const removed = manifestShotIds.filter(id => !scriptSet.has(id)); // manifest 有、script 没有 = 删镜未重建
  const added = scriptShotIds.filter(id => !manifestSet.has(id));   // script 有、manifest 没有 = 新镜未构建
  const reordered =
    scriptShotIds.length === manifestShotIds.length &&
    scriptShotIds.every((id, i) => manifestShotIds[i] === id) === false &&
    removed.length === 0 && added.length === 0; // 同集合但顺序不同
  const mismatches = [...removed, ...added];
  // 任一列表内重复 shot id 会令 find()/timeline/take 恢复产生歧义 → 独立 issue
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
 * 重新从 script.yaml 计算 input_hash,与 manifest 中存储的对比
 * 额外校验:镜头集合(删镜/加镜)与顺序必须一致,否则视为 stale
 * @returns {{ fresh: boolean, stale_shots: string[], structure_issues: string[] }}
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

  // 收集 script 的有序镜头 ID
  const scriptShotIds = [];
  for (const scene of (script.scenes || [])) {
    for (const shot of (scene.shots || [])) {
      scriptShotIds.push(shot.id);
      const { prompt, image_refs } = buildPromptForShot(shot, scene, script, styleGuide);
      const ratio = resolveShotRatio(shot, episodeRatio);
      const model = shot.model || defaults.model || 'default';
      const mShot = manifest.shots.find(s => s.id === shot.id);
      // §3.8/A8:video-stage hash,含当前 selected keyframe digest 与 keyframe_mode
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
  // D6:manifest 重建写入以 episode 目录为粒度加跨进程锁
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
  // 保留旧 render_tasks 与 task_events(attempt 事件流,与任务快照同生命周期)
  const oldRenderTasks = oldManifest?.render_tasks || [];
  const oldTaskEvents = oldManifest?.task_events || [];
  // §4 配额账本:重建时保留;缺省自动初始化(与 render_tasks/task_events 同处理)
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

  // §3.3/M4a continue_from 校验三件套:在计算任何 hash 之前 fail-closed
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

  // §4/M5a 制作意图声明:edit.yaml(存在才读)+ script.intent 逐字段合并;
  // 在 continue_from 校验之后、任何 hash/写盘之前 fail-closed ——
  // 矛盾声明不得留到导出时猜优先级(PRD §4),失败时打印全部错误且不写 manifest。
  const editPath = path.join(absEpDir, 'edit.yaml');
  const edit = fs.existsSync(editPath) ? loadYaml(editPath) : null;
  const intent = deriveIntent(script, { edit });
  const intentValidation = validateIntent(intent);
  // FIX5b:声明 dialogue=false 但 script 实际有对白 → 与 intent 非法组合同口径 exit 4,不写 manifest。
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

  // §3.2/A8:keyframe_mode 缺省 'reference'(参考图引导);'first_frame' 待 E1 通过后启用
  const keyframeMode = script.keyframe_mode || oldManifest?.keyframe_mode || 'reference';

  // §3.7 shot 级 ratio 默认拒绝;allow_mixed_ratio 为显式逃生门
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
  // §3.4/§3.8 TTS 配置(写死优先级 script.tts → series.tts → 默认)与 fail-closed 错误收集。
  // 任何 TTS 配置错误在写盘前统一 exit 4(不留半成品 manifest)。
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

      // §3.4/§3.8 TTS 字段:仅有对白时写入 dialogue_text/voice_id/tts_hash/tts_takes/selected_tts;
      // 无对白绝不写这些字段(保证无对白 episode 的 manifest 字段不漂移)。
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
            styleGuideDigest: null // PRD §3.5 示例含 style_guide_digest,写死传 null
          });
          ttsFields = {
            dialogue_text: dialogue.text,
            voice_id: voice.voiceId,
            tts_hash: ttsHash,
            // 与其他 take 同生命周期:重建保留 tts_takes / selected_tts
            tts_takes: old?.tts_takes ? old.tts_takes.map(t => ({ ...t })) : [],
            selected_tts: old?.selected_tts || null
          };
          // §3.4 字数估时仅预警,绝不阻断/报错
          const est = estimateDialogueSeconds(dialogue.text, { charsPerSecond: ttsConfig.charsPerSecond });
          if (est > duration) {
            console.warn(`WARN: ${shot.id} dialogue estimate ${est.toFixed(2)}s exceeds shot duration ${duration}s (chars_per_second=${ttsConfig.charsPerSecond}) — overflow policy is not implemented yet (M5); continuing without blocking`);
          }
        }
      }

      // §3.3/M4a:continue_from offset canonicalize(秒 → 帧 + 残差);
      // 无 continue_from 时绝不写这两个字段。
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
      // M3a §3.2:keyframe take 与选片指针独立于 video take,重建时必须保留
      let keyframeTakes = old?.keyframe_takes ? old.keyframe_takes.map(t => ({ ...t })) : [];
      let selectedKeyframe = old?.selected_keyframe || null;

      // 迁移路径 1:旧 manifest 有 done/stale + output_path 但无 takes
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

      // 迁移路径 2:从 catalog 恢复全部 takes(保留 rejected + human_review)
      if (takes.length === 0 && catalogRecovery.has(shot.id)) {
        const recs = catalogRecovery.get(shot.id);
        const { takes: recTakes, conflicts, selected_take: recSel } = recoverTakesFromCatalog(shot.id, recs);
        takes = recTakes;
        for (const c of conflicts) console.warn(`  WARN: ${c}`);
        for (const c of resolveSelectionConflict(shot.id, selectedTake, recSel)) console.warn(`  WARN: ${c}`);
        if (recSel && !selectedTake) selectedTake = recSel; // 保留 manifest 既有指针(fail-closed)
        const rejectedCount = takes.filter(t => t.status === 'rejected').length;
        console.log(`  recovered ${shot.id}: ${takes.length} take(s) from catalog (${rejectedCount} rejected)`);
      }

      // §3.8/A8:keyframe-stage hash(无 selected keyframe 依赖)+ video-stage hash
      // (含 selected keyframe digest,keyframe_mode 决定 first_frame vs refs)
      const shotForHash = {
        prompt_final_en: prompt, image_refs, ratio, resolution, duration, model,
        selected_keyframe: selectedKeyframe, keyframe_takes: keyframeTakes
      };
      const keyframeHash = computeShotKeyframeHash(shotForHash, { schemaVersion, styleGuideDigest: sgDigest });
      const keyframeDigest = selectedKeyframeDigest(shotForHash);
      const inputHash = computeShotVideoHash(shotForHash, {
        schemaVersion, styleGuideDigest: sgDigest, keyframeDigest, keyframeMode
      });

      // 统一状态派生
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

  // §3.4/§3.8 TTS fail-closed:voice_id 解析不到 / provider 缺 name|model|version
  // → exit 4 且不写盘(与 continue_from / intent 同一口径)。
  if (ttsErrors.length) {
    console.error('ERROR: tts configuration validation failed (§3.4/§3.8):');
    for (const err of ttsErrors) console.error(`  ${err}`);
    console.error('  no manifest was written; fix the dialogue/voice/provider configuration and rebuild.');
    process.exit(4);
  }

  const manifest = {
    episode: script.episode,
    title: script.title,
    // §6 schema 版本意识:缺省 = 1;显式迁移由 migrate-episode 完成
    schema_version: script.schema_version || 1,
    require_keyframe: script.require_keyframe === true,
    // §3.2/A8:keyframe 承诺模式(缺省 'reference'),决定 video hash 的 first_frame 语义
    keyframe_mode: keyframeMode,
    version: (oldManifest?.version || 0) + 1,
    generated_at: new Date().toISOString(),
    // §3.3/M4a:episode FPS 权威值(build-timeline resolveTimelineFps 自动采用)
    fps: episodeFps,
    // §4/M5a 制作意图声明:声明决定豁免,不由输出缺什么决定;
    // declared/sources 供审计与 Gate 豁免判定(Gate 读它,不得由「输出缺什么」反推)。
    // v1(schema_version===1)同样写入供迁移/审计,不改变 v1 其他行为。
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
    render_tasks: oldRenderTasks, // 保留 render-next 创建的任务快照
    task_events: oldTaskEvents,   // 保留 attempt 事件流(§3.5)
    // §3.4/§3.8 解析后的 TTS 配置(render-next 建 tts 任务时读取 provider/params);
    // 无对白的 episode 不写该字段(避免无对白 manifest 字段漂移)。
    ...(hasDialogue ? {
      tts: {
        provider: ttsConfig.provider,
        params: ttsConfig.params,
        chars_per_second: ttsConfig.charsPerSecond
      }
    } : {}),
    reuse_records: oldManifest?.reuse_records || [], // 保留 fingerprint 复现恢复记录(§3.5)
    approvals: oldManifest?.approvals || [], // §3.3/M4c 保留 bound approval records(重建不丢人工验收)
    approval_history: oldManifest?.approval_history || [], // §3.3/M4c 保留被覆盖的历史记录(审计)
    quota_ledger: oldQuotaLedger, // 保留配额账本(§4)
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
  computeInputHash, computeStagePayloadHash, computeShotKeyframeHash, computeShotVideoHash,
  selectedKeyframeDigest, resolveStageRefsForShot, styleGuideFileDigest,
  deriveStatus, normalizeImageRef, fileContentHash, verifyManifestFreshness,
  selectActiveTaskForShot,
  compareShotList, recoverTakesFromCatalog, atomicWriteJson, resolveSelectionConflict, canonicalJson,
  SimulatedCrashError, CorruptJsonError, readJsonFile, readJsonFileOrNull, cleanupStaleTmpFiles,
  resolveEpisodeRatio, resolveShotRatio, findRatioViolations,
  resolveEpisodeFps, secondsToFrames, validateContinueFrom,
  estimateDialogueSeconds, resolveTtsConfig, normalizeDialogue, resolveVoiceId,
  missingTtsProviderFields,
  DEFAULT_TTS_PROVIDER, DEFAULT_TTS_PARAMS, DEFAULT_TTS_CHARS_PER_SECOND,
  DEFAULT_CONTINUE_FROM_OFFSET_SEC, CONTINUE_FROM_MAX_DEPTH,
  ...taskState
};

if (require.main === module) {
  main();
}
