# experiments — E1 首帧能力实验(PRD §3.1)

本目录存放 **E1 统计契约** 的输入数据集与说明。工具为 `tools/e1-report.js`。

> **E1 正式报告需要真实生成实验(外部动作)**:真实调用生成接口、按分层测试集采集数据、预注册 Δ 后
> 冻结,再运行本工具。本仓库当前**只交付统计工具链与合成样例**,**没有**任何声称来自真实接口的 E1 结论。
> `e1-dataset.example.json` 是**虚构的合成样例**(`meta.synthetic: true`),仅用于验证工具链可运行,
> 不可引用为接口能力证据。

## 为什么需要预注册

PRD §3.1 要求**两个阈值一同冻结**:Δ(A 组相对 B/C 的 SSIM 中位数提升量,`delta_preregistered`)
与 **A 组绝对质量门槛**(`ssim_abs_min`),并在**首次校准实验后、查看正式实验结果前**写入
`delta_frozen_at`,写入报告后不可再改。这是防 post-hoc 调阈值的硬约束。

因此 `tools/e1-report.js` 在缺失 `delta_preregistered`、`ssim_abs_min` 或 `delta_frozen_at` 任一时
**拒绝出结论**(退出码 2),提示先完成预注册。仅「相对 B/C 有提升」不足以承诺首帧约束:
若 A/B/C 都低,说明该参数位不具备可用首帧能力,故必须有绝对门槛。

## 数据集字段

```jsonc
{
  "meta": {
    "interface_name": "…",              // 被测接口名
    "interface_version": "…",           // 接口版本(接口变更需重跑并记录)
    "params_position": "first_frame",   // 首帧参数位标识
    "experiment_date": "YYYY-MM-DD",
    "delta_preregistered": 0.1,         // Δ,预注册阈值(建议初值 0.1)
    "ssim_abs_min": 0.8,                // A 组绝对质量门槛(与 Δ 一同冻结;缺失 → 拒绝出结论)
    "delta_frozen_at": "YYYY-MM-DDTHH:MM:SSZ", // 预注册冻结时间(缺失 → 拒绝出结论)
    "metrics": {                        // 度量与预处理口径(缺失 → incomplete,不阻塞统计)
      "ssim": {
        "impl": "skimage.metrics.structural_similarity", // SSIM 实现名(缺失 → incomplete)
        "version": "0.22.0",                            // 实现版本(缺失 → incomplete)
        "params": { "window": 7, "gaussian": true, "K1": 0.01, "K2": 0.03, "data_range": 255 },
        "preprocessing": { "cover_crop": "to_video_aspect", "resize": "512x512-bilinear", "color_space": "sRGB", "sharpen": false }
      },
      "secondary": { "field": "phash_distance", "impl": "imagehash.phash", "version": "4.3.1" }
    },
    "bootstrap_iterations": 1000,       // 必须 ≥ 1000
    "duration_value_range": [5, 10],    // 接口支持的 duration 值域(E1 同期记录)
    "lipsync": { "supported": false, "source": "…", "verified_at": "…" }, // lip-sync 复核(附来源+日期)
    "synthetic": false                  // true = 虚构合成样例,报告会大声标注
  },
  "samples": [
    {
      "group": "A",                     // A=首帧参数位 | B=参考图位 | C=无图
      "layer": "closeup",               // closeup | wide | empty | motion
      "scene": "scene-01",              // 至少 3 个不同场景素材,不允许同一素材凑数
      "prompt_id": "prompt-01",         // 与 scene 组成 cluster 键
      "seed": 1234,                     // 同 cluster 不同 seed 是 cluster 内重复观测
      "ssim": 0.87,                     // 主指标:输入图 vs 视频第 0 帧 SSIM
      "phash_distance": 6,              // 辅指标(二选一):pHash 汉明距离
      "lpips": 0.08                     // 或 LPIPS(取数据集提供的那个)
    }
  ]
}
```

## 运行方式

