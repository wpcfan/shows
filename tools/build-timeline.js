#!/usr/bin/env node
/**
 * build-timeline.js — PRD v2.4 §3.6 剪辑时间线核心（M1 timeline core）
 *
 * 纯函数核心 + CLI:
 *   - resolveTimelineFps(edit, manifest): edit.timeline.fps → manifest.fps → 30
 *   - secondsToFrames(seconds, fps) / msToFrames(ms, fps): 帧号 + 换算残差
 *   - buildTimeline({ edit, manifest, sourceDurations, options }): clip 实例构建
 *       M4b:cut_join 接头相邻性校验 + 截断(source_out=cut_frame)+ 删帧(deleted_head_frames)
 *       + junction 审计记录;continue_from 为弱承诺,不触发截断/删帧。
 *       M5-OVF(v2):接头处理之后、输出重算之前做 §3.4 对白溢出决策
 *       (dialogue/overflow/padding_frames/trim/dialogue_spill_ms/spill_in);v1 不接入。
 *   - validateTimeline(timeline): 契约校验(不抛错, 返回错误列表)
 *
 * 契约(§3.6 硬规则, 一次性写死):
 *   - 所有 frame range 均为 start-inclusive / end-exclusive 半开区间 [start, end);
 *     duration_frames = end - start。
 *   - clip 实例为唯一发布基准: 同一 take 可被多个 clip 引用, 各自独立计算;
 *     输出按时间线顺序严格连续(首个 output_start = 0)。
 *   - 入出点可以是帧原生(source_in/source_out)或秒制(in_point/out_point);
 *     秒制换算残差记入 conversion_residuals, 帧原生条目为 null。
 *   - deleted_head_frames / padding_frames 参与输出时长口径:
 *     duration = (source_out - source_in) - deleted_head_frames + padding_frames。
 *   - 构建结果确定性: 不含时间戳, 同样入参两次构建 deep-equal。
 *
 * CLI:
 *   node tools/build-timeline.js <episode-dir> [--out <path>] [--dry-run]
 *   - js-yaml 读 edit.yaml, readJsonFile 读 manifest.json;
 *   - 秒制条目缺 out_point 时用 ffprobe 取 take 时长(仅 CLI 使用);
 *   - build + validate 失败非零退出并打印全部错误;
 *   - 默认写 <episode-dir>/timeline.json(atomicWriteJson); --dry-run 只打印 JSON。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { execFileSync } = require('child_process');
const {
  readJsonFile, atomicWriteJson,
  secondsToFrames: secondsToFramesCore,
  DEFAULT_CONTINUE_FROM_OFFSET_SEC
} = require('./build-manifest');
const { decideDeletedHeadFrames, compareJunctionFrames } = require('./junction');
const {
  selectDialogueTake, resolveDialogueTiming, overflowFrames, decideOverflow,
  clipOutputFrames, checkSpillConstraints, trimDialogue, collectUnresolvedOverflow
} = require('./dialogue');

const DEFAULT_FPS = 30;
const ROOT = path.resolve(__dirname, '..');
const TIMELINE_VERSION = 1;

function isPositiveInt(v) {
  return Number.isInteger(v) && v > 0;
}

/**
 * 解析 episode 统一 FPS: edit.timeline.fps → manifest.fps → 30。
 * 解析结果必须为有限正整数, 否则抛错。
 * @param {object} [edit]
 * @param {object} [manifest]
 * @returns {number}
 */
function resolveTimelineFps(edit, manifest) {
  let value;
  const editFps = edit && edit.timeline && typeof edit.timeline === 'object' ? edit.timeline.fps : undefined;
  const manifestFps = manifest ? manifest.fps : undefined;
  if (editFps !== undefined && editFps !== null) value = editFps;
  else if (manifestFps !== undefined && manifestFps !== null) value = manifestFps;
  else value = DEFAULT_FPS;
  if (!isPositiveInt(value)) {
    throw new Error(`timeline fps must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireFps(fps) {
  if (!isPositiveInt(fps)) {
    throw new Error(`fps must be a positive integer, got ${JSON.stringify(fps)}`);
  }
}

/**
 * 秒 → 帧:frames = round(seconds * fps); residual = seconds - frames / fps。
 * §3.3/M4a 权威实现已收敛到 build-manifest.secondsToFrames;
 * 本包装保留 build-timeline 既有语义(秒必须为有限**非负**数),作为兼容转发。
 * @returns {{frames:number, residual:number}}
 */
function secondsToFrames(seconds, fps) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`seconds must be a finite non-negative number, got ${JSON.stringify(seconds)}`);
  }
  return secondsToFramesCore(seconds, fps);
}

/**
 * 毫秒 → 帧: frames = round(ms * fps / 1000); residual = ms/1000 - frames/fps。
 * 供 §3.4 spill 换算使用(本工具只提供函数, 不接音频)。
 * @returns {{frames:number, residual:number}}
 */
function msToFrames(ms, fps) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
    throw new Error(`ms must be a finite non-negative number, got ${JSON.stringify(ms)}`);
  }
  requireFps(fps);
  const frames = Math.round((ms * fps) / 1000);
  return { frames, residual: ms / 1000 - frames / fps };
}

/**
 * 归一化 clip 级 SFX cue（§3.4）。
 * 形态 `{id, at, gain_db?}`，`at` 为 clip 内帧号；缺省/null → []（不新增字段，避免漂移）。
 * 回归 M5-AUD：`audio.js` 按 `clip.output_start + at` 换算绝对毫秒。
 */
function normalizeSfx(sfx, name) {
  if (sfx === undefined || sfx === null) return [];
  if (!Array.isArray(sfx)) throw new Error(`${name} must be an array of {id, at, gain_db}`);
  return sfx.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${name}[${i}] must be an object {id, at, gain_db}`);
    }
    if (typeof item.id !== 'string' || item.id.length === 0) {
      throw new Error(`${name}[${i}].id must be a non-empty string`);
    }
    if (!Number.isInteger(item.at) || item.at < 0) {
      throw new Error(`${name}[${i}].at must be a non-negative integer frame, got ${JSON.stringify(item.at)}`);
    }
    const out = { id: item.id, at: item.at };
    if (item.gain_db !== undefined && item.gain_db !== null) {
      if (typeof item.gain_db !== 'number' || !Number.isFinite(item.gain_db)) {
        throw new Error(`${name}[${i}].gain_db must be a finite number, got ${JSON.stringify(item.gain_db)}`);
      }
      out.gain_db = item.gain_db;
    }
    return out;
  });
}

