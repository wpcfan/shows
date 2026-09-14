# 技术债务清单（PRD v2.3 实施）

记录已确认但按里程碑延后处理的评审项。每条含触发时机，届时随对应里程碑一起处理，避免无归属漂移。

## 待处理债务

（无。D2 / D3 / D5 / D6 / D7 / D8 已在本轮闭环，见「已关闭」；D4 属 PRD M5 既定工作，见下。）

## 既定工作（非债务）

（无。D4 已于 M5-EDIT/D4 交付，见「已关闭」；v1 秒制路径按 PRD §6 保留。）

## 已关闭（工程基础设施改进）

- **测试框架迁移（custom → `node:test`）→ 已关闭**：`tools/test/helpers.js` 改为 `node:test` 薄包装（`test()`/`testAsync()` 委托 `node:test` 的 `test()`；`throws()`/`throwsAsync()` 保持原签名）；删除 `tools/test/run.js`（自定义 runner 不再需要）；`package.json` 的 test script 改为 `node --test tools/test/*.test.js`（每个测试文件独立子进程运行）。fixture helpers（`mkTempDir`/`writeManifest`/`readManifest`/`shotBase`）不变。458 tests / 0 failed，零测试文件改动。
- **TTS Provider 抽象 → 已关闭**：新增 `tools/tts-providers.js`（`register(provider)` / `getProvider(name)` / `listProviders()`；doubao 预注册为内置 provider）；`tts.js` 的 `defaultSynth` 改为按 `provider.name` 派发到注册表（`getProvider(name).synth(...)`），不再硬编码 `synthDoubao`；`classifyTtsError` 保留为 provider-agnostic 共享工具。扩展新 TTS provider 只需 `register({name, synth, classifyError})`。458 tests / 0 failed。

## 已关闭（PRD v2.13 M5-EDIT/D4 帧口径出片 + 确定性）

- **D4（`edit-episode` 消费 `timeline.json` + 帧口径最终出片 + Gate #14 确定性）→ 已交付**：
  - 新增 `tools/render-final.js`：`clipRenderArgs({clip, takePath, fps, width, height, srcDurationFrames, outPath})` 纯函数（入点 = `(source_in + deleted_head_frames)/fps`、删帧右移不改写 `source_in`、`-t` 截到 `source_out` 使 `tpad=stop_mode=clone` 静帧补长生效、`-frames:v = source_out-source_in-deleted_head_frames+padding_frames`、复用 `junction.cfrNormalizeArgs` 的 CFR 滤镜链、追加 `-fflags +bitexact -flags +bitexact -map_metadata -1 -threads 1`）；`renderFinal({absEpDir, manifest, timeline, outPath, opts})` 逐 clip 渲染 → concat `-c copy` → 混流 `<episode-dir>/audio/program.m4a`（`requires_audio`；`audio:none` 不加轨；`silent:true` 允许无轨）→ 字幕 `<episode-dir>/episode.srt`（默认 soft/mov_text；`burn`/`both` 无 libass 降级 soft + WARN）→ 封面 `<episode-dir>/cover.png` → `probe.verifyFinalMedia` v2 全量规格 + 完整解码 + A/V 长度；失败清理 outPath；`determinismDigests` 输出解码视频流 MD5 + 音频 PCM SHA256。
  - 新增 `tools/determinism.js`（Gate #14 取证）：同 `renderFinal` 复跑两次到不同路径，比较摘要，输出 `{ok, first, second, video_md5_equal, audio_md5_equal}`，不一致非零退出（`--keep` 保留产物）。
  - 入口接线（**v1 行为不变**）：`stitch-episode --final` / `edit-episode` 在 `schema_version >= 2` 且 `<episode-dir>/timeline.json` 存在时委托 `renderFinal`（保留既有前置校验与 Gate 顺序：offline gate → renderFinal → 媒体 Gate；媒体 Gate 复用 renderFinal 的 probe/decode 结果）；否则走既有秒制路径；两处均打印模式说明 `v2 timeline render (frame-accurate, PRD §3.6)` / `legacy seconds render (v1 semantics)`。
  - `gate.js` `#14`：保持 `external` 状态语义，external 文案改为提示用 `node tools/determinism.js <episode-dir>` 取证。
  - 回归 `FIN1`–`FIN8`（`clipRenderArgs` 纯函数/帧精确单像素/多 clip+A/V/字幕 soft·burn 降级·none/封面/缺件 fail-closed/确定性 + CLI/v1·v2 入口兼容）。
  - **M5 收尾**：仅剩 deferred 项 #3（E1 正式报告，实验暂停）与 #12（recovered/legacy 账本未初始化）。

