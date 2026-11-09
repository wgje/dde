import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'vercel-prebuilt-recovery.yml');

describe('Vercel prebuilt artifact integrity contract', () => {
  it('injects the repository fingerprint contract into both guard stages', () => {
    const workflow = fs.readFileSync(workflowPath, 'utf8');
    const fingerprintEnv = 'ANDROID_TWA_EXPECTED_SHA256_CERT_FINGERPRINTS:';
    expect(workflow.split(fingerprintEnv).length - 1).toBeGreaterThanOrEqual(2);
    expect(workflow).toContain('vars.ANDROID_TWA_SHA256_FINGERPRINTS || \'\'');
  });

  it('validates the final Vercel static tree after build and before deploy', () => {
    const workflow = fs.readFileSync(workflowPath, 'utf8');
    const buildIndex = workflow.indexOf('- name: Build Vercel prebuilt output');
    const finalGuardIndex = workflow.indexOf('- name: Validate final Vercel prebuilt artifact');
    const deployIndex = workflow.indexOf('- name: Deploy Vercel prebuilt output');
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(finalGuardIndex).toBeGreaterThan(buildIndex);
    expect(deployIndex).toBeGreaterThan(finalGuardIndex);
    const finalGuardBlock = workflow.slice(finalGuardIndex, deployIndex);
    expect(finalGuardBlock).toContain('ARTIFACT_DIST_DIR: .vercel/output/static');
    expect(finalGuardBlock).toContain('npm run quality:guard:deploy-artifacts');
    expect(workflow.indexOf('- name: Run deployment quality guards')).toBeLessThan(
      workflow.indexOf('- name: Validate manual deploy confirmation'),
    );
  });
});
