import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relativePath: string): string =>
  fs.readFileSync(path.join(root, relativePath), 'utf-8');

describe('Cloudflare migration artifact contracts', () => {
  it('does not install an explicit wildcard _redirects rule that turns missing chunks into HTML 200', () => {
    const redirectsPath = path.join(root, 'public', '_redirects');

    if (!fs.existsSync(redirectsPath)) {
      expect(fs.existsSync(redirectsPath)).toBe(false);
      return;
    }

    const redirects = read('public/_redirects');
    expect(redirects).not.toMatch(/^\s*\/\*\s+\/index\.html\s+200\b/m);
  });

  it('keeps the production workflow split into secret-free tests and deploy-only Cloudflare credentials', () => {
    const workflow = read('.github/workflows/deploy-cloudflare-pages.yml');

    expect(workflow).not.toContain('pull_request_target');
    expect(workflow).toMatch(/\n  test:\n/);
    expect(workflow).toMatch(/\n  build-deploy:\n/);
    expect(workflow).toContain('needs: test');
    expect(workflow).toContain('wrangler@${WRANGLER_VERSION}');
    expect(workflow).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');

    const beforeDeploy = workflow.split('- name: Deploy to Cloudflare Pages')[0] ?? workflow;
    expect(beforeDeploy).not.toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
    expect(beforeDeploy).not.toContain('CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}');
  });

  it('runs deterministic build and local wrangler smoke in the dry-run workflow', () => {
    const workflow = read('.github/workflows/deploy-cloudflare-pages-dry-run.yml');

    expect(workflow).toContain('npm run quality:guard:build-deterministic');
    expect(workflow).toContain('wrangler@${WRANGLER_VERSION} pages dev dist/browser');
    expect(workflow).toContain('scripts/smoke/cloudflare-header-smoke.sh');
    expect(workflow).not.toContain('CLOUDFLARE_API_TOKEN');
    expect(workflow).not.toContain('SENTRY_AUTH_TOKEN');
  });

  it('generates a final artifact manifest after headers are installed', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    const deployWorkflow = read('.github/workflows/deploy-cloudflare-pages.yml');
    const dryRunWorkflow = read('.github/workflows/deploy-cloudflare-pages-dry-run.yml');

    expect(fs.existsSync(path.join(root, 'scripts', 'generate-artifact-manifest.cjs'))).toBe(true);
    expect(pkg.scripts.build).toContain('node scripts/generate-artifact-manifest.cjs');
    expect(pkg.scripts['build:strict']).toContain('node scripts/generate-artifact-manifest.cjs');
    expect(deployWorkflow.indexOf('Install Cloudflare headers')).toBeLessThan(
      deployWorkflow.indexOf('Generate artifact manifest')
    );
    expect(dryRunWorkflow.indexOf('Install Cloudflare headers')).toBeLessThan(
      dryRunWorkflow.indexOf('Generate artifact manifest')
    );
    expect(deployWorkflow).toContain('dist/browser/artifact-manifest.json');
    expect(dryRunWorkflow).toContain('node scripts/generate-artifact-manifest.cjs');
  });

  it('deploy artifact guard validates the final artifact manifest', () => {
    const guard = read('scripts/ci/check-deploy-artifacts.cjs');

    expect(guard).toContain('artifact-manifest.json');
    expect(guard).toContain('artifact manifest');
    expect(guard).toContain('modulepreload');
    expect(guard).toContain('cachePolicy');
  });

  it('runs artifact trend checks against the last main baseline before deploy', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    const deployWorkflow = read('.github/workflows/deploy-cloudflare-pages.yml');
    const dryRunWorkflow = read('.github/workflows/deploy-cloudflare-pages-dry-run.yml');
    const generator = read('scripts/generate-artifact-manifest.cjs');

    expect(pkg.scripts['quality:guard:artifact-trends']).toBe('node scripts/ci/check-artifact-trends.cjs');
    expect(fs.existsSync(path.join(root, 'scripts', 'ci', 'check-artifact-trends.cjs'))).toBe(true);
    expect(deployWorkflow).toContain('npm run quality:guard:artifact-trends');
    expect(dryRunWorkflow).toContain('npm run quality:guard:artifact-trends');
    expect(generator).toContain('gojsFlowChunkBytes');
  });

  it('blocks deployment on no-JIT, font, and Supabase readiness guards', () => {
    const deployWorkflow = read('.github/workflows/deploy-cloudflare-pages.yml');
    const dryRunWorkflow = read('.github/workflows/deploy-cloudflare-pages-dry-run.yml');

    for (const workflow of [deployWorkflow, dryRunWorkflow]) {
      expect(workflow).toContain('npm run perf:guard:nojit');
      expect(workflow).toContain('npm run quality:guard:font-contract');
      expect(workflow).toContain('npm run quality:guard:supabase-ready');
    }
  });

  it('strict production builds emit stats for the deploy no-JIT guard', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    const deployWorkflow = read('.github/workflows/deploy-cloudflare-pages.yml');

    expect(deployWorkflow).toContain('run: npm run build:strict');
    expect(deployWorkflow.indexOf('run: npm run build:strict')).toBeLessThan(
      deployWorkflow.indexOf('npm run perf:guard:nojit')
    );
    expect(pkg.scripts['build:strict']).toContain('node scripts/run-ng.cjs build --stats-json');
    expect(pkg.scripts['build:strict:clean']).toContain('node scripts/run-ng.cjs build --stats-json');
  });

  it('runs the canonical origin gate before resource hints and cleans stale SW caches once', () => {
    const indexHtml = read('index.html');
    const gateIndex = indexHtml.indexOf('id="canonical-origin-gate"');

    expect(gateIndex).toBeGreaterThan(-1);
    expect(gateIndex).toBeLessThan(indexHtml.indexOf('rel="preconnect"'));
    expect(gateIndex).toBeLessThan(indexHtml.indexOf('Anti-FOUC'));
    expect(indexHtml).toContain('nanoflow.originGate.cleanup');
    expect(indexHtml).toContain('caches.keys');
    expect(indexHtml).toContain('__NANOFLOW_WRITE_GUARD__');
  });

  it('Cloudflare headers explicitly keep the root app shell fresh and suppress Link headers', () => {
    const headers = read('public/_headers');
    const guard = read('scripts/ci/check-deploy-artifacts.cjs');

    expect(headers).toMatch(/^\/\r?\n(?:[ \t].*\r?\n)+/m);
    expect(headers).toMatch(/^\/\r?\n(?:[ \t].*\r?\n)*[ \t]+Cache-Control: .*no-store/im);
    expect(headers).toMatch(/^\/\*\r?\n(?:[ \t].*\r?\n)*[ \t]+! Link/im);
    expect(guard).toContain('Cloudflare Pages serves the app shell at /');
    expect(guard).toContain('suppresses automatic Link/modulepreload headers');
  });

  it('header smoke accepts Cloudflare default SPA fallback only with chunk self-heal proof', () => {
    const smoke = read('scripts/smoke/cloudflare-header-smoke.sh');

    expect(smoke).toContain('Pages SPA fallback');
    expect(smoke).toContain('GlobalErrorHandler chunk self-heal contract present');
    expect(smoke).toContain('src/services/global-error-handler.service.ts');
    expect(smoke).toContain('src/services/global-error-handler.service.spec.ts');
    expect(smoke).toContain('Failed to fetch dynamically imported module');
  });

  it('header smoke tolerates missing optional Cloudflare cache metadata headers', () => {
    const smoke = read('scripts/smoke/cloudflare-header-smoke.sh');

    expect(smoke).toContain("grep -i '^cf-cache-status:' || true");
    expect(smoke).toContain("grep -i '^age:' || true");
    expect(smoke).toContain('freshness OK (cf=${cf:-none}, age=${age:-0})');
  });

  it('provides a browser smoke for Cloudflare production pages', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    const scriptPath = path.join(root, 'scripts', 'smoke', 'cloudflare-playwright-smoke.cjs');

    expect(pkg.scripts['smoke:cloudflare-playwright']).toBe('node scripts/smoke/cloudflare-playwright-smoke.cjs');
    expect(fs.existsSync(scriptPath)).toBe(true);

    const smoke = read('scripts/smoke/cloudflare-playwright-smoke.cjs');
    expect(smoke).toContain('/version.json');
    expect(smoke).toContain('pageerror');
    expect(smoke).toContain('console');
    expect(smoke).toContain('serviceWorker');
    expect(smoke).toContain('setViewportSize');
    expect(smoke).toContain('hasLocalChunkSelfHealContract');
    expect(smoke).toContain('GlobalErrorHandler chunk self-heal contract present');
  });

  it('keeps the PR cloudflare smoke spec aligned with the Pages fallback self-heal contract', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    const specPath = path.join(root, 'e2e', 'cloudflare-smoke.spec.ts');

    expect(pkg.scripts['smoke:cloudflare-e2e']).toBe('playwright test e2e/cloudflare-smoke.spec.ts --project=chromium');
    expect(fs.existsSync(specPath)).toBe(true);

    const spec = read('e2e/cloudflare-smoke.spec.ts');
    expect(spec).toContain('/projects');
    expect(spec).toContain('intent=open-workspace');
    expect(spec).toContain('X-Robots-Tag');
    expect(spec).toContain('GlobalErrorHandler chunk self-heal contract present');
    expect(spec).not.toContain('缺失的 hashed chunk 必须返回 4xx 或 application/javascript');
  });

  it('Cloudflare workflows use the pinned Wrangler version env instead of hardcoded command versions', () => {
    const deployWorkflow = read('.github/workflows/deploy-cloudflare-pages.yml');
    const dryRunWorkflow = read('.github/workflows/deploy-cloudflare-pages-dry-run.yml');

    expect(deployWorkflow).toContain("WRANGLER_VERSION: '3.114.0'");
    expect(dryRunWorkflow).toContain("WRANGLER_VERSION: '3.114.0'");
    expect(deployWorkflow).toContain('wrangler@${WRANGLER_VERSION}');
    expect(dryRunWorkflow).toContain('wrangler@${WRANGLER_VERSION}');
    expect(deployWorkflow).not.toContain('wrangler@3.114.0');
    expect(dryRunWorkflow).not.toContain('wrangler@3.114.0');
  });

  it('keeps Supabase resource hints aligned with the injected Supabase URL', () => {
    const indexHtml = read('index.html');
    const setEnv = read('scripts/set-env.cjs');
    const supabaseUrl = indexHtml.match(/var SUPABASE_URL = '([^']+)';/)?.[1];
    const preconnect = indexHtml.match(/<link rel="preconnect" href="([^"]+\.supabase\.co)" crossorigin>/)?.[1];
    const dnsPrefetch = indexHtml.match(/<link rel="dns-prefetch" href="([^"]+\.supabase\.co)">/)?.[1];

    expect(supabaseUrl).toBeTruthy();
    expect(preconnect).toBe(supabaseUrl);
    expect(dnsPrefetch).toBe(supabaseUrl);
    expect(setEnv).toContain('supabasePreconnectPattern');
    expect(setEnv).toContain('supabaseDnsPrefetchPattern');
  });

  it('deterministic guard normalizes volatile ngsw timestamp while comparing stable SW content', () => {
    const guard = read('scripts/ci/check-build-deterministic.cjs');

    expect(guard).toContain('normalizeNgswManifest');
    expect(guard).toContain('delete normalized.timestamp');
    expect(guard).toContain('launch.html modulepreload');
    expect(guard).toContain('stableVersionJson');
  });

  it('deployment fingerprints do not let volatile ngsw timestamp or buildTime break deterministic guard', () => {
    const versionScript = read('scripts/generate-version-json.cjs');
    const deterministicGuard = read('scripts/ci/check-build-deterministic.cjs');

    expect(versionScript).toContain('stableNgswHash');
    expect(deterministicGuard).toContain('normalizeArtifactManifest');
    expect(deterministicGuard).not.toContain('sha256(artifactA) !== sha256(artifactB)');
  });

  it('artifact guard explicitly validates manifest id and TWA assetlinks', () => {
    const guard = read('scripts/ci/check-deploy-artifacts.cjs');
    const deployWorkflow = read('.github/workflows/deploy-cloudflare-pages.yml');
    const dryRunWorkflow = read('.github/workflows/deploy-cloudflare-pages-dry-run.yml');

    expect(guard).toContain('manifest.webmanifest id');
    expect(guard).toContain('assetlinks.json');
    expect(guard).toContain('ANDROID_TWA_PACKAGE_NAME');
    expect(guard).toContain('ANDROID_TWA_EXPECTED_SHA256_CERT_FINGERPRINTS');
    expect(guard).toContain('ANDROID_TWA_SHA256_FINGERPRINTS');
    expect(deployWorkflow).toContain('ANDROID_TWA_EXPECTED_SHA256_CERT_FINGERPRINTS');
    expect(dryRunWorkflow).toContain('ANDROID_TWA_EXPECTED_SHA256_CERT_FINGERPRINTS');
  });

  it('Android TWA default origin no longer points at the retired Vercel host', () => {
    const gradle = read('android/app/build.gradle.kts');

    expect(gradle).not.toContain('https://dde-eight.vercel.app');
    expect(gradle).toContain('https://nanoflow.pages.dev');
  });
});