## 已关闭（PRD v2.13 M5-TTS 接线）

- **M5-TTS 接线 → 已交付**：TTS provider 定版 `doubao` / `seed-tts-2.0`（PRD v2.13）。
  - `build-manifest`：`shot.dialogue`（字符串 / `{text, voice_id}`）解析与 voice_id 优先级（`shot.dialogue.voice_id` → `shot.voice_id` → `scene.voice_id` → `script.tts.voice_id` → `series.tts.voice_id`）fail-closed（有对白无 voice → exit 4 不写盘）；provider 优先级 `script.tts` → `series.tts` → 默认 `{name:'doubao',model:'seed-tts-2.0',version:'2026-09-14'}`（缺 `name`/`model`/`version` → exit 4）；`tts_hash = computeStagePayloadHash({schemaVersion, stage:'tts', dialogueText, voiceId, provider, ttsParams, styleGuideDigest: null})`；`estimateDialogueSeconds` 仅预警；有对白才写 `dialogue_text`/`voice_id`/`tts_hash`/`tts_takes`/`selected_tts`（无对白字段不漂移，重建保留 takes/selected）。
  - `render-next`：`targetStage` 识别 tts（`tts_takes[]` 中非 rejected 且 `input_hash === tts_hash` 视为可用，`selected_tts` 优先）；派发顺序 **tts → keyframe → video**；`take_id` 前缀 `tts-`；`task.tts = {dialogue_text, voice_id, provider, tts_params}`；FIX3-1 重算核对；**产物级缓存**命中不建任务、幂等计一次 `tts.cache_hits`；账本 stage 映射 `keyframe→image`、`tts→tts`、其余 `video`。
  - 新增 `tools/tts-api-doubao.js`（`synthDoubao` / `parseDoubaoStream` / `classifyTtsError`；`TTS_MOCK=1` + `TTS_MOCK_AUDIO` 离线夹具，缺 apiKey 抛错含 env 名，4xx→hard、5xx/超时/网络→transient）与 `tools/tts.js`（`--task` / `--take` / `--select` / `--list` / `--env-file`；原子写 `audio/`；幂等；失败不自动记账并非零退出）。
  - `mark-shot --failed` 账本 stage 映射补 `tts → 'tts'`；新增 `--kind hard|transient`（使 tts.js 打印的建议命令可直接执行）。
  - 回归 TTS1–TTS8（全程离线，无真实网络调用）。
  - **M5 收尾**：仅剩 deferred 项 #3（E1 正式报告）与 #12（recovered 账本）。（字幕/封面 ✅ M5-SUB；帧口径出片 + 确定性 ✅ M5-EDIT/D4）

## 已关闭（PRD v2.13 M5-AUD 音轨合成）

