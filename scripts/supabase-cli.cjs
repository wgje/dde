#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const path = require('node:path');
require('dotenv').config({
  path: path.resolve(__dirname, '../.env.local'),
  quiet: true,
});

const args = process.argv.slice(2);
const projectRef = (process.env.SUPABASE_PROJECT_REF || process.env.NG_APP_SUPABASE_PROJECT_REF || '').trim();

function hasOption(argsToInspect, optionNames) {
  return argsToInspect.some((arg) =>
    optionNames.some((optionName) => arg === optionName || arg.startsWith(`${optionName}=`))
  );
}

if (args[0] === 'link' && projectRef && !hasOption(args, ['--project-ref'])) {
  args.splice(1, 0, '--project-ref', projectRef);
}

function quoteCmdArg(value) {
  const text = String(value);
  if (text.length === 0) return '""';
  if (!/[\s"%&()<>^|]/.test(text)) return text;
  return `"${text.replace(/(["^&()<>|])/g, '^$1').replace(/%/g, '^%')}"`;
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
