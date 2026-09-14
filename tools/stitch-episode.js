#!/usr/bin/env node
/**
 * stitch-episode.js — ffmpeg concat 拼接成 episode.mp4 / episode-preview.mp4
 *
 * 用法:
 *   node tools/stitch-episode.js <episode-dir> [--preview|--final] [--out <path>] [--gate-strict]
 *
 * --preview (默认): 拼接所有 done 镜头,警告 stale/pending/缺失,输出 episode-preview.mp4
 *   - 也会调用 verifyManifestFreshness(),对 structure_issues 输出 WARN(不阻塞)
 * --final: 要求所有镜头 done 且无 stale,否则报错列缺失项;输出 episode.mp4
 *   - 阻塞式新鲜度检查 + 对每个 done shot 复用 edit-episode 的 validateTake()
 *     (reject 优先 / review accept 需 reviewed_input_hash 匹配 / 无 review 需 take.input_hash 匹配)
 *   - §5 Release Gate(M5c):拼接前跑可离线条目,拼接后跑媒体条目(8/9);fail → 打印报告并 exit 4;
 *     deferred → 打印 NOT RELEASABLE 但退出 0(桥接期),--gate-strict 时 deferred 也 exit 4
 *
 * 流程:
 *   1. 读取 manifest.json,取可用 shot (按 id 顺序)
 *   2. 每个 shot 先 normalize (统一 1280x720, 30fps, libx264, aac, fast preset)
 *   3. 用 ffmpeg concat demuxer 拼接
 *   4. 输出到 output/<episode-dir-basename>/episode[-preview].mp4
 *
 * V2.3: 不再用 shell 字符串拼接命令(execFileSync + 参数数组),避免命令注入;
 *       concat list 路径按 ffmpeg concat demuxer 规则转义。
 *
 * 依赖:ffmpeg 必须在 PATH 里。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { readJsonFile } = require('./build-manifest');
const { validateTake, escapeConcatPath } = require('./edit-episode');
const { checkApprovalsForEpisode } = require('./approvals');
const { schemaFinalNotice } = require('./migrate-episode');
const { collectGateReport, formatGateReport, gateExitCode } = require('./gate');
const { renderFinal, detectRenderMode } = require('./render-final');

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

/** 从 shot 获取视频路径:优先 selected_take,回退 output_path */
function getShotPath(shot) {
  if (shot.selected_take && shot.takes) {
    const take = shot.takes.find(t => t.id === shot.selected_take);
    if (take && take.path) return take.path;
  }
  return shot.output_path || null;
}

/**
 * 纯函数:收集 --final 拼接前的 take 校验错误(不依赖 ffmpeg,可单测)。
 * 对每个 done shot 解析其 selected_take,复用 validateTake() 的权威判定;
 * 不存在的 take / 文件缺失也作为错误返回。
 * @returns {string[]} 错误信息数组(空表示可拼接)
 */
function collectFinalValidationErrors(manifest) {
  const errors = [];
  for (const shot of (manifest.shots || [])) {
    if (shot.status !== 'done') continue;
    const take = shot.selected_take
      ? (shot.takes || []).find(t => t.id === shot.selected_take)
      : null;
    if (!take) {
      errors.push(`${shot.id}: selected_take ${shot.selected_take || '(null)'} not found in takes`);
      continue;
    }
    if (!take.path || !fs.existsSync(take.path)) {
      errors.push(`${shot.id}/${take.id}: file missing: ${take.path || '(null)'}`);
      continue;
    }
    try {
      validateTake(shot, take);
    } catch (e) {
      errors.push(`${shot.id}/${take.id}: ${e.message}`);
    }
  }
  return errors;
}

/**
 * 纯函数:--final 前的 shot 级阻塞问题(不依赖 ffmpeg,可单测)。
 * blocked 的 shot 必须列出:熔断未解除前不得出正式片。
 * @returns {string[]}
 */
function collectFinalShotProblems(manifest) {
  const allShots = manifest.shots || [];
  const problems = [];
  const staleShots = allShots.filter(s => s.status === 'stale');
  const pendingShots = allShots.filter(s => s.status === 'pending' || s.status === 'rendering');
  const failedShots = allShots.filter(s => s.status === 'failed');
  const blockedShots = allShots.filter(s => s.status === 'blocked');
  if (staleShots.length) problems.push(`${staleShots.length} stale: ${staleShots.map(s => s.id).join(', ')}`);
  if (pendingShots.length) problems.push(`${pendingShots.length} pending: ${pendingShots.map(s => s.id).join(', ')}`);
  if (failedShots.length) problems.push(`${failedShots.length} failed: ${failedShots.map(s => s.id).join(', ')}`);
  if (blockedShots.length) problems.push(`${blockedShots.length} blocked (circuit breaker; run mark-shot --unblock after fixing): ${blockedShots.map(s => s.id).join(', ')}`);
  return problems;
}