- **M5-AUD 音轨合成（对白/sfx/music + 两遍 loudnorm + §3.9 输出规格 + Gate #10 接线）→ 已交付**：
  - `tools/audio.js`：纯函数 `dialogueSegments`（帧位换算写死 `round(frame*1000/fps)`；`trim.keep_ms` 优先；`dialogue_spill_ms` 另记 `spill_ms`）/`cuePlacements`（clip 级 `sfx.at` 帧号、集级 `cues` 帧号优先、源解析与缺失分类）/`programDurationMs`/`planProgram`（稳定排序 + 越界/源缺失分类）/`parseLoudnormJson`/`loudnormArgs`/`verifyLoudness`；ffmpeg 编排 `analyzeLoudness`（第一遍分析）/`buildProgramAudio`（静音基床 → `adelay`+`volume`+`amix=normalize=0` → 两遍 loudnorm → AAC 48k stereo；`execFileSync` 参数数组、tmp `finally` 清理、fail-closed）。
  - **两遍 loudnorm**：第一遍 `print_format=json` 分析混音床 → 第二遍带 `measured_*` + `linear=true` 应用；**最终复测产物响度** 作为 Gate #10 的唯一数据源（`verifyLoudness`：`|I+14|≤1` 且 `TP≤-1`）。
  - `build-timeline.js`：落位 clip `sfx` 与 timeline `cues`（仅显式给出时，既有 fixture/生产集不漂移）。
  - `gate.js`：`#10` 由 `deferred` 改实判（`opts.loudness` 优先；无则 `--final` → `analyzeLoudness`（`opts.analyzeLoudness` 可注入）；两者都无 → fail；offline → external；`audio:none` → N/A；`silent:true` → pass + `loudnorm: skipped`）。
  - CLI：`node tools/audio.js <episode-dir> [--timeline <path>] [--out <path>] [--strict] [--json]`；默认产物 `<episode-dir>/audio/program.m4a`。
  - 回归 AUD1–AUD8（纯函数/真实 `analyzeLoudness`/`buildProgramAudio` 端到端 + spill + 缺源 strict + `build-timeline` 落位 + CLI）。
  - **M5 收尾**：仅剩 deferred 项 #3（E1 正式报告）与 #12（recovered 账本）。（✅ 字幕/封面由 M5-SUB 交付；✅ 帧口径出片 + 确定性由 M5-EDIT/D4 交付）

## 已关闭（PRD v2.13 M5-SUB 字幕产物 + 封面帧）

- **M5-SUB 字幕产物（SRT/烧录/软字幕）+ 封面帧提取 + Gate `#7`/`#11` 实跑衔接（PRD §4）→ 已交付**：
  - `tools/subtitles.js`：纯函数 `subtitleCues`（每 clip 实测对白产 1 cue；起点 = `output_start` 帧位；时长 = `trim.keep_ms` 否则 `dialogue_ms`，再 `+ dialogue_spill_ms`；边界量化到 fps 帧栅格 `round(frame*1000/fps)`；`measured:false` 只 WARN；越界/重叠/空文本 → `problems`）、`wrapCueText`（竖屏 `9:16` ≤15 字、其余 ≤22 字；中文标点优先断行、其次空格/标签边界、超长硬切；不产生空行/行首标点）、`formatSrt`（`HH:MM:SS,mmm`；解析沿用 `gate.parseSrtCues`）、`checkCueAlignment`（帧栅格偏差 <1ms，作为「对白实测 <100ms」的代理验收）、`subtitleFontChain`（`PingFang SC` → `Noto Sans CJK SC` → `Source Han Sans SC` → `Microsoft YaHei`）、`burnSubtitlesArgs`/`softSubtitlesArgs`（`force_style` + `MarginV` 按高度安全区）。
  - ffmpeg 编排：`writeSrt`（默认 `<episode-dir>/episode.srt`，Gate #7 识别位；原子写；problems 非空 fail-closed）、`burnSubtitles`（`burn`/`soft`(`-c copy -c:s mov_text`)/`both`(先 burn 后 soft 两步)；失败清理半成品；`execFileSync` 参数数组）；CLI `node tools/subtitles.js <episode-dir> [--timeline] [--write] [--burn <video> --out <path>] [--mode burn|soft|both] [--font] [--final-duration-ms] [--json]`。
  - `tools/cover.js`：新增 `generateCover({manifest, timeline, epDir, outPath, opts})` 按 `resolveCover` 产 PNG（keyframe 转码 / 实际首帧 `source_in + deleted_head_frames` 抽帧 `-ss frame/fps` / `promo_asset` 拷贝转码）；`opts.extractFrame`/`opts.runFfmpeg` 可注入；失败清理；CLI `node tools/cover.js <episode-dir> [--timeline] [--out] [--json]`（默认 `<episode-dir>/cover.png`）。
  - `gate.js`：`#7` 保持默认发现 `<episode-dir>/episode.srt`（`resolveDefaultArtifacts`，回归 `SUB4` 实跑 pass）；`#11` 新增 `opts.artifacts.cover`/CLI `--cover <path>` 校验已生成封面文件存在（存在 pass、缺失 fail；不传保持 `resolveCover` 现值）。
  - 回归 `SUB1`–`SUB8`（cue 派生/wrap/SRT 格式与帧对齐/`writeSrt` + Gate #7/`burnSubtitles`/`generateCover`/Gate #11 + `artifacts.cover`/生产不漂移）。
  - **M5 收尾**：仅剩 deferred 项 #3（E1 正式报告）与 #12（recovered 账本）。（✅ `edit-episode` 消费 `timeline.json`（D4）+ Gate `#14` 确定性已由 M5-EDIT/D4 交付；v1 秒制路径保留）

