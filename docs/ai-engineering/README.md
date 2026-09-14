# 本项目 AI 工程文档集（`docs/ai-engineering/`）

> 目的：把 `shows`（脚本驱动 Seedance 视频流水线）的 AI 工程实践沉淀为**可验证**的文档。
> 读者有两类：人类维护者（架构/评审/发布）与 AI agent（主 agent、worker 子代理、评审子代理）。
> 规则：外部要点一律带 `（来源：<链接>，访问 2026-09-14）`；本项目事实一律指向真实文件路径或可执行命令。
> 本目录**只读**：不改代码、不改 `PRD-v2.md`、不改 `episodes/S01E01-pov/**` 与 `catalog.json`。
> 全部外部来源的编号、URL、类型与用途见 [`SOURCES.md`](./SOURCES.md)。

## 文档集地图

| 文档 | 回答的问题 | 主要本地锚点 |
|---|---|---|
| `README.md`（本篇） | 文档集怎么用、五原则是什么、该读哪篇 | — |
| [`01-agent-collaboration.md`](./01-agent-collaboration.md) | 谁做决策、worker 规格怎么写、主 agent 怎么验证 | `/tmp/worker-*.md` 形态、`npm test` |
| [`02-model-and-prompt-contract.md`](./02-model-and-prompt-contract.md) | 模型能力边界、输入哈希契约、prompt 写法 | `PRD-v2.md` §3.8、`tools/build-manifest.js`、`tools/build-prompt.js` |
| [`03-evaluation-and-release.md`](./03-evaluation-and-release.md) | 怎么评测、回归怎么分层、发布 Gate 怎么判 | `experiments/e1/preregistration.json`、`tools/gate.js`、`tools/test/regression.test.js` |
| [`04-cost-and-guardrails.md`](./04-cost-and-guardrails.md) | 花多少钱、什么必须审批、出错怎么兜 | `tools/quota-ledger.js`、`tools/lock.js`、`PRD-v2.md` §4 |
| [`SOURCES.md`](./SOURCES.md) | 每条外部要点出自哪个一手页面 | `/tmp/sources/*` |

## 本项目 AI 工程五原则

| # | 原则 | 外部依据（访问 2026-09-14） | 本项目落地位置（可验证） |
|---|---|---|---|
| ① | **控制流与状态归项目**：不要把编排权交给框架黑盒 | 「Own your control flow」——LLM 应用可靠性来自简单可组合模式，而非重框架（来源：https://github.com/humanlayer/12-factor-agents ，访问 2026-09-14） | 派发顺序由 `tools/render-next.js` 决定（tts → keyframe → video）；状态机写死在 `tools/task-state.js`；`package.json` 仅依赖 `js-yaml`（无 agent 框架） |
| ② | **上下文是有限资源，按需检索**：宁可 just-in-time 取，不要一次性塞满 | 「Context is a critical but finite resource」；子 agent 隔离上下文、只回传摘要（来源：https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents ，访问 2026-09-14） | 一次性规格走 `/tmp/worker-*.md`；工具行为写进 `README.md` 工具表而非塞进对话；`grep`/`read` 按需读 `PRD-v2.md` 章节。仓库根 `AGENTS.md`（已建 2026-09-14）是 agent 的统一入口 |
| ③ | **一切可复现**：先红后绿、确定性出片、证据优先 | 探索→计划→编码→提交；TDD；给 agent 一个可运行的检查（来源：https://www.anthropic.com/engineering/claude-code-best-practices ，访问 2026-09-14） | `npm test`（`tools/test/regression.test.js`，当前 **458 passed / 0 failed**）；`tools/determinism.js` 复跑两次比摘要；`tools/render-final.js` 固定 ffmpeg 参数 |
| ④ | **评测先预注册、冻结阈值**：先声明成功标准，再看结果 | 评测是**可注册、可复现、可比较**的资产；小样本先验证再扩大（来源：https://github.com/openai/evals ，访问 2026-09-14） | `experiments/e1/preregistration.json` 冻结 `delta_preregistered=0.25`、`ssim_abs_min=0.80`、`delta_frozen_at`；缺字段 `tools/e1-report.js` 拒绝出结论（退出码 2） |
| ⑤ | **人机边界与成本护栏**：花钱/不可逆动作必须人批准 | human-in-the-loop 与 pause/resume（来源：https://github.com/humanlayer/12-factor-agents ，访问 2026-09-14） | 真实生成消耗 credits 需用户批准（见 `04-cost-and-guardrails.md`）；`TTS_MOCK=1` 离线通道；`validate-script`/`build-manifest`/`build-timeline` 零 credits |

## 该读哪篇（场景 → 文档）

