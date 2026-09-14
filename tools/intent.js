#!/usr/bin/env node
/**
 * intent.js — PRD §4 制作意图声明与配置校验（M5a）
 *
 * 「豁免由制作意图声明决定，不由输出缺什么决定」（PRD §4，写死）。
 * 本模块只做纯函数：从 script/edit 推导 intent、校验矛盾声明、计算 Release Gate 标志位。
 * 无 I/O、无副作用；值域非法只由 validateIntent 报错（deriveIntent 不抛错）。
 *
 * 声明来源优先级（逐字段合并，edit 胜）：
 *   edit.intent  →  edit.timeline.intent  →  script.intent  →  派生
 *
 * 派生规则（写死，绝不产出 audio='none'）：
 *   dialogue = detectDialogue(script)
 *   audio    = dialogue ? 'dialogue' : 'music_sfx'
 *   subtitles = 'none'
 *   silent    = false
 */
'use strict';

const AUDIO_VALUES = ['none', 'dialogue', 'music_sfx', 'full'];
const SUBTITLE_VALUES = ['none', 'burn', 'soft', 'both'];
const INTENT_FIELDS = ['dialogue', 'audio', 'subtitles', 'silent'];

function hasOwn(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * 单个 dialogue 值是否含有效对白。兼容形态：
 *   - 非空字符串（纯空白视为无）
 *   - 数组（元素为非空字符串 / {text} / 嵌套数组）
 *   - {lines: [...]}（递归同一规则）
 *   - {text: '...'}
 * @param {*} value
 * @returns {boolean}
 */
function dialogueValuePresent(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(dialogueValuePresent);
  if (typeof value === 'object') {
    if (hasOwn(value, 'lines')) return dialogueValuePresent(value.lines);
    if (hasOwn(value, 'text')) return typeof value.text === 'string' && value.text.trim().length > 0;
  }
  return false;
}

/**
 * script 任一 scene.shot 有非空 dialogue → true。
 * @param {object} script
 * @returns {boolean}
 */
function detectDialogue(script) {
  for (const scene of ((script && script.scenes) || [])) {
    for (const shot of ((scene && scene.shots) || [])) {
      if (dialogueValuePresent(shot && shot.dialogue)) return true;
    }
  }
  return false;
}

/**
 * 解析单个字段的显式来源。null/undefined 视为未声明。
 * @returns {{value:*, source:'edit'|'script'|'derived'}}
 */
function explicitIntentValue(edit, script, field) {
  const editIntent = (edit && typeof edit.intent === 'object' && edit.intent) || null;
  if (editIntent && hasOwn(editIntent, field) && editIntent[field] != null) {
    return { value: editIntent[field], source: 'edit' };
  }
  const timeline = edit && edit.timeline;
  const timelineIntent = (timeline && typeof timeline === 'object' && !Array.isArray(timeline)
    && typeof timeline.intent === 'object' && timeline.intent) || null;
  if (timelineIntent && hasOwn(timelineIntent, field) && timelineIntent[field] != null) {
    return { value: timelineIntent[field], source: 'edit' };
  }
  const scriptIntent = (script && typeof script.intent === 'object' && script.intent) || null;
  if (scriptIntent && hasOwn(scriptIntent, field) && scriptIntent[field] != null) {
    return { value: scriptIntent[field], source: 'script' };
  }
  return { value: undefined, source: 'derived' };
}

/**
 * 推导制作意图（不抛错；值域非法留给 validateIntent）。
 * @param {object} script script.yaml 对象
 * @param {{edit?:object}} [opts] edit.yaml 对象（可选）
 * @returns {{dialogue:*,audio:*,subtitles:*,silent:*,declared:object,sources:object}}
 */
function deriveIntent(script, { edit } = {}) {
  const detected = detectDialogue(script);
  const derived = {
    dialogue: detected,
    audio: detected ? 'dialogue' : 'music_sfx', // 派生绝不产出 'none'
    subtitles: 'none',
    silent: false,
  };

  const values = {};
  const declared = {};
  const sources = {};
  for (const field of INTENT_FIELDS) {
    const explicit = explicitIntentValue(edit, script, field);
    if (explicit.source === 'derived') {
      values[field] = derived[field];
      declared[field] = false;
      sources[field] = 'derived';
    } else {
      values[field] = explicit.value;
      declared[field] = true;
      sources[field] = explicit.source;
    }
  }

  return {
    dialogue: values.dialogue,
    audio: values.audio,
    subtitles: values.subtitles,
    silent: values.silent,
    declared,
    sources,
  };
}

/**
 * 校验 intent 的值域与矛盾组合。
 * @param {object} intent
 * @returns {{ok:boolean, errors:string[], normalized:object}}
 *   normalized 保留原值（含 audio='none' && silent=true 时 silent 保持 true），
 *   仅在 audio='none' && silent=true 时附加 redundant=['silent']（仅标注冗余）。
 */
function validateIntent(intent) {
  const errors = [];
  const src = intent || {};
  const declared = src.declared || {};
  const normalized = Object.assign({}, src);
  delete normalized.redundant;

  const { dialogue, audio, subtitles, silent } = src;
  const dialogueOk = typeof dialogue === 'boolean';
  const silentOk = typeof silent === 'boolean';

  // 值域
  if (!dialogueOk) errors.push(`intent.dialogue must be a boolean, got ${JSON.stringify(dialogue)}`);
  if (!silentOk) errors.push(`intent.silent must be a boolean, got ${JSON.stringify(silent)}`);
  if (!AUDIO_VALUES.includes(audio)) {
    errors.push(`intent.audio must be one of ${AUDIO_VALUES.join(' | ')}, got ${JSON.stringify(audio)}`);
  }
  if (!SUBTITLE_VALUES.includes(subtitles)) {
    errors.push(`intent.subtitles must be one of ${SUBTITLE_VALUES.join(' | ')}, got ${JSON.stringify(subtitles)}`);
  }

  // 非法组合（PRD §4 写死）
  if (dialogueOk && dialogue === true) {
    if (audio === 'none') {
      errors.push("intent.dialogue=true conflicts with intent.audio='none' (§4: dialogue requires audio output)");
    }
    if (silentOk && silent === true) {
      errors.push('intent.dialogue=true conflicts with intent.silent=true (§4: dialogue must not declare silent)');
    }
    if (subtitles === 'none') {
      errors.push("intent.subtitles='none' conflicts with intent.dialogue=true (§4: dialogue requires subtitles; remove dialogue from the script first)");
    }
  }

  // audio='none' 必须显式声明（不可由派生得到）
  if (audio === 'none' && !declared.audio) {
    errors.push('intent.audio: none must be explicitly declared (§4: audio=none is never derived)');
  }

  // 合法冗余：audio='none' && silent=true → 保留 silent=true，仅标注冗余
  if (audio === 'none' && silentOk && silent === true) {
    normalized.redundant = ['silent'];
  }

  return { ok: errors.length === 0, errors, normalized };
}

/**
 * Release Gate 标志位（公式写死，PRD §4/§5）。
 * @param {object} intent
 * @returns {{requires_subtitles:boolean,requires_audio:boolean,requires_loudnorm:boolean,subtitle_exemption:boolean,audio_exemption:boolean}}
 */
function intentFlags(intent) {
  const src = intent || {};
  const requiresSubtitles = !!src.dialogue || src.subtitles !== 'none';
  const requiresAudio = src.audio !== 'none';
  const requiresLoudnorm = requiresAudio && src.silent !== true;
  return {
    requires_subtitles: requiresSubtitles,
    requires_audio: requiresAudio,
    requires_loudnorm: requiresLoudnorm,
    subtitle_exemption: !requiresSubtitles,
    audio_exemption: !requiresAudio,
  };
}

/**
 * §4 声明与事实一致性:声明 dialogue=false 但脚本实际存在对白 → 错误。
 * 反向(dialogue=true 且无对白)不报错——避免破坏既有无对白 fixture。
 * @param {object} intent 已合并/派生的 intent
 * @param {{hasDialogue:boolean}} facts
 * @returns {{ok:boolean, errors:string[]}}
 */
function checkDialogueDeclaration(intent, { hasDialogue } = {}) {
  const errors = [];
  const declared = intent ? intent.dialogue : undefined;
  if (declared === false && hasDialogue === true) {
    errors.push("intent.dialogue=false but the script declares real dialogue — a false declaration must not hide dialogue from the release gate (§4): declare dialogue: true, or remove the dialogue from the script");
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  AUDIO_VALUES,
  SUBTITLE_VALUES,
  detectDialogue,
  deriveIntent,
  validateIntent,
  checkDialogueDeclaration,
  intentFlags,
};
