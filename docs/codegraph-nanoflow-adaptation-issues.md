# NanoFlow CodeGraph Adaptation Issue Registry

This file records reproducible gaps where NanoFlow's documented CodeGraph
adaptation contract says a query should return a project-specific semantic
result, but the actual MCP or adapter CLI output does not expose the expected
node, edge, relationship group, entry point, source block, or strict native
field.

Use this registry as the repair backlog for the adaptation layer and as a
feedback channel for tightening `docs/codegraph-nanoflow-adaptation.md` when the
documentation overstates the supported query surface.

## When To Record

Record an issue only when all of these are true:

- The missing result belongs to a documented feature in `AGENTS.md` or
  `docs/codegraph-nanoflow-adaptation.md`.
- The query used `nanoflow_context_pack`, `nanoflow_overlay_query`, or the
  adapter-first CLI fallback.
- The expected result is concrete: a named relation, node kind, metadata value,
  source block order, strict native JSON field, or strict native Markdown
  section.
- The agent has checked whether the failure is stale-wrapper, stale-overlay,
  transport, timeout, or source-ordering evidence before classifying it as an
  adaptation quality gap.

Do not record exploratory misses, spelling mistakes, vague "search quality"
complaints, external-library guidance gaps, ordinary application bugs, or
features that the adaptation docs do not claim to support.

## Required Triage

1. Capture the exact MCP call or CLI command.
2. If MCP failed, run the adapter-first fallback:

```powershell
npm run codegraph:adapter:context -- --query "<same search>"
npm run codegraph:overlay:query -- --query "<same relation or symbol>" --skip-refresh
```

3. Run the log guard before blaming the adapter implementation:

```powershell
npm run codegraph:mcp:log:guard
```

4. Record whether the guard showed stale wrapper, stale overlay, overlay timeout,
   base CodeGraph child failure, source-ordering regression, or no transport
   evidence.
5. Add one issue entry using the schema below.

## Issue States

- `open`: Reproduced or strongly suspected, not fixed.
- `needs-repro`: The report lacks enough command/output evidence to act on.
- `implementation-fix`: The documentation is correct; the generator, query
  selection, formatter, wrapper, or tests need a code change.
- `doc-fix`: The implementation is behaving consistently, but the docs promised
  unsupported or ambiguous behavior.
- `fixed`: The implementation was changed and the verification gate passed.
- `doc-updated`: The docs were corrected and the verification gate passed.
- `wont-fix`: The query is outside the supported contract; explain why.

## Open Issues

No active issues are recorded yet.

## Fixed Issues

## CG-NF-20260708-002: Context-pack diagnostic helpers could bypass the de-duplication manifest

- status: fixed
- reported_at: 2026-07-08
- reporter: codex-agent
- feature_scope: de-duplication contract coverage, context-pack source-ordering diagnostics, and native CodeGraph delegation boundaries
- query_surface: docs-validator
- query: `docs/codegraph-nanoflow-dedup-contract.json context-pack diagnostic source-ordering helper coverage`
- expected: Any context-pack helper that influences source-ordering, sourceSelection, low-value suppression, or diagnostic top-ranked source selection should be discovered by `scripts/validate-codegraph-overlay-docs.cjs` and registered in `docs/codegraph-nanoflow-dedup-contract.json`, so the adapter cannot silently grow a second generic CodeGraph ranking/formatter layer.
- actual: Before the fix, `selectContextPackDiagnosticTopRankedOverlayEntry` was manually registered, but the validator discovery pattern did not cover `contextPackDiagnostic...` / `selectContextPackDiagnostic...` helpers. A new diagnostic selection helper could be added without the manifest failing.
- evidence:
  - docs_contract: `docs/codegraph-nanoflow-dedup-contract.json` context-pack source-ordering duplicate hotspot contract
  - output_summary: RED validator fixture appended `contextPackDiagnosticUnregisteredSourceOrderingReason()` to `scripts/codegraph-nanoflow-mcp-stdio.cjs` and the validator incorrectly exited 0. After repair, the validator fails that fixture and reports the missing helper name.
  - log_guard: not applicable; this was a manifest coverage guard gap, not a runtime transport or source-ordering failure.
- freshness_checks:
  - mcp_result: not-run
  - adapter_fallback_result: success
  - wrapper_stale: no
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: implementation-gap
- repair_target: docs | tests
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/validate-codegraph-overlay-docs.spec.ts -t "context-pack diagnostic source-ordering helper"; npm run codegraph:overlay:docs:validate; node --check scripts/validate-codegraph-overlay-docs.cjs`
- resolution_notes: The validator discovery pattern now includes `contextPackDiagnostic...` and `selectContextPackDiagnostic...` helpers. The manifest registers `contextPackDiagnosticTopRankedOverlaySelectionReason`, and the regression test locks the failure mode for future helper additions.

## CG-NF-20260708-001: De-duplication maintenance diagnostics chose test helpers as missing top-ranked overlay evidence

- status: fixed
- reported_at: 2026-07-08
- reporter: codex-agent
- feature_scope: context-pack source ordering, sourceSelection diagnostics, log-guard root-cause quality, and adapter fallback reliability
- query_surface: nanoflow_context_pack | adapter-context-cli | log-guard
- query: `codegraph nanoflow adaptation dedup contract native output source ordering strict native gaps`
- expected: De-duplication/native-output/source-ordering maintenance queries should keep visible adapter maintenance source such as `scripts/query-codegraph-nanoflow-overlay.mjs` or `scripts/validate-codegraph-overlay-docs.cjs` as the diagnostic top-ranked evidence when the rendered Source Code section already contains those files. Test helper matches may remain visible in raw ranking diagnostics, but they should not make the guard report `top-ranked-overlay-missing` unless the query explicitly asks for tests.
- actual: Before the fix, the fresh adapter fallback rendered the implementation maintenance files but the log guard still selected `src/tests/scripts/codegraph-nanoflow-overlay-query-strict-native.spec-helpers.ts` as `topRankedOverlayFile`, set `topRankedOverlayFileVisibleIndex=-1`, and failed the adapter fallback with `latestIssue.issue=top-ranked-overlay-missing`.
- evidence:
  - docs_contract: `docs/codegraph-nanoflow-adaptation.md` context-pack sourceOrdering diagnostics and low-value source pollution contract
  - output_summary: RED context-pack fixture rendered `scripts/query-codegraph-nanoflow-overlay.mjs` and `scripts/validate-codegraph-overlay-docs.cjs`, while raw overlay ranking put strict-native/source-ordering test helpers first. After repair, `rawTopRankedOverlayFile` still records the test helper, but `topRankedOverlayFile` is the visible maintenance source and `topRankedOverlayFileSelectionReason=dedup-maintenance-source-evidence`.
  - log_guard: Fresh adapter fallback for the original query now returns `ok: true` with `currentContextSourceOrdering.latestIssue=null`.
- freshness_checks:
  - mcp_result: success
  - adapter_fallback_result: success
  - wrapper_stale: no
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: source-ordering
- repair_target: context-pack-wrapper | log-guard | tests
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts -t "uses visible de-duplication maintenance source as diagnostic evidence"; npm run codegraph:adapter:context -- --query "codegraph nanoflow adaptation dedup contract native output source ordering strict native gaps" --json; npm run codegraph:overlay:docs:validate`
- resolution_notes: `selectContextPackDiagnosticTopRankedOverlayEntry` now receives final source evidence entries. For de-duplication maintenance queries without explicit test intent, it can select visible dedup maintenance source over low-value test helper raw matches. The log retains the raw top-ranked helper for root-cause analysis while preventing false adapter-failure diagnosis.

## CG-NF-20260706-013: Generated source files bypass context-pack low-value filtering and fallback log guard

- status: fixed
- reported_at: 2026-07-06
- reporter: codex-agent
- feature_scope: context-pack low-value source filtering, sourceSelection diagnostics, and error root-cause logging
- query_surface: nanoflow_context_pack | log-guard
- query: `contract service`; `npm run codegraph:mcp:log:guard -- --fail-on-current-source-ordering`
- expected: Broad implementation context-pack queries should demote unrequested generated files such as `.pb.ts`, `.generated.ts`, and `.gen.ts` from Source Code, Relationships, and Related Symbols when clean implementation files are available. The log guard should still detect generated, `.github`, `cloudflare/workers-static-assets`, and broad `scripts/` source pollution when ranked details are missing or truncated. Error response summaries should include enough root-cause state to triage without stitching multiple log events together.
- actual: Before the fix, generated TypeScript/protobuf-style files were recognized by the native overlay query formatter but not by the context-pack wrapper's low-value path classifier or the analyzer fallback. Overlay candidates filtered out by low-value rules also did not appear in `sourceSelection.filteredSourceFiles`, and `nanoflow.overlay.response` / `client.response` error summaries lacked `rootCauseSnapshot`.
- evidence:
  - docs_contract: `docs/codegraph-nanoflow-adaptation.md` sourceOrdering low-value fallback and context-pack diagnostics contract
  - output_summary: RED tests showed broad `contract service` context packs exposing `src/generated/contracts.pb.ts` and `src/generated/contracts.generated.ts`; after repair only `src/app/core/services/contract.service.ts` remains visible and the generated candidates are recorded as filtered low-value source.
  - log_guard: RED analyzer fixture with missing ranked details did not fail for generated, `.github`, Cloudflare static assets, or broad scripts; after repair it reports `lowValueVisibleSourceBlocks=4`, `lowValueSourcePollution=1`, and `issue=low-value-source-block-visible`.
- freshness_checks:
  - mcp_result: success
  - adapter_fallback_result: not-run
  - wrapper_stale: no
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: implementation-gap | source-ordering
- repair_target: context-pack-wrapper | log-guard | tests | docs
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts --testNamePattern "generated source blocks|wedged NanoFlow overlay query"; npx vitest run --config vitest.config.mts src/tests/scripts/analyze-codegraph-mcp-log.spec.ts --testNamePattern "generated repository tooling"`
- resolution_notes: The wrapper now shares official generated filename patterns with the overlay query layer, treats generated source as low-value unless the query explicitly asks for generated/proto/pb/grpc or a concrete path, records low-value overlay candidates in `sourceSelection.filteredSourceFiles`, extends analyzer fallback low-value classification for generated/GitHub/Cloudflare/scripts paths, and attaches `rootCauseSnapshot` to error response summary logs.

## CG-NF-20260706-012: Tooling context packs let generic Json/stale-smoke noise outrank CodeGraph adapter source

- status: fixed
- reported_at: 2026-07-06
- reporter: codex-agent
- feature_scope: context-pack query focusing, source ordering quality, and source-ordering log diagnostics
- query_surface: nanoflow_context_pack | log-guard
- query: `Codex config doctor json`; `stale wrapper test assertions codegraph mcp wrapper stale-smoke`
- expected: CodeGraph tooling queries should focus generic output/test wording before overlay and base exploration, rank `scripts/codegraph-codex-config.cjs` or wrapper smoke source ahead of generic `Json`/stale business test matches, and log the exact ranking query used for source ordering.
- actual: Before the fix, `Codex config doctor json` could render `src/types/supabase.ts — Json(type_alias)` as the first source block even though overlay had selected `readCodexCodegraphMcpConfig`; `stale-smoke` remained a compound noisy query term, so wrapper smoke queries could fall back to stale business test helpers.
- evidence:
  - docs_contract: `AGENTS.md` source-ordering quality rule and `docs/codegraph-nanoflow-adaptation.md` context-pack source ordering/log guard contract
  - output_summary: RED tests showed `baseQuery=wrapper mcp stale-smoke` and a first source header of `src/types/supabase.ts — Json(type_alias)`; after repair the focused query is `wrapper mcp smoke`, and `scripts/codegraph-codex-config.cjs — getCodexConfigPath(function), readCodexCodegraphMcpConfig(function)` is first.
  - log_guard: `sourceOrdering` now records `sourceRankingQuery` and `sourceVisibilityQuery`, and the analyzer treats either missing field as incomplete diagnostics.
- freshness_checks:
  - mcp_result: success
  - adapter_fallback_result: not-run
  - wrapper_stale: no
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: source-ordering
- repair_target: context-pack-wrapper | log-guard | tests | docs
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts -t "focuses tooling test wording|keeps Codex MCP config diagnostics"; npx vitest run --config vitest.config.mts src/tests/scripts/analyze-codegraph-mcp-log.spec.ts -t "fails current source-ordering guard when diagnostics are present but incomplete"`
- resolution_notes: Context-pack ranking now uses the focused source-ranking query instead of the raw visibility query, compound noisy terms such as `stale-smoke` are split so only meaningful segments survive, injected overlay source blocks are re-ranked with the same source orderer, and log guard required fields include the ranking/visibility query pair.

## CG-NF-20260706-011: Context7 source-map strict native Markdown could render frontmatter before row evidence

- status: fixed
- reported_at: 2026-07-06
- reporter: codex-agent
- feature_scope: strict native Markdown source evidence quality and MCP log post-mortem diagnostics
- query_surface: nanoflow_overlay_query | overlay-query-cli | log-guard
- query: `context7-source-map-source --native-markdown`
- expected: Strict native `### Code` blocks for `context7-source-map-source` should use the matching `docs/context7/source-map.md` table row as edge-line evidence, and directory/glob `context7-source-path` targets should remain relationship targets rather than rendering line 1/frontmatter as code evidence.
- actual: Before the fix, a directory source target such as `src/app/core/services/sync/` could appear as the first code block with `docs/context7/source-map.md:1`, rendering only `---` and pushing the useful source-map row evidence down.
- evidence:
  - docs_contract: `AGENTS.md` strict native source evidence contract and `docs/codegraph-nanoflow-adaptation.md` strict native Markdown/source block contract
  - output_summary: RED fixture showed `#### src/app/core/services/sync/ (docs/context7/source-map.md:1)` followed by a `---` Markdown block before the source-map row; after repair the first code block is `context7-source-map-source` at the route row.
  - log_guard: Malformed wrapper log lines now include `malformedLineNumbers`, `malformedLineRootCauseClasses`, and `malformedLineDetails[]` with parse error and nearby event context so future truncated-log errors can be triaged without guessing.
- freshness_checks:
  - mcp_result: success
  - adapter_fallback_result: success
  - wrapper_stale: no
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: implementation-gap | source-ordering
- repair_target: native-markdown | log-guard | tests | docs
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts -t "prints Context7 source-map relationships"; npx vitest run --config vitest.config.mts src/tests/scripts/analyze-codegraph-mcp-log.spec.ts -t "reports malformed log line diagnostics"`
- resolution_notes: `context7-source-map-source` is now an edge-line, source-first strict native relation. The formatter suppresses `context7-source-path` synthetic targets from code blocks, preserving relationships while keeping the code evidence on the source-map table row. The log analyzer now records line-level malformed JSON diagnostics with nearby run/event context for faster future MCP error root-cause review.

## CG-NF-20260706-002: Story/demo/sample source blocks consumed broad component context

- status: fixed
- reported_at: 2026-07-06
- reporter: codex-agent
- feature_scope: context-pack source ordering quality and log guard low-value source diagnostics
- query_surface: nanoflow_context_pack | adapter-context-cli | log-guard
- query: `action button component`
- expected: Broad implementation/component context packs should prefer production component source blocks and should not spend visible `### Source Code` budget on Storybook stories, demo files, sample files, examples, or playground files unless the query explicitly asks for those categories or paths.
- actual: Before the fix, story/demo/sample files were renderable and could appear ahead of production component source blocks; the log guard also did not infer `.stories.tsx` as low-value pollution when `rankedOverlayFileDetails.lowValuePenalty` was zero.
- evidence:
  - docs_contract: `AGENTS.md` source-ordering low-value fallback rule and `docs/codegraph-nanoflow-adaptation.md` sourceOrdering diagnostics/log guard contract
  - output_summary: The RED context-pack fixture rendered `src/stories/action-button.stories.tsx`, `src/demo/action-button-demo.ts`, and `src/samples/action-button-sample.ts` in visible source blocks while omitting a production `ActionButtonMenuComponent` source block; after repair only production component source blocks remain visible for the broad query.
  - log_guard: The RED log fixture returned `status=0` even with `.stories.tsx` first; after repair `--fail-on-current-source-ordering` fails that fixture with `lowValueVisibleSourceBlocks=1`, `lowValueSourcePollution=1`, and `issue=low-value-source-block-visible`.
