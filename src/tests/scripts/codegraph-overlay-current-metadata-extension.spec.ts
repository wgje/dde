import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import ts from 'typescript';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '../../..');
const predecessor = require('../../../scripts/lib/codegraph-nanoflow-overlay-v1-schema.cjs');
const current = require('../../../scripts/lib/codegraph-overlay-current-schema.cjs');
const contract = require('../../../scripts/contracts/codegraph-nanoflow-overlay-v1.json');
const publisher = require('../../../scripts/lib/codegraph-overlay-generation-publisher.cjs');
const reader = require('../../../scripts/lib/codegraph-overlay-current-receipt.cjs');
const source = fs.readFileSync(path.join(root, 'src/tests/scripts/codegraph-nanoflow-overlay-v1-schema.spec.ts'), 'utf8');
const ast = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true);
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node)
  && ['emptyOverlay', 'graphFileNode'].includes(node.name?.text ?? '')).map(node => node.getText(ast)).join('\n');
const helpers = vm.runInNewContext(ts.transpileModule(functions + '\n({emptyOverlay,graphFileNode})',
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
{ contract: () => contract, GENERATED_AT: '2026-08-03T00:00:00.000Z' });
const paths: string[] = [];
afterEach(() => { for (const p of paths.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });
const cases = [
  { relation: 'migration-index', table: 'public.tasks', columns: ['id'], method: 'btree',
    unique: true, concurrently: true, predicate: 'deleted_at is null' },
  { relation: 'migration-constraint-validation', table: 'public.tasks' },
];
function overlay(metadata: Record<string, unknown>, projectRoot = 'D:/fixture') {
  const value = helpers.emptyOverlay(projectRoot);
  value.typescript.files = [{ file: 'src/a.ts', language: 'typescript' }];
  const node = helpers.graphFileNode('src/a.ts', 'reference');
  node.kind = 'variable'; node.id = 'variable:src/a.ts:reference'; node.metadata = metadata;
  value.graph.nodes = [node]; return value;
}
function validate(metadata: Record<string, unknown>, currentProfile = true) {
  const validator = (currentProfile ? current.createCurrentOverlayValidator : predecessor.createOverlayV1Validator)({
    expectedProjectRoot: 'D:/fixture', expectedSourcePolicyDigest: contract.sourcePolicyDigest });
  validator.write(Buffer.from(JSON.stringify(overlay(metadata), null, 2) + '\n'));
  return validator.finish();
}
describe('registered current metadata extension and frozen predecessor', () => {
  it.each(cases)('validates exact current $relation shape with distinct identity while predecessor rejects it', metadata => {
    expect(validate(metadata).schemaDigest).toBe(current.CURRENT_SCHEMA_DIGEST);
    expect(current.CURRENT_SCHEMA_DIGEST).not.toBe(predecessor.OVERLAY_V1_SCHEMA_DIGEST);
    expect(() => validate(metadata, false)).toThrow();
  });
  it.each(cases)('rejects wrong order, unknown keys and unregistered relation for $relation', metadata => {
    expect(() => validate(Object.fromEntries(Object.entries(metadata).reverse()))).toThrow();
    expect(() => validate({ ...metadata, canary: true })).toThrow();
    expect(() => validate({ ...metadata, relation: 'unreviewed-relation' })).toThrow();
  });
  it('strictly validates real generated SQL shapes without widening the predecessor', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'current-metadata-producer-')); paths.push(dir);
    fs.mkdirSync(path.join(dir, 'supabase/migrations'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'supabase/migrations/20261127000000_shapes.sql'),
      'CREATE INDEX CONCURRENTLY task_idx ON public.tasks USING btree (id) WHERE deleted_at IS NULL;\nALTER TABLE public.tasks VALIDATE CONSTRAINT task_check;\n');
    const generated = spawnSync(process.execPath, [path.join(root, 'scripts/generate-codegraph-nanoflow-overlay.mjs'),
      '--root', dir, '--stdout', '--android-import-source', 'local', '--android-function-source', 'local'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    expect(generated.status, generated.stderr).toBe(0);
    const value = JSON.parse(generated.stdout);
    expect(value.graph.nodes.some((node: { metadata?: { relation?: string } }) =>
      node.metadata?.relation === 'migration-index')).toBe(true);
    expect(value.graph.nodes.some((node: { metadata?: { relation?: string } }) =>
      node.metadata?.relation === 'migration-constraint-validation')).toBe(true);
    const validator = current.createCurrentOverlayValidator({ expectedProjectRoot: dir.replaceAll('\\', '/'),
      expectedSourcePolicyDigest: contract.sourcePolicyDigest });
    try { validator.write(Buffer.from(generated.stdout)); } catch (error) {
      const detail = error as { code?: string; schemaPath?: string };
      throw new Error(String(detail.code) + ':' + String(detail.schemaPath));
    }
    expect(validator.finish().schemaDigest).toBe(current.CURRENT_SCHEMA_DIGEST);
    const validateGenerated = (candidate: unknown) => {
      const check = current.createCurrentOverlayValidator({ expectedProjectRoot: dir.replaceAll('\\', '/'),
        expectedSourcePolicyDigest: contract.sourcePolicyDigest });
      check.write(Buffer.from(JSON.stringify(candidate, null, 2) + '\n')); return check.finish();
    };
    for (const mutation of ['edge-order', 'edge-key', 'constraint-id']) {
      const candidate = JSON.parse(JSON.stringify(value));
      if (mutation === 'constraint-id') {
        candidate.graph.nodes.find((node: { metadata?: { relation?: string } }) =>
          node.metadata?.relation === 'migration-constraint-validation').id += ':wrong';
      } else {
        const edge = candidate.graph.edges.find((item: { metadata?: { relation?: string } }) => item.metadata?.relation === 'migration-index');
        edge.metadata = mutation === 'edge-key' ? { ...edge.metadata, canary: true }
          : Object.fromEntries(Object.entries(edge.metadata).reverse());
      }
      expect(() => validateGenerated(candidate), mutation).toThrow();
    }
  });
  it('rejects unregistered schema digest and preserves predecessor identity', () => {
    expect(() => current.selectOverlaySchemaProfile('f'.repeat(64))).toThrow('unregistered');
    expect(predecessor.OVERLAY_V1_SCHEMA_DIGEST).toBe('0cf35177cabc7261e0d8aa7040d083acc4c5c5c03a3c966a19982d35192a9e22');
  });
  it.each(cases)('publishes and strictly reads back $relation using the same registered current digest', metadata => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'current-metadata-extension-')); paths.push(dir);
    const digest = crypto.createHash('sha256').update('fixture').digest('hex');
    const lease = { barrier: { state: 'HELD', owner: 'test', fence: 1, heldEpoch: 0 },
      resource: { state: 'ACTIVE', kind: 'build', resourceId: 'codegraph-overlay-generation', owner: 'test', fence: 1, heldEpoch: 0 } };
    const result = publisher.createOverlayGenerationPublisher({ readLeaseEvidence: () => lease,
      transactionId: () => 'tx-' + 'a'.repeat(32) }).publish({ projectRoot: dir, overlay: overlay(metadata, dir),
      publishedAt: '2026-08-03T00:00:00.000Z', configDigest: digest, setupDigest: digest,
      sourceManifestDigest: digest, toolchainDigest: digest, overlaySchemaDigest: current.CURRENT_SCHEMA_DIGEST });
    expect(result.current.overlaySchemaDigest).toBe(current.CURRENT_SCHEMA_DIGEST);
    const read = reader.readOverlayCurrentReceipt(dir);
    expect(read, JSON.stringify(read)).toMatchObject({ ok: true });
    expect(read.overlay.graph.nodes[0].metadata).toEqual(metadata);
    expect(read.current.compatibilityDigest).toBe(result.current.compatibilityDigest);
    const currentPath = path.join(dir, '.codegraph/nanoflow-generations/CURRENT.json');
    const wrongProfile = { ...result.current, overlaySchemaDigest: predecessor.OVERLAY_V1_SCHEMA_DIGEST };
    const canonicalBytes = require('../../../scripts/lib/codegraph-overlay-generation-format.cjs').canonicalControlBytes;
    fs.writeFileSync(currentPath, canonicalBytes(wrongProfile));
    expect(reader.readOverlayCurrentReceipt(dir)).toMatchObject({ ok: false, errorCode: 'CURRENT_INVALID' });
  });
});
