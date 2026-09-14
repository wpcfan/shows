#!/usr/bin/env node
/**
 * approvals.js — PRD v2.11 §3.3 bound approval record(版本绑定人工验收)校验核心
 *
 * 统一机制(`--accept-upstream` 与 cut_join 人工四要素验收):
 *   manifest.approvals[] 存 machine-readable 记录,validity **只**比较
 *   `bindings` 的 `content_digest` 与语义参数(`source_out`/`source_in`/`deleted_head_frames`);
 *   `upstream_clip`/`downstream_clip`/`take_id` 仅定位,不参与失效判定
 *   ——内容相同、locator 变化 → 记录仍有效。
 *
 * 导出:
 *   - validateApprovals(manifest, timeline) → { ok, problems[] }
 *       · 遍历 timeline 中 `cut_join === true` 的 clip:必须存在匹配的 `junction_review`
 *         记录(按 digest + 语义参数匹配,与 locator 无关),verdict 四要素全 pass;
 *       · `accept_upstream` 记录存在时校验 upstream digest 与 cut_frame(不强制存在);
 *   - collectApprovalProblems(manifest, timeline) → problems[](供 edit/stitch 复用);
 *   - checkApprovalsForEpisode(absEpDir, manifest) → { problems, skipped, warning, timeline }
 *       若 `<episode-dir>/timeline.json` 缺失则跳过并给出 WARN(M5 再强制)。
 *
 * 半开区间口径:上游 clip `[source_in, source_out)` 最后保留帧 = `source_out - 1`;
 * `cut_frame := upstream.source_out`。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { fileContentHash, readJsonFile } = require('./build-manifest');

const ROOT = path.resolve(__dirname, '..');
const VERDICT_KEYS = ['subject', 'prop', 'action_phase', 'direction'];
const VERDICT_VALUES = ['pass', 'fail'];
const APPROVAL_KINDS = ['accept_upstream', 'junction_review'];

function isApprovalKind(kind) {
  return APPROVAL_KINDS.includes(kind);
}

function isVerdictValue(value) {
  return VERDICT_VALUES.includes(value);
}

/** verdict 四要素齐全且全为 pass */
function isPassVerdict(verdict) {
  return !!verdict && VERDICT_KEYS.every(k => verdict[k] === 'pass');
}

/** take.path 相对路径按项目 ROOT 解析(与 render-next/build-timeline 一致) */
function absTakePath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return null;
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(ROOT, rawPath);
}

/** 当前 take 文件的内容摘要(sha256 前 16 hex);文件不可读 → null */
function takeDigest(take) {
  if (!take || typeof take.path !== 'string' || take.path.length === 0) return null;
  const abs = absTakePath(take.path);
  if (!abs || !fs.existsSync(abs)) return null;
  return fileContentHash(abs);
}

/** take 记录的 keyframe 绑定 digest(take.keyframe.content_digest 或 null) */
function keyframeDigestOf(take) {
  return take && take.keyframe && take.keyframe.content_digest != null
    ? take.keyframe.content_digest
    : null;
}

/** 兼容 timeline.json({clips:[]})与裸 clip 数组 */
function clipList(timeline) {
  if (!timeline) return [];
  if (Array.isArray(timeline)) return timeline;
  if (Array.isArray(timeline.clips)) return timeline.clips;
  return [];
}

function findShot(manifest, id) {
  return ((manifest && manifest.shots) || []).find(s => s && s.id === id) || null;
}

function findTake(manifest, shotId, takeId) {
  const shot = findShot(manifest, shotId);
  if (!shot) return null;
  return (shot.takes || []).find(t => t && t.id === takeId) || null;
}

function selectedTake(shot) {
  if (!shot || !shot.selected_take) return null;
  return (shot.takes || []).find(t => t && t.id === shot.selected_take) || null;
}

function approvalsOf(manifest) {
  return manifest && Array.isArray(manifest.approvals) ? manifest.approvals : [];
}