- freshness_checks:
  - mcp_result: success
  - adapter_fallback_result: success
  - wrapper_stale: no
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: source-ordering
- repair_target: context-pack-wrapper | log-guard | tests | docs
- doc_update_needed: yes
- resolution_notes: The wrapper now classifies story/demo/sample/example/playground as low-value source paths, suppresses low-value overlay source fallback when clean source candidates exist, and logs `sourceOrdering.visibleSourceFileDetails` with visible/ranked index, raw/effective penalty, path class, and explicit-query flags.
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts -t "filters story demo and sample source blocks"; npx vitest run --config vitest.config.mts src/tests/scripts/analyze-codegraph-mcp-log.spec.ts -t "story demo source blocks"`

## CG-NF-20260706-001: Context-pack treated shallow base snippets as complete Edge Function source

- status: fixed
- reported_at: 2026-07-06
- reporter: codex-agent
- feature_scope: documented context-pack source ordering and native-quality source evidence for Supabase Edge Functions
- query_surface: nanoflow_context_pack | adapter-context-cli | overlay-query-cli
- query: `supabase functions transcribe edge-function-invoke route-reference source ordering`
- expected: Context pack should show `supabase/functions/transcribe/index.ts` first and include the real Edge Function handler source when overlay native codeBlocks identify that implementation range, even if base CodeGraph returned a shallow same-file snippet.
- actual: Before the fix, direct/fresh context pack rendered `src/utils/supabase-functions-error.ts` first and only showed `supabase/functions/transcribe/index.ts` line 1, because compact `--context-json` omitted native `codeBlocks` and wrapper same-file de-dup treated the base line-1 snippet as sufficient source evidence.
- evidence:
  - docs_contract: `AGENTS.md` context-pack source ordering contract and strict native source evidence contract for Edge Function relations
  - output_summary: `npm --silent run codegraph:overlay:query -- --query "supabase functions transcribe edge-function-invoke route-reference source ordering" --skip-refresh --json` already produced a native codeBlock for `supabase/functions/transcribe/index.ts` lines 259-553, while `npm --silent run codegraph:adapter:context -- --query "supabase functions transcribe edge-function-invoke route-reference source ordering" --max-files 4 --json --timeout-ms 90000` showed the error helper first and only the Edge Function file header.
  - log_guard: Before repair, source-ordering diagnostics could classify the generic error helper as healthy top-ranked source; after repair, fresh adapter context reports `currentContextSourceOrdering.topRankedMissing=0`, `topRankedNotFirst=0`, `lowValueVisibleSourceBlocks=0`, and `lowValueSourcePollution=0`.
- freshness_checks:
  - mcp_result: success
  - adapter_fallback_result: success
  - wrapper_stale: yes
  - overlay_stale: yes
  - transport_failure: no
- likely_root_cause: source-ordering
- repair_target: context-pack-wrapper | log-guard | tests
- doc_update_needed: no
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts -t "uses context-json code blocks to replace shallow base Edge Function snippets|preserves exact relation tokens when focusing context-pack overlay queries"; npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts -t "source ordering|Source Code|source blocks"; npm run codegraph:mcp:smoke -- --repeat 2 --timeout-ms 90000; npm --silent run codegraph:adapter:context -- --query "supabase functions transcribe edge-function-invoke route-reference source ordering" --max-files 4 --json --timeout-ms 90000`
- resolution_notes: Compact context-json now carries native `codeBlocks`; context pack turns those codeBlocks into source evidence for ranking/de-dup and diagnostics, so shallow base snippets no longer suppress real implementation source. The Codex MCP config now sets `NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS=30000` and `NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE=1` for future host sessions.

## CG-NF-20260629-001: Context-pack source ordering can fail adapter fallback for broad strict-native tooling queries

- status: fixed
- reported_at: 2026-06-29
- reporter: codex-agent
- feature_scope: documented context-pack source ordering and adapter-first fallback reliability
- query_surface: nanoflow_context_pack | adapter-context-cli
- query: `strict native edge-function-header nativeJson column nativeMarkdown Authorization content-length Origin buildNativeCodeBlocks buildExactRelationEdgeCodeBlocks buildProvenanceEdgeLineCodeBlocks readEdgeLineCodeBlock query-codegraph-nanoflow-overlay`
- expected: Adapter context fallback should return a successful context pack, and the source-ordering guard should either show the top-ranked overlay file in the rendered source blocks or classify the absence as a documented non-issue.
- actual: Before the fix, `npm run codegraph:adapter:context -- --query "strict native edge-function-header nativeJson column nativeMarkdown Authorization content-length Origin buildNativeCodeBlocks buildExactRelationEdgeCodeBlocks buildProvenanceEdgeLineCodeBlocks readEdgeLineCodeBlock query-codegraph-nanoflow-overlay" --json` exited nonzero because the fresh wrapper log guard reported `top-ranked-overlay-missing`. The first rendered source block was `scripts/query-codegraph-nanoflow-overlay.mjs`, while `docs/context7/07-examples/add-edge-function.md` was the computed `topRankedOverlayFile` and was not visible.
- evidence:
  - docs_contract: `docs/codegraph-nanoflow-adaptation.md` sourceOrdering diagnostics and log guard contract
  - output_summary: The broad strict-native tooling query used to render `scripts/query-codegraph-nanoflow-overlay.mjs` first while the computed top-ranked overlay file was `docs/context7/07-examples/add-edge-function.md`; after repair, fresh adapter context renders the Context7 docs source first and keeps tooling source available below.
  - log_guard: Fresh adapter context reports `currentDiskContextSourceOrdering.topRankedMissing=0`, `topRankedNotFirst=0`, `lowValueVisibleSourceBlocks=0`, `lowValueSourcePollution=0`, `transportHealthy=true`, and `criticalTransportFailures=0`.
- freshness_checks:
  - mcp_result: success
  - adapter_fallback_result: success
  - wrapper_stale: no
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: source-ordering
- repair_target: context-pack-wrapper | log-guard | tests
- doc_update_needed: no
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts -t "issue registry|tooling context-pack|CodeGraph tooling|top-ranked docs|source first|source ordering|base source|low-value base source|overlay source blocks"; npm run codegraph:adapter:context -- --query "strict native edge-function-header nativeJson column nativeMarkdown Authorization content-length Origin buildNativeCodeBlocks buildExactRelationEdgeCodeBlocks buildProvenanceEdgeLineCodeBlocks readEdgeLineCodeBlock query-codegraph-nanoflow-overlay" --max-files 1 --json --timeout-ms 90000`
- resolution_notes: Context-pack final base-source filtering now allows top-ranked rendered documentation evidence under `docs/` to survive broad CodeGraph tooling queries, while ordinary config/app files remain suppressed by tooling-focused filtering. Regression coverage locks both issue-registry docs and Context7 docs source ordering.

## CG-NF-20260629-002: Strict native Edge Function header output used wrong source blocks and omitted edge columns

- status: fixed
- reported_at: 2026-06-29
- reporter: codex-agent
- feature_scope: strict native JSON/Markdown output quality for `edge-function-header`
- query_surface: overlay-query-cli
- query: `Authorization edge-function-header`; `content-length edge-function-header`
- expected: Strict native JSON edges should preserve the official edge field shape including `column`. Strict native Markdown/codeBlocks for `edge-function-header` should show the concrete `req.headers.get(...)` evidence line or enclosing helper function, not unrelated entry handler lines.
- actual: Before the fix, strict native JSON omitted `column` when overlay edges lacked a column. For shared helper header edges, strict native Markdown/codeBlocks read `edge.source` file with the helper line number, producing unrelated `Origin` evidence or a one-line `}` block instead of the helper header evidence.
- evidence:
  - docs_contract: `AGENTS.md` strict native edge-line evidence supplement and `docs/codegraph-nanoflow-adaptation.md` strict native source evidence contract
  - output_summary: `Authorization edge-function-header --native-json` and `content-length edge-function-header --native-json` had edges without `column`; strict native Markdown could include unrelated `Origin` evidence or a code block containing only `}`. Focused RED tests covered shared helper header evidence and native JSON edge columns.
  - log_guard: No current transport failure was required to reproduce. The bug was isolated through fresh overlay-query CLI output and focused strict native formatter tests.
- freshness_checks:
  - mcp_result: success
  - adapter_fallback_result: success
  - wrapper_stale: no
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: source-ordering
- repair_target: native-json | native-markdown | tests
- doc_update_needed: no
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts -t "uses shared helper header evidence when the edge source is the entry function|keeps strict native JSON edge column fields"; npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts -t "edge-function-header|Edge Function source blocks|strict native JSON formatter projection|native JSON edge column|helper header evidence"; node scripts/query-codegraph-nanoflow-overlay.mjs --query "Authorization edge-function-header" --skip-refresh --native-json; node scripts/query-codegraph-nanoflow-overlay.mjs --query "content-length edge-function-header" --skip-refresh --native-json`
- resolution_notes: `edge-function-header` edge-line source blocks now use the header evidence file from `metadata.sourceFile` or the target node while retaining the Edge Function entry as the owner name. Strict native JSON serialization now fills missing edge `column` as `0`, preserving the official field shape.

## CG-NF-20260629-003: Strict native JSON edge location fallback only covered Edge Function headers

- status: fixed
- reported_at: 2026-06-29
- reporter: codex-agent
- feature_scope: strict native JSON object projection for all overlay relation edges
- query_surface: overlay-query-cli
- query: `host-binding --native-json`; `sync-required-field --native-json`; `android-kotlin-override --native-json`; `migration-constraint-validation --native-json`; `template-url style-url --native-json`
- expected: Strict native JSON edges should always keep the official edge object field shape `source/target/kind/line/column`, with `line: 0` and/or `column: 0` when the overlay relation lacks precise location evidence.
- actual: Before the fix, the strict native serializer only defaulted missing `column` for `edge-function-header`; other documented relation queries emitted edges with missing `column`, and some relation edges also omitted `line`, violating the strict native object projection contract.
- evidence:
  - docs_contract: `AGENTS.md` and `docs/codegraph-nanoflow-adaptation.md` strict native object projection contract
  - output_summary: Fresh `--native-json` queries for `host-binding`, `sync-required-field`, `android-kotlin-override`, `migration-constraint-validation`, and `template-url style-url` returned closed edges without the full `line`/`column` field shape.
  - log_guard: No current transport failure or source-ordering failure was required to reproduce; this was isolated to strict native JSON edge serialization.
- freshness_checks:
  - mcp_result: not-run
  - adapter_fallback_result: success
  - wrapper_stale: no
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: implementation-gap
- repair_target: native-json | tests
- doc_update_needed: no
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts -t "strict native JSON edge line and column fields"; node scripts/query-codegraph-nanoflow-overlay.mjs --query "host-binding" --skip-refresh --native-json; node scripts/query-codegraph-nanoflow-overlay.mjs --query "sync-required-field" --skip-refresh --native-json; node scripts/query-codegraph-nanoflow-overlay.mjs --query "migration-constraint-validation" --skip-refresh --native-json`
- resolution_notes: Strict native JSON edge serialization now defaults every missing edge `line` or `column` to `0`, preserving the official object shape for all relation queries while still retaining real location values when the overlay supplies them.

## CG-NF-20260629-004: Edge Function header helper code blocks were named after the entry function

- status: fixed
- reported_at: 2026-06-29
- reporter: codex-agent
- feature_scope: strict native source evidence quality for `edge-function-header`
- query_surface: overlay-query-cli
- query: `edge-function-header --native-json`; `edge-function-header --native-markdown`
- expected: When `edge-function-header` evidence is expanded to a shared helper function such as `getContentLengthBytes` or `getBearerToken`, strict native JSON `codeBlocks[].nodeName` and strict native Markdown code headers should identify the real helper function, not the Edge Function entry that references it.
- actual: Before the fix, helper source blocks under `supabase/functions/_shared/widget-common.ts` showed the correct helper source range, but the code block name/header still used the Edge Function entry name such as `widget-focus-action`.
- evidence:
  - docs_contract: `AGENTS.md` and `docs/codegraph-nanoflow-adaptation.md` strict native source evidence contract for `edge-function-header`
  - output_summary: `edge-function-header --native-json` rendered helper function content while naming the block after the entry function; `--native-markdown` used the same misleading entry-function code header.
  - log_guard: No current transport failure or source-ordering failure was required to reproduce; this was isolated to strict native source block naming.
- freshness_checks:
  - mcp_result: not-run
  - adapter_fallback_result: success
  - wrapper_stale: no
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: implementation-gap
- repair_target: native-json | native-markdown | tests
- doc_update_needed: no
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts -t "shared helper header evidence"; npm run codegraph:overlay:query -- --query edge-function-header --skip-refresh --native-json; npm run codegraph:overlay:query -- --query edge-function-header --skip-refresh --native-markdown`
- resolution_notes: Edge-function-header code block naming now reads the expanded JavaScript/TypeScript function declaration name from the evidence range, so shared helper blocks are attributed to the helper while anonymous `serve(...)` handler blocks still fall back to the entry function name.

## CG-NF-20260629-005: Doctor mixed script staleness and Codex host configuration mismatch

- status: fixed
- reported_at: 2026-06-29
- reporter: codex-agent
- feature_scope: Codex CodeGraph MCP root-cause diagnostics
- query_surface: adapter-context-cli | log-guard
- query: `npm run codegraph:adapter:doctor -- --strict --json`; `npm run codegraph:adapter:doctor -- --strict --explain`
- expected: Doctor output should distinguish wrapper script hash staleness from live Codex host env/target mismatch, preserve `C:\Users\MI\.codex\config.toml` as the active config source, and attach machine-readable root-cause fields to failing host checks.
- actual: Before the fix, env mismatch could set `hostMcp.staleAgainstDisk=true`, live process target mismatch carried no `investigation`, and target mismatch depended on live process enumeration even though `wrapper.start` logs already contained `codegraphTarget`.
- evidence:
  - docs_contract: AGENTS Codex MCP configuration ownership and MCP failure triage rules
  - output_summary: Doctor could report a stale-looking host state even when the script hash was fresh but the live host env/target no longer matched `.codex`; `--explain` also lacked expected/actual target detail on the failing check line.
  - log_guard: No current transport failure was needed; the problem was doctor classification and root-cause projection quality.