## 已关闭（本轮 TECH-DEBT 批次）

- **D2（`cache_hits` 语义固定）→ 已关闭**：`render-next` 幂等复用既有 active task 时，每个 task 至多计一次 `cache_hit`（task 上新增 `cache_hit_counted: true` 标记），轮询不再线性抬高该指标；`retry_wait` 到期重派仍计真实 `request`。回归用例 `DEBT-D2a` / `DEBT-D2b`（既有 `Q4b` 保持绿）。
- **D3（`e1-report.js --json` 原子写）→ 已关闭**：改用 `atomicWriteJson`（自 `./build-manifest` 引入，tmp + rename），目录创建保留。回归用例 `DEBT-D3a`（可解析、无 `.*.tmp` 残留）。
- **D5（legacy `--failed` 无 `--task`）→ 已关闭**：`schema_version >= 2` 的 manifest 上无 `--task` 的 `--failed` 直接报错（提示先 `render-next` 建任务快照并用 `--failed --task <id>`），**不改任何状态**；v1（schema 1/缺省）保留旧行为并输出迁移警告。回归用例 `DEBT-D5a`（v2 抛错零改动）/ `DEBT-D5b`（v1 成功 + WARN）。
- **D6（跨进程并发 + stale 回收）→ 已关闭**：新增 `tools/lock.js`，导出 `withLock` / `acquireLockOnce` / `tryReclaim` / `lockPathFor`；`fs.openSync(path,'wx')` 原子获取、死 pid 或 mtime 超 `staleMs`（默认 60000）回收、`timeoutMs`（默认 10000）后抛 `lock timeout`、多 key 排序获取逆序释放、`finally` + 一次性 `process.on('exit')` 兜底释放、`Atomics.wait` 同步等待。接线：`mark-shot`（episode + catalog）、`render-next`（非 `--all`）、`build-manifest`、`migrate-episode`。回归用例 `DEBT-D6a`–`DEBT-D6g`。**已知限制**：锁只串行化单次事务，manifest 已落盘、catalog 写入前进程崩溃的窗口仍存在（无事务日志不可消除）；触发并发事务需求时另立 ADR（PRD §8 风险表）。
- **D7（`--select` 对 fingerprint 不匹配硬报错）→ 已关闭**：`--select` 在既有守卫后新增 `take.input_hash != null && !== shot.input_hash` → 抛错（消息含 `input` / `fingerprint mismatch`），不改状态；`null`（来源未知 legacy）与 fingerprint 复现（相等，含 superseded 的人工恢复）仍允许。与 `--review accept` 写入口守卫同一不变量。回归用例 `DEBT-D7a`–`DEBT-D7c`（既有 M0-5c 保持绿）。
- **D8（缺失参考图 fail-closed）→ 已关闭**：`computeInputHash` 构建 refs 时任一 `content_hash === null` 即抛错并列出完整路径（`missing reference image(s) for input_hash: <p1>, <p2> — fix inputs before building (content digest required)`）；`build-manifest` 主流程与 `verifyManifestFreshness` 继承 fail-closed，不再写入 `content_hash: null` 的 hash。回归用例 `DEBT-D8a`（纯函数）/ `DEBT-D8b`（CLI 集成非零退出）。

## 已关闭（E1 工具口径 PRD v2.8 A7）

