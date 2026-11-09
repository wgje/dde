#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const path = require('node:path');
require('dotenv').config({
  path: path.resolve(__dirname, '../.env.local'),
  quiet: true,
});

const mode = process.argv[2];
const extraArgs = process.argv.slice(3);

const rawRelease = (
  process.env.SENTRY_RELEASE
  || process.env.NG_APP_SENTRY_RELEASE
  || process.env.GITHUB_SHA
  || process.env.VERCEL_GIT_COMMIT_SHA
  || ''
).trim();
const release = rawRelease.startsWith('nanoflow@') ? rawRelease : rawRelease ? `nanoflow@${rawRelease}` : '';
const project = (process.env.SENTRY_PROJECT || process.env.NG_APP_SENTRY_PROJECT || '').trim();
const org = (process.env.SENTRY_ORG || process.env.NG_APP_SENTRY_ORG || '').trim();
const dist = (process.env.SENTRY_DIST || process.env.NG_APP_SENTRY_DIST || '').trim();

function quoteCmdArg(value) {
  const text = String(value);
  if (text.length === 0) return '""';
  if (!/[\s"%&()<>^|]/.test(text)) return text;
  return `"${text.replace(/(["^&()<>|])/g, '^$1').replace(/%/g, '^%')}"`;
}

function run(args) {
  const bin = path.resolve(
    __dirname,
    '../node_modules/.bin',
    process.platform === 'win32' ? 'sentry-cli.cmd' : 'sentry-cli'
  );
  const command = process.platform === 'win32' ? 'cmd.exe' : bin;
  const commandArgs = process.platform === 'win32'
    ? ['/d', '/c', [bin, ...args].map(quoteCmdArg).join(' ')]
    : args;
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

function requireRelease(commandName) {
  if (!release) {
    console.error(`${commandName} requires SENTRY_RELEASE or NG_APP_SENTRY_RELEASE.`);
    process.exit(1);
  }
}

const commonFlags = [];
if (org) commonFlags.push('--org', org);
if (project) commonFlags.push('--project', project);

switch (mode) {
  case 'info':
    run(['info', ...extraArgs]);
    break;

  case 'release:new':
    requireRelease(mode);
    run(['releases', ...commonFlags, 'new', release, ...extraArgs]);
    break;

  case 'release:set-commits':
    requireRelease(mode);
    run(['releases', ...commonFlags, 'set-commits', release, '--auto', '--ignore-missing', ...extraArgs]);
    break;

  case 'release:finalize':
    requireRelease(mode);
    run(['releases', ...commonFlags, 'finalize', release, ...extraArgs]);
    break;

  case 'sourcemaps:upload': {
    requireRelease(mode);
    const distPath = process.env.SENTRY_SOURCEMAP_DIR || process.env.NG_APP_SENTRY_SOURCEMAP_DIR || 'dist/browser';
    const args = [
      'sourcemaps',
      ...commonFlags,
      '--release',
      release,
      'upload',
      distPath,
      '--url-prefix',
      '~/',
      '--strip-common-prefix',
    ];
    if (dist) args.push('--dist', dist);
    run([...args, ...extraArgs]);
    break;
  }

  default:
    run(process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['--help']);
}