```bash
# 文本报告 + 机读 JSON
node tools/e1-report.js experiments/e1-dataset.example.json --json /tmp/e1.json

# 可复现:指定 bootstrap 种子 / 迭代次数(缺省 seed=20250101, iterations=max(meta.bootstrap_iterations,1000))
node tools/e1-report.js <dataset.json> --seed 42 --iterations 2000
```

- 退出码:`0` 成功;`2` 预注册缺失(拒绝出结论);`3` 读取/其它错误。
- 输出:human-readable 文本(stdout)+ 可选 `--json <path>` 机读报告。

## 统计口径(实现)

- 主指标 **SSIM**;辅指标 pHash 汉明距离或 LPIPS(取数据集提供的那个,报告写明实现与版本字段)。
- 分组中位数;`Δ_A_B = median(A) − median(B)`,`Δ_A_C` 同理。
- **cluster bootstrap**:以 `scene::prompt_id` 为 cluster **有放回重采样**(≥ `bootstrap_iterations` 次),
  95% CI 用 percentile 法。同 scene 不同 seed 属 cluster 内重复观测,不放大样本量。
  随机数固定种子可复现。
- **分层判定**:closeup / wide / empty / motion 四层,每层每 group ≥ 10 样本才可判定;
  样本不足 → 该层 `status='insufficient'`,整体判定降级。
- **判定「首帧约束成立」需同时满足**:
  1. A 中位数较 B、较 C 均提升 ≥ Δ;
  2. A−B、A−C 的 95% CI 均不跨 0;
  3. 四层分别满足,或至少 closeup+wide 全部满足且其余层无反向显著;
  4. **A 组绝对质量门槛**:`median(A) ≥ ssim_abs_min`(预注册,与 Δ 一同冻结)。
- 不满足 → `verdict='reference_guidance_only'`(仅参考引导),并明确
  **「不允许人工解释为基本可用」**。绝对门槛不通过时 reason 形如
  `A-group absolute median <a_median> < ssim_abs_min <thr>`;机读报告含 `absolute: { ssim_abs_min, a_median, pass }`。
- 缺 `duration_value_range` / `lipsync` → 报告 `incomplete=true`(统计照做,但不得声称 E1 验证完成)。

### 预处理与度量口径(PRD §3.1 写死)

- **预处理协议**(`DEFAULT_PREPROCESSING`,报告按缺省补齐后回显):
  `{ cover_crop: 'to_video_aspect', resize: '512x512-bilinear', color_space: 'sRGB', sharpen: false }`。
  视频侧取第 0 帧;**输入图先按视频帧宽高比做中心 cover-crop**,再与首帧统一 resize 到 512×512 双线性、色彩空间统一到 sRGB/BT.709;
  **不做锐化/对比度增强**(`sharpen: true` → incomplete)。v2.9 起 cover-crop 为必填口径;方图输入 vs 16:9 视频直接 resize 会因形变不均失去区分度。
- `metrics.ssim` 必须记录实现名 + 版本 + 参数(`window/gaussian/K1/K2/data_range`);
  实际使用辅指标时 `metrics.secondary.impl/version` 必须记录。
- 以上任一缺失 → 只进 `incomplete_reasons`(统计与 verdict 照做,但**不得声称 E1 验证完成**),
  **不**触发 refusal;`color_space` 必须在 `{sRGB, BT.709}` 内。
- 机读报告含 `metrics`(声明的 `metrics.ssim` 与 `DEFAULT_PREPROCESSING` 合并 + `secondary` 回显)。

## 真实实验纪律(外部动作)

1. 固定 `interface_name` / `interface_version` / `params_position`,记录日期。
2. 先跑校准实验 → 冻结 Δ 与 `delta_frozen_at` → 才允许查看正式结果(不得先看结果再定阈值)。
3. 分层测试集:近景/全景/空镜/运动起始各 ≥10 次,至少 3 个不同场景素材。
4. 成对实验:同 `scene`+`prompt_id` 只改图的传入位置(A/B/C),相同随机种子策略。
5. 采集样本写入数据集 JSON(不含 `synthetic`),运行 `tools/e1-report.js`。
6. 报告与 M1/M2 的 §3.2 承诺强度绑定;接口版本变更需重跑相应子项(Release Gate 第 3 条)。

