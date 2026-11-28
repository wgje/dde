#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function hasOption(argsToInspect, optionNames) {
  return argsToInspect.some((arg) =>
    optionNames.some((optionName) => arg === optionName || arg.startsWith(`${optionName}=`))
  );
}

function isDbPushCommand(args) {
  return Array.isArray(args) && args[0] === 'db' && args[1] === 'push';
}

function invokeCliCommand(command, commandArgs, options = {}) {
  return spawnSync(command, commandArgs, options);
}

function validateLedgerFreshness(ledger, nowUtc) {
  const nowMs = Date.parse(String(nowUtc || ''));
  const capturedMs = Date.parse(String(ledger?.capturedAtUtc || ''));
  if (!Number.isFinite(nowMs)) return 'ledger-current-time-invalid';
  if (!Number.isFinite(capturedMs)) return 'ledger-snapshot-captured-at-invalid';
  if (!Number.isInteger(ledger.maxAgeSeconds) || ledger.maxAgeSeconds <= 0) {
    return 'ledger-snapshot-max-age-invalid';
  }
  if (capturedMs > nowMs) return 'ledger-snapshot-captured-in-future';
  if (nowMs - capturedMs > ledger.maxAgeSeconds * 1000) return 'ledger-snapshot-stale';
  const evidence = ledger.sourceEvidence;
  if (!evidence || evidence.tool !== 'mcp__supabase.execute_sql'
    || typeof evidence.queryId !== 'string' || evidence.queryId.trim() === ''
    || typeof evidence.query !== 'string' || evidence.query.trim() === ''
    || !Number.isInteger(evidence.resultRowCount)
    || !Array.isArray(ledger.rows)
    || evidence.resultRowCount !== ledger.rows.length) {
    return 'ledger-capture-evidence-unverified';
  }
  return null;
}

function evaluateDbPushPreflight(args, options = {}) {
  if (!isDbPushCommand(args)) return { ok: true, runGuard: false };
  if (hasOption(args, ['--local'])) return { ok: true, runGuard: false, local: true };
  if (!hasOption(args, ['--linked'])) return {
    ok: false,
    runGuard: false,
    reason: 'explicit-target-required',
  };
  const configuredRef = String(options.configuredProjectRef || '').trim();
  const expectedProjectRef = String(options.expectedProjectRef || '').trim();
  const linkedRef = String(options.linkedProjectRef || '').trim();
  const targetSha = String(options.targetSha || '').trim();
  const currentTargetSha = String(options.currentTargetSha || '').trim();
  if (!expectedProjectRef || !configuredRef || !linkedRef
    || configuredRef !== linkedRef || configuredRef !== expectedProjectRef) {
    return { ok: false, runGuard: false, reason: 'project-ref-mismatch' };
  }
  if (!/^[a-f0-9]{40}$/i.test(targetSha)) {
    return { ok: false, runGuard: false, reason: 'target-sha-not-explicit' };
  }
  if (currentTargetSha && currentTargetSha.toLowerCase() !== targetSha.toLowerCase()) {
    return { ok: false, runGuard: false, reason: 'current-target-sha-mismatch' };
  }
  const ledgers = options.ledgerSnapshots;
  if (!Array.isArray(ledgers) || ledgers.length !== 1) {
    return { ok: false, runGuard: false, reason: 'ledger-snapshot-not-target-bound' };
  }
  const ledger = ledgers[0];
  if (!ledger || ledger.projectRef !== configuredRef) {
    return { ok: false, runGuard: false, reason: 'ledger-snapshot-target-mismatch' };
  }
  const sourceGitSha = String(ledger.sourceGitSha || '').trim();
  const expectedSourceGitSha = String(options.expectedGitSha || '').trim();
  if (!/^[a-f0-9]{40}$/i.test(sourceGitSha) || !/^[a-f0-9]{40}$/i.test(expectedSourceGitSha) || expectedSourceGitSha.toLowerCase() !== sourceGitSha.toLowerCase()) {
    return { ok: false, runGuard: false, reason: 'ledger-source-sha-mismatch' };
  }
  if (options.sourceIsAncestor && !options.sourceIsAncestor(sourceGitSha, targetSha)) {
    return { ok: false, runGuard: false, reason: 'ledger-source-sha-not-ancestor' };
  }
  const freshnessReason = validateLedgerFreshness(ledger, options.nowUtc || new Date().toISOString());
  if (freshnessReason) return { ok: false, runGuard: false, reason: freshnessReason };
  return { ok: true, runGuard: true };
}

