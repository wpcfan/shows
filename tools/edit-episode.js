#!/usr/bin/env node
/**
 * edit-episode.js — edit.yaml 驱动的正式剪辑工具
 *
 * V2.2 改进:
 *   - 正式导出前 verifyManifestFreshness():manifest 必须与当前 script.yaml 一致
 *   - 校验 timeline 引用的 take 本身(不是 shot 级别):
 *     take.status 必须 selected,take.input_hash 必须匹配当前 input_hash(或有 human_review accept)
 *   - take_id 必填(不再 fallback 到 selected_take)
 *   - 必需镜头覆盖:manifest 中所有 shot 必须在 timeline 中(或显式 skip)
 *   - 音频:有 audio 配置时拒绝(未实现)
 *   - resolution: 标准尺寸 + 偶数约束
 *   - ffmpeg/ffprobe 通过 execFileSync 参数数组调用(不拼接 shell 字符串);
 *     in_point/out_point 必须是有限非负数
 *
 * 用法:
 *   node tools/edit-episode.js <episode-dir> [--out <path>] [--spec <delivery-name>]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { execFileSync } = require('child_process');
const { verifyManifestFreshness, readJsonFile } = require('./build-manifest');
const { checkApprovalsForEpisode } = require('./approvals');
const { renderFinal, detectRenderMode } = require('./render-final');
const { collectGateReport, formatGateReport, gateExitCode } = require('./gate');

const ROOT = path.resolve(__dirname, '..');

function run(prog, argv, opts = {}) {
  console.log(`$ ${[prog, ...argv].join(' ')}`);
  return execFileSync(prog, argv, { stdio: 'pipe', encoding: 'utf8', ...opts });
}

function ffprobeDuration(file) {
  try {
    const out = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file],
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }
    );
    return parseFloat(out.trim()) || 0;
  } catch { return 0; }
}

/**
 * 纯函数(读 <episode-dir>/timeline.json):bound approval record problems(PRD §3.3/§5 Gate #4b/#13)。
 * timeline.json 缺失 → 返回 [](跳过,M5 再强制);供测试与 main 复用。
 * @returns {string[]}
 */
function collectEditApprovalProblems(absEpDir, manifest) {
  return checkApprovalsForEpisode(absEpDir, manifest).problems;
}

/**
 * 校验时间点:必须是有限非负数。
 * 防止把 YAML 里的字符串(如 '0; touch /tmp/pwn')当 shell 片段传入。
 */
