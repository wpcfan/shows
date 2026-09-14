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
const { readJsonFile } = require('./build-manifest');
const { collectUnresolvedOverflow } = require('./dialogue');
const { verifyLoudness, analyzeLoudness } = require('./audio');
const {
  GATE_ITEMS, DEFAULT_INTENT, SRT_BOUNDS_TOLERANCE,
  isV1Schema, mk, parseSrtCues, reconcileQuotaLedger,
  resolveInterfaceVersion, interfaceVersionOfReport, findReuseRecord,
  takeDependencyProblem, timelineDurationSeconds, resolveDefaultArtifacts,
  formatGateReport,
} = require('./gate-helpers');

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

  // ---- #4b：bound approval records ----
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

  // ---- #5：clip → selected take ----
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

  // ---- #6/#7 prelude：真实对白事实 ----
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

  // ---- #6：dialogue overflow / spill ----
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

  // ---- #10：loudness ----
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
// stitch-episode 复用入口
// ---------------------------------------------------------------------------

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
  ...require('./gate-helpers'),
  collectUnresolvedOverflow,
  evaluateReleaseGate,
  collectGateReport,
  main,
};

if (require.main === module) {
  process.exit(main(process.argv));
}
