#!/usr/bin/env node
/**
 * validate-script.js — 零成本剧本校验(零写盘 / 零网络 / 零 credits)
 *
 * 用法:
 *   node tools/validate-script.js <script.yaml | episode-dir> [--json] [--build] [--timeline]
 *
 * 行为:
 *   - 默认纯校验:只读输入 + 同目录 edit.yaml(可选)+ 仓库 series.yaml,不写任何文件。
 *   - 传入 episode-dir 时自动取其中 script.yaml。
 *   - `--build`:纯校验通过后 spawn `node tools/build-manifest.js <episode-dir>` 并透传退出码/输出
 *     (manifest.json 写在被校验目录内,属预期;draft 目录 OK)。校验失败则绝不 build。
 *   - `--timeline`:`--build` 之后若同目录存在 edit.yaml,再 spawn `build-timeline` CLI 透传。
 *
 * 错误 → exit 4;警告只打印,不影响 exit 0。
 *
 * 复用的纯函数(build-manifest / intent / probe):
 *   validateContinueFrom / normalizeDialogue / resolveVoiceId / resolveTtsConfig /
 *   estimateDialogueSeconds / resolveEpisodeRatio / deriveIntent / validateIntent /
 *   checkDialogueDeclaration / detectDialogue / probe.expectedVideoSpec
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadYaml, ROOT } = require('./build-prompt');
const {
  validateContinueFrom, normalizeDialogue, resolveVoiceId, resolveTtsConfig,
  missingTtsProviderFields, estimateDialogueSeconds, resolveEpisodeRatio,
} = require('./build-manifest');
const { deriveIntent, validateIntent, checkDialogueDeclaration, detectDialogue } = require('./intent');
const { expectedVideoSpec } = require('./probe');

const MAX_SHOT_DURATION = 30;
const DEFAULT_SHOT_DURATION = 8;
const DEFAULT_RESOLUTION = '720p';
const EXIT_ERROR = 4;

function isPositiveInt(v) {
  return Number.isInteger(v) && v > 0;
}

/** ratio/resolution 支持性:复用 probe.expectedVideoSpec 的映射并捕获其抛错 */
function checkVideoSpec(ratio, resolution, where, errors) {
  try {
    expectedVideoSpec({ template: { ratio, resolution } });
  } catch (e) {
    errors.push(`${where}: ${e.message}`);
  }
}

/**
 * 纯校验(无 I/O、不写盘)。脚本对象 → 结构化结果。
 * @param {object} script YAML 解析后的 script 对象
 * @param {{edit?:object|null, series?:object|null, label?:string}} [options]
 * @returns {{ok:boolean, errors:string[], warnings:string[], stats:{shots:number, estimated_seconds:number, dialogue_shots:number}}}
 */