- freshness_checks:
  - mcp_result: not-run
  - adapter_fallback_result: success
  - wrapper_stale: no
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: implementation-gap
- repair_target: log-guard | tests
- doc_update_needed: no
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-adapter-doctor.spec.ts; npm run codegraph:adapter:doctor -- --strict --json`
- resolution_notes: Doctor now keeps `scriptStaleAgainstDisk` separate from `hostConfigMismatch`, preserves wrapper-start `codegraphTarget` evidence, adds `host-mcp:current-wrapper-target` / `host-mcp:current-context-wrapper-target` checks, and attaches `investigation.failureBoundary/failureClass/likelyRootCause/nextEvidence` to host config failures.

## CG-NF-20260626-001: Explicit service source block hidden behind sync helper and migration noise

- status: fixed
- reported_at: 2026-06-26
- reporter: codex-agent
- feature_scope: documented context-pack source ordering and explicit symbol retrieval
- query_surface: nanoflow_context_pack | adapter-context-cli | overlay-query-cli
- query: `TaskSyncOperationsService 本身只是转发。我要直接看 TaskSyncPushService，确认 RPC 被拒绝或不可用时是否会直接落到 table upsert，还是进入 RetryQueue。`
- expected: `TaskSyncPushService` and `src/app/core/services/sync/task-sync-push.service.ts` should be selected and rendered before broad RetryQueue, sync-rule, RPC helper, or migration evidence when the query explicitly says to inspect that service.
- actual: Before the fix, broad `rpc` / `upsert` / `RetryQueue` / sync-rule terms ranked spec helpers and migrations ahead of the focused service; in some fresh context-pack runs `TaskSyncPushService` was absent from the source blocks entirely.
- evidence:
  - docs_contract: `AGENTS.md:57` and `docs/codegraph-nanoflow-adaptation.md:551`
  - output_summary: fresh adapter context ranked `connection-sync-rpc-upsert.spec-helpers.ts`, `task-sync-operations-rpc-upsert.spec-helpers.ts`, and sync RPC migrations before or instead of `task-sync-push.service.ts`.
  - log_guard: sourceOrdering showed `topRankedOverlayFile` as helper/migration evidence even though the user query focused `TaskSyncPushService`.
- freshness_checks:
  - mcp_result: success
  - adapter_fallback_result: success
  - wrapper_stale: no
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: query-ranking
- repair_target: query-selection | context-pack-wrapper | tests
- doc_update_needed: no
- verification_gate: `npx vitest run src/tests/scripts/codegraph-nanoflow-overlay.spec.ts --testNamePattern "prioritizes exact explicit service symbols|promotes an explicitly named service"; node scripts/codegraph-adapter-context.cjs --query "TaskSyncOperationsService 本身只是转发。我要直接看 TaskSyncPushService，确认 RPC 被拒绝或不可用时是否会直接落到 table upsert，还是进入 RetryQueue。" --json; npm run codegraph:overlay:test; npm run codegraph:adapter:quick-gate`
- resolution_notes: Overlay query scoring now boosts exact explicit symbols, with extra weight for focus phrases such as "直接看"; context-pack source ordering now lets base CodeGraph source blocks participate in query-aware ranking, so a base-only focused service block can outrank broad overlay helper or migration matches.

## CG-NF-20260626-002: Metadata-only weak matches fill rendered context before real source

- status: fixed
- reported_at: 2026-06-26
- reporter: codex-agent
- feature_scope: documented source relevance, strict native projections, and context-pack source ordering
- query_surface: nanoflow_context_pack | nanoflow_overlay_query | overlay-query-cli
- query: `render problem investigate`
- expected: A file whose symbol name/path directly matches `render problem investigate` should keep the first related/source/code-block slot ahead of files that only mention those words in metadata, docstrings, signatures, or relationship payloads.
- actual: Before the fix, `selectGraphResults` selected relevant nodes, but the formatter later sorted nodes and source groups by file path. Alphabetically early metadata-only files could take the first Markdown source block and fill Related Symbols before the real symbol source.
- evidence:
  - docs_contract: `docs/codegraph-nanoflow-adaptation.md:1439`
  - output_summary: Synthetic overlay fixture with `RenderProblemOwner` in `src/z-owner.ts` and `MetadataOnlyNoise` in `src/a-metadata-noise.ts` rendered the metadata-only file first before the ranking fix.
  - log_guard: no transport evidence; this is a query-ranking and rendered-context budget issue.
- freshness_checks:
  - mcp_result: success
  - adapter_fallback_result: success
  - wrapper_stale: no
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: query-ranking
- repair_target: query-selection | native-json | native-markdown | context-pack-wrapper | docs | tests
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts --testNamePattern "core symbol source|bounds context-pack related symbols|prioritizes segmented file-name matches|promotes an explicitly named service"`
- resolution_notes: Query output now carries core name/path/kind relevance through node, relatedFiles, source block, and strict native code-block ordering; context packs rank Related Symbols by source-file relevance and cap them to 8 files / 12 symbols per file so weak metadata hits cannot bury overlay source.

## CG-NF-20260626-003: Strict native generated-file demotion overrides explicit query relevance

- status: fixed
- reported_at: 2026-06-26
- reporter: codex-agent
- feature_scope: strict native JSON/Markdown output ordering and generated-file parity
- query_surface: nanoflow_overlay_query | overlay-query-cli
- query: `GeneratedQueryOrderTarget pb`
- expected: When a query has stronger file/name relevance for an official generated path such as `src/generated.pb.ts`, strict native JSON and strict native Markdown should render that entry point and code block before a hand-written same-symbol file. Generated-file demotion should apply only after query relevance is tied.
- actual: Before the fix, strict native JSON and strict native Markdown re-sorted entry points and code blocks with unconditional generated-file demotion, so `src/real.ts` rendered before the explicitly more relevant `src/generated.pb.ts`.
- evidence:
  - docs_contract: `docs/codegraph-nanoflow-adaptation.md:753` and `docs/codegraph-nanoflow-adaptation.md:1031`
  - output_summary: Focused fixture with `GeneratedQueryOrderTarget` in both `src/real.ts` and `src/generated.pb.ts` rendered `src/real.ts` first for `GeneratedQueryOrderTarget pb`.
  - log_guard: no current transport or source-ordering failure; this is strict native projection ordering.
- freshness_checks:
  - mcp_result: not-available
  - adapter_fallback_result: success
  - wrapper_stale: no
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: query-ranking
- repair_target: native-json | native-markdown | tests
- doc_update_needed: no
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts --testNamePattern "explicit generated path relevance|generated filename patterns|generated non-entry nodes|strict native CodeGraph JSON formatter projection|strict native Markdown"; npm run codegraph:mcp:log:guard`
- resolution_notes: Strict native JSON and Markdown now use a shared query-aware projection ordering helper. Query relevance ranks first, official generated-file demotion is only a tie-breaker, and stable input order is preserved afterward.

## CG-NF-20260626-004: Angular plural query signal APIs resolve as imports instead of semantic edges

- status: fixed
- reported_at: 2026-06-26
- reporter: codex-agent
- feature_scope: Angular query/signal semantic edge coverage and native-shaped query output
- query_surface: nanoflow_overlay_query | overlay-query-cli
- query: `viewChildren contentChildren`
- expected: Plural Angular query APIs should select the owning Angular class plus native-shaped `references` edges with `metadata.relation = "query"` and `metadata.api = "viewChildren"` / `"contentChildren"`, before lower-value `@angular/core` import matches.
- actual: Before the fix, API-name queries primarily selected `@angular/core` import nodes and broad same-file import containment, so the owning component and semantic query edges could be buried or absent from the selected graph.
- evidence:
  - docs_contract: `docs/codegraph-nanoflow-adaptation.md:47`
  - output_summary: Focused fixture with `SampleComponent.panels = viewChildren(LazyPanelComponent)` and `SampleComponent.slots = contentChildren('slot')` returned import-heavy output before semantic API edge selection.
  - log_guard: not needed; this is generator/query-selection coverage, reproduced through adapter CLI fixture output.
- freshness_checks:
  - mcp_result: not-available
  - adapter_fallback_result: success
  - wrapper_stale: no
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: query-ranking
- repair_target: generator | query-selection | docs | tests
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts --testNamePattern "plural query signal APIs|emits NanoFlow-specific relationships"; npm run codegraph:overlay:docs:validate`
- resolution_notes: The core fixture and baseline assertions now cover `viewChildren()` and `contentChildren()`. Overlay query selection treats known Angular semantic API names as exact API edge queries and prefers the owner/source class as the entry point.

## CG-NF-20260626-005: Angular writable signal declarations are not emitted as semantic signal edges

- status: fixed
- reported_at: 2026-06-26
- reporter: codex-agent
- feature_scope: Angular signal semantic edge coverage and native-shaped query output
- query_surface: nanoflow_overlay_query | overlay-query-cli
- query: `signal viewChildren contentChildren`
- expected: Class field `signal()` declarations should be captured beside `computed()` and `effect()` as native-shaped `calls` edges with `metadata.relation = "signal"` and `metadata.api = "signal"`, and API-name queries should select the owning Angular class before lower-value `@angular/core` import matches.
- actual: Before the fix, `readAngularApiCall()` ignored `signal()`, so writable signal state declarations were only visible as ordinary TypeScript calls/imports and did not appear in `component.signals`, graph signal edges, relationship groups, or owner-first query results.
- evidence:
  - docs_contract: `docs/codegraph-nanoflow-adaptation.md:47`
  - output_summary: Focused fixture with `SampleComponent.dirty = signal(false)` failed to emit `api=signal`; querying Angular API names returned only plural query edges.
  - log_guard: not needed; this is generator/query-selection coverage, reproduced through adapter CLI fixture output.
- freshness_checks:
  - mcp_result: not-available
  - adapter_fallback_result: success
  - wrapper_stale: no
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: implementation-gap
- repair_target: generator | query-selection | docs | tests
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts --testNamePattern "signal and plural query APIs|emits NanoFlow-specific relationships"; npm run codegraph:overlay:docs:validate`
- resolution_notes: The core Angular fixture now imports and declares a writable `signal()`. Generator semantic extraction emits it as `api=signal`, query selection treats `signal` as an Angular semantic API term, and docs include `signal()` in the supported signal edge surface.

## CG-NF-20260626-006: Angular bootstrap application providers are invisible as composition-root relationships

- status: fixed
- reported_at: 2026-06-26
- reporter: codex-agent
- feature_scope: Angular application bootstrap provider coverage and strict native source evidence
- query_surface: nanoflow_overlay_query | overlay-query-cli
- query: `angular-app-provider`
- expected: Application-level providers from `bootstrapApplication(..., { providers })` and `ApplicationConfig.providers` should be queryable as native-shaped `references` edges from the bootstrap/config file node to provider tokens or provider factory functions. Strict native code blocks should show the real provider block, including `deps` and factory-call arguments.
- actual: Before the fix, querying application providers returned no semantic relation. Searching `bootstrapApplication provideRouter APP_INITIALIZER` selected low-value Angular imports and incidental docstring mentions instead of the composition-root provider entries in `main.ts`.
- evidence:
  - docs_contract: `docs/codegraph-nanoflow-adaptation.md:35`
  - output_summary: Real `main.ts` contains `bootstrapApplication(AppComponent, { providers: [...] })` with `APP_INITIALIZER`, `provideRouter(...)`, and `provideServiceWorker(...)`, but `angular-app-provider` returned 0 nodes before implementation.
  - log_guard: not needed; this is generator/query-selection coverage, reproduced through adapter CLI output.
- freshness_checks:
  - mcp_result: not-available
  - adapter_fallback_result: success
  - wrapper_stale: no
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: implementation-gap
- repair_target: generator | query-selection | native-json | native-markdown | docs | tests
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts --testNamePattern "application bootstrap providers|emits NanoFlow-specific relationships"; npm run codegraph:overlay:docs:validate`
- resolution_notes: The Angular collector now records application provider groups from `bootstrapApplication` and `ApplicationConfig.providers`. Native graph output emits `angular-app-provider` references from the config file node, and query code-block policy treats the relation as source-first with expanded provider evidence.

## CG-NF-20260627-001: Combined relation strict native code blocks are monopolized by the first relation

- status: fixed
- reported_at: 2026-06-27
- reporter: codex-agent
- feature_scope: strict native JSON and Markdown source evidence for combined relation queries
- query_surface: nanoflow_overlay_query | overlay-query-cli
- query: `template-url/style-url`, `host-attribute/host-binding`, `policy-using/policy-with-check`
- expected: Slash-combined documented relation queries should select closed edges from every requested relation and allocate strict native `codeBlocks` across those relation buckets, so HTML/CSS resources, host attribute/binding evidence, and policy USING/WITH CHECK statements all remain visible.
- actual: Before the fix, native code block selection collapsed combined relation queries to the first exact relation term. `template-url/style-url` filled the native budget with `.html` file endpoints, `host-attribute/host-binding` backfilled large component class blocks after host attribute lines, and policy combinations could omit the WITH CHECK evidence from the first page.
- evidence:
  - docs_contract: `docs/codegraph-nanoflow-adaptation.md:65`
  - output_summary: Fresh CLI `--native-json` runs showed both relation edge sets were selected, but `codeBlocks` were generated from only the first relation term.
  - log_guard: transport was not involved; reproduced through fresh overlay-query CLI.
- freshness_checks:
  - mcp_result: success
  - adapter_fallback_result: success
  - wrapper_stale: no
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: query-ranking
- repair_target: native-json | native-markdown | query-selection | tests
- doc_update_needed: no
- verification_gate: `npm run codegraph:overlay:test; npm run codegraph:overlay:docs:validate`
- resolution_notes: Native code block selection now resolves all exact metadata relation terms from a combined query and interleaves endpoint and edge-line evidence by relation bucket before applying the native code block limit.

## CG-NF-20260627-002: Context-pack Angular resource query is polluted by overlay script parameter matches

- status: fixed
- reported_at: 2026-06-27
- reporter: codex-agent
- feature_scope: nanoflow_context_pack source ordering and low-value source filtering
- query_surface: nanoflow_context_pack | adapter-context-cli
- query: `app.component templateUrl template-url`
- expected: Angular resource relation context packs should keep actual app/component files and `.html` or `.css/.scss` resource endpoints in the first Source Code blocks. Adapter implementation files, docs, and spec helpers that merely contain relation token names should not fill the first source budget unless explicitly queried.
- actual: Before the fix, `scripts/generate-codegraph-nanoflow-overlay.mjs -- templateUrl(parameter)` could outrank real HTML resource files because `templateUrl` was scored as a normal explicit symbol term and low-value ranked source chunks were still used to fill the filtered source budget.
- evidence:
  - docs_contract: `docs/codegraph-nanoflow-adaptation.md:137`
  - output_summary: Fresh adapter-context output placed `scripts/generate-codegraph-nanoflow-overlay.mjs` in the first context-pack Source Code blocks for `app.component templateUrl template-url`.
  - log_guard: current source-ordering diagnostics did not flag this class because the top-ranked file was still visible; the failure was low-value source pollution after the first block.
- freshness_checks:
  - mcp_result: success
  - adapter_fallback_result: success
  - wrapper_stale: no
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: source-ordering
- repair_target: context-pack-wrapper | log-guard | tests
- doc_update_needed: no
- verification_gate: `node scripts/codegraph-adapter-context.cjs --query "app.component templateUrl template-url" --json; npm run codegraph:overlay:test; npm run codegraph:mcp:log:guard`
- resolution_notes: Context-pack scoring now treats `templateUrl` and `styleUrl` as resource relation signals rather than explicit symbol terms, penalizes unrequested `scripts/` noise for resource-relation queries, and excludes low-value ranked chunks when enough unpenalized source candidates exist.

## CG-NF-20260627-003: Issue registry template is parsed into the final fixed issue

- status: fixed
- reported_at: 2026-06-27
- reporter: codex-agent
- feature_scope: adaptation issue registry validation and repair workflow reliability
- query_surface: docs-validator
- query: `npm run codegraph:overlay:docs:validate`
- expected: The machine-consumable issue registry should validate only real numbered issue entries. The reusable `Entry Template` must not be parsed into the final issue, and real issues must not retain template placeholders in required fields.
- actual: Before the fix, `parseIssueRegistryEntries()` ended each issue at the next numeric issue header only. The final fixed issue absorbed the following `## Entry Template`, causing the template `status: open` and placeholder fields to be treated as part of the fixed issue and making the docs validation gate fail.
- evidence:
  - docs_contract: `docs/codegraph-nanoflow-adaptation-issues.md:270`
  - output_summary: `npm run codegraph:overlay:docs:validate` failed with `CG-NF-20260626-006 has open status open but is listed under Fixed Issues`.
  - log_guard: not relevant; this was a docs validator parser boundary issue.
- freshness_checks:
  - mcp_result: not-run
  - adapter_fallback_result: not-run
  - wrapper_stale: no
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: docs-overpromise
- repair_target: docs | tests
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/validate-codegraph-overlay-docs.spec.ts; npm run codegraph:overlay:docs:validate`
- resolution_notes: The registry parser now stops each issue at the next second-level heading, not only at the next numeric issue header, and the validator rejects template placeholders in required fields of real issues.

## CG-NF-20260627-004: Log guard misses low-value Source Code pollution when the top-ranked file is visible

- status: fixed
- reported_at: 2026-06-27
- reporter: codex-agent
- feature_scope: context-pack sourceOrdering diagnostics and log guard quality gating
- query_surface: nanoflow_context_pack | adapter-context-cli | docs-validator
- query: `app.component templateUrl template-url`
- expected: `npm run codegraph:mcp:log:guard` should fail current source-ordering quality when visible Source Code blocks include avoidable low-value script/spec/helper evidence even if the top-ranked overlay file is present and first.
- actual: Before the fix, `sourceOrdering.rankedOverlayFileDetails.lowValuePenalty` and `sourceBlockScore` were logged by the wrapper, but `scripts/analyze-codegraph-mcp-log.cjs` only failed on missing diagnostics, duplicate Source Code sections, missing top-ranked files, or top-ranked files not appearing first.
- evidence:
  - docs_contract: `docs/codegraph-nanoflow-adaptation.md` sourceOrdering log guard contract
  - output_summary: A current context-pack response could show low-value `scripts/generate-codegraph-nanoflow-overlay.mjs` in `firstSourceFiles` with `lowValuePenalty: 6000` and still pass `--fail-on-current-source-ordering`.
  - log_guard: no transport failure; this was analyzer classification coverage missing for low-value source pollution.
- freshness_checks:
  - mcp_result: success
  - adapter_fallback_result: success
  - wrapper_stale: no
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: source-ordering
- repair_target: log-guard | docs | tests
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/analyze-codegraph-mcp-log.spec.ts; npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts --testNamePattern "filters avoidable low-value base source blocks"; npm run codegraph:mcp:log:guard -- --json; npm run codegraph:overlay:docs:validate`
- resolution_notes: The log analyzer now counts `lowValueVisibleSourceBlocks`, classifies avoidable `lowValueSourcePollution`, fails `--fail-on-current-source-ordering` for current matching-disk wrappers, and applies a path-based low-value fallback when ranked details are missing or truncated. The context-pack wrapper also filters avoidable low-value base Source Code blocks even when the base block count is already within budget, and documents `sourceBlockScore` plus low-value source budget diagnostics in the adaptation contract.

