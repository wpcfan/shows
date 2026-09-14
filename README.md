# 末日僵尸短片系列 — 脚本驱动 Seedance 生成架构

仿《行尸走肉》风格的末日僵尸短片系列。剧本用中文写，Seedance 提示词英文，角色/场景用定妆照保证一致性，最后 ffmpeg 拼接成集。

## 三步工作流

```bash
# 1. 编辑剧本 (中文 description + 英文 prompt)
$EDITOR episodes/S01E01-pov/script.yaml

# 2. 生成渲染清单
node tools/build-manifest.js episodes/S01E01-pov

# 3. 串行渲染 (agent 执行 — GenerateVideo 禁止并行)
#   读取 manifest → 对每个 pending shot 调 GenerateVideo → mark-shot.js 回写
#   工具辅助：node tools/render-next.js episodes/S01E01-pov
#             打印下一个待渲染 shot 的完整参数

# 4. 拼接成集
node tools/stitch-episode.js episodes/S01E01-pov --final
# → output/S01E01-pov/episode.mp4
# 预览(默认,不要求全部 done,结构不一致仅 WARN):
# node tools/stitch-episode.js episodes/S01E01-pov --preview
```

## 目录

```
shows/
├── README.md                # 本文件
├── style-guide.md          # 行尸走肉视觉风格关键词 (英文, 供 build-prompt.js 注入)
├── series.yaml             # 系列圣经
├── characters/<id>/        # 角色:character.yaml + reference.png
├── locations/<id>/         # 场景:location.yaml + reference.png
├── episodes/<id>/          # 一集:script.yaml + manifest.json + shots/*.mp4
├── templates/              # 新建一集/角色/场景的模板(含 episode-script-9x16.template.yaml 竖屏)
├── tools/                  # Node 脚本(build-manifest/render-next/mark-shot/task-state/...)
├── output/<id>/            # 最终拼接成片
└── catalog.json            # 全系列渲染主索引
```

## 新建一集

```bash
cp templates/episode-script.template.yaml episodes/SxxExx-<slug>/script.yaml
# 竖屏 9:16 一集改用:
# cp templates/episode-script-9x16.template.yaml episodes/SxxExx-<slug>/script.yaml
# 编辑 script.yaml 填 shots
node tools/build-manifest.js episodes/SxxExx-<slug>
# agent 串行渲染
node tools/stitch-episode.js episodes/SxxExx-<slug>
```

## 新建一个角色

```bash
cp templates/character.template.yaml characters/<id>/character.yaml
# 编辑 character.yaml
# 用 GenerateImage 生成 reference.png
# 在 shot 的 characters: [<id>] 引用
```

## 工具脚本

