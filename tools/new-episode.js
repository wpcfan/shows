#!/usr/bin/env node
/**
 * new-episode.js — 新集草稿/新集目录脚手架(零 credits)
 *
 * 用法:
 *   node tools/new-episode.js --draft <slug> [--title "标题"] [--root <dir>]
 *   node tools/new-episode.js --episode <EPISODE-ID> [--title "标题"] [--root <dir>]
 *
 * 目标路径:
 *   --draft   → <root>/episodes/_drafts/<slug>/
 *   --episode → <root>/episodes/<EPISODE-ID>/
 *   --root 缺省 = 仓库根。
 *
 * 生成:
 *   - script.yaml: 可直接通过 `tools/validate-script.js` 的模板(schema_version: 2,
 *     合法 intent/tts/defaults,intent 合法,含 dialogue/continue_from/references 注释示例)
 *   - shots/: 空目录(后续产物占位)
 *   - README.md: 迭代循环 / credits 边界 / E1 时机提示
 *
 * 目标已存在且非空 → 报错、零改动、非零退出;非法 slug/EPISODE-ID(路径分隔、`..`、空白)→ 报错。
 * 纯本地、零网络;不触发任何生成。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DRAFT_DIRNAME = '_drafts';

const PATH_SEP_RE = /[\\/]/;
const WHITESPACE_RE = /\s/;

/** 解析 CLI 参数(不抛错) */
function parseArgs(argv) {
  const opts = { draft: null, episode: null, title: null, root: null, help: false, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--draft') opts.draft = argv[++i];
    else if (a === '--episode') opts.episode = argv[++i];
    else if (a === '--title') opts.title = argv[++i];
    else if (a === '--root') opts.root = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    else opts.unknown.push(a);
  }
  return opts;
}

/** 校验 slug / EPISODE-ID:禁止路径分隔、`..`、空白、空串 */
function validateId(id, kind) {
  const problems = [];
  if (typeof id !== 'string' || id.length === 0) {
    problems.push('must not be empty');
  } else {
    if (PATH_SEP_RE.test(id)) problems.push('must not contain path separators (/ or \\)');
    if (id.includes('..')) problems.push("must not contain '..'");
    if (WHITESPACE_RE.test(id)) problems.push('must not contain whitespace');
    if (id === '.' || id === '..') problems.push('must not be a path navigation segment');
  }
  if (problems.length) {
    throw new Error(`invalid ${kind} ${JSON.stringify(id)}: ${problems.join('; ')}`);
  }
  return id;
}

/** 目录不存在 / 为空 → true;存在且有内容 → false */
function isDirEmptyOrMissing(dir) {
  if (!fs.existsSync(dir)) return true;
  if (!fs.statSync(dir).isDirectory()) return false;
  return fs.readdirSync(dir).length === 0;
}

/** 目标目录(绝对路径) */
function targetDir({ draft, episode, root }) {
  const base = root ? path.resolve(root) : REPO_ROOT;
  if (draft) return path.join(base, 'episodes', DRAFT_DIRNAME, draft);
  return path.join(base, 'episodes', episode);
}

/** script.yaml 模板(可直接通过 validate-script) */
function buildScriptYaml({ id, title }) {
  const ep = JSON.stringify(id);
  const t = JSON.stringify(title);
  return `# 新集剧本草稿 — 由 tools/new-episode.js 生成
# 迭代循环(零 credits → credits):
#   改稿 → node tools/validate-script.js <本目录>(只读/零网络)
#        → node tools/build-manifest.js <本目录>
#        → node tools/build-timeline.js <本目录>(需要 edit.yaml)
#   之后才进入花钱的 keyframe / video 生成。
# 注意:加对白后必须同步把 intent.subtitles 改成 soft/burn/both,并声明 dialogue: true。

schema_version: 2
episode: ${ep}
title: ${t}
logline_cn: <一句话梗概,人读>

style_preset: walking-dead   # 引用 style-guide.md 词库

# 制作意图(PRD §4)。本模板无对白 → music_sfx + 无字幕(合法默认)。
# 一旦有对白:audio 保持 dialogue,subtitles 不能是 none。
intent:
  audio: music_sfx
  subtitles: none

# TTS(PRD §3.4):有对白时使用;voice_id 可被 shot.dialogue.voice_id /
# shot.voice_id / scene.voice_id 覆盖。
tts:
  provider:
    name: doubao
    model: seed-tts-2.0
    version: "2026-09-14"
  voice_id: "zh_male_jieshuoxiaoming_uranus_bigtts"

defaults:
  ratio: "16:9"
  resolution: 720p
  duration: 8

scenes:
  - id: s01
    location: <location-id>          # 引用 locations/<id>/location.yaml
    time_cn: <时间,如 清晨/黄昏/夜间>
    weather_cn: <天气,如 阴天/晴/雨>
    shots:
      - id: s01-shot-01
        duration: 8
        description_cn: |
          <中文动作描述,人读>
        prompt_en: |
          <English Seedance prompt core>
        style_en: "desaturated, handheld, shallow depth of field, tense, dust-lit beams"
        camera: handheld, slight shake
        characters: []

        # location: <location-id>       # 可选,覆盖 scene.location
        # references: []                # 可选,额外参考图(仓库相对路径)

        # --- 对白示例(有对白时必须给 voice,且改 intent.subtitles) ---
        # dialogue:
        #   text: "我们不该来这儿。"
        #   voice_id: "zh_male_jieshuoxiaoming_uranus_bigtts"

        # --- 续镜示例(上游必须在本镜脚本顺序之前;链深 ≤ 3) ---
        # continue_from: s01-shot-00
        # continue_from_offset: -0.1
`;
}

