#!/usr/bin/env node
/**
 * gate.js — PRD v2.11 §5 v2 Final Release Gate（总门槛，M5c / TECH-DEBT A5 矩阵部分）
 *
 * 「同时满足以下全部条件，才称为能发布一集」的**唯一裁定表**。本模块把 PRD §5 的
 * 15 条（编号 1..14，其中 4 拆为 4a/4b）实现成可离线单测的纯函数 + 可复用引擎：
 *
 *   - GATE_ITEMS          条目元数据（标题 + v1/v2 适用性，写死与 PRD §5 表一致）
 *   - reconcileQuotaLedger(manifest)  账本 ↔ 事件流对账（Gate #12）
 *   - parseSrtCues(text)  字幕 cue 解析（Gate #7；容忍 BOM/CRLF，坏格式抛错）
 *   - evaluateReleaseGate(input)      全量矩阵求值，返回 status/reasons/notes/probe
 *   - formatGateReport(result)        文本报告
 *   - runReleaseGateCli(argv)         CLI（read-only）
 *
 * 适用矩阵（PRD §5，写死）：v1（schema_version === 1）下 Gate #3/#4b/#6/#10/#11/#12/#13
 * 不适用（status='not_applicable'，notes 记 'v1 semantics'）；其余按 v1 语义运行。
 *
 * 桥接期政策（见 README「Release Gate」小节）：`deferred` 不阻塞 `--final` 退出码，但
 * 打印 NOT RELEASABLE；`--gate-strict` 立即按 PRD 全量阻塞。正式 E1 落地后默认改为 strict。
 * M5-AUD 已把 `#10` loudness 由 deferred 改为实判（`opts.loudness` / `--final` 分析；
 * 两者都无 → fail；offline 相位 → external）。
 *
 * 硬约束：零新依赖、CommonJS、纯函数可注入（opts.probeMedia / opts.verifyDecode /
 * opts.mediaResult / opts.analyzeLoudness / opts.loudness），CLI 只读、不写任何生产文件。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { intentFlags } = require('./intent');
const { verifyFinalMedia, checkAvLength } = require('./probe');
const { validateApprovals, clipList, findShot, findTake, absTakePath } = require('./approvals');
const { resolveCover } = require('./cover');
const { readJsonFile, isTaskSuperseded } = require('./build-manifest');
const { LEDGER_STAGES, LEDGER_COUNTERS } = require('./quota-ledger');
const { collectUnresolvedOverflow } = require('./dialogue');
const { verifyLoudness, analyzeLoudness } = require('./audio');

const TOOL_NAME = 'gate';
const TOOL_VERSION = '1.0.0';

/** SRT cue 越界容差（PRD §4：cues 全部落在 [0, final_duration]；±50ms 容差） */
const SRT_BOUNDS_TOLERANCE = 0.05;
/** 保守缺省 intent：无 intent 视为音频不适用（不得由产物反推，PRD §4） */
const DEFAULT_INTENT = { dialogue: false, audio: 'none', subtitles: 'none', silent: true };

// ---------------------------------------------------------------------------
// GATE_ITEMS — §5 适用矩阵（写死，与 PRD 表逐行一致）
// ---------------------------------------------------------------------------

const GATE_ITEMS = [
  { id: '1', title: 'M0 regression suite all green', v1: 'applicable', v2: 'applicable' },
  { id: '2', title: 'schema v1/v2 fixtures pass', v1: 'applicable', v2: 'applicable' },
  { id: '3', title: 'E1 report exists and interface version matches', v1: 'not_applicable', v2: 'applicable' },
  { id: '4a', title: 'no unresolved rejected/stale/blocked take dependency', v1: 'applicable', v2: 'applicable' },
  { id: '4b', title: 'all bound approval records valid', v1: 'not_applicable', v2: 'applicable' },
  { id: '5', title: 'every timeline clip resolves to a selected video take', v1: 'applicable', v2: 'applicable' },
  { id: '6', title: 'dialogue overflow = 0 / spill constraints', v1: 'not_applicable', v2: 'applicable' },
  { id: '7', title: 'subtitle cues within [0, final_duration]; artifact required when requires_subtitles', v1: 'applicable', v2: 'applicable' },
  { id: '8', title: 'A/V final stream length error < 100ms', v1: 'applicable', v2: 'applicable' },
  { id: '9', title: 'media attribute probe + full decode verification', v1: 'applicable', v2: 'applicable' },
  { id: '10', title: 'loudness within target', v1: 'not_applicable', v2: 'applicable' },
  { id: '11', title: 'cover can be generated', v1: 'not_applicable', v2: 'applicable' },
  { id: '12', title: 'quota ledger reconciles with event stream', v1: 'not_applicable', v2: 'applicable' },
  { id: '13', title: 'all cut_join junction approvals valid', v1: 'not_applicable', v2: 'applicable' },
  { id: '14', title: 'determinism under the same toolchain', v1: 'applicable', v2: 'applicable' },
];

const GATE_TITLES = GATE_ITEMS.reduce((acc, it) => { acc[it.id] = it.title; return acc; }, {});

function isV1Schema(schemaVersion) {
  return schemaVersion == null || Number(schemaVersion) === 1;
}

function mk(id, status, { reasons = [], notes = [], applicable = true } = {}) {
  return { id, title: GATE_TITLES[id] || id, status, applicable, reasons, notes };
}

// ---------------------------------------------------------------------------
// parseSrtCues — Gate #7 字幕产物解析（纯函数）
// ---------------------------------------------------------------------------

function srtStampToSeconds(hh, mm, ss, ms) {
  const h = Number(hh);
  const m = Number(mm);
  const s = Number(ss);
  // ms 允许 1..3 位：按位补齐（'.5' → 500ms）
  const milli = Number(String(ms).padEnd(3, '0'));
  if (![h, m, s, milli].every(Number.isFinite) || m > 59 || s > 59) return null;
  return h * 3600 + m * 60 + s + milli / 1000;
}