function readGitHead(root, executeGit = spawnSync) {
  const result = executeGit('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

function gitIsAncestor(root, ancestorSha, descendantSha, executeGit = spawnSync) {
  const result = executeGit('git', ['-C', root, 'merge-base', '--is-ancestor', ancestorSha, descendantSha]);
  return result.status === 0;
}

function validateSourceSnapshot(root, ledger, executeGit = spawnSync) {
  const sourceGitSha = String(ledger?.sourceGitSha || '').trim();
  const expectedGitSha = String(ledger?.expectedGitSha || '').trim();
  if (!/^[a-f0-9]{40}$/i.test(sourceGitSha)
    || !/^[a-f0-9]{40}$/i.test(expectedGitSha)
    || sourceGitSha.toLowerCase() !== expectedGitSha.toLowerCase()) {
    return { ok: false, reason: 'ledger-source-sha-mismatch' };
  }
  const head = executeGit('git', ['-C', root, 'cat-file', '-e', `${sourceGitSha}^{commit}`], { encoding: 'utf8' });
  if (head.status !== 0) return { ok: false, reason: 'ledger-source-sha-unavailable' };
  return { ok: true, sourceGitSha };
}

function loadLedgerSnapshots(root) {
  const ledgerSource = path.join(root, 'scripts', 'migration-ledger-snapshot.json');
  const aliasSource = path.join(root, 'scripts', 'migration-version-alias-manifest.json');
  try {
    const ledger = JSON.parse(fs.readFileSync(ledgerSource, 'utf8'));
    const aliases = JSON.parse(fs.readFileSync(aliasSource, 'utf8'));
    const expectedProjectRef = String(aliases.expectedProjectRef || '').trim();
    if (!expectedProjectRef) {
      return { ok: false, ledgers: [], reason: 'alias-manifest-project-ref-missing' };
    }
    if (ledger.projectRef !== expectedProjectRef) {
      return { ok: false, ledgers: [], reason: 'alias-manifest-project-ref-mismatch' };
    }
    const target = aliases && Array.isArray(aliases.aliases)
      ? aliases.aliases.find(entry => entry && entry.sourceVersion === '20261121060000') : null;
    const exactAliasSet = target && Array.isArray(target.appliedAliases)
      && target.appliedAliases.length === 2
      && target.appliedAliases.some(alias => alias.version === '20261122053816' && alias.name === 'widget_focus_action_durable_receipt')
      && target.appliedAliases.some(alias => alias.version === '20261122053936' && alias.name === 'widget_focus_action_durable_receipt_exact_repair');
    if (!exactAliasSet) {
      return { ok: false, ledgers: [], reason: 'known-alias-chain-missing' };
    }
    const sourceValidation = validateSourceSnapshot(root, ledger);
    if (!sourceValidation.ok) return { ok: false, ledgers: [], reason: sourceValidation.reason };
    return { ok: true, ledgers: [ledger], expectedProjectRef, expectedGitSha: ledger.expectedGitSha };
  } catch {
    return { ok: false, ledgers: [], reason: 'ledger-or-alias-snapshot-unavailable' };
  }
}

function runMigrationPreflight(root, options = {}) {
  const guard = path.resolve(__dirname, 'validate-migration-dry-run-rollback.cjs');
  const args = [guard, '--root', root];
  if (options.nowUtc) args.push('--now', options.nowUtc);
  if (options.currentTargetSha) args.push('--current-target-sha', options.currentTargetSha);
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
  });
  return {
    ok: result.status === 0 && !result.error,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || (result.error ? result.error.message : ''),
  };
}

function isRemoteProjectCommand(args) {
  if (!Array.isArray(args) || args.length === 0) {
    return false;
  }

  if (hasOption(args, ['-h', '--help', '-v', '--version'])) {
    return false;
  }

  const [command, subcommand] = args;
  const usesLocalDatabase = hasOption(args, ['--local']);
  const usesLinkedDatabase = hasOption(args, ['--linked']);

  if (command === 'db') {
    if (usesLocalDatabase) {
      return false;
    }
    if (['push', 'pull', 'dump'].includes(subcommand)) {
      return true;
    }
    if (subcommand === 'query') return usesLinkedDatabase;
    return ['reset', 'diff'].includes(subcommand) && usesLinkedDatabase;
  }

  if (command === 'gen' && subcommand === 'types') {
    return usesLinkedDatabase;
  }

  if (command === 'functions' && subcommand === 'deploy') {
    return true;
  }

  if (command === 'secrets' && ['set', 'unset', 'list'].includes(subcommand)) {
    return true;
  }

  if (command === 'migration' && ['list', 'repair'].includes(subcommand)) {
    return !usesLocalDatabase;
  }

  return false;
}

function evaluateRemoteProjectTarget(args, configuredProjectRef, linkedProjectRef) {
  if (!isRemoteProjectCommand(args)) {
    return { ok: true };
  }

  const configuredRef = String(configuredProjectRef || '').trim();
  const linkedRef = String(linkedProjectRef || '').trim();

  if (!configuredRef) {
    return { ok: false, reason: 'missing-configured-project-ref' };
  }
  if (!linkedRef) {
    return { ok: false, reason: 'missing-linked-project-ref' };
  }
  if (configuredRef !== linkedRef) {
    return { ok: false, reason: 'project-ref-mismatch' };
  }

  return { ok: true };
}

