'use strict';

const ts = require('typescript');

function installIssueContractValidator(runtime) {
  const {
    fs, path, root, errors,
    ISSUE_REGISTRY_ALLOWED_STATUSES, ISSUE_REGISTRY_OPEN_STATUSES, ISSUE_REGISTRY_CLOSED_STATUSES, ISSUE_REGISTRY_REQUIRED_FIELDS,
    ISSUE_REGISTRY_ALLOWED_FIELDS, ISSUE_REGISTRY_REQUIRED_NESTED_FIELDS, ISSUE_REGISTRY_ALLOWED_QUERY_SURFACES, ISSUE_REGISTRY_ALLOWED_ROOT_CAUSES,
    ISSUE_REGISTRY_ALLOWED_REPAIR_TARGETS, ISSUE_REGISTRY_ALLOWED_DOC_UPDATE_VALUES, ISSUE_REGISTRY_ALLOWED_FRESHNESS_VALUES, VERIFICATION_GATE_COMMAND_PATTERN,
    NON_CONCRETE_VERIFICATION_GATE_PATTERN, STRICT_NATIVE_SOURCE_EVIDENCE_REQUIRED_TERMS
  } = runtime;

  function readJson(relativePath) {
    return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
  }

  function readText(relativePath) {
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
  }

  let packageScriptsCache;
  function getPackageScripts() {
    if (packageScriptsCache !== undefined) return packageScriptsCache;
    try {
      packageScriptsCache = readJson('package.json').scripts ?? {};
    } catch {
      packageScriptsCache = {};
    }
    return packageScriptsCache;
  }

  function formatNumber(value) {
    return Number(value).toLocaleString('en-US');
  }

  function readFirstNumber(text, pattern, label, file) {
    const match = pattern.exec(text);
    if (!match) {
      errors.push(`${file} missing ${label}`);
      return null;
    }
    return Number(match[1].replace(/,/g, ''));
  }

  function readInlineCounter(text, label) {
    const match = new RegExp(`${escapeRegex(label)}=([\\d,]+)`).exec(text);
    return match ? Number(match[1].replace(/,/g, '')) : null;
  }

  function readInlineCounters(text, labels) {
    const values = {};
    for (const label of labels) {
      const value = readInlineCounter(text, label);
      if (value === null) return null;
      values[label] = value;
    }
    return values;
  }

  function expectNumber(file, label, expected, actual) {
    if (actual === null) return;
    if (actual !== expected) {
      errors.push(`${file} ${label} expected ${expected}, found ${actual}`);
    }
  }

  function expectEveryNumber(file, label, expected, text, pattern) {
    for (const match of text.matchAll(pattern)) {
      expectNumber(file, label, expected, Number(match[1].replace(/,/g, '')));
    }
  }


  function validateQueryPathRelevanceContract(text, file) {
    const required = [
      'query-path relevance',
      'context-json nodes',
      'strict native Markdown',
      'relatedFiles',
      'entryPoints',
      'codeBlocks',
      'vitest services config mts',
    ];
    const missing = required.filter(term => !text.includes(term));
    if (missing.length > 0) {
      errors.push(`${file} missing query-path relevance contract: ${missing.join(', ')}`);
    }
  }

  function validateCodexMcpConfigContract(text, file) {
    const required = [
      'Codex',
      'C:\\Users\\MI\\.codex\\config.toml',
      'D:\\Code\\dde\\.codex\\config.toml',
      'overrides',
      'codegraph:adapter:doctor',
      'adapter-first',
      'do not read or fall back',
      'not the active CodeGraph MCP',
      'must not be edited, repaired, or diagnosed',
      'NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS',
      'NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE',
    ];
    if (file === 'docs/codegraph-nanoflow-adaptation.md') {
      required.push(
        'mcpConfig: source=codex',
        'NANOFLOW_CODEGRAPH_CODEX_CONFIG',
      );
    }
    const staleUserPrimaryPatterns = [
      /Codex sessions use C:\\Users\\MI\\\.codex\\config\.toml as the current MCP source/i,
      /Active wrapper, CodeGraph target, and MCP environment changes belong in C:\\Users\\MI\\\.codex\\config\.toml/i,
    ];
    if (staleUserPrimaryPatterns.some(pattern => pattern.test(text))) {
      errors.push(`${file} conflicting Codex MCP config scope: D:\\Code\\dde\\.codex\\config.toml overrides C:\\Users\\MI\\.codex\\config.toml for this repository`);
    }
    const missing = required.filter(term => !text.includes(term));
    const forbidden = [];
    if (text.includes('may the adapter fall back to .vscode/mcp.json')) {
      forbidden.push('adapter may fall back to .vscode/mcp.json');
    }
    if (text.includes('only fall back to `.vscode/mcp.json`')) {
      forbidden.push('adapter only falls back to .vscode/mcp.json');
    }
    if (text.includes('falling back to `.vscode/mcp.json`')) {
      forbidden.push('adapter falls back to .vscode/mcp.json');
    }
    if (file === 'docs/codegraph-nanoflow-adaptation.md') {
      if (text.includes('The doctor reports `.vscode/mcp.json` under `mcpConfig`')) {
        forbidden.push('doctor reports .vscode/mcp.json as current mcpConfig source');
      }
      if (text.includes('The smoke starts the configured\n`.vscode/mcp.json` CodeGraph target')) {
        forbidden.push('smoke starts .vscode/mcp.json as current target');
      }
    }
    if (missing.length > 0 || forbidden.length > 0) {
      errors.push(`${file} missing Codex MCP config contract: ${[...missing, ...forbidden].join(', ')}`);
    }
  }

  function validateStrictNativeSourceEvidenceContract(text, file) {
    const missing = STRICT_NATIVE_SOURCE_EVIDENCE_REQUIRED_TERMS.filter(term => !text.includes(term));
    if (missing.length > 0) {
      errors.push(`${file} missing strict native source evidence contract: ${missing.join(', ')}`);
    }
  }
  function validateStrictNativeOutputOrderContract(text, file) {
    const required = [
      'strict native output order',
      'query/summary/entryPoints/nodes/edges/codeBlocks/relatedFiles/stats',
      'Code Context -> Entry Points -> Relationships -> Related Symbols -> Code',
      'field order',
      'section order',
    ];
    const missing = required.filter(term => !text.includes(term));
    if (missing.length > 0) {
      errors.push(`${file} missing strict native output order contract: ${missing.join(', ')}`);
    }
  }
  function validateStrictNativeObjectProjectionContract(text, file) {
    const required = [
      'strict native object projection',
      'id/kind/name/qualifiedName/filePath/language/startLine/endLine/signature/docstring/visibility/isExported/isAsync/isStatic/isAbstract',
      'source/target/kind/line/column',
      'filePath/startLine/endLine/language/content/nodeName/nodeKind',
      'metadata/provenance/sourceName/targetName',
    ];
    const missing = required.filter(term => !text.includes(term));
    if (missing.length > 0) {
      errors.push(`${file} missing strict native object projection contract: ${missing.join(', ')}`);
    }
  }
  function validateAdapterGateContract(text, file) {
    const required = [
      'codegraph:adapter:gate',
      'codegraph:adapter:context',
      'codegraph:overlay:validate',
      'codegraph:overlay:sync',
      'codegraph:adapter:infra:test',
      'codegraph:adapter:preflight',
      'codegraph:adapter:quick-gate',
      'codegraph:adapter:context:packaged-artifacts',
      'codegraph:overlay:baseline:manifest',
      'codegraph:overlay:test',
      'codegraph:mcp:smoke',
      'codegraph:mcp:stale-smoke',
      'codegraph:mcp:log:guard',
      'codegraph-adapter-gate-mcp-wrapper.log',
      'codegraph-adapter-gate-stale-mcp-wrapper.log',
      '--fail-on-current-autosync-disabled',
      '--fail-on-stale-current-wrapper',
      '--fail-on-active-stale-wrappers',
      '--fail-on-untrusted-direct-mcp',
      'strict native JSON',
      'strict native Markdown',
      'NANOFLOW_CODEGRAPH_GATE_STEP_TIMEOUT_MS',
      'bounded captured output',
      'descendant',
    ];
    if (getPackageScripts()['codegraph:overlay:stable']) required.push(
      'codegraph:overlay:stable', 'codegraph:overlay:docs:assert-clean', 'codegraph:overlay:docs:recover', 'stable overlay transaction',
      'exactly two builds', 'source manifest path/size/SHA-256', 'generatedAt', 'node.updatedAt',
      'numeric-token-only', 'overlay publication is atomic separately', 'recoverable two-document transaction',
    );
    const missing = required.filter(term => !text.includes(term));
    if (missing.length > 0) {
      errors.push(`${file} missing adapter gate contract: ${missing.join(', ')}`);
    }
  }
  function validateAdapterFirstFallbackContract(text, file) {
    const required = [
      'adapter-first',
      'NanoFlow adapter CLI fallback',
      'codegraph:adapter:context',
      'nanoflow_context_pack',
      'nanoflow_overlay_query',
      'codegraph:overlay:query',
      '--skip-refresh',
      'final native CodeGraph CLI',
      '@colbymchenry/codegraph@1.6.2',
      'only a locator',
    ];
    const missing = required.filter(term => !text.includes(term));
    if (missing.length > 0) {
      errors.push(`${file} missing adapter-first fallback contract: ${missing.join(', ')}`);
    }
  }

  function validateUpstreamCodeGraphBoundaryContract(text, file) {
    const required = [
      'upstream CodeGraph fixed version',
      '@colbymchenry/codegraph@1.6.2',
      '--codegraph-target @colbymchenry/codegraph@<new-version>',
      'delegates generic TypeScript symbol/import/export/call/impact',
      'native Markdown/JSON formatter section order',
      'strict native output projection',
      'context exploration source ordering',
      'must not reimplement native auto-sync, indexing, generic search ranking, or callers/callees/impact',
      'NanoFlow overlay owns only project-specific semantics, output-quality policy, Codex host reliability, and repository hard-rule anchors',
    ];
    const missing = required.filter(term => !text.includes(term));
    if (missing.length > 0) {
      errors.push(`${file} missing upstream CodeGraph boundary contract: ${missing.join(', ')}`);
    }

    const dedupAuditRequired = [
      'De-duplication hotspot audit backlog',
      'collectTypeScript()',
      'buildNativeGraph()',
      'buildImportAliasIndex()',
      'buildExportTargetIndex()',
      'resolveReferenceNodeId()',
      'addTypeScriptCallableEdges()',
      'collectAndroid()',
      'readAndroidKotlinFileSymbols()',
      'readAndroidKotlinMethodCalls()',
      'resolveAndroidKotlinCallTarget()',
      'resolveAndroidKotlinTypeTarget()',
      'addAndroidKotlinTypeReferenceEdges()',
      'addAndroidKotlinOverrideEdges()',
      'addAndroidKotlinAnnotationEdges()',
      'queryOverlay()',
      'scoreCandidate()',
      'selectGraphResults()',
      'formatStrictNativeMarkdown()',
      'formatNativeMarkdown()',
      'contextPackSourceRankingQueryFor()',
      'sanitizeContextPackBaseMarkdownSections()',
      'temporary allowed',
      'attach NanoFlow metadata.relation',
      'delegated upstream owner',
      'formatter duplicate hotspot',
      'source-ordering duplicate hotspot',
      'docs/codegraph-nanoflow-dedup-contract.json',
      'removal trigger',
      'verification gate',
      'codegraph:overlay:docs:validate',
      'codegraph:adapter:gate',
    ];
    const missingDedupAudit = dedupAuditRequired.filter(term => !text.includes(term));
    if (missingDedupAudit.length > 0) {
      errors.push(`${file} missing upstream CodeGraph de-duplication audit contract: ${missingDedupAudit.join(', ')}`);
    }
  }


  function validateSingleSharedTreeFreshnessContract(text, file) {
    const required = [
      'single shared tree',
      'freshness and multi-agent conflict handling',
      'pending index sync',
      'latest changed files',
      'current disk contents',
      'git status --short',
      'git diff --name-only',
      'claim file set',
      'file lease',
      'skipRefresh=true',
      'NANOFLOW_OVERLAY_SKIP_REFRESH=1',
      'codegraph:overlay:validate',
    ];
    const missing = required.filter(term => !text.includes(term));
    if (missing.length > 0) {
      errors.push(`${file} missing single shared tree freshness contract: ${missing.join(', ')}`);
    }
  }

  function validateLocalCodeGraphSourceSetup(text, file) {
    const sectionMatch = /## Local CodeGraph Source Setup[\s\S]*?(?=\n## |\s*$)/.exec(text);
    if (!sectionMatch) return;
    const section = sectionMatch[0];
    if (!/cd\s+D:\\Code\\tools\\codegraph/i.test(section)) return;
    const rawNanoFlowOverlayScript = /(?:^|\n)\s*npm\s+run\s+codegraph:overlay\b/i.test(section);
    const explicitNanoFlowOverlayScript = /npm\s+--prefix\s+D:\\Code\\dde\s+run\s+codegraph:overlay\b/i.test(section)
      || /(?:Push-Location|Set-Location|cd)\s+D:\\Code\\dde[\s\S]*?npm\s+run\s+codegraph:overlay\b/i.test(section);
    if (rawNanoFlowOverlayScript && !explicitNanoFlowOverlayScript) {
      errors.push(`${file} Local CodeGraph Source Setup must run NanoFlow npm scripts with D:\\Code\\dde cwd or --prefix`);
    }
  }

  function validateIssueRegistry(text) {
    const file = 'docs/codegraph-nanoflow-adaptation-issues.md';
    const openStart = text.indexOf('## Open Issues');
    const fixedStart = text.indexOf('## Fixed Issues');
    if (openStart < 0) {
      errors.push(`${file} missing ## Open Issues section`);
    }
    if (fixedStart < 0) {
      errors.push(`${file} missing ## Fixed Issues section`);
    }
    if (openStart >= 0 && fixedStart >= 0 && openStart > fixedStart) {
      errors.push(`${file} must list ## Open Issues before ## Fixed Issues`);
    }

    const issues = parseIssueRegistryEntries(text);
    const openIssueIds = [];
    const seenIssueIds = new Map();
    for (const issue of issues) {
      if (seenIssueIds.has(issue.id)) {
        errors.push(`${file} duplicate issue id ${issue.id}`);
      } else {
        seenIssueIds.set(issue.id, issue.start);
      }
      validateIssueRegistryEntry(file, issue, openStart, fixedStart);
      if (ISSUE_REGISTRY_OPEN_STATUSES.has(issue.fields.status)) {
        openIssueIds.push(issue.id);
      }
    }

    const openSection = openStart >= 0
      ? text.slice(openStart, fixedStart >= 0 ? fixedStart : undefined)
      : '';
    const openSectionSaysEmpty = /No active issues are recorded yet\./.test(openSection);
    if (openIssueIds.length > 0 && openSectionSaysEmpty) {
      errors.push(`${file} Open Issues says no active issues but contains open issue ids: ${openIssueIds.join(', ')}`);
    }
    if (openIssueIds.length === 0 && !openSectionSaysEmpty) {
      errors.push(`${file} Open Issues must say "No active issues are recorded yet." when no open issues exist`);
    }
  }

  function parseIssueRegistryEntries(text) {
    const headers = [...text.matchAll(/^##\s+(.+)$/gm)];
    return headers
      .map((match, index) => {
        const issueMatch = /^(CG-NF-\d{8}-\d{3}):\s+(.+)$/.exec(match[1]);
        if (!issueMatch) return null;
        const start = match.index ?? 0;
        const end = index + 1 < headers.length ? headers[index + 1].index ?? text.length : text.length;
        return {
          id: issueMatch[1],
          title: issueMatch[2],
          start,
          block: text.slice(start, end),
        };
      })
      .filter(Boolean)
      .map(issue => ({
        ...issue,
        fields: parseIssueRegistryFields(issue.block),
        fieldDiagnostics: parseIssueRegistryFieldDiagnostics(issue.block),
        nestedFields: {
          evidence: parseIssueRegistryNestedFields(issue.block, 'evidence'),
          freshness_checks: parseIssueRegistryNestedFields(issue.block, 'freshness_checks'),
        },
        nestedFieldDiagnostics: {
          evidence: parseIssueRegistryNestedFieldDiagnostics(issue.block, 'evidence'),
          freshness_checks: parseIssueRegistryNestedFieldDiagnostics(issue.block, 'freshness_checks'),
        },
      }));
  }

  function parseIssueRegistryFields(block) {
    const fields = {};
    for (const match of block.matchAll(/^- ([a-z_]+):\s*(.*)$/gm)) {
      fields[match[1]] = match[2].trim();
    }
    return fields;
  }

  function parseIssueRegistryFieldDiagnostics(block) {
    const counts = new Map();
    const duplicateFields = new Set();
    const unknownFields = new Set();
    for (const match of block.matchAll(/^- ([a-z_]+):\s*(.*)$/gm)) {
      const field = match[1];
      const count = counts.get(field) ?? 0;
      counts.set(field, count + 1);
      if (count > 0) {
        duplicateFields.add(field);
      }
      if (!ISSUE_REGISTRY_ALLOWED_FIELDS.has(field)) {
        unknownFields.add(field);
      }
    }
    return {
      duplicateFields: [...duplicateFields],
      unknownFields: [...unknownFields],
    };
  }

  function parseIssueRegistryNestedFields(block, parentField) {
    const lines = String(block ?? '').split(/\r?\n/);
    const fields = {};
    let inSection = false;
    for (const line of lines) {
      if (new RegExp(`^- ${escapeRegex(parentField)}:\\s*$`).test(line)) {
        inSection = true;
        continue;
      }
      if (!inSection) continue;
      if (/^- [a-z_]+:/.test(line) || /^##\s+/.test(line)) {
        break;
      }
      const nestedMatch = /^  - ([a-z_]+):\s*(.*)$/.exec(line);
      if (nestedMatch) {
        fields[nestedMatch[1]] = nestedMatch[2].trim();
      }
    }
    return fields;
  }

  function parseIssueRegistryNestedFieldDiagnostics(block, parentField) {
    const lines = String(block ?? '').split(/\r?\n/);
    const counts = new Map();
    const duplicateFields = new Set();
    const unknownFields = new Set();
    const allowedFields = new Set(ISSUE_REGISTRY_REQUIRED_NESTED_FIELDS[parentField] ?? []);
    let inSection = false;
    for (const line of lines) {
      if (new RegExp(`^- ${escapeRegex(parentField)}:\\s*$`).test(line)) {
        inSection = true;
        continue;
      }
      if (!inSection) continue;
      if (/^- [a-z_]+:/.test(line) || /^##\s+/.test(line)) {
        break;
      }
      const nestedMatch = /^  - ([a-z_]+):\s*(.*)$/.exec(line);
      if (!nestedMatch) continue;
      const field = nestedMatch[1];
      const count = counts.get(field) ?? 0;
      counts.set(field, count + 1);
      if (count > 0) {
        duplicateFields.add(field);
      }
      if (!allowedFields.has(field)) {
        unknownFields.add(field);
      }
    }
    return {
      duplicateFields: [...duplicateFields],
      unknownFields: [...unknownFields],
    };
  }

  function validateIssueRegistryEntry(file, issue, openStart, fixedStart) {
    for (const field of issue.fieldDiagnostics?.duplicateFields ?? []) {
      errors.push(`${file} ${issue.id} duplicate field ${field}`);
    }
    for (const field of issue.fieldDiagnostics?.unknownFields ?? []) {
      errors.push(`${file} ${issue.id} unknown field ${field}`);
    }
    for (const field of ISSUE_REGISTRY_REQUIRED_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(issue.fields, field)) {
        errors.push(`${file} ${issue.id} missing required field ${field}`);
      }
    }
    const status = issue.fields.status;
    if (!ISSUE_REGISTRY_ALLOWED_STATUSES.has(status)) {
      errors.push(`${file} ${issue.id} has invalid status ${status || '(missing)'}`);
    }
    if (
      Object.prototype.hasOwnProperty.call(issue.fields, 'reported_at')
      && !isValidIsoDate(issue.fields.reported_at)
    ) {
      errors.push(`${file} ${issue.id} reported_at must be an ISO YYYY-MM-DD date`);
    }
    if (Object.prototype.hasOwnProperty.call(issue.fields, 'verification_gate') && !issue.fields.verification_gate) {
      errors.push(`${file} ${issue.id} verification_gate must not be empty`);
    }
    if (
      Object.prototype.hasOwnProperty.call(issue.fields, 'verification_gate')
      && issue.fields.verification_gate
      && !isConcreteVerificationGate(issue.fields.verification_gate)
    ) {
      errors.push(`${file} ${issue.id} verification_gate must be a concrete command`);
    }
    validateIssueRegistryVerificationGate(file, issue);
    validateIssueRegistryEnumList(file, issue.id, 'query_surface', issue.fields.query_surface, ISSUE_REGISTRY_ALLOWED_QUERY_SURFACES);
    validateIssueRegistryEnumList(file, issue.id, 'likely_root_cause', issue.fields.likely_root_cause, ISSUE_REGISTRY_ALLOWED_ROOT_CAUSES);
    validateIssueRegistryEnumList(file, issue.id, 'repair_target', issue.fields.repair_target, ISSUE_REGISTRY_ALLOWED_REPAIR_TARGETS);
    validateIssueRegistryEnumValue(file, issue.id, 'doc_update_needed', issue.fields.doc_update_needed, ISSUE_REGISTRY_ALLOWED_DOC_UPDATE_VALUES);
    validateIssueRegistryNestedFields(file, issue);
    validateIssueRegistryFreshnessConsistency(file, issue);
    for (const field of ISSUE_REGISTRY_REQUIRED_FIELDS) {
      if (
        Object.prototype.hasOwnProperty.call(issue.fields, field)
        && hasIssueRegistryPlaceholder(issue.fields[field])
      ) {
        errors.push(`${file} ${issue.id} field ${field} contains template placeholder`);
      }
    }
    if (ISSUE_REGISTRY_OPEN_STATUSES.has(status) && fixedStart >= 0 && issue.start > fixedStart) {
      errors.push(`${file} ${issue.id} has open status ${status} but is listed under Fixed Issues`);
    }
    if (ISSUE_REGISTRY_CLOSED_STATUSES.has(status) && openStart >= 0 && fixedStart >= 0 && issue.start > openStart && issue.start < fixedStart) {
      errors.push(`${file} ${issue.id} has closed status ${status} but is listed under Open Issues`);
    }
  }

  function validateIssueRegistryNestedFields(file, issue) {
    for (const [parentField, requiredFields] of Object.entries(ISSUE_REGISTRY_REQUIRED_NESTED_FIELDS)) {
      const nestedFields = issue.nestedFields?.[parentField] ?? {};
      const diagnostics = issue.nestedFieldDiagnostics?.[parentField] ?? {};
      for (const nestedField of diagnostics.duplicateFields ?? []) {
        errors.push(`${file} ${issue.id} duplicate nested field ${parentField}.${nestedField}`);
      }
      for (const nestedField of diagnostics.unknownFields ?? []) {
        errors.push(`${file} ${issue.id} unknown nested field ${parentField}.${nestedField}`);
      }
      for (const nestedField of requiredFields) {
        if (!Object.prototype.hasOwnProperty.call(nestedFields, nestedField)) {
          errors.push(`${file} ${issue.id} missing required nested field ${parentField}.${nestedField}`);
          continue;
        }
        if (hasIssueRegistryPlaceholder(nestedFields[nestedField])) {
          errors.push(`${file} ${issue.id} field ${parentField}.${nestedField} contains template placeholder`);
        }
        if (parentField === 'freshness_checks') {
          validateIssueRegistryEnumValue(
            file,
            issue.id,
            `${parentField}.${nestedField}`,
            nestedFields[nestedField],
            ISSUE_REGISTRY_ALLOWED_FRESHNESS_VALUES[nestedField],
          );
        }
      }
    }
  }

  function validateIssueRegistryVerificationGate(file, issue) {
    const value = issue.fields.verification_gate;
    if (!value) return;
    const command = unwrapBacktickValue(value);
    const scripts = getPackageScripts();
    for (const scriptName of extractNpmRunScripts(command)) {
      if (!Object.prototype.hasOwnProperty.call(scripts, scriptName)) {
        errors.push(`${file} ${issue.id} verification_gate references missing npm script ${scriptName}`);
      }
    }
  }

  function extractNpmRunScripts(command) {
    const scripts = [];
    const pattern = /\bnpm\b(?:\s+(?:--[^\s;`]+|-[^\s;`]+))*\s+run\s+([^\s;`]+)/g;
    for (const match of command.matchAll(pattern)) {
      const scriptName = String(match[1] ?? '').replace(/^['"]|['"]$/g, '').trim();
      if (scriptName) {
        scripts.push(scriptName);
      }
    }
    return scripts;
  }

  function validateIssueRegistryFreshnessConsistency(file, issue) {
    const surfaces = splitIssueRegistryList(issue.fields.query_surface);
    const freshness = issue.nestedFields?.freshness_checks ?? {};
    const usesMcp = surfaces.some(surface => surface === 'nanoflow_context_pack' || surface === 'nanoflow_overlay_query');
    const usesAdapterFallback = surfaces.some(surface => surface === 'adapter-context-cli' || surface === 'overlay-query-cli');
    if (usesMcp && freshness.mcp_result === 'not-run') {
      errors.push(`${file} ${issue.id} freshness_checks.mcp_result cannot be not-run for MCP query surfaces`);
    }
    if (usesAdapterFallback && freshness.adapter_fallback_result === 'not-run') {
      errors.push(`${file} ${issue.id} freshness_checks.adapter_fallback_result cannot be not-run for adapter fallback query surfaces`);
    }
    if (
      (freshness.mcp_result === 'failed' || freshness.mcp_result === 'not-available')
      && freshness.adapter_fallback_result === 'not-run'
    ) {
      errors.push(`${file} ${issue.id} freshness_checks.adapter_fallback_result cannot be not-run when MCP failed or was unavailable`);
    }
    if (
      freshness.transport_failure === 'yes'
      && !splitIssueRegistryList(issue.fields.likely_root_cause).includes('transport')
    ) {
      errors.push(`${file} ${issue.id} transport_failure=yes requires likely_root_cause to include transport`);
    }
  }

  function splitIssueRegistryList(value) {
    return String(value ?? '')
      .split('|')
      .map(part => part.trim())
      .filter(Boolean);
  }

  function validateIssueRegistryEnumList(file, issueId, field, value, allowedValues) {
    if (value === undefined) return;
    const values = String(value)
      .split('|')
      .map(part => part.trim())
      .filter(Boolean);
    if (values.length === 0) {
      errors.push(`${file} ${issueId} field ${field} must list at least one value`);
      return;
    }
    for (const item of values) {
      validateIssueRegistryEnumValue(file, issueId, field, item, allowedValues);
    }
  }

  function validateIssueRegistryEnumValue(file, issueId, field, value, allowedValues) {
    if (value === undefined || !allowedValues) return;
    const normalizedValue = String(value ?? '').trim();
    if (!allowedValues.has(normalizedValue)) {
      errors.push(`${file} ${issueId} field ${field} has invalid value ${normalizedValue || '(empty)'}`);
    }
  }

  function hasIssueRegistryPlaceholder(value) {
    const text = String(value ?? '');
    return /<[^>]+>|\bYYYY-MM-DD\b|\bYYYYMMDD\b/.test(text);
  }

  function isValidIsoDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim());
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year
      && date.getUTCMonth() === month - 1
      && date.getUTCDate() === day;
  }

  function isConcreteVerificationGate(value) {
    const command = unwrapBacktickValue(value);
    if (!command || NON_CONCRETE_VERIFICATION_GATE_PATTERN.test(command)) {
      return false;
    }
    return VERIFICATION_GATE_COMMAND_PATTERN.test(command);
  }

  function unwrapBacktickValue(value) {
    const raw = String(value ?? '').trim();
    return raw.startsWith('`') && raw.endsWith('`')
      ? raw.slice(1, -1).trim()
      : raw;
  }

  function escapeRegex(value) {
    return String(value).replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }


  function extractFunctionBody(sourceText, symbolName) {
    return extractFunctionBodies(sourceText, symbolName)[0] ?? null;
  }

  function extractFunctionBodies(sourceText, symbolName) {
    const source = parseJavaScript(sourceText);
    const bodies = [];
    function visit(node) {
      const body = functionBodyForSymbol(node, symbolName);
      if (body) bodies.push(functionBodyText(source, body));
      ts.forEachChild(node, visit);
    }
    visit(source);
    return bodies;
  }

  function parseJavaScript(sourceText) {
    return ts.createSourceFile(
      'codegraph-overlay-validator-source.ts', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
    );
  }

  function functionBodyForSymbol(node, symbolName) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === symbolName) return node.body;
    if (!ts.isVariableDeclaration(node) || !node.initializer) return null;
    const initializer = node.initializer;
    if (!ts.isFunctionExpression(initializer) && !ts.isArrowFunction(initializer)) return null;
    const variableMatches = ts.isIdentifier(node.name) && node.name.text === symbolName;
    const functionMatches = ts.isFunctionExpression(initializer) && initializer.name?.text === symbolName;
    return variableMatches || functionMatches ? initializer.body : null;
  }

  function functionBodyText(source, body) {
    if (ts.isBlock(body)) {
      return source.text.slice(body.getStart(source) + 1, body.end - 1);
    }
    return body.getText(source);
  }

  function extractModuleSpecifiers(sourceText) {
    const source = parseJavaScript(sourceText);
    const specifiers = [];
    function addSpecifier(node) {
      if (node && ts.isStringLiteralLike(node)) specifiers.push(node.text);
    }
    function visit(node) {
      if (ts.isImportDeclaration(node) && !isWhollyTypeOnlyImport(node)) {
        addSpecifier(node.moduleSpecifier);
      } else if (ts.isExportDeclaration(node) && !isWhollyTypeOnlyExport(node)) {
        addSpecifier(node.moduleSpecifier);
      } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
        addSpecifier(node.moduleReference.expression);
      } else if (ts.isCallExpression(node)) {
        const literalLoader = node.expression.kind === ts.SyntaxKind.ImportKeyword
          || (ts.isIdentifier(node.expression) && node.expression.text === 'require');
        if (literalLoader) addSpecifier(node.arguments[0]);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    return specifiers;
  }

  function isWhollyTypeOnlyImport(node) {
    const clause = node.importClause;
    if (!clause) return false;
    if (clause.isTypeOnly) return true;
    if (clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return false;
    const specifiers = clause.namedBindings.elements;
    return specifiers.length > 0 && specifiers.every(specifier => specifier.isTypeOnly);
  }

  function isWhollyTypeOnlyExport(node) {
    if (node.isTypeOnly) return true;
    if (!node.exportClause || !ts.isNamedExports(node.exportClause)) return false;
    const specifiers = node.exportClause.elements;
    return specifiers.length > 0 && specifiers.every(specifier => specifier.isTypeOnly);
  }

  Object.assign(runtime, {
    readJson, readText, getPackageScripts, formatNumber, readFirstNumber,
    extractFunctionBody, extractFunctionBodies, extractModuleSpecifiers,
    readInlineCounter, readInlineCounters, expectNumber, expectEveryNumber, validateQueryPathRelevanceContract,
    validateCodexMcpConfigContract, validateStrictNativeSourceEvidenceContract, validateStrictNativeOutputOrderContract, validateStrictNativeObjectProjectionContract, validateAdapterGateContract,
    validateAdapterFirstFallbackContract, validateUpstreamCodeGraphBoundaryContract, validateSingleSharedTreeFreshnessContract, validateLocalCodeGraphSourceSetup, validateIssueRegistry,
    parseIssueRegistryEntries, parseIssueRegistryFields, parseIssueRegistryFieldDiagnostics, parseIssueRegistryNestedFields, parseIssueRegistryNestedFieldDiagnostics,
    validateIssueRegistryEntry, validateIssueRegistryNestedFields, validateIssueRegistryVerificationGate, extractNpmRunScripts, validateIssueRegistryFreshnessConsistency,
    splitIssueRegistryList, validateIssueRegistryEnumList, validateIssueRegistryEnumValue, hasIssueRegistryPlaceholder, isValidIsoDate,
    isConcreteVerificationGate, unwrapBacktickValue, escapeRegex,
  });
}

module.exports = { installIssueContractValidator };
