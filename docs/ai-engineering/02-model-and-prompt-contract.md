# 02 · 模型与提示词契约

> 本篇定义三件事：**模型台账**（能力/限制可溯源）、**输入哈希契约**（缓存正确性与一跳失效的基础）、
> **提示词工程**（结构化写法 + 图生视频连续性 + 负向约束）。
> 契约权威文件：`PRD-v2.md` v2.13 §3.1 / §3.2 / §3.8 / §4；实现入口：`tools/build-manifest.js`、`tools/build-prompt.js`。

## 1. 模型台账

| 阶段 | 模型 / 接口 | 关键能力 | 关键限制 | 来源（访问 2026-09-14） |
|---|---|---|---|---|
| video（E1 实测接口） | `pippit-tool-cli` 1.0.21 → `generate-video`，模型 `Seedance_2.0_mini_lite` | `--generate-type 1`（首尾帧同图）锁定 frame0（校准 SSIM 0.9275） | prompt 首句「图片 1 为首帧」在**直连 CLI 不锁帧**（720p 0.5046/0.4940，与参考图位同级）；`--resolution 480p` 被忽略（输出仍 1254×720，成本不变）；**无 seed** | `experiments/e1/preregistration.json`（`interface_version`、`resolution`）；`experiments/e1/pippit-seedance25-capabilities.md` |
| video（平台能力声明） | 小云雀《Seedance 2.5 关键更新速览》wiki `W5tHwoZIDi12dbk2z3KcFkuUnsf`（revision 2777） | 单次 1–30s（1s 粒度）；超长模式直出最长 5min；R2V 参考模式支持 prompt 首句声明首/尾帧；手册示例支持准确口型同步（**待 M1 实测复核**） | 参考图不能当首帧；素材上限 图≤30（4K）/视频≤10 段（总 30s）/音频≤10 段（总 30s）；480p+超分仅限 web 沉浸式短片工具 | `experiments/e1/pippit-seedance25-capabilities.md`；`PRD-v2.md` §0 v2.10/v2.11、§4 |
| TTS | 豆包 `seed-tts-2.0`（标准音色，**弃用 ICL 音色复刻**） | V3 单向流式端点；`speed=0.95`（默认，映射豆包 `speech_rate`）；幂等 `(task_id, content_digest)` | 字符计费；`DOUBAO_TTS_API_KEY` 必需；**不自动批量**（一次一个 `--task`） | `tools/build-manifest.js:573` `DEFAULT_TTS_PROVIDER={name:'doubao',model:'seed-tts-2.0',version:'2026-09-14'}`；`tools/tts-api-doubao.js:30` V3 端点；`PRD-v2.md` §3.4/§3.5 |
| image（keyframe） | 本仓库 keyframe stage（`require_keyframe` + selected keyframe） | keyframe 作为 video 参考图（`keyframe_mode: reference`）或首帧（`first_frame`） | 每个 `(shot, stage=keyframe)` 至多一个 selected；`rejected` 为终态 | `PRD-v2.md` §3.2/§3.8；`tools/mark-keyframe.js`；`tools/render-next.js` |

> **命名口径注意**：官方能力备忘出自《Seedance 2.5》，而 E1 预注册记录的模型是 `Seedance_2.0_mini_lite`。
> 二者是否为同一受控能力尚未确认 → **待核实**（引用能力数字时务必同时标出所据来源与日期）。

## 2. 输入哈希契约（`PRD-v2.md` §3.8）

`input_hash = SHA256(canonical_json(payload))` 前 16 位；canonical JSON = 键排序 + 无空白 + 数值最简形式。
**每个 stage 一份完整 payload，三个 stage 互不继承，未出现的字段一律不入 hash。**

| stage | payload 字段（写死） | 实现入口 |
|---|---|---|
| keyframe | `{schema_version, stage:'keyframe', resolved_prompt, refs[{role,content_digest}], model, params:{ratio,resolution}}` + 按存在性追加 `style_guide_digest` / `continue_from` | `computeShotKeyframeHash(shot,{schemaVersion,styleGuideDigest,upstreamTail})`（`tools/build-manifest.js:488`） |
| video | `{schema_version, stage:'video', resolved_prompt, refs, model, params:{ratio,resolution,requested_video_duration}}` + `first_frame`（恒有）+ `style_guide_digest` | `computeShotVideoHash(shot,{schemaVersion,styleGuideDigest,keyframeDigest,keyframeMode})`（`tools/build-manifest.js:515`） |
| tts | `{schema_version, stage:'tts', dialogue_text, voice_id, provider:{name,model,version}, tts_params, style_guide_digest?}` | `computeStagePayloadHash({...st,stage:'tts'})`（`tools/build-manifest.js:431`） |

