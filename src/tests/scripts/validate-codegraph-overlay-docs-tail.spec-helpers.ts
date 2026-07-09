import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

import { makeFixture, runValidator } from './validate-codegraph-overlay-docs.spec-helpers';

export function registerValidateCodegraphOverlayDocsTailSpecs(): void {
  it('does not treat self-referential global graph totals as freshness gates', () => {
    const root = makeFixture();
    const agentsPath = path.join(root, 'AGENTS.md');
    fs.writeFileSync(
      agentsPath,
      fs.readFileSync(agentsPath, 'utf8')
        .replace(/graphNodes=\d+/, 'graphNodes=4')
        .replace(/graphEdges=\d+/, 'graphEdges=4'),
    );

    const result = runValidator(root);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('CodeGraph overlay documentation validation passed');
  });

  it('fails when documented semantic edge counts drift from the overlay', () => {
    const root = makeFixture({ dynamicImportEdgesInDocs: 1 });

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AGENTS.md dynamicImportEdges expected 2, found 1');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md dynamicImportEdges expected 2, found 1');
  });

  it('fails when documented Angular route and host counts drift from the overlay', () => {
    const root = makeFixture({ angularRouteGuardEdgesInDocs: 0 });

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AGENTS.md angularRouteGuardEdges expected 1, found 0');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md angularRouteGuardEdges expected 1, found 0');
  });

  it('fails when documented Angular external resource counts drift from the overlay', () => {
    const root = makeFixture({ templateUrlEdgesInDocs: 0 });

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AGENTS.md templateUrlEdges expected 1, found 0');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md templateUrlEdges expected 1, found 0');
  });

  it('fails when documented Edge Function semantic counts drift from the overlay', () => {
    const root = makeFixture({ edgeFunctionHeaderEdgesInDocs: 0 });

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AGENTS.md edgeFunctionHeaderEdges expected 1, found 0');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md edgeFunctionHeaderEdges expected 1, found 0');
  });

  it('fails when documented Android Kotlin constructor and property counts drift from the overlay', () => {
    const root = makeFixture({
      androidKotlinConstructorsInDocs: 1,
      androidKotlinConstructorEdgesInDocs: 1,
      androidKotlinPropertiesInDocs: 1,
      androidKotlinPropertyEdgesInDocs: 1,
    });

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AGENTS.md androidKotlinConstructors expected 0, found 1');
    expect(result.stderr).toContain('AGENTS.md androidKotlinConstructorEdges expected 0, found 1');
    expect(result.stderr).toContain('AGENTS.md androidKotlinProperties expected 0, found 1');
    expect(result.stderr).toContain('AGENTS.md androidKotlinPropertyEdges expected 0, found 1');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md androidKotlinConstructors expected 0, found 1');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md androidKotlinPropertyEdges expected 0, found 1');
  });

  it('fails when documented Android Kotlin import counts drift from the overlay', () => {
    const root = makeFixture({
      androidKotlinImportsInDocs: 1,
      androidKotlinImportEdgesInDocs: 1,
    });

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AGENTS.md androidKotlinImports expected 0, found 1');
    expect(result.stderr).toContain('AGENTS.md androidKotlinImportEdges expected 0, found 1');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md androidKotlinImports expected 0, found 1');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md androidKotlinImportEdges expected 0, found 1');
  });

  it('fails when documented Android Kotlin override and type-reference counts drift from the overlay', () => {
    const root = makeFixture({
      androidKotlinOverrideEdgesInDocs: 1,
      androidKotlinTypeReferenceEdgesInDocs: 1,
    });

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AGENTS.md androidKotlinOverrideEdges expected 0, found 1');
    expect(result.stderr).toContain('AGENTS.md androidKotlinTypeReferenceEdges expected 0, found 1');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md androidKotlinOverrideEdges expected 0, found 1');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md androidKotlinTypeReferenceEdges expected 0, found 1');
  });

  it('fails when documented Android Kotlin top-level function counts drift from the overlay', () => {
    const root = makeFixture({
      androidKotlinFunctionsInDocs: 1,
      androidKotlinFunctionEdgesInDocs: 1,
    });

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AGENTS.md androidKotlinFunctions expected 0, found 1');
    expect(result.stderr).toContain('AGENTS.md androidKotlinFunctionEdges expected 0, found 1');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md androidKotlinFunctions expected 0, found 1');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md androidKotlinFunctionEdges expected 0, found 1');
  });

  it('fails when documented Android manifest and resource counts drift from the overlay', () => {
    const root = makeFixture({
      androidManifestComponentsInDocs: 1,
      androidWidgetProvidersInDocs: 1,
      androidResourceReferencesInDocs: 1,
    });

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AGENTS.md androidManifestComponents expected 0, found 1');
    expect(result.stderr).toContain('AGENTS.md androidWidgetProviders expected 0, found 1');
    expect(result.stderr).toContain('AGENTS.md androidResourceReferences expected 0, found 1');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md androidManifestComponents expected 0, found 1');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md androidWidgetProviders expected 0, found 1');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md androidResourceReferences expected 0, found 1');
  });

  it('fails when documented hard-rule semantic counts drift from the overlay', () => {
    const root = makeFixture({ hardRuleKeywordEdgesInDocs: 0 });

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AGENTS.md hardRuleKeywordEdges expected 1, found 0');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md hardRuleKeywordEdges expected 1, found 0');
  });

  it('fails when documented AGENTS node and config provenance counts drift from the overlay', () => {
    const root = makeFixture({
      hardRuleKeywordNodesInDocs: 0,
      hardRuleKeywordMappingEdgesInDocs: 0,
      hardRuleImplementationTargetsInDocs: 0,
      configRulesInDocs: 0,
      syncRuleNodesInDocs: 0,
      syncRuleKeywordNodesInDocs: 0,
      syncRuleKeywordEdgesInDocs: 0,
      configPropertyNodesInDocs: 0,
      configPropertyEdgesInDocs: 0,
      configPropertyParentEdgesInDocs: 0,
      configSourcePropertyEdgesInDocs: 0,
      syncConfigSourceEdgesInDocs: 0,
    });

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AGENTS.md hardRuleKeywordNodes expected 1, found 0');
    expect(result.stderr).toContain('AGENTS.md hardRuleKeywordMappingEdges expected 1, found 0');
    expect(result.stderr).toContain('AGENTS.md hardRuleImplementationTargets expected 1, found 0');
    expect(result.stderr).toContain('AGENTS.md configRules expected 1, found 0');
    expect(result.stderr).toContain('AGENTS.md syncRuleNodes expected 1, found 0');
    expect(result.stderr).toContain('AGENTS.md syncRuleKeywordNodes expected 1, found 0');
    expect(result.stderr).toContain('AGENTS.md syncRuleKeywordEdges expected 2, found 0');
    expect(result.stderr).toContain('AGENTS.md configPropertyNodes expected 1, found 0');
    expect(result.stderr).toContain('AGENTS.md configPropertyEdges expected 1, found 0');
    expect(result.stderr).toContain('AGENTS.md configPropertyParentEdges expected 1, found 0');
    expect(result.stderr).toContain('AGENTS.md configSourcePropertyEdges expected 1, found 0');
    expect(result.stderr).toContain('AGENTS.md syncConfigSourceEdges expected 1, found 0');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md hardRuleKeywordNodes expected 1, found 0');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md configPropertyNodes expected 1, found 0');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md syncConfigSourceEdges expected 1, found 0');
  });

  it('fails when documented policy and privilege relation counts drift from the overlay', () => {
    const root = makeFixture({
      policyRoleEdgesInDocs: 0,
      policyUsingEdgesInDocs: 0,
      policyWithCheckEdgesInDocs: 0,
      privilegeObjectEdgesInDocs: 0,
      privilegeRoleEdgesInDocs: 0,
    });

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AGENTS.md policyRoleEdges expected 1, found 0');
    expect(result.stderr).toContain('AGENTS.md policyUsingEdges expected 1, found 0');
    expect(result.stderr).toContain('AGENTS.md policyWithCheckEdges expected 1, found 0');
    expect(result.stderr).toContain('AGENTS.md privilegeObjectEdges expected 1, found 0');
    expect(result.stderr).toContain('AGENTS.md privilegeRoleEdges expected 1, found 0');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md policyRoleEdges expected 1, found 0');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md policyUsingEdges expected 1, found 0');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md policyWithCheckEdges expected 1, found 0');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md privilegeObjectEdges expected 1, found 0');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md privilegeRoleEdges expected 1, found 0');
  });

  it('fails when documented migration, policy, and privilege node counts drift from the overlay', () => {
    const root = makeFixture({
      migrationSqlFunctionFunctionNodesInDocs: 0,
      migrationTriggerEdgesInDocs: 0,
      migrationIndexNodesInDocs: 0,
      migrationConstraintNodesInDocs: 0,
      migrationTestsInDocs: 0,
      migrationTestEdgesInDocs: 0,
      policyNodesInDocs: 0,
      privilegeNodesInDocs: 0,
      privilegeObjectNodesInDocs: 0,
      privilegeRoleNodesInDocs: 0,
    });

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AGENTS.md migrationSqlFunctionFunctionNodes expected 1, found 0');
    expect(result.stderr).toContain('AGENTS.md migrationTriggerEdges expected 1, found 0');
    expect(result.stderr).toContain('AGENTS.md migrationIndexNodes expected 1, found 0');
    expect(result.stderr).toContain('AGENTS.md migrationConstraintNodes expected 1, found 0');
    expect(result.stderr).toContain('AGENTS.md migrationTests expected 1, found 0');
    expect(result.stderr).toContain('AGENTS.md migrationTestEdges expected 1, found 0');
    expect(result.stderr).toContain('AGENTS.md policyNodes expected 1, found 0');
    expect(result.stderr).toContain('AGENTS.md privilegeNodes expected 1, found 0');
    expect(result.stderr).toContain('AGENTS.md privilegeObjectNodes expected 1, found 0');
    expect(result.stderr).toContain('AGENTS.md privilegeRoleNodes expected 1, found 0');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md migrationIndexNodes expected 1, found 0');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md policyNodes expected 1, found 0');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md privilegeRoleNodes expected 1, found 0');
  });
}