/**
 * 纯函数(读 <episode-dir>/timeline.json):--final 前 bound approval record problems
 * (PRD §3.3/§5 Gate #4b/#13)。timeline.json 缺失 → [](跳过,M5 再强制)。
 * @returns {string[]}
 */
function collectFinalApprovalProblems(absEpDir, manifest) {
  return checkApprovalsForEpisode(absEpDir, manifest).problems;
}

function main() {
  const args = process.argv.slice(2);
  const episodeDir = args[0];
  const isFinal = args.includes('--final');
  const isPreview = args.includes('--preview') || !isFinal;
  const gateStrict = args.includes('--gate-strict');
  const outIdx = args.indexOf('--out');
  const customOut = outIdx >= 0 ? args[outIdx + 1] : null;
  if (!episodeDir) {
    console.error('Usage: node tools/stitch-episode.js <episode-dir> [--preview|--final] [--out <path>] [--gate-strict]');
    return 1;
  }
  const absEpDir = path.isAbsolute(episodeDir) ? episodeDir : path.resolve(episodeDir);

  // 检查 ffmpeg
  try { run('ffmpeg', ['-version']); }
  catch { console.error('ffmpeg not found in PATH'); return 2; }

  const manifestPath = path.join(absEpDir, 'manifest.json');
  const manifest = readJsonFile(manifestPath, { label: 'manifest.json' });

  // 模式说明（写死文案；v2 帧口径仅在 --final 生效，--preview 保持既有行为）
  const renderMode = detectRenderMode({ absEpDir, manifest });
  if (isFinal) console.log(renderMode.modeLine);

  // 统计状态
  const allShots = manifest.shots || [];
  const doneShots = allShots.filter(s => s.status === 'done');
  const staleShots = allShots.filter(s => s.status === 'stale');
  const pendingShots = allShots.filter(s => s.status === 'pending' || s.status === 'rendering');
  const failedShots = allShots.filter(s => s.status === 'failed');
  const blockedShots = allShots.filter(s => s.status === 'blocked');

  // --final: 要求全部 done 且无 stale/blocked
  if (isFinal) {
    const problems = collectFinalShotProblems(manifest);
    if (problems.length) {
      console.error(`ERROR: --final requires all shots done, but found:\n  ${problems.join('\n  ')}`);
      return 3;
    }
    // manifest 新鲜度检查(阻塞)
    const { verifyManifestFreshness } = require('./build-manifest');
    const { fresh, stale_shots, structure_issues } = verifyManifestFreshness(absEpDir);
    if (!fresh) {
      if (stale_shots.length) console.error(`ERROR: manifest is stale (script.yaml or references changed): ${stale_shots.join(', ')}`);
      if (structure_issues.length) {
        console.error(`ERROR: manifest structure mismatch (rebuild required):`);
        for (const si of structure_issues) console.error(`  ${si}`);
      }
      console.error('  run `node tools/build-manifest.js` to rebuild before final stitch');
      return 3;
    }
    // 复用 edit-episode 的 validateTake():与正式导出得到同一结论
    const validationErrors = collectFinalValidationErrors(manifest);
    if (validationErrors.length) {
      console.error(`ERROR: --final but ${validationErrors.length} take(s) failed validation (same rules as edit-episode):`);
      for (const e of validationErrors) console.error(`  ${e}`);
      return 4;
    }
    // §3.3/§5 Gate #4b/#13:bound approval record 统一检查(所有导出入口)
    const approvalCheck = checkApprovalsForEpisode(absEpDir, manifest);
    if (approvalCheck.warning) {
      console.warn(`WARN: ${approvalCheck.warning}`);
    } else if (approvalCheck.problems.length) {
      console.error(`ERROR: --final but ${approvalCheck.problems.length} bound approval problem(s) (PRD §3.3; Release Gate #4b/#13):`);
      for (const p of approvalCheck.problems) console.error(`  ${p}`);
      return 4;
    }

    // §5 M5c:拼接前先跑可离线条目(4a/4b/5/6/7/10/11/12/13/3);fail → 阻断,fail 前不跑 ffmpeg。
    const offlineGate = collectGateReport(absEpDir, manifest, { phase: 'offline' });
    const offlineDecision = gateExitCode(offlineGate, { strict: gateStrict });
    if (offlineDecision.exitCode !== 0) {
      console.error(formatGateReport(offlineGate));
      if (offlineDecision.reason === 'deferred') {
        console.error(`ERROR: --gate-strict: Release Gate has ${offlineGate.deferred.length} deferred item(s) — refusing to stitch (PRD §5 full strictness)`);
      } else {
        console.error('ERROR: Release Gate failed before stitching (PRD §5).');
      }
      return 4;
    }
    if (offlineGate.deferred.length) {
      console.warn(`WARN: Release Gate: NOT RELEASABLE — ${offlineGate.deferred.length} deferred item(s): ${offlineGate.deferred.map(id => `#${id}`).join(', ')}`);
    }

    // M5-EDIT/D4：v2（schema≥2 且有 timeline.json）委托帧口径 renderFinal；否则走既有秒制路径。
    if (renderMode.mode === 'v2') {
      const timeline = readJsonFile(renderMode.timelinePath, { label: 'timeline.json' });
      const epBaseName = path.basename(absEpDir);
      const outDir = customOut ? path.dirname(customOut) : path.join(ROOT, 'output', epBaseName);
      fs.mkdirSync(outDir, { recursive: true });
      const outPath = customOut || path.join(outDir, 'episode.mp4');

      let result;
      try {
        result = renderFinal({ absEpDir, manifest, timeline, outPath });
      } catch (e) {
        console.error(`ERROR: v2 timeline render failed: ${e.message}`);
        return 4;
      }

      console.log(`\nRENDERED: ${result.outPath}`);
      console.log(`  clips: ${result.clips}`);
      console.log(`  duration: ${result.duration_sec.toFixed(2)}s`);
      console.log(`  audio: ${result.audio ? 'yes' : 'no'}`);
      console.log(`  subtitles: ${result.subtitles || 'none'}`);
      console.log(`  cover: ${result.cover || '(skipped)'}`);
      for (const w of result.warnings) console.warn(`  WARN: ${w}`);

      // 媒体 Gate（#8/#9，复用 renderFinal 已完成的 probe/decode 结果，避免重复探测）
      const gateResult = collectGateReport(absEpDir, manifest, { finalPath: outPath, mediaResult: result.mediaResult });
      const decision = gateExitCode(gateResult, { strict: gateStrict });
      if (decision.exitCode !== 0) {
        console.error(formatGateReport(gateResult));
        if (decision.reason === 'deferred') {
          console.error(`ERROR: --gate-strict: Release Gate has ${gateResult.deferred.length} deferred item(s) — not releasable (PRD §5)`);
        } else {
          console.error('ERROR: Release Gate failed after stitching (PRD §5).');
        }
        return 4;
      }
      if (gateResult.deferred.length) {
        console.warn(`WARN: Release Gate: NOT RELEASABLE — ${gateResult.deferred.length} deferred item(s): ${gateResult.deferred.map(id => `#${id}`).join(', ')}`);
        console.warn('WARN: bridging policy — deferred items do not block --final exit code yet; use --gate-strict to enforce PRD §5 now');
      } else {
        console.log('Release Gate: OK');
      }
      return;
    }
  } else {
    // --preview: 结构问题只告警,不阻塞
    try {
      const { verifyManifestFreshness } = require('./build-manifest');
      const { structure_issues } = verifyManifestFreshness(absEpDir);
      if (structure_issues.length) {
        console.warn(`WARN: manifest structure mismatch (preview may reflect an old script):`);
        for (const si of structure_issues) console.warn(`  ${si}`);
      }
    } catch (e) {
      console.warn(`WARN: preview freshness check skipped: ${e.message}`);
    }
  }

  // --preview: 警告缺失
  if (isPreview) {
    if (staleShots.length) console.warn(`WARN: ${staleShots.length} stale shots (inputs changed, video may not match): ${staleShots.map(s => s.id).join(', ')}`);
    if (pendingShots.length) console.warn(`WARN: ${pendingShots.length} pending/rendering shots (skipped): ${pendingShots.map(s => s.id).join(', ')}`);
    if (failedShots.length) console.warn(`WARN: ${failedShots.length} failed shots (skipped): ${failedShots.map(s => s.id).join(', ')}`);
    if (blockedShots.length) console.warn(`WARN: ${blockedShots.length} blocked shots (circuit breaker, skipped): ${blockedShots.map(s => s.id).join(', ')}`);
    // §3.3/§5 Gate #4b/#13:--preview 只 WARN,不阻塞
    const approvalCheck = checkApprovalsForEpisode(absEpDir, manifest);
    if (approvalCheck.warning) console.warn(`WARN: ${approvalCheck.warning}`);
    for (const p of approvalCheck.problems) console.warn(`WARN: bound approval: ${p}`);
  }

  if (doneShots.length === 0) {
    console.error('no done shots to stitch');
    return 3;
  }

  // §6:--final 只读 schema_version,v1 集按 v1 语义出片并提示(不自动升级;--preview 不提示)
  if (isFinal) {
    const notice = schemaFinalNotice(manifest);
    if (notice) console.log(notice);
  }

  console.log(`stitching ${doneShots.length}/${allShots.length} shots (${isFinal ? 'FINAL' : 'PREVIEW'})...`);

  // 1. normalize 每个 shot 到临时目录
  const tmpDir = path.join(absEpDir, '.tmp-stitch');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const normalizedFiles = [];
  for (const shot of doneShots) {
    const src = getShotPath(shot);
    if (!src || !fs.existsSync(src)) {
      // preview 模式:警告跳过;final 模式:上面已拦截,不会到这里
      console.warn(`  warn: ${shot.id} video missing: ${src || '(null)'}, skip`);
      continue;
    }
    const dst = path.join(tmpDir, `${shot.id}.mp4`);
    run('ffmpeg', [
      '-y', '-i', src,
      '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,fps=30',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
      '-c:a', 'aac', '-b:a', '128k',
      '-sn', '-movflags', '+faststart', dst
    ]);
    normalizedFiles.push({ shot, dst });
  }

  if (normalizedFiles.length === 0) {
    console.error('no normalized files produced');
    return 4;
  }

  // 2. concat demuxer
  const listFile = path.join(tmpDir, 'concat-list.txt');
  fs.writeFileSync(listFile, normalizedFiles.map(f => `file ${escapeConcatPath(f.dst)}`).join('\n'));

  const epBaseName = path.basename(absEpDir);
  const outFileName = isFinal ? 'episode.mp4' : 'episode-preview.mp4';
  const outDir = customOut ? path.dirname(customOut) : path.join(ROOT, 'output', epBaseName);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = customOut || path.join(outDir, outFileName);

  run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outPath]);

  // 3. 报告 + §5 Release Gate(拼接后跑 8/9,复用同一次 probe)
  const gateResult = isFinal
    ? collectGateReport(absEpDir, manifest, { finalPath: outPath })
    : null;
  const totalDur = normalizedFiles.reduce((sum, f) => sum + ffprobeDuration(f.dst), 0);
  const probedDur = gateResult && gateResult.probe && gateResult.probe.format
    ? gateResult.probe.format.duration : null;
  const finalDur = (typeof probedDur === 'number' && probedDur > 0) ? probedDur : ffprobeDuration(outPath);
  console.log(`\nSTITCHED: ${outPath}`);
  console.log(`  shots: ${normalizedFiles.length}/${allShots.length}`);
  console.log(`  sum of shot durations: ${totalDur.toFixed(2)}s`);
  console.log(`  final duration: ${finalDur.toFixed(2)}s`);

  if (gateResult) {
    const decision = gateExitCode(gateResult, { strict: gateStrict });
    if (decision.exitCode !== 0) {
      console.error(formatGateReport(gateResult));
      if (decision.reason === 'deferred') {
        console.error(`ERROR: --gate-strict: Release Gate has ${gateResult.deferred.length} deferred item(s) — not releasable (PRD §5)`);
      } else {
        console.error('ERROR: Release Gate failed after stitching (PRD §5).');
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return 4;
    }
    if (gateResult.deferred.length) {
      console.warn(`WARN: Release Gate: NOT RELEASABLE — ${gateResult.deferred.length} deferred item(s): ${gateResult.deferred.map(id => `#${id}`).join(', ')}`);
      console.warn('WARN: bridging policy — deferred items do not block --final exit code yet; use --gate-strict to enforce PRD §5 now');
    } else {
      console.log('Release Gate: OK');
    }
  }

  // 清理临时文件
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

module.exports = {
  collectFinalValidationErrors, collectFinalShotProblems, collectFinalApprovalProblems,
  getShotPath, schemaFinalNotice, collectGateReport, gateExitCode,
};

if (require.main === module) {
  process.exitCode = main() || 0;
}
