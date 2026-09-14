# SOURCES · 外部来源清单

> 本文件是 `docs/ai-engineering/` 的引用总表：每条外部要点都必须能在此找到编号、URL、类型与读取日期。
> 访问日期统一为 **2026-09-14**（本次抓取）。写作时的原文快照曾存放在 `/tmp/sources/`（**不作为验证依据，也不随仓库提交**）；验证以本表 URL + 访问日期为准（可用下方 curl 复访）。
> 原始引用包：`/tmp/sources/project-facts.md`。

## 0. 关于检索环境（重要）

- 本环境**搜索引擎被过滤**：DuckDuckGo / Bing 等检索入口不可用（`WebSearch`/`WebFetch` 到搜索页被拦截）。
- 因此本文档集的来源均为**直接访问的权威一手页面**（标准站点 / 官方 docs / 官方 wiki），而非检索摘要。
- 唯一例外是两处「引用包内已核实事实」，其一手页面不在抓取快照中，但 URL 与数值已由引用包记录：
  - 火山引擎计费说明（编号 9）：用于 TTS 资源包/后付费/音色槽位/并发价格。
  - 小云雀 Seedance 2.5 wiki（编号 10）：引用包只写「飞书 wiki revision 2777」，完整 URL 记录在项目内**结构化摘录** `experiments/e1/pippit-seedance25-capabilities.md`（含 revision **2777** 与读取日期 2026-09-14）；本目录引用能力事实时以该摘录为准。
- `docs.volcengine.com` 与飞书 wiki 的事实，**以 `experiments/e1/pippit-seedance25-capabilities.md` 为项目内权威摘录**。

## 1. 来源清单表

| # | 标题 | URL | 类型 | 访问日期 | 一句话可引用要点 | 本项目用途 |
|---|---|---|---|---|---|---|
| 1 | 12-Factor Agents | https://github.com/humanlayer/12-factor-agents | 标准/指南 | 2026-09-14 | 可靠的 LLM 应用来自简单可组合模式（own control flow / own context window / own prompts / small focused agents / stateless reducer / 事件流审计） | 五原则①⑤；`01` 角色模型、`04` 审计与可回放 |
| 2 | AGENTS.md | https://agents.md/ | 标准（Agentic AI Foundation） | 2026-09-14 | 给 agent 一个专用、可预测的上下文入口（setup/test 命令、代码风格、PR 规范、目录边界），与人类 README 分离 | 五原则②；`01` worker 规格的「上下文入口」依据 |
| 3 | Building Effective Agents（Anthropic，2024-12-19） | https://www.anthropic.com/engineering/building-effective-agents | 工程博客 | 2026-09-14 | 最成功的实现用简单可组合模式；区分 **workflow（预定义编排）** 与 **agent（自主决策）**；先定义成功标准 | 五原则①；`01` 角色模型（本项目选 workflow 而非 autonomous loop） |
| 4 | Best practices for Claude Code（Anthropic） | https://www.anthropic.com/engineering/claude-code-best-practices | 官方文档 | 2026-09-14 | 探索→计划→编码→提交；TDD；给 agent 一个可运行的检查（tests/build/screenshot）；subagent 分担上下文；及时纠偏；对抗式复核 | 五原则③；`01` 验证协议、反模式清单 |
| 5 | Effective context engineering for AI agents（Anthropic，2025-09-29） | https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents | 工程博客 | 2026-09-14 | 上下文是**有限资源**（context rot / attention budget）；just-in-time 检索；子 agent 隔离上下文、只回传摘要；compaction/笔记 | 五原则②；`01` 子代理隔离 |
| 6 | OpenAI Evals | https://github.com/openai/evals | 评测框架 | 2026-09-14 | 评测是可注册、可复现、可比较的资产；每个 eval 声明数据集/评分器/指标；小样本先验证再扩大；记录运行与版本 | 五原则④；`03` 评测方法学 |
| 7 | Veo 视频生成提示词指南（Google Vertex AI） | https://cloud.google.com/vertex-ai/generative-ai/docs/video/video-gen-prompt-guide | 官方文档 | 2026-09-14 | 提示词拆成 Subject / Action / Scene or context / Camera angles & movements / Lighting / Visual style & aesthetics / Ambiance / Tone or mood / Audio / Temporal elements；负向提示应**描述不想要的东西**（如 `wall, frame`），不要用 `no walls`/`don't show walls` | `02` 结构化提示、负向约束 |
| 8 | Video generation in the Gemini API（Google） | https://ai.google.dev/gemini-api/docs/video | 官方文档 | 2026-09-14 | **快照为概览页**（页面自标 Last updated 2026-06-30）：区分 `Gemini Omni Flash`（默认视频生成，多输入推理/角色一致性）与 `Veo 3.1`（场景延展、末帧控制）；**未含**时长/分辨率/宽高比参数表 | `02` §3.2；参数细节标「待核实」 |
| 9 | 火山引擎《计费说明》（豆包语音合成模型 2.0） | https://www.volcengine.com/docs/6561/1359370 | 官方文档 | 2026-09-14 | 资源包 10 万字/年=28 元、2000 万字=5400 元、20000 万字=48000 元；后付费 3 元/万字符；音色槽位 1–50 档 138 元/音色；正式版默认 10 并发，增购 100 元/并发/月 | `04` §1.4 TTS 计费 |
| 10 | 小云雀《🎬 小云雀·Seedance 2.5 关键更新速览》（官方 wiki） | https://bytedance.larkoffice.com/wiki/W5tHwoZIDi12dbk2z3KcFkuUnsf | 官方 wiki（revision 2777） | 2026-09-14 | 单次 1–30s（1s 粒度）、超长直出 5min；R2V 参考模式 prompt 首句声明首/尾帧（参考图不能当首帧）；手册示例支持口型同步；素材上限 图≤30/视频≤10/音频≤10（总 30s）；480p+超分仅 web 工具 | `02` 模型台账、素材上限；`03` E1 能力声明 |

