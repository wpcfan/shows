# 04 · 成本与护栏

> 本篇回答：**一集多少钱**（固定公式 + 账本）、**什么动作必须人批准**、**出错如何兜底与留痕**。
> 权威契约：`PRD-v2.md` §4（发布硬性件·配额账本）、§3.5（失败模型/熔断）、§3.8（identity 与 digest 分离）；
> 实现：`tools/quota-ledger.js`、`tools/lock.js`、`tools/mark-shot.js`、`tools/tts-api-doubao.js`。

## 1. 成本模型

### 1.1 账本计数器（`manifest.quota_ledger`）

| 维度 | 值 |
|---|---|
| stage | `image`（keyframe）/ `tts` / `video` |
| 计数器 | `requests` / `successes` / `cache_hits` / `rejects` / `failed_billed` / `actual_cost` |
| 默认币种 | `USD`（`tools/quota-ledger.js:44` `DEFAULT_CURRENCY`） |
| 纯函数 | `emptyLedger` / `recordOutcome` / `computeCostPerAcceptedVideoShot` / `ledgerReport` |

写入时机（全部走原子写）：`render-next` 新建 task → `video.requests += 1`；幂等复用 → `cache_hits += 1`
（每个 task **至多一次**，task 上 `cache_hit_counted` 标记）；`mark-shot --take` → `successes += 1`；
`--reject`/`--review --conclusion reject` → `rejects += 1`；`--failed --task`（hard/熔断）→ `failed_billed += 1`；
可选 `--cost <n>` 累加到 `actual_cost`。

### 1.2 成本指标公式（写死，`PRD-v2.md` §4）

```
cost_per_accepted_video_shot =
    (image.actual_cost + tts.actual_cost + video.actual_cost)
  / count(distinct accepted video shots included in final timeline)
```

- 分母按 **distinct `shot_id`**（同一 shot 多个 clip 实例只算一次，剪辑方式不污染生成成本）；
- **cache hit 成本计 0**；
- **rejected 生成计入**（抽卡失败的钱也是钱）；
- failed request 供应商实扣则计入；
- 分母为 0 → 返回 `null` + warning（**不除零/不产生 NaN**）。

**请求次数不等于省钱**：方案对比必须用同一账本口径比较该指标；不成立则复盘审核策略（`PRD-v2.md` §4/§8）。

### 1.3 实测与预算（生成接口）

| 事实 | 数值 | 来源 |
|---|---|---|
| 单次生成 | ~**20 credits/次** | `experiments/e1/calibration-2026-09-14.md`、`pippit-seedance25-capabilities.md` |
| 校准实验 | 12 次 = **240 credits**（2135 → 1895） | `calibration-2026-09-14.md` |
| smoke | 8 次 ≈ **140 credits**（2275 → 2135） | `smoke-2026-09-14.md` |
| 实测复核（prompt 首帧 + 480p） | 4 次 = **80 credits**（1895 → 1815） | `calibration-2026-09-14.md` §实测复核 |
| **上轮校准后余额** | **1815** | 引用包 `project-facts.md`；可由上述收支链核对 |
| 全量 E1 预算 | 4 层 × 3 场景 × 4 seed × 3 组 = **144 次 ≈ 2880 credits**（缺口 ~1065） | `calibration-2026-09-14.md` |
| 缩减版 E1 预算 | closeup+wide × 3 场景 × 4 seed × 3 组 = **72 次 ≈ 1440 credits** | 同上；须在报告标 `incomplete` |
| 失败率预留 | 正式按 **+10~20%**（smoke 6 次中 1 次被审核拦截） | `smoke-2026-09-14.md` |
| 480p 降本 | 直连 CLI `--resolution 480p` **未生效**（输出仍 1254×720，成本不变）→ 该降本路径仅限 web 沉浸式短片 | `pippit-seedance25-capabilities.md`；`PRD-v2.md` §0 v2.11 |