## CG-NF-20260627-005: Strict native edge-line evidence blocks expose relation labels or wrong fallback blocks

- status: fixed
- reported_at: 2026-06-27
- reporter: codex-agent
- feature_scope: strict native source evidence quality for Angular host metadata and Supabase Edge Function headers
- query_surface: nanoflow_overlay_query | overlay-query-cli
- query: `host-attribute`; `host-binding`; `edge-function-header`
- expected: Relation-only host metadata queries should render concrete host evidence lines with the owning component as `nodeName`, without appending whole class bodies when precise edge-line evidence exists. `edge-function-header` should render the `serve(...)` handler or helper function that actually contains `req.headers.get(...)`.
- actual: Before the fix, host edge-line codeBlocks used relation labels such as `host-binding` as `nodeName`, standalone `host-attribute` could append whole component class ranges after the precise host lines, and helper-based `edge-function-header` evidence could be replaced by an Edge Function handler block that did not contain the header read.
- evidence:
  - docs_contract: `AGENTS.md` strict native edge-line evidence supplement and `docs/codegraph-nanoflow-adaptation.md` strict native source evidence contract
  - output_summary: Fresh `--native-json` probes showed `host-attribute` class fallback blocks and `edge-function-header` blocks for `cleanup-attachments` that omitted `req.headers.get("Authorization")`.
  - log_guard: no transport failure; this was strict native codeBlock budgeting and source evidence selection.
- freshness_checks:
  - mcp_result: success
  - adapter_fallback_result: success
  - wrapper_stale: no
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: source-ordering
- repair_target: query-selection | native-json | native-markdown | docs | tests
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts --testNamePattern "host-attribute strict native|host metadata|host owners|production host owner|Edge Function handlers for method and header|helper header evidence"; node scripts/query-codegraph-nanoflow-overlay.mjs --query edge-function-header --limit 20 --native-json --skip-refresh`
- resolution_notes: Host metadata and `edge-function-header` exact relation queries now treat edge-line evidence as authoritative. Host blocks keep the real owner `nodeName`; header blocks expand from the header edge line to the containing helper function or `serve(...)` handler with the real `req.headers.get(...)` evidence.

## CG-NF-20260627-006: Source-ordering guard reports a filtered low-value helper as top-ranked missing

- status: fixed
- reported_at: 2026-06-27
- reporter: codex-agent
- feature_scope: context-pack sourceOrdering diagnostics and current log guard reliability
- query_surface: nanoflow_context_pack | adapter-context-cli | log-guard
- query: `sync-required-field`
- expected: When the raw top-ranked overlay file is a low-value test/helper file that the context pack correctly filters out of the Source Code budget, the guard should compare visibility against the top clean candidate instead of failing with `top-ranked-overlay-missing`.
- actual: Before the fix, a fresh `sync-required-field` context pack could show clean production source blocks first while `sourceOrdering.topRankedOverlayFileMissing = true` because the raw top-ranked file was `codegraph-nanoflow-overlay-json-projection-sync-rule-field-budget.spec-helpers.ts`.
- evidence:
  - docs_contract: `docs/codegraph-nanoflow-adaptation.md` sourceOrdering diagnostics and log guard contract
  - output_summary: Fresh adapter-context output had clean production source blocks, but log guard still failed because the missing raw top-ranked file was a low-value helper with positive `lowValuePenalty`.
  - log_guard: `npm run codegraph:mcp:log:guard` reported current `topRankedMissing` for a matching-disk current context wrapper.
- freshness_checks:
  - mcp_result: success
  - adapter_fallback_result: success
  - wrapper_stale: no
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: source-ordering
- repair_target: context-pack-wrapper | log-guard | docs | tests
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/analyze-codegraph-mcp-log.spec.ts --testNamePattern "filtered low-value helper"; npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts --testNamePattern "source-ordering diagnostics|low-value base Source Code"`
- resolution_notes: Wrapper diagnostics now preserve `rawTopRankedOverlayFile` for root-cause analysis but choose `topRankedOverlayFile` after low-value candidates are skipped, with `topRankedOverlayFileSkippedLowValue = true`. The analyzer also treats historical logs with a missing low-value raw top and clean visible production sources as diagnostic, not a current guard failure.

## CG-NF-20260627-007: Issue registry and full gate documentation are not strict enough for machine repair workflows

- status: fixed
- reported_at: 2026-06-27
- reporter: codex-agent
- feature_scope: adaptation issue registry validation and full adapter gate documentation
- query_surface: docs-validator
- query: `npm run codegraph:overlay:docs:validate`; `npm run codegraph:adapter:gate -- --print-plan`
- expected: The issue registry should enforce machine-consumable nested triage fields and controlled vocabularies, and the adaptation docs should describe only the actual full gate runner steps as full-gate steps.
- actual: Before the fix, the docs validator required only top-level registry fields, so missing `freshness_checks.mcp_result` or invalid `query_surface` / `doc_update_needed` values could pass. The full gate paragraph also listed `codegraph:overlay:baseline:manifest` and `codegraph:adapter:quick-gate` as full-gate steps even though the runner plan does not execute them as separate steps.
- evidence:
  - docs_contract: `docs/codegraph-nanoflow-adaptation-issues.md` registry template and `docs/codegraph-nanoflow-adaptation.md` gate contract
  - output_summary: Read-only review compared the docs with `scripts/run-codegraph-adapter-gate.cjs` and found the full-gate step drift; validator tests showed nested registry fields were not enforced.
  - log_guard: not relevant; this was documentation and validator contract hardening.
- freshness_checks:
  - mcp_result: success
  - adapter_fallback_result: not-run
  - wrapper_stale: no
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: docs-overpromise
- repair_target: docs | tests
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/validate-codegraph-overlay-docs.spec.ts; npm run codegraph:overlay:docs:validate`
- resolution_notes: The docs validator now parses required nested registry sections, validates `query_surface`, `likely_root_cause`, `repair_target`, `doc_update_needed`, and freshness-check values, and the full gate documentation now matches the actual runner plan while labeling baseline manifest and quick gate as auxiliary gates.

## CG-NF-20260627-008: Same-bucket Storage policies collapse into one strict native source block

- status: fixed
- reported_at: 2026-06-27
- reporter: codex-agent
- feature_scope: Supabase Storage bucket overlay and strict native source evidence
- query_surface: nanoflow_overlay_query | overlay-query-cli
- query: `supabase-storage-bucket`
- expected: Each `storage.objects` policy that references the same bucket should remain a distinct native-shaped node/edge endpoint, and strict native JSON/Markdown should expose complete SQL statement codeBlocks for multiple policies when budget is available.
- actual: Before the fix, generator node IDs used only `supabase-storage-bucket:bucket-name`, so five `attachments` policies in one migration merged into one node spanning lines 1697-1722. Query-side output either leaked the next policy header into a codeBlock or showed only the first policy while leaving native codeBlock slots unused.
- evidence:
  - docs_contract: `docs/codegraph-nanoflow-adaptation.md:317`
  - output_summary: `node scripts/query-codegraph-nanoflow-overlay.mjs --query "supabase-storage-bucket" --native-json --skip-refresh` returned a merged `attachments` entry point for `20260126074130_remote_commit.sql:1697-1722` and only one migration SQL codeBlock.
  - log_guard: no transport failure; reproduced through fresh overlay-query CLI and fixed generator/query output.
- freshness_checks:
  - mcp_result: success
  - adapter_fallback_result: success
  - wrapper_stale: no
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: implementation-gap | source-ordering
- repair_target: generator | native-json | native-markdown | docs | tests
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts --testNamePattern "storage bucket|storage owner|storage policy|SQL statement"; npm run codegraph:overlay:docs:validate`
- resolution_notes: Storage policy bucket node IDs are now scoped by bucket, policy name, and policy line. SQL statement source blocks expand from the statement start to the terminating semicolon, so same-bucket policies produce separate complete codeBlocks without leaking adjacent policy headers. The overlay baseline now records 6 `supabase-storage-bucket` nodes and 6 edges.

## CG-NF-20260627-009: Explicit i18n/icon context-pack queries are treated as low-value noise

- status: fixed
- reported_at: 2026-06-27
- reporter: codex-agent
- feature_scope: nanoflow_context_pack source ordering, related symbols, and low-value path filtering
- query_surface: nanoflow_context_pack | adapter-context-cli | log-guard
- query: `i18n`; `query codegraph nanoflow overlay mjs template-url style-url`; broad `service`
- expected: Low-value path demotion should suppress test/spec/helper/icon/i18n/script files only when they are incidental. If the query explicitly asks for `i18n`, `icon`, or a tokenized script filename, the matching file should remain eligible. Broad implementation queries should still demote spec-helper Related Symbols and relationships behind production files.
- actual: Before the fix, `i18n` context packs ranked `src/config/dock-i18n.config.ts` in relationships but omitted it from the first source block budget, and log guard still flagged explicitly requested i18n/script blocks as pollution. Broad `service` context packs had improved source blocks but Related Symbols could still start with `*.spec-helpers.ts`.
- evidence:
  - docs_contract: `AGENTS.md:62` and `docs/codegraph-nanoflow-adaptation.md:1059`
  - output_summary: `npm run codegraph:adapter:context -- --query i18n --json` now renders `src/config/dock-i18n.config.ts` as the first Source Code block with `lowValueSourcePollution=0`; tokenized script filename queries also keep `scripts/query-codegraph-nanoflow-overlay.mjs` clean.
  - log_guard: analyzer now treats explicitly requested i18n/icon/tokenized script paths as intentional, while still failing avoidable low-value pollution for broad queries.
- freshness_checks:
  - mcp_result: success
  - adapter_fallback_result: success
  - wrapper_stale: no
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: query-ranking | source-ordering
- repair_target: context-pack-wrapper | log-guard | tests
- doc_update_needed: no
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts --testNamePattern "i18n|service context-pack|service related"; npx vitest run --config vitest.config.mts src/tests/scripts/analyze-codegraph-mcp-log.spec.ts --testNamePattern "i18n|tokenized script"`
- resolution_notes: Context-pack scoring now recognizes explicit low-value-class requests and tokenized file-stem coverage before applying low-value penalties. Related Symbols and relationship ordering use the same production-first demotion, and the log analyzer mirrors the i18n/icon/tokenized path exemptions.

## CG-NF-20260627-010: Log guard loses matching-disk context diagnostics behind a later stale wrapper

- status: fixed
- reported_at: 2026-06-27
- reporter: codex-agent
- feature_scope: MCP wrapper log diagnostics and current-disk source-ordering guard reliability
- query_surface: log-guard | adapter-context-cli
- query: `npm run codegraph:mcp:log:guard`; `npm run codegraph:adapter:context -- --query i18n --json`
- expected: When the latest context response came from a stale wrapper but an earlier matching-disk wrapper produced context-pack source-ordering evidence, `currentDiskContextWrapper` and `currentDiskContextSourceOrdering` should retain that matching-disk evidence for repair decisions.
- actual: Before the fix, the analyzer selected `currentDiskContextWrapper` but skipped its events while aggregating current diagnostics if its run differed from both `currentWrapper` and `currentContextWrapper`, leaving `currentDiskContextSourceOrdering.total = 0`.
- evidence:
  - docs_contract: `docs/codegraph-nanoflow-adaptation.md:1603`
  - output_summary: A synthetic log with a fresh bad context response followed by a stale clean context response produced a non-null `currentDiskContextWrapper` but no disk-context source-ordering metrics.
  - log_guard: no transport failure; this was a log analyzer aggregation bug and documentation contract gap.
- freshness_checks:
  - mcp_result: not-run
  - adapter_fallback_result: success
  - wrapper_stale: yes
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: stale-wrapper | source-ordering
- repair_target: log-guard | docs | tests
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/analyze-codegraph-mcp-log.spec.ts; npx vitest run --config vitest.config.mts src/tests/scripts/validate-codegraph-overlay-docs.spec.ts; npm run codegraph:overlay:docs:validate`
- resolution_notes: The analyzer now records events for `currentDiskContextRunId` in the current aggregation pass, prints and validates `currentDiskContextSourceOrdering`, and the docs/validator require the field so stale-host diagnosis cannot silently drop matching-disk context-pack quality evidence.

## CG-NF-20260627-011: Realtime unsubscribe cleanup is missed when the channel name is dynamic

- status: fixed
- reported_at: 2026-06-27
- reporter: codex-agent
- feature_scope: Supabase Realtime lifecycle cleanup overlay coverage and strict native source evidence
- query_surface: overlay-query-cli
- query: `node scripts/query-codegraph-nanoflow-overlay.mjs --query supabase-realtime-unsubscribe --native-json --skip-refresh`
- expected: `supabase-realtime-unsubscribe` should return owner function/method entry points, native `references` edges, and source blocks for real `channel.unsubscribe()` cleanup even when the channel name cannot be statically reconstructed.
- actual: Before the fix, dynamic channel variables were not recognized as Realtime channel cleanup evidence, so `supabase-realtime-unsubscribe` could return zero lifecycle edges despite real `channel.unsubscribe()` calls.
- evidence:
  - docs_contract: `docs/codegraph-nanoflow-adaptation.md:157` and `docs/codegraph-nanoflow-adaptation.md:353`
  - output_summary: The fixed strict native query returns 4 nodes, 2 `references` edges, and 2 owner codeBlocks for `unsubscribeRealtimeChannel` and `BlackBoxSyncQueueRealtimeLayer::teardownRealtimeSubscription`.
  - log_guard: No current transport failure is needed to reproduce; the issue was generator coverage for dynamic channel variables.
- freshness_checks:
  - mcp_result: not-run
  - adapter_fallback_result: success
  - wrapper_stale: no
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: implementation-gap
- repair_target: generator | native-json | native-markdown | tests | docs
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts --testNamePattern "channel names are not statically known"; node scripts/query-codegraph-nanoflow-overlay.mjs --query supabase-realtime-unsubscribe --native-json --skip-refresh`
- resolution_notes: The generator now treats `channel.unsubscribe()` as lifecycle cleanup when the receiver looks like a Realtime channel even if the static channel name is unknown, preserving `channelVariable` and owner-scoped source evidence.

## CG-NF-20260627-012: Log guard accepts partial source-ordering diagnostics and misses current-disk failures

- status: fixed
- reported_at: 2026-06-27
- reporter: codex-agent
- feature_scope: MCP wrapper log diagnostics and source-ordering guard reliability
- query_surface: log-guard | adapter-context-cli
- query: `npm run codegraph:mcp:log:guard`; `npm run codegraph:adapter:context -- --query icon --json`
- expected: The log guard should treat incomplete `sourceOrdering` objects as missing diagnostics, and `--fail-on-current-source-ordering` should inspect matching-disk context evidence when a later stale wrapper produced the latest context response.
- actual: Before the fix, partial `sourceOrdering` payloads could count as valid diagnostics, and current-disk ordering failures were ignored when they came from a run different from both `currentWrapper` and `currentContextWrapper`.
- evidence:
  - docs_contract: `docs/codegraph-nanoflow-adaptation.md:1518` and `docs/codegraph-nanoflow-adaptation.md:1606`
  - output_summary: Focused analyzer tests now cover partial diagnostics and a fresh bad context response followed by a stale context response; fresh adapter context runs report complete source-ordering diagnostics.
  - log_guard: Historical `.codegraph/nanoflow-mcp-wrapper.log` still contains stale old-wrapper evidence, but fresh wrapper context diagnostics show `missingDiagnostics=0` and `lowValueSourcePollution=0`.
- freshness_checks:
  - mcp_result: not-run
  - adapter_fallback_result: success
  - wrapper_stale: yes
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: source-ordering | stale-wrapper
- repair_target: log-guard | docs | tests
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/analyze-codegraph-mcp-log.spec.ts; npm run codegraph:mcp:log:guard`
- resolution_notes: The analyzer now requires the full source-ordering field set, reports partial payloads as missing diagnostics, and aggregates `currentDiskContextSourceOrdering` for the matching-disk context run even when stale host output is newer.