/**
 * 解析 SRT 文本为 cue 数组。容忍 UTF-8 BOM 与 CRLF；坏格式抛错（fail-closed）。
 * @param {string} text
 * @returns {Array<{index:number,start:number,end:number,text:string}>}
 */
function parseSrtCues(text) {
  if (typeof text !== 'string') {
    throw new Error(`parseSrtCues requires a string, got ${JSON.stringify(text)}`);
  }
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const blocks = src.split(/\n{2,}/).filter(b => b.trim() !== '');
  const cues = [];
  const timing = /^(\d{1,}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,}):(\d{2}):(\d{2})[,.](\d{1,3})\s*$/;
  blocks.forEach((block, bi) => {
    const lines = block.split('\n');
    let i = 0;
    if (/^\d+$/.test(lines[0].trim())) i = 1;
    const timingLine = lines[i];
    if (timingLine === undefined || timingLine.trim() === '') {
      throw new Error(`SRT block ${bi + 1} is malformed: missing timing line`);
    }
    const m = timing.exec(timingLine.trim());
    if (!m) {
      throw new Error(`SRT block ${bi + 1} is malformed: bad timing line ${JSON.stringify(timingLine)}`);
    }
    const start = srtStampToSeconds(m[1], m[2], m[3], m[4]);
    const end = srtStampToSeconds(m[5], m[6], m[7], m[8]);
    if (start === null || end === null) {
      throw new Error(`SRT block ${bi + 1} has an invalid timestamp ${JSON.stringify(timingLine)}`);
    }
    cues.push({
      index: cues.length + 1,
      start,
      end,
      text: lines.slice(i + 1).join('\n'),
    });
  });
  return cues;
}

// ---------------------------------------------------------------------------
// reconcileQuotaLedger — Gate #12（§4 固定公式）
// ---------------------------------------------------------------------------

/** take 所属 stage（keyframe 任务 → image，其余 → video） */
function takeStageOf(manifest, take) {
  if (take && take.stage) return take.stage === 'keyframe' ? 'keyframe' : 'video';
  const task = ((manifest && manifest.render_tasks) || []).find(t => t && t.task_id === take.task_id);
  return task && task.stage === 'keyframe' ? 'keyframe' : 'video';
}

/** 派生计数（事件流） */
function deriveLedgerCounts(manifest) {
  let videoTakes = 0;
  let imageTakes = 0;
  let rejectedTakes = 0;
  for (const shot of ((manifest && manifest.shots) || [])) {
    if (!shot) continue;
    for (const take of (shot.takes || [])) {
      if (!take) continue;
      if (take.status === 'rejected') rejectedTakes += 1;
      if (takeStageOf(manifest, take) === 'keyframe') imageTakes += 1;
      else videoTakes += 1;
    }
    for (const take of (shot.keyframe_takes || [])) {
      if (!take) continue;
      if (take.status === 'rejected') rejectedTakes += 1;
      imageTakes += 1;
    }
  }
  const reuseRecords = Array.isArray(manifest && manifest.reuse_records)
    ? manifest.reuse_records.length : 0;
  return { videoTakes, imageTakes, rejectedTakes, reuseRecords };
}

/** 读单个 stage 的计数器（缺失 → 0） */
function stageCounters(ledger, stage) {
  const raw = (ledger && ledger.stages && ledger.stages[stage]) || {};
  const out = {};
  for (const c of LEDGER_COUNTERS) {
    out[c] = raw[c] === undefined ? 0 : raw[c];
  }
  return out;
}

/**
 * Gate #12：配额账本与事件流对账（纯函数）。
 * @param {object} manifest
 * @returns {{ok:boolean, problems:string[], view:object, deferred:boolean, deferred_reason:string|null}}
 */
