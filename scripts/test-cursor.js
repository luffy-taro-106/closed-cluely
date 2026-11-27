'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
if (process.platform !== 'darwin') {
  console.log('SKIP AppKit cursor checks: macOS only');
} else {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'closedcluely-cursor-test-'));
  const binary = path.join(temporary, 'cursor-test');
  try {
    execFileSync('xcrun', ['clang++', '-std=c++17', '-fobjc-arc',
      path.resolve(__dirname, '../tests/arrow-cursor.mm'), '-framework', 'AppKit', '-o', binary], { stdio: 'inherit', timeout: 60000 });
    execFileSync(binary, { stdio: 'inherit', timeout: 15000 });
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
