# PRD — shows 流水线 v2：从「能拼出一集」到「能发布一集」

- 版本：v2.13（**FROZEN（2026-09-14）** — TTS provider 定版：`doubao` / `seed-tts-2.0`（豆包语音合成模型2.0，标准音色；弃用 ICL 音色复刻）；v2.12 为 cut_join 口径修订）
- 日期：2026-09-14（v2.7：2026-09-14；v2.3：2026-09-13）
- 对标调研：LocalMiniDrama、ViMax、阿里 LumenX
- 范围：在现有 script.yaml → manifest → 串行渲染 → ffmpeg 拼集架构上**增量演进**，不重构、不加 GUI、不引入数据库。

## 0. 版本修订记录

**v2.13（TTS provider 定版，2026-09-14）** TTS 使用**豆包语音合成模型2.0**（`resource_id/model = seed-tts-2.0`，标准音色），**弃用 ICL 音色复刻**（`seed-icl-2.0` / `volcano_icl`：复刻音色资源未授权且字符包不可共用，实测见 ai-course runbook）。§3.5 tts payload 示例 provider 更新为 `{name:'doubao', model:'seed-tts-2.0', version:'2026-09-14'}`；缓存键仍为 payload canonical JSON，换 provider/model/version 必须 miss。

**v2.12（口径修订，2026-09-14）** cut_join 相邻性校验与接镜处理（截断/删帧/CFR）的执行点明确为 **build-timeline**（时间线生成时 fail-closed）；edit/stitch 导出前复查 bound approval record。原文 "build-manifest 报错" 与流水线顺序矛盾（manifest 先于 timeline 生成），实现与 README 已按本口径。

**v2.11（实测更正，2026-09-14）** 直连 CLI 验证（4 次）：1) prompt 首句「图片 1 为首帧」在参考模式下**不锁 frame0**（720p SSIM 0.50/0.49，与参考图位同级；480p 0.42），而 `--generate-type 1`（首尾帧同图）锁定（校准 0.9275）→ **E1 A 组以 `generate_type=1` 定版**；2) `--resolution 480p` 未被模型采纳（输出仍 1254×720，成本无差异）→ 480p+超分仅限 web「沉浸式短片」工具，不走直连路径，E1 固定 720p。

**v2.10（接口事实修订，2026-09-14）** 依据小云雀《Seedance 2.5 关键更新速览》（wiki `W5tHwoZIDi12dbk2z3KcFkuUnsf`，revision 2777）补入：单次生成 1–30s、超长 5min；首/尾帧走 R2V prompt 首句声明（参考图不能当首帧）；口型同步手册示例支持（待 M1 实测复核）；480p+超分降本路径；素材上限（图≤30/视频≤10/音频≤10，总 30s）。摘要见 `experiments/e1/pippit-seedance25-capabilities.md`。

**v2.9（口径修订，2026-09-14，已批准）** E1 预处理从「输入图与首帧各自直接 resize 512×512」改为「先按视频帧宽高比做中心 cover-crop，再统一 resize 512×512」——实测方图输入 vs 16:9 视频时，直接 resize 会因形变不均使 SSIM 失去区分度（A/B/C 均 0.23–0.33）；cover-crop 后 A′ 0.77 vs B/C 0.23。同步更新 `tools/e1-metrics.js`、`e1-report` 的 `DEFAULT_PREPROCESSING`（新增 `cover_crop: to_video_aspect`）与预注册模板。

**v2.8（评审修订版）** 修正成功回调幂等键：每次派发记录 `attempt_id` + 供应商 `request_id`；成功回写按 `(request_id, content_digest)` 幂等，**与 task 解耦**；同 task 不同 request 各自成 take、各计消耗；本地路径只是定位信息，不参与冲突判定。附录增 A9（请求 1 超时→请求 2 发出→两者先后成功）。

**v2.7（评审修订版）**

**v2.6（评审修订版）**

**v2.5（评审修订版）**

**v2.4（评审修订版）**

第五轮评审指出「需求之间互相冲突」，本轮逐条修订；每条给出落点，不改既有不变量语义：

| 评审项 | 修订落点 |
|---|---|
| P0 参考图输入被等同于首帧锁定 | §3.2 新增「两种承诺模式」表；分层不变量按模式条件化；E1 报告（接口/版本/参数位/duration 值域/最大 padding/lip-sync）列为 M3 硬前置 |
| P0 音轨偏移按原始 take 时长 | §3.6 明确逐 clip 实例按 output 帧位计算（含入出点裁切/上游截断/删帧/padding/spill/跳镜/重复引用）；§3.4 spill 同步引用 |
| P0 对白时长与溢出策略冲突 | §3.4 重写：估时仅预警；T / D / max_padding 定义写死；策略适用条件与优先级；final 仅拒绝未解决溢出 |
| P1 连续性对剪辑过强假设 | §3.3 明确只有 cut_join 相邻片段触发截断/删帧；continue_from 永不触发；不假设 keyframe == 上游尾帧 |
| P1 人工接受缺版本绑定 | §3.3 bound approval record（digest + 语义参数 + 四要素）已覆盖；本轮补充全部导出入口统一检查的硬规则 |
| P1 重试计数口径 | §3.5 明确 attempt 事件不写 take；三维熔断窗口全部 epoch 化；unblock 重置三维窗口并保留历史 |
| P1 兼容承诺与新规则冲突 | §3.7/§5/§6 增加 schema 适用范围；迁移矩阵展开（等值 ratio/异值/混合/无 keyframe 封面/stage 补齐） |
| P1 实施前提未成立 | §1/§3.0 明确「具名测试 + 可复现命令输出」为唯一验收证据 |
| 连续性指标收紧 | §3.3 验收补充采样口径、静止镜头分母、机器告警不替代人工四要素 |
| 配额收益收紧 | §4 明确请求数不等于省钱；按阶段实际消耗 + per-accepted-shot 成本同口径对比 |
| 发布规格收紧 | §4 补充真峰值/静音段/字幕逐句/字体回退/换行/安全区/最终探测；断言语初来源版本日期 |

实施顺序按评审建议重排（§7）：M0 → E1 + 时间线契约 → stage/任务/迁移 → keyframe → 连续性 → 声音与发布交付。

**v2.3（冻结版）**
1. E1 判定改为可验收的统计契约（主/辅指标、成对实验、bootstrap CI、多场景、Δ 预注册），废弃「位置哈希」改为 pHash/LPIPS。
2. 新增 §3.8 **input fingerprint 总契约**：canonical JSON 的字段清单、排除清单、identity 与 content digest 分离（禁止 hash take id）。
3. §3.6 时间线引入 **clip_id 片段实例**，所有发布层对象只引用 clip 实例；硬规则「上一镜/下一镜/邻接语义均指 timeline clip instance」。
4. `cross_shot` 重定义为 **dialogue_spill**：只允许音频跨剪切点，不改变任何视频 clip 时长/in/out。
5. 修复熔断三口径冲突：三维度改为「同 task hard≥3 / 同 task transient≥10 / 同 shot 失败执行周期≥5」，引入 `breaker_epoch`。
6. 迁移改为显式 `migrate-episode --to 2`；`--final` 只读 schema_version，发现 v1 时提示不自动升级。
7. 新增 **late/stale callback 处理规则**（§3.5）：late success 记 artifact 但不得自动 selected，作为 superseded take。
8. M0 补两条测试：原子写故障注入、stale callback 不污染 selected state。
9. 其余收紧：offset 统一 canonicalize 为帧号、输出强制 CFR、continue_from 增 cycle/self-reference 检测、keyframe 状态机与「至多一个 selected」约束、task 状态集合与唯一约束定义、音频输出规格固定（AAC/48kHz/stereo + LRA）、loudnorm 改为整条 program 两遍分析、成本公式固定且分母按 distinct shot、人工四要素验收落为 machine-readable 的 **bound approval record**（与 accept-upstream 统一机制）、M4 拆 M4a/M4b（v2.4 已重排为 M0–M5，见 §7）、新增 §5 Release Gate（语义确定性，不强求 byte-identical）。