- **A7（E1 报告绝对质量门槛 + 预处理/度量口径）→ 已关闭**：`tools/e1-report.js` 新增
  - 预注册硬门槛：`ssim_abs_min` 与 Δ 一同冻结（`checkPreregistration` 缺任一即列入 missing），缺失时 `buildReport` 抛 `E1RefusalError`、CLI 退出码 2；
  - 判定条件 #4：`absolute = { ssim_abs_min, a_median, pass }`（`a_median = median(samples[group==='A'].ssim)`，`pass = a_median != null && a_median >= ssim_abs_min`），`first_frame_bound = 既有每层相对判定 && pass`，不通过时 reason 形如 `A-group absolute median <a_median> < ssim_abs_min <thr>`；
  - 度量口径：导出 `DEFAULT_PREPROCESSING = { resize: '512x512-bilinear', color_space: 'sRGB', sharpen: false }`（PRD 写死协议）；新增 `checkMetricMetadata(meta, secondary)` 校验 SSIM 实现/版本/参数（window/gaussian/K1/K2/data_range）与预处理（resize/color_space/sharpen，`sharpen===true` 与 `color_space ∉ {sRGB,BT.709}` 均记 incomplete）及实际使用的辅指标 impl/version；缺失只进 `incomplete_reasons`，**不**触发 refusal；报告 JSON 新增 `metrics`（声明值与 `DEFAULT_PREPROCESSING` 合并 + `secondary` 照实回显），文本报告输出绝对门槛行与实现/版本/预处理行。
  - 回归用例 `A7a`–`A7i`（含 `checkMetricMetadata` 直接契约）；`experiments/README.md` 字段说明与 `e1-dataset.example.json` 同步补齐。

## 已关闭（任务状态批次 PRD v2.8 A1/A2/A9/A10）

- **A1（失败模型）→ 已关闭**：`mark-shot --failed --task` 中 hard/transient 一律先 `retry_wait` 累计（不再 hard 立即 `failed`）；新增 `--terminal` 才进入终态 `failed`；`isTerminalTaskStatus(task.status) || isTaskSuperseded(task)` 守卫拒绝不可调度任务上报 attempt；attempt 事件新增 `attempt_id`（`--attempt-id`/`task.current_attempt_id`/自动 `att-<8hex>`）与 `request_id`；幂等键 = `attempt_id` 或 `(task_id,n)`，重复上报完全 no-op；`failed_billed` 缺省 = `blocked || kind==='hard'`；`--unblock` 将 active 与 blocked 任务一律置 `cancelled` 并重置三维窗口；late success 对 `retry_wait`/`failed` 置 `succeeded + completion='late'`，对 `blocked`/`cancelled` 保持任务状态不变。回归用例 `A-BATCH-A1a`–`A-BATCH-A1d`、`D1a`、`C2h`、`R2-P1-2a/b/c`、`R2-P1-3a/b`、`R3-N2b`、`D4`、`Q4e`。
- **A2（执行状态与有效期分离 + reuse_records）→ 已关闭**：新增 `task.superseded_at`/`superseded_by` 与导出 `isTaskSuperseded(task)`（`superseded_at != null` 或旧数据 `status==='superseded'`）；可调度判定统一为 `isActiveTaskStatus(status) && !isTaskSuperseded(task)`；`render-next` input_hash 变更不再改写旧 active task 执行状态，仅写 `superseded_at/by`；`--select`/`--review accept` 对 fingerprint 复现的 superseded 素材追加 `manifest.reuse_records[]`（`reason: fingerprint_recurrence`）且不改写原任务失效历史；`build-manifest` 重建保留 `reuse_records`。回归用例 `A-BATCH-A2a`–`A-BATCH-A2d`、`W3d`、`B2`、`M0-5a/d`、`M0-5c`、`R2-P0-1c`、`DEBT-D7c`。
- **A9（成功回调按 `(request_id, content_digest)` 幂等）→ 已关闭**：`--take --task` 新增 `--request-id`；`content_digest = fileContentHash(path)`，缺失/不可读抛错；同 `(task_id, request_id)` 同 digest 幂等返回既有 take（不新增、不重复计账），异 digest 冲突抛错且零改动；同 task 不同 request_id 各自成 take 并各计一次 success、不自动 selected；本地路径不同但 digest 相同不算冲突；`render-next` 每次派发（含 retry_wait 到期重派）刷新 `task.current_attempt_id`。回归用例 `A-BATCH-A9a`–`A-BATCH-A9g`。
- **A10（调度集合与唯一约束）→ 已关闭**：`(shot_id, stage, input_hash)` 至多一条可调度任务；`superseded_at != null` 的任务即使 `retry_wait` 到期也不重派、不被复用（`collectRetryWaits`/`createRenderTask` 同步过滤）；hash 复现按 A2 新建快照并与旧任务并存。回归用例 `A-BATCH-A10a`–`A-BATCH-A10c`、`A-BATCH-A2b`。