/** README.md 内容 */
function buildReadme({ id }) {
  return [
    `# 新集草稿: ${id}`,
    '',
    '> 由 `node tools/new-episode.js` 生成。此目录只放剧本草稿;',
    '> 校验满意后再进入花钱的生成环节。',
    '',
    '## 迭代循环(零 credits → credits)',
    '',
    '1. **改稿**:编辑 `script.yaml`。中文 `description_cn` 人读;英文 `prompt_en` 给 Seedance;`style_en` 写显式风格。',
    '2. **零成本校验**:',
    '',
    '   ```bash',
    '   node tools/validate-script.js <本目录>',
    '   ```',
    '',
    '   只读、零写盘、零网络、零 credits。先修 `[ERROR]`;`[WARN]` 只提示、不阻断。',
    '3. **生成 manifest**(纯本地,零 credits):',
    '',
    '   ```bash',
    '   node tools/build-manifest.js <本目录>',
    '   ```',
    '4. **生成时间线**(需要 `edit.yaml`;纯本地,零 credits):',
    '',
    '   ```bash',
    '   node tools/build-timeline.js <本目录>',
    '   ```',
    '5. 之后才是**花钱**的 keyframe / video 生成(`render-next.js` + `mark-keyframe.js` / `mark-shot.js`)。',
    '',
    '## credits 边界',
    '',
    '- **零 credits**:`validate-script` / `build-manifest` / `build-timeline`。',
    '- **计费**:keyframe(图)与 video(视频)生成。keyframe 未通过前不要批量跑 video。',
    '',
    '## E1 时机提示',
    '',
    '- E1(首帧能力实验,PRD §3.1)应在**镜头表冻结之后、批量 video 之前**插入:',
    '  先确认镜头结构不再大改,再用首帧模式跑实验,避免改稿导致实验样本作废。',
    '',
    '## 目录内容',
    '',
    '- `script.yaml` —— 剧本(可直接通过 `validate-script`)',
    '- `shots/` —— 后续生成产物占位目录',
    '',
  ].join('\n');
}

/** 纯函数:生成三件产物内容 */
function renderArtifacts({ id, title }) {
  return {
    'script.yaml': buildScriptYaml({ id, title }),
    'README.md': buildReadme({ id }),
  };
}

/**
 * 脚手架主逻辑(可测,不调用 process.exit)。
 * @returns {{ok:boolean, code:number, target?:string, files?:string[], error?:string}}
 */
function scaffold(opts) {
  const { draft, episode } = opts;
  if (draft && episode) return { ok: false, code: 1, error: 'use either --draft or --episode, not both' };
  if (!draft && !episode) return { ok: false, code: 1, error: 'one of --draft <slug> or --episode <EPISODE-ID> is required' };

  const kind = draft ? 'slug' : 'EPISODE-ID';
  const rawId = draft || episode;
  try {
    validateId(rawId, kind);
  } catch (e) {
    return { ok: false, code: 2, error: e.message };
  }
  const id = rawId;
  const title = (typeof opts.title === 'string' && opts.title.trim()) ? opts.title.trim() : id;
  const target = targetDir({ draft, episode, root: opts.root });

  if (!isDirEmptyOrMissing(target)) {
    return { ok: false, code: 3, error: `target already exists and is not empty: ${target} (no changes made)` };
  }

  const artifacts = renderArtifacts({ id, title });
  const files = Object.keys(artifacts);

  // 全部内容已在内存中备好;现在才落盘。
  fs.mkdirSync(path.join(target, 'shots'), { recursive: true });
  for (const name of files) {
    fs.writeFileSync(path.join(target, name), artifacts[name]);
  }
  return { ok: true, code: 0, target, files: [...files, 'shots/'] };
}

function usage() {
  console.error('Usage: node tools/new-episode.js --draft <slug> [--title "标题"] [--root <dir>]');
  console.error('       node tools/new-episode.js --episode <EPISODE-ID> [--title "标题"] [--root <dir>]');
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { usage(); return 0; }
  if (opts.unknown.length) {
    console.error(`ERROR: unknown argument(s): ${opts.unknown.join(' ')}`);
    usage();
    return 1;
  }
  const res = scaffold(opts);
  if (!res.ok) {
    console.error(`ERROR: ${res.error}`);
    if (res.code === 1) usage();
    return res.code || 1;
  }
  console.log(`created ${res.target}`);
  for (const f of res.files) console.log(`  ${f}`);
  console.log('next:');
  console.log(`  node tools/validate-script.js ${res.target}   # 零成本校验(零 credits)`);
  console.log(`  node tools/build-manifest.js ${res.target}`);
  console.log(`  node tools/build-timeline.js ${res.target}    # 需要 edit.yaml`);
  return 0;
}

module.exports = {
  parseArgs, validateId, isDirEmptyOrMissing, targetDir,
  buildScriptYaml, buildReadme, renderArtifacts, scaffold, main,
  REPO_ROOT, DRAFT_DIRNAME,
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