/**
 * 归一化集级 music cue（§3.4）：`edit.timeline.cues[]`，`at` 帧号优先 / `at_ms` 回退。
 * 缺失 → []（不向 timeline 添加 cues 字段，v1/v2 既有 fixture 不漂移）。
 * 宽容：缺 `id` 的遗留 cue 原样透传（`audio.js` 混音时作为结构性错误拒绝）。
 */
function normalizeCues(edit) {
  const t = edit && edit.timeline;
  const raw = (t && !Array.isArray(t) && typeof t === 'object' && Array.isArray(t.cues)) ? t.cues : [];
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`timeline.cues[${i}] must be an object {id, at|at_ms, gain_db}`);
    }
    const out = {};
    if (item.id !== undefined && item.id !== null) {
      if (typeof item.id !== 'string' || item.id.length === 0) {
        throw new Error(`timeline.cues[${i}].id must be a non-empty string`);
      }
      out.id = item.id;
    }
    if (item.at !== undefined && item.at !== null) {
      if (!Number.isInteger(item.at) || item.at < 0) {
        throw new Error(`timeline.cues[${i}].at must be a non-negative integer frame, got ${JSON.stringify(item.at)}`);
      }
      out.at = item.at;
    }
    if (item.at_ms !== undefined && item.at_ms !== null) {
      if (typeof item.at_ms !== 'number' || !Number.isFinite(item.at_ms) || item.at_ms < 0) {
        throw new Error(`timeline.cues[${i}].at_ms must be a finite non-negative number, got ${JSON.stringify(item.at_ms)}`);
      }
      out.at_ms = item.at_ms;
    }
    if (out.at === undefined && out.at_ms === undefined) {
      throw new Error(`timeline.cues[${i}] requires an absolute frame \`at\` or \`at_ms\``);
    }
    if (item.clip_id !== undefined && item.clip_id !== null) out.clip_id = item.clip_id;
    if (item.shot_id !== undefined && item.shot_id !== null) out.shot_id = item.shot_id;
    if (item.gain_db !== undefined && item.gain_db !== null) {
      if (typeof item.gain_db !== 'number' || !Number.isFinite(item.gain_db)) {
        throw new Error(`timeline.cues[${i}].gain_db must be a finite number, got ${JSON.stringify(item.gain_db)}`);
      }
      out.gain_db = item.gain_db;
    }
    return out;
  });
}

/** 时间线条目来源: 数组 edit.timeline 或对象 edit.timeline.clips(PRD §3.6 两种写法) */
function extractTimelineEntries(edit) {
  const t = edit && edit.timeline;
  if (Array.isArray(t)) return t;
  if (t && typeof t === 'object' && Array.isArray(t.clips)) return t.clips;
  return null;
}

function findTake(manifest, shotId, takeId) {
  const shots = (manifest && manifest.shots) || [];
  const shot = shots.find(s => s && s.id === shotId);
  if (!shot) throw new Error(`timeline references unknown shot_id ${JSON.stringify(shotId)}`);
  const take = (shot.takes || []).find(t => t && t.id === takeId);
  if (!take) throw new Error(`timeline references unknown take_id ${JSON.stringify(takeId)} for shot ${JSON.stringify(shotId)}`);
  return take;
}