## 合成样例

`e1-dataset.example.json` 为确定性生成的虚构数据(144 条),结论被刻意构造成
`reference_guidance_only` 且 `incomplete`(lip-sync 未复核);其 `meta.ssim_abs_min = 0.8` 高于
A 组中位数(≈0.61),因此**绝对门槛也刻意不通过**,用于演示工具链,**不构成任何真实结论**。

## 采集与指标工具链(`e1-collect` + `e1-metrics`)

`tools/e1-report.js` 只负责统计。采集(调用生成接口、抽帧、算 SSIM/pHash、断点续跑、记账)
由 `tools/e1-collect.js`(runner)与 `tools/e1-metrics.js`(指标核心)完成。链路:

```
config.json ──► e1-collect(样本矩阵)
                  │  对每个未完成样本调用 adapter.generate({sample, outPath})
                  ▼
              records.jsonl(断点续跑) + ledger.json(配额账本) + artifacts/*.mp4
                  │  e1-metrics:抽第 0 帧 → SSIM(input, frame0) + pHash 距离
                  ▼
              dataset.json ──► tools/e1-report.js
```

> **红线**:真实实验必须(a)提供真实生成 adapter 替换 `experiments/e1/adapters/mock.js`,
> (b)提供预注册文件(`--prereg`,含冻结的 Δ/`ssim_abs_min`/`delta_frozen_at`)。仓库内
> `mock.js` 由本机 ffmpeg 合成视频,**仅用于演练工具链,不得作为接口能力证据、不得据此宣称 E1 结论**。
>
> 真实接口所需信息(调用形状、首帧/参考图字段、结果获取、能力记录)见
> `experiments/e1/interface-info.template.md`——填完后可据此编写 adapter。

### 配置 schema(`--config`)

```jsonc
{
  "output_dir": "experiments/e1/data",     // 运行产物目录(records/ledger/artifacts/frames/dataset)
  "adapter": "experiments/e1/adapters/mock.js", // adapter 模块路径(相对 cwd 或绝对;--adapter 覆盖)
  "delay_ms": 0,                           // 每次 adapter 调用后的间隔
  "max_retries": 2,                        // 单样本最多尝试次数(含首次);失败达到上限后不再重试
  "synthetic": true,                       // mock 必须 true;真实实验 false
  "groups": [
    { "id": "A", "params_position": "first_frame" },
    { "id": "B", "params_position": "reference_image" },
    { "id": "C", "params_position": null }
  ],
  "cases": [{
    "scene": "scene-01",                   // 与 prompt_id 组成 cluster 键(≥3 个不同 scene 才算完整实验)
    "prompt_id": "prompt-01",
    "layer": "closeup",                    // closeup | wide | empty | motion
    "prompt": "...",
    "image": "assets/scene-01-closeup.png",// 相对 config 文件目录解析;可为绝对路径
    "seeds": [1, 2],
    "duration": 8, "ratio": "16:9", "resolution": "720p", "model": "..."
  }]
}
```

- 样本矩阵 = `cases × groups × seeds`,顺序确定;`sample_id = <scene>__<prompt_id>__<layer>__<group>__seed-<n>`(路径安全化)。
- `groups[].adapter_params`(可选,对象):原样透传到 `sample.adapter_params`,由 adapter 解释(例如 pippit adapter 的 `generate_type`/`image_mode`);runner 不解释内容,仅做深拷贝。
- **组名约定**:`e1-report.js` 按组名 `A`/`B`/`C` 统计——正式 E1 配置必须直接使用这三个组名,语义(首帧/参考图/无图)放在 `adapter_params`。
- 产物写到 `<output_dir>/artifacts/<sample_id>.mp4`。
- 指标口径:`inputImage` 为 case 的 `image`(A/B/C 三组都用它做「意图首帧」参照,成对实验);case 无图时记 `null`。
- 预处理与实现写死:输入图先按视频帧宽高比做中心 cover-crop,再 `[0:v]crop=...,scale=512:512:flags=bilinear,format=rgb24`;帧侧直接 `scale=512:512`(见 `tools/e1-metrics.js` 的 `ssimFilterGraph(target)`);
  pHash 由本工具纯 JS 2D DCT-II 计算(同口径 cover-crop → 32×32 gray → 左上 8×8 DCT → 中位数置位 → 16 位 hex),两者实现名/版本写入数据集。

