# 01 · Agent 协作与验证协议

> 本篇定义本项目「主 agent + worker 子代理 + 评审」三角色的边界、worker 规格模板、验证协议与反模式。
> 外部依据：Anthropic 上下文工程（子 agent 隔离上下文、只回传摘要）与 Claude Code 最佳实践（subagent、探索→计划→编码→提交）。
> 所有命令可在仓库根 `/Users/wangpeng/workspace/shows` 直接运行。

## 1. 角色模型

| 角色 | 上下文 | 职责 | 不该做的事 | 本项目实例 |
|---|---|---|---|---|
| **主 agent**（编排/裁决/验收） | 主会话，长 | 拆任务、写规格、**独立复现**、判定「绿」、决定是否动用 credits | 不采信 worker 自述；不把「跑了套件」当作「语义正确」 | 读取 `/tmp/worker-*.md` 规格 → 派 worker → 跑验收命令 |
| **worker 子代理** | 独立会话，一次性 | 在给定规格内改代码/写测试，返回摘要 + 证据 | 不改冻结文件；不联网；不自行扩大范围 | `/tmp/worker-e1-collect.md` 形态的规格文件 |
| **评审/复核**（fresh-context reviewer） | 独立上下文 | 只看 diff + 验收标准，指出缺口与不变量破坏 | 不追风格偏好；不做「实现者自评」 | 用新会话跑 `npm test` + 抄规格里的验收命令 |

- **同一 worker 不做自己的裁判**：实现者在一个上下文里会沿用自己的错误前提。
  Anthropic 把这条写成「让另一个子 agent 用新上下文评 diff」（来源：https://www.anthropic.com/engineering/claude-code-best-practices ，访问 2026-09-14）。
- **子 agent 只回传摘要**：worker 探索可能消耗上万 token，但交回主会话的应是结论 + 文件清单 + 证据，而不是过程（来源：https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents ，访问 2026-09-14）。
- 「Luna/Sol 式分层复核」是本项目的口头叫法，仓库内无对应文件定义该命名 → **待核实**（当前可核验的实现就是「新上下文复核 + 独立复现」）。

## 2. worker 规格模板（本项目实际形态的抽象）

规格文件是主 agent 唯一允许传给 worker 的「任务上下文入口」，必须落盘（本项目放在 `/tmp/worker-<topic>.md`）。
抽象自 `/tmp/worker-e1-collect.md`（同目录另有 `worker-a7.md`、`worker-debt.md`、`worker-draft.md` 可作对照）。

| 规格字段 | 必须写清 | 本项目实例 |
|---|---|---|
| 目标 | 交付什么、边界在哪 | 「为 E1 交付采集与指标工具链，默认 mock adapter 做端到端演练」 |
| 约束 | 测试隔离、依赖、语言、网络、门控 | `os.tmpdir()` 隔离；CommonJS；**零新依赖**；**不联网**；ffmpeg 缺失时 SKIP |
| 接口契约 | 新文件路径、导出函数名、CLI 参数、数据 schema | `tools/e1-metrics.js` 导出 `phashFromGray`/`ssimFilterGraph`；CLI `--config/--adapter/--out/--dry-run` |
| 验收命令 | 可复制、可判定 pass/fail | `npm test`、`node -e "require('./tools/e1-collect.js')"` |
| 禁止事项 | 冻结文件、生产数据、不可逆动作 | 不改 `PRD-v2.md`、`episodes/S01E01-pov/**`、`catalog.json`；不真实调用生成接口 |
| 输出格式 | 便于主 agent 归档 | `## Completed / ## Files Changed / ## Notes` |

````markdown
# worker 规格模板（复制后填空）
实施任务：<一句话目标>。仓库 `/Users/wangpeng/workspace/shows`。先读 <契约文件/章节>（**已冻结，禁止修改**）。

## 硬性约束
1. **TDD**：在 `tools/test/regression.test.js` 追加 `<章节名>`，先红后绿。
2. 测试用 `os.tmpdir()` 隔离；**不联网**；不修改 <冻结文件清单>；CommonJS、零新依赖。
3. 完成后 `npm test` 全绿（当前基线见 03 篇），并逐条跑下面的验收命令。
4. 输出格式：## Completed / ## Files Changed / ## Notes（Notes 给 reviewer 的符号与锚点）。

## 接口契约
- 新增/修改文件：<path>；导出：<symbol 列表>；CLI：<参数表>。
- 数据 schema：<字段与语义>。

## 禁止事项
- <冻结文件> 一律不改；<外部动作> 需主 agent 批准。

