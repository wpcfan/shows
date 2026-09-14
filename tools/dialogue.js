#!/usr/bin/env node
/**
 * dialogue.js — PRD v2.13 §3.4 时长四量与溢出策略（M5-OVF，TECH-DEBT A3）
 *
 * 纯函数模块（无 I/O、无副作用），只产出**帧级决策与标记**；音频截断 / 混音 /
 * loudnorm 属下一批（M5-AUD），本模块不调用 ffmpeg、不读写任何文件。
 *
 * 职责：
 *   - resolveDialogueTiming({shot, ttsTake, fps})  TTS 实测对白时长 → 毫秒/帧（缺失即 measured:false）
 *   - overflowFrames(dialogueMs, outputDurationFrames, fps)  溢出帧数（向上进位，绝不向下溢出）
 *   - decideOverflow({...})  溢出策略优先级（none → pad_freeze → trim → dialogue_spill → error）
 *   - checkSpillConstraints({clip, nextClip, overflowFrames, fps})  §3.4 spill 五条约束
 *   - trimDialogue({text, dialogueMs, keepMs})  对白尾部截断（标点断句优先 + `…`）
 *   - collectUnresolvedOverflow(timeline, {intent})  Final Release Gate #6 的问题收集
 *
 * 硬约束（写死）：
 *   - 「字数估时」仅预警，绝不参与溢出判定；缺失实测一律 `measured:false`，
 *     不得用估时冒充实测（估时实现保持 build-manifest.estimateDialogueSeconds 单一来源）。
 *   - `allow_trim` 默认 false（禁止默认自动删对白）；`max_freeze_padding_frames` 默认 0（默认禁止静帧补长）。
 *   - 一律按 clip 实例的 output 帧位计算，不按原始 take 时长累加（§3.6）。
 */
'use strict';
const { intentFlags } = require('./intent');

/** 断句首选标点（中英文混排，§3.4 trim 语义） */
const TRIM_BREAK_CHARS = new Set([
  '，', '。', '！', '？', '；', '、', '：',
  ',', '.', '!', '?', ';', ':',
  '）', ')', '】', ']', '…', '—', '～', '~',
]);

function isPositiveNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function isNonNegNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * 取 shot 的可用 TTS take：`selected_tts` 优先（须非 rejected），否则首个非 rejected。
 * @param {object} shot
 * @returns {object|null}
 */
function selectDialogueTake(shot) {
  if (!shot) return null;
  const takes = Array.isArray(shot.tts_takes) ? shot.tts_takes : [];
  const usable = takes.filter(t => t && t.status !== 'rejected');
  if (shot.selected_tts) {
    const selected = usable.find(t => t.id === shot.selected_tts);
    if (selected) return selected;
  }
  return usable[0] || null;
}

/**
 * 解析 clip 的对白实测四量（对话时长侧）。不抛错；无实测一律 measured:false。
 * @param {{shot?:object, ttsTake?:object|null, fps:number}} args
 *   ttsTake 省略时按 shot.selected_tts / 首个非 rejected 选取；显式 null → 视为无 take。
 * @returns {{dialogue_ms:number|null, dialogue_frames:number|null, tts_take_id:string|null, measured:boolean}}
 */
function resolveDialogueTiming({ shot, ttsTake, fps } = {}) {
  if (!isPositiveNumber(fps)) {
    throw new Error(`fps must be a positive number, got ${JSON.stringify(fps)}`);
  }
  const take = ttsTake === undefined ? selectDialogueTake(shot) : ttsTake;
  if (!take || take.status === 'rejected') {
    const id = take && typeof take.id === 'string' ? take.id : null;
    return { dialogue_ms: null, dialogue_frames: null, tts_take_id: id, measured: false };
  }
  const id = typeof take.id === 'string' ? take.id : null;
  if (!isNonNegNumber(take.duration_sec)) {
    return { dialogue_ms: null, dialogue_frames: null, tts_take_id: id, measured: false };
  }
  const dialogueMs = Math.round(take.duration_sec * 1000);
  return {
    dialogue_ms: dialogueMs,
    dialogue_frames: Math.round((dialogueMs * fps) / 1000),
    tts_take_id: id,
    measured: true,
  };
}

