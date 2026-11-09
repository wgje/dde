import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayEdgeFunctionTestMappingNoiseSpecs(
  context: CodegraphOverlaySpecContext,
): void {
  const { runOverlay, queryOverlay, expectSpawnSuccess, tempRoots, writeFile } = context;

  it('excludes overlay harness fixtures from Supabase test mapping provenance', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-test-mapping-harness-noise-'));
    tempRoots.push(root);
    const functionName = 'transcribe';
    const entryPath = ['supabase', 'functions', functionName, 'index.ts'].join('/');
    const deployedRoute = ['/functions/v1', functionName].join('/');
    const contractSpecPath = ['src/tests/contracts', `${functionName}-edge-function.contract.spec.ts`].join('/');
    const harnessSpecPath = [
      'src/tests/scripts',
      'codegraph-nanoflow-overlay-query-edge-functions.spec-helpers.ts',
    ].join('/');

    writeFile(
      root,
      entryPath,
      [
        'Deno.serve(async (req) => {',
        '  return new Response(req.method);',
        '});',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      contractSpecPath,
      [
        `const entryPath = '${entryPath}';`,
        `const deployedRoute = '${deployedRoute}';`,
        "it('covers the real transcribe contract', () => {",
        '  expect(entryPath).toContain("transcribe");',
        '  expect(deployedRoute).toContain("transcribe");',
        '});',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      harnessSpecPath,
      [
        `const fixtureEntryPath = '${entryPath}';`,
        `const fixtureRoute = '${deployedRoute}';`,
        "it('uses these strings only to test overlay extraction fixtures', () => {",
        '  expect(fixtureEntryPath).toBeTruthy();',
        '  expect(fixtureRoute).toBeTruthy();',
        '});',
        '',
      ].join('\n'),
    );

    const overlayResult = runOverlay(root);
    const pathReferenceResult = queryOverlay(root, 'path-reference', ['--limit', '20']);

    expectSpawnSuccess(overlayResult);
    expectSpawnSuccess(pathReferenceResult);
    const overlay = JSON.parse(overlayResult.stdout);
    const edgeFunction = overlay.supabase.edgeFunctions.find((item: { name?: string }) => item.name === 'transcribe');
    expect(edgeFunction.testMappings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        file: contractSpecPath,
        testMapping: 'path-reference',
      }),
    ]));
    expect(edgeFunction.testMappings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        file: harnessSpecPath,
      }),
    ]));
    const pathReferenceResponse = JSON.parse(pathReferenceResult.stdout);
    expect(pathReferenceResponse.relatedFiles).toContain(contractSpecPath);
    expect(pathReferenceResponse.relatedFiles).not.toContain(harnessSpecPath);
  });

  it('does not map bare Edge Function names as invoke-reference test evidence', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-invoke-reference-noise-'));
    tempRoots.push(root);
    const functionName = 'transcribe';
    const entryPath = ['supabase', 'functions', functionName, 'index.ts'].join('/');
    const bareSpecPath = ['src/tests/contracts', `${functionName}-bare-name.contract.spec.ts`].join('/');
    const invokeSpecPath = ['src/tests/contracts', `${functionName}-invoke.contract.spec.ts`].join('/');

    writeFile(
      root,
      entryPath,
      [
        'Deno.serve(async (req) => {',
        '  return new Response(req.method);',
        '});',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      bareSpecPath,
      [
        "describe('bare transcribe prose', () => {",
        "  const label = 'transcribe';",
        '  it("mentions only the function name", () => {',
        "    expect(label).toBe('transcribe');",
        '  });',
        '});',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      invokeSpecPath,
      [
        "describe('invoke transcribe contract', () => {",
        '  it("calls the deployed function through Supabase Functions", async () => {',
        "    await supabase.functions.invoke('transcribe', { body: { source: 'fixture' } });",
        '  });',
        '});',
        '',
      ].join('\n'),
    );

    const overlayResult = runOverlay(root);
    const invokeResult = queryOverlay(root, 'invoke-reference', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(overlayResult);
    expectSpawnSuccess(invokeResult);
    const overlay = JSON.parse(overlayResult.stdout);
    const edgeFunction = overlay.supabase.edgeFunctions.find((item: { name?: string }) => item.name === functionName);
    expect(edgeFunction.testMappings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        file: invokeSpecPath,
        testMapping: 'invoke-reference',
        matchedNeedle: "functions.invoke('transcribe'",
      }),
    ]));
    expect(edgeFunction.testMappings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        file: bareSpecPath,
        testMapping: 'invoke-reference',
      }),
    ]));

    const invokeResponse = JSON.parse(invokeResult.stdout);
    expect(invokeResponse.relatedFiles).toContain(invokeSpecPath);
    expect(invokeResponse.relatedFiles).not.toContain(bareSpecPath);
    expect(invokeResponse.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: invokeSpecPath,
      startLine: 3,
      content: expect.stringContaining("supabase.functions.invoke('transcribe'"),
    }));
  });
}
