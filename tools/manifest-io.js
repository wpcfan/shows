'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function fileContentHash(absPath) {
  try {
    const buf = fs.readFileSync(absPath);
    return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

class SimulatedCrashError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SimulatedCrashError';
    this.code = 'SIMULATED_CRASH';
  }
}

class CorruptJsonError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CorruptJsonError';
    this.code = 'CORRUPT_JSON';
  }
}

function atomicWriteJson(filePath, obj, opts = {}) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  const fault = opts.fault || process.env.SHOWS_FAULT_ATOMIC_WRITE || null;
  try {
    if (fault === 'before-tmp-write') {
      throw new SimulatedCrashError(`fault injected: before-tmp-write (${filePath})`);
    }
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    if (fault === 'after-tmp-write') {
      throw new SimulatedCrashError(`fault injected: after-tmp-write (${filePath}) — simulated crash, tmp left behind`);
    }
    fs.renameSync(tmp, filePath);
  } catch (e) {
    if (!(e instanceof SimulatedCrashError)) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort cleanup */ }
    }
    throw e;
  }
}

const TMP_MAX_AGE_MS = 60 * 1000;

function defaultIsPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!(e && e.code === 'EPERM'); }
}

function parseTmpFileName(name) {
  if (!name.startsWith('.') || !name.endsWith('.tmp')) return null;
  const core = name.slice(1, -4);
  const parts = core.split('.');
  if (parts.length < 3) return null;
  const pid = Number(parts[parts.length - 2]);
  const ts = Number(parts[parts.length - 1]);
  if (!Number.isInteger(pid) || !Number.isFinite(ts)) return null;
  return { pid, ts };
}

function cleanupStaleTmpFiles(filePath, opts = {}) {
  const dir = path.dirname(filePath);
  const prefix = `.${path.basename(filePath)}.`;
  const maxAgeMs = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : TMP_MAX_AGE_MS;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const isAlive = typeof opts.isAlive === 'function' ? opts.isAlive : defaultIsPidAlive;
  const removed = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
      const full = path.join(dir, name);
      const parsed = parseTmpFileName(name);
      let ageMs = Infinity;
      try { ageMs = now - fs.statSync(full).mtimeMs; } catch { /* stat failed, keep Infinity */ }
      const alive = parsed ? isAlive(parsed.pid) : false;
      if (alive && ageMs <= maxAgeMs) continue;
      try { fs.rmSync(full, { force: true }); removed.push(name); } catch { /* best-effort cleanup */ }
    }
  } catch { /* dir unreadable, nothing to clean */ }
  return removed;
}

function readJsonFileOrNull(filePath, opts = {}) {
  const label = opts.label || path.basename(filePath);
  const cleanedTmp = cleanupStaleTmpFiles(filePath, opts.cleanup);
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return { value: null, corrupt: false, missing: true, guidance: null, cleaned_tmp: cleanedTmp };
    throw e;
  }
  try {
    return { value: JSON.parse(raw), corrupt: false, missing: false, guidance: null, cleaned_tmp: cleanedTmp };
  } catch (e) {
    return {
      value: null, corrupt: true, missing: false,
      guidance: `${label} is corrupt (invalid JSON: ${e.message}). The corrupt file is NOT used and was left untouched for inspection; recover with: node tools/build-manifest.js <episode-dir> to rebuild (takes are recoverable from catalog.json), or restore a backup.`,
      cleaned_tmp: cleanedTmp
    };
  }
}

function readJsonFile(filePath, opts = {}) {
  const r = readJsonFileOrNull(filePath, opts);
  if (r.corrupt) throw new CorruptJsonError(r.guidance);
  if (r.missing) {
    const e = new Error(`${opts.label || filePath} not found`);
    e.code = 'ENOENT';
    throw e;
  }
  return r.value;
}

function normalizeImageRef(absPath, root) {
  let rel = path.relative(root, absPath);
  if (rel.startsWith('..')) rel = absPath;
  return { path: rel, content_hash: fileContentHash(absPath) };
}

module.exports = {
  fileContentHash,
  SimulatedCrashError, CorruptJsonError,
  atomicWriteJson, TMP_MAX_AGE_MS,
  cleanupStaleTmpFiles,
  readJsonFile, readJsonFileOrNull,
  normalizeImageRef,
};