**v2.2**：M0 基线、E1 门槛、时间线契约、连续性两层、确认版本绑定、事件流、schema version。
**v2.1**：首帧分层、keyframe→video 绑定、级联警告化、TTS 前置、熔断、ratio 收敛、发布硬性件。

## 1. 背景与问题

现有流水线已建立一组工程机制：manifest/catalog 双台账、take 生命周期状态机、input_hash 校验、冻结输入副本、原子写、`execFileSync` 调用 ffmpeg。这些是设计意图而非已验收基线（见 M0）；**验收只接受具名回归测试用例与可复现命令输出，叙事性描述（如「第一梯队」）不作为通过依据**。制作工艺层与发布硬性件缺口同前两版（P0：连续性、静帧先行、声音轨、字幕；P1：重试熔断、画幅）。

## 2. 目标与非目标

**目标**
1. M0：存量不变量缺陷全部关闭，以具名回归测试与可复现命令输出为证据（含故障注入与并发基础）。
2. E1 + 时间线契约：以预注册统计契约确认生成接口首帧能力（作为 §3.2 承诺边界），并先落地 clip 实例时间线契约（先契约后混音）。
3. 任务快照/attempt 事件流/熔断/unblock + schema 迁移：重试与回调可审计、可续跑、可迁移。
4. 视频配额优先花在构图已锁定的 shot；收益以固定公式的成本指标**同口径**验证，不以请求次数代替成本证据。
5. keyframe 阶段：按 E1 结论在「参考图引导 / 首帧约束」两模式间显式选择，不得默认承诺首帧锁定。
6. 连续性：区分参考依赖与 cut_join 动作接镜，接头人工验收落为版本绑定记录。
7. 声音与发布：对白时长参与决定镜头长度（估时仅预警）；音频只以 dialogue_spill 跨剪切点；成片规格（音轨/字幕/封面/响度/封装）全部基于 clip 实例时间线。

**非目标**
- GUI/画布/Electron、多模型适配层、多 agent 编排、时间线编辑器、ducking、letterbox 混比策略。
- 不改变既有不变量的语义，只修复实现缺陷并增补。
- `--final` 不承担数据迁移（见 §6）。

## 3. 需求详述

### 3.0 M0 — 基础不变量修复与回归验收（阻塞所有后续）

| 缺陷/测试 | 验收 |
|---|---|
| 审核拒绝的 take 被放行进成片 | validateTake 对 rejected 终态用例：`--final` 拒绝 |
| 任务重复登记 | render-next 幂等性测试：同 shot 重复调用只返回一条 active task |
| manifest/catalog 不一致时静默继续 | 冲突报错 + 恢复指引 |
| **原子写故障注入** | 在 tmp 写入与 rename 之间模拟 crash（注入点可配），重启后不残留半写 JSON/YAML，读取侧能识别并丢弃损坏文件 |
| **stale callback 不污染 selected state** | 模拟旧 task（输入已变更）的成功回调：不改变 current task、不产生 selected、作为 superseded take 记录 |

交付物：修复 + `npm test` 回归套件。**M0 未全绿不开工后续里程碑。** 验收证据 = 具名回归测试用例 + 可复现命令输出；不接受仅文字说明。

### 3.1 E1 — 首帧能力实验（§3.2 前置门槛，统计契约）

**主指标**：输入图与视频第 0 帧的 SSIM。
**辅指标**：pHash 汉明距离、LPIPS（二选一即可，但必须写明实现与参数版本）。「位置哈希」废弃，不复用。

**实验设计**：
- A/B/C 三组（首帧参数位 / 参考图位 / 无图），**成对实验**：同一 prompt、相同随机种子策略，仅改变图的传入位置。
- 测试集分层：人物近景、人物全景、场景空镜、运动起始帧，各 ≥10 次；**至少 3 个不同场景素材**，不允许同一素材重复凑数。
- **bootstrap 以 scene/prompt pair 为 cluster 重采样**；同 scene 下不同 seed 是 cluster 内重复观测，不作为独立采样单元（防伪重复）。
- **阈值预注册**：Δ（A 组相对 B/C 的 SSIM 中位数提升量）在首次校准实验后、**查看正式实验结果前**冻结（建议初值 0.1），写入实验报告后不可再改。

**判定「首帧约束成立」需同时满足**：
1. A 组 SSIM 中位数较 B、较 C 均提升 ≥ Δ；
2. A−B、A−C 差值的 bootstrap 95% CI 均不跨 0（bootstrap ≥1000 次重采样）；
3. 上述条件在每个测试层（近景/全景/空镜/运动）分别满足，或至少在人物相关两层全部满足且其余层无反向显著；
4. **A 组绝对质量门槛**：A 组 SSIM 中位数 ≥ `ssim_abs_min`（预注册，与 Δ 一同冻结）。仅「相对 B/C 有提升」不足以承诺首帧约束——若 A/B/C 都低，说明该参数位不具备可用首帧能力。

**预处理与度量口径（写死，v2.9 修订）**：
- 视频侧取第 0 帧；**先以视频帧的宽高比为基准，对输入图做中心 cover-crop**（宽比不一致时不得拉伸变形；视频帧自身按原样缩放）；
- 两侧再统一 resize 到同一边长（默认 512×512，双线性）、色彩空间统一到 sRGB/BT.709（记录所用变换）；不做锐化/对比度增强；
- SSIM 实现名 + 版本 + 参数（window/gaussian/K1/K2/data_range + `cover_crop: to_video_aspect`）记入报告；pHash/LPIPS 同口径且同样记录实现与版本；
- 解码失败帧、尺寸异常帧一律计为不合格样本并留在分母，不得剔除后报优。

**未达阈值一律按「仅参考引导」处理，不允许人工解释为「基本可用」。** 报告记录接口名、版本、参数位、日期；接口变更需重跑相应子项。

### 3.2 P0-2 静帧先行（keyframe 阶段）

**两种承诺模式（必须显式区分，不得混用）**：

| 模式 | 成立条件 | 承诺 | 不承诺 |
|---|---|---|---|
| **参考图引导** | E1 无「通过」结论（报告存在但未通过，或接口版本不一致需重跑） | keyframe 作为 video 的参考图之一进入 input_hash；构图/风格/主体一致性靠抽卡与人工审核 | **不承诺**输出视频第 0 帧与 keyframe 一致；不承诺帧级锁定 |
| **首帧约束** | E1 报告通过，且与当前接口版本一致 | keyframe 传入接口的首帧参数位；content digest 进入 input_hash；keyframe 变更 → 下游 video task 失效 | 仍以人工四要素与验收证据为准，不承诺模型内部无差异 |

> 未取得「首帧约束」资格前，一切文案、验收与收益承诺均按「参考图引导」表述；**禁止把「参考图输入」写成「首帧锁定」**。

**分层不变量（按模式条件化）**：
- 参考图引导：上游尾帧 → keyframe 输入之一（参考）；selected keyframe → video 的参考图之一；video 不接收上游尾帧作为首帧参数。
- 首帧约束（E1 通过时）：上游尾帧 → keyframe 输入之一；selected keyframe → video 唯一首帧来源；video 不接收尾帧。

**keyframe 状态机**（写死）：
- take 状态：`candidate → selected | rejected`；`rejected` 为终态（与 v1 一致）。
- **每 (shot, stage=keyframe) 至多一个 selected**；从 selected A 改选 B 时 A 自动降为 candidate（不降 rejected），且依赖 A 的下游 video task 失效。
- `rejected → selected` **不允许**（终态语义），需重抽新 take。

**首帧绑定（仅首帧约束模式）**：video task 的首帧参数位传 selected keyframe，该图的 content digest 进入 input_hash（见 §3.8）；keyframe selected 变更 → video task 失效。

**官方首帧声明写法（小云雀 Seedance 2.5，来源：官方手册 2026-09-14）**：在参考模式（R2V）中把「图片 N 为首帧 / 图片 N 为首帧、图片 M 为尾帧」写在 **prompt 第一句**；**参考图（环境/风格）不能当作首帧**（手册示例明确）。