### Adapter 契约

```js
// module.exports = { name, generate({ sample, outPath }) }   // generate 可 async
module.exports = {
  name: 'my-real-interface',
  async generate({ sample, outPath }) {
    // 必须把生成产物写到 outPath;返回 { request_id }
    // sample: { sample_id, group, params_position, scene, prompt_id, layer, seed,
    //           prompt, image, duration, ratio, resolution, model }
    return { request_id: 'req-...' };
  }
};
```

- adapter 只负责「发请求 + 落盘」;断点续跑、记账、指标全部由 runner 管理。
- 真实接口名/版本从 `--prereg` 注入数据集 `meta`(adapter 内部可读 `sample` 字段自行决定请求参数)。
- 组需要图(`params_position` 非空)但 `sample.image` 缺失时,adapter 应抛错;runner 记录 `failed` 并计入 ledger。

### 小云雀(pippit-tool-cli)adapter

`experiments/e1/adapters/pippit.js` 通过本机已登录的 CLI 调 Seedance 模型:

| E1 组 | `adapter_params` | CLI 实际调用 |
|---|---|---|
| A′(首帧位替代) | `{generate_type:1, image_mode:'first_last_same'}` | `generate-video --generate-type 1 --image X --image X`（首尾帧同图） |
| B(参考图位) | `{image_mode:'single'}` | `generate-video --image X` |
| C(无图) | `{image_mode:'none'}` | `generate-video`（无 --image） |
| 探测 | `{generate_type:N, image_mode:'single'}` | `generate-video --generate-type N --image X` |

- 结果流:`generate-video` → `thread_id/run_id` → 轮询 `query-result --download-dir` → `videos[0].output_path` 拷到 `artifacts/<sample_id>.mp4`;`request_id = <thread_id>/<run_id>`。
- 环境变量:`PIPPIT_CLI_BIN`(默认 `pippit-tool-cli`)、`E1_PIPPIT_POLL_MS`(默认 10000)、`E1_PIPPIT_TIMEOUT_MS`(默认 900000)、`E1_PIPPIT_MODEL`(model 缺省时兜底)。
- 通道事实(v1.0.21):无「仅首帧」参数位;`generate_type=1` 必须两张图;无 seed 字段 → E1 的 seed 以「同条件重复观测」代替并在报告中注明。

```bash
# smoke(3 组 × 2 次 = 6 次生成)
node tools/e1-collect.js --config experiments/e1/config.smoke.json \
  --prereg experiments/e1/preregistration.smoke.json --out experiments/e1/data/smoke-dataset.json
# generate_type 探测(2 次生成)
node tools/e1-collect.js --config experiments/e1/config.probe.json \
  --prereg experiments/e1/preregistration.smoke.json --out experiments/e1/data/probe-dataset.json
```