function reconcileQuotaLedger(manifest) {
  const problems = [];
  const derived = deriveLedgerCounts(manifest || {});
  const rawLedger = (manifest && manifest.quota_ledger) || null;

  // 1. 计数器必须为非负整数（写死；缺失按 0 处理）
  for (const stage of LEDGER_STAGES) {
    const raw = (rawLedger && rawLedger.stages && rawLedger.stages[stage]) || {};
    for (const c of LEDGER_COUNTERS) {
      const v = raw[c];
      if (v === undefined) continue;
      if (!Number.isInteger(v) || v < 0) {
        problems.push(`${stage}.${c} must be a non-negative integer, got ${JSON.stringify(v)}`);
      }
    }
  }

  const counters = {};
  for (const stage of LEDGER_STAGES) counters[stage] = stageCounters(rawLedger, stage);
  const view = {
    derived,
    stages: counters,
    video_takes: derived.videoTakes,
    image_takes: derived.imageTakes,
    rejected_takes: derived.rejectedTakes,
    reuse_records: derived.reuseRecords,
  };

  if (problems.length > 0) {
    return { ok: false, problems, view, deferred: false, deferred_reason: null };
  }

  // 2. 恢复/legacy take 无记账：不判 fail，转 deferred（写死）
  const videoCounted = counters.video.requests + counters.video.cache_hits;
  if (videoCounted === 0 && derived.videoTakes > 0) {
    return {
      ok: true,
      problems: [],
      view,
      deferred: true,
      deferred_reason: 'ledger not initialized for recovered/legacy takes — reconciliation cannot be performed',
    };
  }

  // 3. 逐项对账
  if (counters.video.successes !== derived.videoTakes) {
    problems.push(`video.successes ${counters.video.successes} != recorded takes ${derived.videoTakes}`);
  }
  if (counters.image.successes !== derived.imageTakes) {
    problems.push(`image.successes ${counters.image.successes} != recorded takes ${derived.imageTakes}`);
  }
  if (counters.video.rejects < derived.rejectedTakes) {
    problems.push(`video.rejects ${counters.video.rejects} < rejected takes ${derived.rejectedTakes}`);
  }
  for (const stage of LEDGER_STAGES) {
    const s = counters[stage];
    if (s.successes > s.requests + s.cache_hits) {
      problems.push(`${stage}.successes ${s.successes} > requests+cache_hits ${s.requests + s.cache_hits}`);
    }
    if (s.failed_billed > s.requests) {
      problems.push(`${stage}.failed_billed ${s.failed_billed} > requests ${s.requests}`);
    }
  }

  return { ok: problems.length === 0, problems, view, deferred: false, deferred_reason: null };
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function resolveInterfaceVersion(manifest, explicit) {
  if (explicit !== undefined && explicit !== null) return explicit;
  const m = manifest || {};
  if (m.interface_version !== undefined && m.interface_version !== null) return m.interface_version;
  if (typeof m.model === 'string' && m.model.length > 0) return m.model;
  if (m.model && typeof m.model === 'object') {
    if (m.model.version !== undefined && m.model.version !== null) return m.model.version;
    if (m.model.id !== undefined && m.model.id !== null) return m.model.id;
  }
  return null;
}

function interfaceVersionOfReport(report) {
  if (!report || typeof report !== 'object') return null;
  if (report.interface_version !== undefined && report.interface_version !== null) return report.interface_version;
  if (report.meta && report.meta.interface_version !== undefined && report.meta.interface_version !== null) {
    return report.meta.interface_version;
  }
  return null;
}

/** 有效 reuse_record：fingerprint_recurrence 且 bound_input_hash === 当前 shot.input_hash */
function findReuseRecord(manifest, shot, take) {
  const records = (manifest && manifest.reuse_records) || [];
  return records.find(r => r
    && r.take_id === take.id
    && r.reason === 'fingerprint_recurrence'
    && r.bound_input_hash != null
    && r.bound_input_hash === shot.input_hash) || null;
}

/**
 * take 是否可用作 final 依赖（单一裁定，所有导出入口共用）:
 *   - block shot / rejected take / human reject → problem
 *   - superseded take 或 superseded task 无有效 reuse_record → problem
 *   - take.input_hash 与 shot.input_hash 失配（双方均非 null）且
 *     无有效 reuse_record 且无 human_review accept（reviewed_input_hash 匹配当前 shot.input_hash）→ problem
 *   - 有效 reuse_record / human accept 可豁免 superseded 与 fingerprint 失配
 * @returns {string[]} problems（空 = 可用）
 */
function takeDependencyProblem(manifest, shot, take, where) {
  const w = where || `shot ${shot && shot.id}`;
  if (shot.status === 'blocked') {
    return [`${w}: shot ${shot.id} is blocked (circuit breaker) — cannot be depended on by the final release`];
  }
  if (take.status === 'rejected' || (take.human_review && take.human_review.conclusion === 'reject')) {
    return [`${w}: take ${take.id} is rejected — cannot be depended on by the final release`];
  }
  const task = ((manifest && manifest.render_tasks) || []).find(t => t && t.task_id === take.task_id);
  const reuse = findReuseRecord(manifest, shot, take);
  const humanAccept = !!(take.human_review
    && take.human_review.conclusion === 'accept'
    && take.human_review.reviewed_input_hash === shot.input_hash);
  if (take.status === 'superseded' || isTaskSuperseded(task)) {
    if (!reuse) {
      return [`${w}: take ${take.id} is superseded/stale and has no valid reuse_record (fingerprint_recurrence bound to shot.input_hash ${JSON.stringify(shot.input_hash)}) — superseded/orphan artifacts cannot enter final`];
    }
  }
  // fingerprint 失配:take 由不同输入生成,除非 fingerprint 复现(reuse_record)或人工审核绑定了当前输入
  if (take.input_hash != null && shot.input_hash != null && take.input_hash !== shot.input_hash
      && !reuse && !humanAccept) {
    return [`${w}: take ${take.id} input_hash ${JSON.stringify(take.input_hash)} does not match shot.input_hash ${JSON.stringify(shot.input_hash)} — take was generated from a different input and cannot enter final (no valid reuse_record / human_review accept)`];
  }
  return [];
}

/** 由 timeline 帧位推算最终时长（offline 阶段用；probe 优先） */
function timelineDurationSeconds(timeline) {
  if (!timeline || !Array.isArray(timeline.clips) || timeline.clips.length === 0) return null;
  const fps = timeline.fps;
  if (!Number.isFinite(fps) || fps <= 0) return null;
  const last = timeline.clips[timeline.clips.length - 1];
  if (!last || !Number.isInteger(last.output_end)) return null;
  return last.output_end / fps;
}

/** 默认字幕产物发现（manifest.artifacts.srt → <episode>/episode.srt） */
function resolveDefaultArtifacts(absEpDir, manifest) {
  const artifacts = {};
  const declared = (manifest && manifest.artifacts) || {};
  if (declared.srt) {
    artifacts.srt = absTakePath(declared.srt) || declared.srt;
  } else if (absEpDir) {
    const candidate = path.join(absEpDir, 'episode.srt');
    if (fs.existsSync(candidate)) artifacts.srt = candidate;
  }
  return artifacts;
}

// ---------------------------------------------------------------------------
// evaluateReleaseGate — §5 全量矩阵
// ---------------------------------------------------------------------------

/**
 * @param {object} input
 *   manifest, timeline, schemaVersion, finalPath, artifacts,
 *   intent, e1Report, e1ReportPath, interfaceVersion, evidence, mediaResult,
 *   finalDuration, opts（透传 probe 注入：probeMedia/verifyDecode/probeOpts/decodeOpts/phase）
 * @returns {{ok:boolean,releasable:boolean,schemaVersion:number,
 *            items:Array,failures:string[],deferred:string[],probe:object|null}}
 */
function evaluateReleaseGate(input = {}) {
  const manifest = input.manifest || {};
  const opts = input.opts || {};
  const offline = opts.phase === 'offline';
  const schemaVersion = input.schemaVersion != null ? input.schemaVersion : (manifest.schema_version != null ? manifest.schema_version : 1);
  const isV1 = isV1Schema(schemaVersion);
  const intent = input.intent || manifest.intent || DEFAULT_INTENT;
  const flags = intentFlags(intent);
  const timeline = input.timeline === undefined ? null : input.timeline;
  const clips = clipList(timeline);
  const finalPath = input.finalPath || opts.finalPath || null;
  const artifacts = input.artifacts || opts.artifacts || {};
  const evidence = input.evidence || opts.evidence || {};
  const interfaceVersionExplicit = input.interfaceVersion !== undefined ? input.interfaceVersion : opts.interfaceVersion;

  // 媒体结果：注入优先（复用）；否则 finalPath 存在时只跑一次 verifyFinalMedia。
  let mediaResult = input.mediaResult || opts.mediaResult || null;
  let mediaError = null;
  let probe = mediaResult ? (mediaResult.probe || null) : null;
  if (!mediaResult && finalPath) {
    try {
      mediaResult = verifyFinalMedia({
        finalPath,
        manifest,
        intent,
        schemaVersion,
        opts: {
          probeMedia: opts.probeMedia,
          verifyDecode: opts.verifyDecode,
          probeOpts: opts.probeOpts,
          decodeOpts: opts.decodeOpts,
          fps: opts.fps,
        },
      });
      probe = mediaResult.probe || null;
    } catch (e) {
      mediaError = (e && e.message) || String(e);
    }
  }

  const resolveFinalDuration = () => {
    if (typeof input.finalDuration === 'number' && Number.isFinite(input.finalDuration)) return input.finalDuration;
    if (typeof opts.finalDuration === 'number' && Number.isFinite(opts.finalDuration)) return opts.finalDuration;
    if (probe) {
      if (probe.format && typeof probe.format.duration === 'number' && probe.format.duration > 0) return probe.format.duration;
      if (probe.video && typeof probe.video.duration === 'number' && probe.video.duration > 0) return probe.video.duration;
    }
    return timelineDurationSeconds(timeline);
  };

  const items = [];
  const add = (it) => { items.push(it); return it; };
  const nv1 = (id) => mk(id, 'not_applicable', { applicable: false, notes: ['v1 semantics'] });

  // ---- #1 / #2 / #14：external 证据 ----
  add(mk('1', evidence.m0 === true ? 'pass' : 'external', evidence.m0 === true ? {} : {
    reasons: ['M0 regression evidence not provided — run `npm test` and pass opts.evidence.m0=true (the gate cannot run the suite in-process)'],
  }));
  add(mk('2', evidence.m0 === true ? 'pass' : 'external', evidence.m0 === true ? {} : {
    reasons: ['schema v1/v2 fixture evidence not provided — covered by opts.evidence.m0 (external)'],
  }));
  add(mk('14', evidence.determinism === true ? 'pass' : 'external', evidence.determinism === true
    ? { notes: ['determinism evidence provided (opts.evidence.determinism=true) — collect it with `node tools/determinism.js <episode-dir>` (re-runs final twice and compares decoded video/audio digests)'] }
    : {
      reasons: ['determinism evidence not provided — collect it with `node tools/determinism.js <episode-dir>` (re-runs final twice and compares decoded video/audio digests), then pass opts.evidence.determinism=true (external)'],
    }));

  // ---- #3：E1 报告 + 接口版本 ----
  try {
    if (isV1) {
      add(nv1('3'));
    } else {
      let report = input.e1Report || opts.e1Report || null;
      const reportPath = input.e1ReportPath || opts.e1ReportPath;
      const notes = [];
      if (!report && reportPath) {
        try {
          report = readJsonFile(reportPath, { label: 'E1 report' });
        } catch (e) {
          notes.push(`cannot read E1 report ${reportPath}: ${e.message}`);
        }
      }
      const keyframeMode = manifest.keyframe_mode || 'reference';
      if (!report) {
        if (keyframeMode === 'first_frame') {
          add(mk('3', 'fail', {
            reasons: ['first_frame keyframe mode requires an E1 report with first_frame_bound=true (PRD §3.1/§5 #3) — report missing'],
            notes,
          }));
        } else {
          add(mk('3', 'deferred', {
            reasons: ['E1 formal report not available (experiment paused); required before release'],
            notes,
          }));
        }
      } else {
        const reasons = [];
        const reportIv = interfaceVersionOfReport(report);
        const iv = resolveInterfaceVersion(manifest, interfaceVersionExplicit);
        if (iv === null || iv === undefined) {
          notes.push('manifest declares no interface version — E1 report version comparison skipped (external evidence)');
        } else if (reportIv !== null && String(reportIv) !== String(iv)) {
          reasons.push(`E1 report interface_version ${JSON.stringify(reportIv)} != manifest interface version ${JSON.stringify(iv)}`);
        }
        if (keyframeMode === 'first_frame' && report.first_frame_bound !== true) {
          reasons.push(`first_frame keyframe mode requires first_frame_bound=true, E1 report has ${JSON.stringify(report.first_frame_bound)}`);
        }
        add(reasons.length ? mk('3', 'fail', { reasons, notes }) : mk('3', 'pass', { notes }));
      }
    }
  } catch (e) {
    add(mk('3', 'fail', { reasons: [`internal error evaluating E1 report: ${e.message}`] }));
  }

  // ---- #4a：rejected/stale/blocked take 依赖 ----
  try {
    const problems = [];
    if (isV1) {
      for (const shot of (manifest.shots || [])) {
        if (!shot) continue;
        if (shot.status === 'blocked') {
          problems.push(`shot ${shot.id} is blocked (circuit breaker) — cannot be depended on by the final release`);
        }
        if (!shot.selected_take) continue;
        const take = (shot.takes || []).find(t => t && t.id === shot.selected_take);
        if (!take) {
          problems.push(`shot ${shot.id}: selected_take ${JSON.stringify(shot.selected_take)} not found in takes`);
          continue;
        }
        problems.push(...takeDependencyProblem(manifest, shot, take, `shot ${shot.id}`));
      }
    } else if (!timeline) {
      problems.push('timeline.json required for v2 Gate #4a (clip-level take dependency) — build it with tools/build-timeline.js');
    } else {
      clips.forEach((clip, i) => {
        const where = `clip ${(clip && clip.clip_id) || `clips[${i}]`}`;
        const shot = clip ? findShot(manifest, clip.shot_id) : null;
        if (!shot) { problems.push(`${where}: references unknown shot ${JSON.stringify(clip && clip.shot_id)}`); return; }
        const take = findTake(manifest, clip.shot_id, clip.take_id);
        if (!take) { problems.push(`${where}: take ${JSON.stringify(clip.take_id)} not found for shot ${shot.id}`); return; }
        problems.push(...takeDependencyProblem(manifest, shot, take, where));
      });
    }
    add(problems.length ? mk('4a', 'fail', { reasons: problems }) : mk('4a', 'pass'));
  } catch (e) {
    add(mk('4a', 'fail', { reasons: [`internal error evaluating take dependency: ${e.message}`] }));
  }

  // ---- #4b：bound approval records（复用 validateApprovals，无 cut_join → pass） ----
  try {
    if (isV1) {
      add(nv1('4b'));
    } else {
      const v = validateApprovals(manifest, timeline);
      add(v.ok ? mk('4b', 'pass') : mk('4b', 'fail', { reasons: v.problems }));
    }
  } catch (e) {
    add(mk('4b', 'fail', { reasons: [`internal error evaluating approvals: ${e.message}`] }));
  }

  // ---- #5：clip → selected take（reuse_records 可恢复） ----
  try {
    const problems = [];
    if (isV1) {
      for (const shot of (manifest.shots || [])) {
        if (!shot || shot.status !== 'done') continue;
        if (!shot.selected_take) {
          problems.push(`shot ${shot.id} is done but has no selected_take`);
          continue;
        }
        const take = (shot.takes || []).find(t => t && t.id === shot.selected_take);
        if (!take) problems.push(`shot ${shot.id}: selected_take ${JSON.stringify(shot.selected_take)} not found in takes`);
      }
    } else if (!timeline) {
      problems.push('timeline.json required for v2 Gate #5 (clip → selected take resolution) — build it with tools/build-timeline.js');
    } else {
      clips.forEach((clip, i) => {
        const where = `clip ${(clip && clip.clip_id) || `clips[${i}]`}`;
        const shot = clip ? findShot(manifest, clip.shot_id) : null;
        if (!shot) { problems.push(`${where}: references unknown shot ${JSON.stringify(clip && clip.shot_id)}`); return; }
        const take = findTake(manifest, clip.shot_id, clip.take_id);
        if (!take) { problems.push(`${where}: take ${JSON.stringify(clip.take_id)} not found for shot ${shot.id}`); return; }
        if (take.id !== shot.selected_take && !findReuseRecord(manifest, shot, take)) {
          problems.push(`${where}: take ${take.id} is neither the selected_take (${JSON.stringify(shot.selected_take)}) nor recovered by a valid reuse_record — superseded/orphan take cannot enter final`);
        }
      });
    }
    add(problems.length ? mk('5', 'fail', { reasons: problems }) : mk('5', 'pass'));
  } catch (e) {
    add(mk('5', 'fail', { reasons: [`internal error evaluating clip resolution: ${e.message}`] }));
  }

  // ---- #6/#7 prelude：真实对白事实（声明 dialogue=false 不得隐藏） ----
  const dialogueHits = [];
  for (const shot of (manifest.shots || [])) {
    if (shot && typeof shot.dialogue_text === 'string' && shot.dialogue_text.trim().length > 0) {
      dialogueHits.push(`shot ${shot.id}.dialogue_text`);
    }
  }
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const d = clip && clip.dialogue;
    if (!d || typeof d !== 'object') continue;
    const hasMeasured = d.measured === true || (typeof d.dialogue_ms === 'number' && d.dialogue_ms > 0);
    const hasText = typeof d.text === 'string' && d.text.trim().length > 0;
    if (hasMeasured || hasText) {
      dialogueHits.push(`clip ${(clip && clip.clip_id) || `clips[${i}]`}.dialogue`);
    }
  }
  const hasRealDialogue = dialogueHits.length > 0;
  const dialogueHidden = intent.dialogue === false && hasRealDialogue;

  // ---- #6：dialogue overflow / spill（§3.4；M5-OVF 实判） ----
  try {
    if (isV1) {
      add(nv1('6'));
    } else if (dialogueHidden) {
      add(mk('6', 'fail', {
        reasons: [`intent.dialogue=false but real dialogue exists (${dialogueHits.join(', ')}) — a false declaration must not hide dialogue from the release gate (§5 #6); declare dialogue or remove the dialogue`],
      }));
    } else if (!intent.dialogue && !flags.requires_subtitles) {
      add(mk('6', 'not_applicable', { applicable: false, notes: ['no dialogue declared (intent.dialogue=false && requires_subtitles=false)'] }));
    } else if (!timeline) {
      add(mk('6', 'fail', {
        reasons: ['timeline.json required for v2 Gate #6 (dialogue overflow/spill) — build it with tools/build-timeline.js'],
      }));
    } else {
      const problems = collectUnresolvedOverflow(timeline, { intent });
      // §5 矩阵第 6 行：未声明 dialogue 但 manifest 实际存在对白 → 失败
      if (intent.dialogue === false) {
        for (const shot of (manifest.shots || [])) {
          if (shot && typeof shot.dialogue_text === 'string' && shot.dialogue_text.trim().length > 0) {
            problems.push(`shot ${shot.id} has dialogue_text but intent.dialogue=false — declare dialogue or remove the dialogue (§5 #6)`);
          }
        }
      }
      add(problems.length ? mk('6', 'fail', { reasons: problems }) : mk('6', 'pass'));
    }
  } catch (e) {
    add(mk('6', 'fail', { reasons: [`internal error evaluating dialogue overflow: ${e.message}`] }));
  }

  // ---- #7：subtitle cues ----
  try {
    if (dialogueHidden) {
      add(mk('7', 'fail', {
        reasons: [`intent.dialogue=false but real dialogue exists (${dialogueHits.join(', ')}) — subtitle artifact is required (§5 #7); a missing required artifact is a failure, not an exemption`],
      }));
    } else if (!flags.requires_subtitles) {
      add(mk('7', 'not_applicable', { applicable: false, notes: ['!requires_subtitles (intent.dialogue=false && subtitles=none)'] }));
    } else {
      const srtPath = artifacts.srt;
      if (!srtPath) {
        add(mk('7', 'fail', { reasons: ['requires_subtitles is true but no subtitle artifact was provided (PRD §4/§5 #7) — a missing required artifact is a failure, not an exemption'] }));
      } else if (!fs.existsSync(srtPath)) {
        add(mk('7', 'fail', { reasons: [`subtitle artifact not found: ${srtPath}`] }));
      } else {
        let cues = null;
        try {
          cues = parseSrtCues(fs.readFileSync(srtPath, 'utf8'));
        } catch (e) {
          add(mk('7', 'fail', { reasons: [`SRT parse failed: ${e.message}`] }));
        }
        if (cues) {
          const finalDuration = resolveFinalDuration();
          if (finalDuration === null) {
            add(mk('7', 'deferred', { reasons: ['cannot verify subtitle cue bounds: final duration unavailable (no final media and no timeline)'] }));
          } else {
            const problems = [];
            for (const cue of cues) {
              if (cue.start < 0 || cue.end > finalDuration + SRT_BOUNDS_TOLERANCE) {
                problems.push(`cue ${cue.index} [${cue.start.toFixed(3)}s, ${cue.end.toFixed(3)}s] outside [0, ${finalDuration.toFixed(3)}s]`);
              }
            }
            add(problems.length ? mk('7', 'fail', { reasons: problems }) : mk('7', 'pass'));
          }
        }
      }
    }
  } catch (e) {
    add(mk('7', 'fail', { reasons: [`internal error evaluating subtitle cues: ${e.message}`] }));
  }

  // ---- #8：A/V 最终流长度 ----
  try {
    if (offline) {
      add(mk('8', 'external', { notes: ['media checks run after the final stitch'] }));
    } else if (!finalPath) {
      add(mk('8', 'fail', { reasons: ['final file required (A/V stream length cannot be verified without --final)'] }));
    } else if (!probe) {
      add(mk('8', 'fail', { reasons: [`cannot verify A/V length: media probe failed${mediaError ? ` (${mediaError})` : ''}`] }));
    } else {
      const problems = checkAvLength(probe, { schemaVersion, intent });
      add(problems.length ? mk('8', 'fail', { reasons: problems }) : mk('8', 'pass'));
    }
  } catch (e) {
    add(mk('8', 'fail', { reasons: [`internal error evaluating A/V length: ${e.message}`] }));
  }

  // ---- #9：媒体属性探测 + 完整解码 ----
  try {
    if (offline) {
      add(mk('9', 'external', { notes: ['media checks run after the final stitch'] }));
    } else if (!finalPath) {
      add(mk('9', 'fail', { reasons: ['final file required (media probe + full decode cannot run without --final)'] }));
    } else if (!mediaResult) {
      add(mk('9', 'fail', { reasons: [`media verification failed to run: ${mediaError || 'unknown error'}`] }));
    } else {
      const steps = mediaResult.steps || {};
      const probeOk = !!(steps.probe && steps.probe.ok);
      const specOk = !!(steps.spec && steps.spec.ok);
      const decodeOk = !!(steps.decode && steps.decode.ok);
      if (probeOk && specOk && decodeOk) {
        add(mk('9', 'pass'));
      } else {
        const problems = (mediaResult.problems || []).filter(p => /^(probe|spec|decode)/.test(p));
        add(mk('9', 'fail', { reasons: problems.length ? problems : ['media probe/decode verification failed'] }));
      }
    }
  } catch (e) {
    add(mk('9', 'fail', { reasons: [`internal error evaluating media verification: ${e.message}`] }));
  }

  // ---- #10：loudness（M5-AUD 实判） ----
  try {
    if (isV1) {
      add(nv1('10'));
    } else if (intent.audio === 'none') {
      add(mk('10', 'not_applicable', { applicable: false, notes: ["intent.audio: none → not_applicable"] }));
    } else if (intent.silent === true) {
      add(mk('10', 'pass', { notes: ['loudnorm: skipped'] }));
    } else {
      const loudness = (input.loudness !== undefined && input.loudness !== null)
        ? input.loudness
        : opts.loudness;
      const analyzeFn = typeof opts.analyzeLoudness === 'function' ? opts.analyzeLoudness : null;
      if (loudness !== undefined && loudness !== null) {
        const v = verifyLoudness({ measured: loudness });
        add(v.ok ? mk('10', 'pass') : mk('10', 'fail', { reasons: v.problems }));
      } else if (offline) {
        add(mk('10', 'external', { notes: ['loudness checks run after the final stitch (or pass opts.loudness)'] }));
      } else if (finalPath) {
        const analyzer = analyzeFn || analyzeLoudness;
        let measured = null;
        let err = null;
        try {
          measured = analyzer(finalPath);
        } catch (e) {
          err = (e && e.message) || String(e);
        }
        if (err) {
          add(mk('10', 'fail', { reasons: [`loudness analysis failed: ${err}`] }));
        } else {
          const v = verifyLoudness({ measured });
          add(v.ok ? mk('10', 'pass') : mk('10', 'fail', { reasons: v.problems }));
        }
      } else {
        add(mk('10', 'fail', {
          reasons: ['loudness cannot be verified: provide --final (analyzed in-process) or opts.loudness ({input_i, input_tp}) (PRD §5 #10)'],
        }));
      }
    }
  } catch (e) {
    add(mk('10', 'fail', { reasons: [`internal error evaluating loudness: ${e.message}`] }));
  }

  // ---- #11：cover ----
  try {
    if (isV1) {
      add(nv1('11'));
    } else if (artifacts.cover) {
      // M5-SUB：显式传入已生成的封面产物 → 只校验文件存在（不传则保持 resolveCover 现值）
      const coverArtifact = absTakePath(artifacts.cover) || artifacts.cover;
      if (fs.existsSync(coverArtifact)) {
        add(mk('11', 'pass', { notes: [`cover artifact: ${coverArtifact}`] }));
      } else {
        add(mk('11', 'fail', { reasons: [`cover artifact not found: ${coverArtifact}`] }));
      }
    } else {
      let res = null;
      let thrown = null;
      try {
        res = resolveCover(manifest, timeline);
      } catch (e) {
        thrown = e;
      }
      if (thrown) {
        add(mk('11', 'fail', { reasons: [`cover resolution failed: ${thrown.message}`] }));
      } else if (!res || !res.ok) {
        add(mk('11', 'fail', { reasons: [res && res.error ? res.error : 'cover could not be resolved (no cover configured)'] }));
      } else if (res.kind === 'promo_asset' || res.kind === 'first_frame') {
        const abs = res.path ? (absTakePath(res.path) || res.path) : null;
        if (!abs || !fs.existsSync(abs)) {
          add(mk('11', 'fail', { reasons: [`cover ${res.kind} file missing/unreadable: ${res.path || '(null)'}`] }));
        } else {
          add(mk('11', 'pass', { notes: [`cover source: ${res.kind}`] }));
        }
      } else {
        add(mk('11', 'pass', { notes: [`cover source: ${res.kind}`] }));
      }
    }
  } catch (e) {
    add(mk('11', 'fail', { reasons: [`internal error evaluating cover: ${e.message}`] }));
  }

  // ---- #12：quota ledger 对账 ----
  try {
    if (isV1) {
      add(nv1('12'));
    } else {
      const rec = reconcileQuotaLedger(manifest);
      if (rec.deferred) add(mk('12', 'deferred', { reasons: [rec.deferred_reason] }));
      else if (!rec.ok) add(mk('12', 'fail', { reasons: rec.problems }));
      else add(mk('12', 'pass'));
    }
  } catch (e) {
    add(mk('12', 'fail', { reasons: [`internal error evaluating quota ledger: ${e.message}`] }));
  }

  // ---- #13：cut_join junction approvals ----
  try {
    if (isV1) {
      add(nv1('13'));
    } else {
      const v = validateApprovals(manifest, timeline);
      add(v.ok ? mk('13', 'pass') : mk('13', 'fail', { reasons: v.problems }));
    }
  } catch (e) {
    add(mk('13', 'fail', { reasons: [`internal error evaluating junction approvals: ${e.message}`] }));
  }

  // 稳定输出顺序：按 GATE_ITEMS 的 id 顺序（1,2,3,4a,4b,5..14）
  const byId = new Map(items.map(it => [it.id, it]));
  const ordered = GATE_ITEMS.map(def => byId.get(def.id)).filter(Boolean);

  const failures = ordered.filter(it => it.status === 'fail').map(it => it.id);
  const deferred = ordered.filter(it => it.status === 'deferred').map(it => it.id);
  const ok = failures.length === 0;

  return {
    ok,
    releasable: ok && deferred.length === 0,
    schemaVersion,
    items: ordered,
    failures,
    deferred,
    probe,
  };
}