**实测更正（2026-09-14，直连 CLI）**：参考模式 + prompt「图片 1 为首帧」**不锁 frame0**（720p SSIM 0.5046/0.4940，与参考图位同级；480p 0.42）；而 `--generate-type 1`（首尾帧同图）锁定（校准 0.9275）。**E1 的 A 组以 `generate_type=1` 定版**；prompt 首帧声明仅适用于 web/沉浸式短片 R2V 通道，直连 CLI 路径不适用。

**E1 前置门槛（keyframe 阶段硬依赖）**：进入 keyframe 阶段前必须**完成能力评估并存在有效 E1 报告**（报告结论可以为「未通过」）；**只有首帧约束模式要求实验通过**（§3.1 判定全部满足），参考图引导模式只要求报告存在且与当前接口版本一致。报告必须记录：
- 实际生成接口名 + 版本 + 首帧参数位 + 实验日期；
- 接口支持的 duration 值域与最大可接受 padding（供 §3.4 使用）；
- lip-sync 能力复核（来源/版本/日期）；
- 接口或参数位变更 → 重跑相应子项；报告版本与当前接口不一致时，禁止进入首帧约束模式（可继续参考图引导）。

**schema**：episode 顶层 `require_keyframe`；catalog key 含 `stage ∈ {keyframe, video}`；迁移脚本为 M2 交付物（keyframe 阶段前置）。

**工具**：`render-next.js` 默认优先 keyframe-pending；`--video` 只返回 keyframe 已 selected（或 require_keyframe=false）的 shot；`mark-keyframe.js` 与 mark-shot 语义对称。

**验收**：
- rejected keyframe 对应 shot 不进 `--video` 队列；同 shot 出现两个 selected keyframe 被拒绝；迁移幂等；
- 参考图引导模式下：video task 的参考图集合包含 selected keyframe 的 content digest，且**禁止出现「首帧一致」类断言**；
- 首帧约束模式下：E1 报告版本与当前接口一致，video task 首帧参数位引用 selected keyframe 的 content digest。

### 3.3 P0-1 镜间连续性（依赖 keyframe）

**两层规则**：
- **视觉参考依赖（continue_from，弱承诺）**：keyframe 阶段引用上游尾帧作参考。仅要求上游顺序在前，不要求剪辑相邻。**校验三件套各有独立测试：self-reference reject、cycle detect、depth>3 reject**。
- **连续动作接镜（cut_join，强承诺）**：`cut_join: true` 表示本镜与上游在**最终时间线中相邻且动作连续**；时间线不相邻则 **build-timeline** 报错（v2.12 口径修订：manifest 阶段尚无时间线；edit/stitch 导出前复查 approvals）。

**触发边界（写死）**：只有 `cut_join` 接头才进入接镜处理（截断/删帧）；continue_from 永远只作视觉参考，**不触发任何截断、删帧或时长调整**；不得假设生成的 keyframe 与上游尾帧等值——是否删帧由实际接头比对（S）决定。

**offset 与帧基准**：`continue_from_offset` 以秒配置（默认 -0.1），**build-manifest 阶段 canonicalize 为帧号**（按 episode FPS 换算取整，记录换算残差）；截断帧、junction 比对帧、删帧数全部使用帧号，不混用秒与帧两套精度。

**接镜处理（仅对时间线相邻且 cut_join=true 的片段对，由实际接头决定）**：
- **帧号语义（半开区间，§3.6）**：上游 clip `[source_in, source_out)` 中**最后保留帧 = `source_out - 1`**；定义 `cut_frame := upstream.source_out`（边界帧，不在输出中）。
- **尾帧抽取与比对**：取 `upstream[cut_frame - 1]` 与 `downstream.source_in`（若已删帧则为删帧后的 `source_in`）做 SSIM。
- **删帧判定**：SSIM ≥ `same_frame_ssim_threshold`（S）→ 置 `deleted_head_frames = k`（k 由比对结果显式给出，默认 1）；否则 `deleted_head_frames = 0`。S 只决定「删不删」，不隐含删几帧；S 与连续性告警阈值 k 是两个独立阈值，**不得复用**。
- **删帧不修改 `source_in`**：`source_in` 始终保留原始裁切点；**实际首帧 = `source_in + deleted_head_frames`**。删帧数只参与输出时长公式一次（§3.6），不得叠加进 `source_in`。
- 所有 intermediate clip 先标准化 CFR（episode FPS 与像素格式统一）后再做删帧/截断，保证「删 1 帧」时长确定。
- **数值示例（24fps）**：上游 `[1920, 2112)` → `cut_frame = 2112`、最后保留帧 `2111`；下游 `[0, 480)`；比对 `upstream[2111]` vs `downstream[0]`；若 SSIM ≥ S 且决定删 1 帧 → `deleted_head_frames = 1`、**`source_in` 保持 0**、实际首帧 1；输出帧数 = `480 - 0 - 1 + 0 = 479`（公式见 §3.6）。

**失效级联与 bound approval record（统一机制）**：
- 自动失效只传一跳；更下游由 render-next 列警告。
- `--accept-upstream` 与 **cut_join 人工四要素验收**统一为一种机制：**bound approval record**，machine-readable 写入 manifest：

```yaml
approvals:
  - kind: accept_upstream | junction_review
    upstream_clip: clip-0012        # locator only：绑定的上游 clip 实例
    downstream_clip: clip-0013      # locator only：绑定的下游 clip 实例
    bindings:            # validity check 只使用 content_digest + 语义参数
      upstream:
        take_id: t06-3              # locator only，仅供定位与审计，不参与失效判定
        content_digest: sha256:...  # 上游视频 take 的内容摘要
        source_out: 2112            # 语义参数：截断边界帧（= cut_frame）
      downstream:
        keyframe:
          take_id: kf-07-2         # locator only
          content_digest: sha256:...
        video:
          take_id: t07-1           # locator only
          content_digest: sha256:...
        source_in: 0               # 语义参数：原始裁切点（删帧不改写它）
        deleted_head_frames: 1     # 语义参数：实际删帧数；实际首帧 = source_in + deleted_head_frames = 1
    verdict:             # junction_review 必填四要素
      subject: pass
      prop: pass
      action_phase: pass
      direction: pass
    reviewer: <agent|human>
    reviewed_at: <ts>
```

**硬规则**：validity check 只比较 digest 与语义参数（`source_out`/`source_in`/`deleted_head_frames`）；**clip_id / take_id 变了但 digest 与语义参数相同 → 记录仍有效**（禁止实现成 `if (clip_id !== new) invalidate()`）。同一 take 出现在多个 clip 时，由各 clip 的裁切/删帧参数区分，approval 必须绑定到 clip 实例。

- 绑定对象变更 → 记录失效，需重新确认；`--final` 与**全部导出入口**（edit-episode、stitch-episode、build_complete 等）统一检查未确认/已失效记录。

**验收**：
- **机器指标仅告警**：帧差 = 灰度 L1 均值；采样口径写死为「junction 前后各 1 帧 vs 下游片段等间距 ≥10 对」的中位数，比值 > `junction_warning_ratio`（质量阈值 k）时告警；静止镜头（片段内部差中位数 < ε）分母趋零，直接降级为仅人工验收；画面相似不能证明主体、持物、动作方向正确。S、k、ε 三个阈值在 M4 校准实验后、正式验收前冻结。
- **人工四要素是动作连续性的唯一权威判定**（subject/prop/action_phase/direction）；任一 fail 或告警未消 → junction 失败，`--final` 拒绝。
- self/cycle/depth 三种拒绝、approval 失效重确认、cut_join 相邻性校验均有用例；continue_from 用例必须验证「不触发截断/删帧」。

### 3.4 P0-3 声音轨（对白参与决定镜长）