/**
 * 溢出帧数 = max(0, ceil(dialogueMs / 1000 * fps) - outputDurationFrames)。
 * 取上整（毫秒进位）；输出足够大时为 0（绝不向下溢出）。
 * @param {number} dialogueMs
 * @param {number} outputDurationFrames
 * @param {number} fps
 * @returns {number} 非负整数帧数
 */
function overflowFrames(dialogueMs, outputDurationFrames, fps) {
  if (!isNonNegNumber(dialogueMs)) {
    throw new Error(`dialogueMs must be a finite non-negative number, got ${JSON.stringify(dialogueMs)}`);
  }
  if (!Number.isInteger(outputDurationFrames) || outputDurationFrames < 0) {
    throw new Error(`outputDurationFrames must be a non-negative integer, got ${JSON.stringify(outputDurationFrames)}`);
  }
  if (!isPositiveNumber(fps)) {
    throw new Error(`fps must be a positive number, got ${JSON.stringify(fps)}`);
  }
  const needed = Math.ceil((dialogueMs / 1000) * fps);
  return Math.max(0, needed - outputDurationFrames);
}

/**
 * §3.4 溢出策略决策（优先级写死）。
 *   1. none            无溢出
 *   2. pad_freeze      溢出 ≤ max_freeze_padding_frames（默认 0 → 不生效）
 *   3. trim            仅 allow_trim === true
 *   4. dialogue_spill  仅 spill.ok
 *   5. error           以上均不适用（reason 列明否决原因）
 * @param {{overflowFrames:number, allowTrim?:boolean, maxFreezePaddingFrames?:number, spill?:{ok:boolean,reason?:string}}} args
 * @returns {{strategy:'none'|'pad_freeze'|'trim'|'dialogue_spill'|'error', padding_frames?:number, reason?:string}}
 */
function decideOverflow({ overflowFrames: ovf, allowTrim = false, maxFreezePaddingFrames = 0, spill = null } = {}) {
  if (!Number.isInteger(ovf) || ovf < 0) {
    throw new Error(`overflowFrames must be a non-negative integer, got ${JSON.stringify(ovf)}`);
  }
  if (!Number.isInteger(maxFreezePaddingFrames) || maxFreezePaddingFrames < 0) {
    throw new Error(`maxFreezePaddingFrames must be a non-negative integer, got ${JSON.stringify(maxFreezePaddingFrames)}`);
  }
  if (ovf === 0) return { strategy: 'none' };

  if (ovf <= maxFreezePaddingFrames) {
    return { strategy: 'pad_freeze', padding_frames: ovf };
  }
  const reasons = [`pad_freeze unavailable: overflow ${ovf} frame(s) > max_freeze_padding_frames ${maxFreezePaddingFrames}`];

  if (allowTrim === true) return { strategy: 'trim' };
  reasons.push('trim unavailable: allow_trim=false');

  if (spill && spill.ok) return { strategy: 'dialogue_spill' };
  reasons.push(`dialogue_spill unavailable: ${(spill && spill.reason) || 'no spill assessment provided'}`);

  return { strategy: 'error', reason: reasons.join('; ') };
}

/** clip 实例的实际输出时长（帧）：优先 output 区间，其次 output 时长公式（§3.6） */
function clipOutputFrames(clip) {
  if (!clip) return null;
  if (Number.isInteger(clip.output_end) && Number.isInteger(clip.output_start)) {
    return clip.output_end - clip.output_start;
  }
  if (Number.isInteger(clip.source_in) && Number.isInteger(clip.source_out)
    && Number.isInteger(clip.deleted_head_frames) && Number.isInteger(clip.padding_frames)) {
    return clip.source_out - clip.source_in - clip.deleted_head_frames + clip.padding_frames;
  }
  return null;
}

/**
 * §3.4 dialogue_spill 约束（五条，全部按 clip 实例 output 帧位）。
 *   1. 下一 clip 实例必须存在；
 *   2. 其 dialogue 为空；
 *   3. spill ≤ 该 clip 实际输出时长；
 *   4. spill 起点（= 上游 clip output_end）不得落在 cut_join 接头帧；
 *   5. 同一 clip 只能 spill 一次（已记 dialogue_spill_ms → 拒绝，禁止链式）。
 * @param {{clip:object, nextClip?:object|null, overflowFrames:number, fps:number}} args
 * @returns {{ok:boolean, reason?:string}}
 */
