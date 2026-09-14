#!/usr/bin/env node
/**
 * e1-collect.js — §3.1 E1 首帧能力实验的采集 runner
 *
 * 责任边界:本工具只负责「按样本矩阵调用生成 adapter、断点续跑、记账、计算指标、
 * 输出 e1-report 可直接消费的数据集」。真实接口调用由 adapter 插件完成:
 *   module.exports = { name, generate({ sample, outPath }) }   // 可 async
 * 仓库内 `experiments/e1/adapters/mock.js` 是**确定性 mock**,仅用于端到端演练,
 * **不得作为接口能力证据**。真实实验必须提供真实 adapter 并提交预注册(--prereg)。
 *
 * 用法:
 *   node tools/e1-collect.js --config <cfg.json> [--adapter <path>] [--out <dataset.json>]
 *                            [--prereg <json>] [--limit N] [--dry-run] [--metrics-only]
 *
 * 产物(缺省在 config.output_dir 下):
 *   records.jsonl   逐样本状态(断点续跑依据)
 *   ledger.json     配额账本(requests/successes/failures + by_group;原子写)
 *   artifacts/*.mp4 生成产物
 *   dataset.json    供 tools/e1-report.js 消费的数据集
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./build-manifest');
const metrics = require('./e1-metrics');

const TOOL_NAME = 'e1-collect';
const TOOL_VERSION = '1.0.0';

/** 文件名常量 */
const RECORDS_FILE = 'records.jsonl';
const LEDGER_FILE = 'ledger.json';
const ARTIFACTS_DIR = 'artifacts';
const FRAMES_DIR = 'frames';
const DATASET_FILE = 'dataset.json';

/** 路径安全化:只保留 [A-Za-z0-9._-] */
function sanitizeId(value) {
  const s = String(value == null ? '' : value).trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'unnamed';
}

/** sample_id = <scene>__<prompt_id>__<layer>__<group>__seed-<n>(路径安全化) */
function sampleIdFor(caseObj, groupId, seed) {
  return [
    sanitizeId(caseObj.scene),
    sanitizeId(caseObj.prompt_id),
    sanitizeId(caseObj.layer),
    sanitizeId(groupId),
    `seed-${sanitizeId(seed)}`
  ].join('__');
}

/** 解析资源配置路径:优先相对 config 目录,其次相对 cwd */
function resolveAsset(p, configDir) {
  if (!p) return null;
  if (path.isAbsolute(p)) return p;
  if (configDir) {
    const rel = path.resolve(configDir, p);
    if (fs.existsSync(rel)) return rel;
  }
  const cwdRel = path.resolve(process.cwd(), p);
  if (fs.existsSync(cwdRel)) return cwdRel;
  return configDir ? path.resolve(configDir, p) : cwdRel;
}

/**
 * 样本矩阵:cases × groups × seeds(顺序确定)。
 * @param {object} config
 * @param {string} [configDir]
 * @returns {Array<object>}
 */
function buildSampleMatrix(config, configDir) {
  const groups = (config && config.groups) || [];
  const cases = (config && config.cases) || [];
  const samples = [];
  for (const c of cases) {
    if (!c || !c.scene) throw new Error('config.cases[]: each case requires "scene"');
    const seeds = Array.isArray(c.seeds) && c.seeds.length ? c.seeds : (c.seed != null ? [c.seed] : [1]);
    for (const g of groups) {
      if (!g || g.id == null) throw new Error('config.groups[]: each group requires "id"');
      for (const seed of seeds) {
        samples.push({
          sample_id: sampleIdFor(c, g.id, seed),
          group: g.id,
          params_position: g.params_position == null ? null : g.params_position,
          adapter_params: g.adapter_params && typeof g.adapter_params === 'object'
            ? JSON.parse(JSON.stringify(g.adapter_params)) : null,
          scene: c.scene,
          prompt_id: c.prompt_id,
          layer: c.layer,
          seed,
          prompt: c.prompt == null ? null : c.prompt,
          image: resolveAsset(c.image, configDir),
          duration: c.duration == null ? null : c.duration,
          ratio: c.ratio == null ? null : c.ratio,
          resolution: c.resolution == null ? null : c.resolution,
          model: c.model == null ? null : c.model
        });
      }
    }
  }
  return samples;
}

/** 计划矩阵汇总(--dry-run 打印 / 测试断言) */
function summarizePlan(samples, groupIds) {
  const byGroup = {};
  const byLayer = {};
  const byScene = {};
  for (const id of (groupIds || [])) byGroup[id] = 0;
  for (const s of samples) {
    byGroup[s.group] = (byGroup[s.group] || 0) + 1;
    byLayer[s.layer] = (byLayer[s.layer] || 0) + 1;
    byScene[s.scene] = (byScene[s.scene] || 0) + 1;
  }
  return {
    total: samples.length,
    by_group: byGroup,
    by_layer: byLayer,
    by_scene: byScene,
    sample_ids: samples.map(s => s.sample_id)
  };
}