function requireFrame(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer frame, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * 归一化 spill_in 条目。
 * 既有形态 `{dialogue, ms}`（§3.6）；M5-OVF 追加可选 `take_id`（spill 来源 take）。
 * 只保留显式给出的键，保证既有条目 deep-equal 不漂移。
 */
function normalizeSpillIn(spill, name) {
  if (spill === undefined || spill === null) return [];
  if (!Array.isArray(spill)) throw new Error(`${name} must be an array of {dialogue, ms}`);
  return spill.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${name}[${i}] must be an object {dialogue, ms}`);
    }
    const dialogueId = (item.dialogue !== undefined && item.dialogue !== null) ? item.dialogue : item.take_id;
    if (typeof dialogueId !== 'string') {
      throw new Error(`${name}[${i}].dialogue must be a string`);
    }
    if (typeof item.ms !== 'number' || !Number.isFinite(item.ms) || item.ms < 0) {
      throw new Error(`${name}[${i}].ms must be a finite non-negative number, got ${JSON.stringify(item.ms)}`);
    }
    const out = { dialogue: dialogueId, ms: item.ms };
    if (item.take_id !== undefined && item.take_id !== null) {
      if (typeof item.take_id !== 'string') {
        throw new Error(`${name}[${i}].take_id must be a string`);
      }
      out.take_id = item.take_id;
    }
    return out;
  });
}

/**
 * 校验单个 clip 的删帧/时长口径(未通过抛错)。
 * 错误消息与 M1 基线保持一致(deleted_head_frames / duration)。
 */
function validateClipDuration(clip, label) {
  const deleted = clip.deleted_head_frames;
  if (!Number.isInteger(deleted) || deleted < 0) {
    throw new Error(`${label} deleted_head_frames must be a non-negative integer, got ${JSON.stringify(deleted)}`);
  }
  const range = clip.source_out - clip.source_in;
  if (deleted > range) {
    throw new Error(`${label} deleted_head_frames (${deleted}) exceeds source range (${range})`);
  }
  const durationFrames = range - deleted + clip.padding_frames;
  if (durationFrames <= 0) {
    throw new Error(`${label} clip duration must be > 0, got ${durationFrames} frames`);
  }
  return durationFrames;
}

/**
 * §3.3/M4b:cut_join 接头的 offset 帧号。
 * 优先读 build-manifest canonicalize 的 `continue_from_offset_frames`;
 * 缺失时按 `continue_from_offset` 秒(缺省 -0.1)用 episode FPS 换算(允许负秒)。
 * 不得使用 build-timeline 的非负兼容包装 secondsToFrames。
 */
function resolveJunctionOffsetFrames(shot, fps) {
  if (shot && Number.isInteger(shot.continue_from_offset_frames)) {
    return shot.continue_from_offset_frames;
  }
  const raw = (shot && shot.continue_from_offset !== undefined && shot.continue_from_offset !== null)
    ? shot.continue_from_offset
    : DEFAULT_CONTINUE_FROM_OFFSET_SEC;
  return secondsToFramesCore(raw, fps).frames;
}

/** §3.3/M4b:接头比对需要素材文件;相对路径按项目 ROOT 解析(epDir/manifestPath 兜底) */
function resolveJunctionTakePath(rawPath, options = {}) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new Error(`cut_join junction requires a take path, got ${JSON.stringify(rawPath)}`);
  }
  const candidates = [];
  if (path.isAbsolute(rawPath)) {
    candidates.push(rawPath);
  } else {
    candidates.push(path.resolve(ROOT, rawPath));
    if (options.epDir) candidates.push(path.resolve(options.epDir, rawPath));
    if (options.manifestPath) candidates.push(path.resolve(path.dirname(options.manifestPath), rawPath));
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`cut_join junction take file not found: ${JSON.stringify(rawPath)} (checked ${candidates.join(', ')})`);
}

/**
 * §3.3/M4b:cut_join 接镜处理(相邻性校验 + 截断恒发生 + 删帧由 S 决定)。
 * 就地更新 clips[i] 与作为其上游的 clips[i-1]。
 */
function applyJunctionProcessing({ edit, manifest, clips, shots, fps, options }) {
  const junctionCompare = typeof options.junctionCompare === 'function'
    ? options.junctionCompare
    : compareJunctionFrames;
  const thresholdS = (edit && edit.timeline && !Array.isArray(edit.timeline))
    ? edit.timeline.same_frame_ssim_threshold
    : undefined;

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    if (!clip.cut_join) continue;

    // 相邻性:cut_join 必须与上游在最终时间线中相邻(首 clip 无上游 → 报错)
    if (i === 0) {
      throw new Error(
        `cut_join adjacency violation: clip ${clip.clip_id} (shot ${clip.shot_id}) is the first timeline clip ` +
        'and has no upstream clip — adjust edit.yaml or remove cut_join'
      );
    }
    const shot = shots.find(s => s && s.id === clip.shot_id) || null;
    const shotIndex = shot ? shots.indexOf(shot) : -1;
    const upstreamShotId = (shot && typeof shot.continue_from === 'string' && shot.continue_from.length > 0)
      ? shot.continue_from
      : (shotIndex > 0 ? shots[shotIndex - 1].id : null);
    const upstreamClip = clips[i - 1];
    if (!upstreamShotId || upstreamClip.shot_id !== upstreamShotId) {
      throw new Error(
        `cut_join adjacency violation: clip ${clip.clip_id} (shot ${clip.shot_id}) expects upstream shot ` +
        `${upstreamShotId === null ? '(none)' : upstreamShotId}, but the preceding timeline clip is ` +
        `${upstreamClip.clip_id} (shot ${upstreamClip.shot_id}) — adjust edit.yaml or remove cut_join`
      );
    }

    // S 必填(有限非负);S 只决定删不删,不隐含删几帧
    if (typeof thresholdS !== 'number' || !Number.isFinite(thresholdS) || thresholdS < 0) {
      throw new Error(
        'cut_join requires timeline.same_frame_ssim_threshold ' +
        `(finite non-negative number), got ${JSON.stringify(thresholdS)}`
      );
    }

    // 截断恒发生(cut_join 定义):cutFrame = upstream.source_out + offset,clamp 到 [source_in+1, source_out]
    const offsetFrames = resolveJunctionOffsetFrames(shot, fps);
    const lo = upstreamClip.source_in + 1;
    const hi = upstreamClip.source_out;
    let cutFrame = upstreamClip.source_out + offsetFrames;
    if (cutFrame < lo) cutFrame = lo;
    if (cutFrame > hi) cutFrame = hi;
    upstreamClip.source_out = cutFrame; // 半开区间:最后保留帧 = cutFrame - 1

    // take 文件定位 + 接头比对(upstream[cutFrame-1] vs downstream[source_in])
    const upstreamTake = findTake(manifest, upstreamClip.shot_id, upstreamClip.take_id);
    const downstreamTake = findTake(manifest, clip.shot_id, clip.take_id);
    const upstreamPath = resolveJunctionTakePath(upstreamTake.path, options);
    const downstreamPath = resolveJunctionTakePath(downstreamTake.path, options);
    const result = junctionCompare({
      upstreamPath,
      cutFrame,
      downstreamPath,
      sourceIn: clip.source_in,
      fps
    });
    if (!result || typeof result.ssim !== 'number') {
      throw new Error(`junctionCompare must return {ssim: number} for clip ${clip.clip_id}`);
    }
    const requested = Number.isInteger(clip.deleted_head_frames) ? clip.deleted_head_frames : 1;
    const deleted = decideDeletedHeadFrames(result.ssim, thresholdS, requested);
    clip.deleted_head_frames = deleted;
    clip.junction = {
      ssim: result.ssim,
      threshold_s: thresholdS,
      cut_frame: cutFrame,
      deleted_head_frames: deleted
    };
  }
}

/**
 * §3.4/M5-OVF 配置解析（写死）：
 *   allow_trim: edit.timeline.allow_trim → edit.overflow.allow_trim → false
 *   max_freeze_padding_frames: edit.timeline.max_freeze_padding_frames → edit.overflow.max_freeze_padding_frames → 0
 */
function resolveOverflowConfig(edit) {
  const timelineCfg = (edit && edit.timeline && !Array.isArray(edit.timeline) && typeof edit.timeline === 'object')
    ? edit.timeline : {};
  const overflowCfg = (edit && edit.overflow && typeof edit.overflow === 'object' && !Array.isArray(edit.overflow))
    ? edit.overflow : {};

  let allowTrim = timelineCfg.allow_trim !== undefined && timelineCfg.allow_trim !== null
    ? timelineCfg.allow_trim : overflowCfg.allow_trim;
  if (allowTrim === undefined || allowTrim === null) allowTrim = false;
  if (typeof allowTrim !== 'boolean') {
    throw new Error(`edit timeline allow_trim must be a boolean, got ${JSON.stringify(allowTrim)}`);
  }

  let maxPad = timelineCfg.max_freeze_padding_frames !== undefined && timelineCfg.max_freeze_padding_frames !== null
    ? timelineCfg.max_freeze_padding_frames : overflowCfg.max_freeze_padding_frames;
  if (maxPad === undefined || maxPad === null) maxPad = 0;
  if (!Number.isInteger(maxPad) || maxPad < 0) {
    throw new Error(`edit timeline max_freeze_padding_frames must be a non-negative integer, got ${JSON.stringify(maxPad)}`);
  }

  return { allowTrim, maxPad };
}

/** shot 的对白文本：优先 manifest canonical 的 dialogue_text，兼容脚本态 dialogue */
function shotDialogueText(shot) {
  if (!shot) return '';
  if (typeof shot.dialogue_text === 'string' && shot.dialogue_text.trim().length > 0) return shot.dialogue_text;
  if (typeof shot.dialogue === 'string' && shot.dialogue.trim().length > 0) return shot.dialogue;
  if (shot.dialogue && typeof shot.dialogue === 'object' && typeof shot.dialogue.text === 'string'
    && shot.dialogue.text.trim().length > 0) {
    return shot.dialogue.text;
  }
  return '';
}

/** spill 段（下游 clip 头部 [0, spillFrames)）落入 cue 时 WARN（允许但留痕，§3.4） */
function warnCuesInSpill({ edit, entries, nextIndex, nextClip, spillFrames, warn }) {
  if (!Array.isArray(entries) || spillFrames <= 0) return;
  const cues = [];
  const nextEntry = entries[nextIndex];
  if (nextEntry && Array.isArray(nextEntry.sfx)) {
    for (const c of nextEntry.sfx) if (c && typeof c === 'object') cues.push({ cue: c, source: 'clip.sfx' });
  }
  const globalCues = (edit && edit.timeline && !Array.isArray(edit.timeline)
    && Array.isArray(edit.timeline.cues)) ? edit.timeline.cues : [];
  for (const c of globalCues) {
    if (!c || typeof c !== 'object') continue;
    const matchesClip = typeof c.clip_id === 'string' && c.clip_id === nextClip.clip_id;
    const matchesShot = typeof c.shot_id === 'string' && c.shot_id === nextClip.shot_id;
    if (matchesClip || matchesShot) cues.push({ cue: c, source: 'timeline.cues' });
  }
  for (const { cue, source } of cues) {
    if (typeof cue.at === 'number' && Number.isFinite(cue.at) && cue.at >= 0 && cue.at < spillFrames) {
      warn(`WARN: ${source} cue ${cue.id === undefined ? `@${cue.at}` : cue.id} at clip frame ${cue.at} falls in the dialogue spill segment [0, ${spillFrames}) of clip ${nextClip.clip_id} — allowed but flagged (§3.4)`);
    }
  }
}

/**
 * §3.4/M5-OVF 对白溢出决策（在接头处理之后、输出重算之前）。
 * 就地更新 clips[]：dialogue / overflow / padding_frames / trim / dialogue_spill_ms / spill_in。
 * 无实测（measured:false）只 WARN 留标记，不阻断（未解决溢出由 Gate #6 在 final 拒绝）。
 * 策略执行后仍无法解决 → 抛错（含 clip id、溢出帧数与各策略否决原因）。
 */
function applyDialogueOverflow({ edit, manifest: _manifest, clips, entries, shots, fps, options }) {
  const warn = (options && typeof options.warn === 'function') ? options.warn : () => {};
  const { allowTrim, maxPad } = resolveOverflowConfig(edit);

  // pass 2.5a: 解析每个 clip 的对白实测时长（下游 spill 判定需要先知道下一 clip 的 dialogue）
  clips.forEach((clip) => {
    const shot = shots.find(s => s && s.id === clip.shot_id) || null;
    const text = shotDialogueText(shot);
    const hasTakes = !!(shot && Array.isArray(shot.tts_takes) && shot.tts_takes.length > 0);
    if (text.length === 0 && !hasTakes) {
      clip.dialogue = null;
      return;
    }
    const take = selectDialogueTake(shot);
    const timing = resolveDialogueTiming({ shot, ttsTake: take, fps });
    clip.dialogue = {
      take_id: timing.tts_take_id,
      dialogue_ms: timing.dialogue_ms,
      measured: timing.measured,
      text: text.length > 0 ? text : null,
    };
    if (!timing.measured) {
      warn(`WARN: clip ${clip.clip_id} (shot ${clip.shot_id}) has dialogue but no measured TTS take (dialogue.measured=false) — run TTS and select a take before final (§3.4)`);
    }
  });

  // pass 2.5b: 溢出决策（顺序与 PRD §3.4 一致）
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    if (!clip.dialogue || !clip.dialogue.measured || typeof clip.dialogue.dialogue_ms !== 'number') continue;

    const outputFrames = clipOutputFrames(clip);
    if (!(Number.isInteger(outputFrames) && outputFrames > 0)) continue;
    const ovf = overflowFrames(clip.dialogue.dialogue_ms, outputFrames, fps);
    if (ovf === 0) {
      clip.overflow = { strategy: 'none', overflow_frames: 0 };
      continue;
    }

    const nextClip = clips[i + 1] || null;
    const spill = checkSpillConstraints({ clip, nextClip, overflowFrames: ovf, fps });
    const decision = decideOverflow({ overflowFrames: ovf, allowTrim, maxFreezePaddingFrames: maxPad, spill });

    if (decision.strategy === 'pad_freeze') {
      clip.padding_frames = clip.padding_frames + decision.padding_frames;
      clip.overflow = { strategy: 'pad_freeze', overflow_frames: ovf, padding_frames: decision.padding_frames };
    } else if (decision.strategy === 'trim') {
      const keepMs = Math.min(clip.dialogue.dialogue_ms, Math.floor((outputFrames * 1000) / fps));
      const trimmed = trimDialogue({ text: clip.dialogue.text || '', dialogueMs: clip.dialogue.dialogue_ms, keepMs });
      clip.trim = { dialogue_ms: clip.dialogue.dialogue_ms, keep_ms: keepMs, text_truncated: trimmed.truncated };
      clip.dialogue.text = trimmed.text;
      clip.dialogue.dialogue_ms = keepMs;
      clip.overflow = { strategy: 'trim', overflow_frames: ovf, keep_ms: keepMs };
    } else if (decision.strategy === 'dialogue_spill') {
      const ms = Math.round((ovf * 1000) / fps);
      clip.dialogue_spill_ms = ms;
      const takeId = clip.dialogue.take_id;
      if (!Array.isArray(nextClip.spill_in)) nextClip.spill_in = [];
      nextClip.spill_in.push({ dialogue: takeId, take_id: takeId, ms });
      clip.overflow = { strategy: 'dialogue_spill', overflow_frames: ovf, spill_ms: ms };
      warnCuesInSpill({ edit, entries, nextIndex: i + 1, nextClip, spillFrames: ovf, warn });
    } else {
      throw new Error(
        `dialogue overflow unresolved for clip ${clip.clip_id} (shot ${clip.shot_id}): overflow ${ovf} frame(s); ${decision.reason}. ` +
        'Fix the script/edit per PRD §3.4 (lengthen requested_video_duration, enable allow_trim, or free the next clip dialogue).'
      );
    }
  }
}

/**
 * 构建时间线 clip 实例(纯函数, 无 I/O, 确定性)。
 *
 * M4b:cut_join 接头在构建期完成相邻性校验 + 截断 + 删帧;
 * continue_from(非 cut_join)为弱承诺,不触发任何截断/删帧。
 *
 * @param {object} args
 * @param {object} args.edit            含 timeline 数组(或 {fps, same_frame_ssim_threshold, clips})
 * @param {object} args.manifest        含 shots[](script 顺序;cut_join/continue_from/takes[].path)
 * @param {object} [args.sourceDurations] shot_id → 秒(秒制条目缺 out_point 时的缺省)
 * @param {object} [args.options]       junctionCompare(stub)/manifestPath/epDir(接头比对定位)
 * @returns {{version:number, fps:number, clips:Array<object>}}
 */
function buildTimeline({ edit, manifest, sourceDurations = {}, options = {} } = {}) {
  const entries = extractTimelineEntries(edit);
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('edit.timeline must be a non-empty array of clip entries');
  }
  const fps = resolveTimelineFps(edit, manifest);
  const durations = sourceDurations && typeof sourceDurations === 'object' ? sourceDurations : {};
  const shots = (manifest && manifest.shots) || [];
  const clips = [];
  const usedClipIds = new Set();

  // ---- pass 1: 解析条目(源区间/裁切);cut_join 的 deleted 待接头比对决定 ----
  entries.forEach((entry, idx) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`timeline entry #${idx + 1} must be an object`);
    }
    const shotId = entry.shot_id;
    const takeId = entry.take_id;
    if (typeof shotId !== 'string' || shotId.length === 0) {
      throw new Error(`timeline entry #${idx + 1} missing required shot_id`);
    }
    if (typeof takeId !== 'string' || takeId.length === 0) {
      throw new Error(`timeline entry #${idx + 1} (shot ${shotId}) missing required take_id`);
    }
    findTake(manifest, shotId, takeId); // 引用存在性校验
    const shot = shots.find(s => s && s.id === shotId) || null;
    const cutJoin = !!(shot && shot.cut_join === true);

    let sourceIn, sourceOut, conversionResiduals = null;
    const hasFrameIn = entry.source_in !== undefined && entry.source_in !== null;
    const hasFrameOut = entry.source_out !== undefined && entry.source_out !== null;
    if (hasFrameIn || hasFrameOut) {
      if (!hasFrameIn || !hasFrameOut) {
        throw new Error(`${shotId} frame-native entry must provide both source_in and source_out`);
      }
      sourceIn = requireFrame(entry.source_in, `${shotId}.source_in`);
      sourceOut = requireFrame(entry.source_out, `${shotId}.source_out`);
    } else {
      const inSec = entry.in_point === undefined || entry.in_point === null ? 0 : entry.in_point;
      let outSec = entry.out_point;
      if (outSec === undefined || outSec === null) {
        outSec = durations[shotId];
        if (outSec === undefined || outSec === null) {
          throw new Error(`${shotId} has no out_point and no known source duration (provide out_point or sourceDurations)`);
        }
      }
      const inConv = secondsToFrames(inSec, fps);
      const outConv = secondsToFrames(outSec, fps);
      sourceIn = inConv.frames;
      sourceOut = outConv.frames;
      conversionResiduals = { source_in_sec: inConv.residual, source_out_sec: outConv.residual };
    }

    if (!(sourceIn < sourceOut)) {
      throw new Error(`${shotId} source_in (${sourceIn}) must be < source_out (${sourceOut})`);
    }

    const padding = entry.padding_frames === undefined || entry.padding_frames === null
      ? 0 : entry.padding_frames;
    if (!Number.isInteger(padding) || padding < 0) {
      throw new Error(`${shotId} padding_frames must be a non-negative integer, got ${JSON.stringify(padding)}`);
    }

    // cut_join 的删除帧数由接头比对(S)决定;显式给出时作为 requested 上界输入
    const deletedProvided = entry.deleted_head_frames !== undefined && entry.deleted_head_frames !== null;
    let deleted;
    if (deletedProvided) {
      deleted = entry.deleted_head_frames;
      if (!Number.isInteger(deleted) || deleted < 0) {
        throw new Error(`${shotId} deleted_head_frames must be a non-negative integer, got ${JSON.stringify(deleted)}`);
      }
    } else {
      deleted = cutJoin ? undefined : 0;
    }

    const spillIn = normalizeSpillIn(entry.spill_in, `${shotId}.spill_in`);

    let clipId = entry.clip_id === undefined || entry.clip_id === null
      ? `clip-${String(idx + 1).padStart(4, '0')}`
      : entry.clip_id;
    if (typeof clipId !== 'string' || clipId.length === 0) {
      throw new Error(`timeline entry #${idx + 1} clip_id must be a non-empty string`);
    }
    if (usedClipIds.has(clipId)) {
      throw new Error(`duplicate clip_id ${JSON.stringify(clipId)} in timeline`);
    }
    usedClipIds.add(clipId);

    const clip = {
      clip_id: clipId,
      shot_id: shotId,
      take_id: takeId,
      source_in: sourceIn,
      source_out: sourceOut,
      deleted_head_frames: deleted,
      padding_frames: padding,
      spill_in: spillIn,
      conversion_residuals: conversionResiduals,
      cut_join: cutJoin
    };
    // §3.4/M5-AUD:clip 级 SFX cue(仅显式给出时落位,既有 fixture 不漂移)
    const sfx = normalizeSfx(entry.sfx, `${shotId}.sfx`);
    if (sfx.length > 0) clip.sfx = sfx;
    // 非 cut_join 在解析期即可完成时长校验(保持 M1 错误矩阵)
    if (!cutJoin) validateClipDuration(clip, shotId);
    clips.push(clip);
  });

  // ---- pass 2: cut_join 相邻性校验 + 截断 + 删帧 ----
  applyJunctionProcessing({ edit, manifest, clips, shots, fps, options });

  // ---- pass 2.5: §3.4 对白溢出决策（仅 v2；v1 走既有秒制路径不接入）----
  const schemaVersion = manifest && manifest.schema_version != null ? Number(manifest.schema_version) : 1;
  if (schemaVersion >= 2) {
    applyDialogueOverflow({ edit, manifest, clips, entries, shots, fps, options });
  }

  // ---- pass 3: 重算输出区间(严格连续)+ 最终校验 ----
  let cursor = 0;
  clips.forEach((clip) => {
    const durationFrames = validateClipDuration(clip, clip.shot_id);
    clip.output_start = cursor;
    clip.output_end = cursor + durationFrames;
    cursor = clip.output_end;
  });

  const result = { version: TIMELINE_VERSION, fps, clips };
  // §3.4/M5-AUD:集级 music cue（仅显式给出时落位）
  const cues = normalizeCues(edit);
  if (cues.length > 0) result.cues = cues;
  return result;
}