| 你要做的事 | 先读 | 然后 |
|---|---|---|
| 委派一个 worker 子代理改代码 | `01-agent-collaboration.md`（worker 规格模板） | 按「验证协议」独立复现 |
| 改剧本 / 写 prompt / 换模型 | `02-model-and-prompt-contract.md` | `node tools/validate-script.js <draft>` |
| 跑 E1 / 判断首帧能力 | `03-evaluation-and-release.md`（评测方法学） | `node tools/e1-report.js` |
| 出一集 / 判断能否发布 | `03-evaluation-and-release.md`（Gate 映射） | `node tools/gate.js <episode>` |
| 估算 credits / 判断要不要审批 | `04-cost-and-guardrails.md` | `node -e` 抽查 ledger |
| 引用外部资料前核对出处 | `SOURCES.md` | 回到 `/tmp/sources/` 原文 |

## 术语表（本目录统一口径）

| 术语 | 定义 | 权威位置 |
|---|---|---|
| 主 agent / worker | 编排与验收者 / 独立上下文的一次性执行者 | `01-agent-collaboration.md` |
| Gate | Release Gate，15 行（§5 的 1..14，4 拆 4a/4b）发布裁定表 | `tools/gate.js`、`PRD-v2.md` §5 |
| take | 一次成功生成的产物记录（`candidate/selected/rejected/superseded`） | `README.md`「take 生命周期」 |
| keyframe | 静帧先行阶段的产物（`shot.keyframe_takes[]`） | `PRD-v2.md` §3.2 |
| `input_hash` | stage payload 的 canonical JSON 摘要（缓存键），identity 不入 hash | `PRD-v2.md` §3.8 |
| E1 | 首帧能力实验（预注册统计契约） | `PRD-v2.md` §3.1、`experiments/e1/` |
| credits | 生成接口的计费单位（E1 实测 ~20 credits/次） | `04-cost-and-guardrails.md` |
| 零 credits 边界 | `validate-script`/`build-manifest`/`build-timeline` 不产生费用 | `README.md`「DRAFT」 |

## 维护约定

- **何时更新**：PRD 版本变更、新增/替换模型或接口、阈值重新预注册、Gate 条目或状态语义变化时，先改对应章节并同步 `SOURCES.md` 的引用日期。
- **改动范围**：本目录为文档，不承载代码；任何实践若需要改代码，先走 `01-agent-collaboration.md` 的 worker 规格流程。
- **评审方式**：改动本目录同样适用「主 agent 独立复现」——至少跑通本文件末尾的可执行检查，并确认引用的外部 URL 仍在一手来源中。

## 阅读约定

- 「**本项目落地位置**」是每个实践的必要字段：没有落点的实践不写进本目录。
- 实测数字只在能被本地文件核验时给出；无法核验的一律写「**待核实**」（见每篇末尾 Notes 与 `SOURCES.md`）。
- 命令块默认可在仓库根 `/Users/wangpeng/workspace/shows` 直接复制运行。

## 常见疑问

| 问题 | 简答 | 展开 |
|---|---|---|
| 为什么不用 agent 框架把控制流交给 LLM？ | 生成本身是单步调用，编排必须可审计、可复现；重框架会遮蔽 prompt/状态 | `01` §1、`README.md` 原则① |
| 为什么必须预注册阈值？ | 事后调参无法区分「能力成立」与「调阈值凑结果」 | `03` §1 |
| 为什么改了 keyframe 就要重跑 video？ | selected keyframe 的 digest 进入 video `input_hash`（一跳失效） | `02` §2 |
| 为什么抽卡失败的钱也算成本？ | `rejected` 生成计入分母与分子，否则成本指标失真 | `04` §1.2 |
| 为什么测试通过还要人复核？ | 套件绿 ≠ 语义正确；跨模型/跨 agent 的验证必须独立复现 | `01` §3 |
| 为什么草稿阶段不直接生成？ | 改稿→零成本校验→满意后再花钱，坏稿不会写出 manifest | `04` §2 |
| 同内容不同 take id 为什么会假失效？ | 不会：绑定用 content digest，不用 take id | `02` §2 |

## 可执行检查

```bash
cd /Users/wangpeng/workspace/shows

# 6 篇文档存在、且都含「可执行检查」
ls docs/ai-engineering/
grep -l "可执行检查" docs/ai-engineering/*.md

# 每篇行数应在 100–200
wc -l docs/ai-engineering/*.md

# 本仓库当前回归基线（应打印 458 passed, 0 failed）
npm test

# 文档引用的外部链接必须都能在引用包或项目内摘录中找到（逐条比对）
SOURCES_LIST="/tmp/sources/project-facts.md experiments/e1/pippit-seedance25-capabilities.md"
for u in $(grep -rhoE 'https?://[^ )，、]+' docs/ai-engineering/ | sed 's/[.,]$//' | sort -u); do
  grep -qF "$u" $SOURCES_LIST || echo "NOT IN SOURCES: $u"
done

# 未在部署环境安装 AGENTS.md（用于核对原则②备注）
test -f AGENTS.md && echo "AGENTS.md exists" || echo "AGENTS.md absent（本仓库现状）"
```