**四个时长量（分离定义，不得混用）**：
- `nominal_duration`：剧本标称镜长（信息项，不直接发请求）；
- `requested_video_duration`：发给生成接口的请求时长，必须在 E1 报告的接口支持值域内（小云雀 Seedance 2.5：**单次 1–30s，1s 粒度**；超长模式原生直出最长 5min，E1 不涉及；来源：官方手册 2026-09-14）；
- `source_duration`：take 实际素材时长（ffprobe 实测，仅用于素材校验/入出点合法性）；
- `output_duration`：最终时间线 clip 输出时长 = `source_out - source_in - deleted_head_frames + padding_frames`（§3.6）；
- `padding_frames` **仅指后期静帧补长**；生成侧延长（requested 变长）与后期静帧延长是两件独立的事，**不得重复补长**。

**配置（分别设置，互不继承）**：
- 模型能力：`duration_value_range`（接口支持值域，取自 E1 报告）；
- 创作上限：`max_freeze_padding_frames`（后期静帧补长上限，episode 配置，**默认 0**，即默认不允许静帧补长）；
- `allow_trim`（**默认 false**）：对白截断必须创作者显式开启，**禁止默认自动删对白**。

**流程（估时不阻断）**：
1. 字数估时**仅预警**；TTS 实测对白时长后确定所需时长；
2. 若 `nominal_duration` 不足：优先在模型值域内请求更长（生成侧延长，`requested_video_duration`）；
3. 生成后若仍不足：按下方策略处理；只有「策略执行后仍未解决」的溢出才进入 final 拒绝。

**溢出策略（适用条件与优先级，写死）**：
1. `pad_freeze`（后期静帧）：溢出量 ≤ `max_freeze_padding_frames` 时，以尾帧静帧延长 `padding_frames`；默认 0 时不生效。
2. `trim`（**仅 `allow_trim: true` 时可用**）：对白从**尾部**截断，字幕同步截断并加 `…`；结果必须保持语义可辨（人工可听）。未开启 → 跳过本策略。
3. `dialogue_spill`（仅当下一 clip 实例满足约束时）：只移动对白音频跨越视觉剪切点，**不改变任何视频 clip 的 in/out 或时长**；溢出量记 `dialogue_spill_ms`。
4. `error`（以上均不适用，例如下一 clip 不存在、其 dialogue 非空或 spill 超限）：报错并要求改剧本。

**dialogue_spill 约束（计算基准统一）**：
- 「下一镜」= 最终时间线上下一 clip 实例；spill 起止一律按该 clip 的 **output 帧位**计算（§3.6），**不得按原始 take 时长累加**；
- 下一 clip 实例必须存在、其 dialogue 为空、且 `spill ≤ 该 clip 实际输出时长`；
- spill 起点不得落在 cut_join 接头帧上；有 SFX/music cue 落入 spill 段时 WARN（允许但留痕）；
- 同一 clip 的 dialogue 只能 spill 一次（**禁止链式对白 spill**）；B→C 的非对白音频事件不受 A→B spill 影响；
- spill 与 cover 无技术冲突（cover 是静态图像、spill 是音频时间关系），不设约束。

`--final` 拒绝的是「策略执行后仍未解决的溢出」；已解决（pad/trim/spill 成功）的溢出不算未解决。

**schema**：dialogue（voice id 在 build-manifest 解析，失败即报错）、结构化 `sfx: [{id, at, gain_db}]`、集级 music cue（可带 gain_db）。sfx/music 的 `at` 同样 canonicalize 到 clip 内帧号。

**TTS 产物与缓存**：产物落 `episodes/<id>/audio/`，记录实测时长；以 (文本 + voice id + 参数) 内容哈希缓存；TTS 阶段先于视频渲染。

**验收**：四种溢出策略（含 spill 的三项约束与禁止链式）各有用例；估时超限本身不报错；`pad_freeze` 超 `max_freeze_padding_frames` 必须转 spill/error（trim 需显式开启）而不是强行补长；`allow_trim` 未开启时不得删对白；`--final` 对未解决溢出报错；缓存命中。

### 3.5 P1 重试、熔断与回调（任务快照 + attempt 事件流）

**执行状态与有效期分离（写死）**：
- `task.status` 只表达**执行结果**：`active = queued | submitted | running | retry_wait`；`terminal = succeeded | failed | cancelled | blocked`；
- `task.superseded_at`（null = 仍是当前有效版本；非 null = 已失效，可附 `superseded_by` locator，新任务未知时为 null）独立持久化「已不是当前有效版本」这一事实；
- **任务资格**（render-next 复用、late artifact 的 orphan 判定）读 `superseded_at`；**素材资格**由 take 状态 + validateTake 决定；两者分离，失效历史永不清除（见下方人工恢复）；
- 兼容：旧数据 `status === 'superseded'` 等价于「执行结果为 cancelled/succeeded + `superseded_at` 非空」，迁移时归一化（见 §6）。

**状态转换表（写死）**：
- 失败上报分两类：**可重试失败**（默认：hard 与 transient 都进入 `retry_wait` 累计）与**最终失败**（显式 `--terminal` 才进入终态 `failed`）；未列出的转换一律拒绝。

| 当前 | 事件 | 下一 | 附加字段 / 说明 |
|---|---|---|---|
| — | 创建任务快照 | queued | 写入 `input_hash`；`(shot_id, stage, input_hash)` 至多一条**可调度 active** |
| queued | 派发 | submitted | ledger `requests += 1` |
| submitted | 首帧/进度回调 | running | — |
| queued / submitted / running | 可重试失败上报（hard 或 transient，未触发熔断） | retry_wait | attempt 事件（kind 保留）+ `retry_after`（60s 指数，上限 15min）；hard 不立即终态，便于同 task 累计 |
| retry_wait | `retry_after` 到期 | submitted | 计一次真实 request |
| running / submitted | 成功回调 | succeeded | `completion = normal | late` |
| retry_wait | 成功回调（超时/失败后到达） | succeeded | `completion = late`；不自动 selected |
| running / submitted | 成功回调（首次到达的 `request_id`） | succeeded | 新增 take；`completion = normal` |
| retry_wait / failed | 成功回调（属于本 task 的历史 `request_id`） | succeeded | `completion = late`；新增 take；不自动 selected |
| succeeded | 成功回调（同 task 的另一个 `request_id`） | succeeded | 新增独立 take；产物与实际消耗各计一次；不自动 selected |
| 任意 | 成功回调：同 `request_id`、同内容摘要 | 保持当前 | 幂等返回既有 take；不新增素材、不重复计账 |
| 任意 | 成功回调：同 `request_id`、不同内容摘要 | 保持当前 | 冲突留痕（conflict 事件）；不覆盖；**仅内容摘要判冲突，本地路径不同不算冲突** |
| blocked / cancelled | 成功回调（任意 `request_id`） | 保持 blocked/cancelled | orphan take 入 catalog；不自动 selected；事件记 `callback_received{late, after_terminal}`；不复活任务 |
| queued / submitted / running / retry_wait | 最终失败（显式 `--terminal`） | failed | 终态；不再接受新 attempt |
| 任意 active | 熔断触发（三维任一） | blocked | task + shot 置 blocked；只能用 `--unblock` 释放 |
| 任意 active | input_hash 变更 | 保持执行状态 | 仅表示执行事实，**移出调度集合**（`retry_after` 到期不重派发、render-next 不复用）；置 `superseded_at` + `superseded_by`；不 cancel 已提交请求 |
| 任意 active **或 blocked** | `--unblock` | cancelled | epoch +1；三维窗口重置；blocked 任务由此释放 |
| failed / cancelled / succeeded | 新 attempt 上报 | 拒绝 | 终态（late success 不是新 attempt，走上表 succeeded 行） |

**唯一性约束与调度集合（写死）**：
- **可调度 active 集合只含 `superseded_at == null` 的任务**；`(shot_id, stage, input_hash)` 至多一条**可调度** active task。
- `superseded_at != null` 的任务永久移出调度集合：即使 status 仍为 `retry_wait`/`submitted`（外部请求还在跑），也**不得被 render-next 复用、`retry_after` 到期不得重派发**；执行事实与回调照常保留（按 late 规则入库）。
- **hash 复现（A→B→A）**：旧 A 保持失效历史；调度侧按当前 input_hash 新建任务快照（`superseded_at=null`）；若旧 A 已有成功产物，可按 `reuse_records[]` 恢复素材（见人工恢复），不因此复活旧任务。

