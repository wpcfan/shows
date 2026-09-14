#!/usr/bin/env node
/**
 * mark-approval.js — PRD v2.11 §3.3 bound approval record 写入(版本绑定人工验收)
 *
 * 统一机制:`--accept-upstream`(continue_from 弱承诺)与 cut_join 人工四要素验收
 * 都写 machine-readable 记录到 `manifest.approvals[]`。
 *
 * 用法:
 *   node tools/mark-approval.js <episode-dir> --kind junction_review \
 *     --upstream-clip clip-0012 --downstream-clip clip-0013 \
 *     --subject pass --prop pass --action-phase pass --direction pass \
 *     [--reviewer X] [--timeline <path>]
 *   node tools/mark-approval.js <episode-dir> --kind accept_upstream \
 *     --downstream-shot s01-shot-02 [--timeline <path>] [--reviewer X]
 *
 * 语义/硬规则(§3.3):
 *   - validity 只比较 bindings 的 content_digest 与语义参数
 *     (`source_out`/`source_in`/`deleted_head_frames`);locators(clip_id/take_id/shot_id)
 *     仅定位与审计,不参与失效判定;
 *   - junction_review 必须绑定到两个已存在的 clip,且其 video take 文件存在;
 *     verdict 四要素(subject/prop/action_phase/direction)必填且 ∈ {pass, fail};
 *   - accept_upstream 按 --downstream-shot 找 shot 的 continue_from 上游 selected take,
 *     upstream 记 `{content_digest, source_out: cut_frame}`(cut_frame 取时间线 junction/
 *     上游 clip source_out 或 manifest render_task 的 continue_from.cut_frame;缺失时报错),
 *     downstream 记 `{video:{content_digest}, source_in/deleted_head_frames 若有}`;
 *   - 重复确认(同 kind + 同 locators/下游 shot)→ 覆盖为最新,旧记录追加到
 *     `manifest.approval_history[]`(附 `superseded_at`)供审计;
 *   - 原子写 `atomicWriteJson`,CLI 层 `withLock` 串行化。
 */
'use strict';
const path = require('path');
const { readJsonFile, atomicWriteJson } = require('./build-manifest');
const { withLock } = require('./lock');
const {
  APPROVAL_KINDS, VERDICT_KEYS, isApprovalKind, isVerdictValue,
  takeDigest, keyframeDigestOf, clipList, findTake, selectedTake,
  resolveAcceptUpstreamCutFrame
} = require('./approvals');

const USAGE = [
  'Usage:',
  '  node tools/mark-approval.js <episode-dir> --kind junction_review \\',
  '    --upstream-clip <clip-id> --downstream-clip <clip-id> \\',
  '    --subject pass|fail --prop pass|fail --action-phase pass|fail --direction pass|fail \\',
  '    [--reviewer <agent|human>] [--timeline <path>]',
  '  node tools/mark-approval.js <episode-dir> --kind accept_upstream \\',
  '    --downstream-shot <shot-id> [--reviewer <agent|human>] [--timeline <path>]'
].join('\n');

function parseArgs(argv) {
  const [episodeDir, ...rest] = argv;
  const opts = {
    episodeDir,
    kind: null,
    upstreamClip: null,
    downstreamClip: null,
    downstreamShot: null,
    subject: null,
    prop: null,
    actionPhase: null,
    direction: null,
    reviewer: null,
    timelinePath: null,
    now: null
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--kind') opts.kind = rest[++i];
    else if (a === '--upstream-clip') opts.upstreamClip = rest[++i];
    else if (a === '--downstream-clip') opts.downstreamClip = rest[++i];
    else if (a === '--downstream-shot') opts.downstreamShot = rest[++i];
    else if (a === '--subject') opts.subject = rest[++i];
    else if (a === '--prop') opts.prop = rest[++i];
    else if (a === '--action-phase') opts.actionPhase = rest[++i];
    else if (a === '--direction') opts.direction = rest[++i];
    else if (a === '--reviewer') opts.reviewer = rest[++i];
    else if (a === '--timeline') opts.timelinePath = rest[++i];
  }
  return opts;
}

/** 重复确认键:`(kind, upstream_clip, downstream_clip)` 或 `(kind, downstream_shot)` */
function approvalsKey(record) {
  if (!record || !record.kind) return 'unknown';
  if (record.kind === 'junction_review') {
    return `${record.kind}|${record.upstream_clip}|${record.downstream_clip}`;
  }
  return `${record.kind}|${record.downstream_shot}`;
}