// ---------------------------------------------------------------------------
// formatGateReport
// ---------------------------------------------------------------------------

const STATUS_LABEL = {
  pass: 'PASS',
  fail: 'FAIL',
  not_applicable: 'N/A',
  deferred: 'DEFER',
  external: 'EXT',
};

function formatGateReport(result) {
  const lines = [];
  const items = (result && result.items) || [];
  for (const it of items) {
    const label = STATUS_LABEL[it.status] || String(it.status).toUpperCase();
    const detail = (it.reasons && it.reasons.length) ? it.reasons.join('; ')
      : ((it.notes && it.notes.length) ? it.notes.join('; ') : '');
    lines.push(`[${label}] #${it.id} ${it.title}${detail ? ` (${detail})` : ''}`);
  }
  const failures = (result && result.failures) || [];
  const deferred = (result && result.deferred) || [];
  lines.push(`Release Gate: ${result && result.ok ? 'OK' : 'NOT OK'}`);
  const parts = [];
  if (failures.length) parts.push(`failures: ${failures.map(id => `#${id}`).join(', ')}`);
  if (deferred.length) parts.push(`deferred: ${deferred.map(id => `#${id}`).join(', ')}`);
  lines.push(`Releasable: ${result && result.releasable ? 'YES' : 'NO'}${parts.length ? ` (${parts.join('; ')})` : ''}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// stitch-episode 复用入口（纯函数）
// ---------------------------------------------------------------------------

/**
 * 收集 Release Gate 报告（供 stitch-episode 与单测复用）。
 * @param {string} absEpDir
 * @param {object} manifest
 * @param {object} [opts] timeline / finalPath / artifacts / e1Report / e1ReportPath /
 *   interfaceVersion / evidence / mediaResult / finalDuration / phase / probeMedia / verifyDecode
 */
function collectGateReport(absEpDir, manifest, opts = {}) {
  let timeline = opts.timeline;
  if (timeline === undefined) {
    const timelinePath = path.join(absEpDir, 'timeline.json');
    timeline = fs.existsSync(timelinePath)
      ? readJsonFile(timelinePath, { label: 'timeline.json' })
      : null;
  }
  const artifacts = opts.artifacts || resolveDefaultArtifacts(absEpDir, manifest);
  const phase = opts.phase || (opts.finalPath ? 'full' : 'offline');
  return evaluateReleaseGate({
    manifest,
    timeline,
    schemaVersion: manifest.schema_version != null ? manifest.schema_version : 1,
    finalPath: opts.finalPath || null,
    artifacts,
    intent: opts.intent || manifest.intent,
    e1Report: opts.e1Report,
    e1ReportPath: opts.e1ReportPath,
    interfaceVersion: opts.interfaceVersion,
    evidence: opts.evidence,
    mediaResult: opts.mediaResult,
    finalDuration: opts.finalDuration,
    opts: Object.assign({}, opts, { phase }),
  });
}

/**
 * 桥接期退出码判定（纯函数，便于单测）：
 *   fail → 4；deferred 且 strict → 4；否则 0。
 * @returns {{exitCode:number, reason:'ok'|'fail'|'deferred'}}
 */
function gateExitCode(result, { strict = false } = {}) {
  if (result && result.failures && result.failures.length > 0) return { exitCode: 4, reason: 'fail' };
  if (result && result.deferred && result.deferred.length > 0) {
    return { exitCode: strict ? 4 : 0, reason: 'deferred' };
  }
  return { exitCode: 0, reason: 'ok' };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage() {
  console.log('usage: node tools/gate.js <episode-dir> [--final <path>] [--timeline <path>] [--e1-report <path>] [--cover <path>] [--json] [--strict]');
  console.log('  §5 v2 Final Release Gate（矩阵 + 账本对账 + 字幕 cue + cover 门禁）');
  console.log('  exit 4 on any failed item; deferred items warn (NOT RELEASABLE) and exit 0 unless --strict');
}

function main(argv) {
  const args = argv.slice(2);
  let episodeDir = null;
  let finalPath = null;
  let timelinePath = null;
  let e1ReportPath = null;
  let coverPath = null;
  let json = false;
  let strict = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') json = true;
    else if (a === '--strict' || a === '--gate-strict') strict = true;
    else if (a === '--final') finalPath = args[++i];
    else if (a.startsWith('--final=')) finalPath = a.slice('--final='.length);
    else if (a === '--timeline') timelinePath = args[++i];
    else if (a.startsWith('--timeline=')) timelinePath = a.slice('--timeline='.length);
    else if (a === '--e1-report') e1ReportPath = args[++i];
    else if (a.startsWith('--e1-report=')) e1ReportPath = a.slice('--e1-report='.length);
    else if (a === '--cover') coverPath = args[++i];
    else if (a.startsWith('--cover=')) coverPath = a.slice('--cover='.length);
    else if (a === '--help' || a === '-h') { printUsage(); return 0; }
    else if (a.startsWith('-')) { console.error(`unknown option: ${a}`); printUsage(); return 2; }
    else if (episodeDir === null) episodeDir = a;
    else { console.error(`unexpected argument: ${a}`); printUsage(); return 2; }
  }

  if (!episodeDir) { printUsage(); return 2; }
  const absEpDir = path.isAbsolute(episodeDir) ? episodeDir : path.resolve(episodeDir);

  let manifest;
  try {
    manifest = readJsonFile(path.join(absEpDir, 'manifest.json'), { label: 'manifest.json' });
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    return 2;
  }

  let timeline = null;
  const resolvedTimelinePath = timelinePath
    ? (path.isAbsolute(timelinePath) ? timelinePath : path.resolve(timelinePath))
    : path.join(absEpDir, 'timeline.json');
  if (fs.existsSync(resolvedTimelinePath)) {
    try {
      timeline = readJsonFile(resolvedTimelinePath, { label: 'timeline.json' });
    } catch (e) {
      console.error(`ERROR: ${e.message}`);
      return 2;
    }
  }

  const artifacts = resolveDefaultArtifacts(absEpDir, manifest);
  if (coverPath) artifacts.cover = path.isAbsolute(coverPath) ? coverPath : path.resolve(coverPath);

  const result = evaluateReleaseGate({
    manifest,
    timeline,
    schemaVersion: manifest.schema_version != null ? manifest.schema_version : 1,
    finalPath: finalPath ? (path.isAbsolute(finalPath) ? finalPath : path.resolve(finalPath)) : null,
    e1ReportPath: e1ReportPath ? (path.isAbsolute(e1ReportPath) ? e1ReportPath : path.resolve(e1ReportPath)) : null,
    intent: manifest.intent,
    artifacts,
    opts: { phase: 'full' },
  });

  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatGateReport(result));

  if (result.failures.length > 0) return 4;
  if (result.deferred.length > 0) {
    console.warn(`WARN: Release Gate: NOT RELEASABLE — ${result.deferred.length} deferred item(s): ${result.deferred.map(id => `#${id}`).join(', ')}`);
    if (strict) return 4;
  }
  return 0;
}

module.exports = {
  TOOL_NAME,
  TOOL_VERSION,
  GATE_ITEMS,
  DEFAULT_INTENT,
  SRT_BOUNDS_TOLERANCE,
  parseSrtCues,
  reconcileQuotaLedger,
  collectUnresolvedOverflow,
  evaluateReleaseGate,
  takeDependencyProblem,
  takeUsabilityProblems: takeDependencyProblem,
  formatGateReport,
  collectGateReport,
  gateExitCode,
  resolveDefaultArtifacts,
  timelineDurationSeconds,
  main,
};

if (require.main === module) {
  process.exit(main(process.argv));
}