function checkSpillConstraints({ clip, nextClip, overflowFrames: ovf, fps: _fps } = {}) {
  if (!clip) return { ok: false, reason: 'upstream clip is missing' };
  if (!Number.isInteger(ovf) || ovf <= 0) {
    return { ok: false, reason: `overflowFrames must be a positive integer, got ${JSON.stringify(ovf)}` };
  }
  const where = `clip ${(clip && clip.clip_id) || '(unknown)'}`;

  if (clip.dialogue_spill_ms !== undefined && clip.dialogue_spill_ms !== null) {
    return { ok: false, reason: `${where} already has dialogue_spill_ms — a clip may spill at most once (no chained spill)` };
  }
  if (clip.cut_join === true) {
    return { ok: false, reason: `${where} is a cut_join clip — the spill start lands on a junction frame` };
  }
  if (!nextClip) {
    return { ok: false, reason: `${where} has no next clip instance in the final timeline (dialogue_spill requires a following clip)` };
  }
  if (nextClip.cut_join === true) {
    return { ok: false, reason: `next clip ${(nextClip && nextClip.clip_id) || '(unknown)'} is a cut_join clip — the spill start lands on a junction frame` };
  }
  if (nextClip.dialogue) {
    return { ok: false, reason: `next clip ${(nextClip && nextClip.clip_id) || '(unknown)'} has non-empty dialogue — dialogue_spill requires a dialogue-free next clip` };
  }
  const nextFrames = clipOutputFrames(nextClip);
  if (!(Number.isInteger(nextFrames) && nextFrames > 0)) {
    return { ok: false, reason: `cannot determine next clip ${(nextClip && nextClip.clip_id) || '(unknown)'} output duration` };
  }
  if (ovf > nextFrames) {
    return { ok: false, reason: `spill ${ovf} frame(s) exceeds next clip ${(nextClip && nextClip.clip_id) || '(unknown)'} output duration ${nextFrames} frame(s)` };
  }
  return { ok: true };
}

/**
 * §3.4 trim：对白从**尾部**截断，字幕同步截断并加 `…`。
 *   - keepMs >= dialogueMs → 原文不截断；
 *   - 否则按比例保留字符，优先在标点处断句，找不到再硬切；
 *   - 结果去尾空白并追加 `…`（已含 `…` 不重复）；
 *   - 空文本 → {text:'', truncated:false}。
 * @param {{text?:string, dialogueMs:number, keepMs:number}} args
 * @returns {{text:string, truncated:boolean}}
 */
function trimDialogue({ text, dialogueMs, keepMs } = {}) {
  const raw = text == null ? '' : String(text);
  if (raw.length === 0) return { text: '', truncated: false };
  if (!isPositiveNumber(dialogueMs)) return { text: raw, truncated: false };
  if (!isNonNegNumber(keepMs) || keepMs >= dialogueMs) return { text: raw, truncated: false };

  const ratio = keepMs / dialogueMs;
  const keepChars = Math.max(0, Math.floor(raw.length * ratio));
  const head = raw.slice(0, keepChars);

  let cutIdx = -1;
  for (let i = head.length - 1; i >= 0; i--) {
    if (TRIM_BREAK_CHARS.has(head[i])) { cutIdx = i; break; }
  }
  const cut = cutIdx >= 0 ? head.slice(0, cutIdx + 1) : head;

  let out = cut.replace(/\s+$/, '');
  if (!out.endsWith('…')) out += '…';
  return { text: out, truncated: true };
}

/**
 * 收集 final 前的未解决对白溢出问题（Final Release Gate #6 的唯一数据源）。
 *
 * 判定（PRD §5 第 6 行）：
 *   - `intentFlags(intent).requires_audio === false` → `[]`（不适用分支由 gate 处理）；
 *   - 有对白但 `dialogue.measured === false` → problem（不得用估时冒充实测）；
 *   - `overflow.strategy === 'error'` 或未落地（无 pad/trim/spill 且重算仍有溢出）→ problem；
 *   - spill 痕迹被破坏（`spill_in` 且下游 dialogue 非空 / spill 超下游输出 / 落在接头）→ problem；
 *   - 未声明 `intent.dialogue === false` 但 clip 仍有 dialogue → problem（矩阵第 6 行）。
 * @param {object} timeline
 * @param {{intent?:object}} [opts]
 * @returns {string[]}
 */
