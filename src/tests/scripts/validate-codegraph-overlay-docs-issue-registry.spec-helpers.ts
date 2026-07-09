import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

import { makeFixture, runValidator } from './validate-codegraph-overlay-docs.spec-helpers';

export function registerValidateCodegraphOverlayDocsIssueRegistrySpecs(): void {
  it('fails when the adaptation issue registry is not machine-consumable', () => {
    const root = makeFixture();
    const registryPath = path.join(root, 'docs', 'codegraph-nanoflow-adaptation-issues.md');
    fs.writeFileSync(
      registryPath,
      fs.readFileSync(registryPath, 'utf8')
        .replace('- status: fixed', '- status: maybe-fixed')
        .replace(/- verification_gate: `npm run codegraph:overlay:test`\n/, ''),
    );

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation-issues.md CG-NF-20260626-001 has invalid status maybe-fixed');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation-issues.md CG-NF-20260626-001 missing required field verification_gate');
  });

  it('fails when adaptation issue registry nested triage fields are not machine-consumable', () => {
    const root = makeFixture();
    const registryPath = path.join(root, 'docs', 'codegraph-nanoflow-adaptation-issues.md');
    fs.writeFileSync(
      registryPath,
      fs.readFileSync(registryPath, 'utf8')
        .replace('- query_surface: nanoflow_context_pack | adapter-context-cli', '- query_surface: nanoflow_context_pack | mystery-surface')
        .replace('  - mcp_result: success\n', '')
        .replace('- doc_update_needed: no', '- doc_update_needed: maybe'),
    );

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation-issues.md CG-NF-20260626-001 field query_surface has invalid value mystery-surface');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation-issues.md CG-NF-20260626-001 missing required nested field freshness_checks.mcp_result');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation-issues.md CG-NF-20260626-001 field doc_update_needed has invalid value maybe');
  });

  it('fails when adaptation issue registry nested fields are duplicated or unknown', () => {
    const root = makeFixture();
    const registryPath = path.join(root, 'docs', 'codegraph-nanoflow-adaptation-issues.md');
    fs.writeFileSync(
      registryPath,
      fs.readFileSync(registryPath, 'utf8')
        .replace(
          '  - mcp_result: success\n',
          '  - mcp_result: success\n  - mcp_result: failed\n  - guard_hint: inspect stale wrapper\n',
        )
        .replace(
          '  - output_summary: fixture output summary\n',
          '  - output_summary: fixture output summary\n  - output_summary: duplicate summary\n  - raw_notes: loose prose\n',
        ),
    );

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation-issues.md CG-NF-20260626-001 duplicate nested field evidence.output_summary');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation-issues.md CG-NF-20260626-001 unknown nested field evidence.raw_notes');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation-issues.md CG-NF-20260626-001 duplicate nested field freshness_checks.mcp_result');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation-issues.md CG-NF-20260626-001 unknown nested field freshness_checks.guard_hint');
  });

  it('ignores the adaptation issue entry template after the final real issue', () => {
    const root = makeFixture();
    const registryPath = path.join(root, 'docs', 'codegraph-nanoflow-adaptation-issues.md');
    fs.appendFileSync(
      registryPath,
      [
        '## Entry Template',
        '',
        '```markdown',
        '## CG-NF-YYYYMMDD-001: Short query failure title',
        '',
        '- status: open',
        '- reported_at: YYYY-MM-DD',
        '- query: `<exact query or command>`',
        '- verification_gate: `<exact command that must pass after repair>`',
        '```',
        '',
      ].join('\n'),
    );

    const result = runValidator(root);

    expect(result.status, result.stderr).toBe(0);
  });

  it('fails when a real adaptation issue keeps template placeholders', () => {
    const root = makeFixture();
    const registryPath = path.join(root, 'docs', 'codegraph-nanoflow-adaptation-issues.md');
    fs.writeFileSync(
      registryPath,
      fs.readFileSync(registryPath, 'utf8')
        .replace('- query: `fixture query`', '- query: `<exact query or command>`')
        .replace('- verification_gate: `npm run codegraph:overlay:test`', '- verification_gate: `<exact command that must pass after repair>`'),
    );

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation-issues.md CG-NF-20260626-001 field query contains template placeholder');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation-issues.md CG-NF-20260626-001 field verification_gate contains template placeholder');
  });

  it('fails when adaptation issue registry fields are ambiguous or not concrete', () => {
    const root = makeFixture();
    const registryPath = path.join(root, 'docs', 'codegraph-nanoflow-adaptation-issues.md');
    const duplicateIssue = [
      '',
      '## CG-NF-20260626-001: Duplicate fixture id',
      '',
      '- status: fixed',
      '- reported_at: 2026-06-26',
      '- reporter: codex-agent',
      '- feature_scope: duplicate',
      '- query_surface: docs-validator',
      '- query: `npm run codegraph:overlay:docs:validate`',
      '- expected: duplicate ids should fail',
      '- actual: duplicate ids failed',
      '- evidence:',
      '  - docs_contract: duplicate',
      '  - output_summary: duplicate',
      '  - log_guard: duplicate',
      '- freshness_checks:',
      '  - mcp_result: not-run',
      '  - adapter_fallback_result: not-run',
      '  - wrapper_stale: unknown',
      '  - overlay_stale: unknown',
      '  - transport_failure: unknown',
      '- likely_root_cause: docs-overpromise',
      '- repair_target: docs',
      '- doc_update_needed: yes',
      '- verification_gate: `npm run codegraph:overlay:docs:validate`',
      '',
    ].join('\n');
    const registry = fs.readFileSync(registryPath, 'utf8')
        .replace('- reported_at: 2026-06-26', '- reported_at: 2026-99-99')
        .replace('- reporter: codex-agent', '- reporter: codex-agent\n- reporter: duplicate-agent\n- root_cause_notes: loose prose')
        .replace('- verification_gate: `npm run codegraph:overlay:test`', '- verification_gate: `todo`');
    fs.writeFileSync(registryPath, `${registry}${duplicateIssue}`);

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation-issues.md duplicate issue id CG-NF-20260626-001');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation-issues.md CG-NF-20260626-001 duplicate field reporter');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation-issues.md CG-NF-20260626-001 unknown field root_cause_notes');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation-issues.md CG-NF-20260626-001 reported_at must be an ISO YYYY-MM-DD date');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation-issues.md CG-NF-20260626-001 verification_gate must be a concrete command');
  });

  it('fails when adaptation issue registry verification and freshness gates are inconsistent', () => {
    const root = makeFixture();
    const registryPath = path.join(root, 'docs', 'codegraph-nanoflow-adaptation-issues.md');
    fs.writeFileSync(
      registryPath,
      fs.readFileSync(registryPath, 'utf8')
        .replace('- verification_gate: `npm run codegraph:overlay:test`', '- verification_gate: `npm run codegraph:no-such-script`')
        .replace('  - mcp_result: success', '  - mcp_result: not-run')
        .replace('  - adapter_fallback_result: success', '  - adapter_fallback_result: not-run'),
    );

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation-issues.md CG-NF-20260626-001 verification_gate references missing npm script codegraph:no-such-script');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation-issues.md CG-NF-20260626-001 freshness_checks.mcp_result cannot be not-run for MCP query surfaces');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation-issues.md CG-NF-20260626-001 freshness_checks.adapter_fallback_result cannot be not-run for adapter fallback query surfaces');
  });
}
