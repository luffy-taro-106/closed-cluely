'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const root = path.join(__dirname, '..');
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(require('electron'), args, { env, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', code => resolve(code ?? 1));
  });
}
void (async () => {
  process.exitCode = await run([root, ...process.argv.slice(2)]);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
