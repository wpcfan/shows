#!/usr/bin/env node
/**
 * lock.js — 跨进程文件锁(无第三方依赖)
 *
 * 目的:为 manifest.json / catalog.json 这类「多文件一致性写入」提供串行化,
 * 避免两个 CLI 进程同时读改写导致丢更新。锁粒度是资源路径:
 *   lockPathFor(key) = key + '.lock'   (key 为绝对路径)
 *
 * 语义:
 *   - 单次获取用 fs.openSync(path, 'wx')(原子创建),写入 {pid, at};
 *   - 已存在则尝试回收 stale 锁:持锁 pid 已死(process.kill(pid, 0) 失败)或
 *     mtime 超过 staleMs(默认 60000)时删除后重试;
 *   - withLock 失败重试至 timeoutMs(默认 10000)后抛 `lock timeout`;
 *   - 多 key 按路径排序后顺序获取、逆序释放(防死锁);
 *   - finally 释放;并注册一次性 process.on('exit') 兜底,
 *     使 fn 内 process.exit() 的场景也能解锁;
 *   - 同步等待用 Atomics.wait(不引入依赖)。
 *
 * 已知限制(见 TECH-DEBT D6):锁只保证单进程内一次事务;manifest 已落盘、
 * catalog 写入前进程崩溃的窗口仍在(无事务日志不可消除)。触发并发事务需求时另立 ADR。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_STALE_MS = 60000;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_RETRY_MS = 25;

/** 资源路径 → 锁文件路径(key 为绝对路径) */
function lockPathFor(key) {
  return String(key) + '.lock';
}

/** 进程是否存活(EPERM = 存在但不属于当前用户,仍视为存活) */
function defaultIsPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!(e && e.code === 'EPERM'); }
}

/** 同步等待(Atomics.wait 不引入依赖,不忙等) */
function sleepSync(ms) {
  if (!(ms > 0)) return;
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

/**
 * 若锁文件 stale(死 pid 或超龄 mtime)则删除。
 * 内容不可解析时只按 mtime 判定(避免与「刚创建尚未写入」的写者竞态)。
 * @param {string} lockPath 锁文件绝对路径
 * @param {{staleMs?:number, isPidAlive?:function, now?:number}} [opts]
 * @returns {boolean} 是否删除
 */
function tryReclaim(lockPath, opts = {}) {
  const staleMs = Number.isFinite(opts.staleMs) ? opts.staleMs : DEFAULT_STALE_MS;
  const isAlive = typeof opts.isPidAlive === 'function' ? opts.isPidAlive : defaultIsPidAlive;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  let stat;
  try { stat = fs.statSync(lockPath); } catch { return false; }
  let pid = null;
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (raw && Number.isInteger(raw.pid)) pid = raw.pid;
  } catch { /* 半写/不可解析 → 仅按 mtime 判定 */ }
  const deadPid = pid != null && !isAlive(pid);
  const aged = (now - stat.mtimeMs) > staleMs;
  if (!deadPid && !aged) return false;
  try { fs.rmSync(lockPath, { force: true }); return true; }
  catch { return false; }
}

/**
 * 单次获取锁(不等待):以 'wx' 原子创建;已存在则回收 stale 后重试一次/直到
 * 不再 stale。返回是否成功持有。
 * @param {string} lockPath 锁文件绝对路径
 * @param {{staleMs?:number, isPidAlive?:function}} [opts]
 * @returns {boolean}
 */
function acquireLockOnce(lockPath, opts = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
    }
    if (!tryReclaim(lockPath, opts)) return false;
    // stale 已删除 → 重试获取
  }
}

/**
 * 以锁保护同步 fn。keyOrKeys 可为单个资源路径或数组;多 key 排序获取、逆序释放。
 * @param {string|string[]} keyOrKeys 资源绝对路径(锁文件 = key + '.lock')
 * @param {() => any} fn
 * @param {{timeoutMs?:number, retryMs?:number, staleMs?:number, isPidAlive?:function}} [opts]
 * @returns {any} fn 的返回值
 */
function withLock(keyOrKeys, fn, opts = {}) {
  if (typeof fn !== 'function') throw new Error('withLock requires a function');
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const retryMs = Number.isFinite(opts.retryMs) ? opts.retryMs : DEFAULT_RETRY_MS;
  const staleMs = Number.isFinite(opts.staleMs) ? opts.staleMs : DEFAULT_STALE_MS;
  const acquireOpts = { staleMs, isPidAlive: opts.isPidAlive };

  const keys = (Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys]).map(String);
  const lockPaths = [...new Set(keys.map(lockPathFor))].sort();
  const held = [];

  const releaseHeld = () => {
    while (held.length) {
      const p = held.pop(); // 逆序释放
      try { fs.rmSync(p, { force: true }); } catch { /* best effort */ }
    }
  };
  const onExit = () => { releaseHeld(); };

  // 一次性兜底:fn 内 process.exit() 时 finally 不执行,但 exit 事件可解锁
  process.on('exit', onExit);
  try {
    const deadline = Date.now() + timeoutMs;
    for (const lockPath of lockPaths) {
      for (;;) {
        if (acquireLockOnce(lockPath, acquireOpts)) {
          held.push(lockPath);
          break;
        }
        if (Date.now() >= deadline) {
          throw new Error(`lock timeout: could not acquire ${lockPath} within ${timeoutMs}ms`);
        }
        sleepSync(retryMs);
      }
    }
    return fn();
  } finally {
    process.removeListener('exit', onExit);
    releaseHeld();
  }
}

module.exports = {
  lockPathFor,
  tryReclaim,
  acquireLockOnce,
  withLock,
  DEFAULT_STALE_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RETRY_MS
};

if (require.main === module) {
  console.error('lock.js is a library module; use withLock() from another tool.');
  process.exit(1);
}