/**
 * accept_upstream 的 cut_frame 解析(continue_from 为弱承诺,不触发截断/删帧)。
 * 优先级:timeline 下游 clip 的 junction.cut_frame(cut_join)→ 时间线上游 clip 的
 * source_out → manifest.render_tasks[].continue_from.cut_frame。
 * `continue_from_offset_frames` 只是相对偏移,单独不可导出绝对帧号;无法解析 → null。
 * @returns {{cut_frame:number, source:string}|null}
 */
function resolveAcceptUpstreamCutFrame(manifest, timeline, shot) {
  if (!shot || typeof shot.continue_from !== 'string' || shot.continue_from.length === 0) return null;
  const clips = clipList(timeline);
  const upShotId = shot.continue_from;
  const downIdx = clips.findIndex(c => c && c.shot_id === shot.id);
  if (downIdx >= 0) {
    const downClip = clips[downIdx];
    if (downClip.cut_join === true && downClip.junction && Number.isInteger(downClip.junction.cut_frame)) {
      return { cut_frame: downClip.junction.cut_frame, source: 'timeline.junction' };
    }
    if (downIdx > 0 && clips[downIdx - 1] && clips[downIdx - 1].shot_id === upShotId
      && Number.isInteger(clips[downIdx - 1].source_out)) {
      return { cut_frame: clips[downIdx - 1].source_out, source: 'timeline.upstream_clip' };
    }
  }
  const upClipAny = clips.find(c => c && c.shot_id === upShotId && Number.isInteger(c.source_out));
  if (upClipAny) return { cut_frame: upClipAny.source_out, source: 'timeline.upstream_clip' };
  const task = ((manifest && manifest.render_tasks) || [])
    .find(t => t && t.shot_id === shot.id && t.continue_from && Number.isInteger(t.continue_from.cut_frame));
  if (task) return { cut_frame: task.continue_from.cut_frame, source: 'manifest.render_task' };
  return null;
}

/** junction_review 记录是否与当前 clip 语义绑定的 digest + 语义参数一致(忽略 locators) */
function junctionBindingMatches(record, current) {
  const b = record && record.bindings;
  if (!b || !b.upstream || !b.downstream) return false;
  const up = b.upstream;
  const down = b.downstream;
  if (up.content_digest !== current.upstream.content_digest) return false;
  if (up.source_out !== current.upstream.source_out) return false;
  if (!down.video || down.video.content_digest !== current.downstream.video.content_digest) return false;
  if (down.source_in !== current.downstream.source_in) return false;
  if (down.deleted_head_frames !== current.downstream.deleted_head_frames) return false;
  const recordedKf = down.keyframe ? down.keyframe.content_digest : null;
  if (recordedKf != null && recordedKf !== current.downstream.keyframe.content_digest) return false;
  return true;
}

function fmtDigest(v) {
  return v === null || v === undefined ? '(null)' : String(v);
}

/** 逐项列出绑定差异(消息含"哪个绑定不一致") */
function describeJunctionMismatch(record, current) {
  const b = (record && record.bindings) || {};
  const up = b.upstream || {};
  const down = b.downstream || {};
  const video = down.video || {};
  const parts = [];
  if (up.content_digest !== current.upstream.content_digest) {
    parts.push(`upstream content_digest ${fmtDigest(up.content_digest)} != current ${fmtDigest(current.upstream.content_digest)}`);
  }
  if (up.source_out !== current.upstream.source_out) {
    parts.push(`upstream source_out ${fmtDigest(up.source_out)} != current ${fmtDigest(current.upstream.source_out)}`);
  }
  if (video.content_digest !== current.downstream.video.content_digest) {
    parts.push(`downstream video content_digest ${fmtDigest(video.content_digest)} != current ${fmtDigest(current.downstream.video.content_digest)}`);
  }
  if (down.source_in !== current.downstream.source_in) {
    parts.push(`downstream source_in ${fmtDigest(down.source_in)} != current ${fmtDigest(current.downstream.source_in)}`);
  }
  if (down.deleted_head_frames !== current.downstream.deleted_head_frames) {
    parts.push(`downstream deleted_head_frames ${fmtDigest(down.deleted_head_frames)} != current ${fmtDigest(current.downstream.deleted_head_frames)}`);
  }
  const recordedKf = down.keyframe ? down.keyframe.content_digest : null;
  if (recordedKf != null && recordedKf !== current.downstream.keyframe.content_digest) {
    parts.push(`downstream keyframe content_digest ${fmtDigest(recordedKf)} != current ${fmtDigest(current.downstream.keyframe.content_digest)}`);
  }
  return parts.length ? parts.join('; ') : 'binding mismatch';
}

