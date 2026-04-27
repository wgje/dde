#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const binDir = path.join(projectRoot, 'node_modules', '.bin');
const shimScriptPath = path.join(projectRoot, 'scripts', 'deno-npm-shim.cjs');

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, 'utf8');
  try {
    fs.chmodSync(filePath, 0o755);
  } catch {
    // Windows 下 chmod 可能是 no-op
  }
}

function main() {
  if (!fs.existsSync(binDir)) {
    console.log('[install-deno-command-shim] node_modules/.bin not found — skipping');
    return;
  }

  const normalizedShimPath = shimScriptPath.replace(/\\/g, '\\\\');
  const cmdPath = path.join(binDir, 'deno.cmd');
  const ps1Path = path.join(binDir, 'deno.ps1');
  const shPath = path.join(binDir, 'deno');

  writeExecutable(cmdPath, `@echo off\r\nnode "${normalizedShimPath}" %*\r\n`);
  writeExecutable(ps1Path, `#!/usr/bin/env pwsh\n& node "${shimScriptPath}" $args\nexit $LASTEXITCODE\n`);
  writeExecutable(shPath, `#!/usr/bin/env sh\nnode "${shimScriptPath}" "$@"\n`);

  console.log('[install-deno-command-shim] installed workspace deno shim into node_modules/.bin');
}

main();