**attempt 事件流**：每次**派发**记录 `attempt_id`（本地）+ 供应商 `request_id`，并追加 `{task_id, attempt_id, request_id, n, kind: hard|transient, error, at, retry_after}`；失败上报按 `attempt_id` 幂等（兼容历史 `(task_id, n)`），计数由事件流派生。**成功回写按 `(request_id, content_digest)` 幂等，与 task 解耦**。**失败 attempt 不创建 take/artifact**；take 只在成功回调时产生（不得把请求尝试与素材混为一谈）。

**超时**：先按 task_id 查询原任务状态，不得直接重发；查无才记 attempt 可重试。

**late/stale callback 规则（v2.3 冻结版修订：late 是完成时机属性，不是第六种状态）**：
- task 状态仍只有上表集合；late 表达为 `task.status = succeeded` + `task.completion = normal | late`（事件流记 `callback_received {late: true}`）。
- 查询口径写死：`terminal success = (status == succeeded)`；`usable success（任务级复用）= (status == succeeded) && task.superseded_at == null && task.input_hash == 当前 input_hash`。**素材资格另由 take 状态 + validateTake 判定**（见下方人工恢复）。
- 请求超时/失败后到达的成功回调：task 置 `succeeded + completion=late`（`failed` 终态也允许这一条）；若该 task 的 `superseded_at` 非 null（或 input_hash 非当前）→ artifact 照常落盘并入 catalog，但只能作为 orphan/superseded take，`--final` 不可用；**不得自动 selected**；
- **superseded 素材的人工恢复（写死，不改写历史字段）**：
  1. 仅当 `take.input_hash === 当前 input_hash`（fingerprint 复现）时，允许 `--select` / `--review accept` 恢复该 take；
  2. 恢复动作在 manifest 追加 `reuse_records[]`：`{take_id, source_task_id, source_artifact_digest, bound_input_hash, reason: "fingerprint_recurrence", at}`；
  3. 原任务的 `superseded_at` / `superseded_by` **保持不动**（失效历史永不清除）；素材资格由 reuse record 恢复：存在 `bound_input_hash === 当前 input_hash` 且 `source_artifact_digest` 与 take 内容摘要一致；
  4. fingerprint 不相符 → 一律拒绝；不得通过清除 `superseded_at` 绕过。
- **成功回调的幂等键是供应商 `request_id`，不是 task**：
  - 同 `request_id`、同内容摘要 → 幂等返回已有 take；不新增素材、ledger 不重复计；
  - 同 `request_id`、不同内容摘要 → 冲突留痕，不覆盖既有 take；**本地路径只是定位信息，路径不同但摘要相同不算冲突**；
  - 同 task、不同 `request_id`（重试后另一次真实请求）→ **各自独立 take**，产物与实际消耗各计一次，不自动 selected（同 task 可有多份合法产物）。
- **blocked / cancelled 后的迟到成功**：artifact 照常入 catalog 为 orphan take，任务状态不复活（避免熔断/操作状态被回调污染）；确需使用的，走 fingerprint 复现 + `reuse_records[]`。

**熔断（v2.3 修复口径冲突）——三个维度分别定义**：

```text
同 task（同 input_hash）: hard attempts      ≥ 3  → blocked
同 task（同 input_hash）: transient attempts ≥ 10 → blocked
同 shot 跨 input_hash  : 发生过 ≥1 次 hard attempt 的任务快照数 ≥ 5 → blocked
```

- 同 task 的 hard 与 transient 都先进入 `retry_wait` 累计；只有显式 `--terminal` 或熔断才终止任务。第三维**计「发生过 hard failure 的任务快照数」，不计 attempt 总数，也不要求任务终态是 failed**：任务可以是 retry_wait、failed 或 `superseded`（hard 失败后改稿导致失效）；同一任务多个 hard attempt 只计 1 次。它防的正是「hard 失败一次 → 改稿换 input_hash → 旧任务清零」的绕过。
- transient ≥10 与 hard ≥3 都在 `retry_wait` 上累计，不产生终态 failed；shot 级维度只计 hard-failure 任务快照，transient 不产生该快照。
- 引入 `breaker_epoch`：每次 unblock +1；**上述三个维度的统计窗口全部 epoch 化**（= 当前 epoch 内的事件/任务）；历史事件与旧任务全量保留供审计。
- `mark-shot --unblock`：epoch +1、**释放 active 与 blocked 任务（→ cancelled）**、同时重置三维计数窗口；限流识别用内置正则表，`--transient` 人工覆盖记入事件流；retry_wait 由 `retry_after`（60s 起指数，上限 15min）驱动。

**验收**：三维度熔断独立用例；**连续三次 hard failure（同 task）→ 第 3 次触发 blocked，中途不进入 failed**；transient 10 次在无 hard 失败时仍可触发；5 个不同 input_hash 的 failed task（或 hard-failure 快照）触发第三维；**「hard 失败一次 → 改稿换 input_hash → 新任务」循环五次（旧任务已 superseded）必须触发第三维**；**`--terminal` → failed；failed 后 late success → succeeded + completion=late 且不自动 selected**；**blocked → `--unblock` → cancelled 并释放**；superseded 素材 fingerprint 复现 → `reuse_records[]` 恢复且原 task 失效历史不变；失败 attempt 不产生 take；unblock 后三维窗口同时归零且历史可查。

### 3.6 剪辑时间线契约（clip 实例为唯一发布基准）

正式导出前构建最终时间线：

```yaml
timeline:
  fps: 24                # episode 统一；所有 clip 先 normalize 到 CFR
  clips:
    - clip_id: clip-0001          # 唯一片段实例 ID
      shot_id: s01
      take_id: t12
      source_in: 0               # 帧，含
      source_out: 192            # 帧，不含（已含接镜截断 cut_frame）
      deleted_head_frames: 1     # cut_join 删帧，由接头比对决定
      padding_frames: 0          # 后期静帧补长（pad_freeze）
      spill_in: [{dialogue: d01, ms: 340}]   # 上游 spill 进本 clip 的对白（只做音频映射）
      # duration_frames = 192 - 0 - 1 + 0 = 191
      output_start: 0            # 帧，含
      output_end: 191            # 帧，不含（= output_start + duration_frames）
    - clip_id: clip-0002
      # ...
      output_start: 191          # = 上一 clip 的 output_end
```

**硬规则（一次性统一，全系统适用）**：所有 frame range 均为 **start-inclusive / end-exclusive 半开区间** `[start, end)`，`duration_frames = end - start`。字幕 offset、spill、cut frame、deleted head frame、A/V <100ms 验收全部按此口径，不使用闭区间。

**硬规则**：
- **凡涉及「上一镜/下一镜/邻接/偏移」的发布阶段语义，均指 timeline clip instance，不指 script 数组相邻项。** cross_shot/dialogue_spill 的「下一镜」= 时间线上下一 clip 实例。
- 同一 take 可被多个 clip 实例引用（重复/乱序）；字幕、SFX、对白、spill、cover、debug 全部只引用 clip_id 或 timeline 帧位。
- 音轨/字幕偏移一律按 clip 实例的 output 帧位计算；原始 take 的 ffprobe 时长仅用于素材校验。
- **输出时长公式（写死）**：`output_frames = source_out - source_in - deleted_head_frames + padding_frames`；`output_start`/`output_end` 按时间线顺序连续（首 clip 从 0 起）。
- `source_out` 是**已含接镜截断**的素材边界（§3.3 的 `cut_frame`），截断不再二次扣减；`padding_frames` 只指后期静帧补长。
- `spill_in` **只影响音频映射，不进入视频时长公式**。
- **偏移计算基准（一次性写死）**：clip 的实际输出区间 = f(source_in/out（已含接镜截断）、deleted_head_frames、padding_frames、时间线顺序)；跳镜（非相邻引用）与同一 take 的重复引用一律各自独立计算，**不沿用原始 take 时长与 script 相邻关系**。

**混音与响度**：per-cue gain → amix → **对整条 program audio 做两遍 loudnorm**（不做分段 gain compensation；静音段不单独处理）。整集无有效非静音样本则跳过 loudnorm 并 WARN。`--preview` 有什么混什么 + WARN 清单。