**四条容易踩错的规则**：

1. **`refs[].hash_role` 是命名空间**：`location:<id>`、`character:<cid>`（保持 `shot.characters` 顺序）、
   `shot.references[<i>]`；**数组顺序参与 hash**（顺序 = prompt 中 `<image N>` 的引用顺序）。
   `role` 人类可读文案仍用于 prompt 注入，不参与 hash。实现：`collectImageRefs()`（`tools/build-prompt.js`，每项返回 `{path, role, hash_role}`）。
2. **`keyframe_mode` 决定 keyframe 进 `first_frame` 还是 `refs`**：`manifest.keyframe_mode`（缺省 `'reference'`）；
   `reference` → `first_frame:null` 且 keyframe 以 `{role:'keyframe:selected', content_digest}` 进 `refs`；
   `first_frame` → `first_frame:digest` 且 refs 不含该图。
3. **continue_from 上游尾帧进 hash**：keyframe 任务派发时把上游 selected video take 的尾帧冻结为
   `{role:'upstream_tail:continue_from', cut_frame}` 追加进 keyframe-stage refs；因尾帧在派发时才知道，
   以**不含尾帧的 base hash** 对齐 `shot.keyframe_hash`，任务另存 `task.base_input_hash`。
4. **identity 不入 hash**：本地绝对/相对路径、`task_id`、`take_id`、时间戳、reviewer、attempt/breaker 事件、
   配额元数据、`padding_frames`/`output_duration` 全部排除。**跨对象绑定一律用 content digest，不用 take id**。

**为什么**：缓存键 = payload canonical JSON，换 provider/model/version 必须 miss；
内容等价（改路径/改 take id）不得产生假失效；内容变更必须引起**一跳失效**（keyframe selected 变更 → video `input_hash` 变化）。
落地：`computeStagePayloadHash`（`tools/build-manifest.js`）、`render-next` 派发前用**冻结副本路径**重算核对的 FIX3-1
（`tools/render-next.js:692`，错误消息含 `input fingerprint mismatch` 与 `rebuild manifest before dispatching`）。

## 3. 提示词工程

### 3.1 结构化提示（来源：Veo 视频生成提示词指南）

Google 的建议是把创意拆成**主体 / 动作 / 场景 / 镜头运动 / 光线 / 风格**等构件分别描述，
不必每次都用到全部构件，但理解每个构件的作用能有效引导模型（来源：https://cloud.google.com/vertex-ai/generative-ai/docs/video/video-gen-prompt-guide ，访问 2026-09-14）。
该页面的小节名可核验为：`Subject`、`Action`、`Scene or context`、`Camera angles`、`Camera movements`、
`Lighting`、`Visual style & aesthetics`、`Ambiance`、`Tone or mood`、`Audio`、`Temporal elements`、`Negative prompts`。

| Veo 构件 | 本项目字段 | 说明 |
|---|---|---|
| Subject / Action / Scene | `shot.prompt_en` | 主体+动作+场景的主要叙述 |
| Camera | `shot.camera` | 镜头运动，独立字段 |
| Lighting / Style | `shot.style_en` | 光线与风格关键词，从 `style-guide.md` 词库人工选用 |
| 引用素材命名 | 角色 `appearance_en` / 场景 `appearance_en` | 由 `build-prompt.js` 自动拼到 prompt 尾部并编号为 `<image N>` |

**本项目拼装顺序（写死）**：`[shot.style_en] + [shot.camera] + shot.prompt_en + [角色 appearance_en] + [场景 appearance_en]`。
`tools/build-prompt.js` 输出最终英文 prompt 到 stdout；`no_style_inject: true` 时跳过 `style_en` 与 `camera`。

### 3.2 图生视频的连续性写法（来源：Gemini 视频生成文档）

视频生成分「文生视频」与「图生视频」两条路径，图像可作为首帧输入并受时长/分辨率/宽高比等参数约束。
（来源：https://ai.google.dev/gemini-api/docs/video ，访问 2026-09-14）
**注意**：本次抓取的页面快照为概览页（页面自标 `Last updated 2026-06-30`），其中只列出
`Gemini Omni Flash`（默认视频生成模型，多输入推理、角色一致性）与 `Veo 3.1`（场景延展、末帧控制等），
**未包含**具体的时延/分辨率/宽高比参数表 → 本节的参数细节标「**待核实**」，以本项目实测为准。

**本项目的可核验实测（替代外部参数表）**：
- 图作为首帧：只有 `--generate-type 1`（首尾帧同图）锁定 frame0（校准 SSIM 0.9275）；
  单图参考 B 组 SSIM 0.5510，无图 C 组 0.2550 → **参考图 ≠ 首帧**。
