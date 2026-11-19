'use strict';
// Re-signs the packaged Mac app with a stable local certificate so macOS keeps
// Screen Recording permission across rebuilds. Ad hoc signatures identify the
// app by a per-build hash, which silently invalidates the permission.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const IDENTITY = process.env.OPENCLUELY_SIGN_IDENTITY || 'OpenCluely Local Signing';

exports.default = async context => {
  if (context.electronPlatformName !== 'darwin') return;
  const found = spawnSync('/usr/bin/security', ['find-identity', '-p', 'codesigning'], { encoding: 'utf8' });
  if (!found.stdout.includes(`"${IDENTITY}"`)) {
    console.log(`  • local signing identity "${IDENTITY}" not found; keeping the ad hoc signature`);
    return;
  }
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const entitlements = path.join(__dirname, '..', 'build', 'entitlements.mac.plist');
  const signed = spawnSync('/usr/bin/codesign', ['--force', '--sign', IDENTITY, '--options', 'runtime', '--entitlements', entitlements, app], { stdio: 'inherit', timeout: 120000 });
  if (signed.status !== 0) throw new Error(`codesign with "${IDENTITY}" failed`);
  console.log(`  • signed with stable local identity "${IDENTITY}"`);
};