function validateScriptObject(script, options = {}) {
  const edit = options.edit || null;
  const series = options.series || null;
  const label = options.label || 'script.yaml';
  const errors = [];
  const warnings = [];
  const stats = { shots: 0, estimated_seconds: 0, dialogue_shots: 0 };

  if (!script || typeof script !== 'object' || Array.isArray(script)) {
    errors.push(`${label}: must be a YAML mapping (object), got ${Array.isArray(script) ? 'array' : typeof script}`);
    return { ok: false, errors, warnings, stats };
  }

  for (const field of ['episode', 'title', 'schema_version', 'defaults']) {
    const v = script[field];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
      errors.push(`${label}: missing required field '${field}'`);
    }
  }
  if (script.defaults !== undefined && script.defaults !== null
    && (typeof script.defaults !== 'object' || Array.isArray(script.defaults))) {
    errors.push(`${label}: 'defaults' must be an object`);
  }

  if (!Array.isArray(script.scenes) || script.scenes.length === 0) {
    errors.push(`${label}: 'scenes' must be a non-empty list`);
    return { ok: errors.length === 0, errors, warnings, stats };
  }

  const defaults = (script.defaults && typeof script.defaults === 'object' && !Array.isArray(script.defaults))
    ? script.defaults : {};
  const seriesDefaults = (series && series.seedance_defaults) || {};
  const episodeRatio = resolveEpisodeRatio(script, series);
  const episodeResolution = defaults.resolution || seriesDefaults.resolution || DEFAULT_RESOLUTION;
  checkVideoSpec(episodeRatio, episodeResolution, label, errors);

  const ttsConfig = resolveTtsConfig(script, series);

  const sceneIds = new Set();
  const shotIds = new Set();
  const cfList = [];

  for (let si = 0; si < script.scenes.length; si++) {
    const scene = script.scenes[si];
    if (!scene || typeof scene !== 'object' || Array.isArray(scene)) {
      errors.push(`scenes[${si}]: must be an object`);
      continue;
    }
    const sceneId = scene.id;
    if (sceneId === undefined || sceneId === null || sceneId === '') {
      errors.push(`scenes[${si}]: missing scene id`);
    } else if (sceneIds.has(sceneId)) {
      errors.push(`scene ${sceneId}: duplicate scene id (scenes[${si}])`);
    } else {
      sceneIds.add(sceneId);
    }
    const sceneWhere = sceneId !== undefined && sceneId !== null && sceneId !== ''
      ? `scene ${sceneId}` : `scenes[${si}]`;

    if (!Array.isArray(scene.shots) || scene.shots.length === 0) {
      warnings.push(`${sceneWhere}: has no shots`);
      continue;
    }

    for (let sj = 0; sj < scene.shots.length; sj++) {
      const shot = scene.shots[sj];
      if (!shot || typeof shot !== 'object' || Array.isArray(shot)) {
        errors.push(`${sceneWhere}.shots[${sj}]: must be an object`);
        continue;
      }
      stats.shots += 1;
      const hasId = shot.id !== undefined && shot.id !== null && shot.id !== '';
      const shotWhere = hasId ? `shot ${shot.id}` : `${sceneWhere}.shots[${sj}]`;

      if (!hasId) {
        errors.push(`${shotWhere}: missing shot id`);
      } else if (shotIds.has(shot.id)) {
        errors.push(`shot ${shot.id}: duplicate shot id`);
      } else {
        shotIds.add(shot.id);
      }

      if (!shot.prompt_en || !String(shot.prompt_en).trim()) {
        errors.push(`${shotWhere}: missing prompt_en`);
      }
      if (!shot.style_en || !String(shot.style_en).trim()) {
        errors.push(`${shotWhere}: missing style_en`);
      }
      if (!shot.description_cn || !String(shot.description_cn).trim()) {
        warnings.push(`${shotWhere}: missing description_cn`);
      }

      // duration:非正整数 → 错误;> 30s → 警告
      const rawDur = shot.duration;
      let duration = defaults.duration;
      if (rawDur !== undefined && rawDur !== null) {
        if (!isPositiveInt(rawDur)) {
          errors.push(`${shotWhere}.duration must be a positive integer, got ${JSON.stringify(rawDur)}`);
        } else {
          duration = rawDur;
          if (rawDur > MAX_SHOT_DURATION) {
            warnings.push(`${shotWhere}.duration ${rawDur}s exceeds ${MAX_SHOT_DURATION}s (long shot — verify it is intentional)`);
          }
        }
      }
      if (!isPositiveInt(duration)) duration = DEFAULT_SHOT_DURATION;
      stats.estimated_seconds += duration;

      // shot 级 ratio:与集级不一致且未 allow_mixed_ratio → 错误
      if (shot.ratio && shot.ratio !== episodeRatio && script.allow_mixed_ratio !== true) {
        errors.push(`${shotWhere}: shot-level ratio '${shot.ratio}' != episode ratio '${episodeRatio}' (set allow_mixed_ratio: true to opt in)`);
      }
      // 支持性(集级已查;shot 覆盖时单独查)
      if (shot.ratio || shot.resolution) {
        checkVideoSpec(shot.ratio || episodeRatio, shot.resolution || episodeResolution, shotWhere, errors);
      }

      // continue_from 校验三件套(纯函数);其错误消息已含 shot id
      cfList.push({ id: hasId ? shot.id : `${sceneWhere}.shots[${sj}]`, continue_from: shot.continue_from });

      // 对白:voice / provider / 估时
      const dialogue = normalizeDialogue(shot);
      if (dialogue) {
        stats.dialogue_shots += 1;
        const voice = resolveVoiceId({ dialogue, shot, scene, script, series });
        if (!voice.voiceId) {
          errors.push(`${shotWhere}: dialogue present but no voice_id could be resolved — checked ${voice.checked.join(' > ')}`);
        }
        const missing = missingTtsProviderFields(ttsConfig.provider);
        if (missing.length) {
          errors.push(`${shotWhere}: tts provider is missing required field(s): ${missing.join(', ')} (source: ${ttsConfig.providerSource})`);
        }
        const est = estimateDialogueSeconds(dialogue.text, { charsPerSecond: ttsConfig.charsPerSecond });
        if (est > duration) {
          warnings.push(`${shotWhere}: dialogue estimate ${est.toFixed(2)}s exceeds shot duration ${duration}s (chars_per_second=${ttsConfig.charsPerSecond})`);
        }
      }
    }
  }

  for (const e of validateContinueFrom(cfList).errors) errors.push(e);

  // intent 声明(§4):派生 + 值域/矛盾校验 + FIX5b dialogue=false 一致性
  const intent = deriveIntent(script, { edit });
  for (const e of validateIntent(intent).errors) errors.push(e);
  const hasDialogue = detectDialogue(script);
  for (const e of checkDialogueDeclaration(intent, { hasDialogue }).errors) errors.push(e);
  if (intent.dialogue === true && !hasDialogue) {
    warnings.push("intent.dialogue=true but the script has no dialogue (declare dialogue: true only when dialogue exists)");
  }

  return { ok: errors.length === 0, errors, warnings, stats };
}