### 1.4 TTS 计费（来源：Volcengine《计费说明》https://www.volcengine.com/docs/6561/1359370 ，访问 2026-09-14）

| 项 | 档位 |
|---|---|
| 豆包声音复刻/语音合成模型 2.0 资源包 | 10 万字/年 = **28 元**；2000 万字 = **5400 元**；20000 万字 = **48000 元** |
| 后付费 | **3 元/万字符** |
| 音色槽位 | 1–50 档，**138 元/音色** |
| 并发 | 正式版默认 **10 并发**；增购 **100 元/并发/月** |

本项目对应：provider 定版 `doubao` / `seed-tts-2.0`（字符计费）；`tts_hash` 按内容哈希缓存，重复派发命中不重复计 `request`。

## 2. 预算护栏（本项目规则）

| 护栏 | 规则 | 落地 |
|---|---|---|
| **真实生成必须批准** | 任何消耗 credits 的动作（keyframe/video/TTS 真实调用）先取得用户批准；不得虚构接口结果 | 引用包协作协议；`PRD-v2.md` §7 |
| **E1 的时机** | E1 插在**镜头表冻结之后、批量 video 之前** | `README.md`「E1 时机」；`new-episode.js` 生成的 README 亦写明 |
| **keyframe 先于 video** | `render-next` 默认队列 **keyframe-pending 优先**；`--video` 只返回 keyframe 已 selected 的 shot | `PRD-v2.md` §3.2；`tools/render-next.js` |
| **零 credits 边界** | `validate-script` → `build-manifest` → `build-timeline` 均为**零 credits**（零写盘/零网络/零 credits）；`keyframe`（图）与 `video`（视频）生成才算钱 | `README.md`「DRAFT」；`tools/validate-script.js` |
| **离线通道** | `TTS_MOCK=1 TTS_MOCK_AUDIO=<真实音频夹具>` → 不联网、不消耗额度；缺夹具报错（**拒绝伪造静音 mp3**） | `tools/tts-api-doubao.js`；回归 `TTS5` |
| **一次一个** | TTS 不自动批量；本工具一次只处理一个 `--task`，批量编排由调用方逐任务驱动 | `PRD-v2.md` §3.5 |

## 3. 安全护栏

| 护栏 | 机制 | 落地 |
|---|---|---|
| **内容审核拦截** | 真实生成可能被平台审核阻断（smoke：6 次中 1 次「内容涉及版权限制」）→ 预留 10–20% 失败率与重试预算 | `experiments/e1/smoke-2026-09-14.md` |
| **失败模型** | hard 与 transient **一律先进入 `retry_wait`**（60s 起指数 ×2，上限 900s）累计；只有显式 `--terminal` 才进终态 `failed` | `PRD-v2.md` §3.5；`tools/mark-shot.js`；回归 `A-BATCH-A1a` |
| **熔断三维** | 同 task hard ≥3 / 同 task transient ≥10 / 同 shot 跨 input_hash 的 hard-failure 快照数 ≥5 → `blocked` | `PRD-v2.md` §3.5；`--unblock` 升 `breaker_epoch` 并释放 |
| **幂等键** | 成功回调幂等键 = `(request_id, content_digest)` 或 `attempt_id`，**与 task 解耦**；同 request 同 digest 幂等返回，异 digest 冲突抛错且零改动 | `PRD-v2.md` §3.5 附录 A7；回归 `A-BATCH-A9` |
| **identity vs digest** | 跨对象绑定用 content digest，不用 take id；take id 变了内容相同不产生假失效，内容变了 id 没变必然失效 | `PRD-v2.md` §3.8；回归 `A8a` |
| **supersede 语义** | `task.superseded_at` 独立表达失效；**一跳自动失效**，更下游列警告；`reuse_records[]` 按 fingerprint 复现恢复素材，不改写历史 | `PRD-v2.md` §3.3/§3.5 |
| **跨进程锁** | `tools/lock.js`：`fs.openSync(path,'wx')` 原子获取，死 pid/超龄（默认 60000ms）回收，`timeoutMs`（默认 10000）后抛 `lock timeout`；`mark-shot`/`render-next`/`build-manifest`/`migrate-episode` 接线 | `README.md`「持久化」；回归 `DEBT-D6a`–`D6g` |
| **原子写与崩溃恢复** | tmp + rename；故障注入 `SHOWS_FAULT_ATOMIC_WRITE=before-tmp-write|after-tmp-write`；读侧清残留 tmp 并识别损坏 JSON，fail-closed | `README.md`「持久化」；回归 `M0-4` |
| **确定性出片** | 同 toolchain 两次出片解码视频流 MD5 / 音频 PCM SHA256 一致（Gate #14） | `tools/determinism.js`；`tools/render-final.js` 固定 ffmpeg 参数 |