/**
 * 校验时间线契约。不抛错, 返回 { ok, errors }。
 * 覆盖: 唯一 clip_id、帧为整数、source_in < source_out、
 *       duration = end - start = (source_out-source_in)-deleted+padding、
 *       output 从 0 起严格连续、spill_in 结构。
 * @param {object} timeline
 * @returns {{ok:boolean, errors:string[]}}
 */
function validateTimeline(timeline) {
  if (!timeline || typeof timeline !== 'object' || Array.isArray(timeline)) {
    return { ok: false, errors: ['timeline must be an object'] };
  }
  const clips = timeline.clips;
  if (!Array.isArray(clips) || clips.length === 0) {
    return { ok: false, errors: ['timeline.clips must be a non-empty array'] };
  }
  const errors = [];
  if (!isPositiveInt(timeline.fps)) {
    errors.push(`timeline.fps must be a positive integer, got ${JSON.stringify(timeline.fps)}`);
  }
  const seenIds = new Set();
  let expectedStart = 0;
  clips.forEach((c, i) => {
    const where = `clips[${i}]`;
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      errors.push(`${where} must be an object`);
      return;
    }
    if (typeof c.clip_id !== 'string' || c.clip_id.length === 0) {
      errors.push(`${where}.clip_id must be a non-empty string`);
    } else if (seenIds.has(c.clip_id)) {
      errors.push(`duplicate clip_id ${JSON.stringify(c.clip_id)}`);
    } else {
      seenIds.add(c.clip_id);
    }

    const frameFields = ['source_in', 'source_out', 'output_start', 'output_end', 'deleted_head_frames', 'padding_frames'];
    for (const f of frameFields) {
      if (!Number.isInteger(c[f]) || c[f] < 0) {
        errors.push(`${where}.${f} must be a non-negative integer frame, got ${JSON.stringify(c[f])}`);
      }
    }

    if (!Array.isArray(c.spill_in)) {
      errors.push(`${where}.spill_in must be an array`);
    } else {
      c.spill_in.forEach((s, j) => {
        if (!s || typeof s !== 'object' || typeof s.dialogue !== 'string'
          || typeof s.ms !== 'number' || !Number.isFinite(s.ms) || s.ms < 0
          || (s.take_id !== undefined && typeof s.take_id !== 'string')) {
          errors.push(`${where}.spill_in[${j}] must be {dialogue: string, ms: finite >= 0} (optional take_id: string)`);
        }
      });
    }

    // §3.4/M5-OVF 可选字段（仅 v2 产出；缺失/ null 合法）
    if (c.dialogue !== undefined && c.dialogue !== null) {
      const d = c.dialogue;
      const okShape = typeof d === 'object' && !Array.isArray(d)
        && (d.take_id === null || typeof d.take_id === 'string')
        && (d.dialogue_ms === null || (typeof d.dialogue_ms === 'number' && Number.isFinite(d.dialogue_ms) && d.dialogue_ms >= 0))
        && typeof d.measured === 'boolean';
      if (!okShape) {
        errors.push(`${where}.dialogue must be {take_id: string|null, dialogue_ms: finite >= 0|null, measured: boolean}`);
      }
    }
    if (c.trim !== undefined && c.trim !== null) {
      const t = c.trim;
      const okTrim = typeof t === 'object' && !Array.isArray(t)
        && typeof t.dialogue_ms === 'number' && Number.isFinite(t.dialogue_ms)
        && typeof t.keep_ms === 'number' && Number.isFinite(t.keep_ms)
        && typeof t.text_truncated === 'boolean';
      if (!okTrim) errors.push(`${where}.trim must be {dialogue_ms, keep_ms, text_truncated: boolean}`);
    }
    if (c.overflow !== undefined && c.overflow !== null) {
      if (typeof c.overflow !== 'object' || Array.isArray(c.overflow) || typeof c.overflow.strategy !== 'string') {
        errors.push(`${where}.overflow must be an object with a string strategy`);
      }
    }
    if (c.dialogue_spill_ms !== undefined && c.dialogue_spill_ms !== null
      && (typeof c.dialogue_spill_ms !== 'number' || !Number.isFinite(c.dialogue_spill_ms) || c.dialogue_spill_ms < 0)) {
      errors.push(`${where}.dialogue_spill_ms must be a finite non-negative number`);
    }

    const sourceValid = Number.isInteger(c.source_in) && Number.isInteger(c.source_out);
    if (sourceValid && c.source_in >= c.source_out) {
      errors.push(`${where} source_in (${c.source_in}) must be < source_out (${c.source_out})`);
    }

    const outputValid = Number.isInteger(c.output_start) && Number.isInteger(c.output_end);
    if (outputValid) {
      const duration = c.output_end - c.output_start;
      if (duration <= 0) errors.push(`${where} duration must be > 0, got ${duration}`);
      if (sourceValid && Number.isInteger(c.deleted_head_frames) && Number.isInteger(c.padding_frames)) {
        const expectedDuration = (c.source_out - c.source_in) - c.deleted_head_frames + c.padding_frames;
        if (duration !== expectedDuration) {
          errors.push(`${where} duration ${duration} != (source_out-source_in)-deleted_head_frames+padding_frames = ${expectedDuration}`);
        }
      }
      if (c.output_start !== expectedStart) {
        errors.push(`${where}.output_start ${c.output_start} is not contiguous (expected ${expectedStart})`);
      }
      expectedStart = c.output_end;
    }
  });

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// CLI(仅此部分做 I/O / 调用 ffprobe)
// ---------------------------------------------------------------------------

