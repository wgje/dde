'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { readOverlayCurrentReceipt } = require('./lib/codegraph-overlay-current-receipt.cjs');
const { resolveCodegraphPackageLaunch, resolveNpmExecLaunch } = require('./lib/codegraph-package-launcher.cjs');
const { withSetupLock } = require('./lib/codegraph-worktree-setup-lock.cjs');

const REQUIRED_RUNTIME_CLOSURE = Object.freeze([
  'scripts/codegraph-worktree-bootstrap.cjs',
  'scripts/setup-codegraph-worktree.cjs',
  'scripts/codegraph-nanoflow-mcp-stdio.cjs',
  'scripts/codegraph-adapter-context.cjs',
  'scripts/codegraph-codex-config.cjs',
  'scripts/codegraph-nanoflow-dedup-query.cjs',
  'scripts/codegraph-nanoflow-specialized-query.cjs',
  'scripts/analyze-codegraph-mcp-log.cjs',
  'scripts/agent-file-lease.cjs',
  'scripts/lib/codegraph-context-outcome.cjs',
  'scripts/lib/codegraph-package-launcher.cjs',
  'scripts/lib/codegraph-worktree-setup-lock.cjs',
  'scripts/query-codegraph-nanoflow-overlay.mjs',
  'scripts/run-codegraph-overlay-stability.cjs',
  'scripts/generate-codegraph-nanoflow-overlay.mjs',
  'scripts/lib/codegraph-overlay-worker-pool.cjs',
  'scripts/lib/agent-file-lease-store.cjs',
  'scripts/lib/codegraph-overlay-current-receipt.cjs',
  'scripts/lib/codegraph-overlay-generation-format.cjs',
  'scripts/lib/codegraph-overlay-generation-publisher.cjs',
  'scripts/lib/codegraph-overlay-baseline.cjs',
  'scripts/lib/codegraph-overlay-stability.cjs',
  'scripts/lib/codegraph-source-policy.cjs',
  'scripts/lib/codegraph-native-graph-sidecar.cjs',
  'scripts/lib/codegraph-nanoflow-overlay-v1-schema.cjs',
  'scripts/lib/codegraph-nanoflow-overlay-current-graph.cjs',
  'scripts/lib/codegraph-overlay-current-schema.cjs',
  'scripts/contracts/codegraph-overlay-current-schema.json',
  'scripts/contracts/codegraph-overlay-current-generation.json',
  'scripts/lib/codegraph-nanoflow-overlay-v1-schema-angular-support.cjs',
  'scripts/lib/codegraph-nanoflow-overlay-v1-schema-graph.cjs',
  'scripts/lib/codegraph-nanoflow-overlay-v1-schema-supabase-android.cjs',
  'scripts/lib/codegraph-nanoflow-overlay-v1-schema-typescript.cjs',
  'scripts/contracts/codegraph-nanoflow-overlay-v1.json',
  'scripts/contracts/codegraph-overlay-generation-v1.json',
]);
const OPTIONAL_PROTOTYPE_CLOSURE = Object.freeze([
  'scripts/lib/codegraph-overlay-resident-worker-prototype.cjs',
  'scripts/codegraph-overlay-resident-worker-prototype.cjs',
]);
const TEST_CLOSURE = Object.freeze([
  'src/tests/fixtures/agent-file-lease-worker.cjs',
  'src/tests/fixtures/codegraph-overlay-resident-worker.fake.cjs',
  'src/tests/scripts/agent-file-lease.spec.ts',
  'src/tests/scripts/codegraph-overlay-resident-worker-prototype.spec.ts',
]);
const CLOSURE_CATEGORIES = Object.freeze({
  requiredRuntime: REQUIRED_RUNTIME_CLOSURE,
  optionalPrototype: OPTIONAL_PROTOTYPE_CLOSURE,
  test: TEST_CLOSURE,
});
const CURRENT_RELATIVE_PATH = path.join('.codegraph', 'nanoflow-generations', 'CURRENT.json');
const BOOTSTRAP_BLOCKED_EXIT = 78;

