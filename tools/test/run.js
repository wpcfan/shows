#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { getStats, runAsyncTests } = require('./helpers');

const testFiles = fs.readdirSync(__dirname)
  .filter(f => f.endsWith('.test.js') && f !== 'regression.test.js')
  .sort();

console.log(`\nRunning ${testFiles.length} test files...\n`);

(async () => {
  for (const file of testFiles) {
    console.log(`\n[${file}]`);
    require(path.join(__dirname, file));
    await runAsyncTests();
  }

  const { passed, failed } = getStats();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
