# AGENTS.md — shows 短剧流水线

> AI coding agent 的专用上下文入口（标准：https://agents.md/ ，访问 2026-09-14）。
> 人类文档见 `README.md`；契约见 `PRD-v2.md`（v2.13 FROZEN）；工程方法与来源见 `docs/ai-engineering/`。

## 这是什么

`script.yaml` → manifest（stage 哈希/任务快照）→ keyframe/video/TTS（外部生成）→ `timeline.json`（帧口径、cut_join/padding/spill）→ 音轨 + 字幕 + 封面 → 帧口径出片 → Release Gate 发布判定。

## 常用命令

```bash
npm test                                              # 回归（node --test；当前基线 458 passed / 0 failed）
node tools/new-episode.js --draft <slug>              # 新集草稿（episodes/_drafts/<slug>）
node tools/validate-script.js <dir>                   # 剧本零成本校验（只读、零网络、零 credits）
node tools/build-manifest.js <dir>                    # 本地编译（零 credits）
node tools/build-timeline.js <dir>                    # 时间线（需要 edit.yaml；零 credits）
node tools/render-final.js <dir>                      # v2 帧口径出片
node tools/gate.js <dir>                              # Release Gate（§5）
node tools/determinism.js <dir>                       # 同 toolchain 确定性取证（Gate #14）
```

- 新集迭代循环与 credits 边界：`episodes/_drafts/<slug>/README.md`。
- 协作/验证协议：`docs/ai-engineering/01-agent-collaboration.md`。
- 模型能力与提示词契约：`docs/ai-engineering/02-model-and-prompt-contract.md`。
- 评测与发布：`docs/ai-engineering/03-evaluation-and-release.md`。
- 成本与护栏：`docs/ai-engineering/04-cost-and-guardrails.md`。

## 硬性约束（不得违反）

- **冻结文件**：`episodes/S01E01-pov/**`、`catalog.json` 不得改动；`PRD-v2.md` 仅在用户批准后修订（版本记录一句话）。
- **真实生成花钱**：keyframe/video/E1/TTS 真实调用消耗 credits（E1 ≈20/次，余额见 `experiments/e1/` 记录）→ 先经用户批准；禁止虚构接口结果。
- **TDD**：先写失败测试再改实现；测试用 `os.tmpdir()` 隔离；ffmpeg 用例 `testFfmpeg` 门控；零新依赖、CommonJS。
- **零 credits 边界**：`validate-script` / `build-manifest` / `build-timeline` 不花钱；keyframe / video / E1 花钱。
- **并发与原子**：跨进程写用 `tools/lock.js`（`withLock`）；写盘用 `atomicWriteJson`（tmp+rename）。
- **收尾检查**：`npm test` 全绿；生产数据哈希前后一致；无 `.lock/.tmp` 残留。

## 工作方式

- 大改动走 worker 子代理：规格文件（目标/约束/接口/验收/禁止项）→ worker 产出 → **主 agent 独立复现验证**（不采信自述）→ 全量回归。
- 每次改动给出可复现证据：测试输出、哈希对比、真实命令。
- 反模式（本项目踩过）：引用旧记录当现状、只跑套件不验证语义、为过测试改弱不变量、并行 worker 同改一个测试文件。
