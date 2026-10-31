#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function hasOption(argsToInspect, optionNames) {
  return argsToInspect.some((arg) =>
    optionNames.some((optionName) => arg === optionName || arg.startsWith(`${optionName}=`))
  );
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

function main() {
  require('dotenv').config({
    path: path.resolve(__dirname, '../.env.local'),
    quiet: true,
  });

  const args = process.argv.slice(2);
  const projectRef = (
    process.env.SUPABASE_PROJECT_REF
    || process.env.NG_APP_SUPABASE_PROJECT_REF
    || ''
  ).trim();
  const linkedProjectRef = readLinkedProjectRef();
  const projectTarget = evaluateRemoteProjectTarget(args, projectRef, linkedProjectRef);
  if (!projectTarget.ok) {
    console.error('Supabase remote command blocked before CLI startup.');
    console.error(`Reason: ${projectTarget.reason}`);
    console.error(`Configured project ref: ${projectRef || '(missing)'}`);
    console.error(`Linked project ref: ${linkedProjectRef || '(missing)'}`);
    console.error('Set SUPABASE_PROJECT_REF and SUPABASE_DB_PASSWORD in .env.local, then run npm run supabase:link.');
    process.exit(2);
  }

  if (args[0] === 'link' && projectRef && !hasOption(args, ['--project-ref'])) {
    args.splice(1, 0, '--project-ref', projectRef);
  }

  const bin = path.resolve(
    __dirname,
    '../node_modules/.bin',
    process.platform === 'win32' ? 'supabase.cmd' : 'supabase'
  );
  const cliArgs = args.length > 0 ? args : ['--help'];
  const command = process.platform === 'win32' ? 'cmd.exe' : bin;
  const commandArgs = process.platform === 'win32'
    ? ['/d', '/c', [bin, ...cliArgs].map(quoteCmdArg).join(' ')]
    : cliArgs;

  const result = spawnSync(command, commandArgs, {
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}

module.exports = {
  evaluateRemoteProjectTarget,
  isRemoteProjectCommand,
};

if (require.main === module) {
  main();
}