## CG-NF-20260627-013: Issue registry accepts malformed nested triage fields

- status: fixed
- reported_at: 2026-06-27
- reporter: codex-agent
- feature_scope: adaptation issue registry validation and machine-consumable repair backlog
- query_surface: docs-validator
- query: `npm run codegraph:overlay:docs:validate`
- expected: Nested `evidence.*` and `freshness_checks.*` fields should be required, duplicate nested fields should fail validation, unknown nested fields should fail validation, and freshness enum values should remain controlled.
- actual: Before the fix, nested registry fields could be duplicated, omitted, or misspelled without a validator failure, weakening the machine repair workflow promised to other agents.
- evidence:
  - docs_contract: `docs/codegraph-nanoflow-adaptation-issues.md` required triage schema and `AGENTS.md:48`
  - output_summary: Validator fixtures now fail on duplicate or unknown nested `evidence.*` and `freshness_checks.*` fields.
  - log_guard: Not relevant; this was a docs-validator contract gap.
- freshness_checks:
  - mcp_result: not-run
  - adapter_fallback_result: not-run
  - wrapper_stale: no
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: docs-overpromise
- repair_target: docs | tests
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/validate-codegraph-overlay-docs.spec.ts; npm run codegraph:overlay:docs:validate`
- resolution_notes: The docs validator now parses nested field diagnostics for `evidence` and `freshness_checks`, rejects duplicate or unknown nested keys, and keeps the registry enforceable for automated repair agents.

## CG-NF-20260627-014: Context-pack related output is polluted by unrequested script and worker paths

- status: fixed
- reported_at: 2026-06-27
- reporter: codex-agent
- feature_scope: nanoflow_context_pack source ordering, Relationships display, and Related Symbols relevance
- query_surface: adapter-context-cli | log-guard
- query: `npm run codegraph:adapter:context -- --query "route guard" --json`; `npm run codegraph:adapter:context -- --query icon --json`
- expected: Ordinary context-pack queries should demote unrequested `scripts/`, `.github/`, `cloudflare/workers-static-assets/`, test/spec/helper/icon/i18n/generated paths from visible source, overlay Relationships, and Related Symbols when clean project implementation files are available.
- actual: Before the fix, broad `route guard` and generic `icon` context packs could show tokenized script or worker/static-asset paths in overlay Relationships or Related Symbols even when the visible source blocks were otherwise clean.
- evidence:
  - docs_contract: `AGENTS.md:60`, `AGENTS.md:89`, and `docs/codegraph-nanoflow-adaptation.md:1085`
  - output_summary: Fresh adapter-context runs for `route guard` and `icon` now complete with matching-disk wrapper diagnostics and `lowValueSourcePollution=0`; focused fixtures cover script/worker demotion and tokenized script relationship filtering.
  - log_guard: Fresh adapter wrapper diagnostics report complete source ordering with `missingDiagnostics=0`, while the historical global log still recommends treating old stale-wrapper source-ordering issues as historical evidence.
- freshness_checks:
  - mcp_result: not-run
  - adapter_fallback_result: success
  - wrapper_stale: yes
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: query-ranking | source-ordering | transport
- repair_target: context-pack-wrapper | log-guard | docs | tests
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts --testNamePattern "generic icon context-pack|route guard relationships"; npm run codegraph:mcp:log:guard`
- resolution_notes: The wrapper now classifies unrequested script, GitHub metadata, worker-static-asset, test/spec/helper/icon/i18n/generated paths as low-value for context-pack display, demotes them from source ordering, and filters NanoFlow overlay-rendered Relationships and Related Symbols when clean requested source remains.

## CG-NF-20260627-015: Host MCP Transport closed is misdiagnosed as current adapter failure

- status: fixed
- reported_at: 2026-06-27
- reporter: codex-agent
- feature_scope: MCP host transport diagnostics, stale wrapper triage, and adapter fallback recovery
- query_surface: nanoflow_context_pack | adapter-context-cli | log-guard | mcp-smoke
- query: `codegraph/nanoflow_context_pack query="codegraph adapter doctor stale host MCP Transport closed context-pack source ordering quality issue registry"; npm run codegraph:adapter:doctor -- --explain; node scripts/smoke-codegraph-mcp-wrapper.cjs --repeat 3 --timeout-ms 90000`
- expected: A host-side `Transport closed` should be distinguished from a current on-disk wrapper crash, and the repair path should identify stale `currentContextWrapper` evidence plus a fresh wrapper smoke result.
- actual: Before the fix, the screenshot-level error looked like a CodeGraph adapter crash even though fresh wrapper smoke passed and the global log showed the latest context-producing host wrapper was stale against the current disk script.
- evidence:
  - docs_contract: `AGENTS.md:59` and `docs/codegraph-nanoflow-adaptation.md:1409`
  - output_summary: `codegraph/nanoflow_context_pack` returned `Transport closed`; fresh smoke completed `tools/list -> nanoflow_context_pack -> nanoflow_overlay_query` successfully; adapter doctor now prints `hostMcp: log=present currentWrapper=fresh currentContextWrapper=stale`.
  - log_guard: `npm run codegraph:mcp:log:guard -- --json` reported current transport healthy for matching-disk wrapper evidence while the host context wrapper hash was stale, with recovery recommending host/session restart or fresh adapter fallback.
- freshness_checks:
  - mcp_result: failed
  - adapter_fallback_result: success
  - wrapper_stale: yes
  - overlay_stale: no
  - transport_failure: yes
- likely_root_cause: stale-wrapper | transport
- repair_target: log-guard | docs | tests
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-adapter-doctor.spec.ts; node scripts/smoke-codegraph-mcp-wrapper.cjs --repeat 3 --timeout-ms 90000`
- resolution_notes: The adapter doctor now inspects `.codegraph/nanoflow-mcp-wrapper.log`, compares latest wrapper/context wrapper startup hashes to the current disk script, reports stale host context wrappers before transport errors are blamed on the adapter, and prints the adapter-first recovery command.

## CG-NF-20260627-016: Compound context-pack diagnostic query hides AGENTS config evidence behind generic noise

- status: fixed
- reported_at: 2026-06-27
- reporter: codex-agent
- feature_scope: nanoflow_context_pack query selection, source ordering, and AGENTS config hard-rule evidence
- query_surface: nanoflow_context_pack | adapter-context-cli
- query: `npm run codegraph:adapter:context -- --query "floating tree config context-pack quality source ordering low-value related symbols codegraph nanoflow overlay" --json`
- expected: Context-pack overlay selection should preserve focused project intent such as `floating tree config`, show AGENTS hard-rule/config evidence, and rank `FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH` plus `src/config/layout.config.ts` ahead of generic CodeGraph/debug words.
- actual: Before the fix, the full diagnostic query was passed into overlay selection unchanged, so `context-pack`, `source ordering`, `quality`, `related symbols`, `codegraph`, `nanoflow`, and `overlay` terms overpowered the project query and could return tooling/spec noise instead of the documented config evidence.
- evidence:
  - docs_contract: `AGENTS.md:60`, `AGENTS.md:62`, and `docs/codegraph-nanoflow-adaptation.md:1505`
  - output_summary: Fresh adapter context now records `overlayQuery: "floating tree config"` and places `AGENTS.md` plus `src/config/layout.config.ts` source evidence ahead of generic context-pack/debug matches.
  - log_guard: Fresh matching-disk wrapper context diagnostics show complete sourceOrdering fields with `lowValueSourcePollution=0`.
- freshness_checks:
  - mcp_result: failed
  - adapter_fallback_result: success
  - wrapper_stale: yes
  - overlay_stale: no
  - transport_failure: yes
- likely_root_cause: query-ranking | source-ordering | stale-wrapper | transport
- repair_target: query-selection | context-pack-wrapper | docs | tests
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts --testNamePattern "compound AGENTS config"; npm run codegraph:adapter:context -- --query "floating tree config context-pack quality source ordering low-value related symbols codegraph nanoflow overlay" --json`
- resolution_notes: Context-pack overlay queries now strip diagnostic noise segments unless the query has explicit test/path/tooling intent, and compound symbol scoring recognizes dotted all-caps config handles such as `FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH`.

## CG-NF-20260627-017: Broad context-pack Related Symbols can be filled only by spec helpers

- status: fixed
- reported_at: 2026-06-27
- reporter: codex-agent
- feature_scope: nanoflow_context_pack Related Symbols relevance and low-value path suppression
- query_surface: adapter-context-cli | nanoflow_context_pack
- query: `npm run codegraph:adapter:context -- --query service --json`
- expected: For ordinary broad implementation queries, context-pack `### Related Symbols` should not display only test/spec/helper symbols when production source blocks are available; if filtering removes every low-value overlay symbol, the section should say no overlay symbols matched rather than filling the response with spec helpers.
- actual: Before the fix, broad `service` context packs could show clean production source blocks while `Related Symbols` was still dominated by `*.spec-helpers.ts` overlay nodes, making the result look noisy and less native-quality.
- evidence:
  - docs_contract: `AGENTS.md:60` and `docs/codegraph-nanoflow-adaptation.md:1088`
  - output_summary: The focused fixture now renders `No overlay symbols matched this query.` when all overlay related nodes are low-value spec helpers and the query does not request tests.
  - log_guard: This is a context-pack formatting/ranking issue; no current transport failure is required to reproduce with the fixture.
- freshness_checks:
  - mcp_result: failed
  - adapter_fallback_result: success
  - wrapper_stale: yes
  - overlay_stale: no
  - transport_failure: yes
- likely_root_cause: query-ranking | source-ordering | stale-wrapper | transport
- repair_target: context-pack-wrapper | docs | tests
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts --testNamePattern "only spec helpers"`
- resolution_notes: Context-pack Related Symbols now uses the same low-value file ranking as source ordering, suppresses all-low-value related groups for non-test queries, and emits an explicit no-match line instead of letting spec/helper nodes occupy the visible answer.

## CG-NF-20260627-018: Adapter context fallback can hide base CodeGraph hangs behind its own timeout

- status: fixed
- reported_at: 2026-06-27
- reporter: codex-agent
- feature_scope: adapter-context-cli timeout diagnostics and base CodeGraph timeout classification
- query_surface: adapter-context-cli | mcp-smoke | log-guard
- query: `npm run codegraph:adapter:context -- --query "codegraph adapter doctor stale host MCP Transport closed context-pack source ordering quality issue registry" --timeout-ms 90000 --json`
- expected: When base `codegraph_explore` hangs or runs past budget for a wide context-pack query, the wrapper should return a client-visible `base-codegraph-timeout` response and log `nanoflow.context.timeout` before the outer adapter CLI gives up.
- actual: Before the fix, `codegraph:adapter:context` gave the wrapper and the outer CLI the same timeout budget, so the parent process could reject with opaque `Timed out waiting for nanoflow_context_pack` and kill the wrapper before `nanoflow.context.timeout` was emitted.
- evidence:
  - docs_contract: `docs/codegraph-nanoflow-adaptation.md:1463` and `docs/codegraph-nanoflow-adaptation.md:1729`
  - output_summary: A fake CodeGraph child that never responds to `codegraph_explore` reproduced the opaque adapter timeout; after the fix the wrapper reports `NanoFlow context pack timed out waiting for base CodeGraph` and logs `failureClass: "base-codegraph-timeout"` first.
  - log_guard: Isolated repro logs show `nanoflow.context.child.request` without a child response before the fix; the fixed path logs `nanoflow.context.timeout` before adapter termination.
- freshness_checks:
  - mcp_result: not-run
  - adapter_fallback_result: success
  - wrapper_stale: no
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: implementation-gap
- repair_target: context-pack-wrapper | tests | docs
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-mcp-smoke.spec.ts --testNamePattern "wrapper report base CodeGraph timeout"; npm run codegraph:adapter:context -- --query "codegraph adapter doctor stale host MCP Transport closed context-pack source ordering quality issue registry" --timeout-ms 10000 --json`
- resolution_notes: The adapter context CLI now gives the wrapper an internal request budget below the outer CLI timeout and exposes both `timeoutMs` and `wrapperRequestTimeoutMs` in JSON output, so base CodeGraph hangs are classified inside wrapper diagnostics before the adapter process times out.

## CG-NF-20260627-019: Host tool registry can hide configured CodeGraph MCP tools from agents

- status: fixed
- reported_at: 2026-06-27
- reporter: codex-agent
- feature_scope: MCP tool discovery diagnostics and adapter-first fallback triage
- query_surface: tool-discovery | adapter-context-cli | log-guard
- query: `tool_search query="codegraph nanoflow_context_pack codegraph_explore mcp__codegraph"; npm run codegraph:adapter:context -- --query "MCP tool discovery nanoflow_context_pack tool panel unsupported call adapter context fallback AGENTS codegraph" --json --timeout-ms 90000`
- expected: When the agent runtime does not expose `mcp__codegraph.*` tools, the triage path should classify that as host tool-discovery unavailability, then verify the repository MCP config and adapter fallback before blaming NanoFlow wrapper code.
- actual: The screenshot-level agent correctly observed that the current tool panel did not expose `nanoflow_context_pack` or native CodeGraph MCP tools, but the existing runbook did not name this as a separate boundary from stale wrapper, transport closed, or adapter failure.
- evidence:
  - docs_contract: `AGENTS.md:21` and `docs/codegraph-nanoflow-adaptation.md:1599`
  - output_summary: Current tool discovery returned `Found 0 tools`, while fresh `codegraph:adapter:context` succeeded with `transportHealthy=true`, matching wrapper and disk script hashes, and a configured `@colbymchenry/codegraph@1.1.1` target.
  - log_guard: Fresh wrapper diagnostics showed matching-disk context evidence and no critical transport failures; this boundary occurs before wrapper tool calls reach `.codegraph/nanoflow-mcp-wrapper.log`.
- freshness_checks:
  - mcp_result: not-available
  - adapter_fallback_result: success
  - wrapper_stale: no
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: tool-discovery
- repair_target: log-guard | docs | tests
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-adapter-doctor.spec.ts --testNamePattern "configured MCP entrypoints"; npm run codegraph:adapter:doctor -- --explain; npm run codegraph:overlay:docs:validate`
- resolution_notes: Adapter doctor now reports Codex `C:\Users\MI\.codex\config.toml` CodeGraph server configuration, wrapper script presence, pinned CodeGraph target, and an explicit `unknown-host-state` marker for runtime tool discovery. Codex adapter tooling does not read or fall back to `.vscode/mcp.json`, so a missing `mcp__codegraph.*` tool panel can be diagnosed as a Codex host registry issue after adapter fallback succeeds.

## CG-NF-20260627-020: Adapter context fallback can keep timing out or truncating after base timeout diagnostics

- status: fixed
- reported_at: 2026-06-27
- reporter: codex-agent
- feature_scope: adapter-context-cli maxFiles control, base-timeout retry, and oversized context-pack triage
- query_surface: adapter-context-cli | nanoflow_context_pack | log-guard
- query: `npm run codegraph:adapter:context -- --query "WorkspaceShellBeforeUnloadController setup cleanup beforeUnloadGuard beforeUnloadManager isBrowser" --json --timeout-ms 90000`
- expected: When a wide context-pack query causes base `codegraph_explore` to time out or produce a response too large for the agent/tool UI, the adapter-preserving fallback should expose a native `maxFiles` control and automatically retry a base timeout with a narrower source budget before forcing agents to abandon NanoFlow context.
- actual: Before the fix, the wrapper could correctly report `base-codegraph-timeout`, but `codegraph:adapter:context` always called `nanoflow_context_pack` without `maxFiles` and failed on the first timeout. Agents then had to jump to native CodeGraph CLI or targeted file reads even though a smaller native-style context pack could still succeed.
- evidence:
  - docs_contract: `docs/codegraph-nanoflow-adaptation.md:1422` and `AGENTS.md:29`
  - output_summary: Screenshot-level adapter fallback commands timed out after wrapper-owned base CodeGraph timeout; MCP/tool output was also clipped for broad source-heavy queries, requiring manual targeted disk rereads.
  - log_guard: The wrapper remained alive and classified the failure as `base-codegraph-timeout`; the missing behavior was adapter CLI query-budget control, not transport recovery.
- freshness_checks:
  - mcp_result: success
  - adapter_fallback_result: success
  - wrapper_stale: no
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: implementation-gap
- repair_target: query-selection | tests | docs
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-adapter-context-cli.spec.ts; npm run codegraph:overlay:docs:validate`
- resolution_notes: `codegraph:adapter:context` now accepts `--max-files`, forwards it into `nanoflow_context_pack`, records per-attempt diagnostics, and retries `base-codegraph-timeout` once with `maxFiles=1` so broad/truncated context queries can degrade to a smaller native-style context before falling through to overlay/native CLI fallback. If the retry returns base native Exploration/source but the combined overlay section times out, the adapter preserves the usable context as a successful partial result while keeping `mcpIsError=true`, `partial=true`, and `failureClass=overlay-timeout` in diagnostics.