function readLinkedProjectRef() {
  const linkedProjectRefPath = path.resolve(__dirname, '../supabase/.temp/project-ref');
  if (!fs.existsSync(linkedProjectRefPath)) {
    return '';
  }
  return fs.readFileSync(linkedProjectRefPath, 'utf8').trim();
}

function quoteCmdArg(value) {
  const text = String(value);
  if (text.length === 0) return '""';
  if (!/[\s"%&()<>^|]/.test(text)) return text;
  return `"${text.replace(/(["^&()<>|])/g, '^$1').replace(/%/g, '^%')}"`;
}

function executeCli(args = process.argv.slice(2), dependencies = {}) {
  const runCli = dependencies.invokeCliCommand || invokeCliCommand;
  const env = dependencies.env || process.env;
  const root = dependencies.root || path.resolve(__dirname, '..');
  const readLinkedRef = dependencies.readLinkedProjectRef || readLinkedProjectRef;
  const loadLedgers = dependencies.loadLedgerSnapshots || loadLedgerSnapshots;
  const runPreflight = dependencies.runMigrationPreflight || runMigrationPreflight;
  const readHead = dependencies.readGitHead || readGitHead;
  const isAncestor = dependencies.gitIsAncestor || gitIsAncestor;
  const logError = dependencies.logError || ((message) => console.error(message));

  require('dotenv').config({ path: path.resolve(__dirname, '../.env.local'), quiet: true });

  const projectRef = String(env.SUPABASE_PROJECT_REF || env.NG_APP_SUPABASE_PROJECT_REF || '').trim();
  const linkedProjectRef = readLinkedRef(root);
  const projectTarget = evaluateRemoteProjectTarget(args, projectRef, linkedProjectRef);
  if (!projectTarget.ok) {
    logError('Supabase remote command blocked before CLI startup.');
    logError(`Reason: ${projectTarget.reason}`);
    logError(`Configured project ref: ${projectRef || '(missing)'}`);
    logError(`Linked project ref: ${linkedProjectRef || '(missing)'}`);
    return { exitCode: 2, spawned: false };
  }

  const ledgerState = loadLedgers(root);
  const nowUtc = env.NANOFLOW_PREFLIGHT_NOW_UTC || new Date().toISOString();
  const currentTargetSha = env.NANOFLOW_CURRENT_TARGET_SHA || readHead(root);
  const pushPreflight = evaluateDbPushPreflight(args, {
    expectedProjectRef: ledgerState.expectedProjectRef,
    expectedGitSha: ledgerState.expectedGitSha,
    configuredProjectRef: projectRef,
    linkedProjectRef,
    targetSha: env.NANOFLOW_PUSH_TARGET_SHA,
    currentTargetSha,
    sourceIsAncestor: (sourceGitSha, targetSha) => isAncestor(root, sourceGitSha, targetSha),
    nowUtc,
    ledgerSnapshots: ledgerState.ledgers,
  });
  if (!pushPreflight.ok) {
    logError('Supabase db push blocked before CLI startup.');
    logError(`Reason: ${pushPreflight.reason || ledgerState.reason || 'db-push-preflight-failed'}`);
    return { exitCode: 2, spawned: false, reason: pushPreflight.reason || ledgerState.reason || 'db-push-preflight-failed' };
  }
  if (pushPreflight.runGuard) {
    const guardResult = runPreflight(root, { nowUtc, currentTargetSha });
    if (!guardResult.ok) {
      logError('Supabase db push blocked by migration preflight.');
      if (guardResult.stderr) logError(guardResult.stderr.trim());
      return { exitCode: guardResult.status || 1, spawned: false };
    }
  }

  if (args[0] === 'link' && projectRef && !hasOption(args, ['--project-ref'])) {
    args.splice(1, 0, '--project-ref', projectRef);
  }

  const bin = path.resolve(__dirname, '../node_modules/.bin', process.platform === 'win32' ? 'supabase.cmd' : 'supabase');
  const cliArgs = args.length > 0 ? args : ['--help'];
  const command = process.platform === 'win32' ? 'cmd.exe' : bin;
  const commandArgs = process.platform === 'win32'
    ? ['/d', '/c', [bin, ...cliArgs].map(quoteCmdArg).join(' ')]
    : cliArgs;
  const result = runCli(command, commandArgs, { stdio: 'inherit', env });
  if (result.error) {
    logError(result.error.message);
    return { exitCode: 1, spawned: true };
  }
  return { exitCode: result.status ?? 1, spawned: true };
}

function main() {
  const result = executeCli();
  process.exit(result.exitCode);
}

module.exports = {
  evaluateDbPushPreflight,
  evaluateRemoteProjectTarget,
  executeCli,
  invokeCliCommand,
  isDbPushCommand,
  isRemoteProjectCommand,
  loadLedgerSnapshots,
  validateLedgerFreshness,
};

if (require.main === module) {
  main();
}