**验收**：≥20 镜、含 cut_join/删帧/padding/spill 的整集，最后一镜对白偏移误差 <100ms；同一 take 两个 clip 实例时字幕/sfx 各归其位。

### 3.7 P1 画幅（episode 级收敛）

- **适用范围**：`schema_version >= 2` 的 episode；schema 1 集在迁移前维持 v1 行为（见 §6），不因本节规则被拒绝重建。
- ratio 仅 series → episode 两级，shot 级默认拒绝；`allow_mixed_ratio` 为显式逃生门；9:16 模板随 M1。
- 迁移时：shot ratio 与 episode ratio 等值 → 删除该覆盖；不等值 → 人工裁决（改 shot 或设 allow_mixed_ratio）；混合画幅在 manifest 按 clip 记录实际 ratio。

### 3.8 Input fingerprint 总契约（v2.3 新增）

**`input_hash = SHA256(canonical_json(payload))`**，canonical JSON 规则：键排序、无空白、UTF-8、数值不带尾零。

**stage 输入契约（每个 stage 一份完整 payload；三个 stage 互不继承，未出现的字段一律不入 hash）**

**keyframe**
```json
{
  "schema_version": 2,
  "stage": "keyframe",
  "resolved_prompt": "……",
  "refs": [
    {"role": "location:abandoned-hospital", "content_digest": "sha256:..."},
    {"role": "character:protagonist-hands", "content_digest": "sha256:..."},
    {"role": "shot.references[0]", "content_digest": "sha256:..."},
    {"role": "upstream_tail:continue_from", "content_digest": "sha256:...", "cut_frame": 2112}
  ],
  "model": {"provider": "seedance", "id": "doubao-seedance-1.0-pro", "version": "2026-06-12"},
  "params": {"ratio": "16:9", "resolution": "720p", "keyframe_params": {"prompt_extend": false}},
  "style_guide_digest": "sha256:..."
}
```

**video**（自有 params，**不继承 `keyframe_params`**）
```json
{
  "schema_version": 2,
  "stage": "video",
  "resolved_prompt": "……",
  "refs": [
    {"role": "location:abandoned-hospital", "content_digest": "sha256:..."},
    {"role": "character:protagonist-hands", "content_digest": "sha256:..."},
    {"role": "keyframe:selected", "content_digest": "sha256:..."}
  ],
  "first_frame": null,
  "model": {"provider": "seedance", "id": "doubao-seedance-1.0-pro", "version": "2026-06-12"},
  "params": {"ratio": "16:9", "resolution": "720p", "requested_video_duration": 10, "first_frame_slot": "first_frame"},
  "style_guide_digest": "sha256:..."
}
```
- `first_frame`：首帧约束模式 = selected keyframe 的 `content_digest`；参考图引导模式 = `null`，此时 keyframe 以 `{"role": "keyframe:selected", ...}` 进 `refs[]`；
- `params` 为 video 自有集合；`requested_video_duration` 是唯一时长请求量，`padding_frames`/`output_duration` 不入 hash。

**tts**
```json
{
  "schema_version": 2,
  "stage": "tts",
  "dialogue_text": "……",
  "voice_id": "zh_male_...",
  "provider": {"name": "doubao", "model": "seed-tts-2.0", "version": "2026-09-14"},
  "tts_params": {"speed": 1.0, "emotion": "neutral"},
  "style_guide_digest": null
}
```
- TTS 必须含 provider/model/version：**缓存键 = 本 payload 的 canonical JSON**，换引擎/版本必须 miss（防止错误命中）。

**`refs[]` 契约（有序数组；顺序 = prompt 中 `<image N>` 的引用顺序，顺序参与 hash）**：
- 每个角色/场景/额外 reference/上游尾帧/keyframe 都必须以 `{role, content_digest}` 入列；
- `role` 命名空间写死：`location:<id>`、`character:<id>`、`shot.references[<i>]`、`upstream_tail:<continue_from|cut_join>`、`keyframe:selected`；
- 接口素材上限（小云雀 Seedance 2.5，2026-09-14）：图片 ≤30 张（4K）、视频 ≤10 段（总 30s）、音频 ≤10 段（总 30s）；`refs[]` 规模必须在此上限内；
- `content_digest` = 内容摘要；本地路径、take_id、task_id、clip_id 不入 hash；
- 默认值规则：`style_guide_digest` 无注入时为 `null`；`tts_params` 未配置的键不出现（不做隐式默认）；**实际请求参数必须能在 payload 逐一找到，反之 payload 中不存在的参数不得影响请求**（缓存键与请求参数一一对应）。

**不进入 hash 的字段**：

```text
created_at / task_id / reviewer / breaker 与 attempt 事件 / quota 元数据 / 本地绝对路径 / take_id
```

**identity 与 content digest 分离**：所有跨对象绑定（下游对上游、video 对 keyframe、approval record）一律用 **content digest**，不用 take id——take id 变了但内容相同不产生假失效；内容变了 id 没变必然失效。take id 只做 catalog 定位，不参与任何 hash。

**验收**：同内容不同 take id → hash 相同、下游不失效；仅改 reviewer/时间戳 → hash 不变；改 prompt/style-guide/上游内容 → hash 变、下游失效。

### 3.9 音频输出规格（v2.3 固定）

```text
codec: AAC；sample rate: 48 kHz；channel layout: stereo
loudnorm: I=-14 LUFS, TP=-1.0 dB, LRA target = 11（两遍分析）
封装与视频规格随 episode 模板固定（分辨率/FPS/pixel format），写入 manifest
```

平台/接口能力断言一律附来源、版本、验证日期。

## 4. 发布硬性件

**豁免由制作意图声明决定，不由输出缺什么决定（写死）**：
- `intent.dialogue`（布尔）：script 是否存在 dialogue；
- `intent.audio`：`none | dialogue | music_sfx | full`（缺省按 script 推导；**`none` 必须显式声明**）；
- `intent.subtitles`：`none | burn | soft | both`（edit.yaml 配置，缺省 `none`）；
- `intent.silent`（布尔，缺省 false）：整集无有效音频样本的显式声明；
- **声明了 dialogue / 字幕 / audio 而对应产物缺失 → 失败，不是豁免**；只有显式 `none` / `silent: true` 才产生豁免，且必须写入 manifest。

**判定公式（写死）**：
- `requires_subtitles = intent.dialogue || intent.subtitles != none`；**豁免条件 = !requires_subtitles**；
- `requires_audio = intent.audio != none`；**豁免条件 = !requires_audio**；
- `requires_loudnorm = requires_audio && !intent.silent`；`silent: true` 仅跳过 loudnorm，不豁免其余音频检查。

**配置校验（build-manifest 阶段拒绝矛盾声明，不得留到导出时猜优先级）**：
- 非法：`dialogue=true && audio=none`（有对白必须产出音频）；
- 非法：`dialogue=true && silent=true`（有对白不得声明全静音）；
- 非法：`dialogue=true && subtitles=none`（有对白必须产出字幕；确需无字幕应先改稿去掉 dialogue）；
- 合法：`dialogue=false && subtitles != none`（显式字幕意图，按需产出）；
- 合法：`audio=none && silent=true`（无音频项目的冗余声明，按 `audio=none` 归一化）。