## CG-NF-20260627-021: Default adapter context loses wrapper auto-narrowing for tooling timeout queries

- status: fixed
- reported_at: 2026-06-27
- reporter: codex-agent
- feature_scope: adapter-context-cli default maxFiles semantics and CodeGraph tooling source ordering
- query_surface: adapter-context-cli | nanoflow_context_pack | log-guard
- query: `npm run codegraph:adapter:context -- --query "codegraph mcp wrapper timeout truncation adapter context log guard source ordering overlay timeout currentContextSourceOrdering NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS" --json --timeout-ms 120000`
- expected: Default adapter fallback should preserve the wrapper's own `maxFiles` defaulting semantics, so focused CodeGraph/MCP tooling queries can immediately use `baseMaxFiles=1`; source ordering should prioritize relevant CodeGraph tooling scripts ahead of app logger or guard files for timeout/log diagnostics.
- actual: Before the fix, the CLI default `maxFiles: 8` was always serialized into the `nanoflow_context_pack` MCP call. The wrapper treated it as user-explicit, skipped its focused-query `baseMaxFiles=1` optimization, waited for `base-codegraph-timeout`, and only then retried with `maxFiles=1`. Because root tooling scripts are normally low-value paths, source-ordering diagnostics could also skip the relevant CodeGraph script and let app logger/guard source consume visible budget.
- evidence:
  - docs_contract: `AGENTS.md:29` and `docs/codegraph-nanoflow-adaptation.md:1460`
  - output_summary: Fresh adapter reproduction showed first attempt `failureClass: "base-codegraph-timeout-overlay-only"` and second attempt success for the same query; total runtime was about two minutes even though the focused retry was enough.
  - log_guard: Current wrapper matched disk and transport was healthy; the issue was request-shape and source-ranking semantics, not stale wrapper or transport closure.
- freshness_checks:
  - mcp_result: success
  - adapter_fallback_result: success
  - wrapper_stale: no
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: implementation-gap | source-ordering
- repair_target: query-selection | context-pack-wrapper | log-guard | tests | docs
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-adapter-context-cli.spec.ts src/tests/scripts/analyze-codegraph-mcp-log.spec.ts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts --testNamePattern "auto-narrow default maxFiles|overlay-only timeout recovery|retries base CodeGraph timeouts|timeout source ordering|CodeGraph tooling source"; npm run codegraph:adapter:context -- --query "codegraph mcp wrapper timeout truncation adapter context log guard source ordering overlay timeout currentContextSourceOrdering NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS" --json --timeout-ms 30000; npm run codegraph:mcp:log:guard -- --json`
- resolution_notes: Default adapter context calls now omit `maxFiles` unless the user explicitly passes `--max-files`, while still reporting the effective default in diagnostics and preserving explicit max-file retry behavior. Tooling timeout/waiting terms now trigger focused base queries, CodeGraph/MCP tooling scripts are exempt from low-value source penalties when the query is anchored to CodeGraph/NanoFlow/MCP tooling, and log guard now counts `nanoflow.context.timeout` sourceOrdering as current context evidence so overlay-only timeout quality does not disappear from diagnostics.

## CG-NF-20260627-022: Stale wrapper and exact wrapper symbol queries still push agents to ordinary file search

- status: fixed
- reported_at: 2026-06-27
- reporter: codex-agent
- feature_scope: context-pack-wrapper query focus, same-file source expansion, and adapter fallback JSON size
- query_surface: nanoflow_context_pack | adapter-context-cli | log-guard
- query: `stale wrapper host restart`; `stale wrapper assertions return exit host restart test`; `forwardToCodegraph`
- expected: Stale-wrapper lifecycle queries should rank wrapper/log/smoke/test evidence ahead of app `*host*`, `return`, or `exit` files. If the query asks for tests or assertions, context-pack source blocks should expose the relevant CodeGraph/MCP lifecycle diagnostics assertion line. Exact wrapper symbols should show the requested function body even when the base CodeGraph source block already contains the same file. Adapter fallback JSON should not include full overlay markdown/source by default.
- actual: Before the fix, `stale wrapper host restart` let app host/lazy-load files consume visible source budget because `scripts/` paths were still low-value without an explicit CodeGraph/MCP anchor. Natural assertion wording such as `stale wrapper assertions return exit host restart test` could be focused to generic `wrapper return exit`, surfacing business methods like `shouldExitEditMode` or `ReturningUpdatedAt`, and later could keep unrelated `shutdown` blocks such as `serve-pwa-preview.cjs`. `forwardToCodegraph` could show `scripts/codegraph-nanoflow-mcp-stdio.cjs` without the `forwardToCodegraph` body because same-file overlay source injection was skipped. Adapter fallback JSON also carried full overlay payloads, which could add megabytes of unrelated provenance output.
- evidence:
  - docs_contract: `AGENTS.md:29` and `docs/codegraph-nanoflow-adaptation.md:1420`
  - output_summary: Fresh adapter verification now ranks `scripts/codegraph-nanoflow-mcp-stdio.cjs`, `scripts/analyze-codegraph-mcp-log.cjs`, `scripts/smoke-codegraph-mcp-wrapper.cjs`, and `scripts/run-codegraph-adapter-gate.cjs` for `stale wrapper host restart`; assertion wording now surfaces `src/tests/scripts/codegraph-nanoflow-overlay-mcp-lifecycle-diagnostics.spec-helpers.ts` with `wrapper.shutdown.stale-wrapper-script` while excluding `serve-pwa-preview.cjs`, `shouldExitEditMode`, and `ReturningUpdatedAt`; `forwardToCodegraph` now includes `function forwardToCodegraph(jsonText)`, `logWrapperScriptStaleIfNeeded`, and the `isNanoFlowContextPackToolCall` branch.
  - log_guard: Current transport is healthy and source-ordering has no current issue, but the long-lived host MCP wrapper is stale against disk; use fresh adapter fallback or restart the MCP host before judging panel behavior.
- freshness_checks:
  - mcp_result: success
  - adapter_fallback_result: success
  - wrapper_stale: yes
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: query-ranking | source-ordering
- repair_target: query-selection | context-pack-wrapper | tests | docs
- doc_update_needed: no
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts -t "context-pack|tooling|stale wrapper assertion"; npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-adapter-context-cli.spec.ts; node scripts/codegraph-adapter-context.cjs --query "stale wrapper assertions return exit host restart test" --json --timeout-ms 90000; node scripts/codegraph-adapter-context.cjs --query "forwardToCodegraph" --json --timeout-ms 90000; npm run codegraph:mcp:smoke -- --repeat 1 --timeout-ms 90000; npm run codegraph:mcp:log:guard -- --json`
- resolution_notes: Added lifecycle-focused wrapper query terms, exempted stale-wrapper tooling scripts and CodeGraph/MCP diagnostics tests from low-value penalties, allowed same-file overlay source blocks when the base block omits focused node lines, added focused assertion-line windows for large lifecycle diagnostic test functions, filtered unrelated `shutdown` scripts from stale-wrapper assertion queries, and compacted adapter fallback overlay JSON by default with `--include-overlay-json` as the explicit full-payload escape hatch.

## CG-NF-20260627-023: Android widget provider queries miss Manifest, Kotlin receiver, and XML provider evidence

- status: fixed
- reported_at: 2026-06-27
- reporter: codex-agent
- feature_scope: Android host/widget project semantics and strict native source evidence
- query_surface: nanoflow_context_pack | nanoflow_overlay_query | overlay-query-cli | adapter-context-cli
- query: `android-widget-provider NanoflowWidgetReceiver nanoflow_focus_widget_info`; `NanoflowWidgetReceiver android widget provider receiver`
- expected: Android widget provider queries should return native-shaped Manifest/Kotlin/XML context: the `NanoflowWidgetReceiver` Kotlin class, `AndroidManifest.xml` receiver declaration, `@xml/nanoflow_focus_widget_info` provider resource, `@layout/nanoflow_widget_compact` resource reference, `references` edges with `metadata.relation = "android-manifest-component"` / `"android-widget-provider"`, and strict native code blocks for the Kotlin receiver and XML provider.
- actual: Before the fix, Android widget/provider queries returned no Android graph nodes in overlay-query fixtures and real context-pack output was filled by TypeScript bootstrap/helper sources rather than Manifest/Kotlin/XML evidence.
- evidence:
  - docs_contract: `docs/codegraph-nanoflow-adaptation.md` Android project semantics section added with this repair; prior behavior was a documented project-specific adaptation gap under the active native-quality objective.
  - output_summary: The RED fixture query returned `response.nodes = []`; after the fix it returns Android `class`/`file` nodes, `android-widget-provider` / `android-manifest-component` / `android-resource-reference` edges, and strict native Kotlin/XML codeBlocks.
  - log_guard: No transport failure is required to reproduce; the host MCP wrapper is known stale against disk in the current long-lived session, so fresh overlay-query CLI and adapter-context CLI are the authoritative verification surfaces.
- freshness_checks:
  - mcp_result: success
  - adapter_fallback_result: success
  - wrapper_stale: yes
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: implementation-gap | query-ranking | source-ordering
- repair_target: generator | query-selection | native-json | native-markdown | docs | tests
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts -t "Android widget provider|Context7 source-map relationships in strict native Markdown order"; npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts -t "Android widget provider|Angular external template|strict native JSON|strict native Markdown|explicit path|template-url|style-url|source blocks"; npm run codegraph:overlay:validate; node scripts/query-codegraph-nanoflow-overlay.mjs --query "android-widget-provider NanoflowWidgetReceiver nanoflow_focus_widget_info" --limit 20 --native-json --skip-refresh`
- resolution_notes: Added Android overlay extraction for Manifest component declarations, Kotlin class declarations, app widget provider XML resources, and XML resource references. Query output now treats `android-widget-provider` as a source-first relation with file endpoint code blocks, supports `.kt` and `.xml` path/language inference, and keeps strict native Markdown section headers stable even when Related Symbols is empty.

## CG-NF-20260628-001: Issue registry status queries are polluted by app open methods

- status: fixed
- reported_at: 2026-06-28
- reporter: codex-agent
- feature_scope: context-pack issue registry query focus and source ordering
- query_surface: nanoflow_context_pack | adapter-context-cli
- query: `codegraph nanoflow adaptation issues open fixed remaining gaps issue registry docs context-pack quality source ordering`
- expected: Issue-registry and remaining-gap queries should focus on `docs/codegraph-nanoflow-adaptation-issues.md`, preserve the user's original exploration heading, and show registry entries with `status: open` / `status: fixed` before any unrelated app method named `open`.
- actual: Before the fix, `open` and `fixed` were treated as normal project symbol terms. Context-pack source blocks were filled by application `open()` methods such as `FlowLinkConnectionEditorController.open`, while the issue registry appeared only in related symbols or not in the visible source budget.
- evidence:
  - docs_contract: `AGENTS.md` CodeGraph adaptation issue registry rule and `docs/codegraph-nanoflow-adaptation.md` context-pack quality contract
  - output_summary: The RED fixture returned `baseQuery=codegraph nanoflow adaptation issues open fixed remaining gaps issue registry docs context-pack quality source ordering` and a first source block for `src/app/features/flow/services/flow-link-connection-editor.controller.ts`; after repair it returns `baseQuery=docs/codegraph-nanoflow-adaptation-issues.md codegraph nanoflow adaptation issues` and a registry source block containing `CG-NF-20260627-901`.
  - log_guard: No transport failure is required to reproduce; this is a query-selection/source-ordering quality issue. Fresh wrapper tests are authoritative when host context evidence is stale.
- freshness_checks:
  - mcp_result: success
  - adapter_fallback_result: success
  - wrapper_stale: unknown
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: query-ranking | source-ordering
- repair_target: query-selection | context-pack-wrapper | tests | docs
- doc_update_needed: no
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts -t "focuses issue registry status queries"; node scripts/codegraph-adapter-context.cjs --query "codegraph nanoflow adaptation issues open fixed remaining gaps issue registry docs context-pack quality source ordering" --json --timeout-ms 90000; npm run codegraph:mcp:log:guard -- --json`
- resolution_notes: `nanoflow_context_pack` now detects NanoFlow/CodeGraph adaptation issue-registry queries before generic explicit-path/tooling filters and rewrites both base CodeGraph and overlay lookup queries to `docs/codegraph-nanoflow-adaptation-issues.md codegraph nanoflow adaptation issues`, preventing status words such as `open` and `fixed` from selecting unrelated application methods.

## CG-NF-20260628-002: Open issue registry queries answer with fixed issues when no active issues exist

- status: fixed
- reported_at: 2026-06-28
- reporter: codex-agent
- feature_scope: context-pack issue registry open-section source evidence
- query_surface: nanoflow_context_pack | adapter-context-cli
- query: `codegraph nanoflow adaptation issues open remaining gaps issue registry docs`
- expected: When the registry has no real `status: open` entries, open/remaining-gap queries should render the `## Open Issues` section and the `No active issues are recorded yet.` line, without using fixed issues or the Entry Template placeholder as open evidence.
- actual: Before the fix, issue-registry source injection started at the latest fixed issue because no real open issue heading was found. The same source window could also include the Entry Template `- status: open` placeholder, making agents believe there were active adaptation issues.
- evidence:
  - docs_contract: `AGENTS.md` CodeGraph adaptation issue registry rule and this registry's `## Open Issues` state contract
  - output_summary: The RED fixture returned a fixed issue and the reusable entry-template placeholder for an open-only query; after repair, fresh adapter output has first source `docs/codegraph-nanoflow-adaptation-issues.md`, contains `## Open Issues` and `No active issues are recorded yet.`, and excludes template `- status: open`.
  - log_guard: No transport failure is required; current host MCP can remain stale against disk, so fresh adapter context is the authoritative behavior check.
