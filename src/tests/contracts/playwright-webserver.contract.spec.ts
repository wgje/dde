import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(__dirname, '..', '..', '..');

function readPlaywrightConfig(): string {
  return readFileSync(join(workspaceRoot, 'playwright.config.ts'), 'utf8');
}

function readPackageJson(): { scripts?: Record<string, string> } {
  return JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
}

describe('Playwright web server contract', () => {
  it('starts a fresh managed dev server by default and only reuses servers when explicitly requested', () => {
    const source = readPlaywrightConfig();

    expect(source).not.toContain("[resolverPath, '--json', '--allow-existing']");
    expect(source).toContain("const resolverArgs = ['--json'];");
    expect(source).toContain("resolverArgs.push('--allow-existing');");
    expect(source).toContain('readCachedPlaywrightDevServer()');
    expect(source).toContain("process.env['PLAYWRIGHT_RESOLVED_DEV_SERVER_URL']");
    expect(source).toContain("process.env['PLAYWRIGHT_RESOLVED_DEV_SERVER_PORT']");
    expect(source).toContain('reuseExistingServer: shouldReuseExistingServer');
    expect(source).toContain("process.env['PLAYWRIGHT_REUSE_EXISTING_SERVER'] === '1'");
  });

  it('keeps Playwright on one worker by default unless explicitly overridden', () => {
    const source = readPlaywrightConfig();

    expect(source).toContain("Number.parseInt(process.env['PLAYWRIGHT_WORKERS'] || '', 10)");
    expect(source).toContain('const resolvedWorkers = Number.isFinite(configuredWorkers) && configuredWorkers > 0');
    expect(source).toContain(': 1;');
    expect(source).toContain('workers: resolvedWorkers');
    expect(source).not.toContain("process.env['CI']\n    ? 1\n    : undefined");
  });

  it('can run PWA offline E2E against a production service-worker preview server', () => {
    const source = readPlaywrightConfig();
    const packageJson = readPackageJson();

    expect(packageJson.scripts?.['start:pwa-preview']).toBe('node scripts/serve-pwa-preview.cjs');
    expect(packageJson.scripts?.['test:e2e:pwa']).toBe('cross-env PLAYWRIGHT_PWA_PREVIEW=1 playwright test');
    expect(source).toContain("process.env['PLAYWRIGHT_PWA_PREVIEW'] === '1'");
    expect(source).toContain('npm run build && npm run start:pwa-preview');
    expect(source).toContain('const needsResolvedDevServer = !hasCustomBaseURL && !hasCustomWebServerCommand');
    expect(source).not.toContain('PLAYWRIGHT_PWA_PREVIEW=1`npm run start:e2e');
  });
});
