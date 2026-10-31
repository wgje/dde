import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { makeFixture, runValidator } from './validate-codegraph-overlay-docs.spec-helpers';

export function registerValidateCodegraphOverlayDocsFormatterDelegationSpecs(): void {
  it('fails when augmented Markdown formatter source body calls strict-native formatter logic', () => {
    const root = makeFixture();
    const overlayPath = path.join(root, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');
    const sourceText = fs.readFileSync(overlayPath, 'utf8');
    fs.writeFileSync(
      overlayPath,
      sourceText.replace(
        'function formatNativeMarkdown() {}\n',
        [
          'function formatNativeMarkdown() {',
          '  const markdown = formatStrictNativeMarkdown({ nodes: [], edges: [] });',
          '  return `${markdown}\\n## Code Context\\n### Entry Points\\n### Code`;',
          '}',
          '',
        ].join('\n'),
      ),
    );

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'docs/codegraph-nanoflow-dedup-contract.json hotspot formatNativeMarkdown() nanoflow-augmented native-markdown formatter source body must not reference strict-native formatter token formatStrictNativeMarkdown',
    );
    expect(result.stderr).toContain(
      'docs/codegraph-nanoflow-dedup-contract.json hotspot formatNativeMarkdown() nanoflow-augmented native-markdown formatter source body must not render strict-native heading ## Code Context',
    );
    expect(result.stderr).toContain(
      'docs/codegraph-nanoflow-dedup-contract.json hotspot formatNativeMarkdown() nanoflow-augmented native-markdown formatter source body must not render strict-native heading ### Entry Points',
    );
    expect(result.stderr).toContain(
      'docs/codegraph-nanoflow-dedup-contract.json hotspot formatNativeMarkdown() nanoflow-augmented native-markdown formatter source body must not render strict-native heading ### Code',
    );
  });

  it('fails when strict native Markdown formatter source body renders NanoFlow metadata', () => {
    const root = makeFixture();
    const manifestPath = path.join(root, 'docs', 'codegraph-nanoflow-dedup-contract.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      hotspots: Array<Record<string, unknown> & {
        coveredChildSymbols?: string[];
      }>;
    };
    const strictFormatter = manifest.hotspots.find(entry => entry.name === 'formatStrictNativeMarkdown()');
    if (!strictFormatter) {
      throw new Error('fixture missing formatStrictNativeMarkdown() hotspot');
    }
    strictFormatter.coveredChildSymbols = [
      ...new Set([
        ...(strictFormatter.coveredChildSymbols ?? []),
        'buildStrictNativeMarkdownRelationshipGroups',
        'formatEdgeMetadata',
      ]),
    ];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const overlayPath = path.join(root, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');
    fs.appendFileSync(
      overlayPath,
      [
        'function formatEdgeMetadata() {}',
        'function buildStrictNativeMarkdownRelationshipGroups() {',
        '  return formatEdgeMetadata({ metadata: { relation: "supabase-table-write", table: "tasks", writeOperation: "upsert" } });',
        '}',
        '',
      ].join('\n'),
    );

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'docs/codegraph-nanoflow-dedup-contract.json hotspot formatStrictNativeMarkdown() strict-native nativeMarkdown formatter source body must not reference augmented formatter token formatEdgeMetadata',
    );
    expect(result.stderr).toContain(
      'docs/codegraph-nanoflow-dedup-contract.json hotspot formatStrictNativeMarkdown() strict-native nativeMarkdown formatter source body must not reference NanoFlow metadata token relation:',
    );
    expect(result.stderr).toContain(
      'docs/codegraph-nanoflow-dedup-contract.json hotspot formatStrictNativeMarkdown() strict-native nativeMarkdown formatter source body must not reference NanoFlow metadata token table:',
    );
    expect(result.stderr).toContain(
      'docs/codegraph-nanoflow-dedup-contract.json hotspot formatStrictNativeMarkdown() strict-native nativeMarkdown formatter source body must not reference NanoFlow metadata token writeOperation',
    );
  });

  const strictCallers = ['formatStrictNativeMarkdown', 'strictNativeCodeBlockBudgetReached'] as const;
  const augmentedCallees = ['formatNativeMarkdown', 'formatNanoFlowAugmentedMarkdown'] as const;
  for (const caller of strictCallers) {
    for (const callee of augmentedCallees) {
      it(`fails when strict formatter ${caller} delegates to augmented formatter ${callee}`, () => {
        const root = makeFixture();
        const overlayPath = path.join(root, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');
        const sourceText = fs.readFileSync(overlayPath, 'utf8');
        fs.writeFileSync(
          overlayPath,
          sourceText.replace(
            `function ${caller}() {}\n`,
            `function ${caller}() { return ${callee}(); }\n`,
          ),
        );

        const result = runValidator(root);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          `docs/codegraph-nanoflow-dedup-contract.json hotspot formatStrictNativeMarkdown() strict-native nativeMarkdown formatter source body must not reference augmented formatter token ${callee}`,
        );
      });
    }
  }

  it('allows augmented Markdown formatter delegation within its augmented boundary', () => {
    const root = makeFixture();
    const overlayPath = path.join(root, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');
    const sourceText = fs.readFileSync(overlayPath, 'utf8');
    fs.writeFileSync(
      overlayPath,
      sourceText.replace(
        'function formatNativeMarkdown() {}\n',
        'function formatNativeMarkdown() { return formatNanoFlowAugmentedMarkdown(); }\n',
      ),
    );

    expect(runValidator(root).status).toBe(0);
  });

  it('allows strict native Markdown formatter delegation within its strict boundary', () => {
    const root = makeFixture();
    const overlayPath = path.join(root, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');
    const sourceText = fs.readFileSync(overlayPath, 'utf8');
    fs.writeFileSync(
      overlayPath,
      sourceText.replace(
        'function formatStrictNativeMarkdown() {}\n',
        'function formatStrictNativeMarkdown() { return strictNativeCodeBlockBudgetReached(); }\n',
      ),
    );

    expect(runValidator(root).status).toBe(0);
  });
}