- freshness_checks:
  - mcp_result: success
  - adapter_fallback_result: success
  - wrapper_stale: yes
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: query-ranking | source-ordering
- repair_target: context-pack-wrapper | tests | docs
- doc_update_needed: no
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts -t "issue registry|context-pack|tooling"; node scripts/codegraph-adapter-context.cjs --query "codegraph nanoflow adaptation issues open remaining gaps issue registry docs" --json --timeout-ms 90000; npm run codegraph:overlay:docs:validate`
- resolution_notes: Issue-registry source selection now uses an open-section fallback when an open-only query finds no real open issue entry, and registry source windows stop at the next second-level heading so fixed issues and Entry Template placeholders cannot leak into open issue evidence.

## CG-NF-20260628-003: Android Kotlin members stop at classes and methods

- status: fixed
- reported_at: 2026-06-28
- reporter: codex-agent
- feature_scope: Android Kotlin native-shaped symbol and relationship parity
- query_surface: nanoflow_overlay_query | overlay-query-cli | nanoflow_context_pack | adapter-context-cli
- query: `android-kotlin-property android-kotlin-constructor NanoflowWidgetRepository EXTRA_WIDGET_ID PARAM_PAYLOAD WidgetBridgeContext`
- expected: Android Kotlin support should expose class members at native quality, not just class and method declarations. Primary constructors should appear as native `method` nodes named `constructor`; constructor parameter `val` / `var` declarations, body properties, `object` constants, and `companion object` constants should appear as native `property` nodes. `contains` relationships should link the owner class/object to each constructor and property, and strict native JSON/code blocks should show explicitly requested Kotlin member evidence inside the normal native budget.
- actual: Before the fix, Android Kotlin overlay extraction emitted `class`, `method`, and method-call relations only. Queries for constructor/property semantics returned class/file context but no `android-kotlin-constructor` or `android-kotlin-property` endpoints, so agents still had to fall back to file reads for constructor injection parameters, data-class properties, object constants, and companion constants.
- evidence:
  - docs_contract: `docs/codegraph-nanoflow-adaptation.md` Android project semantics section
  - output_summary: The RED fixture query returned Kotlin class/file nodes only; after repair it returns `method` constructor nodes, `property` nodes for `store`, `json`, `token`, `EXTRA_WIDGET_ID`, and `PARAM_PAYLOAD`, `contains` edges with `android-kotlin-constructor` / `android-kotlin-property`, and strict native code blocks for the constructor plus requested constants.
  - log_guard: No transport failure is required to reproduce. The long-lived MCP host can remain stale against disk, so fresh overlay-query CLI and adapter-context CLI are authoritative until the host wrapper is restarted.
- freshness_checks:
  - mcp_result: success
  - adapter_fallback_result: success
  - wrapper_stale: yes
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: implementation-gap | query-ranking
- repair_target: generator | query-selection | native-json | native-markdown | context-pack-wrapper | docs | tests
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts -t "Android"; npm run codegraph:overlay:docs:validate; node scripts/query-codegraph-nanoflow-overlay.mjs --query "android-kotlin-property android-kotlin-constructor NanoflowWidgetRepository EXTRA_WIDGET_ID PARAM_PAYLOAD WidgetBridgeContext" --limit 60 --native-json --skip-refresh`
- resolution_notes: Android collection now extracts Kotlin primary constructors, constructor property parameters, class-body properties, object constants, and companion-object constants. Native graph generation emits constructor `method` nodes and member `property` nodes with owner `contains` edges, query selection recognizes the new relation terms, and code-block endpoint ordering prioritizes explicitly requested Kotlin property/constructor endpoints without changing existing `android-kotlin-method` caller-first behavior.

## CG-NF-20260628-004: Localized stale-wrapper test wording misses assertion evidence

- status: fixed
- reported_at: 2026-06-28
- reporter: codex-agent
- feature_scope: context-pack wrapper query focus, source ordering, and log-guard source-ordering diagnostics
- query_surface: nanoflow_context_pack | adapter-context-cli | log-guard
- query: `测试 stale wrapper 返回退出 host 重启 断言`
- expected: Localized test/assertion/lifecycle wording should route stale-wrapper context packs to the same focused lifecycle diagnostics query as English `stale wrapper assertions return exit host restart test`, render the stale-wrapper assertion test source before unrelated app source, and keep current source-ordering guard metrics clean.
- actual: Before the fix, Chinese `测试` / `断言` / `返回` / `退出` / `重启` terms were dropped by ASCII tokenization. The context pack narrowed only to `stale wrapper`, allowing business `return` / lifecycle files to consume source budget; after adding localized aliases, the wrapper returned the lifecycle diagnostics assertion source, but the log guard still treated localized test queries as broad queries until its test-intent detection was aligned.
- evidence:
  - docs_contract: `AGENTS.md:64`, `docs/codegraph-nanoflow-adaptation.md:1584`, and `docs/codegraph-nanoflow-adaptation.md:1597`
  - output_summary: RED fixture showed `baseQuery=stale wrapper` plus `shouldExitEditMode` / `insertConnectionReturningUpdatedAt` business source for the Chinese query. Fresh adapter verification now uses `stale wrapper shutdown lifecycle diagnostics spec assertions`, includes `wrapper.shutdown.stale-wrapper-script`, excludes `workspace-shell-keyboard-shortcuts.controller.ts`, and reports `lowValueSourcePollution=0`.
  - log_guard: Current wrapper matched disk and transport was healthy; the remaining failure was source-ordering guard interpretation of localized test wording, not stale wrapper or transport failure.
- freshness_checks:
  - mcp_result: success
  - adapter_fallback_result: success
  - wrapper_stale: no
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: query-ranking | source-ordering
- repair_target: query-selection | context-pack-wrapper | log-guard | tests | docs
- doc_update_needed: no
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts -t "keeps stale wrapper assertion wording"; npx vitest run --config vitest.config.mts src/tests/scripts/analyze-codegraph-mcp-log.spec.ts -t "localized test wording|low-value source blocks consume"; npm run codegraph:adapter:context -- --query "测试 stale wrapper 返回退出 host 重启 断言" --json --timeout-ms 90000`
- resolution_notes: Context-pack query tokenization now appends localized aliases for Chinese test/assertion/lifecycle terms, lifecycle assertion queries restrict source budget to CodeGraph/MCP tooling and diagnostics test files, and the log analyzer treats Chinese test wording as explicit test evidence when classifying low-value source pollution.

## CG-NF-20260628-005: Android Kotlin constructor/property overlay can remain stale without docs gate failure

- status: fixed
- reported_at: 2026-06-28
- reporter: codex-agent
- feature_scope: Android Kotlin member coverage, generated overlay freshness, docs validator baseline, and context-pack coverage output
- query_surface: nanoflow_context_pack | adapter-context-cli | overlay-query-cli | docs-validator
- query: `android-kotlin-property android-kotlin-constructor NanoflowWidgetRepository EXTRA_WIDGET_ID PARAM_PAYLOAD WidgetBridgeContext`
- expected: Once Android Kotlin constructors and properties are documented as supported, fresh adapter context, overlay query, and docs validation must all show nonzero `androidKotlinConstructors`, `androidKotlinProperties`, `android-kotlin-constructor`, and `android-kotlin-property` evidence. A stale `.codegraph/nanoflow-overlay.json` missing those arrays or graph relations must fail validation instead of reporting the adaptation healthy.
- actual: Before the fix, the generator source could emit 35 constructors and 841 properties, but the checked overlay file still lacked `android.kotlinConstructors`, `android.kotlinProperties`, and the corresponding graph edges. `nanoflow_context_pack` and `codegraph:adapter:context` therefore reported `androidKotlinConstructors=0` and `androidKotlinProperties=0`, while `codegraph:overlay:docs:validate` still passed because the baseline and docs validator did not include these new Android Kotlin member counters.
- evidence:
  - docs_contract: `docs/codegraph-nanoflow-adaptation.md:118` and `AGENTS.md:102`
  - output_summary: `node scripts/generate-codegraph-nanoflow-overlay.mjs --stdout` showed 35 constructors, 841 properties, 35 constructor graph edges, and 841 property graph edges while `.codegraph/nanoflow-overlay.json` still had zero/undefined for those fields. After refresh and validator hardening, docs validation reports 96,804 nodes and 183,797 edges with graph shape passed.
  - log_guard: Transport was healthy; doctor showed host context wrapper stale in the long-lived MCP session, but fresh adapter CLI also exposed the stale overlay file until `npm run codegraph:overlay` regenerated it.
- freshness_checks:
  - mcp_result: success
  - adapter_fallback_result: success
  - wrapper_stale: yes
  - overlay_stale: yes
  - transport_failure: no
- likely_root_cause: stale-overlay | docs-overpromise
- repair_target: generator | docs | tests
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/validate-codegraph-overlay-docs.spec.ts; npm run codegraph:overlay:validate; node scripts/query-codegraph-nanoflow-overlay.mjs --query "android-kotlin-property android-kotlin-constructor NanoflowWidgetRepository EXTRA_WIDGET_ID PARAM_PAYLOAD WidgetBridgeContext" --limit 60 --native-json --skip-refresh; npm run codegraph:adapter:context -- --query "android-kotlin-property android-kotlin-constructor NanoflowWidgetRepository EXTRA_WIDGET_ID PARAM_PAYLOAD WidgetBridgeContext" --max-files 2 --json --timeout-ms 90000`
- resolution_notes: The overlay was regenerated, baseline math now includes Android Kotlin constructor/property array counts and graph relation edge counts, the docs validator and sync script validate the Android Kotlin member graph summary, `android-kotlin-constructor` and `android-kotlin-property` are registered graph relations, and regression tests prove documented Android Kotlin member counts cannot drift silently again.

## CG-NF-20260706-003: Low-value relationships and related symbols can occupy context-pack output

- status: fixed
- reported_at: 2026-07-06
- reporter: codex-agent
- feature_scope: context-pack relationship and Related Symbols quality
- query_surface: nanoflow_context_pack | adapter-context-cli
- query: `route guard`; `icon`; `action button component`
- expected: Broad implementation queries should keep production source, route, guard, and component symbols visible while suppressing avoidable scripts, workers, Android drawable/layout resource snippets, spec helpers, story/demo/sample files, and other low-value relationship endpoints unless explicitly requested.
- actual: Before the fix, source blocks were cleaner but `### Relationships` could restore every low-value edge when scoped filtering returned empty, `### Related Symbols` still displayed script/spec/helper groups after clean production candidates, and generic `icon` queries could promote one-line Android drawable XML files plus resource-reference edges into the visible context.
- evidence:
  - docs_contract: `AGENTS.md` context-pack quality and source-ordering low-value rules
  - output_summary: RED fixtures showed `registerRouteGuardSpecs -> readRouteGuardReferences`, `scripts/generate-codegraph-nanoflow-overlay.mjs`, and `android/app/src/main/res/drawable/nano_widget_icon_archive.xml` in visible context for broad queries; after repair, low-value edges/source groups are omitted and clean related symbol groups fill the visible budget.
  - log_guard: No transport failure is required. This is context-pack ranking/filtering behavior, not stale wrapper or overlay failure.
- freshness_checks:
  - mcp_result: success
  - adapter_fallback_result: success
  - wrapper_stale: unknown
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: query-ranking | source-ordering
- repair_target: context-pack-wrapper | tests | docs
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts -t "demotes script, worker, and drawable|low-value relationships|route guard relationships|story demo"`
- resolution_notes: Relationship filtering no longer restores all low-value edges when no scoped edge survives, `guard` is no longer treated as a generic CodeGraph tooling intent token, Android resource files are low-value for broad non-resource queries, and Related Symbols now omits low-value groups when clean related symbols exist for non-explicit broad queries.

## CG-NF-20260706-004: Log triage misses index-frozen and malformed-log root causes

- status: fixed
- reported_at: 2026-07-06
- reporter: codex-agent
- feature_scope: MCP wrapper log guard and adapter doctor root-cause diagnostics
- query_surface: log-guard | adapter-doctor
- query: `npm run codegraph:mcp:log:guard`; `npm run codegraph:adapter:doctor -- --explain`
- expected: If upstream CodeGraph reports `auto-sync disabled`, `file lock`, or `index is frozen`, the log guard should classify it as index-frozen evidence. If the host wrapper log contains malformed JSON, doctor should fail `host-mcp:log-parse` and preserve the malformed line tail instead of silently discarding it.
- actual: Before the fix, `child.stderr` auto-sync warnings were visible only as raw log text and could be mistaken for adapter quality failures. Doctor dropped malformed JSON lines, so truncated `wrapper.start`, `wrapper.script.stale`, or `nanoflow.context.response` evidence could disappear from the health report.
- evidence:
  - docs_contract: `docs/codegraph-nanoflow-adaptation.md` MCP log guard and doctor diagnostics contract
  - output_summary: RED fixtures now require `codegraphAutoSyncDisabled`, `currentCodegraphAutoSyncDisabled`, `hostMcp.logMalformedLines`, `hostMcp.latestMalformedLogLine`, and `host-mcp:log-parse`.
  - log_guard: Transport may remain healthy; these diagnostics classify freshness/log-integrity root causes before ranking or transport changes.
- freshness_checks:
  - mcp_result: success
  - adapter_fallback_result: success
  - wrapper_stale: unknown
  - overlay_stale: unknown
  - transport_failure: no
- likely_root_cause: stale-overlay | stale-wrapper | unknown
- repair_target: log-guard | docs | tests
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/analyze-codegraph-mcp-log.spec.ts -t "stale context-pack evidence|auto-sync disabled"; npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-adapter-doctor.spec.ts -t "responds after a fresh host|malformed host MCP log|older than a fresh host"`
- resolution_notes: The log analyzer now records CodeGraph auto-sync/index-frozen stderr under dedicated summary buckets with `failureClass=codegraph-autosync-disabled`, and doctor reports malformed host MCP log lines through a failing `host-mcp:log-parse` check. Stale context freshness now compares fresh wrapper starts against the latest context response timestamp, so stale responses after a fresh start remain current stale evidence.

## CG-NF-20260706-005: Strict native output leaks synthetic coordinates and unknown fences

- status: fixed
- reported_at: 2026-07-06
- reporter: codex-agent
- feature_scope: strict native JSON and strict native Markdown output quality
- query_surface: nanoflow_overlay_query | overlay-query-cli
- query: `sync-required-field --native-json`; `template-url --native-markdown`; `style-url --native-markdown`
- expected: Strict native JSON should omit absent edge `line` / `column` coordinates instead of fabricating `0:0`, and strict native Markdown/JSON code blocks should use specific languages for recognizable HTML, CSS, SQL, Markdown, JSON, and related resource files.
- actual: Before the fix, metadata-only edges emitted `line: 0, column: 0`, making unknown locations look jumpable. HTML/CSS resource code blocks fell back to `unknown`, reducing rendering and machine-consumption quality.
- evidence:
  - docs_contract: strict native JSON/Markdown parity expectations in `docs/codegraph-nanoflow-adaptation.md`
  - output_summary: RED fixtures required absent edge coordinates to be omitted and Angular external resource code blocks to emit `html` / `css` languages.
  - log_guard: No transport or freshness failure is involved; this is formatter output quality.
- freshness_checks:
  - mcp_result: success
  - adapter_fallback_result: success
  - wrapper_stale: unknown
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: implementation-gap
- repair_target: native-json | native-markdown | tests | docs
- doc_update_needed: no
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts -t "strict native JSON edge coordinates|Angular external resource source blocks"`
- resolution_notes: `serializeNativeJsonEdge` now lets missing coordinates be omitted by the native JSON projection, and `languageForFile` plus the language allowlist now recognize HTML, CSS, SCSS, Sass, Less, SQL, Markdown, and JSON code blocks.

## CG-NF-20260706-006: Strict native Markdown omitted relationships and completion markers

- status: fixed
- reported_at: 2026-07-06
- reporter: codex-agent
- feature_scope: strict native Markdown output parity and machine-consumable completeness signals
- query_surface: nanoflow_overlay_query | overlay-query-cli
- query: `native-section-order-fixture --native-markdown`; `zzzz-native-empty-output-probe --native-markdown`; `NativeCodeBudget --native-markdown`
- expected: Strict native Markdown should preserve native-style `### Relationships` between entry points and related symbols, strip NanoFlow metadata/provenance from that section, emit explicit empty-state rows for zero-result sections, and mark visible related-symbol/code-block budget truncation.
- actual: Before the fix, strict native Markdown skipped `### Relationships`, rendered empty sections as blank headings, and silently capped related symbols/code blocks without a completion signal.
- evidence:
  - docs_contract: `docs/codegraph-nanoflow-adaptation.md` strict native output order and object projection contracts
  - output_summary: RED fixtures required `### Relationships`, `**references:**`, `NativeSectionAnchor -> NativeSectionRelated`, no `metadata`/`provenance`, `No ... found` rows, `+N more related symbols`, and a code block budget marker.
  - log_guard: No transport or freshness failure is involved; this is formatter output quality.
- freshness_checks:
  - mcp_result: success
  - adapter_fallback_result: success
  - wrapper_stale: unknown
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: implementation-gap
- repair_target: native-markdown | tests | docs
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts -t "strict native Markdown section order|empty-state rows|related-symbol truncation|code-block budget truncation|infers markdown language"`
- resolution_notes: `formatStrictNativeMarkdown` now renders `### Relationships` from closed native edges, omits NanoFlow extension fields, renders explicit empty-state rows, emits related-symbol/code-block budget markers, and lets `unknown` node languages fall through to file-extension code-fence inference.

## CG-NF-20260706-007: Base CodeGraph child restart logs exposed only raw exit codes