## 已关闭复核项

- **D1（无 `schema_version` / final 无 v1 提示）→ 已关闭**（PRD §6，M2 交付）：manifest/script 均携带 `schema_version`（缺省 1）；`tools/migrate-episode.js --to 2` 提供显式、幂等、原子写迁移（含 catalog 路径注入与注释保护）；`stitch-episode --final` 只读 `schema_version`，v1 集输出 `v1 final semantics applied. Run migrate-episode --to 2 to adopt v2 publishing requirements.`，`--preview` 不输出。回归用例 MG1–MG14。
- P1-N1（review accept 写入口与 validateTake 判定分裂）→ 已修（写入口拦截非 null 且不匹配的 input_hash）
- P2-N1（`--pending`/`--rendering` 绕过 blocked 终态）→ 已修（blocked 时强制先 `--unblock`）
- P2-N2（重复 `(task_id,n)` 上报顺延 retry_after）→ 已修（幂等重复完全无副作用）
- P2-N3（`--done` 未传 schemaVersion）→ 已修（按 manifest.schema_version 传入）
- P2-N5（测试缺口：unblock→select / null-hash superseded / retry_after 不可解析 fail-open / P1-N1 场景）→ 已补 `R3-*` 用例
- **FIX3-1（派发未校验输入新鲜度）→ 已关闭**：`render-next` 冻结全部参考图后，用**冻结副本路径**重算 `computeInputHash` 并与 `shot.input_hash` 核对；不一致抛 `input fingerprint mismatch for <shot>: manifest stores <h1>, frozen inputs hash to <h2> — rebuild manifest before dispatching (node tools/build-manifest.js <episode-dir>)`，catch 清理本次冻结目录，manifest 不新增 task；复用路径不重算但保留 `frozenAssetsIntact`。回归锚点 `F1a` / `F1b` / `F1c`。
- **FIX3-2（回调按可变 `current_attempt_id` 绑定）→ 已关闭**：`render-next` 每次派发（新建、retry_wait 到期重派）向 `task.attempts[]` 追加 `{attempt_id, at, input_hash}`；`mark-shot` 抽出 `resolveAttempt(task, opts, manifest)`，`--take` / `--failed` 共用：`--attempt-id` 必须命中否则抛 `unknown attempt_id ... refusing to guess`；仅 `--request-id` 先按 `attempts[].request_id` 再按 `task_events` 同 request 事件，并将 request_id 回填到对应 attempt；均无身份时仅 `attempts.length <= 1`（或 legacy 无 attempts 但有 `current_attempt_id`）允许绑定，多 attempt 抛错要求身份。`current_attempt_id` 仅作兼容展示。回归锚点 `F2a` / `F2b` / `F2c` / `F2d`。
- **FIX3-3（无身份回调静默吞掉不同产物）→ 已关闭**：删除 `task.status === 'succeeded'` 时的静默幂等分支；无 `request_id`/`attempt_id` 时同 task 已有 take 且存在同 `content_digest` → 幂等返回，digest 全不同 → 抛 `callback for task X has no request/attempt identity and a different content digest — pass --request-id (or --attempt-id) to record it as an independent request (refusing to silently drop a possibly paid result)`（不新增/不丢弃）；同 task 无 take → 按单 attempt 绑定新增（legacy 无 attempts 时 `attempt_id` 为 null）。take 记录实际解析出的 `attempt_id`。回归锚点 `F3a` / `F3b` / `F3c`。

## PRD v2.8 新契约 → 实现对齐项（随对应里程碑，不阻塞文档冻结）