| 项 | 内容 |
|---|---|
| 字幕 | 基于 clip 时间线生成 .srt；`subtitles: burn \| soft \| both`；逐句时间与对白实测对齐 <100ms，cues 全部落在 `[0, final_duration]`；字体声明内置字体名 + 回退链；中文按标点优先换行、每行 ≤15 字（竖屏），超长拆行 |
| 响度 | §3.6/§3.9：整条 program 两遍 loudnorm（I=-14±1 LUFS，TP≤-1 dB，LRA=11）；静音段不单独处理；整集无有效非静音样本则跳过 loudnorm 并 WARN |
| 竖屏安全区 | 9:16 字幕烧录区上下各留 15%，模板定死 |
| 封面帧 | v2：`cover.clip_id` 指定最终时间线中的 clip —— ① 若该 clip 的**视频 take 绑定的 selected keyframe**（生成该视频时 `first_frame` 引用的 keyframe digest）存在 → 用该 keyframe；② 否则取该 clip 的**实际首帧**（`source_in + deleted_head_frames`）。**不得用 shot 当前 selected keyframe**（可能与该 clip 的视频版本无关）。也可用 `cover.promo_asset` 显式独立宣传素材（不入 input_hash/时间线）。两者皆无 → 报错。v1 不强制（见 §5） |
| 配额账本（固定公式） | manifest 分阶段记 requests/successes/cache_hits/rejects/failed_billed 与可取得的实际消耗字段（金额或配额单位）。成本指标公式写死：<br>`cost_per_accepted_video_shot = (image_cost + tts_cost + video_cost) / count(distinct accepted video shots included in final timeline)`<br>分母按 **distinct shot**（不按 clip 实例）；cache hit 成本计 0；rejected 生成计入；failed request 供应商实扣则计入。**请求次数本身不构成收益证据**：方案对比必须用同一账本口径比较 `cost_per_accepted_video_shot`，不成立则复盘审核策略（§8） |
| 媒体属性探测 | 第一步：ffprobe 读取 streams/format（resolution / FPS / pixel format / video codec / audio codec / sample rate / channels / duration）；任一项与 §3.9 或 episode 模板不符 → 失败 |
| 完整解码验证 | 第二步：`ffmpeg -v error -i final -f null -`（视频+音频全解码）；退出码非 0、超时、或任何解码 error 输出 → 失败。两步都通过才计「可解码」；平台与接口能力断言一律附来源、版本、验证日期 |
| 口型约束 | 小云雀 Seedance 2.5 手册示例支持对白 + **准确口型同步**（来源：官方 wiki，2026-09-14 读取）；**待 M1 实测复核**。复核通过前，有对白镜头保守走背身/画外/手部特写；通过后可放宽近景对白，写入 style-guide.md |
| 抽卡分辨率策略 | web「沉浸式短片」支持 480p 生成 +「提升画质」超分至 4K（来源：官方手册）；**实测：直连 CLI 传 `--resolution 480p` 输出仍为 1254×720**（模型未采纳，成本无差异）→ 该降本路径不走直连 CLI，E1 固定 720p |

## 5. v2 Final Release Gate（新增总门槛）

**同时满足以下全部条件，才称为「能发布一集」**：

1. M0 回归全绿；
2. schema v1/v2 fixture 均通过（v1 集维持 v1 行为，见 §6）；
3. E1 报告存在且当前接口版本与报告一致（首帧约束模式另需 §3.1 判定通过）；
4a. final 中不存在 unresolved 的 rejected/stale/blocked take 依赖（全部版本适用）；
4b. 所有 bound approval record 有效，绑定对象未变更（v2 / cut_join 适用）；
5. 所有 timeline clip 可解析至 selected video take（superseded/orphan 不可用，**经有效 `reuse_records` 恢复的素材除外**；v1 无 clip 时按编辑条目等价校验）；
6. dialogue unresolved overflow = 0；所有 spill 满足 §3.4 约束；
7. 全部 subtitle cue 落在 `[0, final_duration]`；`requires_subtitles = intent.dialogue || intent.subtitles != none` 为真时必须存在字幕产物（缺失 = 失败），豁免仅当 `!requires_subtitles`；
8. A/V 最终流长度误差 < 100ms；
9. final 通过「媒体属性探测 + 完整解码验证」两步（§4）；v2 按 §3.9 校验音频规格，v1 仅校验视频流与容器可解码（保留 v1 模板口径）；
10. loudness 达标（I=-14±1 LUFS，TP≤-1 dB）；`intent.audio: none` → 不适用；`intent.silent: true`（显式）→ 记 `loudnorm: skipped` 放行；声明 dialogue/audio 但实际静音 → 失败；
11. cover 可生成；
12. quota ledger 与事件流对账一致；
13. 全部 cut_join junction 的人工验收记录（四要素）有效；
14. **确定性（同构建环境口径）**：CI 固定 ffmpeg toolchain（版本/build/encoder/平台记入 manifest），同一 manifest/timeline 在**同 toolchain** 下重复执行 final，解码后的视频流逐帧一致、音频 PCM 样本一致；不强求跨环境 bit-exact 与 byte-identical（container metadata/timestamp 允许不同）。跨环境一致性需求出现时另立 ADR。

**Release Gate 适用矩阵（唯一裁定表，条目编号对应上表）**：

| 条目 | v1（schema=1） | v2（schema≥2） | 条件与豁免 |
|---|---|---|---|
| 1 M0 回归 | ✅ | ✅ | — |
| 2 schema fixtures | ✅ | ✅ | v1 fixture 走 v1 语义 |
| 3 E1 报告 | 不适用 | ✅ | 报告存在且版本一致；仅首帧约束模式要求实验通过 |
| 4a rejected/stale/blocked | ✅ | ✅ | 按各自 take 状态等价校验 |
| 4b approval records | 不适用 | ✅ | 无 cut_join → 允许为空 |
| 5 clip→selected take | ✅（按编辑条目） | ✅（按 clip 实例） | v1 无 clip 概念 |
| 6 overflow / spill | 不适用 | ✅ | 声明 `intent.dialogue` → 必须已解决；未声明但实际存在对白 → 失败 |
| 7 subtitle cues | ✅（requires_subtitles 时） | ✅ | `requires_subtitles = intent.dialogue || intent.subtitles != none` → 字幕产物必须存在且逐句校验；缺失 = 失败；豁免仅当 `!requires_subtitles` |
| 8 A/V 长度 | ✅ | ✅ | `intent.audio ≠ none` → 音视频都校验；`none` → 只校验视频流 |
| 9 探测 + 完整解码 | ✅（v1 视频口径） | ✅（§3.9） | v1 仅校验视频流与容器可解码，不强制 §3.9 音频规格；`intent.audio: none` → 跳过音频流检查 |
| 10 loudness | 不适用（v1 无响度要求） | ✅ | `intent.audio: none` → 不适用；`intent.silent: true`（显式）→ 记 `loudnorm: skipped` 放行；声明 dialogue/audio 但实际静音 → 失败 |
| 11 cover | 不适用 | ✅ | 无可用 clip/keyframe → 必须显式 promo_asset，否则失败 |
| 12 quota ledger | 不适用（v1 无账本） | ✅ | 无生成请求 → 允许零账本 |
| 13 junction approval | 不适用 | ✅ | 无 cut_join → 允许为空 |
| 14 确定性 | ✅ | ✅ | 同 toolchain 口径；跨环境另立 ADR |

## 6. 兼容与迁移（显式迁移，`--final` 无副作用）

- manifest/catalog/script 各携带 `schema_version`（缺省 = 1）。
- **迁移只由显式命令执行**：`node tools/migrate-episode.js <episode-dir> --to 2`。迁移矩阵（逐项幂等；只改标注字段，不改已成片视频）：

| 旧状态 | 处理 |
|---|---|
| `shot.ratio == episode.ratio` | 删除 shot 级覆盖，保留 episode ratio |
| `shot.ratio != episode.ratio` 且未设 `allow_mixed_ratio` | 报错要求人工裁决：改 shot / 设 `allow_mixed_ratio`；不得静默丢弃 |
| take/task 缺 `stage` | 补 `stage: video` |
| `task.status === 'superseded'` | 归一化：置 `superseded_at`（旧数据取当前或已知替代时间）+ `status: cancelled`（未完成）/`succeeded`（有产物）；`superseded_by` 可空 |
| 缺 `overflow.allow_trim` / `max_freeze_padding_frames` | 补默认 `false` / `0`（禁止默认删对白与静帧补长） |
| 缺 `intent.dialogue` / `intent.audio` / `intent.subtitles` | 按 script/edit 配置推导并**显式写入**；`audio: none` / `subtitles: none` 不自动填充（需人工确认） |
| episode 缺 `require_keyframe` | 补 `require_keyframe: false` |
| catalog 条目缺 `stage` | 补 `stage: video` |
| 缺 `schema_version` | 迁移成功后写入 2 |
| 旧集要出封面但无 keyframe | 迁移**不改写**封面配置；v2 final 需显式 `cover.clip_id` 或 `cover.promo_asset`，未显式配置 → 报错（见 §4/§5） |