function describeVerdict(verdict) {
  const v = verdict || {};
  return VERDICT_KEYS
    .map(k => `${k}=${v[k] === undefined || v[k] === null ? '(missing)' : v[k]}`)
    .join(', ');
}

/**
 * 校验 manifest.approvals[] 对当前 story 是否仍有效。
 * 不抛错,返回 { ok, problems }。
 * @param {object} manifest
 * @param {object|Array} timeline timeline.json 或 clip 数组
 * @returns {{ok:boolean, problems:string[]}}
 */
function validateApprovals(manifest, timeline) {
  const problems = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, problems: ['manifest must be an object'] };
  }
  const approvals = approvalsOf(manifest);
  const clips = clipList(timeline);
  const junctionRecords = approvals.filter(r => r && r.kind === 'junction_review');

  // --- cut_join 接头:每个都必须有匹配的 junction_review 记录且四要素全 pass ---
  clips.forEach((clip, i) => {
    if (!clip || clip.cut_join !== true) return;
    const clipId = clip.clip_id || `clips[${i}]`;
    if (i === 0) {
      problems.push(`${clipId}: cut_join clip has no upstream clip in timeline — cannot validate junction_review approval`);
      return;
    }
    const upClip = clips[i - 1];
    if (!upClip) {
      problems.push(`${clipId}: preceding timeline clip missing — cannot validate junction_review approval`);
      return;
    }
    const upTake = findTake(manifest, upClip.shot_id, upClip.take_id);
    const downTake = findTake(manifest, clip.shot_id, clip.take_id);
    if (!upTake) {
      problems.push(`${clipId}: upstream take ${upClip.shot_id}/${upClip.take_id} not found in manifest`);
      return;
    }
    if (!downTake) {
      problems.push(`${clipId}: downstream take ${clip.shot_id}/${clip.take_id} not found in manifest`);
      return;
    }
    const upDigest = takeDigest(upTake);
    const downDigest = takeDigest(downTake);
    if (upDigest === null) {
      problems.push(`${clipId}: upstream take file missing/unreadable (${upTake.path || '(null)'}) — cannot verify junction_review binding`);
      return;
    }
    if (downDigest === null) {
      problems.push(`${clipId}: downstream take file missing/unreadable (${downTake.path || '(null)'}) — cannot verify junction_review binding`);
      return;
    }
    const current = {
      upstream: { content_digest: upDigest, source_out: upClip.source_out },
      downstream: {
        keyframe: { content_digest: keyframeDigestOf(downTake) },
        video: { content_digest: downDigest },
        source_in: clip.source_in,
        deleted_head_frames: clip.deleted_head_frames
      }
    };
    const bindingMatches = junctionRecords.filter(r => junctionBindingMatches(r, current));
    if (bindingMatches.length === 0) {
      const locator = junctionRecords.find(r => r.upstream_clip === upClip.clip_id && r.downstream_clip === clip.clip_id)
        || junctionRecords.find(r => r.downstream_clip === clip.clip_id)
        || junctionRecords.find(r => r.upstream_clip === upClip.clip_id);
      if (locator) {
        problems.push(
          `${clipId}: junction_review approval binding is stale — ${describeJunctionMismatch(locator, current)} ` +
          `(locator upstream_clip=${locator.upstream_clip}, downstream_clip=${locator.downstream_clip}; locators alone do not invalidate, digests/params do)`
        );
      } else {
        problems.push(
          `${clipId}: no junction_review approval bound to this cut_join junction ` +
          `(upstream ${upClip.clip_id || upClip.shot_id}, downstream ${clip.clip_id}) — record one with tools/mark-approval.js`
        );
      }
      return;
    }
    const passing = bindingMatches.find(r => isPassVerdict(r.verdict));
    if (!passing) {
      const bad = bindingMatches[0];
      problems.push(
        `${clipId}: junction_review approval verdict is not all-pass (${describeVerdict(bad.verdict)}) — ` +
        'PRD §3.3 requires subject/prop/action_phase/direction all pass before --final'
      );
    }
  });

  // --- accept_upstream:弱承诺,不强制存在;存在即校验 upstream digest 与 cut_frame ---
  for (const r of approvals.filter(x => x && x.kind === 'accept_upstream')) {
    const shotId = r.downstream_shot;
    const prefix = `accept_upstream approval${shotId ? ` for ${shotId}` : ''}`;
    if (!shotId) {
      problems.push(`${prefix}: missing downstream_shot locator — cannot validate`);
      continue;
    }
    const shot = findShot(manifest, shotId);
    if (!shot) {
      problems.push(`${prefix}: shot not found in manifest`);
      continue;
    }
    if (typeof shot.continue_from !== 'string' || shot.continue_from.length === 0) {
      problems.push(`${prefix}: shot no longer declares continue_from — approval is invalid`);
      continue;
    }
    const upShot = findShot(manifest, shot.continue_from);
    const upTake = upShot ? selectedTake(upShot) : null;
    if (!upTake) {
      problems.push(`${prefix}: upstream ${shot.continue_from} has no selected video take — approval is invalid`);
      continue;
    }
    const upDigest = takeDigest(upTake);
    if (upDigest === null) {
      problems.push(`${prefix}: upstream take file missing/unreadable (${upTake.path || '(null)'})`);
      continue;
    }
    const recordedUp = (r.bindings && r.bindings.upstream) || {};
    if (recordedUp.content_digest !== upDigest) {
      problems.push(`${prefix}: upstream content_digest changed (recorded ${fmtDigest(recordedUp.content_digest)}, current ${upDigest})`);
    }
    const cut = resolveAcceptUpstreamCutFrame(manifest, timeline, shot);
    if (cut && recordedUp.source_out !== cut.cut_frame) {
      problems.push(`${prefix}: cut_frame changed (recorded ${fmtDigest(recordedUp.source_out)}, current ${cut.cut_frame} via ${cut.source})`);
    }
  }

  return { ok: problems.length === 0, problems };
}