function requireFrame(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer frame, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** junction_review:两个 clip 存在 + video take 文件存在 → bindings + verdict */
function buildJunctionReview(manifest, timeline, opts, now) {
  if (!opts.upstreamClip) throw new Error('junction_review requires --upstream-clip');
  if (!opts.downstreamClip) throw new Error('junction_review requires --downstream-clip');
  const clips = clipList(timeline);
  const upClip = clips.find(c => c && c.clip_id === opts.upstreamClip);
  if (!upClip) throw new Error(`junction_review: upstream clip ${opts.upstreamClip} not found in timeline`);
  const downClip = clips.find(c => c && c.clip_id === opts.downstreamClip);
  if (!downClip) throw new Error(`junction_review: downstream clip ${opts.downstreamClip} not found in timeline`);
  const upTake = findTake(manifest, upClip.shot_id, upClip.take_id);
  if (!upTake) throw new Error(`junction_review: upstream take ${upClip.shot_id}/${upClip.take_id} not found in manifest`);
  const downTake = findTake(manifest, downClip.shot_id, downClip.take_id);
  if (!downTake) throw new Error(`junction_review: downstream take ${downClip.shot_id}/${downClip.take_id} not found in manifest`);

  const upDigest = takeDigest(upTake);
  if (upDigest === null) {
    throw new Error(`junction_review: upstream take file missing/unreadable: ${upTake.path || '(null)'}`);
  }
  const downDigest = takeDigest(downTake);
  if (downDigest === null) {
    throw new Error(`junction_review: downstream take file missing/unreadable: ${downTake.path || '(null)'}`);
  }
  requireFrame(upClip.source_out, `${upClip.clip_id || upClip.shot_id}.source_out`);
  requireFrame(downClip.source_in, `${downClip.clip_id || downClip.shot_id}.source_in`);
  requireFrame(downClip.deleted_head_frames, `${downClip.clip_id || downClip.shot_id}.deleted_head_frames`);

  const flagMap = { subject: 'subject', prop: 'prop', action_phase: 'actionPhase', direction: 'direction' };
  const verdict = {};
  for (const key of VERDICT_KEYS) {
    const value = opts[flagMap[key]];
    const flag = `--${key.replace(/_/g, '-')}`;
    if (value === undefined || value === null) {
      throw new Error(`junction_review requires ${flag} (pass|fail) — verdict four elements are mandatory`);
    }
    if (!isVerdictValue(value)) {
      throw new Error(`${flag} must be pass or fail, got ${JSON.stringify(value)}`);
    }
    verdict[key] = value;
  }

  return {
    kind: 'junction_review',
    upstream_clip: upClip.clip_id,
    downstream_clip: downClip.clip_id,
    downstream_shot: null,
    bindings: {
      upstream: {
        take_id: upClip.take_id,
        content_digest: upDigest,
        source_out: upClip.source_out
      },
      downstream: {
        keyframe: {
          take_id: (downTake.keyframe && downTake.keyframe.take_id) || null,
          content_digest: keyframeDigestOf(downTake)
        },
        video: {
          take_id: downClip.take_id,
          content_digest: downDigest
        },
        source_in: downClip.source_in,
        deleted_head_frames: downClip.deleted_head_frames
      }
    },
    verdict,
    reviewer: opts.reviewer || process.env.USER || 'unknown',
    reviewed_at: now
  };
}

/** accept_upstream:continue_from 弱承诺的上游 take 接受记录 */
function buildAcceptUpstream(manifest, timeline, opts, now) {
  if (!opts.downstreamShot) throw new Error('accept_upstream requires --downstream-shot');
  const shot = ((manifest.shots) || []).find(s => s && s.id === opts.downstreamShot);
  if (!shot) throw new Error(`accept_upstream: downstream shot ${opts.downstreamShot} not found in manifest`);
  if (typeof shot.continue_from !== 'string' || shot.continue_from.length === 0) {
    throw new Error(`accept_upstream: shot ${shot.id} does not declare continue_from — nothing to accept`);
  }
  const upShot = ((manifest.shots) || []).find(s => s && s.id === shot.continue_from);
  if (!upShot) throw new Error(`accept_upstream: upstream shot ${shot.continue_from} not found in manifest`);
  const upTake = selectedTake(upShot);
  if (!upTake) throw new Error(`accept_upstream: upstream shot ${upShot.id} has no selected video take — finish upstream first`);
  const upDigest = takeDigest(upTake);
  if (upDigest === null) {
    throw new Error(`accept_upstream: upstream take file missing/unreadable: ${upTake.path || '(null)'}`);
  }
  const cut = resolveAcceptUpstreamCutFrame(manifest, timeline, shot);
  if (!cut) {
    throw new Error(
      `accept_upstream: cannot resolve cut_frame for ${shot.id} — provide timeline.json containing the ` +
      `${upShot.id}/${shot.id} clips (or a render_task with continue_from.cut_frame); ` +
      'continue_from_offset_frames alone is a relative offset and cannot yield an absolute frame'
    );
  }
  const downTake = selectedTake(shot);
  const downDigest = downTake ? takeDigest(downTake) : null;
  const downClip = clipList(timeline).find(c => c && c.shot_id === shot.id) || null;
  const downstream = {
    video: {
      take_id: downTake ? downTake.id : null,
      content_digest: downDigest
    }
  };
  if (downClip && Number.isInteger(downClip.source_in)) downstream.source_in = downClip.source_in;
  if (downClip && Number.isInteger(downClip.deleted_head_frames)) downstream.deleted_head_frames = downClip.deleted_head_frames;

  return {
    kind: 'accept_upstream',
    upstream_clip: null,
    downstream_clip: downClip ? downClip.clip_id : null,
    downstream_shot: shot.id,
    bindings: {
      upstream: {
        take_id: upTake.id,
        content_digest: upDigest,
        source_out: cut.cut_frame
      },
      downstream
    },
    reviewer: opts.reviewer || process.env.USER || 'unknown',
    reviewed_at: now
  };
}

/**
 * 构建一条 approval record(纯函数,不写盘)。
 * @param {object} manifest
 * @param {object} timeline
 * @param {object} opts parseArgs 结果
 * @param {string} now ISO 时间戳
 */
function buildApprovalRecord(manifest, timeline, opts, now) {
  if (!isApprovalKind(opts.kind)) {
    throw new Error(`--kind must be one of ${APPROVAL_KINDS.join(' | ')}, got ${JSON.stringify(opts.kind)}`);
  }
  if (opts.kind === 'junction_review') return buildJunctionReview(manifest, timeline, opts, now);
  return buildAcceptUpstream(manifest, timeline, opts, now);
}

/**
 * 读取 manifest + timeline,构建并落盘 approval record(原子写)。
 * 重复确认覆盖为最新,旧记录追加到 manifest.approval_history[](附 superseded_at)。
 * @returns {{record:object, superseded:object|null}}
 */
function updateApproval(absEpDir, opts) {
  const manifestPath = path.join(absEpDir, 'manifest.json');
  const manifest = readJsonFile(manifestPath, { label: 'manifest.json' });
  const timelinePath = opts.timelinePath
    ? (path.isAbsolute(opts.timelinePath) ? opts.timelinePath : path.resolve(opts.timelinePath))
    : path.join(absEpDir, 'timeline.json');
  const timeline = readJsonFile(timelinePath, { label: path.basename(timelinePath) });

  const now = opts.now || new Date().toISOString();
  const record = buildApprovalRecord(manifest, timeline, opts, now);
  const key = approvalsKey(record);

  const approvals = Array.isArray(manifest.approvals) ? manifest.approvals : (manifest.approvals = []);
  const history = Array.isArray(manifest.approval_history) ? manifest.approval_history : (manifest.approval_history = []);
  let superseded = null;
  const idx = approvals.findIndex(r => r && approvalsKey(r) === key);
  if (idx >= 0) {
    superseded = Object.assign({}, approvals[idx], { superseded_at: now });
    history.push(superseded);
    approvals.splice(idx, 1);
  }
  approvals.push(record);
  atomicWriteJson(manifestPath, manifest);
  return { record, superseded };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.episodeDir || !opts.kind) {
    console.error(USAGE);
    process.exit(1);
  }
  const absEpDir = path.isAbsolute(opts.episodeDir) ? opts.episodeDir : path.resolve(opts.episodeDir);
  try {
    const res = withLock(absEpDir, () => updateApproval(absEpDir, opts));
    console.log(`approval recorded: ${res.record.kind}`);
    console.log(`  reviewer: ${res.record.reviewer}`);
    if (res.record.kind === 'junction_review') {
      console.log(`  upstream_clip: ${res.record.upstream_clip} → downstream_clip: ${res.record.downstream_clip}`);
      console.log(`  verdict: ${VERDICT_KEYS.map(k => `${k}=${res.record.verdict[k]}`).join(' ')}`);
    } else {
      console.log(`  downstream_shot: ${res.record.downstream_shot} (upstream cut_frame ${res.record.bindings.upstream.source_out})`);
    }
    if (res.superseded) {
      console.log(`  superseded previous record (archived in manifest.approval_history[] at ${res.superseded.superseded_at})`);
    }
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(3);
  }
}

module.exports = {
  parseArgs, approvalsKey, buildApprovalRecord,
  buildJunctionReview, buildAcceptUpstream, updateApproval, USAGE
};

if (require.main === module) {
  main();
}