- status: fixed
- reported_at: 2026-07-06
- reporter: codex-agent
- feature_scope: MCP wrapper log guard and root-cause diagnostics for future transport errors
- query_surface: log-guard
- query: `npm run codegraph:mcp:log:guard`; wrapper `child.exit` / `child.restart.delayed`
- expected: Child exit and crash-loop diagnostics should include semantic exit-code fields so future `Transport closed` or child restart failures can be triaged without guessing what a Windows/native process code means.
- actual: Before the fix, wrapper logs and analyzer summaries exposed only raw `code`/`signal`; historical `3221225794` restart backoff evidence could not be distinguished quickly from a normal nonzero exit or signal termination.
- evidence:
  - docs_contract: MCP log guard root-cause diagnostics contract
  - output_summary: RED fixtures required `childExitCodeHex`, `childExitClass`, `childExitName`, `childUptimeMs`, `byExitClass`, and `byExitName` for crash-loop backoff.
  - log_guard: The analyzer can now classify existing raw-code history while fresh wrapper logs write the same fields directly.
- freshness_checks:
  - mcp_result: success
  - adapter_fallback_result: success
  - wrapper_stale: unknown
  - overlay_stale: unknown
  - transport_failure: no
- likely_root_cause: implementation-gap
- repair_target: log-guard | tests | docs
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/analyze-codegraph-mcp-log.spec.ts -t "summarizes base CodeGraph crash-loop backoff"; npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts -t "backs off rapid base CodeGraph restart loops"`
- resolution_notes: The wrapper now records child exit classification fields on `child.exit`, `child.exit.stale`, `child.restart.request`, and `child.restart.delayed`; the analyzer derives the same fields for older logs and aggregates crash-loop backoff by exit class/name.

## CG-NF-20260706-008: Wrapper fixture tests polluted the shared MCP host log

- status: fixed
- reported_at: 2026-07-06
- reporter: codex-agent
- feature_scope: adapter doctor/gate diagnostics and test isolation for MCP wrapper fixtures
- query_surface: adapter-doctor | log-guard
- query: `npm run codegraph:adapter:gate`; `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts -t "Content-Length"`
- expected: Wrapper fixture tests that use fake CodeGraph targets should write diagnostics to per-test temporary logs so the shared `.codegraph/nanoflow-mcp-wrapper.log` remains evidence for real Codex host sessions.
- actual: Before the fix, Content-Length wrapper tests inherited the default shared log path and wrote a `wrapper.start` entry with a temporary `fake-codegraph-framed.cjs` target. `codegraph:adapter:doctor` then reported `host-mcp:current-wrapper-target` against that fake target instead of the live Codex MCP target.
- evidence:
  - docs_contract: adapter doctor/gate diagnostics should distinguish host/session mismatch from test fixture evidence
  - output_summary: `codegraph:adapter:gate` failed in `codegraph:adapter:doctor:strict` with `current-wrapper-target` pointing at a temp fake CodeGraph script while live wrapper process command lines still used `@colbymchenry/codegraph@1.1.1`.
  - log_guard: Shared log had no critical transport failure; the failure was diagnostic evidence pollution from tests.
- freshness_checks:
  - mcp_result: success
  - adapter_fallback_result: success
  - wrapper_stale: yes
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: implementation-gap
- repair_target: tests | log-guard
- doc_update_needed: no
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts -t "Content-Length"`
- resolution_notes: The overlay spec harness now sets a per-test temporary `NANOFLOW_CODEGRAPH_MCP_LOG` and restores the caller environment after each test. Re-running the Content-Length fixture tests kept `.codegraph/nanoflow-mcp-wrapper.log` line count unchanged.

## CG-NF-20260706-009: Adapter doctor selected non-live fixture wrapper log entries

- status: fixed
- reported_at: 2026-07-06
- reporter: codex-agent
- feature_scope: adapter doctor host/session diagnostics and shared MCP log root-cause accuracy
- query_surface: adapter-doctor
- query: `npm run codegraph:adapter:doctor`; `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-adapter-doctor.spec.ts -t "uses live wrapper process ids"`
- expected: When live wrapper process evidence is available, doctor should select current wrapper/context evidence from shared log entries whose wrapper pid is still live; non-live fixture or old smoke `wrapper.start` entries should not override the real Codex host wrapper.
- actual: Before the fix, doctor selected the last `wrapper.start` in `.codegraph/nanoflow-mcp-wrapper.log` even when live process inspection showed that pid was no longer running and the only live wrapper process used the configured `@colbymchenry/codegraph@1.1.1` target.
- evidence:
  - docs_contract: adapter doctor/gate diagnostics should distinguish active host/session evidence from historical fixture log evidence
  - output_summary: RED fixture wrote a live wrapper start followed by a later fake `fake-codegraph-framed.cjs` wrapper start; live process JSON contained only the live wrapper pid, but doctor still reported the fake target as current before the fix.
  - log_guard: No transport failure was involved; this was current-wrapper evidence selection using stale shared-log ordering.
- freshness_checks:
  - mcp_result: success
  - adapter_fallback_result: success
  - wrapper_stale: yes
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: implementation-gap
- repair_target: log-guard | tests | docs
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-adapter-doctor.spec.ts -t "uses live wrapper process ids"; npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-adapter-doctor.spec.ts`
- resolution_notes: Doctor now inspects live wrapper pids before selecting current shared-log wrapper evidence, filters `wrapper.start` and `nanoflow.context.response` records to live pids when available, and exposes `hostMcp.liveWrapperLogFilter` with applied pid and ignored-entry counts. Historical log order remains the fallback when live process evidence is unavailable.

## CG-NF-20260706-010: Fixture, mock, stub, and browser-test paths can still fill context-pack output

- status: fixed
- reported_at: 2026-07-06
- reporter: codex-agent
- feature_scope: context-pack source ordering, Related Symbols, Relationships, and log guard low-value diagnostics
- query_surface: nanoflow_context_pack | adapter-context-cli | log-guard
- query: `session service`
- expected: Broad implementation queries should keep the implementation source visible and suppress avoidable e2e/cypress/playwright helpers, fixture data, mocks, stubs, and snapshots from `### Source Code`, `### Relationships`, and `### Related Symbols` unless the query explicitly asks for tests, fixtures, mocks, stubs, browser tests, or a concrete low-value path. Context response/error logs should include enough query-planning data to debug base/overlay query focus and max-file budgets from one event.
- actual: Before the fix, `src/fixtures/session-data.ts`, `src/__mocks__/session.service.ts`, `src/stubs/session-store.ts`, and browser-test paths could still appear in visible context for a broad `session service` implementation query. The log analyzer also treated `src/__mocks__/session.service.ts` as explicitly requested because broad filename-token coverage matched `session`, and `nanoflow.context.response` did not include a single structured query plan.
- evidence:
  - docs_contract: `AGENTS.md` source-ordering low-value fallback rule and `docs/codegraph-nanoflow-adaptation.md` context-pack query-aware low-value contract
  - output_summary: RED context-pack fixture rendered fixture/mock/stub source headers and low-value relationship/related-symbol endpoints for a broad implementation query; after repair only `src/app/core/services/session.service.ts` remains visible, low-value relationships are omitted, and `nanoflow.context.response.queryPlan` records raw/base/overlay query and max-file budgets.
  - log_guard: RED analyzer fixture returned `status=0` when fixture/mock/browser-test files consumed visible source slots; after repair `--fail-on-current-source-ordering` reports `lowValueVisibleSourceBlocks=3`, `lowValueSourcePollution=1`, and `issue=low-value-source-block-visible`.
- freshness_checks:
  - mcp_result: success
  - adapter_fallback_result: success
  - wrapper_stale: unknown
  - overlay_stale: no
  - transport_failure: no
- likely_root_cause: query-ranking | source-ordering
- repair_target: context-pack-wrapper | log-guard | tests | docs
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts -t "filters e2e fixture mock and stub paths"; npx vitest run --config vitest.config.mts src/tests/scripts/analyze-codegraph-mcp-log.spec.ts -t "classifies fixture mock and browser-test source blocks"; npx vitest run --config vitest.config.mts src/tests/scripts/codegraph-nanoflow-overlay.spec.ts -t "context-pack queries"; npx vitest run --config vitest.config.mts src/tests/scripts/analyze-codegraph-mcp-log.spec.ts -t "source"`
- resolution_notes: The wrapper now classifies e2e/cypress/playwright roots, fixture/mock/stub/snapshot directories, `*.cy.*`, `*.e2e.*`, and fixture/mock/stub/snapshot file suffixes as low-value for broad context packs, while preserving them when the query explicitly asks for test-like evidence or a concrete path. The analyzer mirrors the path fallback and tightens tokenized path coverage so a broad `session service` query does not exempt `__mocks__/session.service.ts`. Context response/error/timeout/forward-failure logs now include `queryPlan` for single-event root-cause triage.

## CG-NF-20260707-001: Explicit wrapper log-triage queries can rank legacy wrapper and logger noise first

- status: fixed
- reported_at: 2026-07-07
- reporter: codex-agent
- feature_scope: context-pack source ranking, adapter fallback log guard, and MCP error triage quality
- query_surface: nanoflow_context_pack | adapter-context-cli | log-guard
- query: `codegraph-nanoflow-mcp-stdio MCP wrapper logging doctor log guard config target mismatch Transport closed`
- expected: Context packs for explicit CodeGraph/NanoFlow MCP wrapper log-triage queries should keep `scripts/codegraph-nanoflow-mcp-stdio.cjs` as the top-ranked and first visible source block, while demoting legacy wrapper files and app logging/bootstrap/telemetry sources unless explicitly requested.
- actual: Before the fix, source ranking focused away the full `codegraph-nanoflow-mcp-stdio` file-stem token and let `scripts/codegraph-mcp-stdio.cjs`, `src/services/logger.service.ts`, `main.ts`, telemetry, and other broad log matches compete for the visible source budget. A fresh adapter fallback succeeded internally but then failed its `--fail-on-current-source-ordering` log guard with `top-ranked-overlay-not-first`.
- evidence:
  - docs_contract: `AGENTS.md` source-ordering low-value fallback rule and `docs/codegraph-nanoflow-adaptation.md` sourceOrdering diagnostics contract
  - output_summary: RED adapter context showed `topRankedOverlayFile=scripts/codegraph-mcp-stdio.cjs`, `topRankedOverlayFileVisibleIndex=1`, and raw base headings led by logger/main/telemetry source blocks. After repair, the same adapter query returns `ok=true` and first context source is `scripts/codegraph-nanoflow-mcp-stdio.cjs`.
  - log_guard: Fresh temporary adapter log changed from `latestIssue=top-ranked-overlay-not-first` to `latestIssue=null`; shared Codex host log still reports historical stale direct MCP entries until the host/session reconnects.
- freshness_checks:
  - mcp_result: failed
  - adapter_fallback_result: success
  - wrapper_stale: yes
  - overlay_stale: no
  - transport_failure: yes
- likely_root_cause: query-ranking | source-ordering | transport
- repair_target: context-pack-wrapper | tests | docs
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts --no-file-parallelism --maxWorkers 1 src/tests/scripts/codegraph-nanoflow-overlay.spec.ts -t "explicitly named NanoFlow wrapper"; npm run codegraph:adapter:context -- --query "codegraph-nanoflow-mcp-stdio MCP wrapper logging doctor log guard config target mismatch Transport closed" --json`
- resolution_notes: The wrapper now treats CodeGraph tooling log/guard/mismatch/transport/closed/root-cause queries as source-pollution-prone diagnostics. That preserves full explicit file-stem tokens for source ranking and applies existing logger/main/telemetry pollution penalties, so adapter fallback remains usable when direct MCP transport is closed.

## CG-NF-20260707-002: Direct MCP Transport closed without current wrapper evidence can be misread as adapter failure

- status: fixed
- reported_at: 2026-07-07
- reporter: codex-agent
- feature_scope: adapter-doctor root-cause logging, Codex host transport triage, and stale wrapper misdiagnosis prevention
- query_surface: adapter-doctor | log-guard | tool-discovery
- query: `npm run codegraph:adapter:doctor -- --explain --direct-mcp-error "Transport closed" --observed-at "2026-07-07T10:00:00.000Z"`
- expected: When direct MCP returns `Transport closed` and no live/current wrapper evidence exists, doctor output should identify the failure boundary as `codex-mcp-host-transport`, include live wrapper process count, latest wrapper-log event, live-process log-filter counts, latest-log age, observed-at freshness, current-evidence-window filter counts, and the adapter fallback command. Historical wrapper entries must not be treated as current adapter evidence.
- actual: Before this fix, doctor could correctly classify the host transport boundary, but the human-readable output did not show the latest log event or the count of historical wrapper entries ignored by the live-process filter. That made it too easy to infer that a stale historical wrapper or the adapter itself was the current root cause.
- evidence:
  - docs_contract: `AGENTS.md` MCP failure override requires adapter-first fallback and forbids diagnosing Codex CodeGraph behavior through `.vscode/mcp.json`.
  - output_summary: RED doctor spec lacked `logEvidence latestTs=... latestEvent=... ignoredWrapperStarts=... noCurrentWrapperEvidence=true`; after repair, explain output includes those fields and JSON exposes `hostMcp.rootCauseSummary.observed.logEvidence`.
  - log_guard: Current direct MCP still returns `Transport closed`, while fresh adapter fallback and wrapper smoke can pass; this distinguishes host transport/tool-registry state from wrapper implementation failure.
- freshness_checks:
  - mcp_result: failed
  - adapter_fallback_result: success
  - wrapper_stale: unknown
  - overlay_stale: no
  - transport_failure: yes
- likely_root_cause: transport | tool-discovery | stale-wrapper
- repair_target: log-guard | tests | docs
- doc_update_needed: yes
- verification_gate: `npx vitest run --config vitest.config.mts --no-file-parallelism --maxWorkers 1 src/tests/scripts/codegraph-adapter-doctor.spec.ts -t "classifies observed direct MCP Transport closed even when no new wrapper log was written"; npm run codegraph:adapter:doctor -- --explain --direct-mcp-error "Transport closed"`
- resolution_notes: Doctor now records `hostMcp.logEvidence` and projects it into root-cause JSON and human-readable explain output. The key fields are `observedAt`, `latestTs`, `latestEvent`, `latestRunId`, `latestLogAgeMs`, `activeWindowMs`, `staleAgainstObservedAt`, `hasCurrentWrapperEvidence`, `liveWrapperLogFilter.ignoredWrapperStarts`, `liveWrapperLogFilter.ignoredContextResponses`, `currentEvidenceWindow.ignoredWrapperStarts`, `currentEvidenceWindow.ignoredContextResponses`, and `noCurrentWrapperEvidence`.

## Entry Template

Copy this template for each new issue. Keep the field names stable so agents can
parse the file.

```markdown
## CG-NF-YYYYMMDD-001: Short query failure title

- status: open
- reported_at: YYYY-MM-DD
- reporter: codex-agent
- feature_scope: documented
- query_surface: nanoflow_context_pack | nanoflow_overlay_query | adapter-context-cli | adapter-doctor | overlay-query-cli | tool-discovery
- query: `<exact query or command>`
- expected: <specific node, edge, metadata relation, source block, or strict native field>
- actual: <short observed output or missing result>
- evidence:
  - docs_contract: `AGENTS.md:<line>` or `docs/codegraph-nanoflow-adaptation.md:<line>`
  - output_summary: <short summary; do not paste huge output>
  - log_guard: <summary of npm run codegraph:mcp:log:guard>
- freshness_checks:
  - mcp_result: success | failed | not-available
  - adapter_fallback_result: success | failed | not-run
  - wrapper_stale: yes | no | unknown
  - overlay_stale: yes | no | unknown
  - transport_failure: yes | no | unknown
- likely_root_cause: implementation-gap | query-ranking | source-ordering | stale-wrapper | stale-overlay | transport | tool-discovery | docs-overpromise | unknown
- repair_target: generator | query-selection | native-json | native-markdown | context-pack-wrapper | log-guard | docs | tests
- doc_update_needed: yes | no | unknown
- verification_gate: `<exact command that must pass after repair>`
- resolution_notes: <filled when status changes>
```

## Repair Workflow

For `implementation-gap`, `query-ranking`, `source-ordering`, or formatter
issues, add or update the smallest focused fixture/spec before changing the
implementation. Prefer the existing
`src/tests/scripts/codegraph-nanoflow-overlay*.spec.ts` and helper fixtures.

For `docs-overpromise`, update `docs/codegraph-nanoflow-adaptation.md` and
`AGENTS.md` together when the behavior affects agent routing or hard rules.

Every resolved issue must record the verification command that proved the fix.
Use `npm run codegraph:overlay:validate` for semantic/doc-count changes and
`npm run codegraph:adapter:quick-gate` or `npm run codegraph:adapter:gate` when
the repair touches wrapper behavior, query formatting, strict native output, or
diagnostic logging.