/** 供 edit-episode / stitch-episode 复用的 problems 数组 */
function collectApprovalProblems(manifest, timeline) {
  return validateApprovals(manifest, timeline).problems;
}

/**
 * 读 `<episode-dir>/timeline.json` 并校验 approvals。
 * timeline.json 缺失 → 跳过(problems 为空)并返回 WARN(M5 再强制)。
 * @param {string} absEpDir
 * @param {object} manifest
 * @returns {{problems:string[], skipped:boolean, timeline:object|null, warning:string|null}}
 */
function checkApprovalsForEpisode(absEpDir, manifest) {
  const timelinePath = path.join(absEpDir, 'timeline.json');
  if (!fs.existsSync(timelinePath)) {
    return {
      problems: [],
      skipped: true,
      timeline: null,
      warning: `timeline.json not found in ${absEpDir} — bound approval record checks skipped (M5 will make this mandatory before --final)`
    };
  }
  const timeline = readJsonFile(timelinePath, { label: 'timeline.json' });
  return { problems: collectApprovalProblems(manifest, timeline), skipped: false, timeline, warning: null };
}

module.exports = {
  VERDICT_KEYS, VERDICT_VALUES, APPROVAL_KINDS,
  isApprovalKind, isVerdictValue, isPassVerdict,
  absTakePath, takeDigest, keyframeDigestOf, clipList,
  findShot, findTake, selectedTake, approvalsOf,
  resolveAcceptUpstreamCutFrame,
  junctionBindingMatches, describeJunctionMismatch, describeVerdict,
  validateApprovals, collectApprovalProblems, checkApprovalsForEpisode
};