function validateTimePoint(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * 按 ffmpeg concat demuxer 规则转义路径:用单引号包裹,内部 ' 写作 '\''
 */
function escapeConcatPath(p) {
  const s = String(p);
  if (/[\r\n]/.test(s)) throw new Error(`invalid concat path (contains newline): ${JSON.stringify(s)}`);
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * blocked(熔断终态)的镜头不得进正式成片(PRD Release Gate #4)。
 * @returns {string[]} 错误列表(空 = 通过)
 */
function collectBlockedShotErrors(manifest) {
  const blocked = ((manifest && manifest.shots) || []).filter(s => s && s.status === 'blocked');
  return blocked.map(s => `${s.id}: blocked (${s.blocked_reason || 'circuit breaker'}) — resolve the failure and run: node tools/mark-shot.js <episode-dir> ${s.id} --unblock`);
}

/**
 * 根据 resolution + ratio 返回标准像素尺寸(偶数)
 * "p" = 短边像素数;长边 = p * 长短比,四舍五入到偶数
 */
function resolutionToSize(res, ratio) {
  const p = res === '1080p' ? 1080 : res === '480p' ? 480 : 720;
  let w, h;
  switch (ratio) {
    case '9:16': w = p; h = Math.round(p * 16 / 9); break;
    case '3:4': w = p; h = Math.round(p * 4 / 3); break;
    case '1:1': w = p; h = p; break;
    case '4:3': h = p; w = Math.round(p * 4 / 3); break;
    default: h = p; w = Math.round(p * 16 / 9); break; // 16:9
  }
  // 确保偶数(yuv420p 要求)
  w = w - (w % 2);
  h = h - (h % 2);
  return [w, h];
}

/**
 * 从 manifest shot + timeline entry 精确获取 take
 * take_id 必填,不 fallback
 */
function getTakeByTimelineEntry(shot, entry) {
  const takes = shot.takes || [];
  if (!entry.take_id) {
    throw new Error(`${entry.shot_id} timeline must specify take_id (no fallback for final edit)`);
  }
  const take = takes.find(t => t.id === entry.take_id);
  if (!take) {
    throw new Error(`${entry.shot_id}/${entry.take_id} not found (available: ${takes.map(t => t.id).join(', ') || 'none'})`);
  }
  return take;
}

/**
 * 校验 take 本身的审核状态和输入匹配
 * 设计:审核结论(human_review)与选片指针(selected_take)分离。
 * 时间线显式声明的 take_id 即为授权使用;只要该 take 未被拒绝且输入版本一致即可导出,
 * 不要求它同时是当前默认选片指针(旧时间线可重新导出)。
 */
function validateTake(shot, take) {
  // 1. 终态:被拒绝(显式 reject 或人工审核 reject)→ 禁止导出
  if (take.status === 'rejected') {
    throw new Error(`${shot.id}/${take.id} status is 'rejected' — cannot use in final edit`);
  }
  if (take.human_review && take.human_review.conclusion === 'reject') {
    throw new Error(`${shot.id}/${take.id} was reviewed and rejected on ${take.human_review.reviewed_at} — cannot use in final edit`);
  }
  // 1b. superseded:旧 input_hash 的 late/stale 产物,不得自动进成片;
  //     fingerprint 复现后人工 --select 可恢复(§3.5)
  if (take.status === 'superseded') {
    throw new Error(`${shot.id}/${take.id} is superseded (stale/orphan artifact from an outdated input) — cannot use in final edit; re-select it manually only if the input fingerprint matches again`);
  }
  // 2. 人工审核通过:reviewed_input_hash 必须匹配当前 input_hash
  if (take.human_review && take.human_review.conclusion === 'accept') {
    if (take.human_review.reviewed_input_hash !== shot.input_hash) {
      throw new Error(`${shot.id}/${take.id} was reviewed against a different input hash (input changed after review)`);
    }
    // P0-1 防洗白:审核绑定必须与产物自身的 fingerprint 一致(来源未知的 null 历史素材除外),
    // 否则 superseded/orphan 产物可通过重写 reviewed_input_hash 伪装成当前版本。
    if (take.input_hash != null && take.input_hash !== take.human_review.reviewed_input_hash) {
      throw new Error(`${shot.id}/${take.id} human_review binding is inconsistent: take.input_hash=${take.input_hash} != reviewed_input_hash=${take.human_review.reviewed_input_hash} (artifact does not correspond to the reviewed input)`);
    }
    return; // review 通过且 input 未变 → OK
  }
  // 3. 无人工审核:take.input_hash 必须匹配当前 input_hash(来源未知 null → stale)
  if (take.input_hash !== shot.input_hash) {
    throw new Error(`${shot.id}/${take.id} input_hash mismatch: take was generated from ${take.input_hash || 'null'}, current is ${shot.input_hash} (input changed since generation, or source unknown — run --review to approve)`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const episodeDir = args[0];
  const outIdx = args.indexOf('--out');
  const customOut = outIdx >= 0 ? args[outIdx + 1] : null;
  const specIdx = args.indexOf('--spec');
  const specName = specIdx >= 0 ? args[specIdx + 1] : null;
  const gateStrict = args.includes('--gate-strict');

  if (!episodeDir) {
    console.error('Usage: node tools/edit-episode.js <episode-dir> [--out <path>] [--spec <delivery-name>]');
    process.exit(1);
  }
  const absEpDir = path.isAbsolute(episodeDir) ? episodeDir : path.resolve(episodeDir);

  try { run('ffmpeg', ['-version']); }
  catch { console.error('ffmpeg not found in PATH'); process.exit(2); }

  // 读取 edit.yaml
  const editPath = path.join(absEpDir, 'edit.yaml');
  let edit;
  try { edit = yaml.load(fs.readFileSync(editPath, 'utf8')); }
  catch { console.error(`edit.yaml not found in ${absEpDir}`); process.exit(2); }

  // 读取 manifest
  const manifestPath = path.join(absEpDir, 'manifest.json');
  const manifest = readJsonFile(manifestPath, { label: 'manifest.json' });

  // === 1b. 熔断镜头不得进成片(Release Gate #4) ===
  const blockedErrors = collectBlockedShotErrors(manifest);
  if (blockedErrors.length) {
    console.error(`ERROR: ${blockedErrors.length} blocked shot(s) cannot be included in the final edit:`);
    for (const e of blockedErrors) console.error(`  ${e}`);
    process.exit(4);
  }
  const shotsById = new Map();
  for (const s of (manifest.shots || [])) shotsById.set(s.id, s);

  const timeline = edit.timeline || [];
  if (timeline.length === 0) {
    console.error('edit.yaml has empty timeline');
    process.exit(3);
  }

  // === 1. manifest 新鲜度检查 ===
  console.log('checking manifest freshness...');
  const { fresh, stale_shots, structure_issues } = verifyManifestFreshness(absEpDir);
  if (!fresh) {
    if (stale_shots.length) {
      console.error(`ERROR: manifest is stale (script.yaml or reference images changed since last build): ${stale_shots.join(', ')}`);
    }
    if (structure_issues.length) {
      console.error(`ERROR: manifest structure mismatch (rebuild required):`);
      for (const si of structure_issues) console.error(`  ${si}`);
    }
    console.error('  run `node tools/build-manifest.js` to rebuild before final edit');
    process.exit(4);
  }
  console.log('  manifest is fresh');

  // === 1c. bound approval record 检查(PRD §3.3/§5 Gate #4b/#13) ===
  // timeline.json 存在则校验;缺失仅 WARN(M5 再强制)。
  const approvalCheck = checkApprovalsForEpisode(absEpDir, manifest);
  if (approvalCheck.warning) {
    console.warn(`WARN: ${approvalCheck.warning}`);
  } else if (approvalCheck.problems.length) {
    console.error(`ERROR: ${approvalCheck.problems.length} bound approval problem(s) (PRD §3.3; Release Gate #4b/#13):`);
    for (const p of approvalCheck.problems) console.error(`  ${p}`);
    console.error('  re-confirm the junction with: node tools/mark-approval.js <episode-dir> --kind junction_review ...');
    process.exit(4);
  }

  // M5-EDIT/D4：v2（schema≥2 且有 timeline.json）委托帧口径 renderFinal；否则走既有秒制路径。
  const renderMode = detectRenderMode({ absEpDir, manifest });
  console.log(renderMode.modeLine);
  if (renderMode.mode === 'v2') {
    const clipsTimeline = readJsonFile(renderMode.timelinePath, { label: 'timeline.json' });
    // FIX5a:委托 renderFinal 前先跑与 `stitch-episode --final` 完全相同的离线 Release Gate，
    // 防止人工审核拒绝 / superseded / hash 失配 / blocked 的素材绕过 renderFinal 的 pre-flight。
    const offlineGate = collectGateReport(absEpDir, manifest, { timeline: clipsTimeline, phase: 'offline' });
    const offlineDecision = gateExitCode(offlineGate, { strict: gateStrict });
    if (offlineDecision.exitCode !== 0) {
      console.error(formatGateReport(offlineGate));
      if (offlineDecision.reason === 'deferred') {
        console.error(`ERROR: --gate-strict: Release Gate has ${offlineGate.deferred.length} deferred item(s) — refusing to render (PRD §5 full strictness)`);
      } else {
        console.error('ERROR: Release Gate failed before rendering (PRD §5).');
      }
      process.exit(4);
    }
    if (offlineGate.deferred.length) {
      console.warn(`WARN: Release Gate: NOT RELEASABLE — ${offlineGate.deferred.length} deferred item(s): ${offlineGate.deferred.map(id => `#${id}`).join(', ')}`);
      console.warn('WARN: bridging policy — deferred items do not block the exit code yet; use --gate-strict to enforce PRD §5 now');
    }
    const epBaseName = path.basename(absEpDir);
    const outDir = customOut ? path.dirname(customOut) : path.join(ROOT, 'output', epBaseName);
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = customOut || path.join(outDir, 'episode.mp4');
    let result;
    try {
      result = renderFinal({ absEpDir, manifest, timeline: clipsTimeline, outPath });
    } catch (e) {
      console.error(`ERROR: v2 timeline render failed: ${e.message}`);
      process.exit(4);
    }
    console.log(`\nEDITED: ${result.outPath}`);
    console.log(`  clips: ${result.clips}`);
    console.log(`  duration: ${result.duration_sec.toFixed(2)}s`);
    console.log(`  audio: ${result.audio ? 'yes' : 'no'}`);
    console.log(`  subtitles: ${result.subtitles || 'none'}`);
    console.log(`  cover: ${result.cover || '(skipped)'}`);
    for (const w of result.warnings) console.warn(`  WARN: ${w}`);
    return;
  }

  // === 2. 音频配置检查(未实现 → 拒绝) ===
  if (edit.audio && edit.audio.length > 0) {
    console.error('ERROR: audio pipeline not yet implemented — edit.yaml has audio tracks configured');
    console.error('  remove audio section from edit.yaml or wait for audio support');
    process.exit(4);
  }

  // === 3. 必需镜头覆盖检查 ===
  const timelineShotIds = new Set(timeline.map(e => e.shot_id));
  const skipped = edit.skip_shots || [];
  const skippedSet = new Set(skipped);
  const missing = [];
  for (const s of (manifest.shots || [])) {
    if (!timelineShotIds.has(s.id) && !skippedSet.has(s.id)) {
      missing.push(s.id);
    }
  }
  if (missing.length) {
    console.error(`ERROR: ${missing.length} shot(s) not in timeline and not in skip_shots:`);
    console.error(`  ${missing.join(', ')}`);
    console.error('  add them to timeline, or list in skip_shots with a reason');
    process.exit(4);
  }

  // === 4. 逐个校验 timeline 条目 ===
  console.log('pre-flight validation...');
  for (const entry of timeline) {
    const shot = shotsById.get(entry.shot_id);
    if (!shot) {
      console.error(`ERROR: ${entry.shot_id} not found in manifest`);
      process.exit(5);
    }
    const take = getTakeByTimelineEntry(shot, entry); // 必须有 take_id
    if (!take.path || !fs.existsSync(take.path)) {
      console.error(`ERROR: ${entry.shot_id}/${take.id} file missing: ${take.path || '(null)'}`);
      process.exit(5);
    }
    validateTake(shot, take); // take 状态 + input_hash 校验
    console.log(`  OK: ${entry.shot_id}/${take.id}`);
  }

  // === 5. 裁切入出点 + 拼接 ===
  const tmpDir = path.join(absEpDir, '.tmp-edit');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const outputSpec = edit.output || {};
  const targetRes = outputSpec.resolution || '720p';
  const targetRatio = outputSpec.ratio || '16:9';
  const targetFps = outputSpec.fps || 30;
  const [tw, th] = resolutionToSize(targetRes, targetRatio);

  const clipFiles = [];
  for (let i = 0; i < timeline.length; i++) {
    const entry = timeline[i];
    const shot = shotsById.get(entry.shot_id);
    const take = getTakeByTimelineEntry(shot, entry);

    const dur = ffprobeDuration(take.path);
    const rawIn = (entry.in_point === undefined || entry.in_point === null) ? 0 : entry.in_point;
    const rawOut = (entry.out_point === undefined || entry.out_point === null) ? dur : entry.out_point;
    try {
      validateTimePoint(rawIn, `${entry.shot_id}.in_point`);
      validateTimePoint(rawOut, `${entry.shot_id}.out_point`);
    } catch (e) {
      console.error(`ERROR: ${e.message}`);
      process.exit(6);
    }
    const inPt = rawIn;
    const outPt = rawOut;
    if (outPt > dur + 0.1) {
      console.error(`ERROR: ${entry.shot_id}/${take.id} out_point ${outPt}s exceeds take duration ${dur.toFixed(2)}s`);
      process.exit(6);
    }
    const clipDur = outPt - inPt;
    if (clipDur <= 0) {
      console.error(`ERROR: ${entry.shot_id}/${take.id} in_point >= out_point (${inPt} >= ${outPt})`);
      process.exit(6);
    }

    console.log(`  ${entry.shot_id}/${take.id}: ${inPt}s–${outPt}s (${clipDur.toFixed(2)}s)`);
    const dst = path.join(tmpDir, `clip-${String(i).padStart(3, '0')}.mp4`);
    run('ffmpeg', [
      '-y', '-ss', String(inPt), '-i', take.path, '-t', String(clipDur),
      '-vf', `scale=${tw}:${th}:force_original_aspect_ratio=decrease,pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2:black,fps=${targetFps}`,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-c:a', 'aac', '-b:a', '128k',
      '-sn', '-movflags', '+faststart', dst
    ]);
    clipFiles.push(dst);
  }

  if (clipFiles.length === 0) {
    console.error('no clips produced');
    process.exit(7);
  }

  // concat
  const listFile = path.join(tmpDir, 'concat-list.txt');
  fs.writeFileSync(listFile, clipFiles.map(f => `file ${escapeConcatPath(f)}`).join('\n'));

  const epBaseName = path.basename(absEpDir);
  const outDir = customOut ? path.dirname(customOut) : path.join(ROOT, 'output', epBaseName);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = customOut || path.join(outDir, 'episode.mp4');

  run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outPath]);

  const totalDur = clipFiles.reduce((sum, f) => sum + ffprobeDuration(f), 0);
  const finalDur = ffprobeDuration(outPath);
  console.log(`\nEDITED: ${outPath}`);
  console.log(`  clips: ${clipFiles.length}`);
  console.log(`  sum of clip durations: ${totalDur.toFixed(2)}s`);
  console.log(`  final duration: ${finalDur.toFixed(2)}s`);
  console.log(`  resolution: ${tw}x${th} @ ${targetFps}fps (${targetRes} ${targetRatio})`);

  // 多规格交付
  const deliveries = edit.delivery || [];
  for (const del of deliveries) {
    if (specName && del.name !== specName) continue;
    const [dw, dh] = resolutionToSize(del.resolution || targetRes, del.ratio || targetRatio);
    const delPath = path.join(outDir, `episode-${del.name}.mp4`);
    console.log(`\n  delivery: ${del.name} (${del.ratio || targetRatio} ${del.resolution || targetRes} → ${dw}x${dh})`);
    run('ffmpeg', [
      '-y', '-i', outPath,
      '-vf', `scale=${dw}:${dh}:force_original_aspect_ratio=decrease,pad=${dw}:${dh}:(ow-iw)/2:(oh-ih)/2:black`,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-c:a', 'aac', '-b:a', '128k', delPath
    ]);
    console.log(`  → ${delPath}`);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

module.exports = { validateTake, getTakeByTimelineEntry, resolutionToSize, validateTimePoint, escapeConcatPath, collectBlockedShotErrors, collectEditApprovalProblems };

if (require.main === module) {
  main();
}