function parseArgs(argv) {
  const parsed = {
    root: process.cwd(),
    sourceRoot: process.env.NANOFLOW_CODEGRAPH_BOOTSTRAP_SOURCE_ROOT || null,
    json: false,
    requireReady: false,
    generate: true,
    bootstrapIndex: true,
    overwrite: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') parsed.root = path.resolve(requireValue(argv, ++index, arg));
    else if (arg === '--source-root') parsed.sourceRoot = path.resolve(requireValue(argv, ++index, arg));
    else if (arg === '--json') parsed.json = true;
    else if (arg === '--require-ready') parsed.requireReady = true;
    else if (arg === '--no-generate') parsed.generate = false;
    else if (arg === '--no-index') parsed.bootstrapIndex = false;
    else if (arg === '--sync-clean') parsed.syncClean = true;
    else if (arg === '--overwrite') parsed.overwrite = true;
    else if (arg === '--help' || arg === '-h') return { help: true };
    else throw new Error(`unknown argument: ${arg}`);
  }
  parsed.root = path.resolve(parsed.root);
  if (parsed.sourceRoot) parsed.sourceRoot = path.resolve(parsed.sourceRoot);
  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function existsFile(root, relativePath) {
  try { return fs.statSync(path.join(root, relativePath)).isFile(); } catch { return false; }
}

function hashFile(filePath) {
  try {
    return require('node:crypto').createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch { return null; }
}

function currentPath(root) { return path.join(root, CURRENT_RELATIVE_PATH); }

function currentState(root, readReceipt = readOverlayCurrentReceipt) {
  const filePath = currentPath(root);
  if (!fs.existsSync(filePath)) return { status: 'missing', path: filePath };

  const receipt = readReceipt(root);
  if (receipt.ok) {
    return {
      status: 'ready',
      path: filePath,
      generationId: receipt.current.generationId,
      sequence: receipt.current.sequence,
    };
  }

  return {
    status: receipt.errorCode === 'CURRENT_MISSING' ? 'missing' : 'invalid',
    path: filePath,
    errorCode: receipt.errorCode,
  };
}

function targetIsClean(root, relativePath) {
  const result = spawnSync('git', ['-C', root, 'status', '--porcelain', '--', relativePath], { cwd: root, encoding: 'utf8' });
  return result.status === 0 && String(result.stdout ?? '').trim() === '';
}
function copyMissingClosure(root, sourceRoot, overwrite, syncClean = false) {
  const missingBefore = REQUIRED_RUNTIME_CLOSURE.filter(relativePath => !existsFile(root, relativePath));
  const copied = [];
  const skippedSourceMissing = [];
  const overwritten = [];
  const staleBefore = [];
  const dirtyConflicts = [];
  if (!sourceRoot) return { missingBefore, copied, overwritten, staleBefore, staleAfter: [], dirtyConflicts, skippedSourceMissing };
  for (const relativePath of missingBefore) {
    const sourcePath = path.join(sourceRoot, relativePath);
    const targetPath = path.join(root, relativePath);
    if (!existsFile(sourceRoot, relativePath)) { skippedSourceMissing.push(relativePath); continue; }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
    copied.push({ path: relativePath, sha256: hashFile(targetPath) });
  }
  if (overwrite || syncClean) {
    for (const relativePath of REQUIRED_RUNTIME_CLOSURE) {
      const sourcePath = path.join(sourceRoot, relativePath);
      const targetPath = path.join(root, relativePath);
      if (!existsFile(sourceRoot, relativePath) || !existsFile(root, relativePath)) continue;
      if (hashFile(sourcePath) === hashFile(targetPath)) continue;
      staleBefore.push(relativePath);
      if (syncClean && !targetIsClean(root, relativePath)) { dirtyConflicts.push(relativePath); continue; }
      fs.copyFileSync(sourcePath, targetPath);
      overwritten.push({ path: relativePath, sha256: hashFile(targetPath) });
    }
  }
  const staleAfter = !(overwrite || syncClean) ? [] : REQUIRED_RUNTIME_CLOSURE.filter(relativePath => existsFile(sourceRoot, relativePath)
    && existsFile(root, relativePath)
    && hashFile(path.join(sourceRoot, relativePath)) !== hashFile(path.join(root, relativePath)));
  return { missingBefore, copied, overwritten, staleBefore, staleAfter, dirtyConflicts, skippedSourceMissing };
}
function resolveNpmCache(env = process.env, platform = process.platform, homeDirectory = os.homedir()) {
  const configured = env.npm_config_cache || env.NPM_CONFIG_CACHE || env.NANOFLOW_CODEGRAPH_NPM_CACHE;
  if (configured) return configured;
  return platform === 'win32' ? 'D:/Code/tools/codegraph-npm-cache' : path.join(homeDirectory, '.npm');
}
function ensureNativeIndex(root, sourceRoot = null, dependencies = {}) {
  const databasePath = path.join(root, '.codegraph', 'codegraph.db');
  const current = currentState(root);
  if (fs.existsSync(databasePath)) return { status: 'ready', path: databasePath, bootstrapped: false, current };
  const inheritedEnv = dependencies.env || process.env;
  const npmCache = resolveNpmCache(
    inheritedEnv,
    dependencies.platform || process.platform,
    dependencies.homeDirectory || os.homedir(),
  );
  const initArgs = ['init', '--yes', root];
  const env = { ...inheritedEnv, npm_config_cache: npmCache };
  const launch = resolveCodegraphPackageLaunch('@colbymchenry/codegraph@1.6.2', initArgs, { root, env })
    || resolveNpmExecLaunch('@colbymchenry/codegraph@1.6.2', initArgs);
  if (!launch) return { status: 'failed', path: databasePath, bootstrapped: false, exitCode: 78, stderrTail: 'Node npm CLI unavailable; install npm before worktree setup' };
  const { command, args: commandArgs } = launch;
  const result = (dependencies.spawnSync || spawnSync)(command, commandArgs, {
    cwd: root, encoding: 'utf8', timeout: 20 * 60 * 1000, maxBuffer: 16 * 1024 * 1024,
    env, windowsHide: true,
  });
  const ready = result.status === 0 && fs.existsSync(databasePath);
  return { status: ready ? 'ready' : 'failed', path: databasePath, bootstrapped: ready,
    exitCode: result.status ?? 1, stderrTail: String(result.stderr ?? '').slice(-4000), stdoutTail: String(result.stdout ?? '').slice(-4000) };
}

function runGeneration(root, sourceRoot = null) {
  const executionRoot = root;
  const result = spawnSync(process.execPath, [path.join(executionRoot, 'scripts', 'run-codegraph-overlay-stability.cjs'), '--root', root], {
    cwd: executionRoot,
    encoding: 'utf8',
    timeout: 20 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, NANOFLOW_CODEGRAPH_REFRESH_ON_STARTUP: '0' },
  });
  return {
    exitCode: result.status ?? 1,
    signal: result.signal,
    stdoutTail: String(result.stdout ?? '').slice(-4000),
    stderrTail: String(result.stderr ?? '').slice(-4000),
  };
}

function printHelp() {
  process.stdout.write([
    'Prepare a CodeGraph worktree before adapter-dependent tests.',
    '',
    'Usage: node scripts/codegraph-worktree-bootstrap.cjs --root <worktree> --source-root <prepared-source> [--json] [--require-ready]',
    '',
    'Default behavior is non-blocking: missing setup is reported as ENVIRONMENT_BLOCKED and exits 0.',
    '--require-ready exits 78 for ENVIRONMENT_BLOCKED or GENERATION_PENDING so a gate can stop before running unrelated specs.',
  ].join('\n') + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  const report = {
    schemaVersion: 1,
    root: args.root,
    sourceRoot: args.sourceRoot,
    status: 'READY',
    taskImpact: 'adapter-dependent tasks may run',
    independentTasksMayProceed: true,
    currentBefore: currentState(args.root),
    runtimeClosure: null,
    closureCategories: CLOSURE_CATEGORIES,
    generation: null,
    blockingReason: null,
    generationState: null,
    exactRoot: { root: args.root, databasePath: path.join(args.root, '.codegraph', 'codegraph.db'), currentPath: currentPath(args.root) },
    nativeIndexSync: null,
  };
  if (!fs.existsSync(args.root)) {
    report.status = 'ENVIRONMENT_BLOCKED';
    report.taskImpact = 'adapter-dependent tasks blocked; unrelated tasks may proceed';
    report.blockingReason = 'requested worktree root does not exist';
  } else {
    report.runtimeClosure = copyMissingClosure(args.root, args.sourceRoot, args.overwrite, args.syncClean);
    const missingAfter = REQUIRED_RUNTIME_CLOSURE.filter(relativePath => !existsFile(args.root, relativePath));
    const staleAfter = report.runtimeClosure.staleAfter ?? [];
    report.runtimeClosure.missingAfter = missingAfter;
    report.runtimeClosure.missingOptional = OPTIONAL_PROTOTYPE_CLOSURE.filter(relativePath => !existsFile(args.root, relativePath));
    report.runtimeClosure.missingTests = TEST_CLOSURE.filter(relativePath => !existsFile(args.root, relativePath));
    const dirtyConflicts = report.runtimeClosure.dirtyConflicts ?? [];
    // A worktree may intentionally pin a different wrapper release than its
    // source-root. Never overwrite that root's selected implementation. Only
    // an incomplete runtime closure is a setup blocker; drift is recorded.
    if (missingAfter.length > 0) {
      report.status = 'ENVIRONMENT_BLOCKED';
      report.taskImpact = 'adapter-dependent tasks blocked; unrelated tasks may proceed';
      const unresolved = [...missingAfter, ...dirtyConflicts];
      report.blockingReason = args.sourceRoot
        ? `runtime dependency closure is incomplete: ${unresolved.join(', ')}`
        : 'runtime dependency closure is incomplete and no bootstrap source root was supplied';
    } else if (dirtyConflicts.length > 0) {
      report.status = 'READY_WITH_LOCAL_RUNTIME_CHANGES';
      report.taskImpact = 'adapter-dependent tasks may run; changed runtime files require task-local review; unrelated tasks may proceed';
      report.blockingReason = `local runtime changes preserved for review: ${dirtyConflicts.join(', ')}`;
      report.currentAfter = currentState(args.root);
      if (report.currentAfter.status !== 'ready') {
        report.status = 'ENVIRONMENT_BLOCKED';
        report.taskImpact = 'adapter-dependent tasks blocked; unrelated tasks may proceed';
        report.blockingReason = `local runtime changes exist and CURRENT.json is ${report.currentAfter.status}`;
      }
    } else if (args.generate && report.currentBefore.status !== 'ready') {
      if (args.bootstrapIndex) {
        report.index = ensureNativeIndex(args.root, args.sourceRoot);
        if (report.index.status !== 'ready') {
          report.status = 'ENVIRONMENT_BLOCKED';
          report.taskImpact = 'adapter-dependent tasks blocked; unrelated tasks may proceed';
          report.blockingReason = `native CodeGraph index bootstrap failed (exit=${report.index.exitCode ?? 'unknown'})`;
        }
      }
      if (report.status === 'READY') report.generation = runGeneration(args.root, args.sourceRoot);
      report.exactRoot.databaseExists = fs.existsSync(report.exactRoot.databasePath);
      report.exactRoot.generation = report.currentBefore.status === 'ready' ? report.currentBefore.generationId : report.currentAfter?.generationId ?? null;
      report.currentAfter = currentState(args.root);
      report.exactRoot.databaseExists = fs.existsSync(report.exactRoot.databasePath);
      report.exactRoot.generation = report.currentAfter?.generationId ?? null;
      if (report.status === 'READY' && (report.generation.exitCode !== 0 || report.currentAfter.status !== 'ready')) {
        report.status = 'ENVIRONMENT_BLOCKED';
        report.taskImpact = 'adapter-dependent tasks blocked; unrelated tasks may proceed';
        report.blockingReason = `immutable generation bootstrap failed (exit=${report.generation.exitCode})`;
      }
    } else {
      report.currentAfter = report.currentBefore;
      if (report.currentAfter.status !== 'ready') {
        report.generationState = report.currentAfter.status === 'missing' ? 'PENDING' : 'INVALID';
        report.taskImpact = 'runtime closure ready; immutable generation is not usable and adapter-dependent tasks remain blocked; unrelated tasks may proceed';
        report.blockingReason = report.currentAfter.status === 'missing'
          ? 'CURRENT_MISSING_WITH_RUNTIME_CLOSURE_READY'
          : 'CURRENT_INVALID_WITH_RUNTIME_CLOSURE_READY';
        report.status = args.requireReady ? 'GENERATION_PENDING' : 'CLOSURE_READY_GENERATION_PENDING';
      } else {
        report.generationState = 'READY';
      }
    }
  }
  if ((report.status === 'ENVIRONMENT_BLOCKED' || report.status === 'GENERATION_PENDING') && args.requireReady) {
    report.exitCode = BOOTSTRAP_BLOCKED_EXIT;
  } else {
    report.exitCode = 0;
  }
  const text = JSON.stringify(report, null, 2);
  if (args.json) process.stdout.write(`${text}\n`);
  else process.stdout.write(`[codegraph-worktree-bootstrap] ${report.status}: ${report.blockingReason ?? 'ready'}\n${text}\n`);
  process.exitCode = report.exitCode;
}

if (require.main === module) try {
  const targetRoot = path.resolve(parseArgs(process.argv.slice(2)).root);
  const lockHeld = process.env.NANOFLOW_CODEGRAPH_WORKTREE_SETUP_LOCK_ROOT
    && path.resolve(process.env.NANOFLOW_CODEGRAPH_WORKTREE_SETUP_LOCK_ROOT).toLowerCase() === targetRoot.toLowerCase();
  if (lockHeld || !fs.existsSync(targetRoot) || process.argv.includes('--help') || process.argv.includes('-h')) main();
  else withSetupLock(targetRoot, () => main());
} catch (error) {
  process.stderr.write(`[codegraph-worktree-bootstrap] ENVIRONMENT_BLOCKED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 78;
}

module.exports = Object.freeze({
  REQUIRED_RUNTIME_CLOSURE,
  OPTIONAL_PROTOTYPE_CLOSURE,
  TEST_CLOSURE,
  CLOSURE_CATEGORIES,
  currentState,
  ensureNativeIndex,
  resolveNpmCache,
});