## 2. 逐条引用要点与本地映射（供逐句核对）

| # | 在本目录被引用处 | 备注 |
|---|---|---|
| 1 | `README.md` 原则①⑤；`01` §1/§3；`04` §4 | 「own your control flow」→ 无框架依赖；「事件流审计」→ `manifest.task_events[]` |
| 2 | `README.md` 原则②；`01` §2 | 规格文件 `/tmp/worker-*.md` 即「agent 专用入口」；仓库根 `AGENTS.md` 已建（2026-09-14），与本文档集互为引用 |
| 3 | `README.md` 原则①；`01` §1 | workflow vs agent：本项目把**编排写死在工具里**，LLM 只做生成，不做自主循环 |
| 4 | `README.md` 原则③；`01` §1/§5 | 「给 agent 可运行的检查」→ `npm test` / `tools/gate.js`；「对抗式复核」→ 新上下文 reviewer |
| 5 | `README.md` 原则②；`01` §1 | 子 agent 只回传摘要；按需 `grep`/`read` 读 `PRD-v2.md` 章节 |
| 6 | `README.md` 原则④；`03` §1 | 预注册 + 分层 + `metrics` 版本 → `experiments/e1/preregistration.json` |
| 7 | `02` §3.1/§3.3 | 构件名可核验；负向写法直接落到 `prompt_en` 与 `style-guide.md` |
| 8 | `02` §3.2 | 只引用页面实际存在的内容；参数表标「待核实」 |
| 9 | `04` §1.4 | 价格数字逐项照抄引用包，未做汇率/单位换算 |
| 10 | `02` §1/§3.4/§4；`03` §1.1 | 项目内摘录 `experiments/e1/pippit-seedance25-capabilities.md`（revision 2777） |

## 3. 溯源规则

