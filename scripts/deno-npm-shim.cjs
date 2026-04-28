#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const workspaceBinDir = path.join(projectRoot, 'node_modules', '.bin');

function fail(message, details) {
  console.error(`[deno-npm-shim] ${message}`);
  if (details) {
    console.error(details);
  }
  process.exit(1);
}

function parseNpmTarget(target) {
  if (!target.startsWith('npm:')) {
    fail(`Unsupported target: ${target}`);
  }

  const spec = target.slice(4);
  const match = spec.match(/^(?<packageName>@[^/]+\/[^/@]+|[^/@][^/@]*)(?:@(?<version>[^/]+))?(?:\/(?<binName>.+))?$/);
  if (!match?.groups?.packageName) {
    fail(`Invalid npm target: ${target}`);
  }

  return {
    packageName: match.groups.packageName,
    binName: match.groups.binName ?? null,
    requested: spec,
  };
}

function getFallbackBinName(packageName) {
  return packageName.includes('/')
    ? packageName.slice(packageName.lastIndexOf('/') + 1)
    : packageName;
}

function resolveBinScript(packageName, binName) {
  const pkgJsonPath = path.join(projectRoot, 'node_modules', ...packageName.split('/'), 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    return null;
  }

  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  const fallbackBinName = getFallbackBinName(packageName);

  let binEntry = null;
  if (typeof pkg.bin === 'string') {
    binEntry = pkg.bin;
  } else if (pkg.bin && typeof pkg.bin === 'object') {
    binEntry = pkg.bin[binName] ?? pkg.bin[fallbackBinName] ?? null;
    if (!binEntry) {
      const binValues = Object.values(pkg.bin);
      if (binValues.length === 1 && typeof binValues[0] === 'string') {
        binEntry = binValues[0];
      }
    }
  }

  if (typeof binEntry !== 'string' || binEntry.length === 0) {
    fail(`Unable to resolve binary '${binName}' from package '${packageName}'`);
  }

  return path.resolve(path.dirname(pkgJsonPath), binEntry);
}

function runViaNpx(target, forwardedArgs) {
  const npxCommand = 'npx';
  const binName = target.binName ?? getFallbackBinName(target.packageName);
  const npxArgs = target.binName
    ? ['--yes', '--package', target.packageName, binName, ...forwardedArgs]
    : ['--yes', target.packageName, ...forwardedArgs];

  const result = spawnSync(npxCommand, npxArgs, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    windowsHide: false,
    shell: process.platform === 'win32',
  });

  if (result.error) {
    fail(`Failed to execute ${target.requested} via npx`, result.error.stack ?? String(result.error));
  }

  process.exit(result.status ?? 1);
}

function findRealDenoExecutable() {
  const pathValue = process.env.PATH ?? '';
  const candidates = process.platform === 'win32'
    ? ['deno.exe', 'deno.cmd', 'deno.bat', 'deno.ps1', 'deno']
    : ['deno'];

  for (const rawEntry of pathValue.split(path.delimiter)) {
    if (!rawEntry) {
      continue;
    }

    const entry = path.resolve(rawEntry);
    if (entry === path.resolve(workspaceBinDir)) {
      continue;
    }

    for (const executableName of candidates) {
      const executablePath = path.join(entry, executableName);
      if (fs.existsSync(executablePath)) {
        return executablePath;
      }
    }
  }

  return null;
}

function delegateToRealDeno(args) {
  const realDeno = findRealDenoExecutable();
  if (!realDeno) {
    return false;
  }

  const result = spawnSync(realDeno, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    windowsHide: false,
  });

  if (result.error) {
    fail(`Failed to execute real Deno via ${realDeno}`, result.error.stack ?? String(result.error));
  }

  process.exit(result.status ?? 1);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    fail('Expected arguments after deno shim invocation');
  }

  if (args[0] === '--version' || args[0] === '-V') {
    if (delegateToRealDeno(args)) {
      return;
    }
    console.log('deno 0.0.0-shim');
    return;
  }

  if (args[0] !== 'run') {
    if (delegateToRealDeno(args)) {
      return;
    }
    fail(`Unsupported deno command: ${args[0]}. Only 'deno run npm:...' is supported without a real Deno installation.`);
  }

  let targetIndex = 1;
  while (targetIndex < args.length && !String(args[targetIndex]).startsWith('npm:')) {
    targetIndex += 1;
  }

  if (targetIndex >= args.length) {
    if (delegateToRealDeno(args)) {
      return;
    }
    fail('Missing npm: target in deno shim invocation and no real Deno executable was found on PATH');
  }

  const target = parseNpmTarget(String(args[targetIndex]));
  const forwardedArgs = args.slice(targetIndex + 1);
  const scriptPath = resolveBinScript(target.packageName, target.binName);
  if (!scriptPath) {
    runViaNpx(target, forwardedArgs);
    return;
  }

  const result = spawnSync(process.execPath, [scriptPath, ...forwardedArgs], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    windowsHide: false,
  });

  if (result.error) {
    fail(`Failed to execute ${target.requested}`, result.error.stack ?? String(result.error));
  }

  process.exit(result.status ?? 1);
}

main();
