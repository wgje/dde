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

  it('pins the Node patch release that carries the contract ICU version', () => {
    const workflow = readFileSync(path.join(root, '.github/workflows/test-full-suite.yml'), 'utf8');
    const perfWorkflow = readFileSync(path.join(root, '.github/workflows/perf-and-resume-gates.yml'), 'utf8');
    expect(workflow).toMatch(/node-version: 24\.11\.1/);
    expect(perfWorkflow).toMatch(/node-version: 24\.11\.1/);
    expect(workflow).not.toMatch(/node-version: 24\s*$/m);
    expect(perfWorkflow).not.toMatch(/node-version: 24\s*$/m);
  });

  it('configures all required overlay worker settings in the CI doctor config', () => {
    const workflow = readFileSync(path.join(root, '.github/workflows/test-full-suite.yml'), 'utf8');
    const start = workflow.indexOf('      - name: Configure CodeGraph Adapter for CI');
    const end = workflow.indexOf('      - name: Run CodeGraph Adapter Gate', start);
    const step = workflow.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(step).toContain('NANOFLOW_CODEGRAPH_OVERLAY_QUERY_TIMEOUT_MS = "60000"');
    expect(step).toContain('NANOFLOW_CODEGRAPH_OVERLAY_WORKER_ENABLED = "1"');
    expect(step).toContain('NANOFLOW_CODEGRAPH_OVERLAY_WORKER_POOL_SIZE = "1"');
    expect(step).toContain('NANOFLOW_CODEGRAPH_OVERLAY_PREWARM = "1"');
  });

  it('bootstraps a native CodeGraph index in the CI main checkout before the adapter gate', () => {
    const workflow = readFileSync(path.join(root, '.github/workflows/test-full-suite.yml'), 'utf8');
    const setup = workflow.indexOf('      - name: Bootstrap exact-root CodeGraph index and overlay');
    const configure = workflow.indexOf('      - name: Configure CodeGraph Adapter for CI', setup);
    const gate = workflow.indexOf('npm run codegraph:adapter:gate');
    const step = workflow.slice(setup, configure);

    expect(setup).toBeGreaterThanOrEqual(0);
    expect(configure).toBeGreaterThan(setup);
    expect(step).toContain('node scripts/codegraph-worktree-bootstrap.cjs');
    expect(step).toContain('--root "$GITHUB_WORKSPACE"');
    expect(step).toContain('--source-root "$GITHUB_WORKSPACE"');
    expect(step).toContain('--require-ready');
    expect(step).toContain('--json');
    expect(workflow).not.toContain('npm run codex:worktree:setup');
    expect(gate).toBeGreaterThan(configure);
  });
  it('prepares generated environment files before running CodeGraph infra tests', () => {
    const workflow = readFileSync(path.join(root, '.github/workflows/test-full-suite.yml'), 'utf8');
    const envSetup = workflow.indexOf('run: npm run test:prepare-env');
    const codegraphSetup = workflow.indexOf('node scripts/codegraph-worktree-bootstrap.cjs');
    const gate = workflow.indexOf('npm run codegraph:adapter:gate');

    expect(envSetup).toBeGreaterThanOrEqual(0);
    expect(codegraphSetup).toBeGreaterThan(envSetup);
    expect(gate).toBeGreaterThan(codegraphSetup);
  });

  it('prepares a fresh exact-root CodeGraph index before the adapter gate', () => {
    const workflow = readFileSync(path.join(root, '.github/workflows/test-full-suite.yml'), 'utf8');
    const setup = workflow.indexOf('node scripts/codegraph-worktree-bootstrap.cjs');
    const gate = workflow.indexOf('npm run codegraph:adapter:gate');
    expect(setup).toBeGreaterThanOrEqual(0);
    expect(gate).toBeGreaterThan(setup);
  });
});