function collectUnresolvedOverflow(timeline, { intent } = {}) {
  const flags = intentFlags(intent);
  if (!flags.requires_audio) return [];

  const clips = timeline && Array.isArray(timeline.clips) ? timeline.clips : [];
  const fps = timeline && timeline.fps;
  if (!clips.length || !isPositiveNumber(fps)) return [];

  const dialogueNotDeclared = !!intent && intent.dialogue === false;
  const problems = [];

  clips.forEach((clip, i) => {
    if (!clip || typeof clip !== 'object') return;
    const where = `clip ${clip.clip_id || `clips[${i}]`}`;
    const hasDialogue = !!clip.dialogue;

    if (hasDialogue && dialogueNotDeclared) {
      problems.push(`${where}: dialogue present in the timeline but intent.dialogue=false — declare dialogue or remove the dialogue (§5 #6)`);
    }

    if (hasDialogue && clip.dialogue.measured === false) {
      problems.push(`${where}: dialogue present but no measured TTS take (dialogue.measured=false) — run TTS and select a take before final (§3.4)`);
    }

    if (clip.overflow && clip.overflow.strategy === 'error') {
      problems.push(`${where}: dialogue overflow marked error (${clip.overflow.reason || 'unresolved'}) — fix the script/edit (§3.4)`);
    }

    const spilled = isNonNegNumber(clip.dialogue_spill_ms) && clip.dialogue_spill_ms > 0;
    const trimmed = !!clip.trim;

    // 重算未落地（无 pad/trim/spill）的溢出
    if (hasDialogue && !spilled && !trimmed
      && isNonNegNumber(clip.dialogue.dialogue_ms)) {
      const outputFrames = clipOutputFrames(clip);
      if (Number.isInteger(outputFrames) && outputFrames > 0) {
        const ovf = overflowFrames(clip.dialogue.dialogue_ms, outputFrames, fps);
        if (ovf > 0) {
          problems.push(`${where}: dialogue overflow ${ovf} frame(s) unresolved (${clip.dialogue.dialogue_ms}ms > ${outputFrames} output frames @ ${fps}fps) — apply pad_freeze/trim/dialogue_spill (§3.4)`);
        }
      }
    }

    // spill 痕迹约束复核（下游必须无对白）
    if (Array.isArray(clip.spill_in) && clip.spill_in.length > 0) {
      if (hasDialogue) {
        problems.push(`${where}: spill_in present but the downstream clip has dialogue — dialogue_spill requires a dialogue-free next clip (§3.4)`);
      }
      const outputFrames = clipOutputFrames(clip);
      const maxMs = Number.isInteger(outputFrames) && outputFrames > 0 ? (outputFrames * 1000) / fps : null;
      if (maxMs !== null) {
        for (const s of clip.spill_in) {
          if (s && isNonNegNumber(s.ms) && s.ms > maxMs + 1e-9) {
            problems.push(`${where}: spill_in ${s.ms}ms exceeds the clip output duration ${Math.round(maxMs)}ms (§3.4)`);
          }
        }
      }
    }

    if (spilled) {
      const next = clips[i + 1] || null;
      const spillFrames = Math.round((clip.dialogue_spill_ms / 1000) * fps);
      if (!next) {
        problems.push(`${where}: dialogue_spill recorded but no next clip instance exists in the final timeline (§3.4)`);
      } else {
        if (next.dialogue) {
          problems.push(`${where}: dialogue spills into clip ${next.clip_id || `clips[${i + 1}]`} which has non-empty dialogue (§3.4)`);
        }
        const nextFrames = clipOutputFrames(next);
        if (Number.isInteger(nextFrames) && nextFrames > 0 && spillFrames > nextFrames) {
          problems.push(`${where}: dialogue_spill ${spillFrames} frame(s) exceeds next clip output duration ${nextFrames} frame(s) (§3.4)`);
        }
      }
      if (clip.cut_join === true) {
        problems.push(`${where}: dialogue_spill starts on a cut_join junction frame (§3.4)`);
      }
    }
  });

  return problems;
}

module.exports = {
  TRIM_BREAK_CHARS,
  selectDialogueTake,
  resolveDialogueTiming,
  overflowFrames,
  decideOverflow,
  clipOutputFrames,
  checkSpillConstraints,
  trimDialogue,
  collectUnresolvedOverflow,
};