| # | v2.8 契约（§3.3/§3.5/§3.8/§5） | 当前实现 | 对齐时机 |
|---|---|---|---|
| A3 | 时长四量分离；`allow_trim` 默认 false；`max_freeze_padding_frames` 默认 0 | **已交付（M5-TTS + M5-OVF + M5-AUD）**：TTS 接线 ✅ — `build-manifest` dialogue/voice/provider 解析 + `tts_hash`(§3.8) + 字数估时仅预警（`estimateDialogueSeconds`，超 `duration` 只 WARN）；`render-next` tts stage（派发顺序 tts→keyframe→video）+ 产物级缓存 + 账本 stage 映射；`tools/tts.js`/`tools/tts-api-doubao.js`（`TTS_MOCK` 离线夹具）；回归 TTS1–TTS8。**时长四量分离与溢出策略 ✅（M5-OVF，帧级决策/标记）**：`tools/dialogue.js`（`resolveDialogueTiming`/`overflowFrames`/`decideOverflow`/`checkSpillConstraints`/`trimDialogue`/`collectUnresolvedOverflow`）+ `build-timeline` v2 接线（clip `dialogue`/`overflow`/`padding_frames`/`trim`/`dialogue_spill_ms`/`spill_in`；`edit.timeline.allow_trim` 默认 false、`max_freeze_padding_frames` 默认 0，`edit.overflow.*` 亦接受；v1 不接入、字段不漂移）；Gate #6 由 deferred 改为实判（未解决/未实测/spill 约束破坏/未声明却有对白 → fail；v1 N/A；无 timeline → fail）；回归 OVF1–OVF7。**音轨层 ✅（M5-AUD）**：`tools/audio.js`（`dialogueSegments`/`cuePlacements`/`planProgram`/`parseLoudnormJson`/`loudnormArgs`/`verifyLoudness` + `analyzeLoudness`/`buildProgramAudio`）：静音基床→对白/sfx/music `adelay`+`volume`+`amix=normalize=0`→**两遍 loudnorm**→AAC 48k stereo；`build-timeline` 落位 clip `sfx` 与 timeline `cues`；Gate #10 由 deferred 改实判；回归 AUD1–AUD8 | M5-AUD ✅ |
| A5 | Gate 豁免由 `intent.*` 显式声明决定（非输出缺失）；矩阵含 v1 音频口径 | **已交付（M5a 声明 + M5c 矩阵引擎 + M5-AUD 音频实判）**：`tools/intent.js`（`detectDialogue`/`deriveIntent`/`validateIntent`/`intentFlags`）+ `build-manifest` 接线（矛盾声明 exit 4 不写盘；`manifest.intent` 含 flags/`declared`/`sources`，v1 同写审计）；`tools/gate.js` 交付 §5 全量适用矩阵（`GATE_ITEMS` 1..14，4 拆 4a/4b；v1/v2 判定写死）+ cover 门禁 #11（复用 `resolveCover`）+ quota ledger 对账 #12（`reconcileQuotaLedger`）+ subtitle cue #7（`parseSrtCues`）+ 导出入口接入（`stitch-episode --final` / `--gate-strict`）；回归 M5c1–M5c12。`deferred` 桥接政策见 README「Release Gate（§5，M5c）」——本质是 E1 正式实验暂停 + 字幕产物未接入，Gate 结构已全量实现。**#6（对白溢出/spill）已于 M5-OVF 转实判，#10（loudness）已于 M5-AUD 转实判**（`opts.loudness` / `--final` 分析 `verifyLoudness`；两者都无 → fail；offline → external） | M5a ✅ / M5c ✅ / M5-AUD ✅ |
| A6 | final 探测两步：媒体属性探测 + 完整解码验证 | 已交付（M5b）：`tools/probe.js`（`parseProbeJson`/`probeMedia`/`expectedVideoSpec`/`checkMediaSpec`/`verifyDecode`/`checkAvLength`/`verifyFinalMedia` + CLI；回归 M5b1–M5b7）；Release Gate #8/#9 接线随 M5c 已交付（`gate.js` `evaluateReleaseGate` + `stitch-episode --final` 拼接后复用同一次 probe） | M5（已交付） |

## 已关闭（PRD v2.8 A4）

