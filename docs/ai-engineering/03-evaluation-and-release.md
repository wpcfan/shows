# 03 · 评测与发布

> 本篇回答三件事：**怎样才算验证过**（预注册 + 分层 + 双门槛）、**回归套件如何充当「永远在跑的评测」**、
> **Release Gate 的 14 条如何映射到本地检查**。
> 权威契约：`PRD-v2.md` §3.1（E1）、§5（Release Gate）、§7（里程碑）；工具：`tools/e1-report.js`、`tools/gate.js`。

## 1. 评测方法学

| 原则 | 做法（本项目写死） | 本地落地 |
|---|---|---|
| **预注册** | 阈值在看到正式结果**之前**冻结；Δ（相对提升）与 `ssim_abs_min`（绝对质量门槛）一同冻结，并记 `delta_frozen_at` | `experiments/e1/preregistration.json`：`delta_preregistered=0.25`、`ssim_abs_min=0.80`、`delta_frozen_at=2026-09-14T12:00:30+0800` |
| **可注册/可复现** | 评测是资产：声明数据集/评分器/指标/版本；小样本先验证再扩大 | 来源：https://github.com/openai/evals ，访问 2026-09-14；`experiments/e1-dataset.example.json` schema |
| **分层样本** | closeup / wide / empty / motion 四层，每层每组 ≥10 样本；至少 3 个不同场景素材 | `e1-report.js` 的 `LAYERS`、`MIN_LAYER_SAMPLES=10` |
| **cluster bootstrap** | cluster = `(scene, prompt_id)`，同 scene 多 seed 是 cluster 内重复观测，不是独立采样单元 | `e1-report.js` `bootstrap_iterations ≥ 1000` |
| **绝对门槛** | 仅「相对 B/C 有提升」不够：A 组中位数必须 ≥ `ssim_abs_min` | 报告字段 `absolute:{ssim_abs_min,a_median,pass}` |
| **相对判定** | A 对 B、A 对 C 的提升 ≥ Δ，且两者 bootstrap 95% CI 均不跨 0；每层分别满足（或人物两层满足且其余无反向显著） | `e1-report.js` 判定 1–3 |
| **不合格样本留在分母** | 解码失败/尺寸异常一律计不合格，不得剔除后报优 | `PRD-v2.md` §3.1 |
| **拒绝出结论** | 缺 Δ / `ssim_abs_min` / `delta_frozen_at` → 工具拒绝，退出码 **2**；缺 `metrics`/`duration_value_range`/`lipsync` → 报告标 `incomplete`（统计照做，但不得声称 E1 验证完成） | `checkPreregistration` / `E1RefusalError`；`checkMetricMetadata` |

### 1.1 E1 实例（校准实验，2026-09-14）

| 组 | 语义 | SSIM median | min–max | pHash median |
|---|---|---|---|---|
| **A′** | `--generate-type 1`（首尾帧同图） | **0.9275** | 0.9155–0.9398 | 1 |
| **B** | 单图参考 | 0.5510 | 0.5251–0.5906 | 3 |
| **C** | 无图 | 0.2550 | 0.2489–0.2968 | 31 |

- Δ(A−B)=**0.3765**、Δ(A−C)=**0.6726**；建议冻结 Δ=0.25（留约 33% 余量）、`ssim_abs_min`=0.80。
- 来源：`experiments/e1/calibration-2026-09-14.md`（**CALIBRATION ONLY**，n=4/组，低于 ≥10 要求，不是正式 E1 结论）。
- **预处理协议（v2.9 修订）**：先按视频帧宽高比中心 cover-crop，再统一 resize **512×512**（双线性），色彩空间 sRGB/BT.709，不锐化。
  实测：直接 resize 时 A/B/C 全塌到 0.23–0.33；cover-crop 后 A′ 0.769 vs B/C 0.23（`experiments/e1/smoke-2026-09-14.md`）。