/** 把 CLI 输入解析为 { scriptPath, episodeDir, label } */
function resolveInput(input) {
  const abs = path.isAbsolute(input) ? input : path.resolve(input);
  let stat = null;
  try { stat = fs.statSync(abs); } catch { stat = null; }
  if (stat && stat.isDirectory()) {
    return { episodeDir: abs, scriptPath: path.join(abs, 'script.yaml'), label: path.join(abs, 'script.yaml') };
  }
  return { episodeDir: path.dirname(abs), scriptPath: abs, label: abs };
}

/** 读脚本 + edit + series。返回 { script, edit, series, parseErrors } */
function loadInputs(resolved) {
  const parseErrors = [];
  let script = null;
  if (!fs.existsSync(resolved.scriptPath)) {
    parseErrors.push(`${resolved.label}: not found`);
    return { script, edit: null, series: null, parseErrors };
  }
  try {
    script = loadYaml(resolved.scriptPath);
  } catch (e) {
    parseErrors.push(e.message);
    return { script, edit: null, series: null, parseErrors };
  }

  let edit = null;
  const editPath = path.join(resolved.episodeDir, 'edit.yaml');
  if (fs.existsSync(editPath)) {
    try { edit = loadYaml(editPath); }
    catch (e) { parseErrors.push(e.message); }
  }

  let series = null;
  try { series = loadYaml(path.join(ROOT, 'series.yaml')); }
  catch (e) { parseErrors.push(e.message); }

  return { script, edit, series, parseErrors };
}

function formatText(result, resolved) {
  const lines = [];
  lines.push(`script: ${resolved.label}`);
  for (const e of result.errors) lines.push(`[ERROR] ${e}`);
  for (const w of result.warnings) lines.push(`[WARN] ${w}`);
  lines.push(`shots: ${result.stats.shots}, estimated_seconds: ${result.stats.estimated_seconds}, dialogue_shots: ${result.stats.dialogue_shots}`);
  lines.push(`RESULT: ${result.ok ? 'OK' : 'FAIL'} (${result.errors.length} error(s), ${result.warnings.length} warning(s))`);
  return lines.join('\n');
}

function parseArgs(argv) {
  const opts = { input: null, json: false, build: false, timeline: false, help: false, unknown: [] };
  for (const a of argv) {
    if (a === '--json') opts.json = true;
    else if (a === '--build') opts.build = true;
    else if (a === '--timeline') opts.timeline = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--')) opts.unknown.push(a);
    else if (!opts.input) opts.input = a;
    else opts.unknown.push(a);
  }
  return opts;
}

function usage() {
  console.error('Usage: node tools/validate-script.js <script.yaml | episode-dir> [--json] [--build] [--timeline]');
}

function runChild(scriptName, episodeDir) {
  const bin = path.join(__dirname, scriptName);
  const r = spawnSync(process.execPath, [bin, episodeDir], { stdio: 'inherit' });
  if (r.error) {
    console.error(`ERROR: failed to spawn ${scriptName}: ${r.error.message}`);
    return 1;
  }
  return r.status === null ? 1 : r.status;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { usage(); return 0; }
  if (!opts.input) { usage(); return 1; }
  if (opts.unknown.length) {
    if (opts.json) console.log(JSON.stringify({ ok: false, errors: [`unknown argument(s): ${opts.unknown.join(' ')}`], warnings: [], stats: { shots: 0, estimated_seconds: 0, dialogue_shots: 0 } }));
    else console.error(`ERROR: unknown argument(s): ${opts.unknown.join(' ')}`);
    return 1;
  }

  const resolved = resolveInput(opts.input);
  const { script, edit, series, parseErrors } = loadInputs(resolved);
  const result = parseErrors.length
    ? { ok: false, errors: parseErrors.slice(), warnings: [], stats: { shots: 0, estimated_seconds: 0, dialogue_shots: 0 } }
    : validateScriptObject(script, { edit, series, label: resolved.label });

  if (opts.json) console.log(JSON.stringify({ ok: result.ok, errors: result.errors, warnings: result.warnings, stats: result.stats }));
  else console.log(formatText(result, resolved));

  if (!result.ok) return EXIT_ERROR;

  const doBuild = opts.build || opts.timeline;
  if (doBuild) {
    const code = runChild('build-manifest.js', resolved.episodeDir);
    if (code !== 0) return code;
  }
  if (opts.timeline) {
    const editPath = path.join(resolved.episodeDir, 'edit.yaml');
    if (fs.existsSync(editPath)) {
      const code = runChild('build-timeline.js', resolved.episodeDir);
      if (code !== 0) return code;
    } else {
      console.log(`skip build-timeline: no edit.yaml in ${resolved.episodeDir}`);
    }
  }
  return 0;
}

module.exports = {
  validateScriptObject, resolveInput, loadInputs, formatText, parseArgs, main,
  checkVideoSpec, EXIT_ERROR, MAX_SHOT_DURATION,
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
