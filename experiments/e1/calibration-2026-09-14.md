# E1 校准实验（2026-09-14，v2.9 cover-crop 口径）

> **CALIBRATION ONLY** — 用于确定 Δ 与 `ssim_abs_min`；**不是正式 E1 结论**（每层/每组 4 样本，远低于 ≥10 要求）。
> 通道：`pippit-tool-cli` 1.0.21 → `generate-video`；模型 `Seedance_2.0_mini_lite`；12 次生成、0 失败；credits 2135 → 1895（240）。

## 配置与素材

- `experiments/e1/config.calibration.json`：2 场景 × 3 组 × 2 seed = 12。
- keyframe：`assets/calib-keyframe-01.png`（人物 closeup）、`calib-keyframe-02.png`（场景 empty），均 **1280×720（16:9，ratio-matched）**。
- 组语义：**A′** = `generate_type=1` 首尾帧同图；**B** = 单图参考；**C** = 无图。
- 实测输出规格：**1254×720、24fps、5.088s**。
- 指标：`ffmpeg-ssim`（`cover_crop: to_video_aspect` → `512×512 bilinear`）+ pHash（同口径）。

## 结果（SSIM，n=4/组）

| 组 | median | min | max | pHash median |
|---|---|---|---|---|
| **A′** | **0.9275** | 0.9155 | 0.9398 | 1 |
| **B** | **0.5510** | 0.5251 | 0.5906 | 3 |
| **C** | **0.2550** | 0.2489 | 0.2968 | 31 |

- **Δ(A−B) = 0.3765**；**Δ(A−C) = 0.6726**。
- 分层中位数：closeup A′ 0.9159 / B 0.5282 / C 0.2729；empty A′ 0.9393 / B 0.5806 / C 0.2550。
- 证据图：`evidence/calibration-2026-09-14/contact-keyframe-A-B-C.png`（keyframe｜A′｜B｜C 的 frame0 2×2 对比）+ 单帧 PNG。

## 建议冻结值（写入正式 `preregistration.json`）

| 字段 | 建议值 | 依据 |
|---|---|---|
| `delta_preregistered` | **0.25** | 观测 Δ(A−B)=0.3765，留 ~33% 余量；B 组区间宽仅 ~0.065 |
| `ssim_abs_min` | **0.80** | A′ 最低观测 0.9155、B 最高 0.5906 → 0.80 可干净区分（0.85 亦可行但余量更小） |
| `delta_frozen_at` | 正式实验开始前写入 | 本校准数据不得用于事后调参重判 |

## 工具约定（本次发现）

- `e1-report.js` 只按组名 **A/B/C** 统计；本次 smoke/calibration 配置使用描述性组名（`A_first_last_same` 等），已通过**显式映射**生成 `calibration-dataset.abc.json` 供报告消费（未改动原始数据）。
- **正式 E1 配置必须直接使用组名 `A`/`B`/`C`**，语义放在 `adapter_params`。

## 正式 E1 预算缺口

- 全设计：4 层 × 3 场景 × 4 seed × 3 组 = **144 次**；按 ~20 credits/次 ≈ **2880 credits**；当前余额 **1895** → 缺口 **~985**。
- 选项：(a) 充值后跑全量；(b) 先跑缩减版（closeup+wide × 3 场景 × 4 seed × 3 组 = 72 次 ≈ 1440）并在报告中标注 `incomplete`（不构成完整 E1 判定）。
- 失败率预留：校准 0/12；smoke 1/6 被版权审核拦截 → 正式按 +10~20% 预留。

## 仍缺（报告会标 incomplete）

- `duration_value_range`、lip-sync 已依据官方手册补入（`[1,30]`；手册示例支持口型同步，待 M1 实测复核）——预注册文件已更新，不再标 incomplete。

## 实测复核（2026-09-14，4 次验证：prompt 首帧声明 + 480p）

| 组 | 请求 | SSIM | pHash | 结论 |
|---|---|---|---|---|
| prompt-first @720p | 单图参考 + prompt「图片 1 为首帧」 | 0.5046 / 0.4940 | 6 / 6 | **不锁 frame0**（与参考图位同级） |
| prompt-first @480p | 同上，`--resolution 480p` | 0.4238 / 0.4224 | 10 / 8 | 不锁；且**输出仍 1254×720**（480p 未生效） |
| （对照）A′ generate_type=1 @720p | 校准 4 样本 | **0.9275** | 1 | 锁定 |

- 4 次共 80 credits（~20/次，与 720p 一致）→ 直连 CLI 无 480p 降本空间。
- **A 组定版**：`--generate-type 1` + 首尾帧同图（校准用定义不变）；prompt 首帧声明仅适用 web/沉浸式短片 R2V，直连 CLI 不适用。
- 正式 E1 固定 720p，预算仍按 ~20 credits/次。