- **正式 E1 仍是外部动作、尚未完成**：`PRD-v2.md` §7 的 E1 正式报告需真实生成实验；仓库只交付统计工具链与合成样例（`meta.synthetic:true`）。

### 1.2 报告字段（`tools/e1-report.js`）

| 字段 | 含义 |
|---|---|
| `first_frame_bound` | 相对判定通过 **且** 绝对门槛通过 |
| `absolute.{ssim_abs_min,a_median,pass}` | A 组绝对质量门槛 |
| `metrics` | 声明的 SSIM 实现/版本/参数 + `DEFAULT_PREPROCESSING` 合并 + 辅指标回显 |
| `incomplete_reasons` | 缺 `duration_value_range`/`lipsync`/`metrics` 等；不阻塞统计，但不得声称验证完成 |
| verdict | 未达阈值一律 `reference_guidance_only`，不允许人工解释为「基本可用」 |

## 2. 回归套件 = 永远在跑的评测

- 单文件：`tools/test/regression.test.js`；入口 `npm test`；**当前基线 458 passed / 0 failed**（2026-09-14 实测）。
- 分层（按测试内 `[...]` 章节前缀，可 `grep` 核验）：

| 层 | 章节前缀（节选） | 覆盖 |
|---|---|---|
| M0 不变量 | `M0-3`/`M0-4`/`M0-5`/`W1`–`W8`/`validateTake` | reject 终态、原子写故障注入、stale callback、catalog 恢复 |
| 迁移 | `M2-MG` | schema 1→2 显式迁移、幂等、注释保护 |
| 任务状态 | `A-BATCH`/`FIX3`/`R2`/`R3`/`DEBT` | 失败模型、状态-有效期分离、回调幂等、熔断、锁 |
| 时间线 | `M1-TL`/`M4a`/`M4b`/`M4c`/`OVF` | 帧号契约、continue_from、cut_join、approval、溢出策略 |
| E1 工具 | `M1-A`–`M1-G`/`A7`/`E1-COLLECT` | 统计契约、绝对门槛、采集与指标工具链 |
| Gate | `M5c`/`M5b`/`A8` | 适用矩阵、probe/decode、stage 哈希 |
| TTS / 音频 / 字幕 | `TTS`/`AUD`/`SUB`/`M5a` | 豆包 adapter（mock 离线）、loudnorm、SRT/封面 |
| 出片 / 草稿 | `FIN`/`DRAFT` | 帧口径出片、确定性、新集零成本校验 |

- **TDD 流程（新增改动）**：① 在 `tools/test/regression.test.js` 追加用例并确认**红**；
  ② 实现最小改动；③ 确认**绿**且不破坏既有 458 条；④ 主 agent 独立复跑（见 `01-agent-collaboration.md`）。
- 测试隔离：`os.tmpdir()`；零新依赖（`package.json` 仅 `js-yaml`）；ffmpeg 集成用例在缺二进制时 SKIP。

## 3. Release Gate 映射（`PRD-v2.md` §5，`tools/gate.js`）

**「同时满足以下全部条件，才称为能发布一集」**。条目 1..14，其中 4 拆 4a/4b（共 15 行）。

