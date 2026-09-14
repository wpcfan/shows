'use strict';
const fs = require('fs');
const path = require('path');
const { absTakePath } = require('./approvals');
const { isTaskSuperseded } = require('./build-manifest');
const { LEDGER_STAGES, LEDGER_COUNTERS } = require('./quota-ledger');

const TOOL_NAME = 'gate';
const TOOL_VERSION = '1.0.0';

const SRT_BOUNDS_TOLERANCE = 0.05;
const DEFAULT_INTENT = { dialogue: false, audio: 'none', subtitles: 'none', silent: true };

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

const STATUS_LABEL = {
  pass: 'PASS',
  fail: 'FAIL',
  not_applicable: 'N/A',
  deferred: 'DEFER',
  external: 'EXT',
};

function isV1Schema(schemaVersion) {
  return schemaVersion == null || Number(schemaVersion) === 1;
}

function mk(id, status, { reasons = [], notes = [], applicable = true } = {}) {
  return { id, title: GATE_TITLES[id] || id, status, applicable, reasons, notes };
}

// ---------------------------------------------------------------------------
// parseSrtCues — Gate #7
// ---------------------------------------------------------------------------

function srtStampToSeconds(hh, mm, ss, ms) {
  const h = Number(hh);
  const m = Number(mm);
  const s = Number(ss);
  const milli = Number(String(ms).padEnd(3, '0'));
  if (![h, m, s, milli].every(Number.isFinite) || m > 59 || s > 59) return null;
  return h * 3600 + m * 60 + s + milli / 1000;
}

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
// reconcileQuotaLedger — Gate #12
// ---------------------------------------------------------------------------

function takeStageOf(manifest, take) {
  if (take && take.stage) return take.stage === 'keyframe' ? 'keyframe' : 'video';
  const task = ((manifest && manifest.render_tasks) || []).find(t => t && t.task_id === take.task_id);
  return task && task.stage === 'keyframe' ? 'keyframe' : 'video';
}

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

function stageCounters(ledger, stage) {
  const raw = (ledger && ledger.stages && ledger.stages[stage]) || {};
  const out = {};
  for (const c of LEDGER_COUNTERS) {
    out[c] = raw[c] === undefined ? 0 : raw[c];
  }
  return out;
}

function reconcileQuotaLedger(manifest) {
  const problems = [];
  const derived = deriveLedgerCounts(manifest || {});
  const rawLedger = (manifest && manifest.quota_ledger) || null;

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
// Misc helpers
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

function findReuseRecord(manifest, shot, take) {
  const records = (manifest && manifest.reuse_records) || [];
  return records.find(r => r
    && r.take_id === take.id
    && r.reason === 'fingerprint_recurrence'
    && r.bound_input_hash != null
    && r.bound_input_hash === shot.input_hash) || null;
}

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
  if (take.input_hash != null && shot.input_hash != null && take.input_hash !== shot.input_hash
      && !reuse && !humanAccept) {
    return [`${w}: take ${take.id} input_hash ${JSON.stringify(take.input_hash)} does not match shot.input_hash ${JSON.stringify(shot.input_hash)} — take was generated from a different input and cannot enter final (no valid reuse_record / human_review accept)`];
  }
  return [];
}

function timelineDurationSeconds(timeline) {
  if (!timeline || !Array.isArray(timeline.clips) || timeline.clips.length === 0) return null;
  const fps = timeline.fps;
  if (!Number.isFinite(fps) || fps <= 0) return null;
  const last = timeline.clips[timeline.clips.length - 1];
  if (!last || !Number.isInteger(last.output_end)) return null;
  return last.output_end / fps;
}

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
// formatGateReport
// ---------------------------------------------------------------------------

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

function gateExitCode(result, { strict = false } = {}) {
  if (result && result.failures && result.failures.length > 0) return { exitCode: 4, reason: 'fail' };
  if (result && result.deferred && result.deferred.length > 0) {
    return { exitCode: strict ? 4 : 0, reason: 'deferred' };
  }
  return { exitCode: 0, reason: 'ok' };
}

module.exports = {
  TOOL_NAME,
  TOOL_VERSION,
  GATE_ITEMS,
  GATE_TITLES,
  STATUS_LABEL,
  DEFAULT_INTENT,
  SRT_BOUNDS_TOLERANCE,
  isV1Schema,
  mk,
  parseSrtCues,
  reconcileQuotaLedger,
  resolveInterfaceVersion,
  interfaceVersionOfReport,
  findReuseRecord,
  takeDependencyProblem,
  takeUsabilityProblems: takeDependencyProblem,
  timelineDurationSeconds,
  resolveDefaultArtifacts,
  formatGateReport,
  gateExitCode,
};
