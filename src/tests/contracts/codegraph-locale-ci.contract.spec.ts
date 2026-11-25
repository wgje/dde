import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const localeWorkflows = [
  '.github/workflows/database-hardening-gates.yml',
  '.github/workflows/deploy-cloudflare-pages-dry-run.yml',
  '.github/workflows/deploy-cloudflare-pages.yml',
  '.github/workflows/perf-and-resume-gates.yml',
  '.github/workflows/perf-nightly-audit.yml',
  '.github/workflows/test-full-suite.yml',
  '.github/workflows/vercel-prebuilt-recovery.yml',
] as const;

describe('CodeGraph locale CI contract', () => {
  it.each(localeWorkflows)('%s pins the locale required by graph ordering', workflowPath => {
    const workflow = readFileSync(path.join(root, workflowPath), 'utf8');
    expect(workflow).toMatch(/^\s*LANG:\s*['\"]?zh-CN['\"]?\s*$/m);
  });

  it('prepares a fresh exact-root CodeGraph index before the adapter gate', () => {
    const workflow = readFileSync(path.join(root, '.github/workflows/test-full-suite.yml'), 'utf8');
    const setup = workflow.indexOf('run: npm run codex:worktree:setup');
    const gate = workflow.indexOf('npm run codegraph:adapter:gate');
    expect(setup).toBeGreaterThanOrEqual(0);
    expect(gate).toBeGreaterThan(setup);
  });
});