> 真实调用会消耗 credits;先 `--dry-run` 确认矩阵,再执行。
>
> **接口能力备忘（2026-09-14）**：官方手册要点（30s 单次时长、R2V prompt 首句声明首/尾帧、参考图≠首帧、口型同步示例、80p+超分降本、素材上限、负向控制）见 `experiments/e1/pippit-seedance25-capabilities.md`；E1 prompt 建议统一加「不要字幕」负向控制。
>
> **2026-09-14 smoke 结果**：A′（首尾帧同图）锁定首帧（cover-crop SSIM 0.77，目视同图），B/C 与探测的 `generate_type=2/3` 均不锁（≈0.23）；输入图宽比与视频不一致时现 512×512 协议会失真，需选「强制 ratio-matched keyframe」或「协议增加 cover-crop」；另发现无 seed、审核拦截 1/6、输出 1254×720。详见
> `experiments/e1/smoke-2026-09-14.md`（含证据图 `experiments/e1/evidence/smoke-2026-09-14/`）。
>
> **2026-09-14 校准（v2.9 口径，12 次）**：A′ 0.9275 / B 0.5510 / C 0.2550（ratio-matched keyframe + cover-crop）；建议冻结 `Δ=0.25`、`ssim_abs_min=0.80`。详见 `experiments/e1/calibration-2026-09-14.md`（证据 `experiments/e1/evidence/calibration-2026-09-14/`）。

### 命令示例

```bash
# 1) mock 演练(端到端,不联网;产物仅用于验证工具链)
#    config.mock.json = 3 场景 × 4 层 × 3 组 × 4 seed = 144 样本;完整跑约 17s,`--limit N` 可小批量
node tools/e1-collect.js --config experiments/e1/config.mock.json \
  --prereg experiments/e1/preregistration.template.json --dry-run     # 只看矩阵
node tools/e1-collect.js --config experiments/e1/config.mock.json \
  --prereg experiments/e1/preregistration.template.json --limit 6     # 小批量演练

# 2) 真实实验(必须替换 adapter + 提供已冻结的 prereg)
node tools/e1-collect.js --config experiments/e1/config.real.json \
  --adapter /path/to/real-adapter.js --prereg experiments/e1/preregistration.json \
  --out experiments/e1/dataset.json
node tools/e1-report.js experiments/e1/dataset.json --json experiments/e1/report.json

# 3) 只重算指标(不重新生成)
node tools/e1-collect.js --config experiments/e1/config.real.json --metrics-only
```

CLI 选项:`--config` / `--adapter` / `--out` / `--prereg` / `--limit N` / `--dry-run` / `--metrics-only`。

### 预注册流程

1. 复制 `experiments/e1/preregistration.template.json` → `preregistration.json`。
2. 先跑**校准实验**(少量样本),据此选定 `delta_preregistered`(Δ,建议初值 0.1)与 `ssim_abs_min`(A 组绝对门槛)。
3. 写入 `delta_frozen_at`(UTC ISO8601)与真实接口信息(`interface_name`/`interface_version`/`params_position`/`experiment_date`)、
   `metrics`(SSIM/pHash 实现与版本)、`duration_value_range`、`lipsync`(含 `verified_at`)。
4. **冻结后、查看正式结果前**完成上述写入;之后不得再改。缺任一预注册字段 → `e1-report` 拒绝出结论(exit 2)。
5. 正式采集时用 `--prereg preregistration.json`;若省略该参数,runner 会打印 WARN,数据集不含预注册字段。

### 产物说明

| 产物 | 路径 | 说明 |
|---|---|---|
| `records.jsonl` | `<output_dir>/records.jsonl` | 逐样本 append-only 状态:`{sample_id,status:'done'\|'failed',request_id,artifact_path,attempts,error,at}`;启动时加载并跳过 done,failed 在未达 `max_retries` 前重试 |
| `ledger.json` | `<output_dir>/ledger.json` | 配额账本:`requests/successes/failures` + `by_group`;每次调用 adapter 前 `+requests`;原子写(`atomicWriteJson`) |
| `artifacts/` | `<output_dir>/artifacts/<sample_id>.mp4` | 生成产物 |
| `frames/` | `<output_dir>/frames/*.frame0.png` | 抽出的第 0 帧(指标中间产物) |
| `dataset.json` | `<output_dir>/dataset.json`(或 `--out`) | 供 `tools/e1-report.js` 消费;`meta` = `--prereg` 的 meta 原样合并 + `collection` + `synthetic`;`samples` 字段与 README「数据集字段」一致 |

`meta.collection = { tool:'e1-collect', adapter:<name>, collected_at:<ISO>, records:'records.jsonl' }`。
