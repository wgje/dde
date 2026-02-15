#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = process.cwd();

const targets = [
  'src/app/features/flow/components/flow-task-detail.component.ts',
  'src/app/features/flow/components/flow-toolbar.component.ts',
];

const errors = [];

for (const relativeFile of targets) {
  const absoluteFile = path.join(projectRoot, relativeFile);
  if (!fs.existsSync(absoluteFile)) {
    errors.push(`${relativeFile}: file not found`);
    continue;
  }

  const source = fs.readFileSync(absoluteFile, 'utf8');

  if (!source.includes('UserSessionService')) {
    errors.push(`${relativeFile}: missing UserSessionService import/reference`);
  }

  if (!/inject\s*\(\s*UserSessionService\s*\)/.test(source)) {
    errors.push(`${relativeFile}: missing inject(UserSessionService)`);
  }

  if (/projectState\s*\.?\s*currentUserId\b/.test(source)) {
    errors.push(`${relativeFile}: forbidden projectState.currentUserId usage`);
  }
}

if (errors.length > 0) {
  console.error('[test:contracts] Flow currentUserId contract failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log('[test:contracts] Flow currentUserId contract passed.');
