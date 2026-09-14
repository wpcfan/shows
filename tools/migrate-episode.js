#!/usr/bin/env node
/**
 * migrate-episode.js — 显式 schema 1 → 2 迁移(PRD v2.4 §6)
 *
 * 用法:
 *   node tools/migrate-episode.js <episode-dir> --to 2 [--dry-run] [--catalog <path>]
 *
 * 设计要点:
 *   - 迁移只由显式命令执行;`stitch-episode --final` 只读 schema_version,不自动升级。
 *   - 逐项幂等:第二次运行 `changed=[]` 且不改任何字节。
 *   - 注释保护:仅补/改顶层标量键(schema_version / require_keyframe)时走文本级
 *     插入/替换,禁止整文件 YAML 重排;确需删除 shot 级 ratio 这类结构变更时优先
 *     文本级删行;文本级无法完成才回退 js-yaml 重写,并先写 `<file>.bak` 备份 + WARN。
 *   - ratio 冲突(shot.ratio != episode ratio 且未设 allow_mixed_ratio)是硬错误:
 *     列出违规 shot、提示人工裁决,不写任何文件。
 *   - 全部写入原子(tmp+rename);manifest/catalog 用 atomicWriteJson,script 文本走
 *     tmp+rename。
 *   - catalog 路径可注入(默认 <repo>/catalog.json),便于测试隔离。
 *
 * 迁移矩阵(PRD §6):
 *   shot.ratio == episode.ratio                  → 删除 shot 级覆盖
 *   shot.ratio != episode.ratio 无 allow_mixed   → 报错,零写入
 *   shot.ratio != episode.ratio 有 allow_mixed   → 保留
 *   take/task 缺 stage                           → stage: 'video'
 *   episode 缺 require_keyframe                  → script + manifest 补 false
 *   catalog 条目缺 stage(仅本 episode)         → stage: 'video'
 *   缺 schema_version                            → script + manifest 写入 2
 *   旧集要出封面但无 keyframe                    → 仅 notes 报告(不写数据)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { loadYaml } = require('./build-prompt');
const {
  readJsonFileOrNull, atomicWriteJson, resolveEpisodeRatio
} = require('./build-manifest');
const { withLock } = require('./lock');

const ROOT = path.resolve(__dirname, '..');

/** 原子写文本文件(tmp + rename),与 atomicWriteJson 同语义 */
function atomicWriteText(filePath, text) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort cleanup */ }
    throw e;
  }
}

/** 去掉 YAML 标量外层引号,用于文本级匹配 */
function stripQuotes(s) {
  const t = String(s).trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1);
  }
  return t;
}

function formatScalar(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return String(value);
}

/**
 * 文本级插入/替换顶层标量键(保持其余字节与顺序不变)。
 * 已存在 `^key:` 行 → 原地替换;缺失 → 在文件头部注释块之后插入。
 * @param {string} text
 * @param {Object} updates { key: value }
 * @returns {string}
 */