- 连续性：`continue_from`（弱承诺）只把上游尾帧作为参考图，**不触发任何截断/删帧/时长调整**；
  `cut_join`（强承诺）才触发截断/删帧，且删帧数由接头 SSIM 决定（`PRD-v2.md` §3.3）。
- 负向约束：平台支持「不要字幕 / 不要 bgm」类负向控制；E1 统一加「不要字幕」以减少叠加元素对 frame0 的干扰
  （来源：`experiments/e1/pippit-seedance25-capabilities.md`）。

### 3.3 负向约束写法

Veo 指南建议**描述你不想要的东西**（例如 `wall, frame`），而**不要**用 `no walls`/`don't show walls`
这类指令式措辞（来源：https://cloud.google.com/vertex-ai/generative-ai/docs/video/video-gen-prompt-guide ，访问 2026-09-14）。
本项目落在 `shot.prompt_en` 的负向短语与平台负向控制位上；`style-guide.md` 的 `injection_rule` 标记了 `style_en` 的人工注入口径。

### 3.4 E1 实测事实（决定能否承诺首帧）

| 事实 | 数值 | 来源 |
|---|---|---|
| `--generate-type 1` 首尾帧同图 | 校准 A′ median 0.9275（0.9155–0.9398） | `experiments/e1/calibration-2026-09-14.md` |
| prompt 首句「图片 1 为首帧」@720p | 0.5046 / 0.4940 → **不锁 frame0** | 同上；`PRD-v2.md` §0 v2.11 |
| 同上 @480p | 0.4238 / 0.4224；输出仍 1254×720 | 同上 |
| 结论 | E1 的 A 组以 `generate_type=1` 定版；prompt 声明仅适用 web R2V 通道 | `experiments/e1/preregistration.json` `params_position` |

**未取得「首帧约束」资格前，一切文案按「参考图引导」表述；禁止把「参考图输入」写成「首帧锁定」**（`PRD-v2.md` §3.2）。

## 4. 素材上限与画幅

| 约束 | 值 | 落地 |
|---|---|---|
| 图片素材 | ≤30 张（4K） | `refs[]` 规模须在上限内（`PRD-v2.md` §3.8） |
| 视频素材 | ≤10 段（总 30s） | 同上 |
| 音频素材 | ≤10 段（总 30s） | 同上 |
| 请求时长 | 单次 1–30s（1s 粒度） | `duration_value_range`，来自 E1 报告（`PRD-v2.md` §3.4） |
| 画幅两级收敛 | `series.yaml seedance_defaults.ratio` → episode `script.yaml defaults.ratio` → `'16:9'` | `PRD-v2.md` §3.7；shot 级 ratio 不一致默认报错（`allow_mixed_ratio` 逃生门） |
| cover-crop 预处理 | 先按视频帧宽高比中心 cover-crop，再 resize 512×512 | `e1-report.js` 的 `DEFAULT_PREPROCESSING`（新增 `cover_crop: to_video_aspect`）；实测 0.328→0.769（A′ seed-1），直接 resize 时 A/B/C 全塌到 0.23–0.33（`experiments/e1/smoke-2026-09-14.md`） |

## 可执行检查

```bash
cd /Users/wangpeng/workspace/shows

# 1) build-prompt CLI 存在且可用（真实 shot id: s01-shot-01）
node tools/build-prompt.js episodes/S01E01-pov s01-shot-01 | head -3

# 2) 纯函数入口：refs 的 hash_role 与 stage payload
node -e "
const bm=require('./tools/build-manifest');
console.log(typeof bm.computeStagePayloadHash, typeof bm.computeShotVideoHash, typeof bm.computeShotKeyframeHash);
const bp=require('./tools/build-prompt');
console.log(typeof bp.buildPromptForShot, typeof bp.collectImageRefs);
"

# 3) 零成本剧本校验（会检查 ratio/continue_from/voice/intent/video spec）
#    注：episodes/S01E01-pov 是 legacy v1 稿，会报缺 schema_version 等错误（exit 4），属预期
node tools/validate-script.js episodes/S01E01-pov --json | head -c 400

# 4) 预注册阈值与接口版本（能力承诺的前提）
node -e "const p=require('./experiments/e1/preregistration.json');console.log(p.meta.interface_version,p.meta.params_position,p.meta.delta_preregistered,p.meta.ssim_abs_min)"

# 5) 素材上限/画幅写死在 PRD（抽查）
grep -n "图片 ≤30\|allow_mixed_ratio\|cover_crop" PRD-v2.md | head
```