/** 与 edit-episode.js 同款 ffprobe 调用方式 */
function ffprobeDuration(file) {
  try {
    const out = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file],
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }
    );
    return parseFloat(out.trim()) || 0;
  } catch { return 0; }
}

function main() {
  const args = process.argv.slice(2);
  const episodeDir = args[0];
  const outIdx = args.indexOf('--out');
  const customOut = outIdx >= 0 ? args[outIdx + 1] : null;
  const dryRun = args.includes('--dry-run');

  if (!episodeDir) {
    console.error('Usage: node tools/build-timeline.js <episode-dir> [--out <path>] [--dry-run]');
    process.exit(1);
  }
  const absEpDir = path.isAbsolute(episodeDir) ? episodeDir : path.resolve(episodeDir);

  let edit;
  try {
    edit = yaml.load(fs.readFileSync(path.join(absEpDir, 'edit.yaml'), 'utf8'));
  } catch {
    console.error(`edit.yaml not found in ${absEpDir}`);
    process.exit(2);
  }

  let manifest;
  try {
    manifest = readJsonFile(path.join(absEpDir, 'manifest.json'), { label: 'manifest.json' });
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(2);
  }

  // 秒制条目缺 out_point → ffprobe 该条目的 take(仅 CLI)
  const entries = extractTimelineEntries(edit) || [];
  const shotsById = new Map(((manifest && manifest.shots) || []).map(s => [s && s.id, s]));
  const sourceDurations = {};
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.source_in !== undefined && entry.source_in !== null) continue;
    if (entry.source_out !== undefined && entry.source_out !== null) continue;
    if (entry.out_point !== undefined && entry.out_point !== null) continue;
    const shot = shotsById.get(entry.shot_id);
    const take = shot && (shot.takes || []).find(t => t && t.id === entry.take_id);
    if (!take || !take.path || !fs.existsSync(take.path)) continue; // buildTimeline 会给出明确错误
    const dur = ffprobeDuration(take.path);
    if (dur > 0) sourceDurations[entry.shot_id] = dur;
  }

  let timeline;
  try {
    timeline = buildTimeline({
      edit, manifest, sourceDurations,
      options: { epDir: absEpDir, manifestPath: path.join(absEpDir, 'manifest.json'), warn: (m) => console.warn(m) }
    });
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(3);
  }

  const validation = validateTimeline(timeline);
  if (!validation.ok) {
    console.error('ERROR: timeline validation failed:');
    for (const e of validation.errors) console.error(`  ${e}`);
    process.exit(4);
  }

  const json = JSON.stringify(timeline, null, 2);

  if (dryRun) {
    console.log(json);
    return;
  }

  const outPath = customOut
    ? (path.isAbsolute(customOut) ? customOut : path.resolve(customOut))
    : path.join(absEpDir, 'timeline.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  atomicWriteJson(outPath, timeline);
  console.log(`timeline written: ${outPath}`);
  console.log(`  fps: ${timeline.fps}`);
  console.log(`  clips: ${timeline.clips.length}`);
  console.log(`  total frames: ${timeline.clips[timeline.clips.length - 1].output_end}`);
}

module.exports = {
  DEFAULT_FPS, TIMELINE_VERSION,
  resolveTimelineFps, secondsToFrames, msToFrames, buildTimeline, validateTimeline,
  resolveJunctionOffsetFrames,
  // §3.4/M5-OVF 溢出策略纯函数（转发 dialogue.js，便于单测与 gate 复用）
  selectDialogueTake, resolveDialogueTiming, overflowFrames, decideOverflow,
  clipOutputFrames, checkSpillConstraints, trimDialogue, collectUnresolvedOverflow
};

if (require.main === module) {
  main();
}