- **v1 适用范围**：未迁移集不适用 §3.2/§3.3/§3.4/§3.7 的 v2 新规则；`--final` 按 §5 的 v1 适用范围执行。
- `stitch-episode --final` **只读 schema_version**：发现 v1 时按 v1 语义出片，并输出提示 `v1 final semantics applied. Run migrate-episode --to 2 to adopt v2 publishing requirements.`——不自动升级、不改 manifest。
- 「旧集不改即可用」承诺：schema 1 集维持 v1 行为；升级需显式迁移，冲突项人工裁决。

## 7. 里程碑

| 里程碑 | 内容 | 依赖 |
|---|---|---|
| **M0** | §3.0 五项测试（含原子写注入、stale callback） | 无，阻塞所有 |
| **M1** | **E1 首帧能力实验**（含接口/版本/参数位/duration 值域/最大 padding/lip-sync 记录）+ **timeline core（clip 实例构建与契约测试，先契约后混音）** | M0 |
| **M2** | 画幅收敛 + 任务快照/attempt 事件流/三维熔断+epoch + late callback + quota 账本 + `migrate-episode`（schema 1→2） | M1（E1 报告须存在，通过与否均可） |
| **M3** | keyframe 阶段（按 §3.2 模式条件化）+ 状态机约束 + 封面帧 | M2；**首帧约束模式另需 E1 判定通过** |
| **M4** | 连续性：continue_from 校验三件套 + cut_join + 帧号 canonicalize + CFR 标准化 + bound approval record | M3 |
| **M5** | TTS + 溢出策略 + 音轨/字幕 + cut_join/padding/spill 与时间线集成 + §3.9 输出规格 + §4 发布件 + Release Gate 验收 | M4 |

## 8. 风险

| 风险 | 缓解 |
|---|---|
| E1 判定仅参考引导 | §3.2 降级为参考引导 + 抽卡；成本口径同步校准；阈值预注册 + A 组绝对门槛（§3.1）；E1 报告为硬前置但「未通过」不阻塞参考图引导 |
| 接口能力/值域随版本变化 | E1 报告记录版本与日期；接口变更重跑相应子项；Release Gate 第 3 条把关 |
| 时间线复杂度膨胀 | §3.6 契约 + M1 先交付时间线核心函数与独立测试，先契约后混音 |
| 并发/竞态（late callback、重复回调） | M0 两条并发基础测试 + §3.5 状态模型；superseded 不可进成片 |
| input_hash 契约实现偏差导致假失效/漏失效 | §3.8 验收用例直接测「该失效/不该失效」矩阵 |
| 上游重抽引发下游大量失效 | 一跳自动失效 + bound approval；digest 绑定防假失效 |
| TTS 音色跨集漂移 | voice id 绑定 + 内容哈希缓存 |
| 配额收益不成立 | 固定公式同口径前后对比；不成立则复盘审核策略并下调 §3.2 承诺 |
| 静止镜头指标失效 | ε 降级路径 + 人工四要素兜底 |
| 首帧能力被高估（把参考图当日首帧锁定） | §3.2 两模式表 + E1 报告硬前置；未通过一律按参考图引导表述 |
| 时间线偏移口径漂移（按 take 原始时长累加） | §3.6 单一计算基准 + §3.4 spill 引用 + clip 实例验收用例 |

## 附录 A：契约走查（五个必过示例）

> 用具体例子把三张表走一遍；实现与验收用例必须与这些例子一致。

**A1 删一帧（半开区间 + 不重复扣减）**
- 下游 clip `source_in=0, source_out=480`；接头比对 `upstream[cut_frame-1]` vs `downstream[0]`，SSIM ≥ S → `deleted_head_frames=1`；
- `source_in` **保持 0**，实际首帧 = `0 + 1 = 1`；`output_frames = 480 - 0 - 1 + 0 = 479`；
- approval 记录 `source_in=0, deleted_head_frames=1`；封面若取该 clip → 取实际首帧 1（或该视频绑定的 keyframe）。

**A2 连续三次 hard failure（同 task、同 input_hash）**
- T(h1) submitted → 第 1 次 hard 失败 → `retry_wait`（attempt n=1）；第 2 次 → `retry_wait`（n=2）；第 3 次 → 触发维度 1（hard ≥3）→ **blocked**（task+shot）；全程不进入 `failed`；
- 若第 1 次 hard 后改稿（h2）：T 置 `superseded_at`；新任务 T2 创建；T 的 hard attempt 仍作为「hard-failure 快照」计入维度 3（跨 input_hash）。

**A3 blocked 后 unblock**
- shot/task 处于 blocked → 人工修复 → `mark-shot --unblock`：`epoch += 1`；**该 shot 的 blocked 任务 → cancelled**；三维窗口重置；shot 回到 pending/stale，可被 `render-next` 领取；历史事件与旧任务保留。

**A4 failed 后 late success**
- T 被显式 `--terminal` 标为 `failed`；原请求的成功回调随后到达（`--take --task T`）→ `status=succeeded`、`completion=late`；artifact 入 catalog；
- **不自动 selected**；若 T 的 `superseded_at` 非空或 input 非当前 → 只能作 orphan/superseded take，`--final` 不可用；若 input 仍匹配 → 可人工 `--select` 采用。

**A5 有对白但漏字幕**
- 声明 `intent.dialogue=true`、`intent.subtitles=burn`：`requires_subtitles = dialogue || subtitles != none = true`；final 未生成/未烧录字幕 → **Gate 7 失败**（缺少必需产物不是豁免）；
- 豁免条件唯一：`!requires_subtitles`（即 `dialogue=false && subtitles=none`）；音频同理：`requires_audio = audio != none`，声明 audio≠none 而 final 无音频流 → Gate 8/9 失败；`audio=none` 才豁免。

**A6 `dialogue=true + subtitles=none`**
- `requires_subtitles = true` 但 `subtitles=none` 属**矛盾声明**：build-manifest 配置校验直接拒绝（有对白必须产出字幕），不进入导出；
- 修正路径：设 `subtitles: burn|soft|both`，或先改稿移除 dialogue 后再把 `intent.dialogue=false`；不得留到 final 时猜优先级。

**A7 同一成功回调到达两次 / 同 task 两次请求**
- 同 `request_id`、同内容摘要的重复回调：第一次新增 take-001，ledger `successes += 1`；第二次幂等返回 take-001，不新增素材、不重复计账；
- 同 `request_id`、不同内容摘要：冲突留痕，不覆盖 take-001；**本地路径不同但摘要相同 → 幂等，不冲突**；
- 同 task、不同 `request_id`（重试后第二次真实请求）：两次请求各自成功 → 两份独立 take，各计一次产物与消耗，不自动 selected。

**A8 A→B→A（旧 A 处于 retry_wait）**
- A(h1) retry_wait → 改稿 B(h2)：A 置 `superseded_at`，**移出调度集合**（status 仍 retry_wait 仅表示执行事实）；
- 改回 A(h1)：旧 A 不可被 render-next 复用、`retry_after` 到期也不重发；调度侧新建 A'(h1, `superseded_at=null`)；若旧 A 已有成功产物，可经 `reuse_records[]` 恢复素材，不复活旧任务。

**A9 请求 1 超时 → 请求 2 发出 → 两者先后成功**
- task T 派发 req-1（`attempt_id=a1`）→ 超时，T 置 retry_wait；`retry_after` 到期派发 req-2（a2）；
- req-2 成功先到 → T 置 succeeded，新增 take-001（绑定 `request_id=req-2`）；
- req-1 成功后到 → 同 task、不同 `request_id` → **新增 take-002**（完成时机记 late），两份产物与实际消耗各计一次；不覆盖 take-001、不自动 selected；后续由人工按 fingerprint 与内容审核选定，`--final` 只接受选中的 take。