- **A4（approval 绑定 clip 实例 + 裁切/删帧参数；cover 绑定 clip 的视频 keyframe 或实际首帧）→ 已关闭**：
  - **cover 纯函数（M3a 已交付，回归 MK8）**：`tools/cover.js` 的 `resolveCover(manifest, timeline)` 按写死优先级返回封面来源（clip 绑定的 keyframe → 该 keyframe 文件 / 否则 clip 实际首帧 `source_in + deleted_head_frames` / `cover.promo_asset` / 缺失报错）。**cover 门禁接入 `--final`/Release Gate #11 随 M5**（本期只交付纯函数与用例）。
  - **approval clip 绑定（M4c 已交付）**：新增 `tools/approvals.js`（`validateApprovals` / `collectApprovalProblems` / `checkApprovalsForEpisode` / `resolveAcceptUpstreamCutFrame`）与 `tools/mark-approval.js`（写 `manifest.approvals[]`，`atomicWriteJson` + `withLock`）。记录 schema 写死为 `{kind, upstream_clip, downstream_clip, downstream_shot?, bindings, verdict?, reviewer, reviewed_at}`；validity **只**比较 `bindings` 的 `content_digest` 与语义参数（`source_out`/`source_in`/`deleted_head_frames`），clip_id/take_id/shot_id 仅定位与审计（locator 无关性）。每个 `cut_join` clip 必须有匹配的 `junction_review` 记录且四要素全 pass；`accept_upstream` 记录存在时校验上游 digest 与 `cut_frame`（不强制存在）。重复确认覆盖为最新并追加 `manifest.approval_history[]`（附 `superseded_at`）；`build-manifest` 重建保留 `approvals`/`approval_history`；`edit-episode` 正式导出前与 `stitch-episode --final` 统一检查（有问题 exit 4；`timeline.json` 缺失跳过 + WARN，M5 再强制）。回归 `M4c1`–`M4c6`。

## 已关闭（任务状态批次 PRD v2.8 A8）

- **A8（stage 输入契约与哈希重构）→ 已关闭**：按 PRD §3.8 将 `input_hash` 拆为 **stage 版本**：
  - `build-prompt`：`collectImageRefs()` 每项新增 `hash_role`（`character:<id>` / `location:<id>` / `shot.references[<i>]`），`buildPromptForShot` 返回 `image_refs`（`role` 人类可读文本不变）；`collectImageRefs` 导出。
  - `build-manifest`：新增导出 `computeStagePayloadHash({schemaVersion, stage, prompt, refs, model, params, firstFrame, continueFrom, styleGuideDigest})`（keyframe/video/tts 三份互不继承的 canonical payload；refs 只入 `{role, content_digest}`，任一缺失 fail-closed；tts 含 `dialogue_text`/`voice_id`/`provider{name,model,version}`/`tts_params`）、`computeShotKeyframeHash`、`computeShotVideoHash`（keyframe digest 按 `manifest.keyframe_mode` 入 `first_frame` 或 `refs:keyframe:selected`）、`selectedKeyframeDigest`、`resolveStageRefsForShot`、`styleGuideFileDigest`；每 shot 存 `image_refs`/`keyframe_hash`/`input_hash`，manifest 存 `keyframe_mode`（缺省 `'reference'`）；`verifyManifestFreshness` 改用 video-stage hash。legacy `computeInputHash` 保留（`mark-shot --done` 与既有单测）。
  - `render-next`：keyframe 任务 hash = `computeShotKeyframeHash`（FIX3-1 核对 `shot.keyframe_hash`，缺失提示重建）；video 任务 hash = `computeShotVideoHash`（含 selected keyframe digest，FIX3-1 核对 `shot.input_hash`）；stage 感知 task 复用；`task.image_refs` 带 `hash_role`。
  - `mark-keyframe`：take `input_hash` 沿用任务快照（keyframe-stage hash）；`--take`/`--select`/`--review` 与 `shot.keyframe_hash` 同口径（旧 manifest 缺字段时回退 `shot.input_hash`）。
  - 回归锚点 `A8a`（identity 字段不入 hash）/ `A8b`（refs 顺序与 role 命名空间）/ `A8c`（缺失参考图 fail-closed）/ `A8d`（keyframe digest 与 `keyframe_mode`）/ `A8e`（tts payload）/ `A8f`（集成：select 后重建 → hash 变 + freshness + render-next video FIX3-1）/ `A8g`（`image_refs`/`hash_role` prompt 文本不变）。
  - TTS 仅交付纯函数与单测（不接 TTS 实现）；实际 TTS 集成随 M5。