1. 外部要点写法：`（来源：<URL>，访问 2026-09-14）`；同一文档内重复引用可简写为「同上」并保留 URL。
2. 本项目事实写法：给文件路径（含行号更佳，如 `tools/quota-ledger.js:44`）或可复制命令。
3. 无法在 `/tmp/sources/` 或仓库文件核实的内容：标「**待核实**」，不得作为结论引用。
4. 抓取快照若与页面现状不一致（页面会更新），以**快照日期 + 页面自标 Last updated** 共同限定；引用前回看 `experiments/e1/pippit-seedance25-capabilities.md` 的版本记录。

## 4. 快照文件对照表

| # | 快照文件（`/tmp/sources/`） | 说明 |
|---|---|---|
| 1 | `12factor.md` | 12-Factor Agents 指南全文（另有 `.txt` 导出） |
| 2 | `agentsmd.html` / `agentsmd.html.txt` | AGENTS.md 首页（`.txt` 为去除标签后的正文提取） |
| 3 | `anthropic-agents.html` / `.txt` | Building Effective Agents（2024-12-19） |
| 4 | `anthropic-cc.html` / `.txt` | Claude Code Best Practices |
| 5 | `anthropic-context.html` / `.txt` | Effective context engineering（2025-09-29） |
| 6 | `openai-evals.md` | OpenAI Evals README |
| 7 | `veo-guide.html` | Veo 视频生成提示词指南 |
| 8 | `gemini-video.html` | Gemini API 视频生成（概览页快照） |
| 9 | （无快照） | 火山引擎计费说明：URL 与数值由 `project-facts.md` 记录 |
| 10 | （无快照） | 飞书 wiki：项目内摘录见 `experiments/e1/pippit-seedance25-capabilities.md` |

## 5. 本目录标记为「待核实」的点（汇总）

| 位置 | 待核实内容 |
|---|---|
| `README.md` 原则② | 仓库根 `AGENTS.md`（已建 2026-09-14）提供命令/约束/文档地图入口 |
| `02` §1 | 官方能力备忘出自《Seedance 2.5》，E1 实测模型为 `Seedance_2.0_mini_lite`，二者映射关系未确认 |
| `02` §3.2 | Gemini 视频文档抓取快照未含时长/分辨率/宽高比参数表 |
| `01` §1 | 「Luna/Sol 式分层复核」命名在仓库内无对应定义，可核验的是「新上下文复核 + 独立复现」 |
| `01` §5 | 题述「403 误判教训」在仓库/引用包中无记录 |

## 6. 如何更新本文件

1. 新增来源：追加一行到 §1（编号递增），并在 §2 写明被引用处。
2. 来源更新（页面改版/接口变更）：保留旧行，新增一行并注明版本/日期；不要静默改写历史引用。
3. 从「待核实」转正：必须先找到一手页面或仓库内可验证证据，再同时修改 §1/§4 与对应文档。
4. 任何新增外部要点都不得绕过 §1——没有编号的链接不允许出现在 `docs/ai-engineering/` 其他文件中。

## 可执行检查

```bash
cd /Users/wangpeng/workspace/shows

# 1) 本表 URL 可复访（网络可达时；任一非 200 则需重新核对或降级为“待核实”）
for u in $(grep -oE 'https?://[^ |)]+' docs/ai-engineering/SOURCES.md | sed 's/[.,，。]$//' | sort -u); do
  printf '%-90s ' "$u"; curl -s -o /dev/null --max-time 15 -A 'Mozilla/5.0' -w 'http=%{http_code}\n' "$u"
done

# 2) 文档中出现的所有外部 URL 都在本表中（空输出=全部命中）
for u in $(grep -rhoE 'https?://[^ )，、`]+' docs/ai-engineering/ | sed 's/[.,]$//' | sort -u); do
  grep -qF "$u" docs/ai-engineering/SOURCES.md || echo "NOT IN SOURCES: $u"
done

# 3) 项目内权威摘录（wiki revision 2777）与计费来源
grep -n "revision 2777" experiments/e1/pippit-seedance25-capabilities.md
grep -n "1359370" docs/ai-engineering/SOURCES.md

# 4) 引用规则自检：外部引用是否带“访问 2026-09-14”
grep -c "访问 2026-09-14" docs/ai-engineering/*.md
```
