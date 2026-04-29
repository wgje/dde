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
    expect(workflow).toContain('wrangler@3.114.0');
    expect(workflow).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');

    const beforeDeploy = workflow.split('- name: Deploy to Cloudflare Pages')[0] ?? workflow;
    expect(beforeDeploy).not.toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
    expect(beforeDeploy).not.toContain('CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}');
  });

  it('runs deterministic build and local wrangler smoke in the dry-run workflow', () => {
    const workflow = read('.github/workflows/deploy-cloudflare-pages-dry-run.yml');

    expect(workflow).toContain('npm run quality:guard:build-deterministic');
    expect(workflow).toContain('wrangler@3.114.0 pages dev dist/browser');
    expect(workflow).toContain('scripts/smoke/cloudflare-header-smoke.sh');
    expect(workflow).not.toContain('CLOUDFLARE_API_TOKEN');
    expect(workflow).not.toContain('SENTRY_AUTH_TOKEN');
  });

  it('artifact guard explicitly validates manifest id and TWA assetlinks', () => {
    const guard = read('scripts/ci/check-deploy-artifacts.cjs');

    expect(guard).toContain('manifest.webmanifest id');
    expect(guard).toContain('assetlinks.json');
    expect(guard).toContain('ANDROID_TWA_PACKAGE_NAME');
    expect(guard).toContain('ANDROID_TWA_SHA256_FINGERPRINTS');
  });

  it('Android TWA default origin no longer points at the retired Vercel host', () => {
    const gradle = read('android/app/build.gradle.kts');

    expect(gradle).not.toContain('https://dde-eight.vercel.app');
    expect(gradle).toContain('https://nanoflow.pages.dev');
  });
});
