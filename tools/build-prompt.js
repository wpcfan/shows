#!/usr/bin/env node
/**
 * build-prompt.js — 单 shot → 最终英文 Seedance 提示词
 *
 * 用法:
 *   node tools/build-prompt.js <episode-dir> <shot-id>
 *
 * 输出: 最终英文 prompt 到 stdout (纯文本,可直接喂给 GenerateVideo 的 prompt 参数)
 *
 * V2 拼装规则:
 *   [shot.style_en] + [shot.camera] + shot.prompt_en
 *   + [引用角色 appearance_en][引用场景 appearance_en]
 * style-guide.md 为参考词库,不再自动注入。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');

// ---------- 工具函数 ----------
function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function loadYaml(p) {
  const txt = readText(p);
  if (!txt) return null;
  try { return yaml.load(txt); } catch (e) {
    throw new Error(`YAML parse failed for ${p}: ${e.message}`);
  }
}

/** 在 dir 下查找 reference.{png,jpg,jpeg,webp},返回绝对路径或 null */
function findReferenceImage(dir) {
  if (!fs.existsSync(dir)) return null;
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
    const p = path.join(dir, 'reference' + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * 解析 style-guide.md → { category: [keywords] }
 * 文件格式:## <category>\nkeyword1, keyword2, ...
 */
const SKIP_CATEGORIES = new Set(['injection_rule', 'pacing', 'audio_cue (visual proxy)']);
function parseStyleGuide(text) {
  const out = {};
  if (!text) return out;
  const sections = text.split(/^##\s+/m);
  for (const sec of sections) {
    if (!sec.trim()) continue;
    const lines = sec.split('\n');
    const cat = lines[0].trim();
    // 跳过:preamble(第一个 ## 前的内容,cat 会是 H1 标题)、文档性分类
    if (cat.startsWith('#') || SKIP_CATEGORIES.has(cat)) continue;
    const rest = lines.slice(1).join('\n');
    // 注释行(以 # 开头)跳过,其余按逗号分割
    const kws = rest
      .split('\n')
      .filter(l => l.trim() && !l.trim().startsWith('#'))
      .flatMap(l => l.split(','))
      .map(s => s.trim())
      .filter(Boolean);
    if (kws.length) out[cat] = kws;
  }
  return out;
}

/** 从关键词数组里随机取 n 个 (不重复) */
function sample(arr, n) {
  if (!arr || arr.length === 0) return [];
  const pool = [...arr];
  const out = [];
  while (out.length < n && pool.length) {
    const i = Math.floor(Math.random() * pool.length);
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

/** 按 scene.time_cn / weather_cn 挑 lighting 关键词 */
function pickLighting(timeCn, weatherCn, lightingKws) {
  if (!lightingKws || !lightingKws.length) return [];
  const t = timeCn || '';
  const w = weatherCn || '';
  const want = [];
  if (/清晨|morning/.test(t)) want.push('harsh sunlight', 'dust-lit beams');
  if (/黄昏|dusk|傍晚/.test(t)) want.push('dusk blue hour', 'golden hour haze');
  if (/夜|night/.test(t)) want.push('moonlight cold tone', 'deep shadows');
  if (/阴|overcast/.test(w)) want.push('overcast sky', 'cold tone');
  if (/雨|rain/.test(w)) want.push('wet reflections', 'cold tone');
  if (want.length === 0) return sample(lightingKws, 2);
  // 只保留 style-guide 里实际有的
  const filtered = want.filter(k => lightingKws.includes(k));
  return filtered.length ? filtered : sample(lightingKws, 2);
}

// ---------- 核心:构建最终 prompt ----------
/**
 * 为单个 shot 构建最终英文 prompt 与 image_paths。
 *
 * V2:确定性风格注入。不再随机采样 style-guide 关键词。
 * 作者在 shot.style_en 中显式写风格关键词(参考 style-guide.md 词库)。
 *
 * 拼装顺序:[shot.style_en] + [shot.camera] + shot.prompt_en
 *           + [引用角色 appearance_en][引用场景 appearance_en]
 *
 * @param {object} shot - shot 对象
 * @param {object} scene - shot 所在 scene
 * @param {object} script - 整个 script.yaml 数据
 * @param {object} styleGuide - parseStyleGuide 的输出(V2不再用于随机注入,保留参数兼容)
 * @returns {{ prompt: string, image_paths: string[] }}
 */
function buildPromptForShot(shot, scene, _script, _styleGuide) {
  // shot.no_style_inject: true 时跳过所有风格注入(用于明亮/非末日场景)
  // 只用 shot.prompt_en + 角色外观 + 场景外观
  let prefixParts = [];
  if (!shot.no_style_inject) {
    if (shot.style_en) {
      prefixParts.push(shot.style_en);
    } else {
      // 无 style_en → 不注入风格,打印 warning
      process.stderr.write(`WARN: ${shot.id} has no style_en — no style keywords injected (see style-guide.md for reference)\n`);
    }
    if (shot.camera) prefixParts.push(shot.camera);
  }

  const prefix = prefixParts.join(', ');
  const core = (shot.prompt_en || '').trim();

  // 引用角色
  const charParts = [];
  for (const cid of (shot.characters || [])) {
    const cdir = path.join(ROOT, 'characters', cid);
    const cdata = loadYaml(path.join(cdir, 'character.yaml'));
    if (cdata && cdata.prompt_inject && cdata.appearance_en) {
      charParts.push(cdata.appearance_en.trim());
    }
  }
  // 引用场景
  const locId = shot.location || scene?.location;
  const locParts = [];
  if (locId) {
    const ldir = path.join(ROOT, 'locations', locId);
    const ldata = loadYaml(path.join(ldir, 'location.yaml'));
    if (ldata && ldata.prompt_inject && ldata.appearance_en) {
      locParts.push(ldata.appearance_en.trim());
    }
  }

  const all = [prefix, core, ...charParts, ...locParts]
    .map(s => (s || '').trim().replace(/[.\s]+$/, ''))  // 去掉末尾的句点/空白,避免拼接出 .. 双句点
    .filter(s => s)
    .join('. ');

  // 收集 image_paths 与各自的角色描述,生成 <image N> 引用映射后缀
  // image_refs = 完整 ref(含 §3.8 hash_role),供 stage payload/hash 使用;prompt 文本不变
  const refs = collectImageRefs(shot, scene);
  const image_refs = refs.map(r => ({ path: r.path, role: r.role, hash_role: r.hash_role }));
  let imagePaths = refs.map(r => r.path);
  if (refs.length) {
    const refSuffix = refs.map((r, i) => `<image ${i + 1}>: ${r.role}`).join('. ');
    return { prompt: all + '. Image references — ' + refSuffix + '.', image_paths: imagePaths, image_refs };
  }
  return { prompt: all, image_paths: imagePaths, image_refs };
}

/**
 * 收集 image refs:角色定妆照 + 场景参考图 + shot.references,带 role 描述。
 * 每项返回 `{ path, role, hash_role }`:
 *   - `role` 为人类可读描述(供 prompt `<image N>` 注入,不得改动)
 *   - `hash_role` 为 §3.8 写死的命名空间(`character:<id>` / `location:<id>` /
 *     `shot.references[<i>]`),参与 stage payload hash
 */
function collectImageRefs(shot, scene) {
  const out = [];
  const seen = new Set();
  const push = (p, role, hashRole) => {
    if (p && !seen.has(p)) { seen.add(p); out.push({ path: p, role, hash_role: hashRole }); }
  };

  for (const cid of (shot.characters || [])) {
    const cdir = path.join(ROOT, 'characters', cid);
    const cdata = loadYaml(path.join(cdir, 'character.yaml'));
    const role = cdata ? `${cdata.name_en} appearance` : `character ${cid} appearance`;
    push(findReferenceImage(cdir), role, `character:${cid}`);
  }
  const locId = shot.location || scene?.location;
  if (locId) {
    const ldir = path.join(ROOT, 'locations', locId);
    const ldata = loadYaml(path.join(ldir, 'location.yaml'));
    const role = ldata ? `${ldata.name_en} setting` : `location ${locId} setting`;
    push(findReferenceImage(ldir), role, `location:${locId}`);
  }
  const references = shot.references || [];
  for (let i = 0; i < references.length; i++) {
    const r = references[i];
    const p = path.isAbsolute(r) ? r : path.join(ROOT, r);
    push(p, 'extra reference', `shot.references[${i}]`);
  }
  return out;
}

/** 兼容旧接口:返回纯路径数组 */
function collectImagePaths(shot, scene) {
  return collectImageRefs(shot, scene).map(r => r.path);
}

// ---------- 加载 script.yaml ----------
function loadScript(episodeDir) {
  const sp = path.join(episodeDir, 'script.yaml');
  return loadYaml(sp);
}

/** 在 script 里按 id 找 shot,返回 {shot, scene, script} */
function findShot(script, shotId) {
  for (const scene of (script.scenes || [])) {
    for (const shot of (scene.shots || [])) {
      if (shot.id === shotId) return { shot, scene, script };
    }
  }
  return null;
}

// ---------- CLI ----------
function main() {
  const [episodeDir, shotId] = process.argv.slice(2);
  if (!episodeDir || !shotId) {
    console.error('Usage: node tools/build-prompt.js <episode-dir> <shot-id>');
    process.exit(1);
  }
  const absEpDir = path.isAbsolute(episodeDir) ? episodeDir : path.resolve(episodeDir);
  const script = loadScript(absEpDir);
  if (!script) { console.error(`script.yaml not found in ${absEpDir}`); process.exit(2); }
  const found = findShot(script, shotId);
  if (!found) { console.error(`shot ${shotId} not found`); process.exit(3); }

  const sgText = readText(path.join(ROOT, 'style-guide.md'));
  const styleGuide = parseStyleGuide(sgText);

  const { prompt } = buildPromptForShot(found.shot, found.scene, script, styleGuide);
  process.stdout.write(prompt + '\n');
}

module.exports = {
  readText, loadYaml, findReferenceImage, parseStyleGuide,
  sample, pickLighting, buildPromptForShot, collectImageRefs, collectImagePaths,
  loadScript, findShot, ROOT
};

if (require.main === module) main();