function patchTopLevelScalars(text, updates) {
  const lines = text.split('\n');
  const inserted = [];
  for (const [key, value] of Object.entries(updates || {})) {
    const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`);
    const i = lines.findIndex(l => re.test(l));
    if (i >= 0) lines[i] = `${key}: ${formatScalar(value)}`;
    else inserted.push(`${key}: ${formatScalar(value)}`);
  }
  if (inserted.length) {
    // 插到头部连续注释/空行之后,保持文件头注释在最上方
    let pos = 0;
    while (pos < lines.length) {
      const t = lines[pos].trim();
      if (t === '' || t.startsWith('#')) pos++;
      else break;
    }
    lines.splice(pos, 0, ...inserted);
  }
  return lines.join('\n');
}

/**
 * 文本级删除指定 shot 块内的 `ratio:` 行(保留注释与其他字段)。
 * shot 块 = 从 `- id: <shotId>` 到下一个同级/更浅缩进行。
 * @returns {{ text: string, removed: boolean }}
 */
function stripShotRatio(text, shotId) {
  const lines = text.split('\n');
  const idx = lines.findIndex(l => {
    const m = l.match(/^(\s*)-\s*id:\s*(.+?)\s*$/);
    return m && stripQuotes(m[2]) === shotId;
  });
  if (idx < 0) return { text, removed: false };
  const dashIndent = (lines[idx].match(/^(\s*)/) || ['', ''])[1].length;
  let end = idx + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() === '') { end++; continue; }
    const indent = (line.match(/^(\s*)/) || ['', ''])[1].length;
    if (indent <= dashIndent) break;
    end++;
  }
  const block = lines.slice(idx, end);
  const ratioIdx = block.findIndex(l => /^\s*ratio:/.test(l));
  if (ratioIdx < 0) return { text, removed: false };
  const newBlock = block.filter((_, i) => i !== ratioIdx);
  return { text: [...lines.slice(0, idx), ...newBlock, ...lines.slice(end)].join('\n'), removed: true };
}

/**
 * 纯函数:迁移 script 数据结构(不改入参)。
 * @returns {{ data: object, changes: Array, errors: string[], hasStructuralChanges: boolean }}
 */
function migrateScriptData(script, opts = {}) {
  const data = JSON.parse(JSON.stringify(script || {}));
  const changes = [];
  const errors = [];
  const to = Number.isFinite(Number(opts.to)) ? Number(opts.to) : 2;
  const episodeRatio = opts.episodeRatio || '16:9';
  const allowMixed = opts.allowMixedRatio === true || data.allow_mixed_ratio === true;

  for (const scene of (data.scenes || [])) {
    for (const shot of (scene.shots || [])) {
      if (shot.ratio === undefined || shot.ratio === null) continue;
      if (shot.ratio === episodeRatio) {
        delete shot.ratio;
        changes.push({
          type: 'remove_shot_ratio',
          shot_id: shot.id,
          ratio: episodeRatio,
          message: `script.yaml: removed shot ratio override for ${shot.id} ('${episodeRatio}' == episode ratio)`
        });
      } else if (!allowMixed) {
        errors.push(`ratio violation: shot '${shot.id}' has ratio '${shot.ratio}' != episode ratio '${episodeRatio}' (PRD §3.7). Fix the shot or set 'allow_mixed_ratio: true' in script.yaml to explicitly opt in to mixed-ratio output.`);
      }
    }
  }
  if (errors.length) {
    return { data, changes, errors, hasStructuralChanges: false };
  }

  if (Number(data.schema_version) !== to || data.schema_version === undefined) {
    const prev = data.schema_version === undefined ? 1 : data.schema_version;
    if (prev !== to) {
      changes.push({
        type: 'set_schema_version',
        from: prev,
        to,
        message: `script.yaml: schema_version ${data.schema_version === undefined ? '(default 1)' : prev} → ${to}`
      });
    }
    data.schema_version = to;
  }
  if (data.require_keyframe === undefined) {
    changes.push({ type: 'set_require_keyframe', value: false, message: 'script.yaml: require_keyframe → false' });
    data.require_keyframe = false;
  }
  return { data, changes, errors: [], hasStructuralChanges: changes.some(c => c.type === 'remove_shot_ratio') };
}

/**
 * 纯函数:迁移 manifest 数据(不改入参)。
 * @returns {{ data: object, changes: Array, warnings: string[] }}
 */
function migrateManifestData(manifest, opts = {}) {
  const data = JSON.parse(JSON.stringify(manifest || {}));
  const changes = [];
  const warnings = [];
  const to = Number.isFinite(Number(opts.to)) ? Number(opts.to) : 2;
  const requireKeyframe = opts.requireKeyframe === true;

  const prev = data.schema_version === undefined ? 1 : Number(data.schema_version);
  if (prev !== to) {
    changes.push({
      type: 'set_schema_version',
      from: prev,
      to,
      message: `manifest.json: schema_version ${data.schema_version === undefined ? '(default 1)' : prev} → ${to}`
    });
  }
  data.schema_version = to;

  if (data.require_keyframe === undefined) {
    changes.push({ type: 'set_require_keyframe', value: requireKeyframe, message: `manifest.json: require_keyframe → ${requireKeyframe}` });
    data.require_keyframe = requireKeyframe;
  } else if (data.require_keyframe !== requireKeyframe) {
    warnings.push(`manifest.json: require_keyframe=${data.require_keyframe} differs from script (${requireKeyframe}); left unchanged — rebuild with build-manifest.js to align.`);
  }

  for (const shot of (data.shots || [])) {
    for (const take of (shot.takes || [])) {
      if (take.stage === undefined || take.stage === null) {
        take.stage = 'video';
        changes.push({ type: 'set_take_stage', shot_id: shot.id, take_id: take.id, message: `manifest.json: shots[${shot.id}].takes[${take.id}].stage → video` });
      }
    }
  }
  for (const t of (data.render_tasks || [])) {
    if (t.stage === undefined || t.stage === null) {
      t.stage = 'video';
      changes.push({ type: 'set_task_stage', task_id: t.task_id, message: `manifest.json: render_tasks[${t.task_id}].stage → video` });
    }
  }
  return { data, changes, warnings };
}

/**
 * 纯函数:仅为本 episode 的 catalog 条目补 stage(不改入参)。
 * @returns {{ data: array, changes: Array }}
 */
function migrateCatalogData(catalog, episodeId) {
  const data = JSON.parse(JSON.stringify(Array.isArray(catalog) ? catalog : []));
  const changes = [];
  if (!Array.isArray(catalog)) return { data, changes };
  for (const entry of data) {
    if (!entry || entry.episode !== episodeId) continue;
    if (entry.stage === undefined || entry.stage === null) {
      entry.stage = 'video';
      changes.push({
        type: 'set_catalog_stage',
        shot_id: entry.shot_id,
        take_id: entry.take_id,
        message: `catalog.json: ${entry.shot_id}/${entry.take_id} stage → video`
      });
    }
  }
  return { data, changes };
}

/**
 * `stitch-episode --final` 的 v1 语义提示(纯函数)。
 * @returns {string} schema < 2 时返回提示语,否则返回空串
 */
function schemaFinalNotice(manifest) {
  const v = Number((manifest && manifest.schema_version) || 1) || 1;
  if (v >= 2) return '';
  return 'v1 final semantics applied. Run migrate-episode --to 2 to adopt v2 publishing requirements.';
}

/**
 * 报告旧集封面来源(不写数据)。
 * @returns {string[]} notes
 */
function coverNotes(manifest) {
  const notes = [];
  const shots = (manifest && manifest.shots) || [];
  const hasSelectedKeyframe = shots.some(s => (s.takes || []).some(t => t.stage === 'keyframe' && t.status === 'selected'));
  const selectedVideo = [];
  for (const shot of shots) {
    const take = shot.selected_take ? (shot.takes || []).find(t => t.id === shot.selected_take) : null;
    if (take && (take.stage === undefined || take.stage === 'video')) {
      selectedVideo.push({ shot_id: shot.id, take_id: take.id });
    }
  }
  if (hasSelectedKeyframe) {
    notes.push('cover: selected keyframe present — cover frame uses the selected keyframe (PRD §4).');
  } else if (selectedVideo.length) {
    notes.push(`cover: no keyframe for this v1 episode — cover frame will use the head frame of selected video take ${selectedVideo[0].shot_id}/${selectedVideo[0].take_id} (PRD §4).`);
  } else {
    notes.push('cover: no selected video take found — final cover will fail per PRD §4; select a video take before running --final.');
  }
  return notes;
}

/**
 * 迁移一集。全部写入原子化;ratio 冲突时零写入。
 * @param {Object} opts
 * @param {string} opts.episodeDir
 * @param {number} [opts.to=2]
 * @param {boolean} [opts.dryRun=false]
 * @param {string} [opts.catalogPath=<repo>/catalog.json]
 * @param {string} [opts.seriesPath=<repo>/series.yaml]
 * @returns {{ from:number, to:number, changed:string[], warnings:string[], errors:string[], notes:string[] }}
 */
function migrateEpisode(opts = {}) {
  const to = Number.isFinite(Number(opts.to)) ? Number(opts.to) : 2;
  const result = { from: 1, to, changed: [], warnings: [], errors: [], notes: [] };
  if (!opts.episodeDir) { result.errors.push('episodeDir is required'); return result; }
  const episodeDir = path.resolve(opts.episodeDir);
  const dryRun = opts.dryRun === true;
  const catalogPath = opts.catalogPath || path.join(ROOT, 'catalog.json');
  const seriesPath = opts.seriesPath === undefined ? path.join(ROOT, 'series.yaml') : opts.seriesPath;

  const scriptPath = path.join(episodeDir, 'script.yaml');
  if (!fs.existsSync(scriptPath)) { result.errors.push(`script.yaml not found in ${episodeDir}`); return result; }
  let scriptText;
  let script;
  try {
    scriptText = fs.readFileSync(scriptPath, 'utf8');
    script = loadYaml(scriptPath);
  } catch (e) {
    result.errors.push(`script.yaml parse failed: ${e.message}`);
    return result;
  }
  if (!script || typeof script !== 'object') { result.errors.push('script.yaml is empty or not a mapping'); return result; }

  const manifestPath = path.join(episodeDir, 'manifest.json');
  const manifestRead = readJsonFileOrNull(manifestPath, { label: 'manifest.json' });
  if (manifestRead.corrupt) { result.errors.push(`manifest.json is corrupt: ${manifestRead.guidance}`); return result; }
  const hasManifest = manifestRead.value !== null && typeof manifestRead.value === 'object';
  const manifest = hasManifest ? manifestRead.value : null;

  // 分文件版本判定(FIX5e):script/manifest 各自迁移到 to;任一 > to → 不支持降级,零写入。
  const scriptSv = Number.isFinite(Number(script.schema_version)) ? Number(script.schema_version) : 1;
  const manifestSv = hasManifest && Number.isFinite(Number(manifest.schema_version)) ? Number(manifest.schema_version) : 1;
  result.from = Math.min(scriptSv, manifestSv) || 1; // 兼容既有输出(提示用)
  result.files = {
    script: { from: scriptSv, to, changed: false },
    manifest: { from: manifestSv, to, changed: false }
  };

  const downgrades = [];
  if (scriptSv > to) downgrades.push(`script.yaml schema_version ${scriptSv} is newer than target ${to}`);
  if (hasManifest && manifestSv > to) downgrades.push(`manifest.json schema_version ${manifestSv} is newer than target ${to}`);
  if (downgrades.length) {
    for (const d of downgrades) result.errors.push(`${d} — schema downgrade is not supported; no file was written`);
    return result;
  }

  const scriptNeedsMigration = scriptSv < to;
  const manifestNeedsMigration = hasManifest && manifestSv < to;
  if (!scriptNeedsMigration && !manifestNeedsMigration) return result; // 已是目标版本 → no-op

  const series = seriesPath ? loadYaml(seriesPath) : null;
  const episodeRatio = resolveEpisodeRatio(script, series);

  const changed = [];
  const warnings = [];

  // ---- script 写入内容(仅 script 需要迁移时) ----
  let scriptChanged = false;
  let scriptOutText = scriptText;
  let usedYamlRewrite = false;
  let structural = false;
  let requireKeyframe = script.require_keyframe === true;

  if (scriptNeedsMigration) {
    const scriptRes = migrateScriptData(script, {
      episodeRatio,
      allowMixedRatio: script.allow_mixed_ratio === true,
      to
    });
    if (scriptRes.errors.length) {
      result.errors.push(...scriptRes.errors);
      return result; // 硬错误:不写任何文件
    }
    changed.push(...scriptRes.changes.map(c => c.message));
    requireKeyframe = scriptRes.data.require_keyframe === true;

    const needsSchema = Number(script.schema_version) !== to;
    const needsKeyframe = script.require_keyframe === undefined;
    structural = scriptRes.hasStructuralChanges;
    scriptChanged = structural || needsSchema || needsKeyframe;
    if (scriptChanged) {
      const scalarUpdates = {};
      if (needsSchema) scalarUpdates.schema_version = to;
      if (needsKeyframe) scalarUpdates.require_keyframe = false;
      if (structural) {
        let text = scriptText;
        let allRemoved = true;
        for (const c of scriptRes.changes.filter(x => x.type === 'remove_shot_ratio')) {
          const r = stripShotRatio(text, c.shot_id);
          if (!r.removed) { allRemoved = false; break; }
          text = r.text;
        }
        if (allRemoved) {
          scriptOutText = Object.keys(scalarUpdates).length ? patchTopLevelScalars(text, scalarUpdates) : text;
        } else {
          usedYamlRewrite = true;
          scriptOutText = yaml.dump(scriptRes.data, { lineWidth: 120, noRefs: true });
        }
      } else {
        scriptOutText = Object.keys(scalarUpdates).length ? patchTopLevelScalars(scriptText, scalarUpdates) : scriptText;
      }
    }
  }

  // ---- manifest / catalog(仅 manifest 需要迁移时;仅 script 需要时绝不触碰 manifest) ----
  let manifestOut = null;
  let manifestChanged = false;
  let catalogOut = null;
  let catalogChanged = false;

  if (manifestNeedsMigration) {
    const mRes = migrateManifestData(manifest, { to, requireKeyframe });
    manifestOut = mRes.data;
    manifestChanged = mRes.changes.length > 0;
    changed.push(...mRes.changes.map(c => c.message));
    warnings.push(...mRes.warnings);
    result.notes.push(...coverNotes(manifestOut));

    const catRead = readJsonFileOrNull(catalogPath, { label: 'catalog.json' });
    if (catRead.corrupt) {
      warnings.push(`catalog.json is corrupt — skipped catalog migration: ${catRead.guidance}`);
    } else if (catRead.missing) {
      warnings.push(`catalog.json not found at ${catalogPath} — skipped catalog stage backfill.`);
    } else {
      const cRes = migrateCatalogData(catRead.value, script.episode);
      catalogOut = cRes.data;
      catalogChanged = cRes.changes.length > 0;
      changed.push(...cRes.changes.map(c => c.message));
    }
  } else if (scriptNeedsMigration && !hasManifest) {
    warnings.push('manifest.json not found — migrated script fields only (ratio/require_keyframe/schema_version); manifest/catalog fields were NOT migrated. Run build-manifest.js first to create a manifest, then re-run migrate-episode.');
  }

  if (structural) {
    warnings.push(usedYamlRewrite
      ? `script.yaml: structural change (shot ratio removal) required a full YAML rewrite — comments may be lost; backup written to script.yaml.bak`
      : `script.yaml: structural change (shot ratio removal) applied textually (comments preserved); backup written to script.yaml.bak`);
  }

  result.changed = changed;
  result.warnings = warnings;
  result.files.script.changed = scriptChanged;
  result.files.manifest.changed = manifestChanged;

  if (dryRun) return result;

  // ---- 落盘(仅改写本次确实迁移的文件) ----
  if (scriptChanged) {
    if (structural) fs.copyFileSync(scriptPath, scriptPath + '.bak');
    atomicWriteText(scriptPath, scriptOutText);
  }
  if (manifestChanged) atomicWriteJson(manifestPath, manifestOut);
  if (catalogChanged) atomicWriteJson(catalogPath, catalogOut);

  return result;
}

function parseArgs(argv) {
  const out = { episodeDir: null, to: 2, dryRun: false, catalogPath: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--to') out.to = Number(argv[++i]);
    else if (a.startsWith('--to=')) out.to = Number(a.slice('--to='.length));
    else if (a === '--catalog') out.catalogPath = argv[++i];
    else if (a.startsWith('--catalog=')) out.catalogPath = a.slice('--catalog='.length);
    else if (!a.startsWith('--')) out.episodeDir = a;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.episodeDir) {
    console.error('Usage: node tools/migrate-episode.js <episode-dir> --to 2 [--dry-run] [--catalog <path>]');
    return 1;
  }
  if (!Number.isFinite(args.to) || args.to < 1) {
    console.error(`ERROR: --to must be a positive schema version (got ${args.to})`);
    return 1;
  }
  const absEpDir = path.resolve(args.episodeDir);
  const catalogPath = args.catalogPath ? path.resolve(args.catalogPath) : path.join(ROOT, 'catalog.json');
  let res;
  try {
    // D6:script/manifest/catalog 写入以 episode 目录 + catalog 路径为粒度加锁
    res = withLock([absEpDir, catalogPath], () => migrateEpisode({
      episodeDir: args.episodeDir,
      to: args.to,
      dryRun: args.dryRun,
      catalogPath: args.catalogPath || undefined
    }));
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    return 3;
  }

  console.log(`migrate-episode: ${path.basename(path.resolve(args.episodeDir))} schema ${res.from} → ${res.to}${args.dryRun ? ' [dry-run]' : ''}`);
  if (res.changed.length) {
    console.log('changes:');
    for (const c of res.changed) console.log(`  - ${c}`);
  } else {
    console.log('  no changes (already at target schema)');
  }
  if (res.notes.length) {
    console.log('notes:');
    for (const n of res.notes) console.log(`  - ${n}`);
  }
  if (res.warnings.length) {
    console.log('warnings:');
    for (const w of res.warnings) console.log(`  - ${w}`);
  }
  if (res.errors.length) {
    console.error('errors:');
    for (const e of res.errors) console.error(`  - ${e}`);
    return 1;
  }
  if (args.dryRun) console.log('[dry-run] no files written');
}

module.exports = {
  migrateEpisode,
  migrateScriptData,
  migrateManifestData,
  migrateCatalogData,
  schemaFinalNotice,
  patchTopLevelScalars,
  stripShotRatio,
  atomicWriteText
};

if (require.main === module) {
  process.exit(main());
}