| 条目 | 内容 | 本地检查 | v1 | v2 |
|---|---|---|---|---|
| 1 | M0 回归全绿 | `external`（`opts.evidence.m0`；Gate 进程不跑套件） | ✅ | ✅ |
| 2 | schema v1/v2 fixtures | `external`（同上） | ✅ | ✅ |
| 3 | E1 报告存在且接口版本一致 | `opts.e1Report`/`--e1-report`；`first_frame_bound!==true` → fail | N/A | ✅ |
| 4a | 无 unresolved rejected/stale/blocked take | 遍历 timeline clips / `shot.selected_take` | ✅ | ✅ |
| 4b | bound approval record 有效 | `tools/approvals.js` `validateApprovals` | N/A | ✅ |
| 5 | 每个 clip 可解析到 selected video take | 含 `reuse_records[]` 恢复例外 | ✅ | ✅ |
| 6 | 对白 overflow=0 / spill 约束 | `tools/dialogue.js` `collectUnresolvedOverflow` | N/A | ✅ |
| 7 | 字幕 cue 落在 `[0, final_duration]` 且产物存在 | `parseSrtCues` + `episode.srt` 默认识别位 | ✅ | ✅ |
| 8 | A/V 长度误差 <100ms | `tools/probe.js` `checkAvLength` | ✅ | ✅ |
| 9 | 探测 + 完整解码 | `probe.verifyFinalMedia`（probe→spec→decode） | ✅ | ✅ |
| 10 | loudness 达标（I=−14±1，TP≤−1） | `audio.verifyLoudness`（`opts.loudness` 或 `--final` 分析） | N/A | ✅ |
| 11 | 封面可生成 | `cover.resolveCover` / `--cover` | N/A | ✅ |
| 12 | quota ledger 与事件流对账 | `reconcileQuotaLedger` | N/A | ✅ |
| 13 | cut_join junction 四要素验收有效 | 同 4b | N/A | ✅ |
| 14 | 同 toolchain 确定性 | `external`（用 `node tools/determinism.js <episode>` 取证） | ✅ | ✅ |

**status 语义（写死）**：`pass | fail | not_applicable | deferred | external`；`ok = 无 fail`；`releasable = ok && 无 deferred`；
`external` 不阻塞；单项内部异常 → 该条 fail + 摘要（不抛出）。有 fail → 退出码 **4**。

**桥接期政策（写死）**：`deferred` 不阻塞 `--final` 退出码，但打印 `NOT RELEASABLE — N deferred item(s)`；
`--gate-strict`/`--strict` 时 `deferred` 也 exit 4。当前仅剩 deferred 项 `#3`（E1 正式报告，实验暂停）与
`#12`（recovered/legacy 账本未初始化）——见 `TECH-DEBT.md`「M5 收尾」。`--preview` 不跑 Gate。

## 4. 何时该跑什么

| 改动类型 | 必跑 | 命令 |
|---|---|---|
| 改剧本 / 写 prompt | 零成本校验（零写盘/零网络/零 credits） | `node tools/validate-script.js <episode-dir>` |
| 改任何代码 | 全量回归 | `npm test` |
| 出片 | Gate + 确定性取证 | `node tools/gate.js <episode>`；`node tools/determinism.js <episode>` |
| 换模型 / 换接口 / 改参数位 | 重跑相应 E1 子项（报告版本不一致禁止进首帧约束模式；**消耗 credits，先经用户批准**） | `node tools/e1-collect.js --config <cfg> --prereg experiments/e1/preregistration.json` → `node tools/e1-report.js` |
| 改阈值 / 改预处理协议 | 重新预注册（冻结后不得改动；改动即新实验） | 更新 `preregistration.json` 并重跑 |

## 可执行检查

```bash
cd /Users/wangpeng/workspace/shows

# 1) 回归基线（必须 458 passed, 0 failed）
npm test

# 2) 测试分层可核验
grep -oE "console\.log\('\\\\n\[[^]]+\]" tools/test/regression.test.js | sed "s/.*\[//" | sort -u

# 3) Release Gate（--help 有；无 --final 时 8/9 会 fail，属预期）
node tools/gate.js --help
node tools/gate.js episodes/S01E01-pov --json | head -c 500

# 4) 确定性取证（需要可出片产物；无产物时报缺件，属预期）
node tools/determinism.js episodes/S01E01-pov --json 2>&1 | head -c 300 || true

# 5) E1 报告工具用法（无 --help，按实际用法）
node tools/e1-report.js experiments/e1-dataset.example.json
# 阈值预注册字段自检
node -e "const p=require('./experiments/e1/preregistration.json').meta;console.log(p.delta_preregistered,p.ssim_abs_min,p.delta_frozen_at)"
```