/** 读取 records.jsonl → Map<sample_id, 最新记录>;损坏行抛错(fail-closed) */
function loadRecords(recordsPath) {
  const map = new Map();
  if (!fs.existsSync(recordsPath)) return map;
  const lines = fs.readFileSync(recordsPath, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); }
    catch (e) { throw new Error(`records.jsonl line ${i + 1} is corrupt: ${e.message}`); }
    if (rec && rec.sample_id) map.set(rec.sample_id, rec);
  }
  return map;
}

/** 追加一条记录(JSONL,append-only) */
function appendRecord(recordsPath, record) {
  fs.mkdirSync(path.dirname(path.resolve(recordsPath)), { recursive: true });
  fs.appendFileSync(recordsPath, JSON.stringify(record) + '\n');
}

/** 空账本(按 group 建桶) */
function emptyLedger(groupIds) {
  const by_group = {};
  for (const g of (groupIds || [])) by_group[g] = { requests: 0, successes: 0, failures: 0 };
  return { requests: 0, successes: 0, failures: 0, by_group, updated_at: null };
}

/** 归一化账本(补齐缺失 group/计数器) */
function normalizeLedger(raw, groupIds) {
  const led = emptyLedger(groupIds);
  if (!raw || typeof raw !== 'object') return led;
  for (const k of ['requests', 'successes', 'failures']) {
    if (typeof raw[k] === 'number' && Number.isFinite(raw[k])) led[k] = raw[k];
  }
  if (raw.by_group && typeof raw.by_group === 'object') {
    for (const g of (groupIds || [])) {
      const src = raw.by_group[g];
      if (src && typeof src === 'object') {
        for (const k of ['requests', 'successes', 'failures']) {
          if (typeof src[k] === 'number' && Number.isFinite(src[k])) led.by_group[g][k] = src[k];
        }
      }
    }
  }
  led.updated_at = raw.updated_at || null;
  return led;
}

/** 读取 ledger.json(缺失 → 空账本) */
function loadLedger(ledgerPath, groupIds) {
  if (!fs.existsSync(ledgerPath)) return emptyLedger(groupIds);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); }
  catch (e) { throw new Error(`ledger.json is corrupt: ${e.message}`); }
  return normalizeLedger(raw, groupIds);
}

/** 原子写账本 */
function saveLedger(ledgerPath, ledger) {
  ledger.updated_at = new Date().toISOString();
  atomicWriteJson(ledgerPath, ledger);
}

function bumpCounter(ledger, group, field) {
  ledger[field] = (ledger[field] || 0) + 1;
  if (!ledger.by_group) ledger.by_group = {};
  if (!ledger.by_group[group]) ledger.by_group[group] = { requests: 0, successes: 0, failures: 0 };
  ledger.by_group[group][field] = (ledger.by_group[group][field] || 0) + 1;
}

/** 加载 adapter 插件模块 */
function loadAdapter(adapterPath) {
  if (!adapterPath) throw new Error('adapter path is required (config.adapter or --adapter)');
  const resolved = path.isAbsolute(adapterPath) ? adapterPath : path.resolve(process.cwd(), adapterPath);
  if (!fs.existsSync(resolved)) throw new Error(`adapter not found: ${resolved}`);
  let mod;
  try { mod = require(resolved); }
  catch (e) { throw new Error(`cannot load adapter ${resolved}: ${e.message}`); }
  if (!mod || typeof mod.generate !== 'function') {
    throw new Error(`adapter ${resolved} must export { name, generate({ sample, outPath }) }`);
  }
  return { name: mod.name || path.basename(resolved, path.extname(resolved)), generate: mod.generate };
}

/**
 * 采集 runner(可 async;adapter.generate 允许返回 Promise)。
 * @param {object} opts
 * @param {object} opts.config            配置对象
 * @param {string} [opts.configDir]       配置目录(解析相对图片路径)
 * @param {string} [opts.adapterPath]
 * @param {{name:string, generate:function}} [opts.adapter] 已加载的 adapter(测试注入)
 * @param {object|null} [opts.preregMeta] 预注册 meta(原样合并进 dataset.meta)
 * @param {string} [opts.outputDir]
 * @param {string} [opts.outPath]
 * @param {number} [opts.limit]
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.metricsOnly]
 * @param {function} [opts.warn]
 * @returns {Promise<object>}
 */