## 验收命令
```bash
cd /Users/wangpeng/workspace/shows
npm test
<每任务真实命令>
```
````

## 3. 验证协议：主 agent 必须独立复现

| 步骤 | 做法 | 证据形态 | 本项目锚点 |
|---|---|---|---|
| 1 复跑套件 | 主 agent 自己跑，不读 worker 的粘贴输出 | `458 passed, 0 failed` | `npm test` |
| 2 红→绿 | 合并前在旧代码上确认新用例**确实失败**，再确认修复后转绿 | 两次运行输出 | 规格要求「先红后绿」 |
| 3 语义抽查 | 不看断言，直接读产物（JSON/时间线/日志） | 字段实际值 | `node tools/gate.js <episode> --json` |
| 4 生产数据哈希前后对比 | 改动触达生产数据时比对 `shasum -a 256` | 前后哈希相等 | 见下命令 |
| 5 隔离性 | 测试不得写进真实 `episodes/` | `find episodes -newer <stamp>` 为空 | 回归含 `DRAFT5`（全程未在真实 `episodes/` 下创建文件） |

**不采信自述的最小集**：worker 声称「全绿」时，主 agent 至少独立跑 `npm test` 并抽查一个未改动文件的行为（如 `node tools/validate-script.js episodes/_drafts/<slug>`）。

## 4. 变更守恒

| 守恒项 | 规则 | 可验证 |
|---|---|---|
| 冻结文件 | `PRD-v2.md` 仅在批准后修订；`episodes/S01E01-pov/**`、`catalog.json` 不改 | 改动前 `shasum -a 256` 存底，改动后比对 |
| credits | 真实生成前必须用户批准（详见 04 篇） | `node -e` 读取 `manifest.quota_ledger` |
| identity 字段 | `task_id`/`take_id`/时间戳/reviewer **不入** `input_hash` | `PRD-v2.md` §3.8「不进入 hash 的字段」；回归 `A8a` |
| 无 git 环境 | 以 `mtime`/哈希核验，而不是 `git diff` | `find . -newer <ref> -not -path './node_modules/*'` |

## 5. 反模式清单（各配本项目实例）

| 反模式 | 为什么坏 | 正确做法 | 本项目锚点 / 实例 |
|---|---|---|---|
| 把旧记录当现状 | 接口/版本/阈值会变；旧结论可能是旧版本的 | 引用前核对版本与日期，必要时重跑子项 | `experiments/e1/pippit-seedance25-capabilities.md` 记录能力随版本变化；Gate #3 要求 E1 报告与当前接口版本一致。**题述的「403 误判」仓库内无记录 → 待核实** |
| 只跑套件不验证语义 | 套件绿 ≠ 不变量成立（可能改断言迁就实现） | 主 agent 读产物字段、跑 Gate | 禁止「把测试改绿而不修不变量」；`PRD-v2.md` §1「验收只接受具名回归测试与可复现命令输出」 |
| 把测试改绿而不修不变量 | 掩盖真实缺陷，回归基线失真 | 修实现；若规格错则先改规格并说明 | `PRD-v2.md` §3.0「M0 未全绿不开工后续里程碑」 |
| 并行 worker 同改一个测试文件 | 回归文件是单文件 `tools/test/regression.test.js`，并发写会互相覆盖 | 串行派发，或让 worker 只写自己的测试文件再统一合并 | 本项目测试集中在 `tools/test/regression.test.js` |
| 无限探索 | 把整个仓库读进上下文，挤掉真正的任务 | 窄化范围或用子 agent 隔离探索 | 来源：https://www.anthropic.com/engineering/claude-code-best-practices ，访问 2026-09-14 |
| 过度纠正 | 同一问题纠 2 次以上，上下文被失败方案污染 | 清空上下文、带上学到的信息重开 | 同上（"Correcting over and over"） |

## 可执行检查

```bash
cd /Users/wangpeng/workspace/shows

# 1) 回归基线（主 agent 必须自己跑）
npm test

# 2) 冻结文件哈希存底 / 比对
shasum -a 256 PRD-v2.md catalog.json
shasum -a 256 episodes/S01E01-pov/manifest.json

# 3) 尚未释放的跨进程锁 / 崩溃残留
find . -name "*.lock" -not -path "./node_modules/*"
find . -name "*.tmp" -not -path "./node_modules/*"

# 4) 无 git 环境下按 mtime 找最近改动
find . -type f -newermt '2026-09-14 00:00:00' -not -path './node_modules/*' | head

# 5) 隔离性：草稿不影响生产
node tools/validate-script.js episodes/_drafts/my-episode --json 2>/dev/null | head -c 300 || true
```
