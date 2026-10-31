import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

import {
  adaptationDocPath,
  agentsDocPath,
  makeFixture,
  overlayBaselineModulePath,
  packageJsonPath,
  runSync,
  runValidator,
  syncDocsScriptPath,
  testFullSuiteWorkflowPath,
  validatorScriptPath,
} from './validate-codegraph-overlay-docs.spec-helpers';

export function registerValidateCodegraphOverlayDocsPackageSpecs(): void {
  it('exposes a read-only overlay validation gate and keeps generation explicit', () => {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const agentsDoc = fs.readFileSync(agentsDocPath, 'utf8');
    const adaptationDoc = fs.readFileSync(adaptationDocPath, 'utf8');

    expect(packageJson.scripts?.['codegraph:overlay:validate']).toBe(
      'npm run codegraph:overlay:docs:assert-clean && npm run codegraph:overlay:docs:validate',
    );
    expect(packageJson.scripts?.['codegraph:overlay:stable']).toBe(
      'node scripts/run-codegraph-overlay-stability.cjs',
    );
    expect(packageJson.scripts?.['codegraph:overlay:docs:sync']).toBe(
      'node scripts/sync-codegraph-overlay-docs.cjs',
    );
    expect(packageJson.scripts?.['codegraph:overlay:docs:assert-clean']).toBe(
      'node scripts/sync-codegraph-overlay-docs.cjs --assert-clean',
    );
    expect(packageJson.scripts?.['codegraph:overlay:docs:recover']).toBe(
      'node scripts/sync-codegraph-overlay-docs.cjs --recover',
    );
    expect(packageJson.scripts?.['codegraph:overlay:sync']).toBe(
      'npm run codegraph:overlay:stable && npm run codegraph:overlay:docs:sync',
    );
    expect(packageJson.scripts?.['codegraph:adapter:doctor']).toBe(
      'node scripts/codegraph-adapter-doctor.cjs',
    );
    expect(packageJson.scripts?.['codegraph:adapter:preflight']).toBe(
      'node scripts/codegraph-adapter-preflight.cjs',
    );
    expect(packageJson.scripts?.['codegraph:adapter:context']).toBe(
      'node scripts/codegraph-adapter-context.cjs',
    );
    expect(packageJson.scripts?.['codegraph:adapter:quick-gate']).toBe(
      'node scripts/run-codegraph-adapter-gate.cjs --profile quick',
    );
    expect(packageJson.scripts?.['codegraph:overlay:baseline:manifest']).toBe(
      'node scripts/generate-codegraph-overlay-baseline-manifest.cjs',
    );
    expect(packageJson.scripts?.['agent:file-lease']).toBe(
      'node scripts/agent-file-lease.cjs',
    );
    expect(agentsDoc).toContain('native graph shape/health');
    expect(agentsDoc).toContain('agent:file-lease');
    expect(agentsDoc).toContain('codegraph:adapter:doctor');
    expect(agentsDoc).toContain('codegraph:adapter:preflight');
    expect(agentsDoc).toContain('codegraph:adapter:context');
    expect(agentsDoc).toContain('codegraph:adapter:quick-gate');
    expect(agentsDoc).toContain('codegraph:overlay:baseline:manifest');
    expect(agentsDoc).toContain('numeric-token-only');
    expect(agentsDoc).toContain('codegraph:overlay:docs:recover');
    expect(adaptationDoc).toContain('npm run codegraph:overlay:validate');
    expect(adaptationDoc).toContain('npm run codegraph:overlay:sync');
    expect(adaptationDoc).toContain('npm run codegraph:overlay:baseline:manifest');
    expect(adaptationDoc).toContain('npm run codegraph:adapter:preflight');
    expect(adaptationDoc).toContain('npm run codegraph:adapter:context');
    expect(adaptationDoc).toContain('npm run codegraph:adapter:doctor');
    expect(adaptationDoc).toContain('npm run codegraph:adapter:quick-gate');
    expect(adaptationDoc).toContain('npm run agent:file-lease');
    expect(adaptationDoc).toContain('codegraph:overlay:docs:assert-clean');
    expect(adaptationDoc).toContain('codegraph:overlay:stable');
    expect(adaptationDoc).toContain('numeric-token-only');
    expect(adaptationDoc).toContain('codegraph:overlay:docs:recover');
    expect(adaptationDoc).toContain('native graph shape/health');
  });

  it('requires local CodeGraph source setup commands to run NanoFlow scripts from the NanoFlow workspace', () => {
    const root = makeFixture();
    const adaptationPath = path.join(root, 'docs', 'codegraph-nanoflow-adaptation.md');
    fs.writeFileSync(
      adaptationPath,
      fs.readFileSync(adaptationPath, 'utf8')
        .replace('npm --prefix D:\\Code\\dde run codegraph:overlay', 'npm run codegraph:overlay'),
    );

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md Local CodeGraph Source Setup must run NanoFlow npm scripts with D:\\Code\\dde cwd or --prefix');
  });

  it('keeps MCP failure fallback adapter-first before native CodeGraph CLI degradation', () => {
    const root = makeFixture();
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.writeFileSync(
        filePath,
        fs.readFileSync(filePath, 'utf8')
          .replace(/.*adapter-first.*\n?/g, ''),
      );
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md missing adapter-first fallback contract');
    expect(result.stderr).toContain('AGENTS.md missing adapter-first fallback contract');
    expect(result.stderr).toContain('final native CodeGraph CLI');
    expect(result.stderr).toContain('only a locator');
  });

  it('keeps overlay baseline and contract math in shared modules for validation and sync', () => {
    const baselineModule = fs.readFileSync(overlayBaselineModulePath, 'utf8');
    const validatorScript = fs.readFileSync(validatorScriptPath, 'utf8');
    const syncScript = fs.readFileSync(syncDocsScriptPath, 'utf8');

    expect(baselineModule).toContain('function buildBaseline');
    expect(baselineModule).toContain('module.exports');
    expect(validatorScript).toContain("require('./lib/codegraph-overlay-baseline.cjs')");
    expect(validatorScript).toContain("require('./lib/codegraph-overlay-contract-manifest.cjs')");
    expect(syncScript).toContain("require('./lib/codegraph-overlay-baseline.cjs')");
    expect(validatorScript).not.toContain('function buildBaseline(');
    expect(syncScript).not.toContain('function buildBaseline(');
  });

  it('requires the recoverable stable-artifact command contract in both authoritative docs', () => {
    const root = makeFixture();
    const fixturePackagePath = path.join(root, 'package.json');
    const fixturePackage = JSON.parse(fs.readFileSync(fixturePackagePath, 'utf8')) as {
      scripts: Record<string, string>;
    };
    fixturePackage.scripts['codegraph:overlay:stable'] = 'node scripts/run-codegraph-overlay-stability.cjs';
    fs.writeFileSync(fixturePackagePath, `${JSON.stringify(fixturePackage, null, 2)}\n`);
    const contract = 'stable overlay transaction codegraph:overlay:stable codegraph:overlay:docs:assert-clean codegraph:overlay:docs:recover exactly two builds source manifest path/size/SHA-256 generatedAt node.updatedAt numeric-token-only overlay publication is atomic separately recoverable two-document transaction';
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.appendFileSync(filePath, `\n${contract}\n`);
    }
    expect(runValidator(root).status).toBe(0);
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.writeFileSync(filePath, fs.readFileSync(filePath, 'utf8').replace('numeric-token-only', 'numeric-token-removed'));
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AGENTS.md missing adapter gate contract');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md missing adapter gate contract');
  });

  it('runs the full adapter gate from CI instead of relying on local-only checks', () => {
    const workflow = fs.readFileSync(testFullSuiteWorkflowPath, 'utf8');

    expect(workflow).toContain('codegraph-adapter-gate:');
    expect(workflow).toContain('npm run codegraph:adapter:gate');
    expect(workflow).toContain('concurrency:');
    expect(workflow).toContain('cancel-in-progress: true');
    expect(workflow).toContain('NANOFLOW_CODEGRAPH_GATE_LOG_DIR');
    expect(workflow).toContain('runner.temp');
    expect(workflow).toContain('${{ runner.temp }}/codegraph-adapter-gate/');
  });

  it('syncs generated overlay baseline counts back into AGENTS and adaptation docs', () => {
    const root = makeFixture({
      dynamicImportEdgesInDocs: 1,
      totalTestEdgesInDocs: 4,
    });

    const before = runValidator(root);
    expect(before.status).toBe(1);
    expect(before.stderr).toContain('AGENTS.md dynamicImportEdges expected 2, found 1');
    expect(before.stderr).toContain('docs/codegraph-nanoflow-adaptation.md totalTestEdges expected 5, found 4');

    const sync = runSync(root);

    expect(sync.status, sync.stderr || sync.stdout).toBe(0);
    expect(sync.stdout).toContain('CodeGraph overlay documentation counts synced');

    const after = runValidator(root);
    expect(after.status, after.stderr || after.stdout).toBe(0);
  });
}