## 4. 审计与可回放

| 审计面 | 载体 | 说明 |
|---|---|---|
| 事件流 | `manifest.task_events[]`：`{task_id, attempt_id, request_id, shot_id, stage, n, kind, kind_source, error, at, retry_after, epoch}` | 每次尝试留痕；按 `attempt_id` 或 `(task_id,n)` 幂等；`build-manifest` 重建时与 `render_tasks` 一起保留 |
| attempt 列表 | `task.attempts[]`：`{attempt_id, at, input_hash}` | 回调按 attempt 身份解析（`resolveAttempt`），`current_attempt_id` 仅作兼容展示 |
| 人工验收 | `manifest.approvals[]` + `manifest.approval_history[]` | 记录 `bindings.content_digest` + 语义参数；重复确认覆盖为最新、旧记录留历史 |
| take 状态机 | `candidate → selected | rejected`（`rejected` 终态）；旧 input 产物 → `superseded` | `validateTake()` 是「能否用于成片」的唯一权威判定 |
| 事件流原则 | 「把一切记录成事件流以便审计/回放」 | 来源：https://github.com/humanlayer/12-factor-agents ，访问 2026-09-14 |

## 可执行检查

```bash
cd /Users/wangpeng/workspace/shows

# 1) 账本纯函数可用 + 成本公式分母语义（rejected 计入；同 shot 多 clip 只算一次）
node -e "
const q=require('./tools/quota-ledger');
const l=q.emptyLedger();
q.recordOutcome(l,'video','success',{cost:20}); q.recordOutcome(l,'video','reject',{cost:20});
console.log('成本公式入口 ->',typeof q.computeCostPerAcceptedVideoShot);
console.log('1 shot ->', q.computeCostPerAcceptedVideoShot(l, [{shot_id:'s01'}]));
console.log('同 shot 两个 clip ->', q.computeCostPerAcceptedVideoShot(l, [{shot_id:'s01'},{shot_id:'s01'}]));
console.log('无 accepted shot ->', q.computeCostPerAcceptedVideoShot(l, []));
"

# 2) 抽查某集账本（旧集可能无 quota_ledger，属预期）
node -e "const m=require('./episodes/S01E01-pov/manifest.json');console.log('schema',m.schema_version,'ledger',m.quota_ledger?'present':'absent')"

# 3) Gate 对账（#12 quota ledger）
node tools/gate.js episodes/S01E01-pov --json | grep -A6 '"id": "12"' || true

# 4) 锁与崩溃残留
find . -name '*.lock' -not -path './node_modules/*'
find . -name '*.tmp' -not -path './node_modules/*'

# 5) 确定性取证脚本入口
node -e "require('./tools/determinism');require('./tools/quota-ledger');require('./tools/lock');console.log('load OK')"

# 6) TTS 离线通道（不联网、不消耗额度；缺夹具会报错，属预期语义）
TTS_MOCK=1 node -e "require('./tools/tts-api-doubao');console.log('adapter load OK')"
```