async function runCollect(opts = {}) {
  const config = opts.config || {};
  const warn = typeof opts.warn === 'function' ? opts.warn : (m => console.warn(m));
  const configDir = opts.configDir || process.cwd();
  const outputDir = path.resolve(opts.outputDir || config.output_dir || path.join('experiments', 'e1', 'data'));
  const groupIds = ((config.groups) || []).map(g => g.id);
  const matrix = buildSampleMatrix(config, configDir);
  const plan = summarizePlan(matrix, groupIds);
  const synthetic = config.synthetic === true;

  if (opts.dryRun) {
    return { dryRun: true, plan, matrix, outputDir, synthetic };
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const recordsPath = path.join(outputDir, RECORDS_FILE);
  const ledgerPath = path.join(outputDir, LEDGER_FILE);
  const artifactsDir = path.join(outputDir, ARTIFACTS_DIR);
  const framesDir = path.join(outputDir, FRAMES_DIR);
  const records = loadRecords(recordsPath);
  const ledger = loadLedger(ledgerPath, groupIds);

  const adapter = opts.adapter || loadAdapter(opts.adapterPath || config.adapter);
  const maxAttempts = Math.max(1, Number.isFinite(config.max_retries) ? Math.floor(config.max_retries) : 2);
  const delayMs = Number.isFinite(config.delay_ms) ? config.delay_ms : 0;
  const limit = Number.isFinite(opts.limit) && opts.limit >= 0 ? opts.limit : null;

  if (!opts.metricsOnly) {
    fs.mkdirSync(artifactsDir, { recursive: true });
    let processed = 0;
    for (const sample of matrix) {
      const prev = records.get(sample.sample_id);
      if (prev && prev.status === 'done') continue;
      if (prev && prev.status === 'failed' && Number(prev.attempts || 0) >= maxAttempts) continue; // 已耗尽重试
      if (limit != null && processed >= limit) break;
      processed++;
      let attempts = prev && Number.isFinite(prev.attempts) ? prev.attempts : 0;
      const artifactPath = path.join(artifactsDir, `${sample.sample_id}.mp4`);
      while (attempts < maxAttempts) {
        attempts++;
        bumpCounter(ledger, sample.group, 'requests');
        saveLedger(ledgerPath, ledger); // 调用前记账,崩溃也不丢请求数
        let result = null;
        let err = null;
        try {
          result = await adapter.generate({ sample, outPath: artifactPath });
          if (!result || typeof result !== 'object') throw new Error('adapter.generate must return an object (e.g. { request_id })');
          if (!fs.existsSync(artifactPath)) throw new Error(`adapter did not write artifact: ${artifactPath}`);
        } catch (e) {
          err = e;
        }
        if (!err) {
          bumpCounter(ledger, sample.group, 'successes');
          records.set(sample.sample_id, {
            sample_id: sample.sample_id,
            status: 'done',
            request_id: result.request_id == null ? null : result.request_id,
            artifact_path: artifactPath,
            attempts,
            error: null,
            at: new Date().toISOString()
          });
          appendRecord(recordsPath, records.get(sample.sample_id));
          saveLedger(ledgerPath, ledger);
          break;
        }
        bumpCounter(ledger, sample.group, 'failures');
        records.set(sample.sample_id, {
          sample_id: sample.sample_id,
          status: 'failed',
          request_id: null,
          artifact_path: null,
          attempts,
          error: String((err && err.message) || err),
          at: new Date().toISOString()
        });
        appendRecord(recordsPath, records.get(sample.sample_id));
        saveLedger(ledgerPath, ledger);
        if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }

  // 计算指标并输出数据集(done 记录)
  fs.mkdirSync(framesDir, { recursive: true });
  const samplesOut = [];
  const metricMetaSamples = [];
  for (const sample of matrix) {
    const rec = records.get(sample.sample_id);
    if (!rec || rec.status !== 'done') continue;
    if (!rec.artifact_path || !fs.existsSync(rec.artifact_path)) {
      warn(`WARN: done record ${sample.sample_id} artifact missing (${rec.artifact_path || 'null'}) — skipped in dataset`);
      continue;
    }
    const m = metrics.computeSampleMetrics({
      inputImage: sample.image,
      videoPath: rec.artifact_path,
      workDir: framesDir
    });
    metricMetaSamples.push(m.metric_meta);
    samplesOut.push({
      sample_id: sample.sample_id,
      group: sample.group,
      layer: sample.layer,
      scene: sample.scene,
      prompt_id: sample.prompt_id,
      seed: sample.seed,
      ssim: m.ssim,
      phash_distance: m.phash_distance
    });
  }

  const meta = Object.assign({}, (opts.preregMeta && typeof opts.preregMeta === 'object') ? opts.preregMeta : {}, {
    collection: {
      tool: TOOL_NAME,
      adapter: adapter.name,
      collected_at: new Date().toISOString(),
      records: RECORDS_FILE
    },
    synthetic
  });
  if (!opts.preregMeta) {
    warn('WARN: --prereg not provided — dataset.meta has NO preregistration fields; tools/e1-report.js will REFUSE to produce a verdict (exit 2). Provide --prereg for any real E1 run.');
  }

  const dataset = { meta, samples: samplesOut };
  const datasetPath = path.resolve(opts.outPath || path.join(outputDir, DATASET_FILE));
  atomicWriteJson(datasetPath, dataset);

  return {
    dryRun: false,
    plan,
    matrix,
    outputDir,
    recordsPath,
    ledgerPath,
    artifactsDir,
    datasetPath,
    records,
    ledger,
    dataset,
    metric_meta_samples: metricMetaSamples,
    synthetic
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') out.config = argv[++i];
    else if (a === '--adapter') out.adapter = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--prereg') out.prereg = argv[++i];
    else if (a === '--limit') out.limit = parseInt(argv[++i], 10);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--metrics-only') out.metricsOnly = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function usage() {
  console.log([
    `Usage: node tools/${TOOL_NAME}.js --config <cfg.json> [options]`,
    '',
    'Options:',
    '  --adapter <path>   覆盖 config.adapter',
    '  --out <path>       数据集输出路径(缺省 <output_dir>/dataset.json)',
    '  --prereg <json>    预注册文件(原样合并其 meta;缺失则 WARN,e1-report 将拒绝)',
    '  --limit N          只跑前 N 个未完成样本(演练用)',
    '  --dry-run          只打印计划矩阵与数量,不调用 adapter、不写任何产物',
    '  --metrics-only     不生成,只对已有 done 记录重算指标并输出数据集'
  ].join('\n'));
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(`ERROR: ${e.message}`); process.exit(1); }
  if (args.help || !args.config) { usage(); process.exit(args.help ? 0 : 1); }

  const configPath = path.resolve(args.config);
  let config;
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch (e) { console.error(`ERROR: cannot read config ${configPath}: ${e.message}`); process.exit(3); }
  const configDir = path.dirname(configPath);

  let preregMeta = null;
  if (args.prereg) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.resolve(args.prereg), 'utf8'));
      preregMeta = raw && typeof raw === 'object' ? (raw.meta || null) : null;
      if (!preregMeta) console.warn(`WARN: ${args.prereg} has no "meta" object — ignored`);
    } catch (e) {
      console.error(`ERROR: cannot read prereg ${args.prereg}: ${e.message}`);
      process.exit(3);
    }
  }

  try {
    const result = await runCollect({
      config,
      configDir,
      adapterPath: args.adapter || config.adapter,
      preregMeta,
      outPath: args.out,
      limit: args.limit,
      dryRun: args.dryRun,
      metricsOnly: args.metricsOnly
    });
    if (result.dryRun) {
      console.log('DRY-RUN: no adapter calls, no records/artifacts written.');
      console.log(`output_dir: ${result.outputDir}`);
      console.log(`adapter: ${path.resolve(process.cwd(), config.adapter || '')}`);
      console.log(`synthetic: ${result.synthetic}`);
      console.log(`planned samples: ${result.plan.total}`);
      console.log(`  by_group: ${JSON.stringify(result.plan.by_group)}`);
      console.log(`  by_layer: ${JSON.stringify(result.plan.by_layer)}`);
      console.log(`  by_scene: ${JSON.stringify(result.plan.by_scene)}`);
      console.log('sample matrix:');
      for (const id of result.plan.sample_ids) console.log(`  ${id}`);
      process.exit(0);
    }
    const done = result.dataset.samples.length;
    const failed = [...result.records.values()].filter(r => r.status === 'failed').length;
    console.log(`dataset written: ${result.datasetPath}`);
    console.log(`  samples(done): ${done}, failed(no artifact): ${failed}`);
    console.log(`  ledger: ${JSON.stringify({ requests: result.ledger.requests, successes: result.ledger.successes, failures: result.ledger.failures })}`);
    console.log(`  records: ${result.recordsPath}`);
    console.log(`  synthetic: ${result.synthetic}` + (result.synthetic ? ' (mock/demo only — NOT interface-capability evidence)' : ''));
    process.exit(0);
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(3);
  }
}

module.exports = {
  TOOL_NAME,
  TOOL_VERSION,
  RECORDS_FILE,
  LEDGER_FILE,
  ARTIFACTS_DIR,
  DATASET_FILE,
  sanitizeId,
  sampleIdFor,
  resolveAsset,
  buildSampleMatrix,
  summarizePlan,
  loadRecords,
  appendRecord,
  emptyLedger,
  normalizeLedger,
  loadLedger,
  saveLedger,
  loadAdapter,
  runCollect,
  parseArgs
};

if (require.main === module) {
  main();
}
