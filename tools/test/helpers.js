'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

function throws(fn, msgSubstr) {
  let threw = false;
  try { fn(); } catch (e) { threw = true; if (msgSubstr && !e.message.includes(msgSubstr)) throw new Error(`expected error containing "${msgSubstr}", got "${e.message}"`); }
  if (!threw) throw new Error(`expected to throw${msgSubstr ? ` containing "${msgSubstr}"` : ''}, but did not`);
}

const asyncTests = [];

function testAsync(name, fn) { asyncTests.push({ name, fn }); }

async function throwsAsync(fn, msgSubstr) {
  let threw = false;
  try { await fn(); } catch (e) { threw = true; if (msgSubstr && !e.message.includes(msgSubstr)) throw new Error(`expected error containing "${msgSubstr}", got "${e.message}"`); }
  if (!threw) throw new Error(`expected to reject${msgSubstr ? ` containing "${msgSubstr}"` : ''}, but did not`);
}

function mkTempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shows-test-'));
  return d;
}

function writeManifest(dir, manifest) {
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

function readManifest(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
}

function shotBase(id, opts = {}) {
  return Object.assign({
    id, scene: 's01', description_cn: 'test',
    prompt_final_en: 'p', input_hash: 'h1', prev_hash: null,
    duration: 10, ratio: '16:9', resolution: '720p', model: 'default',
    image_paths: [], takes: [], selected_take: null,
    output_path: null, status: 'pending', rendered_at: null, error: null, retries: 0
  }, opts);
}

async function runAsyncTests() {
  for (const { name, fn } of asyncTests) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
  }
}

function getStats() { return { passed, failed }; }

module.exports = {
  test, throws, testAsync, throwsAsync,
  mkTempDir, writeManifest, readManifest, shotBase,
  runAsyncTests, getStats
};