| 脚本 | 用法 | 职责 |
|---|---|---|
| `new-episode.js` | `node tools/new-episode.js --draft <slug> [--title "标题"] [--root <dir>]`；`--episode <EPISODE-ID> [--title "标题"] [--root <dir>]` | 新集/草稿脚手架(零 credits):`--draft` → `<root>/episodes/_drafts/<slug>/`,`--episode` → `<root>/episodes/<EPISODE-ID>/`;生成可直接通过 `validate-script` 的 `script.yaml`(schema_version: 2,合法 intent/tts/defaults,含 dialogue/continue_from/references 注释示例)+ `README.md` + 空 `shots/`;目标已存在且非空或非法 slug(路径分隔/`..`/空白)→ 报错、零改动、非零退出 |
| `validate-script.js` | `node tools/validate-script.js <script.yaml \| episode-dir> [--json] [--build] [--timeline]` | 零成本剧本校验(默认**零写盘/零网络/零 credits**):复用 `validateContinueFrom`/`normalizeDialogue`/`resolveVoiceId`/`resolveTtsConfig`/`estimateDialogueSeconds`/`deriveIntent`/`validateIntent`(含 FIX5b)/`probe.expectedVideoSpec`;错误 exit 4,警告只打印不阻断;`--build` 纯校验通过后 `spawnSync` 透传 `build-manifest`(manifest.json 写在被校验目录,属预期),`--timeline` 再透传 `build-timeline` |
| `build-manifest.js` | `node tools/build-manifest.js <episode-dir>` | script.yaml → manifest.json |
| `build-prompt.js` | `node tools/build-prompt.js <episode-dir> <shot-id>` | 单 shot → 最终英文 Seedance 提示词 (stdout) |
| `render-next.js` | `node tools/render-next.js <episode-dir>` | 打印下一个 pending shot 的完整渲染参数;把参考图冻结到 `.task-assets/<task_id>/<NN>-<basename>` |
| `mark-shot.js` | `node tools/mark-shot.js <episode-dir> <shot-id> --take --task <task-id> --path <mp4> [--request-id <rid>]` | 回写 take/shot 状态到 manifest + catalog;`--failed --task <id> [--terminal] [--attempt-id <id>]` 记 attempt 事件;`--unblock` 解除熔断;`--cost <n>` 写配额账本 |
| `mark-keyframe.js` | `node tools/mark-keyframe.js <episode-dir> <shot-id> --take --task <task-id> --path <png> [--request-id <rid>]` | PRD §3.2 keyframe take 回写:存 `shot.keyframe_takes[]`/`shot.selected_keyframe`;`--select`/`--reject`/`--review`/`--failed --task`/`--pending` 与 mark-shot 语义对称;catalog 条目写 `stage:'keyframe'` |
| `tts.js` | `node tools/tts.js <episode-dir> --task <task-id> [--select] [--env-file <path>]`；`--take <audio-path>` 记录外部产物；`--list` 只读列出待做 | PRD §3.4 TTS stage 产物:合成/记录 `<episode-dir>/audio/<shot-id>-<take-id>.mp3`,take 追加 `shot.tts_takes[]`,`--select` 落 `shot.selected_tts`;幂等 `(task_id, content_digest)`;失败分类打印但**不自动记账** |
| `tts-api-doubao.js` | `require('./tools/tts-api-doubao')` | PRD §3.5 TTS adapter(豆包 `seed-tts-2.0`):`synthDoubao`(node `https`;`DOUBAO_TTS_API_KEY` 必需;`TTS_MOCK=1` 走本地夹具不联网)/`parseDoubaoStream`/`classifyTtsError`(4xx→`hard`、5xx/超时/网络→`transient`) |
| `cover.js` | `node tools/cover.js <episode-dir> [--timeline <path>] [--out <path>] [--json]`；`require('./tools/cover')` | PRD §4/§5 #11 封面帧(M3 纯函数 + M5-SUB 产物):`resolveCover(manifest, timeline)` 优先级 = clip 绑定的 keyframe → 该 keyframe 文件 / 否则 clip 实际首帧(`source_in + deleted_head_frames`) / `cover.promo_asset` / 都没有报错;`generateCover()` 按该结果产 PNG(keyframe 转码 / 首帧抽帧 `-ss frame/fps` / promo 拷贝转码),失败清理半成品;默认 `<episode-dir>/cover.png` |
| `subtitles.js` | `node tools/subtitles.js <episode-dir> [--timeline <path>] [--write] [--burn <video> --out <path>] [--mode burn\|soft\|both] [--font <name>] [--final-duration-ms <n>] [--json]`；`require('./tools/subtitles')` | PRD §4 字幕产物(M5-SUB):纯函数 `subtitleCues`(clip 实例时间线 → 逐句 cue;`trim.keep_ms`/`dialogue_spill_ms` 延伸)/`wrapCueText`(竖屏 15 字、其余 22 字、中文标点优先)/`formatSrt`/`checkCueAlignment`(帧栅格 <1ms)/`subtitleFontChain`/`burnSubtitlesArgs`/`softSubtitlesArgs`;`writeSrt`(默认 `<episode-dir>/episode.srt`,Gate #7 识别位,原子写+fail-closed);`burnSubtitles`(burn/soft/both 两步骤,失败清理) |
| `quota-ledger.js` | `require('./tools/quota-ledger')` | PRD §4 配额账本纯函数(计数/成本公式/报告) |
| `intent.js` | `require('./tools/intent')` | PRD §4 制作意图声明纯函数:`detectDialogue` / `deriveIntent(script,{edit})` / `validateIntent` / `intentFlags`(值域与矛盾组合校验 + Gate 标志位公式);`AUDIO_VALUES`/`SUBTITLE_VALUES` |
| `probe.js` | `node tools/probe.js <file> [--manifest <manifest.json>] [--json]`；`require('./tools/probe')` | PRD §4 final 两步校验(M5b):纯函数 `parseProbeJson`/`expectedVideoSpec`/`checkMediaSpec`/`checkAvLength` + 真实 `probeMedia`(ffprobe)/`verifyDecode`(ffmpeg 全解码)+ 编排 `verifyFinalMedia`;v1 仅校验视频流+容器,v2 校验分辨率/FPS/`yuv420p`/§3.9 音频(AAC/48kHz/stereo) |
| `gate.js` | `node tools/gate.js <episode-dir> [--final <path>] [--timeline <path>] [--e1-report <path>] [--cover <path>] [--json] [--strict]`；`require('./tools/gate')` | PRD §5 v2 Final Release Gate(M5c):`GATE_ITEMS` 适用矩阵(1..14,4 拆 4a/4b)、`reconcileQuotaLedger`(#12)、`parseSrtCues`(#7)、`evaluateReleaseGate`、`formatGateReport`;`--cover`/`opts.artifacts.cover` 供 #11 校验已生成封面;失败 exit 4,`deferred` 默认放行(`--strict` 阻塞) |
| `lock.js` | `require('./tools/lock')` | 跨进程文件锁:`withLock`/`acquireLockOnce`/`tryReclaim`/`lockPathFor`;死 pid/超龄(mtime)回收、多 key 排序获取逆序释放、`process.exit` 兜底释放、`Atomics.wait` 同步等待 |
| `e1-report.js` | `node tools/e1-report.js <dataset.json> [--json <out>]` | PRD §3.1 E1 统计契约(cluster bootstrap/分层判定/预注册拒绝);含绝对门槛 `ssim_abs_min`(与 Δ 一同冻结)与预处理/度量口径(`metrics` + `DEFAULT_PREPROCESSING`) |
| `build-timeline.js` | `node tools/build-timeline.js <episode-dir> [--out <path>] [--dry-run]` | PRD §3.6 时间线核心:edit.yaml + manifest → 帧号 clip 实例(`timeline.json`);纯函数 `resolveTimelineFps`/`secondsToFrames`/`msToFrames`/`buildTimeline`/`validateTimeline`;v2 接 §3.4 对白溢出(pad_freeze/trim/dialogue_spill,写在 clip 上),v1 不接入(字段不漂移) |
| `dialogue.js` | `require('./tools/dialogue')` | PRD §3.4 时长四量与溢出策略**纯函数(帧级决策/标记,不跑音频)**:`selectDialogueTake`/`resolveDialogueTiming`(实测,缺失 `measured:false`)/`overflowFrames`(向上进位)/`decideOverflow`(none→pad_freeze→trim→spill→error)/`checkSpillConstraints`(五条)/`trimDialogue`(标点断句+`…`)/`clipOutputFrames`/`collectUnresolvedOverflow`(Release Gate #6 唯一数据源) |
| `audio.js` | `node tools/audio.js <episode-dir> [--timeline <path>] [--out <path>] [--strict] [--json]`；`require('./tools/audio')` | PRD §3.4/§3.9 音轨合成(M5-AUD):纯函数 `dialogueSegments`/`cuePlacements`/`programDurationMs`/`planProgram`/`parseLoudnormJson`/`loudnormArgs`/`verifyLoudness` + ffmpeg 编排 `analyzeLoudness`(第一遍分析)/`buildProgramAudio`(静音基床→对白/sfx/music `adelay`+`volume`+`amix=normalize=0`→两遍 loudnorm→AAC 48k stereo);默认产物 `<episode-dir>/audio/program.m4a` |
| `approvals.js` | `require('./tools/approvals')` | PRD §3.3 bound approval record 校验核心:`validateApprovals(manifest, timeline)` / `collectApprovalProblems`(只看 digest + 语义参数,locator 无关)/ `resolveAcceptUpstreamCutFrame` / `checkApprovalsForEpisode`(timeline.json 缺失 → 跳过 + WARN) |
| `mark-approval.js` | `node tools/mark-approval.js <episode-dir> --kind junction_review --upstream-clip <id> --downstream-clip <id> --subject/--prop/--action-phase/--direction pass\|fail [--reviewer X]`；`--kind accept_upstream --downstream-shot <id>` | PRD §3.3 写入 `manifest.approvals[]`(原子写 + `withLock`):junction_review 计算 upstream/downstream digest + `source_out/source_in/deleted_head_frames` 绑定 + 四要素 verdict;accept_upstream 绑 upstream take + cut_frame;重复确认覆盖为最新并把旧记录追加到 `manifest.approval_history[]` |
| `migrate-episode.js` | `node tools/migrate-episode.js <episode-dir> --to 2 [--dry-run] [--catalog <path>]` | PRD §6 schema 1→2 **显式迁移**:等值 ratio 覆盖删除 / 异值 ratio 冲突报错(零写入)/ 补齐 take+task+catalog 的 `stage: video` / 补 `require_keyframe` / 写 `schema_version: 2`。幂等、原子写、catalog 路径可注入 |
| `stitch-episode.js` | `node tools/stitch-episode.js <episode-dir> [--preview\|--final] [--out <path>] [--gate-strict]` | ffmpeg concat → output/<id>/episode[-preview].mp4;`--final` 接 §5 Release Gate(M5c:拼接前离线条目、拼接后 8/9;失败 exit 4,`deferred` 打印 NOT RELEASABLE 但退出 0,`--gate-strict` 立即阻塞);**M5-EDIT/D4: `--final` 且 schema≥2 且有 `timeline.json` → 委托 `render-final.js`(帧口径;offline gate → renderFinal → 媒体 Gate,复用 probe/decode 结果),否则走既有秒制路径并打印模式说明**;导出 `collectGateReport`/`gateExitCode` |
| `edit-episode.js` | `node tools/edit-episode.js <episode-dir> [--out <path>] [--spec <delivery-name>]` | edit.yaml 驱动的正式剪辑;保留 freshness/approvals/blocked 前置检查;**M5-EDIT/D4: schema≥2 且有 `timeline.json` → 委托 `render-final.js`(帧口径),否则按秒制裁切出片(v1 语义)**;导出 `validateTake`/`collectEditApprovalProblems` 等 |
| `render-final.js` | `node tools/render-final.js <episode-dir> [--out <path>] [--timeline <path>] [--json] [--skip-cover]`；`require('./tools/render-final')` | PRD §3.3/§3.6/§3.9/§4 **v2 帧口径最终出片**(M5-EDIT/D4):纯函数 `clipRenderArgs`(入点/删帧右移/`tpad` 静帧/`-frames:v` 精确帧数/`cfrNormalizeArgs` CFR 链/确定性参数)+ `renderFinal`(逐 clip → concat `-c copy` → 混流 `audio/program.m4a` → 字幕 `episode.srt`(默认 soft,无 libass 降级+WARN) → 封面 `cover.png` → `probe.verifyFinalMedia` v2 全量规格/解码/A/V)+ `determinismDigests`(视频 MD5 + 音频 PCM SHA256)+ `detectRenderMode` |
| `determinism.js` | `node tools/determinism.js <episode-dir> [--out <path>] [--keep] [--json]` | PRD §5 Gate #14 取证:同 `renderFinal` 复跑两次到不同路径,比较解码视频/音频摘要,输出 `{ok, first, second, video_md5_equal, audio_md5_equal}`,不一致非零退出(`--keep` 保留产物) |

## 约束

- **GenerateVideo 禁止并行**：必须串行渲染，每完成一个 shot 调 `mark-shot.js` 回写 manifest 持久化状态。
- **单轮配额**：若 GenerateVideo 报"per-turn allowance 用尽"，本轮停止，下轮继续。manifest 保证续渲染。
- **剧本语言**：`description_cn` 中文（人读），`prompt_en` 英文（给 Seedance）。
- **风格注入**：`build-prompt.js` 会把 `style-guide.md` 的关键词 + 引用角色/场景的 `appearance_en` 自动拼到最终 prompt。

## 不变量(工具共享)

### take 生命周期
- `take.status ∈ candidate | selected | rejected | superseded`;`rejected` 是终态:不可再 `--review accept` 或 `--select`;`superseded` 是旧 input_hash 的 late/stale 产物:不得自动进成片,仅当 input fingerprint 复现时允许人工 `--select` 恢复。
- `superseded` 不得用 `--review accept` 洗白(input 不匹配时报错);**`--review accept` 写入口执行与 `validateTake` 相同的不变量**:`take.input_hash != null` 且 ≠ 当前 `shot.input_hash` 时一律报错(防止旧输入产物经写入口进入 `--preview`,到 `--final` 才暴露);仅来源未知的 null 历史素材允许复核绑定当前输入。`validateTake()` 额外校验 accept 绑定一致性:`take.input_hash != null` 时必须 === `reviewed_input_hash`。
- `human_review.conclusion ∈ accept | reject` 是审核结论;`shot.selected_take` 是选片指针;二者分离。
- `validateTake()` 是“能否用于成片”的唯一权威判定(reject/superseded 优先 → review accept 需 reviewed_input_hash 匹配 → 无 review 需 take.input_hash 匹配);`edit-episode --final` 与 `stitch-episode --final` 共用同一判定。
- catalog 是 manifest 丢失后的恢复台账:同一 `(episode, shot_id, take_id)` 只有一条(幂等 upsert,同 key 不同 path 报冲突并附恢复指引);恢复时保留 rejected/superseded 与 human_review。

### keyframe 阶段(PRD §3.2,M3a)
- **数据模型写死**:keyframe take 存 `shot.keyframe_takes[]`(id 前缀 `kf-`,如 `kf-001`),**不混入** `shot.takes[]`;keyframe 选片指针 `shot.selected_keyframe`;video 仍用 `shot.takes[]` / `shot.selected_take`。take 记录 `{id, path, model, input_hash, task_id, attempt_id, request_id, content_digest, rendered_at, status, stage:'keyframe'}`。
- **目标 stage 判定**:`require_keyframe === true` 且无可用 selected keyframe → keyframe 任务;否则 → video 任务(`require_keyframe === false` 或已选 keyframe)。
- **队列门控**:`render-next` 默认队列 **keyframe-pending 优先**(先所有待 keyframe,再 video-eligible);`--video` 只返回 video-eligible(keyframe 已 selected 或 `require_keyframe !== true`),跳过待 keyframe 的 shot;`--all` 列表标注 `[stage=keyframe|video]` 与 `[keyframe:selected <kf-id>|keyframe:pending|keyframe:n/a]`。
- **keyframe 任务快照**:`stage:'keyframe'`、`take_id:'kf-NNN'`、`take_path: shots/shot-<NNN>-<kf-id>.png`、`prompt: shot.prompt_final_en`、冻结参考图、`attempts`/`current_attempt_id`、`superseded_at:null`;FIX3-1 新鲜度校验用 **keyframe-stage hash**(`computeShotKeyframeHash`)核对 `shot.keyframe_hash`,旧 manifest 缺 `keyframe_hash` 时报错提示重建。
- **video 任务的 keyframe 绑定**:存在 selected keyframe 时,`render-next` 冻结该 keyframe 并在任务上记 `keyframe:{take_id, content_digest, frozen_path}`;**不**把 keyframe 混入 `image_paths`,其 digest 按 §3.8 以 `keyframe:selected` 进 video-stage `input_hash`(A8/M3b);`mark-shot --take` 把该绑定镜像到 video take(`take.keyframe`),供 `resolveCover` 使用。
- **keyframe 状态机**:take 状态 `candidate → selected | rejected`,`rejected` 为终态;每 `(shot, stage=keyframe)` **至多一个 selected**;`--select` 换片时原 selected 降为 `candidate`(**不降 rejected**);`rejected → selected` 不允许(`--select`/`--review accept` 一律报错)。`--take` 落 `candidate` 且**不自动 selected**;`--review accept` 在无 selected 时自动选中;`--pending` 只置 `shot.status='pending'`(保留 `takes`/`keyframe_takes`)。
- **下游 video task 失效**:换 keyframe selected 时,绑定被替换旧 keyframe 的 video task(`task.keyframe.take_id === 旧 id`)置 `superseded_at` + `superseded_by:null`(复用 A2 语义,**不改 status**)并打印 WARN;绑定新 keyframe 的任务不受影响。
- `--failed --task` 与 mark-shot 共用 `recordTaskFailure()`(hard/transient → `retry_wait`、`--terminal` → `failed`、三维熔断),attempt 事件 `stage:'keyframe'`,配额账本记 `image` 阶段。
- **catalog stage**:新增条目带 `stage`(`mark-shot` → `'video'`,`mark-keyframe` → `'keyframe'`,已有条目不动);selection 同步按 `(shot, stage)` 隔离,keyframe 与 video 条目互不干扰。

### 任务状态与唯一性(PRD §3.5)
- `task.status` 集合写死:`active = queued | submitted | running | retry_wait`,`terminal = succeeded | failed | cancelled | superseded | blocked`。旧数据归一化:`completed → succeeded`、`obsolete → superseded`;新写入一律用新状态名。
- **执行状态与有效期分离**:`task.superseded_at`(null = 仍是当前有效版本)与 `task.superseded_by`(新 task_id locator)独立持久化失效事实;`isTaskSuperseded(task)` = `superseded_at != null` **或** 旧数据 `normalizeTaskStatus(status) === 'superseded'`。**可调度判定 = `isActiveTaskStatus(status) && !isTaskSuperseded(task)`**;调度集合只含 `superseded_at == null` 的 active task。
- 唯一性约束:`(shot_id, stage, input_hash)` 至多一条**可调度** active task(`stage` 缺省 `video`)。input_hash 变化时旧可调度 active task 仅写 `superseded_at`/`superseded_by`(**不改执行状态**;不 cancel 已提交请求,回调按 late callback 规则处理),新 task 才可创建;同 input_hash 且冻结资产完整则幂等复用。hash 复现(A→B→A)按当前 input_hash **新建**快照,旧 A 失效历史永不清除。
- `retry_wait` 的 `retry_after` 必须被执行:`render-next` 在退避窗口内不派发(take 仍为 retry_wait),到期后重新置 `submitted` 并计一次真实 `request` 且刷新 `current_attempt_id`;**已失效(`superseded_at != null`)的任务即使到期也不重派、不复用**。等待中的 shot 不阻塞其它可渲染 shot。
- blocked 是熔断终态:`--select` / `--review accept` / `--pending` / `--rendering` 都必须先 `--unblock`;`deriveStatus` 在未显式清除前保持 blocked;`edit-episode`(正式导出)与 `stitch-episode --final` 都拒绝 blocked 镜头(Release Gate #4),`--preview` 仅警告。
- **superseded 素材的人工恢复(不改写历史)**:仅当 `take.input_hash === 当前 shot.input_hash`(fingerprint 复现)时允许 `--select` / `--review accept` 恢复该 superseded take;恢复时向 `manifest.reuse_records[]` 追加 `{take_id, source_task_id, source_artifact_digest, bound_input_hash, reason:'fingerprint_recurrence', at}`,**原任务 `superseded_at/by` 保持不动**;fingerprint 不匹配一律拒绝。`build-manifest` 重建保留 `reuse_records`。
- `render-next` 的 `task.image_paths` 指向 `.task-assets/<task_id>/` 下的冻结副本(生成器实际消费的输入),`task.image_src_paths` 保留原始路径。
- **派发前 fingerprint 核对**:`render-next` 冻结参考图后必须用**冻结副本路径**按 stage 重算(`computeShotKeyframeHash` 核对 `shot.keyframe_hash`,`computeShotVideoHash` 核对 `shot.input_hash`,后者含 selected keyframe digest)并核对 manifest 记录;不一致即报错并沿用 catch 清理本次冻结目录(消息含 `fingerprint mismatch` / `rebuild`,提示 `node tools/build-manifest.js <episode-dir>`),manifest 不得新增 task。已提交任务的幂等复用路径不重算,但 `frozenAssetsIntact` 校验保持。

### attempt 事件流与熔断(PRD §3.5)
- `manifest.task_events[]` 记录每次尝试:`{task_id, attempt_id, request_id, shot_id, stage, n, kind, kind_source, error, at, retry_after, epoch}`;`kind ∈ hard | transient | callback_received`;按 `attempt_id` 或 `(task_id, n)` 幂等;`build-manifest` 重建时与 `render_tasks` 一起保留。
- **每次派发**(`render-next` 新建或 retry_wait 到期重派)生成/刷新 `task.current_attempt_id = 'att-<8hex>'`,并向 `task.attempts[]` 追加 `{attempt_id, at, input_hash}`(新任务 `attempts` 初始为空数组后追加首个 attempt)。
- **回调按 attempt 身份解析(不得用 `current` 指针)**:`mark-shot --take` / `--failed` 一律用 `resolveAttempt(task, opts, manifest)` 解析 —— 显式 `--attempt-id` 必须命中 `task.attempts`(或 legacy `current_attempt_id`),否则抛 `unknown attempt_id ... refusing to guess`;仅 `--request-id` 时先按 `attempts[].request_id`,再按 `task_events` 中同 request_id 的事件,命中后把 request_id 回填到对应 attempt;都不提供时仅 `attempts.length <= 1`(或 legacy 无 attempts 但有 `current_attempt_id`)允许绑定。**`current_attempt_id` 仅作兼容展示,不再作为绑定来源**;多 attempt 无身份 → 抛错要求 `--attempt-id`。
- `mark-shot --failed --task <id> --error "<msg>" [--transient|--hard] [--terminal] [--attempt-id <id>] [--request-id <id>] [--billed|--no-billed] [--cost <n>]`:先按 task_id 查原任务(查无报错,不得直接重发/新建);**`isTerminalTaskStatus(task.status) || isTaskSuperseded(task)` 守卫拒绝不可调度任务上报 attempt**;内置正则表自动分类(`rate limit|429|timeout|5xx|temporarily` → transient;`policy|content|invalid|unsafe` → hard),`--transient/--hard` 人工覆盖并记 `kind_source: manual|auto`。
- **失败模型**:hard 与 transient **一律先进入 `retry_wait` + `retry_after`**(60s 起指数 ×2,上限 900s)累计,hard 不立即终态;只有显式 `--terminal` 才进入终态 `failed`。`shot.retries` 只跟随实际追加的事件;**重复上报(同 `attempt_id` 或同 `(task_id,n)`)完全无副作用**:不重算 `retry_after`、不顺延退避窗口、不改 task 状态。
- **v2 拒绝 legacy `--failed`**:`schema_version >= 2` 的 manifest 上无 `--task` 的 `--failed` 直接报错(提示先 `render-next` 建任务快照并用 `--failed --task <id>`),**不改任何状态**;v1(schema 1/缺省)保留旧 shot 级 failed 行为并输出 `WARN: legacy --failed without --task (v1 path) — no attempt event; migrate to schema 2`。
- **熔断三维度**:`同 task hard ≥ 3` / `同 task transient ≥ 10` / `同 shot 跨 input_hash 的 hard-failure 任务快照数 ≥ 5`(`hardFailureTaskCount`,同任务多个 hard 只计 1,transient 不计)→ task 与 shot 置 `blocked` 并记 `blocked_reason`。统计窗口 = `epoch === shot.breaker_epoch` 的事件。
- `mark-shot --unblock`:`breaker_epoch += 1`、该 shot 的 **active 与 blocked** 任务一律置 `cancelled`、清除 `blocked_reason`;历史事件与旧任务全部保留供审计。blocked shot 不进入 `render-next` 队列;`stitch-episode --final` 必须报错列出,`--preview` 警告。
- **late/stale callback**:`staleArtifact = task.input_hash !== 当前 shot.input_hash || isTaskSuperseded(task)`;`terminalLate = status ∈ {blocked, cancelled}`;take 状态 = `staleArtifact || terminalLate ? 'superseded' : 'candidate'`,**永不自动 selected**。`retry_wait` / `failed` 的成功回调置 `succeeded + completion: late`;`blocked` / `cancelled` 的任务状态**不复活**,artifact 作为 orphan/superseded take 入 catalog(事件记 `callback_received {late, after_terminal}`)。
- **成功回调幂等键 = `(request_id, content_digest)` / `attempt_id`(与 task 解耦)**:`--take --task <id> --path <mp4> [--request-id <rid>] [--attempt-id <id>]`;`content_digest = fileContentHash(path)`,缺失/不可读抛错;有身份时按 `(task_id, request_id)` 或 `(task_id, attempt_id)` 同 digest → 幂等返回既有 take(不新增素材、ledger 不重复计),异 digest → **冲突抛错且零改动**(本地路径只是 locator,路径不同但 digest 相同不算冲突);同 task、不同 request_id → 各自独立 take、产物与实际消耗各计一次、不自动 selected。**无身份回调不得静默丢弃**:同 task 已有 take 且存在同 digest → 幂等返回;已有 take 但 digest 全不同 → 抛错 `callback for task X has no request/attempt identity and a different content digest — pass --request-id (or --attempt-id) ...`(既不新增也不丢弃);同 task 无 take → 按单 attempt 绑定新增(legacy 无 attempts 时 `attempt_id` 可为 null)。take 记录解析出的 `attempt_id`。

### 画幅两级收敛(PRD §3.7)
- ratio 解析顺序:`series.yaml seedance_defaults.ratio` → episode `script.yaml defaults.ratio`(episode 覆盖 series)→ `'16:9'`。
- shot 级 `ratio` 与 episode ratio 不同时默认报错退出(列出违规 shot 并提示 `allow_mixed_ratio` 逃生门);`allow_mixed_ratio: true` 显式放行混合画幅;冗余同值允许。`input_hash` 用解析后的 ratio(混合镜头用该 shot 实际 ratio)。
- 竖屏 9:16 用 `templates/episode-script-9x16.template.yaml`;字幕烧录区上下各留 15% 安全区(模板定死)。

### schema 版本与迁移(PRD §6)
- manifest / script 各携带 `schema_version`,**缺省 = 1**;`build-manifest` 重建时写入 `schema_version: script.schema_version || 1` 与 `require_keyframe: script.require_keyframe === true`(以 script 为准,`input_hash` 也按此 schema 版本计算)。
- **迁移只由显式命令执行**:`node tools/migrate-episode.js <episode-dir> --to 2`。`stitch-episode --final` **只读** `schema_version`——v1 集按 v1 语义出片并输出提示 `v1 final semantics applied. Run migrate-episode --to 2 to adopt v2 publishing requirements.`,不自动升级、不改 manifest。
- 迁移是**逐项幂等**的:第二次运行 `changed=[]` 且文件字节不变;`--dry-run` 只报告不落盘。
- **注释保护**:仅补/改顶层标量(`schema_version` / `require_keyframe`)时走文本级插入/替换(不整文件 YAML 重排);删除 shot 级 `ratio` 优先文本级删行;确需 YAML 重写时先写 `<file>.bak` 再 WARN 注释可能丢失。
- **ratio 冲突零写入**:`shot.ratio != episode.ratio` 且未设 `allow_mixed_ratio` 时列出违规 shot 并报错,不写任何文件(人工裁决:改 shot 或显式开逃生门)。
- **v1 适用范围**:未迁移集不适用 §3.2/§3.3/§3.4/§3.7 的 v2 新规则,`--final` 按 §5 的 v1 适用条目执行;`--preview` 不输出 v1 提示。

### input_hash 契约(PRD §3.8,M3b)
- `input_hash = SHA256(canonical_json(payload))` 前 16 位;canonical JSON = 键排序 + 无空白 + 数值最简形式(`canonicalJson()` 导出)。**每个 stage 一份完整 payload,三个 stage 互不继承,未出现的字段一律不入 hash**。
- **refs role 命名空间(有序,顺序参与 hash)**:`collectImageRefs()` 每项带 `hash_role`,`location` → `location:<id>`、角色 → `character:<cid>`(保持 `shot.characters` 顺序)、额外引用 → `shot.references[<i>]`;`buildPromptForShot` 返回值新增 `image_refs`(含 `path/role/hash_role`),`role`(人类可读)仍用于 prompt `<image N>` 注入、`image_paths` 兼容不变。
- **stage payload**(`computeStagePayloadHash`):
  - keyframe:`{schema_version, stage:'keyframe', resolved_prompt, refs[{role, content_digest}], model, params:{ratio, resolution}}`,按存在性追加 `style_guide_digest`;`computeShotKeyframeHash(shot,{schemaVersion, styleGuideDigest})` 为 shot 版入口。
  - video:`{schema_version, stage:'video', resolved_prompt, refs, model, params:{ratio, resolution, requested_video_duration}}` + `first_frame`(恒有)+ `style_guide_digest`;`computeShotVideoHash(shot,{schemaVersion, styleGuideDigest, keyframeDigest, keyframeMode})` 为 shot 版入口。`manifest.keyframe_mode`(缺省 `'reference'`)决定:`reference` → `first_frame:null` 且 keyframe 以 `{role:'keyframe:selected', content_digest}` 进 `refs`;`first_frame` → `first_frame:digest` 且 refs 不含该图。
  - tts:`{schema_version, stage:'tts', dialogue_text, voice_id, provider:{name, model, version}, tts_params, style_guide_digest?}`(字段名写死;缓存键 = canonical JSON,换引擎/版本必须 miss)。
  - 按存在性追加的可选字段:`continue_from:{content_digest, cut_frame}`、`style_guide_digest`(=`fileContentHash(style-guide.md)`,由 `styleGuideFileDigest()` 提供)。
- **缺失参考图 fail-closed**:`normalizeStageRefs` 构建 refs 时任一 `content_digest` 为 null(文件缺失/不可读)立即报错并列出完整路径(`missing reference image(s) for input_hash: … — fix inputs before building (content digest required)`);`build-manifest` 主流程与 `verifyManifestFreshness` 继承此行为,不再写入 `content_digest: null` 的 hash。
- **keyframe digest 入 video hash**:selected keyframe 的 `content_digest` 参与 video-stage hash(参考图引导入 `refs`,首帧约束入 `first_frame`);keyframe selected 变更 → video `input_hash` 变化、下游任务失效。`verifyManifestFreshness` 用 `computeShotVideoHash`(含当前 selected keyframe digest 与 `keyframe_mode`)与 `shot.input_hash` 比较。
- **legacy `computeInputHash`** 保留(供已废弃的 `mark-shot --done` 与既有单测),不再用于 manifest 主路径。`build-manifest` 每 shot 存 `image_refs`(含 `hash_role`)、`keyframe_hash`(keyframe-stage)、`input_hash`(video-stage)。
- **不入**字段:本地绝对/相对路径(参考图同内容迁移/改名不产生假失效)、task_id、take_id、时间戳、reviewer、attempt/breaker 事件、配额元数据;`padding_frames`/`output_duration` 不入 video hash。

### 剪辑时间线契约(PRD §3.6,M1 timeline core)
- **半开区间**:所有 frame range 为 `[start, end)`(`start` 含、`end` 不含),`duration_frames = end - start`;字幕 offset、spill、cut frame、deleted head frame 全部按此口径,不使用闭区间。
- **帧号基准**:`build-timeline.js` 输出 `timeline.json` 为帧号(clip 实例唯一发布基准);入出点可写帧原生 `source_in/source_out`,或秒制 `in_point/out_point`(按 episode FPS 换算,`conversion_residuals` 记 `source_in_sec`/`source_out_sec`;帧原生条目为 `null`)。
- **output 连续**:首个 clip `output_start = 0`,其后 `output_start = 上一 clip 的 output_end`;`output_end = output_start + duration_frames`,`duration_frames = (source_out - source_in) - deleted_head_frames + padding_frames > 0`。
- **同一 take 可多 clip**:同一 take 可被多个 clip 实例引用(重复/乱序),各自独立计算,不沿用原始 take 时长或 script 相邻关系。
- **偏移按 clip 实例**:凡「上一镜/下一镜/邻接/偏移」的发布阶段语义均指 timeline clip instance;音轨/字幕偏移一律按 clip 的 output 帧位计算,原始 take 的 ffprobe 时长仅用于素材校验。
- `buildTimeline` 为纯函数且确定性(不含时间戳、两次构建 deep-equal);`validateTimeline` 不抛错,返回 `{ ok, errors }` 供 CLI/发布入口校验。

### 镜间连续性 continue_from(PRD §3.3,M4a 弱承诺)
- **episode FPS 权威在 `build-manifest`**:`resolveEpisodeFps(script, series)` 按 `script.defaults.fps` → `series.seedance_defaults.fps` → `30` 解析(非有限正整数即抛错),写入 `manifest.fps`;`build-timeline` 的 `resolveTimelineFps` 仍按 `edit.timeline.fps` → `manifest.fps` → `30`,链路自动一致。
- **offset 帧号 canonicalize**:`continue_from_offset` 以秒配置(缺省 `-0.1`),`build-manifest` 按 episode FPS 换算为 `continue_from_offset_frames` 并记录换算残差 `continue_from_residual_sec`;无 `continue_from` 时不写这两个字段。帧换算权威入口为 `build-manifest.secondsToFrames(seconds, fps)`(`{frames, residual}`,允许负秒),`build-timeline.secondsToFrames` 为兼容转发(保留非负校验)。
- **校验三件套(构建期 fail-closed)**:`validateContinueFrom(shots)` 纯函数逐条拒绝 self-reference、unknown / 顺序在前(上游必须在 script 顺序之前)、cycle(错误列出环)、depth > 3(=3 允许);`build-manifest` 在计算任何 hash 前调用,任一错误打印全部链路并非零退出且不写 manifest。
- **keyframe 上游尾帧引用**:shot 有 `continue_from` 且建 keyframe 任务时,`render-next` 取上游 shot 的 **selected video take**,调用 `tools/tail-frame.js` 的 `extractTailFrame({videoPath, offsetFrames, fps, outPath})`(可注入 stub)把尾帧冻结到 `.task-assets/<task_id>/upstream-tail.png`;该图作为 `{role:'upstream_tail:continue_from'}` ref 进入 task,`cut_frame = 上游 take 时长帧数 + offsetFrames(≥0)`,`task.continue_from = {upstream_shot_id, take_id, offset_frames, cut_frame, content_digest}`。`computeShotKeyframeHash(shot, {upstreamTail:{path, cut_frame}})` 把该 ref 追加进 keyframe-stage refs;因尾帧在派发时才可知,FIX3 以**不含尾帧的 base hash** 对齐 `shot.keyframe_hash`,任务记录叠加尾帧后的 stage hash(`task.base_input_hash` 保存 base,供幂等复用/选片对齐)。上游缺 selected video take / 文件不存在 → 抛错且零改动。
- **弱承诺**:continue_from 只增加视觉参考,**不触发任何截断/删帧/时长调整**(截断仅由 `cut_join` 接头决定);`tail-frame.js` 一律以 `execFileSync` 参数数组调用 ffmpeg/ffprobe,失败抛错。
- **复用前绑定校验(§3.8 内容等价)**:`render-next` 复用 continue_from keyframe 任务前校验 `task.continue_from` 与上游当前 selected take 一致——`upstream_take_digest` 相同则 take_id 变了仍可复用；内容变更 → 旧任务一跳失效(`superseded_at`)、新建任务。回归 `M4a6`(内容变更失效)/`M4a7`(内容等值复用)。

### 镜间连续动作接镜 cut_join(PRD §3.3,M4b 强承诺)
- **触发边界(写死)**:只有 `cut_join: true` 的接头进入接镜处理(截断/删帧);`continue_from` 永远只作视觉参考,**不触发任何截断/删帧/时长调整**(即使时间线相邻)。回归 `M4b4`。
- **相邻性校验(仅 cut_join,fail-closed)**:上游 = `shot.continue_from || script 顺序上一镜`(`manifest.shots` 顺序即 script 顺序)。`cut_join` 落在时间线**首 clip**(无上游)→ 报错;前一 clip 的 `shot_id !== 上游` → 报错,消息含本镜/上游/实际前置镜头并提示调整 `edit.yaml` 或去掉 `cut_join`。非 cut_join 不做相邻性要求。回归 `M4b2`。
- **截断恒发生**:`S = edit.timeline.same_frame_ssim_threshold`(必填,有限非负;缺失报 `cut_join requires timeline.same_frame_ssim_threshold`)。`offsetFrames` 取下游 shot 的 `continue_from_offset_frames`(无 continue_from 时按 `continue_from_offset` 秒或默认 `-0.1` 用 episode FPS 换算;不得用 build-timeline 的非负兼容包装),`cutFrame = 上游 clip.source_out + offsetFrames`,clamp 到 `[上游.source_in + 1, 上游.source_out]`,并把**上游 clip 的 `source_out` 更新为 cutFrame**(半开区间:最后保留帧 = `cutFrame - 1`;截断与 SSIM 无关)。回归 `M4b3`。
- **删帧由 S 决定**:比对 `upstream[cutFrame-1]` vs `downstream.source_in` 得 SSIM;`SSIM >= S` → `deleted_head_frames = requested`(`requested` = edit.yaml 显式值,否则默认 `1`),否则 `0`。`source_in` **始终保留原裁切点**,实际首帧 = `source_in + deleted_head_frames`,删帧只参与输出时长公式一次。
- **接头比对**:`tools/junction.js` 的 `decideDeletedHeadFrames`/`extractFrameAt`/`compareJunctionFrames`/`cfrNormalizeArgs`;`buildTimeline({options.junctionCompare})` 可注入 stub(默认 `compareJunctionFrames`),take 相对路径按项目 ROOT 解析,缺失/文件不存在 → 报错;抽帧/比对一律 `execFileSync` 参数数组。返回的每个 clip 带 `cut_join` 布尔,cut_join 时附 `junction: {ssim, threshold_s, cut_frame, deleted_head_frames}` 供审计。回归 `M4b1`/`M4b5`/`M4b7` + ffmpeg 门控。
- **CFR 标准化**:`cfrNormalizeArgs({input, output, fps, width, height})` 写死滤镜链 `scale=W:H:force_original_aspect_ratio=decrease,pad=W:H:(ow-iw)/2:(oh-ih)/2:black,fps=<fps>,format=yuv420p` + `-c:v libx264 -preset fast -crf 22 -an -movflags +faststart`;先标准化再做删帧/截断,保证「删 1 帧」时长确定。回归 `M4b6`。
- **失败消息**:相邻性错误统一前缀 `cut_join adjacency violation`;缺 S 为 `cut_join requires timeline.same_frame_ssim_threshold`;缺素材为 `cut_join junction take file not found` / `cut_join junction requires a take path`。bound approval record 见下节。

### bound approval record(PRD §3.3,M4c)
- **统一机制**:`--accept-upstream`(continue_from 弱承诺)与 cut_join 人工四要素验收统一为一种 machine-readable 记录,存 `manifest.approvals[]`;schema 写死:
  `{ kind:'accept_upstream'|'junction_review', upstream_clip, downstream_clip, downstream_shot?, bindings:{ upstream:{take_id, content_digest, source_out}, downstream:{ keyframe:{take_id, content_digest}|absent, video:{take_id, content_digest}, source_in?, deleted_head_frames? } }, verdict?, reviewer, reviewed_at }`。
- **validity 只看内容与语义**:只比较 `bindings` 的 `content_digest` 与语义参数(`source_out`=cut_frame、`source_in`、`deleted_head_frames`);`upstream_clip`/`downstream_clip`/`downstream_shot`/`take_id` **仅定位与审计,不参与失效判定**——clip_id/take_id 变了但内容与裁切/删帧参数相同 → 记录仍有效(禁止 `if (clip_id !== new) invalidate()`)。回归 `M4c3`。
- **junction_review 硬规则**:每个 `cut_join === true` 的 clip 必须匹配到一条记录(按 digest + 语义参数匹配,与 locator 无关);记录必须绑定两个已存在 clip 且其 video take 文件可读;`verdict` 四要素(`subject`/`prop`/`action_phase`/`direction`)必填且 ∈ {pass, fail},**全 pass 才有效**。take 内容变化 / `source_out` / `source_in` / `deleted_head_frames` 变化 → 记录失效(problem 消息含 clip id 与不一致的绑定)。回归 `M4c1`/`M4c2`。
- **accept_upstream**:弱承诺,不强制存在;存在即校验 upstream take 内容摘要与 `cut_frame`(`cut_frame` 解析优先级:时间线 `junction.cut_frame` → 时间线上游 clip `source_out` → `render_task.continue_from.cut_frame`;`continue_from_offset_frames` 是相对偏移,单独不可导出绝对帧号,缺失时报错)。回归 `M4c4`。
- **写入(`mark-approval.js`)**:读 `manifest.json` + timeline(默认 `<episode-dir>/timeline.json`),`atomicWriteJson` + `withLock`;重复确认(同 `(kind, upstream_clip, downstream_clip)` 或 `(kind, downstream_shot)`)→ **覆盖为最新**并把旧记录追加到 `manifest.approval_history[]`(附 `superseded_at`,历史可审计)。`build-manifest` 重建时保留 `approvals` / `approval_history`。回归 `M4c5`。
- **导出入口统一检查(§5 Gate #4b/#13)**:`edit-episode` 正式导出前(freshness 之后)与 `stitch-episode --final` 都调用 `collectApprovalProblems(manifest, timeline)`;有问题打印全部并 exit 4。timeline 来源为 `<episode-dir>/timeline.json`(只用于 approvals 校验,不要求与 `edit.yaml` 一致);缺失时跳过并 WARN(M5 再强制)。`stitch --preview` 仅 WARN。回归 `M4c6`。

### 持久化
- manifest.json / catalog.json 采用原子写(tmp + rename);支持故障注入 `SHOWS_FAULT_ATOMIC_WRITE=before-tmp-write|after-tmp-write`(模拟 rename 前 crash)。读侧 `readJsonFile()` 先清理崩溃残留 tmp,识别损坏 JSON 后拒绝使用并给出恢复指引(不静默吞掉半写文件)。
- tmp 清理是 pid 感知的:存活写者的新鲜 tmp(≤60s)视为 in-flight 保留,写者已死或超龄才清理(避免并发写者互相误删)。
- **跨进程锁**(`tools/lock.js`):`mark-shot`(episode 目录 + catalog)、`render-next`(非 `--all`)、`build-manifest`、`migrate-episode` 的事务式写入均以 `withLock` 串行化——`fs.openSync(path,'wx')` 原子获取,死 pid 或 mtime 超 `staleMs`(默认 60000)回收,`timeoutMs`(默认 10000)后抛 `lock timeout`;多 key 排序获取逆序释放,`finally` + 一次性 `process.on('exit')` 兜底。**已知限制**:锁不消除 manifest 已落盘、catalog 写入前崩溃的窗口(无事务日志不可消除),触发并发事务需求时另立 ADR。
- `edit-episode` / `stitch-episode` 用 `execFileSync` 参数数组调用 ffmpeg/ffprobe(不拼接 shell),`in_point/out_point` 必须为有限非负数。

### 配额账本(PRD §4)
- manifest 顶层 `quota_ledger`(缺省自动初始化,`build-manifest` 重建时与 `render_tasks`/`task_events` 一起保留):
  `stages.{image,tts,video} = { requests, successes, cache_hits, rejects, failed_billed, actual_cost }` + `currency`(缺省 `USD`)。
- 成本指标公式**写死**:
  `cost_per_accepted_video_shot = (image.actual_cost + tts.actual_cost + video.actual_cost) / count(distinct accepted video shots included in final timeline)`。
  分母按 **distinct shot_id**(同一 shot 多个 clip 实例只算一次,剪辑方式不污染生成成本);**cache hit 成本计 0**;**rejected 生成计入**;failed request 供应商实扣则计入。
- 集成(全部走原子写):`render-next` 新建 task → `video.requests += 1`,幂等复用 → `video.cache_hits += 1`(每个 task **至多一次**:task 上 `cache_hit_counted` 标记,轮询式反复复用不再线性抬高;`retry_wait` 到期重派仍计真实 `request`);
  `mark-shot --take` → `video.successes += 1`,`--review --conclusion reject`/`--reject` → `video.rejects += 1`,
  `--failed --task`(hard/熔断)→ `video.failed_billed += 1`(`--billed`/`--no-billed` 显式覆盖,供应商实扣无法自动确认时由调用方决策);
  可选 `--cost <n>` 累加到 `video.actual_cost`(有限非负数,非法报错)。
- 纯函数:`emptyLedger` / `recordOutcome` / `computeCostPerAcceptedVideoShot` / `ledgerReport`;分母为 0 时返回 `null` + warning(不除零/NaN)。

### intent 声明(PRD §4,M5a)
**豁免由制作意图声明决定,不由输出缺什么决定**(写死)。`build-manifest` 在 **continue_from 校验之后、任何 hash/写盘之前** 调用 `validateIntent`;矛盾声明打印全部错误并 `exit(4)`,不写 manifest(不得留到导出时猜优先级)。
- **字段值域**:`dialogue`/`silent` 布尔;`audio ∈ none | dialogue | music_sfx | full`;`subtitles ∈ none | burn | soft | both`。非法值在 `validateIntent` 报错(含字段名与实际值),`deriveIntent` 不抛错。
- **来源优先级(逐字段合并,edit 胜)**:`edit.intent` → `edit.timeline.intent` → `script.intent` → 派生;`declared[field]=true` 仅当显式给出,`sources[field] ∈ edit | script | derived`。
- **派生规则(写死)**:`dialogue = detectDialogue(script)`(任一 `scene.shot.dialogue` 非空:字符串/数组元素/`{text}`/`{lines:[...]}`,纯空白不算);`audio = dialogue ? 'dialogue' : 'music_sfx'`(**派生绝不产出 `none`**);`subtitles = 'none'`;`silent = false`。
- **三条非法组合(写死)**:`dialogue=true && audio='none'`;`dialogue=true && silent=true`;`dialogue=true && subtitles='none'`(确需无字幕应先改稿去掉 dialogue)。
- **合法例外**:`dialogue=false && subtitles!=='none'`(显式字幕意图);`audio='none' && silent=true` 合法,`normalized.redundant=['silent']`(**保留 `silent=true`,仅标注冗余**;loudnorm 由公式自然不适用)。
- **`audio='none'` 必须显式声明**:`validateIntent` 报错消息含 `intent.audio: none must be explicitly declared`。
- **判定公式(写死)**:`requires_subtitles = dialogue || subtitles != 'none'`;`requires_audio = audio != 'none'`;`requires_loudnorm = requires_audio && !silent`;豁免 = 对应 require 取反。
- **落盘与审计**:`manifest.intent = { dialogue, audio, subtitles, silent, requires_subtitles, requires_audio, requires_loudnorm, declared, sources }`;`declared`/`sources` 供审计与 Gate 豁免判定(**Gate 读它,不得由「输出缺什么」反推**)。v1(`schema_version === 1`)集同样写入供迁移/审计,不改变 v1 其他行为。
- 回归 `M5a1`–`M5a8`(派生/显式优先级/非法组合/合法例外/真值表/CLI 集成/真实 episode 只读回归)。

### TTS stage(PRD §3.4/§3.5,M5)
**TTS 管道已接线,但端到端渲染仍需真实 `DOUBAO_TTS_API_KEY`;字幕产物已由 M5-SUB 交付(见「字幕与封面」;溢出策略 M5-OVF、音轨/loudnorm M5-AUD 已交付)。**
- **dialogue 解析(写死)**:`shot.dialogue` 支持字符串或 `{text, voice_id}`;trim 后为空视为无对白。有对白 → shot 增 `dialogue_text`/`voice_id`/`tts_hash`/`tts_takes: []`/`selected_tts: null`;**无对白绝不写这些字段**(无对白 episode 的 manifest 字段不漂移,重建保留 `tts_takes`/`selected_tts`)。
- **provider 配置(写死优先级)**:`script.tts` → `series.tts` → 默认 `{provider:{name:'doubao',model:'seed-tts-2.0',version:'2026-09-14'}, params:{speed:0.95}}`;provider 必须含 `name`/`model`/`version`,任一缺失且存在对白 → **exit 4 不写盘**。解析结果落 `manifest.tts = {provider, params, chars_per_second}`(仅存在对白时写),供 render-next 建 tts 任务。
- **voice_id fail-closed**:`shot.dialogue.voice_id` → `shot.voice_id` → `scene.voice_id` → `script.tts.voice_id` → `series.tts.voice_id`;有对白但解析不到 → **exit 4**(消息含 shot id 与全部配置位点),不写 manifest。
- **tts_hash(§3.8)**:`computeStagePayloadHash({schemaVersion, stage:'tts', dialogueText, voiceId, provider, ttsParams, styleGuideDigest: null})`。换 provider/model/version/text/voice/params 必须 miss;identity/时间戳不入 hash。
- **字数估时仅预警**:`estimateDialogueSeconds(text,{charsPerSecond})` 缺省 5 字/秒,`script.tts.chars_per_second` 可覆盖;估算 > `shot.duration` **只打印 WARN,不报错/不阻断**。
- **render-next tts stage**:`targetStage` = 有 `dialogue_text` 且无**已选**可用 tts take → `'tts'`;否则维持 keyframe/video。可用 tts take = `tts_takes[]` 中 `status !== 'rejected'` 且 `input_hash === shot.tts_hash`(`selected_tts` 指向时优先)。派发顺序 **tts → keyframe → video**(`--video` 仍只做 video)。
- **tts 任务**:`take_id` 前缀 `tts-`(`tts-001` 起,避让已预留 id);`task.tts = {dialogue_text, voice_id, provider, tts_params}`;账本 stage 映射 `keyframe→image`、`tts→tts`、其余 `video`。FIX3-1 按 `manifest.tts` + shot 字段重算 `tts_hash` 并核对,不一致抛错指向 `build-manifest`。
- **产物级缓存(PRD:内容哈希缓存)**:派发前若已存在 `input_hash === shot.tts_hash` 的非 rejected take → **不新建任务**;`selected_tts` 未落位时认领该 take(幂等:仅首次认领时 `tts.cache_hits += 1`,重复派发不重复计),打印 `tts cache hit <take>`。
- **CLI `tts.js`**:真实调用与 `--take` 二选一;产物 `<episode-dir>/audio/<shot-id>-<take-id>.mp3`(先 tmp 再 rename 原子写);take 记 `{id, task_id, status, path, input_hash, content_digest, duration_sec, provider, request_id, at}`;幂等 `(task_id, content_digest)`;成功 `tts.successes += 1`(**不重复计 request**,request 在 render-next 建任务时已计);失败不自动记账,打印 `classifyTtsError` 分类与 `node tools/mark-shot.js <ep> <shot> --failed --task <id> --kind hard|transient [--billed]` 并非零退出且零落盘。`--env-file` 仅注入本进程 env;写盘全程 `withLock`;`--list` 只读不加锁。
- **`TTS_MOCK` 用法(离线端到端)**:`TTS_MOCK=1 TTS_MOCK_AUDIO=<真实音频夹具路径>` 时 `synthDoubao` 不联网、不消耗额度,直接返回夹具字节;缺 `TTS_MOCK_AUDIO` 报错(**拒绝伪造静音 mp3**)。
- **真实调用**:需 `DOUBAO_TTS_API_KEY`(可选 `DOUBAO_TTS_RESOURCE_ID`/`DOUBAO_TTS_API_URL`/`DOUBAO_TTS_UID`);**不自动批量**——本工具一次只处理一个 `--task`,批量编排由调用方逐任务驱动。
- 回归 `TTS1`–`TTS8`(dialogue/voice/hash/估时/render-next tts/产物缓存/adapter mock/tts.js/账本 stage 映射/无对白不漂移;全程离线,无真实网络调用)。

### final 探测两步(PRD §4,M5b)
**步骤顺序写死**：`probe`(媒体属性探测)→ `spec`(v1/v2 口径校验)→ `decode`(完整解码)→ `av_length`(Gate #8);任一步失败**短路**后续(后续步骤 `{ok:false, skipped:true}`)并汇总 `problems`;全部通过才计「可解码」。入口 `verifyFinalMedia({finalPath, manifest, template, intent, schemaVersion, opts})`,`opts.probeMedia`/`opts.verifyDecode` 可注入以便离线单测;缺省 `template={ratio,resolution}`、`fps=manifest.fps`、`intent=manifest.intent`、`schemaVersion=manifest.schema_version||1`。
- **第一步 媒体属性探测**(`probeMedia` = `ffprobe -v error -print_format json -show_format -show_streams <file>`;`parseProbeJson` 解析 `{video,audio,format}`,无视频流 → `video=null`,`fps` 由 `avg_frame_rate` 解析(缺失回退 `r_frame_rate`,`0/0`→null))。
- **v2 口径**(`schemaVersion!=1`)：视频流必须存在;宽高 = `expectedVideoSpec({template,fps})`(纯函数,`resolution` 数字为**短边**:横屏作高、竖屏作宽,`720p/16:9`→1280×720、`720p/9:16`→720×1280、`1:1`→720×720;宽高 `Math.round` 后偶数化;`template.width/height` 显式给出优先;非法 resolution/ratio fail-closed);FPS 与期望差 **< 0.5**;`pix_fmt==='yuv420p'`;`format.format_name` 非空(容器可识别)。
- **v1 口径**(`schemaVersion===1`，保留 v1 模板语义)：**仅**要求视频流存在 + 容器可识别,**不**校验分辨率/FPS/pix_fmt/音频(错分辨率也不报)。
- **音频豁免(写死,§5 矩阵第 9 行)**：`intentFlags(intent).requires_audio===true` 的 v2 才校验音频流存在 + `codec==='aac'` + `sample_rate===48000` + `channels===2`(逐项报错);`requires_audio===false`(`intent.audio:'none'`)或 v1 → **跳过全部音频规格检查**(有声轨也不报错)。
- **第二步 完整解码验证**(`verifyDecode`)：`ffmpeg -v error -i <file> -f null -`(`execFileSync` 参数数组,`timeoutMs` 缺省 600000);`ok = !timedOut && exitCode===0 && stderr 去空白为空`——退出码非 0、超时、**任何非空 error 输出**均失败(PRD 写死)。
- **A/V 长度**(`checkAvLength`,Gate #8,严格 `<0.1s`)：`requires_audio` 为真且 audio 存在 → `|video.duration-audio.duration|<0.1`;否则只要求 `video.duration>0`(`audio:'none'` 或 v1 无音轨 → 只校验视频流)。
- **二进制可覆盖**：`FFPROBE_BIN` / `FFMPEG_BIN`;一律 `execFileSync` 参数数组(不拼 shell),失败 fail-closed。
- 回归 `M5b1`–`M5b7`(纯函数 + stub 编排 + 真实 ffmpeg 门控 + CLI);Release Gate 接线随 M5c。

### 时长四量与溢出策略(PRD §3.4,M5-OVF)
**只做决策与标记(帧级),音频截断/混音/loudnorm 属 M5-AUD。** 纯函数在 `tools/dialogue.js`,`build-timeline` v2 在**接头处理之后、输出重算之前**执行溢出决策。
- **四个时长量(分离定义,不得混用)**:`nominal_duration`(标称,信息项)/`requested_video_duration`(请求值,须在 E1 值域内)/`source_duration`(take 实测,仅入出点合法性)/`output_duration = source_out - source_in - deleted_head_frames + padding_frames`(§3.6)。`padding_frames` **仅指后期静帧补长**,不参与生成侧请求。
- **实测优先**:`dialogue_ms = round(tts_take.duration_sec * 1000)`;无 selected/non-rejected tts take 或 take 无 `duration_sec` → `dialogue.measured=false`(记 WARN,不阻断);**字数估时(`estimateDialogueSeconds`)仅预警,绝不用作溢出判定**。
- **溢出帧数**:`overflowFrames = max(0, ceil(dialogue_ms/1000*fps) - output_duration)`(向上进位,绝不向下溢出)。
- **策略优先级(写死)**:`none`(无溢出)→ `pad_freeze`(溢出 ≤ `max_freeze_padding_frames`,**默认 0 即不生效**,`padding_frames += 溢出帧数`)→ `trim`(**仅 `allow_trim:true`**,默认 false)→ `dialogue_spill`(`spill.ok`)→ `error`(抛错并要求改剧本;消息含 clip id、溢出帧数、各策略否决原因).
- **spill 五条约束(按 clip 实例 output 帧位)**:①下一 clip 实例必须存在;②其 dialogue 为空;③`spill ≤ 下一 clip 实际输出时长`;④spill 起点(上游 `output_end`)不得落在 `cut_join` 接头帧;⑤同一 clip 只能 spill 一次(已记 `dialogue_spill_ms` → 拒绝,禁止链式)。spill **不改任何视频 clip 的 in/out 或时长**;SFX/music cue 落入 spill 段(下游 clip 头部)时 WARN(允许但留痕)。
- **trim 语义**:从尾部截断,比例保留字符并优先在标点(`,。！？；、,.!?;）】` 等)断句,找不到硬切;去尾空白并追加 `…`(已含不重复);`clip.trim = {dialogue_ms, keep_ms, text_truncated}` 且 `dialogue.dialogue_ms` 更新为 `keep_ms`。空文本不截断。
- **配置来源(写死)**:`edit.timeline.allow_trim`(默认 **false**)/`edit.timeline.max_freeze_padding_frames`(默认 **0**);`edit.overflow.allow_trim`/`edit.overflow.max_freeze_padding_frames` 亦接受。**禁止默认删对白与默认静帧补长**。
- **Gate #6(实判,已去除 deferred)**:`intent.dialogue===false && requires_subtitles===false` → `not_applicable`;否则 v2 由 `collectUnresolvedOverflow(timeline,{intent})` 判:`measured=false` / 未落地溢出 / spill 约束被破坏 / 未声明但 manifest 有 `dialogue_text` → **fail**(列明 clip);无 `timeline.json` → **fail** 并给 `build-timeline` 提示;v1 → `not_applicable`。已解决(pad/trim/spill 成功)不算未解决。
- 回归 `OVF1`–`OVF7`(四量/溢出/策略优先级/spill 五约束/trim/build-timeline 集成/Gate #6/回归)。

### 音轨与响度(PRD §3.9,M5-AUD)
**把 M5-OVF 的帧级决策落成一条 program 音轨**:`tools/audio.js`。纯函数(无 ffmpeg)+ ffmpeg 编排(`execFileSync` 参数数组、无 shell、`FFMPEG_BIN` 可覆盖)。
- **输出规格(写死)**:AAC / **48000 Hz** / **stereo**(`-ar 48000 -ac 2 -c:a aac -b:a 192k`);容器 `.m4a`。
- **段来源与偏移(一律按 clip 实例 output 帧位)**:
  - 对白:`clip.dialogue` → 段起点 = `clip.output_start` 帧位换算毫秒(写死 `round(frame*1000/fps)`);时长 = `trim.keep_ms`(有 trim)否则 `dialogue.dialogue_ms`;`measured:false` / `dialogue_ms=null` → 只记 WARN、不产段。
  - sfx:clip 级 `sfx: [{id, at, gain_db}]`,`at` 为 clip 内帧号 → `clip.output_start + at`;源 `<episode-dir>/audio/sfx/<id>.(mp3|wav|m4a)`(按写死顺序解析)。
  - music:集级 `edit.timeline.cues`(构建时落位到 `timeline.json` 的 `cues[]`),**帧号 `at` 优先**、`at_ms` 回退;源 `<episode-dir>/audio/music/<id>.*`。
- **spill 只动音频**:`dialogue_spill_ms` 另记 `spill_ms`,`keep_ms` 不变;混音用 `adelay`(+`apad`)跨切点延伸对白,**program 长度不变**(由静音基床与 `amix=duration=first` 决定)。
- **混音**:静音基床(`anullsrc`,48k stereo,时长 = `programDurationMs` = 最后 clip `output_end` @ fps)→ 每段 `aformat→atrim→adelay→volume=<gain>dB` → `amix=inputs=N:normalize=0:duration=first`(不二次归一;交叠由显式 gain 控制)。
- **两遍 loudnorm(顺序写死)**:第一遍 `loudnorm=I=-14:TP=-1:LRA=11:print_format=json -f null -` 分析 → 第二遍带 `measured_I/TP/LRA/thresh/offset` + `linear=true` 应用并直接封装 AAC。**最终复测产物**的 loudness 作为 Gate #10 / `verifyLoudness` 的唯一数据源(不用第一遍的输入测量值)。
- **达标与豁免**:`|I-(-14)|≤1` 且 `TP≤-1`;整集无有效非静音样本 → 跳过 loudnorm 并 WARN(`loudnorm: skipped`),不崩。
- **strict 语义**:`strict:true`(函数默认)下源缺失/越界(`at_ms+dur>duration_ms` 且无 spill) → **errors + 抛错且不留半成品**;`strict:false`(CLI 默认,`--strict` 开启)下缺失源 → WARN + 跳过该段,结构性坏 cue 仍 fail-closed。CLI 成功退出 0(打印时长/测得响度/警告数),失败退出非零。
- 回归 `AUD1`–`AUD8`(对白段/cue 落位/loudnorm 纯函数/真实 `analyzeLoudness`/`buildProgramAudio` 端到端 + spill + 缺源 strict/`build-timeline` 落位 cues·sfx/CLI)。

### 字幕与封面(PRD §4,M5-SUB)
**把 clip 实例时间线落成字幕产物与封面帧**:`tools/subtitles.js` + `tools/cover.js`。
- **cue 时间口径(写死)**:每 clip 的 `dialogue`(`measured===true` 且 `dialogue_ms!=null`)产 1 cue;起点 = `clip.output_start`;时长 = `trim.keep_ms`(有 trim)否则 `dialogue_ms`,再 `+ dialogue_spill_ms`(**字幕跟随实际音频**:spill 只延长音频,字幕同样延伸)。cue 边界量化到 fps 帧栅格(`round(frame*1000/fps)`);`checkCueAlignment` 以「与帧栅格偏差 <1ms」作为「逐句与对白实测对齐 <100ms」的代理验收(帧对齐误差 ≤ 半帧;非帧对齐 → problem 提示按 fps 量化)。`measured:false` → 只 WARN 不产 cue。`cues` 全部落在 `[0, final_duration]`(±1ms),重叠/空文本 → fail-closed。
- **换行规则(写死)**:竖屏 `9:16` 每行 ≤**15** 字,其余比例 ≤**22** 字;中文标点优先断行(`，。！？；：、,.!?;:` 之后),其次空格/标签边界,超长硬切;不产生空行、不以标点起行。
- **字体回退链(写死)**:`PingFang SC` → `Noto Sans CJK SC` → `Source Han Sans SC` → `Microsoft YaHei`;`--font` 只覆盖 primary,回退链不变。
- **安全区**:竖屏字幕烧录区上下各留 **15%**(`force_style` 的 `MarginV` 按 `videoHeight` 15% 计算,调用方给高度);非竖屏默认 5%。
- **产物**:`writeSrt` 默认写 `<episode-dir>/episode.srt`(**Gate #7 默认识别位**),原子写、problems 非空抛错;`burnSubtitles` 支持 `burn`(硬字幕)/`soft`(`-c copy -c:s mov_text`)/`both`(先 burn 后 soft 两步),失败清理半成品。`burn`/`both` 需要 ffmpeg 编入 `subtitles` filter(libass);`hasSubtitlesFilter(bin)` 可预检,缺 filter 时抛 `kind='missing_libass'` 的可执行异常(提示改用 `mode=soft` 或装完整 ffmpeg);当前开发机 ffmpeg 无 libass → 硬烧录分支在测试中跳过,`soft` 正常。
- **封面优先级(写死,PRD §4)**:`cover.clip_id` → ① 该 clip 的视频 take 绑定的 keyframe(生成视频时的 `first_frame` 来源,**不得用 shot 当前 selected keyframe**)→ ② 否则实际首帧 = `source_in + deleted_head_frames`;退路 `cover.promo_asset`(独立宣传素材,不入 input_hash/时间线);都没有 → 报错。`generateCover` 按此产 PNG,失败清理半成品。
- 回归 `SUB1`–`SUB8`(cue 派生/wrap/SRT 格式与帧对齐/writeSrt + Gate #7/`burnSubtitles`/`generateCover`/Gate #11 + `artifacts.cover`/生产不漂移)。

### v2 帧口径出片与确定性(PRD §3.6/§5,M5-EDIT/D4)
**消费 `timeline.json`(clip 实例)产出最终成片**:`tools/render-final.js` + `tools/determinism.js`。纯函数 `clipRenderArgs`(可单测)+ ffmpeg 编排(`execFileSync` 参数数组、无 shell、`FFMPEG_BIN`/`FFPROBE_BIN` 可覆盖)。
- **入点/删帧/静帧/帧数(写死)**:`-ss = (source_in + deleted_head_frames)/fps`(**删帧=入点右移,不改写 `source_in`**,实际首帧 = `source_in + deleted_head_frames`);`-t = (source_out - source_in - deleted_head_frames)/fps` 先把素材截到 `source_out`,使 `padding_frames>0` 时 `tpad=stop_mode=clone:stop_duration=padding_frames/fps` **静帧补长**生效;`-frames:v = output_duration = source_out - source_in - deleted_head_frames + padding_frames`(半开区间 §3.6)。
- **CFR/规格与确定性参数(写死)**:滤镜/编码复用 `junction.cfrNormalizeArgs`(`scale/pad/fps/format=yuv420p` + libx264 `fast`/`crf22` + `-an`);追加 `-fflags +bitexact -flags +bitexact -map_metadata -1 -threads 1`。逐 clip 渲染后 `concat` demuxer `-c copy`。
- **音频(§3.9)**:`intentFlags(manifest.intent).requires_audio` 为真 → 需要 `<episode-dir>/audio/program.m4a`(缺 → 报错并提示 `node tools/audio.js <episode-dir>`);`intent.audio==='none'` → 不加音轨(`-an`);`intent.silent===true` → 允许无音轨(WARN)。混流用 `-map 0:v:0 -map 1:a:0 -c copy`。
- **字幕(§4)**:`requires_subtitles` 为真 → 需要 `<episode-dir>/episode.srt`(缺且声明对白 → 报错并提示 `node tools/subtitles.js <episode-dir> --write`);默认 `soft`(`mov_text`);`burn`/`both` 且本机有 libass → 硬烧录;无 libass → **降级 `soft` + WARN**(本机口径,写死)。
- **封面(§4/#11)**:`cover.generateCover` → `<episode-dir>/cover.png`(已存在则覆盖;失败抛错;`opts.skipCover` 可跳过);优先级仍为 clip 绑定 keyframe → 实际首帧 → `promo_asset`。
- **出片后校验(§5 #8/#9)**:`probe.verifyFinalMedia`(v2 全量规格 + 完整解码 + A/V 长度 <100ms);失败 → 报错且**不留 outPath**(tmp 在 `finally` 清理)。返回 `{ok, outPath, clips, duration_sec, audio, subtitles, cover, warnings}`。
- **入口接线(v1 行为不变)**:`stitch-episode --final` / `edit-episode` 仅当 `manifest.schema_version >= 2` 且 `<episode-dir>/timeline.json` 存在时委托 `renderFinal`(保留既有 freshness/approvals/Gate 前置校验;Stitch 顺序为 offline gate → renderFinal → 媒体 Gate,媒体 Gate 复用 renderFinal 的 probe/decode 结果);否则走既有秒制路径。两处均打印 `v2 timeline render (frame-accurate, PRD §3.6)` / `legacy seconds render (v1 semantics)`。
- **确定性(Gate #14 取证)**:`determinismDigests(file)` = 解码视频流 `MD5`(`-map 0:v -f md5 -`)+ 音频 PCM `SHA256`(`-map 0:a -f s16le -ar 48000 -ac 2 -`);`node tools/determinism.js <episode-dir> [--out <path>] [--keep]` 复跑两次并比较,不一致非零退出。`gate.js` `#14` 保持 `external`,external 文案提示用该工具取证。
- 回归 `FIN1`–`FIN8`(`clipRenderArgs` 纯函数/帧精确单像素/多 clip+A/V/字幕/封面/缺件 fail-closed/确定性 + CLI/v1·v2 入口兼容)。

### Release Gate(PRD §5,M5c)
**「同时满足以下全部条件,才称为能发布一集」的唯一裁定表**(`tools/gate.js`)。条目编号与 PRD §5 一致:**1..14,其中 4 拆为 4a/4b(共 15 行)**。
- **适用矩阵(写死)**:v1(`schema_version === 1`)下 `#3`/`#4b`/`#6`/`#10`/`#11`/`#12`/`#13` → `not_applicable`(`notes` 记 `v1 semantics`,按各自等价校验);其余按 v1 语义运行。v2(schema ≥ 2)全部适用。
- **status 语义**:`pass | fail | not_applicable | deferred | external`。`ok = 无 fail`;`releasable = ok && 无 deferred`;`external`(M0/fixture/确定性证据)不阻塞。单项内部异常(如 timeline 结构坏)→ 该条 fail + 摘要,不抛出。
- **各条口径**:
  - `#1`/`#2` M0 与 schema fixtures 全绿 → `external`(`opts.evidence.m0 === true` 时 pass,否则 external 记原因;Gate 进程不跑全套件)。`#14` 确定性 → `external`(`opts.evidence.determinism === true`)。
  - `#3` E1 报告存在 + 接口版本一致(`opts.e1Report` / `opts.e1ReportPath`;版本取自 `manifest.interface_version`/`manifest.model.*`,无则跳过版本比对并记 external 说明);缺失在 `keyframe_mode==='first_frame'` 时 **fail**,否则 **deferred**(`E1 formal report not available (experiment paused); required before release`);`first_frame_bound!==true` → fail。
  - `#4a` 遍历 timeline clips(v1 按 `shot.selected_take`):take 缺失/`rejected`/任务 `superseded_at`(或 take `superseded`)且无有效 `reuse_record` → fail;shot `blocked` → fail。
  - `#4b`/`#13` 复用 `approvals.validateApprovals`(无 cut_join → pass;绑定 digest/语义参数失效 → fail)。
  - `#5` v2:clip take 必须 == `shot.selected_take`,或该 take 出现在有效 `reuse_records[]`(`reason==='fingerprint_recurrence'` 且 `bound_input_hash===shot.input_hash`);v1:done shot 必须有 `selected_take`。
  - `#6` `intent.dialogue===false && requires_subtitles===false` → `not_applicable`;否则 v2 按 `dialogue.collectUnresolvedOverflow(timeline,{intent})` 实判(未解决溢出/`measured:false`/spill 约束破坏/未声明却有 `dialogue_text` → **fail**,消息列明 clip);无 `timeline.json` → **fail** 并给 `build-timeline` 提示;v1 → `not_applicable`。**已由 deferred 转为实判(M5-OVF)**。
  - `#7` `requires_subtitles===false`(`intent.dialogue===false && subtitles==='none'`)→ `not_applicable`;否则 `artifacts.srt` 缺失/文件不存在 → **fail**;`parseSrtCues` 解析(容忍 BOM/CRLF,坏格式 fail);`finalDuration` 缺失 → deferred;任一 cue 起点 <0 或终点 > `final_duration+0.05` → fail。**产物由 M5-SUB `subtitles.writeSrt` 默认写到 `<episode-dir>/episode.srt`(默认识别位),回归 `SUB4` 已实跑该 srt + `finalDuration` 判 pass。**
  - `#8` 复用 `checkAvLength(probe,{schemaVersion,intent})`;无 `--final` → **fail**(`final file required`)。
  - `#9` 复用 `probe.verifyFinalMedia`(`opts.probeMedia`/`opts.verifyDecode` 可注入;`opts.mediaResult` 可复用已探测结果);`probe + spec + decode` 三步全过才 pass。
  - `#10` `intent.audio==='none'` → `not_applicable`;`intent.silent===true` → **pass** 并记 `loudnorm: skipped`;否则 **实判(M5-AUD)**:`opts.loudness`(`{input_i,input_tp}` 已解析值)→ `audio.verifyLoudness`(`|I+14|≤1` 且 `TP≤-1`);无 `opts.loudness` 但有 `--final` → `analyzeLoudness(finalPath)`(可注入 `opts.analyzeLoudness`);两者都无 → **fail** 并提示 `--final`/`opts.loudness`;offline 相位 → `external`(不阻塞 stitch 前检查)。
  - `#11` **显式传入 `opts.artifacts.cover`(或 CLI `--cover <path>`)时先校验该文件存在**(存在 pass、缺失 fail);不传时复用 `cover.resolveCover`;失败/空 → fail;`promo_asset` 文件须存在;`first_frame` 来源的 take 文件须存在(无可用 clip/keyframe 且无 `promo_asset` → fail)。封面帧由 M5-SUB `cover.generateCover` 产出(默认 `<episode-dir>/cover.png`,回归 `SUB6`/`SUB7`)。
  - `#12` `reconcileQuotaLedger(manifest)`:计数器必须非负整数;`video.successes === 非 keyframe takes 数`、`image.successes === keyframe takes 数`、`video.rejects >= rejected takes`、`successes <= requests+cache_hits`、`failed_billed <= requests`;`video.requests+cache_hits===0 && videoTakes>0` → **deferred**(`ledger not initialized for recovered/legacy takes`,不判 fail)。
- **CLI(只读)**:`node tools/gate.js <episode-dir> [--final <path>] [--timeline <path>] [--e1-report <path>] [--json] [--strict]`;默认读 `<episode-dir>/manifest.json` 与 `<episode-dir>/timeline.json`(缺失 → v2 的 clip 类条目 fail 并给重建提示);`--final` 缺失时 8/9 两条 fail;有 fail → 退出码 4;否则 0。
- **桥接期政策(写死,`--gate-strict` 可立即全量阻塞)**:`deferred` **不阻塞** `--final` 退出码,但打印 `NOT RELEASABLE — N deferred item(s)`;`stitch-episode --final` 拼接前跑可离线条目(`#3/4a/4b/5/6/7/10/11/12/13`),拼接后跑 `#8`/`#9`(复用同一次 probe),`--gate-strict` 时 `deferred` 也 exit 4;`--preview` **不跑** Gate(既有行为)。原因:E1 正式实验暂停 + TTS/音频/字幕产物未接入;Gate 结构已按 PRD 全量实现,只差对应检查函数落位。正式 E1 与 M5 音频批次落地后默认改为 strict。
- 回归 `M5c1`–`M5c12`(元数据矩阵/v1 矩阵/4a·5/3/7/6·10/11/12/ok·releasable/注入 probe + `parseSrtCues`/CLI/stitch 接线)。

### E1 首帧能力实验(PRD §3.1)
- 统计契约见 `tools/e1-report.js` 与 `experiments/README.md`:主指标 SSIM,辅指标 pHash/LPIPS;
  A/B/C 成对实验;**cluster bootstrap**(cluster = `scene::prompt_id`,同 scene 多 seed 不作为独立采样单元);
  四层(closeup/wide/empty/motion)各 ≥10 样本才可判定;判定条件与「仅参考引导」降级见 PRD §3.1。
- **阈值预注册**:缺 `delta_preregistered` / `ssim_abs_min` / `delta_frozen_at` → 工具**拒绝出结论**(退出码 2);
  判定条件 #4 为 A 组绝对质量门槛(`median(A) ≥ ssim_abs_min`,report JSON `absolute:{ssim_abs_min,a_median,pass}`);
  缺 `duration_value_range` / `lipsync` / `metrics`(SSIM 实现名+版本+参数+预处理协议) → 报告 `incomplete`
  (统计照做,但不得声称 E1 验证完成)。
- **E1 正式报告需要真实生成实验(外部动作)**:本仓库只交付统计工具链与 `experiments/e1-dataset.example.json`
  (虚构合成样例,`meta.synthetic: true`,报告大声标注),**没有**任何真实接口结论。

## 新集草稿与零成本校验(DRAFT)

改稿 → 零成本校验 → 满意后再进入花钱的生成环节的循环。脚手架与校验器纯本地(零网络),**不调用任何真实生成/TTS**。

```bash
# 1) 建草稿目录(零 credits):<root>/episodes/_drafts/<slug>/;--root 缺省仓库根
node tools/new-episode.js --draft my-episode --title "我的新集"
#    正式集目录:node tools/new-episode.js --episode S02E03 --title "..."

# 2) 零成本校验(零写盘/零网络);有 [ERROR] 先修,[WARN] 只提示
node tools/validate-script.js episodes/_drafts/my-episode          # 文本
node tools/validate-script.js episodes/_drafts/my-episode --json   # 结构化

# 3) 校验通过后再落 manifest(纯本地,零 credits)
node tools/validate-script.js episodes/_drafts/my-episode --build
#    若同目录有 edit.yaml,可一并生成时间线:
node tools/validate-script.js episodes/_drafts/my-episode --build --timeline

# 4) 之后才是花钱的 keyframe / video 生成
node tools/build-manifest.js episodes/_drafts/my-episode
node tools/build-timeline.js episodes/_drafts/my-episode   # 需要 edit.yaml
```

- **迭代循环**:改 `script.yaml` → `validate-script`(零 credits)→ `build-manifest` → `build-timeline` → keyframe/video(credits)。`validate-script --build` 是「先校验、后构建」的唯一入口:纯校验失败时**绝不**进入 `build-manifest`,因此坏稿不会写出 `manifest.json`。
- **credits 边界**:`validate-script`/`build-manifest`/`build-timeline` 均为零 credits;**keyframe(图)与 video(视频)生成才算钱**。keyframe 未通过前不要批量跑 video。
- **校验错误(exit 4)**:YAML 解析失败/非对象;缺 `episode`/`title`/`schema_version`/`defaults`;`scenes` 空;scene/shot id 重复或缺失;shot 缺 `style_en`/`prompt_en`;`duration` 非正整数;shot 级 `ratio` 与集级不一致且未 `allow_mixed_ratio: true`;`continue_from` self/unknown/顺序/cycle/depth;有对白但 voice 解析不到;`intent` 非法组合(含 `dialogue=false` 却有对白);`resolution`/`ratio` 不在支持集。
- **警告(不阻断)**:对白估时 > shot duration;shot 缺 `description_cn`;`duration > 30s`;`intent.dialogue=true` 但无任何对白。
- **`--json` 输出**:`{ ok, errors[], warnings[], stats:{ shots, estimated_seconds, dialogue_shots } }`。
- **E1 时机**:E1(首帧能力实验)应插在**镜头表冻结之后、批量 video 之前**;脚手架生成的 `README.md` 亦写明该提示与迭代循环。

## PRD v2.11 里程碑状态（v2.11 已冻结；附录 A1–A9 走查示例为验收基准）

| 里程碑 | 状态 |
|---|---|
| M0 §3.0 五项不变量回归（拒绝终态/任务幂等/冲突指引/原子写注入/stale callback） | ✅ 已完成（`npm test` 全绿） |
| M1 E1 统计工具链 + timeline core | E1 工具链 ✅ 代码完成（`e1-report.js`；**正式报告待真实接口实验**）；timeline core ✅ 已完成（`tools/build-timeline.js` + 回归 TL1–TL16；**最终混音/音轨集成随 M5**） |
| M2 画幅收敛 + 任务快照/attempt 事件流/三维熔断+epoch + quota 账本 + `migrate-episode` | ✅ 已完成(`migrate-episode.js` schema 1→2 + `schema_version` 意识,回归 MG1–MG14;任务/事件/熔断/quota 此前已完成);PRD 门禁要求 E1 报告存在,属超前实现 |
| M2 补充:**任务状态批次 A1/A2/A9/A10**(失败模型/状态-有效期分离/reuse_records/回调幂等/调度集合) | ✅ 已完成(回归 `A-BATCH-A1a`–`A-BATCH-A10c` + 同步更新 `D1a`/`W3d`/`B2`/`C2h`/`M0-5d`/`Q4e`;`npm test` 全绿) |
| M3 keyframe 阶段(keyframe 管道 M3a）+ 状态机 + 封面纯函数 + **A8 stage 哈希重构(M3b)** | ✅ M3a 已交付(`mark-keyframe.js`/`render-next` stage 感知/`resolveCover`;回归 MK1–MK8);✅ M3b 已交付(stage payload/refs role/keyframe digest 入 video hash/`keyframe_mode`;回归 A8a–A8g，`npm test` 全绿);首帧约束模式另需 E1 判定通过 |
| M4a 连续性 continue_from(校验三件套 + offset 帧号 canonicalize + keyframe 上游尾帧引用) | ✅ 已交付(`resolveEpisodeFps`/`secondsToFrames`/`validateContinueFrom`/`tools/tail-frame.js`/`render-next` 上游尾帧 ref;回归 M4a1–M4a5 + ffmpeg 门控抽帧;`npm test` 全绿) |
| M4b 连续动作接镜 cut_join(相邻性校验 + 截断/删帧 + CFR 标准化) | ✅ 已交付(`tools/junction.js` + `build-timeline` 接头处理;回归 M4b1–M4b7 + ffmpeg 门控接头比对;`npm test` 全绿)。bound approval record 随 M4c |
| M4c bound approval record(含 A4 clip 绑定 / junction 人工四要素) | ✅ 已交付(`tools/approvals.js` 纯函数校验 + `tools/mark-approval.js` CLI 写入;`edit-episode`/`stitch-episode --final` 统一检查;回归 M4c1–M4c6;`npm test` 全绿) |
| M5a `intent.*` 制作意图声明与配置校验(§4 硬性件;TECH-DEBT A5 声明部分) | ✅ 已交付(`tools/intent.js` 纯函数 + `build-manifest` 接线;回归 M5a1–M5a8;`npm test` 全绿);Gate 适用矩阵引擎随 M5c |
| M5b final 媒体属性探测 + 完整解码验证(TECH-DEBT A6) | ✅ 已交付(`tools/probe.js`:纯函数 `parseProbeJson`/`expectedVideoSpec`/`checkMediaSpec`/`checkAvLength` + `probeMedia`/`verifyDecode` + 编排 `verifyFinalMedia` + CLI;回归 M5b1–M5b7;`npm test` 全绿);Release Gate 接线随 M5c |
| M5c Final Release Gate 引擎 + 适用矩阵 + 导出入口接入(TECH-DEBT A5 矩阵部分) | ✅ 已交付(`tools/gate.js`:15 行 `GATE_ITEMS`(§5 编号 1..14,4 拆 4a/4b)/`reconcileQuotaLedger`/`parseSrtCues`/`evaluateReleaseGate`/`formatGateReport` + CLI;`stitch-episode --final` 接线(拼接前离线条目、拼接后 8/9)与 `--gate-strict`;`deferred` 桥接政策;回归 M5c1–M5c12;`npm test` 全绿) |
| M5-TTS TTS stage 接线(dialogue/voice/tts_hash + render-next tts 任务 + `tts.js` + 豆包 adapter;§3.4/§3.5/§3.8) | ✅ 已交付(`build-manifest` dialogue/voice/provider 解析 + fail-closed `tts_hash` + 估时预警;`render-next` tts stage + 产物级缓存 + 账本映射;`tools/tts.js` + `tools/tts-api-doubao.js`(mock 通道);回归 TTS1–TTS8;`npm test` 全绿) |
| M5-OVF 时长四量与溢出策略 + Release Gate #6 接线(§3.4,TECH-DEBT A3) | ✅ 已交付(`tools/dialogue.js` 纯函数 + `build-timeline` v2 接线(clip `dialogue`/`overflow`/`padding_frames`/`trim`/`dialogue_spill_ms`/`spill_in`);`allow_trim` 默认 false、`max_freeze_padding_frames` 默认 0;Gate #6 由 deferred 改实判;回归 OVF1–OVF7;`npm test` 全绿)。**仅决策/标记层,不跑音频** |
| M5-AUD 音轨合成(对白/sfx/music)+ 两遍 loudnorm + §3.9 输出规格 + Release Gate #10 接线(§3.4/§3.9,TECH-DEBT A3 音频层) | ✅ 已交付(`tools/audio.js`:纯函数 `dialogueSegments`/`cuePlacements`/`programDurationMs`/`planProgram`/`parseLoudnormJson`/`loudnormArgs`/`verifyLoudness` + ffmpeg 编排 `analyzeLoudness`/`buildProgramAudio`;`build-timeline` 落位 clip `sfx` 与 timeline `cues`(缺省不漂移);Gate #10 由 deferred 改实判;回归 AUD1–AUD8;`npm test` 全绿) |
| M5-SUB 字幕产物(SRT/烧录/软字幕)+ 封面帧提取 + Gate `#7`/`#11` 实跑衔接(§4) | ✅ 已交付(`tools/subtitles.js`:纯函数 `subtitleCues`/`wrapCueText`/`formatSrt`/`checkCueAlignment`/`subtitleFontChain`/`burnSubtitlesArgs`/`softSubtitlesArgs` + `writeSrt`(默认 `episode.srt`)+ `burnSubtitles`(burn/soft/both)+ CLI;`tools/cover.js` 新增 `generateCover`(keyframe/实际首帧/promo)+ CLI;Gate #11 支持 `opts.artifacts.cover`/`--cover`;回归 `SUB1`–`SUB8`;`npm test` 全绿) |
| M5-EDIT/D4 v2 帧口径最终出片(消费 `timeline.json`;D4)+ program.m4a/episode.srt/cover.png 接入 + Gate `#14` 确定性 | ✅ 已交付(`tools/render-final.js`:`clipRenderArgs` 纯函数(入点/删帧右移/`tpad` 静帧/`-frames:v` 精确帧数/CFR 链/确定性参数)+ `renderFinal`(逐 clip→concat→program 混流→字幕 soft/burn 降级→cover→`verifyFinalMedia`)+ `determinismDigests`;`tools/determinism.js` 复跑取证;`stitch-episode --final`/`edit-episode` v2 委托 + v1 秒制路径保留;**回归 `FIN1`–`FIN8`;`npm test` 全绿**) |
| M5 收尾 | ✅ D4 已交付;**仅剩 deferred 项** `#3`(E1 正式报告,实验暂停)与 `#12`(recovered/legacy 账本未初始化);字幕/封面/`#7`/`#11` ✅、音轨/loudnorm/`#10` ✅、帧口径出片/确定性 ✅ |
| DRAFT 新集草稿与零成本校验 | ✅ 已交付(`tools/new-episode.js` 脚手架 + `tools/validate-script.js` 零成本校验(零写盘/零网络/零 credits,复用 continue_from/voice/TTS 估时/intent/视频规格纯函数);`--build`/`--timeline` 先后置校验再透传;回归 `DRAFT1`–`DRAFT5`,含生产隔离;`npm test` 全绿) |

> 旧表述 M1a/M1b 已并入上表：M1a 的任务/事件/熔断/画幅归入 M2，M1b 的 E1 工具链归入 M1、quota 归入 M2。

## 依赖

- Node.js (v24 测试通过)
- `js-yaml` (已装：`npm install js-yaml --no-save`)
- ffmpeg (v8.1 测试通过)
