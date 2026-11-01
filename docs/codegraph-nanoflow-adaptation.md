# CodeGraph NanoFlow Adaptation

This repository keeps CodeGraph as a toolchain dependency, not as application source.
The target layout is:

```text
D:\Code\
  dde\                 # NanoFlow application repository
  tools\
    codegraph\         # local CodeGraph fork/source checkout
```

Do not place CodeGraph source under `D:\Code\dde`. Keeping it beside the app avoids
polluting NanoFlow git history, npm dependencies, and CodeGraph's own project index.

## Adaptation Issue Registry

If an agent queries `nanoflow_context_pack`, `nanoflow_overlay_query`, or the
adapter-first CLI fallback and a documented NanoFlow semantic is missing from the
result, record a reproducible entry in
`docs/codegraph-nanoflow-adaptation-issues.md`. This applies to missing or
mis-ranked nodes, edges, relationship groups, entry points, source blocks,
strict native JSON fields, and strict native Markdown sections that this document
or `AGENTS.md` explicitly promises.

Before recording an issue, rule out stale wrapper, stale overlay, transport
failure, timeout, and source-ordering evidence with the current MCP response,
adapter-first fallback, and `npm run codegraph:mcp:log:guard`. The registry is
for documented adapter quality gaps and documentation-contract corrections, not
for exploratory search misses or features outside the stated support surface.

## Diagnostic Triage Contract

`scripts/analyze-codegraph-mcp-log.cjs` emits `diagnosticTriage` before the
longer historical counters so future agents can avoid treating host/session
drift as an adapter regression. In addition to `adapterFailureLikely`,
`failureBoundary`, `directMcpTrust`, and `misdiagnosisGuards`, the analyzer
must expose:

- `diagnosticTriage.evidenceGaps`: missing evidence that blocks a root-cause
  conclusion, such as `current-wrapper-log-evidence`,
  `fresh-adapter-fallback-result`, `adapter-doctor-config-snapshot`,
  `current-wrapper-transport-failure-evidence`,
  `current-configured-wrapper-evidence`, or `fresh-codegraph-index-evidence`.
- `diagnosticTriage.requiredEvidenceBeforeConclusion`: machine-readable
  requirements for conclusions such as `adapter-source-regression`,
  `wrapper-transport-crash`, `nanoflow-ranking-regression`, and
  `direct-mcp-healthy`.

When direct MCP reports `Transport closed`, an agent should pass the observed
error into the analyzer:

```powershell
node scripts/analyze-codegraph-mcp-log.cjs .codegraph\nanoflow-mcp-wrapper.log --text --observed-at now --direct-mcp-error "Transport closed"
```

If the triage fields require a fresh adapter fallback or doctor snapshot, do
not change adapter source or timeout values until those commands reproduce the
failure or confirm the config boundary.

## Current Adaptation Layer

NanoFlow uses a sidecar overlay to add project-specific semantics that the generic
CodeGraph AST index does not fully model:

- Angular standalone component metadata.
- Angular standalone `imports`, `providers`, `hostDirectives`, and `host`
  metadata object entries.
- Angular external template/style resource file edges using native `imports`
  edges with `metadata.relation = "template-url"` / `"style-url"` and
  `metadata.angularProperty` preserving the original `templateUrl`, `styleUrl`,
  or `styleUrls` decorator property.
- Angular `inject()` dependency edges.
- Angular constructor dependency edges.
- Exact `standalone-import`, component/directive `provider`, and `dependency`
  queries keep the owning decorator or injection declaration line as the first
  native source evidence. Dependency edges preserve `injectionKind=inject` or
  `injectionKind=constructor` plus source line/column, and injection collection
  is scoped per declaring class rather than shared across every class in one
  TypeScript file.
- Angular application bootstrap provider edges from
  `bootstrapApplication(..., { providers })` and `ApplicationConfig.providers`.
  Object providers, direct provider tokens, spread providers, and provider
  factory calls are emitted as native `references` edges from the application
  config file node to the provider endpoint with `metadata.relation =
  "angular-app-provider"`. Metadata keeps `providerKind`, `useClass`,
  `useExisting`, `useFactory`, `deps`, factory-call `arguments`, and the
  bootstrap/config source line so strict native code blocks point at the real
  composition-root provider block rather than a low-value Angular import.
- Angular `input()`, `output()`, `model()`, `@Input`, and `@Output` edges.
- Angular `viewChild()`, `viewChildren()`, `contentChild()`,
  `contentChildren()`, `signal()`, `computed()`, and `effect()` edges. Querying
  these API names selects the owning Angular class and the native-shaped
  semantic `query`/`signal` edges before lower-value `@angular/core` import
  matches.
- Angular host binding/listener edges from decorators and `host` metadata, plus
  static host attribute edges.
- Angular template binding references, including property/event/interpolation/model
  bindings, block syntax (`@if`, `@switch`, `@case`, `@for`, `@let`) and
  structural directive microsyntax such as `*ngFor` / `*ngIf`, while filtering template-local names
  from `as` aliases, `let` aliases, pipe names, and `$index` / `$count` /
  `$first` / `$last` / `$even` / `$odd` contextual variables. Structural
  microsyntax such as `*ngIf="expr as alias"` keeps the alias local and only
  records the expression before `as`. `@defer` parsing records
  business expressions from `when` and `prefetch when` clauses without treating
  `on` / `prefetch on` trigger words such as `viewport`, `idle`, or `timer` as
  component references.
- Angular template declaration usage edges. Static element selectors, directive
  selector lists, element/class/attribute/attribute-value directive selectors,
  `:not(...)` exclusions, and pipe operator names are emitted as native
  `references` edges from the containing component class to the matched Angular
  declaration class with `metadata.relation = "template-component"`,
  `"template-directive"`, or `"template-pipe"`. The edge carries the concrete
  template usage line/column and keeps `templateFile` plus `matchedNeedle`
  provenance in metadata. Unmatched selectors and dynamic names do not
  materialize unresolved placeholder nodes.
- Angular route `component`, `loadComponent`, and `loadChildren` edges; lazy
  routes resolve `.then(m => m.exportName)` to the real exported symbol when it
  is present, with a file node fallback for unresolved route modules. The
  fallback remains a closed native endpoint in default JSON and strict
  `nativeJson`, so unresolved lazy exports do not become placeholder variable
  nodes or disappear from the route edge.
- Angular route guard/resolver edges from `canActivate`, `canActivateChild`,
  `canDeactivate`, `canMatch`, `canLoad`, and `resolve` route configuration
  properties. Guard/resolver references are emitted as native `references` edges
  from the route node to the guard/resolver symbol with `metadata.relation =
  "angular-route-guard"` or `"angular-route-resolver"`. Resolver extraction is
  limited to objects with route shape, so ordinary object properties named
  `resolve` do not become route semantics.
- Angular route redirect edges from `redirectTo` route configuration properties.
  Redirects are emitted as native `references` edges between route nodes with
  `metadata.relation = "angular-route-redirect"`. Empty-path routes use `(root)`
  as the stable graph node name while metadata keeps the real `path: ""`,
  `redirectTo`, and `pathMatch` values.
- Angular route provider edges from route-level `providers` arrays. Providers are
  emitted as native `references` edges from the route node to the provider symbol
  with `metadata.relation = "angular-route-provider"`, preserving the route path
  and provider name for focused relation queries.
- Dynamic `import()` lazy-load edges.
- Same-directory/same-basename and class-reference Angular test mappings. The
  compatibility `tests` arrays stay as file paths, while `testMappings` records
  the provenance (`same-basename` or `class-reference`) and graph edges expose it
  as `metadata.testMapping`.
- Android Manifest component declarations for activities, services, receivers,
  and providers. Manifest entries are emitted as native `references` edges from
  the `AndroidManifest.xml` file node to the resolved Kotlin class with
  `metadata.relation = "android-manifest-component"`, preserving component type,
  exported state, intent actions, raw manifest name, and source line.
- Android Manifest permissions, package/provider/intent queries, component-level
  permissions, and intent-filter action/category/data values are emitted as
  closed native `references` edges. Their NanoFlow meanings are carried by
  `android-manifest-uses-permission`, `android-manifest-query`,
  `android-manifest-component-permission`, and the
  `android-manifest-intent-filter-*` relation family; metadata preserves the
  permission declaration type, query type/value, component owner, and concrete
  intent value fields. The validator fails closed when those relations are
  unregistered or required metadata is absent.
- Android Kotlin host classes under `android/` are emitted as native `class`
  nodes with `language = "kotlin"`, package-qualified names, source ranges, and
  file containment edges, so Manifest class references resolve to the real
  receiver/service/activity implementation when it exists. Kotlin top-level
  `interface` declarations are emitted as native `interface` nodes with
  `metadata.relation = "android-kotlin-interface"`, preserving source ranges
  and strict native JSON/Markdown projection. Kotlin classes that implement
  same-file, imported, or external Android/Kotlin interfaces use native
  `implements` edges with `metadata.relation = "android-kotlin-implements"`;
  Kotlin classes or interfaces that extend same-file, imported, or external
  declarations use native `extends` edges with
  `metadata.relation = "android-kotlin-extends"`. Imported/external heritage
  endpoints are kept as native-shaped Kotlin `variable` nodes in the declaring
  file, and relation-only source blocks suppress those synthetic endpoints when
  the real owner class source is available. Kotlin `data` and `sealed`
  modifiers stay in metadata and signatures, with `sealed` classes marked
  `isAbstract = true` so the native node shape preserves modifier semantics.
  Kotlin top-level
  `object` declarations stay native-compatible as `class` nodes with
  `signature = "object <Name>"`, `isStatic = true`, and
  `metadata.relation = "android-kotlin-object"` on the object containment edge.
  Kotlin `companion object` declarations are emitted as nested class-shaped
  owners with `qualifiedName = "Owner::Companion"` (or the named companion),
  `signature = "companion object..."`, and a native `contains` edge from the
  owner class using `metadata.relation = "android-kotlin-companion-object"`.
- Android Kotlin import declarations are emitted as native `import` nodes with
  `language = "kotlin"`, package-qualified targets, alias and wildcard metadata,
  and native `imports` edges with
  `metadata.relation = "android-kotlin-import"`. Strict native JSON/Markdown
  keeps the import evidence through closed `imports` edges and Kotlin source
  blocks while stripping NanoFlow metadata, matching CodeGraph's TypeScript
  import projection shape.
- Android Kotlin primary constructors are emitted as native `method` nodes named
  `constructor` with `metadata.relation = "android-kotlin-constructor"`, matching
  native TypeScript constructor representation instead of inventing a separate
  node kind. Constructor parameter `val` / `var` declarations, class-body
  properties, `object` constants, and `companion object` constants are emitted
  as native `property` nodes with `metadata.relation = "android-kotlin-property"`.
  Companion methods and properties are owned by that companion node and keep
  `isStatic = true`. Kotlin `enum class` declarations are emitted as native `enum` nodes, enum
  entries are emitted as native `enum_member` nodes, and `contains` edges use
  `metadata.relation = "android-kotlin-enum-member"` so strict native JSON and
  Markdown match CodeGraph's TypeScript enum shape. `contains` edges link each
  class/object/enum to its constructor and properties, and strict native code
  blocks prioritize explicitly requested Kotlin member names within the normal
  native code-block budget.
- Android Kotlin top-level `fun` declarations are emitted as native `function`
  nodes with package-qualified `qualifiedName`, source ranges, signature,
  visibility, `isAsync`, and `returnType` fields. File-to-function containment
  uses a native `contains` edge with
  `metadata.relation = "android-kotlin-function"`. Function parameter and
  return types reuse the same `android-kotlin-type-reference` `type_of` edges as
  class methods, and class methods can resolve unqualified calls to top-level
  functions as native `calls` edges with
  `metadata.relation = "android-kotlin-call"`. Strict native JSON/Markdown keep
  these edges closed while code blocks prefer the real function source over
  synthetic type endpoints.
- Android Kotlin `override` methods/properties are projected as native
  `overrides` edges with `metadata.relation = "android-kotlin-override"`.
  Same-file Kotlin base members resolve to real `method` / `property`
  endpoints; imported or external Android/Kotlin base members are scoped
  native-shaped `variable` endpoints such as
  `android.appwidget.AppWidgetProvider::onUpdate`. Kotlin property types,
  method parameter types, and method return types are projected through native
  `type_of` edges with
  `metadata.relation = "android-kotlin-type-reference"`. Type targets resolve
  through same-file declarations and imports before materializing external
  endpoints, while Kotlin standard-library scalar/container types are filtered
  to avoid low-value graph noise. Relation-only JSON/Markdown source evidence is
  source-first and suppresses synthetic type/override endpoints when the real
  Kotlin owner source is available.
- Android Kotlin annotations on classes, enum declarations, constructor
  properties, body properties, and methods are projected through the native
  decorator shape: default JSON nodes expose `decorators`, graph relationships
  use native `decorates` edges with
  `metadata.relation = "android-kotlin-annotation"`, and strict native
  JSON/Markdown keep the relation evidence through closed edges and focused
  source blocks while stripping NanoFlow metadata.
- Android Kotlin member graph summary: 175 androidKotlinClasses, 71 androidKotlinDataClasses, 7 androidKotlinSealedClasses, 7 androidKotlinInterfaces, 0 androidKotlinInterfaceEdges, 9 androidKotlinExtendsEdges, 20 androidKotlinImplementsEdges, 20 androidKotlinObjects, 20 androidKotlinObjectEdges, 8 androidKotlinCompanionObjects, 8 androidKotlinCompanionObjectEdges, 19 androidKotlinEnums, 79 androidKotlinEnumMembers, 79 androidKotlinEnumMemberEdges, 495 androidKotlinImports, 495 androidKotlinImportEdges, 86 androidKotlinConstructors, 86 androidKotlinConstructorEdges, 1758 androidKotlinProperties, 1758 androidKotlinPropertyEdges, 622 androidKotlinMethods, 622 androidKotlinMethodEdges, 32 androidKotlinFunctions, 32 androidKotlinFunctionEdges, 74 androidKotlinOverrideEdges, 720 androidKotlinTypeReferenceEdges, 1171 androidKotlinCalls, 1171 androidKotlinCallEdges, 36 androidKotlinAnnotations, and 36 androidKotlinAnnotationEdges.
- Android packaging/resource graph summary: 7 androidManifestComponents, 3 androidManifestPermissions, 3 androidManifestUsesPermissionEdges, 3 androidManifestQueries, 3 androidManifestQueryEdges, 1 androidManifestComponentPermissions, 1 androidManifestComponentPermissionEdges, 6 androidManifestIntentFilters, 6 androidManifestIntentFilterActions, 6 androidManifestIntentFilterActionEdges, 3 androidManifestIntentFilterCategories, 3 androidManifestIntentFilterCategoryEdges, 1 androidManifestIntentFilterData, 1 androidManifestIntentFilterDataEdges, 1 androidWidgetProviders, 46 androidResourceReferences, 276 androidKotlinResourceReferences, and 276 androidKotlinResourceReferenceEdges.
- Android App Widget provider metadata is emitted as native `references` edges
  from the resolved receiver class to the `res/xml/*.xml` provider file with
  `metadata.relation = "android-widget-provider"`. Querying this relation is
  source-first: strict native entry points and code blocks prefer the Kotlin
  receiver and then the provider XML, rather than filling the budget with web
  bootstrap TypeScript helpers.
- Android XML resource references such as `@layout/nanoflow_widget_compact` are
  emitted as native `imports` edges with `metadata.relation =
  "android-resource-reference"` so provider XML can lead to the concrete layout
  or resource file.
- Kotlin `R.string`, `R.layout`, `R.drawable`, and `R.id` references are emitted
  as native `references` edges with `metadata.relation =
  "android-kotlin-resource-reference"`. Edges resolve only to indexed project
  resources, preserve `resourceType` and `resourceName`, and exclude
  `android.R`, comments, strings, and unresolved resources. Relation-only source
  evidence remains source-first and uses the real Kotlin owner before the
  resource endpoint.
- Supabase Edge Function entry points.
- Supabase Edge Function environment variable references, including relative
  imports into `supabase/functions/_shared` helper modules.
- Supabase Edge Function source/helper import references discovered by following
  relative imports under `supabase/functions`, emitted as native `imports` edges
  with `metadata.relation = "edge-function-source"`.
- Supabase Edge Function deployment route and HTTP method references, emitted as
  native `route` / `variable` nodes plus `edge-function-route` and
  `edge-function-method` relationship metadata.
- Supabase Edge Function request-header references from static
  `req.headers.get('<header>')` calls, emitted as native `variable` nodes and
  native `references` edges with `metadata.relation = "edge-function-header"`.
  Metadata keeps the original `header`, lower-cased `normalizedHeader`, and
  `sourceFile`, so auth, CORS, content-length, webhook-signature, and proxy-IP
  requirements can be queried without scanning source manually.
  When multiple Edge Function entries reuse the same `_shared` helper,
  `edge-function-method` and `edge-function-header` targets stay scoped by
  `functionName + method/header + line`, so each entry's `references` edge keeps
  its own native-shaped endpoint instead of resolving to the first same-file,
  same-name helper node.
- Supabase Edge Function implementation-side invokes from static
  `client.functions.invoke('name', ...)` / `supabase.functions.invoke('name', ...)`
  calls, emitted as native `references` edges from the containing callable to the
  existing `/functions/v1/<name>` route node with
  `metadata.relation = "edge-function-invoke"`.
- Supabase RPC and table write calls. Static `rpc('function_name', args)` calls
  are emitted as native-shaped `variable` nodes plus native `references` edges
  with `metadata.relation = "supabase-rpc"`. Static
  `.from('table').insert(...)`, `.update(...)`, `.upsert(...)`, and `.delete()`
  chains are emitted as `table.operation` native-shaped `variable` nodes plus
  native `references` edges with
  `metadata.relation = "supabase-table-write"`.
- Supabase Realtime implementation-side channel and `postgres_changes`
  subscriptions from `.channel('<name>')` / `.channel(channelName)` and
  `.on('postgres_changes', { event, schema, table, filter })` calls, emitted as
  native-shaped `variable` nodes plus native `references` edges with
  `metadata.relation = "supabase-realtime-channel"` or
  `metadata.relation = "supabase-realtime-postgres-change"`.
  Channel and Postgres-change endpoint nodes are scoped by callable owner and
  call line, so two subscriptions in the same file that reuse the same
  channel/table/event still keep separate native endpoints and source windows.
- Supabase Realtime subscribe status literals from real runtime source,
  including `SUBSCRIBED`, `CHANNEL_ERROR`, `TIMED_OUT`, and `CLOSED`, emitted as
  owner-scoped native-shaped `variable` nodes plus native `references` edges with
  `metadata.relation = "supabase-realtime-status"`. Metadata keeps `status`,
  `action` (`subscribed` for `SUBSCRIBED`, `fallback` for error/timeout/closed
  states), and `owner`; overlay implementation files, spec helpers, and test
  setup mocks are filtered so status assertions do not become project semantics.
- Supabase Realtime lifecycle cleanup calls from `channel.unsubscribe()`,
  `client.removeChannel(channel)`, and `client.removeAllChannels()`, emitted as
  owner-scoped native-shaped `variable` nodes plus native `references` edges
  with `metadata.relation = "supabase-realtime-unsubscribe"`,
  `"supabase-realtime-remove-channel"`, or
  `"supabase-realtime-remove-all-channels"`. Dynamic channel variables remain
  lifecycle evidence; when a concrete channel name cannot be reconstructed,
  metadata preserves `channelVariable` instead of dropping the cleanup edge.
- Supabase Edge Function test mappings from entry paths or function directory
  paths, deployed `functions/v1/<name>` routes, or
  `supabase.functions.invoke('<name>')` calls referenced by spec/test files,
  emitted as native `references` edges with `metadata.relation = "test"`,
  `metadata.testMapping`, plus `metadata.matchedNeedle` when the mapping came
  from a concrete route/path/invoke string. Entry path / function directory
  matches are `path-reference`, deployed route matches are `route-reference`,
  and invoke-call matches are `invoke-reference`. Invoke matches keep the
  concrete `functions.invoke('<name>'` / `functions.invoke("<name>"` call
  fragment as `matchedNeedle`, not the bare function name, so strict native code
  blocks point at the call evidence instead of an earlier `describe` or
  variable line. Bare function-name matching stays disabled to avoid noisy terms
  such as `transcribe` or `virus-scan`.
- Supabase migration risk tags for client IDs, RLS, LWW sync, and secrets.
- Supabase migration table, policy, and policy-detail anchors sourced from
  migration file nodes, including `CREATE POLICY` command, role, `USING`, and
  `WITH CHECK` details plus policy type/defaults (`AS PERMISSIVE` by default,
  `FOR ALL` by default, and `TO PUBLIC` by default), policy anchor signatures,
  and real `CREATE POLICY` line numbers with SQL noise filters for dynamic SQL
  strings, privilege statements, and non-table `ON ...` clauses.
- Supabase migration privilege grant/revoke anchors sourced from migration file
  nodes, including privilege action, privilege list, object type, object names,
  target roles, grant-option semantics, revoke behavior, and statement line numbers. Privilege object and role facts are
  emitted as separate native `references` relationships so `GRANT` / `REVOKE`
  statements stay queryable without becoming noisy migration table anchors.
  SQL comma splitting is top-level only, so function privilege signatures such
  as `public.fn(arg_a uuid, arg_b jsonb)` remain one object name instead of
  becoming two pseudo-objects.
- Supabase migration index anchors sourced from statement-level
  `CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS]` statements, emitted as
  native-shaped `variable` nodes plus native `references` edges with
  `metadata.relation = "migration-index"`. Metadata keeps index name, table,
  indexed columns, method, uniqueness/concurrency flags, optional predicate, and
  the real SQL line number. In strict native JSON/Markdown, multi-line index
  anchors expand to the complete SQL statement instead of stopping at the
  `CREATE INDEX` line.
- Supabase migration constraint anchors sourced from statement-level
  `ALTER TABLE ... ADD CONSTRAINT ... CHECK (...) [NOT VALID]` and
  `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY (...) REFERENCES ...`,
  `UNIQUE [NULLS [NOT] DISTINCT] (...)`, `PRIMARY KEY (...)`,
  `{ UNIQUE | PRIMARY KEY } USING INDEX ...`, `EXCLUDE [USING method] (...)`,
  and named table constraints inside `CREATE TABLE ... (CONSTRAINT ... CHECK |
  UNIQUE | FOREIGN KEY | EXCLUDE ...)` statements, emitted as native-shaped
  `variable` nodes plus native `references` edges with
  `metadata.relation = "migration-constraint"`.
  Metadata keeps constraint name, table, constraint type, check expression or
  foreign-key source columns, referenced table, optional referenced columns,
  `MATCH FULL|PARTIAL|SIMPLE`, `ON DELETE` / `ON UPDATE` actions,
  optional action column lists for `SET NULL (...)` / `SET DEFAULT (...)`,
  unique `NULLS DISTINCT` semantics, reused index name, exclusion index method,
  exclusion elements, optional predicate, `DEFERRABLE` / `NOT DEFERRABLE`,
  `INITIALLY DEFERRED|IMMEDIATE`, not-valid flag, `constraintSource`
  (`alter-table` or `create-table`), and the real SQL line number.
  Duplicate same-name constraint definitions in one migration keep the legacy
  stable node ID for the first occurrence and use table+line scoped IDs for
  later occurrences, preventing unrelated constraints from folding together.
  The current real migrations contain no `MATCH` / deferrability /
  action-column FK clauses and no `USING INDEX` / `EXCLUDE` constraints, but
  fixture/spec coverage locks the parser and query behavior. In strict native
  JSON/Markdown, multi-line `ALTER TABLE ... ADD CONSTRAINT ...` anchors expand
  to the complete SQL statement, including trailing `NOT VALID` or predicate
  lines.
- Supabase migration constraint-validation anchors sourced from statement-level
  `ALTER TABLE ... VALIDATE CONSTRAINT ...` statements, including quoted
  identifiers such as `"public"."tasks"` and `"constraint_name"`. They are
  emitted as native `references` edges with
  `metadata.relation = "migration-constraint-validation"` from the migration
  file node to the matching constraint node, so delayed validation is queryable
  without introducing duplicate validation-only symbols when the constraint
  definition exists in the same migration. Same-name constraints are matched by
  `constraintName` plus table scope, so `VALIDATE CONSTRAINT` on one table does
  not resolve to another table's first same-name constraint in the same
  migration file. Strict native `migration-constraint-validation` codeBlocks
  expand the source edge line to the complete `ALTER TABLE ... VALIDATE
  CONSTRAINT ...;` SQL statement.
- Supabase migration SQL function anchors sourced from migration file nodes,
  including statement-level `CREATE [OR REPLACE] FUNCTION` name,
  `RETURNS`/`RETURNS TABLE`, `LANGUAGE`, and `SECURITY DEFINER` /
  `SECURITY INVOKER` metadata. Dollar-quoted function bodies are skipped by the
  SQL statement splitter so strings inside PL/pgSQL bodies do not become
  migration-level function facts.
- Supabase migration trigger anchors sourced from migration file nodes,
  including `CREATE TRIGGER` name, `ON` table, timing, events, and
  `EXECUTE FUNCTION` / `EXECUTE PROCEDURE` target function.
- Supabase migration test mappings from migration relative paths or filenames
  referenced by spec/test files, emitted as native `references` edges with
  `metadata.relation = "test"`, `metadata.testMapping`, plus
  `metadata.matchedNeedle` for concrete filename/path hits. Filename matches
  are `filename-reference`; relative path matches are `path-reference`.
- `AGENTS.md` hard-rule anchors, body text for body-only retrieval terms, and
  scoped native `variable` keyword nodes for high-signal hard constraints such
  as `crypto.randomUUID()`, `@defer`, `visibility:hidden`, `StoreService`, and
  the sync-required `content` field.
  Keyword edges carry `metadata.keywordMapping = "hard-rule-keyword"` plus
  `metadata.matchedNeedle`. Implementation evidence such as AST-proven
  `crypto.randomUUID()` calls also emits native `references` edges from the
  AGENTS keyword node to the containing method/function node with
  `metadata.relation = "hard-rule-implementation"`. Required sync fields such
  as `content` also emit native `references` edges from the AGENTS keyword node to matching
  `FIELD_SELECT_CONFIG.*.content` select-field property nodes with
  `metadata.relation = "sync-required-field"`.
- `AGENTS.md` sync-rule anchors derived from hard-rule bodies, with scoped native
  `variable` keyword nodes and `references` edges for synchronization keywords
  such as `RetryQueue`, `LWW`, `IndexedDB`, `updated_at`, and `last_sync_time`;
  config-table rows such as `SYNC_CONFIG.DEBOUNCE_DELAY`,
  `TIMEOUT_CONFIG.QUICK`, and `FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY` are also extracted as
  sync-rule anchors with their baseline value as body text. Keyword anchors stay
  in `AGENTS.md` even when project code has same-name fields or constants.
  Resolved `*_CONFIG.*` rows also emit native `references` edges to their real
  config `property` source when available, including object literals wrapped in
  `as const` / `satisfies`, nested object-literal properties, and getter
  properties such as `SYNC_CONFIG.REALTIME_ENABLED`. The edge metadata carries
  `metadata.relation = "config-source"`, `metadata.configKey`,
  `metadata.configObject`, `metadata.configProperty`, and
  `metadata.configPath`; when the exact property node cannot be found the layer
  falls back to the config constant. `SYNC_CONFIG.*` rows additionally keep the
  compatibility relation `sync-config-source` to the `SYNC_CONFIG` constant;
  exact `sync-config-source` queries also pull the same-source `config-source`
  property provenance so strict native code blocks can show the concrete
  `SYNC_CONFIG.*` line instead of only the whole config object.
  Config properties themselves preserve object-literal parent-child structure
  through native `contains` edges, for example
  `FOCUS_CONFIG.GATE -> FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY`, with
  `metadata.parentConfigPath` on child edges.
  Unresolved config sources are skipped instead of materialized as placeholder
  nodes. Sync keyword edges distinguish
  `metadata.keywordMapping = "sync-body-keyword"` from
  `metadata.keywordMapping = "sync-config-keyword"` and retain
  `metadata.matchedNeedle`.
- Supabase `FIELD_SELECT_CONFIG.*_FIELDS` string lists are split into
  native-shaped `property` field nodes such as
  `FIELD_SELECT_CONFIG.TASK_LIST_FIELDS::content`. Calls to
  `.select(FIELD_SELECT_CONFIG.*_FIELDS)`, including wrapper arguments such as
  `getCompatibleTaskSelectFields(FIELD_SELECT_CONFIG.TASK_LIST_FIELDS)`, emit
  native `references` edges from the containing method/function to each selected
  field with `metadata.relation = "supabase-select-field"`, `metadata.table`,
  `metadata.field`, and `metadata.selectConfig`.
  Direct string literal calls such as `.select('id, content, updated_at')`
  create owner-scoped native `property` field nodes with
  `metadata.selectSource = "inline-select"` and method/function `references`
  edges to the selected fields. The parser splits on top-level commas, recurses
  into nested select parentheses, and skips `*` / relationship wrapper names so
  relation joins do not become false field nodes.
- Supabase incremental-pull predicates such as `.gt('updated_at', since)`,
  `.gt('updated_at', effectiveSince)`, and `.gte('updated_at', lastSyncTime)`
  are extracted into native-shaped `variable` predicate nodes named
  `updated_at > last_sync_time`. The containing method/function emits a native
  `references` edge to the predicate with
  `metadata.relation = "supabase-incremental-predicate"`, while AGENTS
  `updated_at` and `last_sync_time` sync-rule keyword nodes emit native
  `references` edges to the same predicate nodes with
  `metadata.relation = "sync-required-predicate"`. Predicate metadata keeps the
  table, column, operator, concrete cursor variable name, and normalized
  `cursorKeyword`.
	- Supabase Storage bucket references from `.storage.from('bucket')` and
	  `storage.objects` policy expressions such as `bucket_id = 'bucket'` are
	  extracted into native-shaped `variable` bucket nodes. The containing
	  method/function or migration file emits a native `references` edge with
	  `metadata.relation = "supabase-storage-bucket"`. Storage metadata uses
	  `storageSource` instead of `source` so native formatter relationship fields do
	  not get overwritten. Migration policy bucket nodes are scoped by bucket,
	  policy name, and policy line so multiple policies for the same bucket do not
	  merge into one broad source range.
- Supabase RPC calls from `rpc('function_name', args)` are extracted only when
  the function name is static. The containing method/function emits a native
  `references` edge with `metadata.relation = "supabase-rpc"`, while metadata
  keeps `functionName` and static object argument keys as `argNames`.
- Supabase table write calls from `.from('table').insert(...)`,
  `.update(...)`, `.upsert(...)`, and `.delete()` are extracted only when the
  table name is static in the call chain. The containing method/function emits a
  native `references` edge with `metadata.relation = "supabase-table-write"`,
  while metadata keeps `table`, `writeOperation`, static `payloadKeys`, and
  static `optionKeys`.
- Supabase Realtime channels and Postgres change subscriptions are extracted
  from implementation-side `.channel(...)` and `.on('postgres_changes', ...)`
  calls. The containing method/function emits native `references` edges with
  `metadata.relation = "supabase-realtime-channel"` or
  `metadata.relation = "supabase-realtime-postgres-change"`. Metadata keeps the
  callable `owner`, the static or template-derived `channelName`, plus `event`,
  `schema`, `table`, and `filter` when available. The endpoint node id includes
  owner and call line to avoid folding separate subscriptions that share a
  channel name or `postgres_changes` target in the same file.
- Supabase Realtime subscribe statuses are extracted from implementation-side
  status comparisons and previous-status checks. The containing method/function
  emits native `references` edges with `metadata.relation =
  "supabase-realtime-status"`, and the status node is scoped by callable owner so
  repeated `SUBSCRIBED` / `CHANNEL_ERROR` / `TIMED_OUT` literals keep precise
  source windows. Tooling/test files are excluded from this project-semantic
  relation while still remaining available as ordinary native TypeScript graph
  symbols.
- Supabase Realtime lifecycle cleanup calls are extracted from
  `channel.unsubscribe()`, `client.removeChannel(channel)`, and
  `client.removeAllChannels()`. The containing method/function emits native
  `references` edges with `metadata.relation` values
  `supabase-realtime-unsubscribe`, `supabase-realtime-remove-channel`, or
  `supabase-realtime-remove-all-channels`. Lifecycle nodes are scoped by the
  callable owner so repeated `removeChannel(channel)` calls in the same file keep
  precise line-level code blocks instead of merging into one wide file-level
  node. `channel.unsubscribe()` is still extracted when the receiver is a
  Realtime channel variable whose concrete channel name is unknown; in that case
  metadata keeps `channelVariable`.
- Native-shaped TypeScript/JavaScript-family graph nodes for files, classes, methods,
  constructors, properties, functions, interfaces, `type_alias`, `constant`,
  `variable`, enums, enum members, namespaces, explicit `import` / `export`
  declarations, `parameter` nodes, `.mts` / `.cts` module files, `.d.ts`
  declaration files, `.js` / `.jsx` / `.mjs` / `.cjs` source files,
  declarations nested inside namespaces,
  exported object-literal function properties, default-export object-literal
  function properties, default-export object-identifier function properties,
  export-declared object-identifier function properties, CommonJS
  `module.exports = { ... }` and
  `exports.name = ...` exported object/function properties, CommonJS
  `require()` destructuring and namespace aliases, exported factory-returned
  object function properties including middleware/HOF call wrappers, nested named
  functions and variable-bound arrow/function-expression functions in function
  bodies, local class/interface/type/enum declarations inside function and
  method bodies, type literal members, function-typed type literal properties
  promoted to method nodes, interface/type literal call, construct, and index
  signatures, tuple contract string-literal method names, and higher-order
  wrapped class-field arrow/function methods. Union object type members are not
  promoted, matching native CodeGraph's phantom-member noise boundary. Build
  output directories such as `build/` stay excluded so JavaScript report bundles
  do not become repository facts.
- Native TypeScript-style filtering for built-in utility/global types
  (`Record`, `ReadonlyArray`, `Promise`, `Partial`, `Pick`, `Awaited`, etc.),
  standard-library global values (`Promise`, `Math`, `JSON`, DOM globals, etc.),
  and local generic type parameters (`T`, `TPort`, etc.), including nested type
  literal / callback / method signature scopes, so they do not become project
  symbol nodes while their generic project type arguments remain linked.
- Native TypeScript-style handling for modern type-expression syntax:
  `satisfies`, `as`, and type assertions keep project type references, while
  `as const` is filtered as a standard-library/language-level assertion instead
  of becoming a project symbol.
- Native-shaped TypeScript edges for file containment, class/interface/enum
  membership, parameter containment, object-function containment, nested-function
  containment, local-declaration containment, type-literal-member containment,
  imports, exports and re-exports, extends/implements, calls, return types, type
  references, local variable type annotations, parameter types, type parameter
  constraints/defaults, initializer references, JSX component render
  dependencies, `new` expressions, decorators, overrides, and native-style
  `interface-impl` synthesized `calls` edges from interface/base methods to
  concrete implementation methods.
- Scoped TypeScript reference resolution for same-file symbols, imported
  aliases, default imports/exports, namespace imports, qualified namespace/type
  names, type-only imports/exports, `export =` / `import = require()` aliases,
  duplicate symbol names across files, and re-export aliases.

Generate the overlay with:

```powershell
npm run codegraph:overlay
```

Use the fresh validation gate before treating the adapted CodeGraph corpus or the
coverage numbers in this document as current:

```powershell
npm run codegraph:overlay:validate
```

This command publishes one immutable `.codegraph/nanoflow-generations/<generation-id>/` and advances `.codegraph/nanoflow-generations/CURRENT.json` before validating the docs.
Production reads use `scripts/lib/codegraph-overlay-current-receipt.cjs`
through `readOverlayCurrentReceipt(projectRoot)`; `compatibility/nanoflow-overlay.json` is generation-local only.
The stable overlay transaction runs `codegraph:overlay:docs:assert-clean`, then `codegraph:overlay:stable`, performing exactly two builds around source manifest path/size/SHA-256 snapshots M0/M1/M2.
Full normalized equality and native graph shape/health ignore only `generatedAt` and graph `node.updatedAt`,
preserves array order and non-diagnostic semantic counters; overlay publication is atomic separately.
Documentation sync is numeric-token-only and
uses a recoverable two-document transaction with fsynced same-directory temps,
journaled pre/post images, and preimage CAS. `codegraph:overlay:docs:assert-clean`
is read-only; `codegraph:overlay:docs:recover` accepts only recognized hashes.
There is no cross-three-file simultaneous atomicity claim. The lower-level docs
validator remains snapshot-only. After intentional count drift, run
`npm run codegraph:overlay:sync`, then finish with `codegraph:overlay:validate`.

Single shared tree freshness and multi-agent conflict handling is the default
coordination model for NanoFlow agents. CodeGraph remains the first repository
fact locator, but current disk contents are authoritative for the latest changed
files. When CodeGraph reports `pending index sync`, or when a target file has
changed since context was gathered, agents must treat the indexed result as a
locator only and reread the precise on-disk source before editing. Before any
write in the shared tree, run `npm run codegraph:adapter:preflight` or an
equivalent check that captures `git status --short`, `git diff --name-only`,
doctor output, and lease state. Then claim file set in the progress update and
hold a short file lease with
`npm run agent:file-lease -- claim --owner <agent-id> <files...>` until the edit
is verified or abandoned. `agent:file-lease status` is a read-only diagnostic;
expired lease cleanup uses an explicit `prune` command. Query paths must stay non-mutating:
`skipRefresh=true` / `NANOFLOW_OVERLAY_SKIP_REFRESH=1` remains the default for
MCP context queries, and semantic changes refresh the adapted graph explicitly
with `npm run codegraph:overlay` followed by `npm run codegraph:overlay:validate`.
The contract keywords are `single shared tree` and `latest changed files`.

Use the lightweight adapter doctor for a machine-readable local health snapshot
without running the full gate:

```powershell
npm run codegraph:adapter:doctor
npm run codegraph:adapter:doctor -- --explain
npm run codegraph:adapter:doctor -- --strict
npm run codegraph:adapter:doctor -- --direct-mcp-error "Transport closed" --explain
node scripts/analyze-codegraph-mcp-log.cjs .codegraph\nanoflow-mcp-wrapper.log --text --observed-at now --direct-mcp-error "Transport closed"
```

It reports package script wiring, authenticated CURRENT/immutable-generation freshness,
graph size, and current `agent:file-lease` state. `--explain` renders the same
checks as a human-readable summary; `--strict` also checks CI workflow wiring,
quick-gate wiring, infra-test coverage, gate-owned wrapper logs, and strict log
guard flags. The doctor also inspects the host MCP wrapper log, compares the
latest wrapper and latest context-pack-producing wrapper startup script hashes
against the current on-disk `scripts/codegraph-nanoflow-mcp-stdio.cjs`, and
reports `host-mcp:current-wrapper` / `host-mcp:current-context-wrapper`. If the
live process list is available and contains CodeGraph wrapper processes, doctor
uses each wrapper's process identity, not PID alone, to filter shared-log
`wrapper.start` and `nanoflow.context.response` evidence before selecting
current wrapper records. On Windows the identity includes
`Win32_Process.CreationDate`; on POSIX it is derived from `ps etimes`. A log
event with the same PID but a timestamp earlier than the current process start,
allowing a 5000ms clock-skew window, is historical PID-reuse evidence and must
not revive an old direct watcher, target mismatch, or auto-sync-disabled run.
The `hostMcp.liveWrapperLogFilter` object records whether that filter was
applied, `liveWrapperPids`, `liveWrapperProcesses[].startedAt`,
`processStartClockSkewMs`, total ignored entries, and the separate
`ignoredPidReuseWrapperStarts` / `ignoredPidReuseContextResponses` counts. If
no process start time is available, doctor conservatively retains PID-only
matching; if no live wrapper process evidence is available, doctor falls
back to historical log order so offline log inspection still works. If the
latest host context wrapper is stale, treat host `Transport closed` as a
session/config refresh problem until a fresh wrapper smoke or adapter fallback
proves the current disk script is failing.
Live process collection also records `parentName` and `parentCommandLine`.
Wrappers whose parent is explicitly a Codex process remain host candidates;
wrappers whose parent is explicitly a non-Codex Node, Vitest, PowerShell, or
smoke process are retained under `hostMcp.liveProcesses.auxiliaryProcesses`
with `classificationReason=wrapper-parent-is-not-codex-host` and excluded from
host target/command mismatch checks and live-log PID filtering. Missing parent
evidence is `unknown` and remains a host candidate, so the diagnostic does not
hide a real second Codex instance merely because parent inspection failed.
Context evidence has a second supersession boundary for host configuration.
If a context-producing wrapper has a target/env mismatch, its last
`nanoflow.context.response` is older than a later
`currentConfiguredWrapper` start, and that later wrapper matches disk plus the
active Codex target/env, doctor sets
`currentContextWrapperConfigSupersededByFreshWrapper=true`, records
`currentContextWrapperSupersededReason=config`, preserves the old comparison in
`currentContextWrapperRawEnv` / `currentContextWrapperRawTarget`, and makes the
effective context env/target checks unknown rather than failed. If the
misconfigured wrapper emits another context response after the configured
wrapper start, it is still active evidence and strict doctor must fail; a new
wrapper start in a different task does not prove that every old Codex MCP
transport reconnected.
If the agent already observed a direct MCP tool-layer error such as
`Transport closed`, pass that exact error to doctor with
`--direct-mcp-error`. Doctor must fail `host-mcp:observed-direct-mcp-error`,
set `hostMcp.rootCauseSummary.status` to
`direct-mcp-host-transport-closed`, set
`hostMcp.rootCauseSummary.failureBoundary` to `codex-mcp-host-transport`, and
include `observed-direct-mcp-transport-closed`,
`observed.directMcpError`, `observed.liveWrapperProcessCount`,
`directMcpTrust=do-not-trust-direct-mcp-until-host-restarts`, and the
adapter-first fallback command. This covers the case where the connected Codex
MCP host closes before a fresh wrapper can write new request evidence, so a
clean shared log must not be treated as proof that direct MCP is healthy.
The log analyzer accepts the same observed tool-layer error through
`--direct-mcp-error` or `NANOFLOW_CODEGRAPH_DIRECT_MCP_ERROR`. When supplied, its
JSON and text summaries must include top-level `observedDirectMcpError`,
`observedDirectMcpFailureClass`, and
`diagnosticTriage.primaryEvidence.directMcpError`. If no current effective
wrapper transport failure is present, `observed-direct-mcp-transport-closed` is
host/session evidence and `adapterFailureLikely=false`; if
`latestEffectiveCriticalTransportFailure` is present, the wrapper transport
failure remains the primary root cause and the observed direct MCP error is only
additional evidence.
For deterministic incident review, pass `--observed-at <iso-time>` with the
time the tool-layer error was seen; otherwise doctor uses `now` for direct MCP
errors. The root-cause JSON and `--explain` output include
`hostMcp.rootCauseSummary.observed.logEvidence.observedAt`,
`latestLogAgeMs`, `activeWindowMs`, `staleAgainstObservedAt`,
`hasCurrentWrapperEvidence`, `liveWrapperLogFilter.*`, and
`currentEvidenceWindow.*`. If `staleAgainstObservedAt=true` or
`hasCurrentWrapperEvidence=false`, the latest shared-log line is historical
evidence only and must not be used to blame the current adapter wrapper.

Use the machine-readable baseline manifest when a consumer needs stable handles
for overlay counters:

```powershell
npm run codegraph:overlay:baseline:manifest
```

It writes `.codegraph/nanoflow-overlay-baseline-manifest.json`, marking
`graphNodes` and `graphEdges` as diagnostic counters while semantic counters are
stable by default.

Use the quick agent gate for a faster shared-tree confidence check:

```powershell
npm run codegraph:adapter:preflight
npm run codegraph:adapter:quick-gate
```

The quick profile runs preflight, `codegraph:adapter:infra:test`, one MCP smoke
iteration, `npm run codegraph:adapter:context`, the focused
`codegraph:adapter:context:packaged-artifacts` source-quality regression, and
`codegraph:mcp:log:guard`.
It is intentionally lighter than the full gate and does not replace full overlay
extraction/query verification.

For write-path preparation, run `npm run codegraph:adapter:preflight` before
editing adapted graph code or docs. For a faster agent-local confidence pass,
run `npm run codegraph:adapter:quick-gate`; it composes preflight, adapter
infrastructure tests, one adapter context fallback, one MCP smoke, stale-smoke,
and strict log guard. For machine-readable semantic-count drift tracking, run
`npm run codegraph:overlay:baseline:manifest` to emit
`.codegraph/nanoflow-overlay-baseline-manifest.json`.

When the host MCP session is stale, unavailable, or returning transport errors,
use the adapter-first NanoFlow adapter CLI fallback instead of dropping directly
to native CodeGraph:

```powershell
npm run codegraph:adapter:context -- --query "AGENTS hard rules sync-required-field"
npm run codegraph:overlay:query -- --query sync-required-field --skip-refresh
```

`codegraph:adapter:context` starts a fresh NanoFlow wrapper process and calls
`nanoflow_context_pack` plus `nanoflow_overlay_query`, preserving project
semantics even when the already-connected IDE MCP process is stale.

Use the full project adapter gate before claiming the NanoFlow CodeGraph
adapter is healthy end to end:

```powershell
npm run codegraph:adapter:gate
```

That gate owns the formal direct order: docs `assert-clean` once with a 30-second
bound, stable generation once with a 20-minute bound (internally exactly two
builds), then the validator once with a 10-minute bound. It does not nest package
aliases or double-generate. The remaining plan runs adapter preflight and doctor,
adapter infrastructure tests, tooling dependency closure, adapter context and
focused source-quality checks, `codegraph:overlay:test`, `codegraph:mcp:smoke` / `codegraph:mcp:stale-smoke`,
and the strict log guard. `codegraph:adapter:context:packaged-artifacts` retains
the minified-bundle/source-map/lockfile regression. Printed invocation counts and
the formal plan digest are byte-semantic test contracts. The generator, raw docs
validator, query/MCP refresh paths, and gate therefore share direct fail-closed
transaction checks instead of relying only on package aliases. The auxiliary
`codegraph:overlay:baseline:manifest` and quick gate are not extra full-gate
steps. The fresh smoke and guard steps are
wired through the gate-owned `codegraph-adapter-gate-mcp-wrapper.log`; stale
continuation uses the separate `codegraph-adapter-gate-stale-mcp-wrapper.log`
so strict current-wrapper health is not polluted by the intentional stale
simulation. The guard uses `--fail-on-current-autosync-disabled`,
`--fail-on-stale-current-wrapper`, `--fail-on-active-stale-wrappers`,
`--fail-on-host-config-mismatch`, and `--fail-on-untrusted-direct-mcp` so a
frozen current CodeGraph index, stale IDE wrapper history, mixed active wrapper
hashes, live wrapper target/env drift from the active Codex config, or a
root-cause summary that marks direct MCP as untrusted cannot be mistaken for
current on-disk wrapper health. Treat
`codegraph:overlay:test` as
the native-adapter parity layer: it locks focused Angular, Supabase, AGENTS,
sync-rule, test-mapping, strict native JSON, strict native Markdown, source
block, generated-file, and wrapper resilience behavior instead of relying on
prose or one-off manual queries. The gate runner also enforces a configurable
per-step timeout via
`NANOFLOW_CODEGRAPH_GATE_STEP_TIMEOUT_MS`, reports a bounded captured output
tail for noisy direct commands, and cleans up matching CodeGraph descendant
processes so a hung adapter step cannot leave the gate indefinitely stuck.
An explicit positive `timeoutMs` on a printed-plan command overrides that
global default for that command only. The full `codegraph:overlay:test` parity
step uses `900000ms` because the 421-test native/overlay suite can exceed the
generic ten-minute budget under concurrent repository load; all other steps
retain the normal default unless their plan entry explicitly says otherwise.
`codegraph:adapter:doctor` also checks `host-mcp:log-parse`; malformed wrapper
log lines are reported through `hostMcp.logMalformedLines` and
`hostMcp.latestMalformedLogLine` instead of being silently discarded, because a
truncated `wrapper.start`, `wrapper.script.stale`, or `nanoflow.context.response`
line can hide the real root cause. The MCP log analyzer also exposes
`malformedLineNumbers`, `malformedLineRootCauseClasses`, and capped
`malformedLineDetails[]` entries with `lineNumber`, `rootCauseClass`,
`parseError`, `linePreview`, `suspectedEvent`, `nearbyRunId`, `nearbySeq`,
`previousEvent`, and `nextEvent` so a half-written JSON line can be traced to
the surrounding wrapper run without guessing.

The immutable generation tree and selector are local-only:

```text
.codegraph/nanoflow-generations/<generation-id>/
```

It is ignored by git with the rest of `.codegraph/`.

For high-adaptation MCP output, call:

```text
nanoflow_context_pack
```

This MCP tool asks CodeGraph for the base `codegraph_explore` result, queries the
NanoFlow overlay, and returns one native CodeGraph-style Markdown response:

- The original `codegraph_explore` sections when CodeGraph returns them. The
  pinned `@colbymchenry/codegraph@1.6.2` base explore renderer uses
  `**Exploration: ...**`, `**Relationships**`, and `**Source Code**`; the
  wrapper still recognizes legacy `## Exploration` / `### Source Code` output
  from older fixtures and stale hosts.
- Overlay-backed source blocks when the base CodeGraph result misses
  an exact project file that the overlay selected. If the base result already
  contains a generic `**Source Code**` or legacy `### Source Code` section, overlay source blocks are inserted
  at the front of that section so the first visible source window follows the
  NanoFlow-specific match instead of a broad generic symbol. This is intentionally
  used for root-level project configuration files such as
  `vitest.services.config.mts`, where a broad query may otherwise be pulled
  toward generic symbols like `cleanup` or `config`.
- Overlay `### Relationships`, grouped with native CodeGraph edge names such as
  `imports`, `references`, `type_of`, `calls`, and `decorates`. Ordinary symbol
  queries suppress generic `contains` edges in Markdown like native
  `codegraph_explore`; exact `metadata.relation`, `metadata.synthesizedBy`,
  Angular template `metadata.bindingKind`, test edge `metadata.testMapping`, or
  AGENTS keyword edge `metadata.keywordMapping` queries still show matching
  `contains`, synthesized, template, test, or keyword relationship edges when
  the queried metadata is represented that way.
- `### Blast radius — what depends on these (update/verify before editing)`,
  derived from overlay graph reverse edges and same-directory test links.
- Overlay `### Related Symbols`, using CodeGraph-like symbol rows grouped by file.
- Overlay `### Source Code` blocks with the native verbatim on-disk source disclaimer and
  `#### file — symbol(kind)` headers.
- `### Not shown above — explore these names for their source`, plus the native
  complete-source and explore-budget guidance when the result spans more symbols
  than the source window budget can show.
- `### NanoFlow Coverage`, with current overlay coverage counts.
- `### Next Steps`, with safe follow-up guidance for targeted CodeGraph calls.

The wrapper keeps machine-readable output available through the CLI query's
`--json` mode and the MCP tool's explicit `json: true` argument. Default JSON
responses include `nodes` in the official CodeGraph `Node` shape and `edges` in
the official CodeGraph `Edge` shape (`source`, `target`, `kind`, optional
`metadata`, `line`, `column`, and `provenance`), plus NanoFlow debug/compatibility
fields such as `matches`, `displayEdges`, `relationshipGroups`, `blastRadius`,
`notShown`, `coverage`, and the rendered `markdown`. JSON responses also include
the native `TaskContext`-style projection fields `summary`, `entryPoints`,
`codeBlocks`, `relatedFiles`, and `stats`. Strict native `entryPoints`, `nodes`,
`codeBlocks`, and `relatedFiles` keep the selected graph intact but demote
low-information test/spec/helper/icon/i18n/generated paths and import/export/file
placeholders when an ordinary symbol/path query does not explicitly ask for them.
Pure exact relation `codeBlocks` keep the relation-specific evidence order from
the native code-block builder, so template/resource files, test-mapping evidence
lines, migration validation statements, and owner-first implementation evidence
are not re-sorted behind generic method/class blocks. `entryPoints`
follow CodeGraph's
high-information node policy: `import`, `export`, `parameter`, and non-call
unresolved reference placeholder nodes are kept in `nodes`/`edges` when
relevant, but are not promoted as primary context entry points while a real
declaration is available. For single-term queries, exact or prefix matches on
high-information declarations take entry-point and code-block priority over
incidental substring matches such as `FlowMinimapComponent` for `map`. Callable
unresolved references follow CodeGraph's
resolver boundary: a `calls` edge is emitted only when same-file, import,
default-export object-literal/object-identifier, export-declared object
identifier, namespace-import, re-export, or CommonJS require evidence resolves a
target.
Simple identifier receiver calls are encoded like native CodeGraph as
`receiver.member` before resolution, so `namespace.member()` can resolve through
namespace imports, `defaultActions.run()` can resolve through a default import
to a function property on `export default { run() {}, queue: () => {} }`, and
`namedDefaultActions.runNamed()` can resolve through
`const namedDefaultActions = { ... }; export default namedDefaultActions`, while
`exportedActions.runExported()` can resolve through
`export { localNamedExportActions as exportedActions }`, and
`this.member()` keeps the bare method name. Unresolved member calls are not
materialized as local `variable` nodes. CommonJS exports use the native
`exports` edge kind with `metadata.relation = "commonjs-export"`; shorthand
properties in `module.exports = { loadCommonJs }` point at the existing
declaration instead of creating a duplicate function node. CommonJS `require()`
aliases use the native `imports` edge kind with
`metadata.relation = "commonjs-require"`, and destructured calls such as
`hydrate()` or namespace calls such as `commonjsActions.queue()` resolve to the
real CommonJS export target when the export graph has enough evidence. The debug
`matches` list uses the same
high-information ranking, so a
decorator query such as `Injectable` surfaces the decorated class before the
low-information `import Injectable` rows when both are present. For normal
symbol queries, JSON `codeBlocks` are generated from entry points first, use
official `Language` enum values, and keep source content separate from
Markdown's line-numbered source windows. For exact metadata relation queries,
strict native JSON code blocks prioritize readable relation targets and then
other endpoints, including endpoints that are not selected as entry points, such
as AGENTS config `property` nodes. Exact relation node selection preserves both
source and target ids even when their display names are identical, so strict
native JSON does not drop edges during closed-endpoint projection. Test mapping
queries use the same target-first
budgeting for spec/test `file` endpoints, so `same-basename` and related
provenance queries still expose test source when the result set exceeds the
native code block budget. Non-test relation-only edge-line and provenance
codeBlocks use owner-first ordering: method/function evidence wins over
class/component context, which wins over properties, synthetic variables, file
nodes, and low-value paths before the five-block native budget is applied.
`template-url` and `style-url` queries use the same
resource-endpoint budgeting for Angular external HTML/CSS/SCSS `file` nodes, so
strict native JSON exposes resource content before declaration class blocks can
fill the native code block budget. `path-reference`, `route-reference`,
`invoke-reference`, and `filename-reference` use edge-line codeBlocks for the
referencing spec/test file and resolve the line from `matchedNeedle`, so strict
native JSON exposes concrete path, route, invoke, or migration filename
assertions instead of a whole contract file. Angular route relation queries
expand single-line `route` endpoints to the full route object, so strict native
JSON/Markdown shows `path`, guard/resolver/provider/redirect fields, and nested
route context instead of a lone `{` line. Non-test exact relation queries deprioritize
test/spec fixture paths for codeBlock endpoint ordering, so
`angular-route-redirect` exposes production route blocks from `src/app.routes.ts`
before route-shaped parser fixtures. `host-attribute`, `host-binding`, and
`host-listener` use authoritative edge-line codeBlocks for the Angular `host`
metadata object, so strict native JSON exposes the concrete static attribute,
binding expression, or listener expression line before synthetic one-line
endpoint nodes or class-body-only blocks can consume the native budget. Those
edge-line blocks keep the real owner `nodeName` such as `SampleComponent`
instead of labeling every block with the relation name. `edge-function-source` uses source-first
budgeting and suppresses same-file line-one fallback blocks after the same Edge
Function handler has been expanded to its `Deno.serve(...)` / `serve(...)`
function block. `edge-function-route` uses source-first budgeting and
expands Supabase `Deno.serve(...)` / `serve(...)` handlers into function
codeBlocks, so deployed route queries expose the real Edge Function
implementation instead of only the synthetic route line. `edge-function-invoke`
uses source-first codeBlock budgeting for implementation-side call sites, so
strict native JSON exposes caller methods/functions before synthetic route
endpoints or file headers can fill the native budget. `supabase-storage-bucket`
uses source-first codeBlock budgeting for TypeScript call sites and suppresses
same-file synthetic bucket variable blocks when an owner method/function is
available, while still preserving SQL migration policy bucket blocks.
`supabase-rpc` and `supabase-table-write` use the same source-first treatment for
implementation-side Supabase operation calls, so strict native JSON exposes the
owner method/function before synthetic RPC or table-operation variable rows can
fill the native code block budget.
`sync-required-field` backtracks from the AGENTS `content` rule edge to the
same field's concrete `supabase-select-field` provenance, so strict native JSON
exposes owner methods/functions with `.select(...)` before AGENTS keyword or
field-definition blocks can consume the native code block budget, even when
noisy provenance edges appear first in overlay edge order.
`providedIn` uses source-first codeBlock budgeting and local-scope provider
targets, so strict native JSON exposes the injectable class/decorator source
before a scoped provider value such as `root` can fill the native code block
budget.
`supabase-incremental-predicate` uses the same owner-first treatment for
TypeScript sync query predicates, so strict native JSON exposes the method or
function containing `.gt('updated_at', ...)` / `.gte('updated_at', ...)`
instead of only the synthesized predicate variable line.
`sync-required-predicate` backtracks from the AGENTS `updated_at` /
`last_sync_time` rule edge to the same predicate's real Supabase owner
method/function, and suppresses AGENTS keyword plus synthesized predicate
variable blocks so rule queries still expose implementation source first.
`migration-constraint-validation`
uses edge-line codeBlocks for the source migration file, so strict native JSON
exposes the `ALTER TABLE ... VALIDATE CONSTRAINT ...` statement before constraint
definition nodes, while still respecting the native code block budget.
`edge-function-method` uses source-first codeBlock budgeting, so strict native
JSON exposes the Edge Function handler that contains the `req.method` branch
before synthetic one-line method variable nodes such as `POST`.
`edge-function-header` uses authoritative edge-line evidence expanded to the
containing `serve(...)` handler or helper function that actually contains
`req.headers.get(...)`, so helper-based auth/header checks are not replaced by a
handler block with no header evidence.
`supabase-realtime-channel`, `supabase-realtime-postgres-change`,
`supabase-realtime-status`, `supabase-realtime-unsubscribe`,
`supabase-realtime-remove-channel`, and
`supabase-realtime-remove-all-channels` also use source-first codeBlock
budgeting, so strict native JSON exposes the methods/functions that create
subscriptions, handle subscribe statuses, or perform Realtime lifecycle cleanup
before synthetic one-line channel/change/status/cleanup nodes can fill the
native code block budget. These Realtime owner blocks are ordered by source
location, not display-name relevance, so the first budgeted block reflects the
first implementation evidence in the file. This lets consumers inspect endpoint,
invoke call-site, storage bucket usage, incremental sync predicate usage,
migration test evidence, migration validation, runtime status-handling, and
cleanup source without re-querying the graph. The `displayEdges` field remains
display-enriched with `sourceName` and `targetName` only for relationship
rendering and compatibility consumers.
Member queries also recover their owner context from native-style qualified
names. For example, a query for `touch` includes the same-file `SampleService`
owner, and a query for `default::run` or `module.exports::queue` can include the
exported object owner, so Markdown and JSON do not collapse to a single
low-context member row.

For exact parity with CodeGraph's native formatters, use one of the strict native
projections. The JSON projection mirrors `formatContextAsJson()`:

```powershell
npm run codegraph:overlay:query -- --query RetryQueue --native-json
```

or call `nanoflow_overlay_query` with `nativeJson: true`. This mode emits only
the official JSON formatter fields:

```text
query, summary, entryPoints, nodes, edges, codeBlocks, relatedFiles, stats
```

The strict native output order contract treats field order and section order as
part of the machine-consumable API. Strict native JSON keeps the native JSON
field order `query/summary/entryPoints/nodes/edges/codeBlocks/relatedFiles/stats`,
and strict native Markdown keeps the native Markdown section order
`Code Context -> Entry Points -> Relationships -> Related Symbols -> Code` and
always emits those section headers. Empty sections render explicit `No ... found`
rows, `Related Symbols` renders a `+N more` marker when the visible related
symbol budget is capped, and `Code` renders a budget marker when the native code
block limit is reached. NanoFlow coverage, debug metadata, and enhanced source
sections must stay out of these strict projections instead of shifting official
formatter positions.

The strict native object projection contract fixes sub-object field order as
part of the same API. Node fields stay ordered as
`id/kind/name/qualifiedName/filePath/language/startLine/endLine/signature/docstring/visibility/isExported/isAsync/isStatic/isAbstract`,
edge fields stay ordered as `source/target/kind/line/column`, and codeBlock
fields stay ordered as `filePath/startLine/endLine/language/content/nodeName/nodeKind`.
Edges preserve endpoint closure over returned `nodes`, and strict native JSON
therefore strips NanoFlow `metadata/provenance/sourceName/targetName` extension
or display fields. MCP responses default to Markdown
so agents can consume the adapted context the same way they consume native
CodeGraph output.

The Markdown projection mirrors `formatContextAsMarkdown()`:

```powershell
npm run codegraph:overlay:query -- --query RetryQueue --native-markdown
```

or call `nanoflow_overlay_query` with `nativeMarkdown: true`. This mode emits
only the official Markdown sections `## Code Context`, `### Entry Points`,
`### Relationships`, `### Related Symbols`, and `### Code`. The relationship
section groups closed native edges by edge kind and prints only native
source/target/kind/location facts, stripping NanoFlow `metadata`, `provenance`,
`sourceName`, and `targetName` display fields. It intentionally omits NanoFlow
enhanced sections such as `### Source Code`, `### Blast radius`, and
`### NanoFlow Coverage`. Entry points and code blocks use the same generated-file
down-ranking semantics as CodeGraph's `generated-detection.ts`: suffixes such as
`.gen.ts`, `.generated.ts`, `.pb.ts`, `_pb.ts`, `.g.dart`, `.freezed.dart`, and
other official generated patterns sort after hand-written files with the same
symbol relevance. If a graph node reports `language: unknown` but the file
extension is recognizable, strict native Markdown code fences infer the concrete
language from the path for Markdown, SQL, HTML, CSS/SCSS/Sass/Less, JSON,
TypeScript, JavaScript, Kotlin, and XML source blocks.

For lower-level overlay debugging, query the overlay directly after CodeGraph has
identified a likely symbol or feature:

```powershell
npm run codegraph:overlay:query -- --query ProjectShellComponent
npm run codegraph:overlay:query -- --query host-directive --json --skip-refresh
npm run codegraph:overlay:query -- --query host-attribute --json --skip-refresh
npm run codegraph:overlay:query -- --query host-listener --json --skip-refresh
npm run codegraph:overlay:query -- --query edge-function-source --json --skip-refresh
npm run codegraph:overlay:query -- --query edge-function-route --json --skip-refresh
npm run codegraph:overlay:query -- --query edge-function-method --json --skip-refresh
npm run codegraph:overlay:query -- --query edge-function-header --json --skip-refresh
npm run codegraph:overlay:query -- --query edge-function-invoke --json --skip-refresh
npm run codegraph:overlay:query -- --query supabase-realtime-channel --json --skip-refresh
npm run codegraph:overlay:query -- --query supabase-realtime-postgres-change --json --skip-refresh
npm run codegraph:overlay:query -- --query supabase-realtime-status --json --skip-refresh
npm run codegraph:overlay:query -- --query supabase-realtime-remove-channel --json --skip-refresh
npm run codegraph:overlay:query -- --query supabase-realtime-unsubscribe --json --skip-refresh
npm run codegraph:overlay:query -- --query supabase-realtime-remove-all-channels --json --skip-refresh
npm run codegraph:overlay:query -- --query sql-function --json --skip-refresh
npm run codegraph:overlay:query -- --query trigger-function --json --skip-refresh
npm run codegraph:overlay:query -- --query migration-index --json --skip-refresh
npm run codegraph:overlay:query -- --query migration-constraint --json --skip-refresh
npm run codegraph:overlay:query -- --query migration-constraint-validation --json --skip-refresh
npm run codegraph:overlay:query -- --query policy-command --json --skip-refresh
npm run codegraph:overlay:query -- --query policy-type --json --skip-refresh
npm run codegraph:overlay:query -- --query privilege-revoke --json --skip-refresh
npm run codegraph:overlay:query -- --query privilege-grant --json --skip-refresh
npm run codegraph:overlay:query -- --query 20260609020000_drop_entity_uuid_defaults.sql --json --skip-refresh
npm run codegraph:overlay:query -- --query RetryQueue --json
npm run codegraph:overlay:query -- --query config-source --json --skip-refresh
npm run codegraph:overlay:query -- --query sync-config-source --json --skip-refresh
npm run codegraph:overlay:query -- --query supabase-select-field --json --skip-refresh
npm run codegraph:overlay:query -- --query inline-select --json --skip-refresh
npm run codegraph:overlay:query -- --query sync-required-field --json --skip-refresh
npm run codegraph:overlay:query -- --query supabase-incremental-predicate --json --skip-refresh
npm run codegraph:overlay:query -- --query sync-required-predicate --json --skip-refresh
npm run codegraph:overlay:query -- --query supabase-storage-bucket --json --skip-refresh
npm run codegraph:overlay:query -- --query supabase-rpc --json --skip-refresh
npm run codegraph:overlay:query -- --query supabase-table-write --json --skip-refresh
npm run codegraph:overlay:query -- --query template-component --json --skip-refresh
npm run codegraph:overlay:query -- --query template-directive --json --skip-refresh
npm run codegraph:overlay:query -- --query template-pipe --json --skip-refresh
npm run codegraph:overlay:validate
npm run codegraph:overlay:docs:validate
npm run codegraph:overlay:query -- --query RetryQueue --native-json
npm run codegraph:overlay:query -- --query RetryQueue --native-markdown
```

With `--skip-refresh` (including implicit context JSON and the environment
equivalent), `isOverlayStale()` remains the sole freshness authority. A stale
overlay fails before query/formatting; a fresh result is serialized, checked
once more, and written to stdout once. At most two freshness checks run. Stale
paths emit no stdout, write the exact stderr line `overlay-stale-skip-refresh`,
do not invoke the generator, and do not mutate overlay bytes or metadata. Fresh
skip and non-skip projections remain byte-compatible. An external writer can
still change source after the final synchronous check and before or while stdout
is written; closing that residual TOCTOU requires locking or version coordination
outside this adapter boundary.

When using the MCP wrapper, the same query is available as the MCP tool
`nanoflow_overlay_query`. The wrapper adds both `nanoflow_context_pack` and
`nanoflow_overlay_query` beside CodeGraph's native tools during `tools/list`, so
agents can stay inside the MCP workflow. The CLI query command remains the
fallback/debug entry. Query terms can target symbol names, file names, node
kinds, edge kinds, exact `metadata.relation` values, exact
`metadata.synthesizedBy` values, Angular template `metadata.bindingKind`
values, test edge `metadata.testMapping` values, or AGENTS keyword edge
`metadata.keywordMapping` values. Relation-only, synthesized-metadata,
template-binding-kind, test-mapping, and keyword-mapping queries
such as `type-literal-member`, `object-function`, `nested-function`,
`local-declaration`, `local-variable-type`, `type-parameter-constraint`,
`type-parameter-default`, `interface-impl`, `control-flow`, `structural`,
`host-directive`, `host-attribute`, `host-binding`, `host-listener`,
`angular-route-guard`, `angular-route-resolver`, `edge-function-route`,
`edge-function-method`, `edge-function-header`, `edge-function-invoke`,
`supabase-realtime-channel`,
`supabase-realtime-postgres-change`,
`supabase-realtime-status`, `supabase-realtime-unsubscribe`,
`supabase-realtime-remove-channel`, `supabase-realtime-remove-all-channels`,
`route-reference`,
`invoke-reference`, `filename-reference`, `hard-rule-keyword`,
`hard-rule-implementation`,
`context7-source-map-source`, `sync-body-keyword`, `sync-config-keyword`, `config-source`,
  `sync-config-source`, `template-component`, `template-directive`,
  `template-pipe`, `supabase-select-field`, `sync-required-field`,
  `supabase-incremental-predicate`, `sync-required-predicate`,
  `supabase-storage-bucket`, `supabase-rpc`, and `supabase-table-write`
select the
matching edges and both endpoint nodes, then render the same relationship groups
and line-numbered source windows as symbol queries. `sync-required-field` stays
focused on required-field edges, but also includes the matching
`supabase-select-field` provenance edges for the same field nodes so callers can
see both the AGENTS requirement and the concrete `.select(...)` sources.
  `context7-source-map-source` strict native code blocks use the source-map
  route table row as edge-line evidence and suppress `context7-source-path`
  synthetic target nodes from code blocks, so directory or glob source paths
  cannot render `docs/context7/source-map.md` frontmatter as the first code
  block.
  `supabase-incremental-predicate` similarly stays focused on concrete Supabase
  filter predicates, while also including AGENTS `updated_at` / `last_sync_time`
  `sync-required-predicate` edges for the same predicate nodes.
  `supabase-storage-bucket` stays focused on concrete Storage bucket references
  from client `.storage.from(...)` calls and `storage.objects` policy
  conditions.
  `supabase-rpc` stays focused on static Supabase Postgres function calls, and
  `supabase-table-write` stays focused on static table write chains; both return
  the containing callable node, the native-shaped semantic endpoint node, and the
  file source window around the real call.
  `template-component`, `template-directive`, and `template-pipe` stay focused on
  Angular template declaration usage, returning the using component class and the
  matched component/directive/pipe class endpoint plus the template usage
  evidence line.
  `edge-function-method` and `edge-function-header` stay focused on
  implementation-side Edge Function request method/header evidence. Method
  queries return the handler function plus the scoped native-shaped method node;
  header queries return the handler or helper function containing
  `req.headers.get(...)` plus the scoped native-shaped header node.
  `edge-function-invoke` stays focused on implementation-side Edge Function
  client calls and returns the callable node plus the existing native route node.
  `supabase-realtime-channel` and `supabase-realtime-postgres-change` stay
  focused on implementation-side Realtime channel creation and
  `postgres_changes` subscription configs, returning the callable node plus the
  owner-and-line-scoped native-shaped channel/change node. Strict native
  codeBlocks prioritize the callable owner by source location.
  `supabase-realtime-status` stays focused on implementation-side subscribe
  status handling, returning the callable node plus the owner-scoped status node
  while excluding overlay/test/mock status assertion noise. Strict native
  codeBlocks prioritize the callable owner by source location.
  `supabase-realtime-unsubscribe`, `supabase-realtime-remove-channel`, and
  `supabase-realtime-remove-all-channels` stay focused on Realtime cleanup
  lifecycle calls, returning the callable node plus the owner-scoped cleanup
  action node. Strict native codeBlocks prioritize the callable owner by source
  location.
Exact metadata queries stay focused on the
matched relationship edges instead of pulling every neighboring edge from the
endpoint symbols. Supabase policy, function, and trigger detail queries such as
`policy-command`, `policy-type`, `policy-role`, `policy-using`,
`policy-with-check`, `sql-function`, `trigger`, `trigger-function`,
`migration-index`, `migration-constraint`, `migration-constraint-validation`,
`privilege-grant`, `privilege-revoke`, `privilege-object`, and
`privilege-role` use the same route; the edge source is the migration file node,
and SQL-specific values remain in `metadata` so SQL commands such as `select`
or `insert`, policy types such as `permissive` or `restrictive`, SQL function
names, trigger function names, privilege names, object names, and role names do
not resolve to unrelated TypeScript symbols. In strict `--native-json` mode,
relation-only queries keep both endpoints of each matching edge in `nodes`
(including migration `file` source nodes), so the official-shaped `edges` array
remains closed and non-empty. Same-named source and target nodes are preserved by
id instead of collapsed by display label, which keeps keyword relations such as
`sync-config-keyword` machine-consumable in strict native JSON. Strict native JSON
also keeps readable non-entry endpoints in `codeBlocks`, which matters for config
`property`, SQL detail `variable`, and route endpoints that would otherwise have
a relationship edge without a local source window. For `policy-using` and
`policy-with-check`, strict native JSON and strict native Markdown expand policy
code blocks to the full `CREATE POLICY ...;` statement so multi-line SQL
expressions do not stop at the declaration line.
Route endpoint code blocks use the same block expansion for Angular route
relations, so guard/resolver/redirect/provider queries keep route object context.
Querying `angular-app-provider` returns application composition-root providers
as native `references` edges from the bootstrap/config file node to provider
tokens or provider factory functions. Strict native JSON and Markdown use
source-first evidence and expand provider code blocks from the
`bootstrapApplication(...)` or `ApplicationConfig` object line through the
concrete provider entry, preserving `deps` and factory-call arguments.
The strict native source evidence contract keeps relation-only codeBlocks
complete and focused across these projection modes: `migration-index`,
`migration-constraint`, and `migration-constraint-validation` expand to complete
SQL statement ranges; `policy-using` and `policy-with-check` keep full
`CREATE POLICY` statements; owner method, `matchedNeedle`, and source-first
relation queries prevent synthetic endpoints from filling the code block budget;
edge-line evidence blocks use the real source owner `nodeName` when the source
node is the meaningful context, instead of replacing every header with a
generic relation label.
Trigger detail nodes are scoped by trigger name, table, and source line so
PostgreSQL table-local duplicate trigger names do not collapse into one graph
symbol; their native-shaped code blocks point at the concrete `CREATE TRIGGER`
line.
Querying a migration filename or relative path also returns Supabase migration
test references as native `references` edges from the migration file node to
the referencing spec/test file node. For `path-reference`, `route-reference`,
`invoke-reference`, and `filename-reference`, strict native JSON code blocks are
scoped to the referencing test line matched by `matchedNeedle`, so large
contract specs do not replace the useful evidence line with a whole-file source
block.
Querying `edge-function-source` returns Supabase Edge Function source/helper
dependencies as native `imports` edges from the Edge Function entry node to
followed source file nodes, with the actual importing file preserved in
`metadata.sourceFile`. Strict native JSON for this query uses source-first
handler codeBlocks and suppresses same-file line-one fallbacks once the handler
has been expanded to its `Deno.serve(...)` / `serve(...)` block.
Querying `edge-function-invoke` returns implementation-side
`functions.invoke('<name>')` calls as native `references` edges from the
containing method/function to the deployed Edge Function route node.
Querying `supabase-rpc` returns implementation-side Postgres RPC calls as native
`references` edges from the containing method/function to a scoped
`supabase.rpc:<function>` native-shaped node. Querying `supabase-table-write`
returns implementation-side table writes as native `references` edges from the
containing method/function to a scoped `supabase.table_write:<table.operation>`
native-shaped node.
Querying `template-component`, `template-directive`, or `template-pipe` returns
Angular template declaration usage as native `references` edges from the using
component class to the matched component, directive, or pipe class. Metadata
keeps `templateFile`, `matchedNeedle`, the declaration `selector`, and matched
`attribute`, `className`, `element`, `attributeValue`, or `pipeName` details.
Directive selector parsing preserves commas inside quoted attribute values,
does not treat `.classLike` text inside attribute values as class selectors, and
normalizes Angular template binding prefixes such as `[foo]`, `[(foo)]`,
`bind-foo`, and `bindon-foo` to the directive attribute name before matching.
Strict native JSON code blocks prefer the concrete template usage line before
falling back to declaration class context; external templates use the
`templateFile` line, while inline templates store source-file absolute line
offsets so evidence points at the host `.ts` template line rather than the first
same-name `matchedNeedle`.
Querying `supabase-realtime-channel` or `supabase-realtime-postgres-change`
returns implementation-side Realtime calls as native `references` edges from the
containing method/function to owner-and-line-scoped native-shaped channel or
Postgres change nodes. If two methods in one file subscribe to the same
channel/table/event, relation-only queries keep both edge targets instead of
collapsing them by display name.
Querying `supabase-realtime-status` returns implementation-side Realtime status
handling as native `references` edges from the containing method/function to
owner-scoped status nodes; strict native projections keep edge endpoints closed
and strip NanoFlow-only metadata.
Querying `supabase-realtime-remove-channel` returns owner-scoped Realtime
cleanup actions as native `references` edges; strict native projections keep
each edge endpoint closed and code blocks scoped to the concrete call line or
owning method.

Both query paths return a native-shaped graph projection plus NanoFlow-specific
metadata that is often missing from a generic AST graph: TypeScript/JavaScript-family
file/class/method/constructor/property/function/interface/type_alias/constant/
variable/enum/namespace/import/export/parameter symbols including class
expressions, `.d.ts` declarations, `.js` / `.jsx` / `.mjs` / `.cjs` source
files, direct and higher-order wrapped function-valued class fields,
exported object-literal function properties, exported factory-returned object
function properties including middleware/HOF call wrappers, nested named
functions and variable-bound arrow/function-expression functions, local class/interface/type/enum declarations,
type literal members, function-typed type literal properties promoted to method
nodes, interface/type literal call signatures, construct signatures, index
signatures, tuple contract string-literal method names, union object type member
suppression,
nested namespace declarations, explicit
import/export declaration nodes, parameter containment and parameter type edges,
import/export/re-export edges, contains edges, extends/implements edges,
call/return/type-reference/local-variable-type/type-parameter-constraint/
type-parameter-default/new edges, initializer references, JSX component render dependencies, decorator and
decorator-argument edges with unresolved synthetic arguments materialized per
declaring file instead of cross-file same-name fallback, Angular `providedIn`
provider scope targets materialized per injectable declaration file instead of
cross-file same-name fallback,
initializer-reference edges that avoid cross-file same-name fallback while
preserving source-file scoped unresolved value evidence, override edges, native-style `interface-impl`
synthesized calls, scoped filtering for TypeScript built-in utility/global
types, standard-library globals, and local type parameters across nested type
literal / callback / method signature scopes,
`satisfies` / `as` / type assertion project references, `as const`
language-level assertion filtering, component metadata, injected
dependencies, lazy imports, test files, Supabase risk tags, and hard-rule
anchors. Human-readable output uses the same high-level shape, source-block file
budget, and relationship display budget as `codegraph_explore`, including
`### Source Code` blocks with line-numbered verbatim on-disk snippets around
matched symbols and file headers that list the matched `symbol(kind)` entries.
Default Markdown emits those source blocks before the verbose `Related Symbols`
section, so a wide query cannot leave `### Source Code` visible while truncating
away every concrete `#### file` block. Source block headers omit low-information
`file`, `import`, and `export` nodes when concrete symbols are available.
Markdown source blocks, `Not shown above` entries, and relationship groups are
capped by the native repo-size tiers while JSON keeps the complete selected edge
set in the official-shaped `edges` array. The display-enriched `displayEdges`
array is compatibility output for relationship grouping, not the official Edge
schema. Small-repo tiers
suppress the Markdown `Relationships`, `Not shown above`,
complete-source, and explore-budget sections just like native CodeGraph; exact
`metadata.relation`, `metadata.synthesizedBy`, and `metadata.bindingKind`
queries still surface their matching relationship group so relationship-focused
overlay queries remain useful. Default Markdown source-block selection also uses
	CodeGraph's low-value file rule across repo-size tiers: test/spec/helper,
	e2e/cypress/playwright, fixture/mock/stub/snapshot, icon/i18n, and
	story/demo/sample/example/playground files are omitted from `### Source Code`
	when at least two non-low-value source candidates remain, unless the query
	itself asks about tests/specs/verification, e2e/browser tests,
	fixtures/mocks/stubs, `i18n`, `icon` / `icons`, or the concrete low-value
	path.
Filtered files still appear in `Not shown above` when that section is enabled.
Related symbols and JSON nodes are not dropped, so machine consumers keep the
full selected graph. Explicit path/file tokens such as
`vitest.services.config.mts`, `supabase/functions/transcribe/index.ts`, or a
migration filename are treated as strong relevance signals for matches, entry
points, and source-block file ordering; concrete `file` nodes can be returned as
first-class entry points for explicit path queries. They outrank broad
incidental terms in the same query without disabling ordinary symbol search. The
same path signal logic accepts Windows-style backslashes, `file:line[:column]`
suffixes, absolute-path suffix matches, and tokenized file-stem coverage so
natural queries such as `sync service config` still prefer
`sync-service.config.ts` over a generic cleanup service when the file evidence
is stronger. Tokenized file-stem coverage is weighted by matched segment count,
so `vitest services config mts` prefers `vitest.services.config.mts` over the
shorter `vitest.config.mts`. The query-path relevance contract applies to all
machine-facing output modes: default JSON, strict native JSON, strict native Markdown,
and MCP compact queries must keep context-json nodes, `relatedFiles`,
`entryPoints`, and `codeBlocks` ordered by the same segmented file-name relevance.
When relevance ties or only weak metadata hits are available, strict native JSON
`relatedFiles` uses the same query-aware low-value demotion as code blocks:
test/spec/helper, e2e/cypress/playwright, fixture/mock/stub/snapshot,
icon/i18n/generated files plus unrequested `scripts/`, `.github/`, and
`cloudflare/workers-static-assets/` paths move behind clean implementation files
unless the query explicitly names tests, specs, browser tests, fixtures, mocks,
stubs, generated artifacts, resources, `i18n`, `icon` / `icons`, or the
concrete low-value path.
The same low-value path rules apply to the NanoFlow overlay-rendered
`### Relationships` and `### Related Symbols` sections in context packs; if
filtering would remove every relationship, the wrapper leaves the rendered
relationship section empty rather than restoring low-value weak edges.
Once an ordinary
symbol query resolves a concrete file path, the selected graph, `relatedFiles`,
and `codeBlocks` are scoped to that target file set. This keeps generic terms
such as `default`, `client`, or
`policy` from expanding through cross-file `type_of`, `returns`, or `contains`
edges into unrelated source files; exact metadata relation queries still return
closed relationship endpoints according to their relation-specific rules.
The overlay query renderer
tracks the official `getExploreOutputBudget` fields: `<150` TypeScript files use
`maxOutputChars=13000`, `defaultMaxFiles=4`,
`maxSymbolsInFileHeader=5`, `gapThreshold=7`, and
`maxEdgesPerRelationshipKind=4`; `<500` uses `18000/5/6/8/6`;
`<5000` uses `24000/8/10/12/10`; larger workspaces use
`24000/8/15/15/15`. Those same fields drive Markdown truncation, source block
count, source-block header symbol caps, line-window merging, and relationship
display caps so the human-readable output has the same shape as native
`codegraph_explore`. Project-specific meaning is kept in edge metadata such as
`relation: template-url`, `relation: style-url`, `relation: dependency`,
`relation: type-reference`, `relation: parameter-type`,
`relation: initializer-reference`, `relation: jsx-component`,
`relation: decorator`, `relation: override`, `relation: object-function`,
`relation: nested-function`, `relation: local-declaration`,
`relation: type-literal-member`, `relation: type-parameter-constraint`,
`relation: type-parameter-default`, or `relation: new`; official-style
heuristic dispatch bridges use `metadata.synthesizedBy: interface-impl` and
`provenance: heuristic`. Relationship occurrence coordinates such as decorator
locations are emitted as top-level `line` and `column` edge fields, matching the
official `Edge` schema, while project-specific relation labels remain in
`metadata.relation`. TypeScript member,
object-function, nested-function, local-declaration, and
parameter `qualifiedName` values follow the native `Class::member`,
`Object::function`, `Function::nested`, `Function::LocalDeclaration`, and
`Function::parameter` style, and
nodes include native-style location and modifier fields such as `startLine`,
`endLine`, `startColumn`, `endColumn`, `isExported`, `isAsync`, `isStatic`,
`isAbstract`, `visibility`, `decorators`, `typeParameters`, `returnType`, and
top-level `docstring` when they can be derived from the AST. These fields follow
the native CodeGraph node shape rather than NanoFlow-specific `metadata`.
When the same node is enriched by multiple overlay passes, location fields merge
to preserve the full AST declaration range instead of letting decorator or
framework metadata anchors shrink the node to one line.
Every selected graph node emits numeric `startLine`, `endLine`, `startColumn`,
and `endColumn` fields because they are required by the official `Node` schema;
nodes without precise column data are normalized to column `0` instead of
omitting the fields.
`language` is normalized to CodeGraph's official `Language` enum. NanoFlow
overlay anchors for SQL migrations, Markdown agent rules, HTML templates, and
stylesheets use `language: unknown`; their project-specific meaning remains in
`metadata` such as `platform: supabase-migration`, `relation: hard-rule`, or
`relation: template-url` or `relation: style-url`. Formatter projections may
still infer a more specific code-fence language from the file path when
rendering strict native Markdown; the underlying graph node language remains
native-shaped.
`decorators` is emitted as a string array of decorator/annotation names,
`typeParameters` is emitted as a string array of generic parameter names, and
`returnType` is emitted on callable graph nodes from the same normalized return
type used by the native-shaped `returns` edge. `updatedAt` is emitted as a
number on every graph node using the current overlay generation timestamp,
matching the official `Node.updatedAt` schema field. `docstring` comment markers
(`/**`, `/*`, `*/`, leading `//`, and JSDoc line-leading `*`) are stripped with
the same cleanup policy as the official tree-sitter extractor:

To match native CodeGraph's noise boundary, `object-function` nodes are promoted
only from exported object maps or exported factory-returned object maps. Private
object maps remain ordinary `constant` / `variable` nodes.

Call edges also follow native CodeGraph's unresolved-reference boundary. The
overlay records a `calls` edge only after scoped or import-aware resolution has
found a real graph node; it does not fall back to cross-file same-name matching
for calls. It preserves native-style simple receiver names for calls such as
`callTargets.namespacedHelper()`, and it does not create placeholder `variable`
nodes for unresolved member calls such as `items.push()` or `items.some()`.

Initializer references use the same no-cross-file-fallback boundary: same-file,
import alias, namespace import, re-export alias, and CommonJS require alias
resolution still point at real graph nodes, while unresolved value identifiers
are materialized as scoped `variable` evidence in their own source file instead
of being connected to the first same-name symbol in another file.

```text
## Exploration: <query>
Found <n> symbols across <m> files.

### Relationships
**imports:**
- Component -> template.html

### Related Symbols
- src/.../component.ts: Component:12, methodName:42
```

As of the latest fresh overlay audit on this dirty workspace, the sidecar
captures roughly this graph scale. Full TypeScript-family file and node totals
can drift by small amounts as local worktree files and this documentation change;
the stable audit gates are the zero bad-node/bad-edge counts and the semantic
relationship counts below.

- 1,777 JavaScript-family source files, including TypeScript-language and
  JavaScript-language files, local `.d.ts` declarations, and `.js` /
  `.jsx` / `.mjs` / `.cjs` scripts while excluding build outputs.
- 557 classes, 4,698 functions, 1,590 interfaces, 762 type aliases, 1,841
  constants and 72 source variables split using native `constant` and
  `variable` node kinds, 3 enums, 16 enum member nodes, 8 namespaces, 15,709
  imports, 4,147 exports, and 18,976 graph parameter nodes.
- 15,709 explicit `import` nodes and 4,147 explicit `export` nodes in the
  native-shaped projection.
- Parameter containment/type edges, object-function containment edges,
  nested-function containment edges, local-declaration containment edges,
  type-literal-member containment edges, type-parameter constraint/default
  edges, initializer-reference edges, and TSX JSX component render edges use
  only native CodeGraph edge kinds; the specific reason is stored in
  `metadata.relation`.
- Angular declaration and dependency-injection graph summary: `angularComponents=88`,
  `angularDirectives=3`, `angularPipes=1`, `angularInjectables=273`,
  `angularInjectorFiles=605`, `angularInjectorDependencyReferences=1943`, and
  `angularApplicationProviders=1`.
- Angular imports and reactive API graph summary: `standaloneImportEdges=172`,
  `angularInputEdges=193`, `angularOutputEdges=220`, `angularModelEdges=0`,
  `angularQueryEdges=22`, and `angularSignalEdges=490`. The real tree currently
  has no projected Angular model relation; fixture/spec coverage preserves that
  supported zero-count contract.
- Context7 retrieval and source-map graph summary: `context7Documents=72`,
  `context7Categories=17`, `context7CategoryDocEdges=72`,
  `context7RetrievalRoutes=14`, `context7RetrievalPrimaryEdges=14`,
  `context7RetrievalSecondaryEdges=40`, `context7SourceMapRoutes=16`,
  `context7SourceMapDocEdges=21`, and `context7SourceMapSourceEdges=37`.
- 120 dynamic import entries, 117 dynamic import graph edges, and 28 Angular route
  anchors. The current real tree has 3 `angular-route-guard` edges
  (`canActivate` and `canDeactivate`) and 0 `angular-route-resolver` edges;
  resolver parsing is covered by fixtures and excludes ordinary object
  `resolve` properties. It also has 2 `angular-route-redirect` edges, with root
  redirect route nodes named `(root)` and the original empty path preserved in
  metadata. Route-level provider parsing is covered by fixtures and relation
  queries; the current real tree has 0 `angular-route-provider` edges.
- Route, template binding, template declaration usage, signal, input/output/model, provider/import,
  host-directive, host attribute, host binding/listener, Edge Function env, migration table, and migration policy edges are included
  when present. Current Angular template extraction records 3,312 template bindings: 1,368 property, 1,071 event, 319 interpolation, 23 model, 525 control-flow, and 6 structural directive bindings, with 0 template-local
  alias/contextual-variable bindings, 0 pipe-name-as-binding entries, and 0
  `@defer on` trigger-word bindings. The template declaration usage layer adds 75 `template-component` edges, 3 `template-directive` edges in the current
  real tree (the workspace shell slot `@Directive` declarations `app-workspace-overlays`, `app-workspace-sidebar`, and `app-workspace-shell-core` used as elements in `src/workspace-shell.component.html`), and 6 `template-pipe` edges; fixtures cover directive selector lists, `:not(...)` exclusions,
  quoted attribute values containing `.` or `,`, Angular `bind-` attribute
  prefixes, inline-template source line offsets, directive selector parsing, and
  relation query output.
  `hostDirectives` are parsed from class entries and object entries with
  `inputs` / `outputs` alias metadata; the current real tree has 0 host-directive edges because it does not use this Angular metadata yet.
  `host` metadata object entries are parsed into `host-attribute`,
  `host-binding`, and `host-listener` relationships with the static value or
  expression preserved in edge metadata. The current real tree has 6 host-attribute edges, 5 host-binding edges, and 24 host-listener edges.
- 9 Supabase Edge Functions with 37 env-var references after following relative
  helper imports under `supabase/functions`, 25 followed source/helper files
  counted per Edge Function (`14` unique files), 17 recorded source import
  relations, 17 native `edge-function-source` import edges, 9 generated
  `/functions/v1/<name>` route nodes/edges, 31 explicit `req.method` method
  and CORS allowed-method references currently found in the real tree
  (`method-equality=7`, `method-inequality-guard=8`,
  `cors-allowed-methods=16`; covering `OPTIONS` and `POST`), 10
  implementation-side `edge-function-invoke` edges, and 42
  native test-reference edges from Edge Function entry nodes to 18 spec/contract
  file references.
  `env-var` nodes/edges are stable project-semantic counters and preserve
  `metadata.envVar`. Edge Function and migration `risk-tag` nodes/edges are also
  fail-closed coverage counters; their metadata preserves `riskTag` and
  `riskSource=edge-function|migration` so a nonzero prose count cannot hide a
  missing semantic graph relation.
- Supabase Realtime implementation extraction adds 2 native
  `supabase-realtime-channel` nodes/edges and 1 native
  `supabase-realtime-postgres-change` node/edge in the current real tree. The
  Realtime status layer adds 6 native supabase-realtime-status nodes/edges
  across `RealtimeStatusController` and `BlackBoxSyncQueueRealtimeLayer`, with 0
  noisy status sources from overlay scripts, spec helpers, or test setup mocks.
  The Realtime lifecycle layer adds 3 native
  `supabase-realtime-remove-channel` nodes/edges for concrete cleanup paths in
  `RealtimePollingService` and `BlackBoxSyncQueueRealtimeLayer`; the current
  real tree has 2 `supabase-realtime-unsubscribe` and 5
  `supabase-realtime-remove-all-channels` edges.
  Realtime graph summary: 2 supabase-realtime-channel edges, 1 supabase-realtime-postgres-change edges, 6 supabase-realtime-status edges, 3 supabase-realtime-remove-channel edges, 2 supabase-realtime-unsubscribe edges, and 5 supabase-realtime-remove-all-channels edges.
  Realtime node summary: 2 supabase-realtime-channel nodes, 1 supabase-realtime-postgres-change nodes, 6 supabase-realtime-status nodes, 3 supabase-realtime-remove-channel nodes, 2 supabase-realtime-unsubscribe nodes, and 5 supabase-realtime-remove-all-channels nodes.
  Template-derived channel names and `postgres_changes` filters are preserved in
  readable `${...}` form in default JSON metadata, and strict `nativeJson`
  codeBlocks still prioritize the owner method instead of the synthetic
  Realtime endpoint.
- 119 Supabase migrations with risk tags; migration `table`, `policy`,
  `risk-tag`, `test`, `sql-function`, `trigger`, `trigger-function`,
  `migration-index`, `migration-constraint`, `migration-constraint-validation`, `migration-realtime-publication`, `migration-view`, `policy-command`, `policy-type`, `policy-role`, `policy-using`, and
  `policy-with-check`, `privilege-grant`, `privilege-revoke`,
  `privilege-object`, and `privilege-role` edges
  use migration `file` nodes as their source
  (`250` table edges, `118` policy edges, `155` risk-tag edges, `121`
  sql-function edges backed by 121 native `function` nodes, `118` policy nodes,
  `63` policy-command edges, `63` policy-type edges, `63` policy-role edges,
  `52` policy-using edges, `23` policy-with-check edges, `40` trigger edges,
  `40` trigger-function
  edges, `64` migration-index edges, `59` migration-constraint edges
  (`23` foreign-key, `15` primary-key, `18` check, and `3` unique constraints;
  `53` sourced from `ALTER TABLE` and `6` from `CREATE TABLE`), `6`
  migration-constraint-validation edges, `280` privilege-grant edges, `378` privilege-revoke edges, `472`
  privilege-object edges, `650` privilege-role edges, `65` migration test
  edges, `0` migration variable-sourced edges). The
  structured `policyDetails` array currently contains 109 parsed policy detail
  records, `functionDetails` contains 151 parsed SQL function definitions,
  `triggerDetails` contains 40 parsed SQL trigger definitions, and
  `indexDetails` contains 90 parsed SQL index definitions, and
  `constraintDetails` contains 63 parsed SQL constraints.
  `constraintValidationDetails` contains 8 parsed SQL constraint validation
  statements and reuses the corresponding constraint nodes instead of creating
  validation-only graph nodes. The structured
  `privilegeDetails` array contains 662 parsed PostgreSQL `GRANT` / `REVOKE`
  statements, backed by 480 privilege nodes, 472 privilege-object nodes, and
  650 privilege-role nodes.
  Supabase structured detail summary: 42 edgeFunctionTests, 151 migrationFunctionDetails, 40 migrationTriggers, 109 migrationRlsDetails, 173 migrationTests, and 109 policyDetails.
  The Supabase migration node summary is 151 SQL function nodes, 151 SQL function edges, 40 trigger edges, 40 trigger-function edges, 90 migration-index nodes, 90 migration-index edges, 63 migration-constraint nodes, 63 migration-constraint edges, 0 migration-constraint-validation nodes, 8 migration-constraint-validation edges, and 109 migration-rls edges.
  The Supabase policy/privilege node summary is 179 policy nodes, 108 policy-command edges, 108 policy-type edges, 108 policy-role edges, 86 policy-using edges, 47 policy-with-check edges, 706 privilege nodes, 684 privilege-object nodes, 425 privilege-grant edges, 720 privilege-revoke edges, 684 privilege-object edges, 1055 privilege-role nodes, and 1055 privilege-role edges.
  The Supabase migration test summary is 173 migration tests and 173 migration test edges.
  The migration graph summary is 151 SQL function edges, 40 trigger-function edges, 90 migration-index edges, 63 migration-constraint edges, 8 migration-constraint-validation edges, and 109 migration-rls edges. The policy and privilege graph summary
  is 108 policy-command edges, 108 policy-type edges, 108 policy-role edges, 86 policy-using edges, 47 policy-with-check edges, 425 privilege-grant edges, 720 privilege-revoke edges, 684 privilege-object edges, and 1055 privilege-role edges.
  Statement-level `ALTER PUBLICATION <name> ADD|DROP|SET TABLE` entries are
  split on top-level commas into per-table `migration-realtime-publication`
  facts that link the Realtime publication to the same tables the TypeScript
  `postgres_changes` subscriptions poll, and statement-level
  `CREATE [OR REPLACE] [MATERIALIZED] VIEW` headers become `migration-view`
  facts with materialized/orReplace markers; dollar-quoted function bodies are
  never parsed as publication or view statements.
  The migration publication/view summary is 4 migration-realtime-publication edges backed by 4 publication nodes from 4 parsed publication details, and 4 migration-view edges backed by 4 view nodes from 4 parsed view details.
- 6 AGENTS hard-rule anchors, all with body text stored on hard-rule metadata
  for body-only terms such as `断网可写`; 19 scoped hard-rule keyword nodes and
  19 hard-rule keyword reference edges expose high-signal constraints such as
  `crypto.randomUUID()`, `@defer`, `visibility:hidden`, `StoreService`, and
  `content`. All 19 hard-rule keyword edges carry
  `keywordMapping: hard-rule-keyword` and `matchedNeedle`. The implementation
  evidence layer adds 76 `hard-rule-implementation` native `references` edges
  from the `crypto.randomUUID()` AGENTS keyword to 63 callable symbols that
  contain AST-proven calls.
  The AGENTS hard-rule node/provenance summary is 19 hard-rule keyword nodes, 19 hard-rule keyword edges, 19 hard-rule keyword mapping edges, 76 hard-rule implementation edges, and 63 hard-rule implementation targets.
  The AGENTS hard-rule graph summary is 19 hard-rule keyword edges and 76 hard-rule implementation edges. The AGENTS sync-rule graph summary is 19 sync-rule anchors, 20 sync-body keyword edges, 5 sync-config keyword edges, and 14 config-source edges.
- 19 AGENTS-derived sync-rule anchors, including 14 `*_CONFIG.*` baseline rows
  from the §9 key configuration table, with 25 explicit AGENTS keyword nodes and
  25 keyword reference edges for synchronization/config terms such as
  `RetryQueue`, `LWW`, `IndexedDB`, `updated_at`, `last_sync_time`,
  `SYNC_CONFIG.DEBOUNCE_DELAY`, `TIMEOUT_CONFIG.QUICK`, and
  `FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY`. The sync keyword edge provenance
  splits into 20 `sync-body-keyword` edges and 5 `sync-config-keyword` edges.
  The config baseline source layer adds 87 native `config-property` nodes, 87
  `config-property` containment edges, and 14 `config-source` references from
  AGENTS rows to exact config properties across `sync.config.ts`,
  `timeout.config.ts`, `layout.config.ts`, `auth.config.ts`, and
  `focus.config.ts`; all 14 currently resolve to property nodes, 37 nested
  properties keep parent-property `contains` edges, and the 5 `SYNC_CONFIG.*`
  rows also keep the compatibility `sync-config-source` relation to the
  `SYNC_CONFIG` constant while exact `sync-config-source` queries bring back the
  corresponding property provenance for strict native codeBlocks.
  The AGENTS sync-rule node/provenance summary is 19 sync-rule anchors, 14 config-rule anchors, 19 sync-rule nodes, 25 sync-rule keyword nodes, 25 sync-rule keyword edges, 20 sync-body keyword edges, 5 sync-config keyword edges, 88 config-property nodes, 88 config-property edges, 37 config-property parent edges, 14 config-source edges, 14 config-source property edges, and 5 sync-config-source edges.
- The Supabase select-field layer adds 212 native `supabase-select-field` property nodes, 393 `supabase-select-field` edges, 285 method/function `references` edges from `.select(...)` call sites to selected fields, 104 inline select field nodes, 105 inline select provenance edges, and 6 `sync-required-field` edges from the AGENTS `content` hard-rule keyword to tasks field nodes. The incremental-predicate layer adds 1 `supabase-incremental-predicate` nodes, 1 method/function predicate `references` edges, and 2 `sync-required-predicate` edges from AGENTS keywords to query predicates. The Storage bucket layer adds 10 `supabase-storage-bucket` nodes and 10 native `references` edges
  for the real `attachments` bucket across client calls and `storage.objects`
  policies.
  Select and storage node summary: 212 supabase-select-field nodes, 104 inline select field nodes, 1 supabase-incremental-predicate nodes, and 10 supabase-storage-bucket nodes.
  Select and storage graph summary: 393 supabase-select-field edges, 285 supabase-select-field reference edges, 105 inline select provenance edges, 6 sync-required-field edges, 1 supabase-incremental-predicate edges, 2 sync-required-predicate edges, and 10 supabase-storage-bucket edges.
- The Supabase RPC/table-write layer adds 22 `supabase-rpc` nodes and 34 native
  `references` edges for static `rpc(...)` calls, plus 19
  `supabase-table-write` nodes and 35 native `references` edges for static
  `.from(...).insert/update/upsert/delete` write chains. The real tree currently
  contains table-write operations for `insert`, `update`, and `upsert`; fixture
  coverage locks `delete` parsing and query output.
  The operation node summary is 22 Supabase RPC nodes and 34 Supabase RPC edges; 19 Supabase table-write nodes and 35 Supabase table-write edges.
  The operation graph summary is 34 Supabase RPC edges and 35 Supabase table-write edges.
- The Supabase Edge Function header layer adds 46 `edge-function-header`
  native-shaped `variable` nodes and 46 native `references` edges across
  request auth, CORS, content-length, webhook-signature, and proxy-IP headers.
- A synced diagnostic run reported 146,739 graph nodes and 278,583 graph edges in the native-shaped projection. `codegraph:overlay:sync` refreshes this
  top-level diagnostic summary, while the validator only requires the summary to
  be present because this document and `AGENTS.md` both participate in the graph
  and exact totals would otherwise oscillate as self-referential helper rows.
  `badNodes=0`, `badEdges=0`, `callPlaceholders=0`,
  `migrationVarSources=0`, and `noisyMigrationTables=0`.
- 14,719 initializer-reference edges, 7,057 parameter-type edges, 27
  object-function containment edges, 143 nested-function containment edges, 6
  local-declaration containment edges, 214 local-variable-type edges, 741
  type-literal-member containment edges, 8,317 interface-member containment
  edges, 49 type-parameter-constraint edges, and 7 type-parameter-default
  edges.
- 148 CommonJS require edges, 74 CommonJS export edges, 81 `implements` edges,
  1,056 `decorates` edges, 125 `decorator-argument` edges, and 8 `overrides`
  edges; all emitted edge kinds are from CodeGraph's native edge-kind set.
- 797 total test-reference edges; all 797 carry provenance in
  `metadata.testMapping`. Angular contributes 71 `same-basename` edges and
  511 `class-reference` edges. Supabase contributes 40 `path-reference` edges,
  2 `route-reference` edge, 0 `invoke-reference` edges, and 173
  `filename-reference` edges. Default JSON `relationshipGroups` and Markdown
  render `testMapping`; 5,588 template/path/route/filename-derived edges also render
  `matchedNeedle`, while strict native JSON strips it with the rest of NanoFlow
  metadata.
- Angular external resource graph summary: 19 template-url edges and 10 style-url edges.
- Latest overlay audit: 0 bad nodes, 0 bad edges, 0 unresolved call placeholder
  nodes, 0 migration variable-sourced semantic edges, and 0 noisy migration
  table anchors from `IF`, `ONLY`, `SCHEMA`, `CONFLICT`, `FUNCTION`, `SET`, or
  `ON`; all 5 hard rules have body text in both `agentRules.hardRules` and the
  hard-rule graph node metadata, all 14 hard-rule keyword anchors, all 58
  hard-rule implementation evidence edges, and all 19 sync-rule anchors have
  graph nodes, and all 472 parsed privilege statements
  are represented through migration
  file-sourced native `references` edges. Unresolved call references stay absent
  from the graph until resolver evidence can connect them to a real symbol.
- Latest full regression run:
  `src/tests/scripts/codegraph-nanoflow-overlay.spec.ts` passed with 214 tests.

## MCP Startup

For this repository, the active project config `D:\Code\dde\.codex\config.toml`
points the `codegraph` MCP server at:

```text
scripts/codegraph-nanoflow-mcp-stdio.cjs
```

That wrapper injects `nanoflow_context_pack` plus `nanoflow_overlay_query` before
starting the real CodeGraph MCP server. It can run either the pinned npm package
or a local build. Startup background refresh is disabled by default to avoid
competing with latency-sensitive MCP queries; set
`NANOFLOW_CODEGRAPH_REFRESH_ON_STARTUP=1` only when you explicitly want a wrapper
process to publish an immutable generation and advance the CURRENT selector in the background.

Codex-side adapter tooling resolves the active MCP configuration in this order:
explicit `NANOFLOW_CODEGRAPH_CODEX_CONFIG`, repository `.codex/config.toml`,
then user `C:\Users\MI\.codex\config.toml`. A repository config that declares
`[mcp_servers.codegraph]` always overrides the user server. If its `--path` does
not match the requested root, tooling reports `appliesToRoot=false` as an active
project contract error instead of falling back to the user config.
`codegraph:adapter:context`, `codegraph:mcp:smoke`, and
`codegraph:adapter:doctor` verify the selected server against the requested root.
They do not read or fall back to `.vscode/mcp.json`. If an explicit
`NANOFLOW_CODEGRAPH_CODEX_CONFIG` path is missing, context and smoke fail fast
with `Codex MCP config not found`; doctor reports `mcpConfig: source=codex` and
marks the missing Codex config checks as failed instead of diagnosing VS Code
workspace files.
For current Codex usage, `.vscode/mcp.json` is not the active CodeGraph MCP
configuration and must not be edited, repaired, or diagnosed as the fix target
for Codex MCP failures. Active wrapper, CodeGraph target, and MCP environment
changes belong in the doctor-resolved active config, currently
`D:\Code\dde\.codex\config.toml`; the user config is a fallback only when no
project server is declared. An explicit temporary Codex config selected through
`NANOFLOW_CODEGRAPH_CODEX_CONFIG` remains the highest-priority override. Verify
with `codegraph:adapter:doctor`, `codegraph:mcp:smoke`, and
`codegraph:mcp:log:guard`.
`NANOFLOW_CODEGRAPH_CODEX_CONFIG=<path-to-config.toml>` can point those tools at
a temporary Codex config for smoke tests or upgrade probes without touching the
real global file.
After `codegraph:adapter:doctor --repair-config` changes the active file, disk
contract success is not runtime success. Until a wrapper start matching the
repaired target, env, and current script is observed, the doctor report uses
`pendingHostRestart=true`, `runtimeOk=false`, `ok=false`, and a nonzero exit so
automation cannot mistake a required Codex MCP host restart for recovery.

## Upstream Version And De-Duplication Boundary

The upstream CodeGraph fixed version for NanoFlow is
`@colbymchenry/codegraph@1.6.2`. Upgrade probes must run through
`--codegraph-target @colbymchenry/codegraph@<new-version>` first, using
`npm run codegraph:adapter:context` and `node scripts/smoke-codegraph-mcp-wrapper.cjs`,
before changing the pinned target in the doctor-resolved active Codex config,
`scripts/codegraph-adapter-context.cjs`, `scripts/smoke-codegraph-mcp-wrapper.cjs`,
tests, and this document.

The upstream [`v1.5.0` release](https://github.com/colbymchenry/codegraph/releases/tag/v1.5.0)
was promoted after the official binary reported `1.5.0`,
an explicit-target NanoFlow context pack succeeded, and a three-round wrapper
smoke completed with zero transport failures or overlay timeouts. Upstream
`1.5.0` moves parsing for supported languages into the native Rust kernel while
preserving graph parity and automatically falling back for unsupported platforms
or individual parse failures. NanoFlow does not duplicate that kernel, watcher,
generic ranking, or resolver work; those remain upstream responsibilities.

The project adaptation itself lives in `D:\Code\dde`: its wrapper, overlay,
queries, doctor, gate, tests, docs, and project Codex config are repository-owned.
`D:\Code\tools\codegraph` is only an optional upstream source clone/fork used
when changing CodeGraph itself. It is not consulted by the default package-mode
runtime and must not contain NanoFlow's project adaptation contract.

The adapter delegates generic TypeScript symbol/import/export/call/impact
discovery to native CodeGraph. native Markdown/JSON formatter section order,
strict native output projection, and context exploration source ordering are
also upstream delegation boundaries. The adapter must not reimplement native auto-sync, indexing, generic search ranking, or callers/callees/impact. NanoFlow overlay owns only project-specific semantics, output-quality policy, Codex host reliability, and repository hard-rule anchors. Current duplication hotspots such
as `collectTypeScript()` and `buildNativeGraph()` are tolerated only while they
attach NanoFlow `metadata.relation` edges to native-shaped endpoints; when
upstream exposes an extension point for that attachment, those generic
TypeScript graph-building paths become removal candidates rather than permanent
parallel CodeGraph behavior.

The machine-readable source for this audit is
`docs/codegraph-nanoflow-dedup-contract.json`. `npm run
codegraph:overlay:docs:validate` validates that every hotspot in that manifest
still points at a real source function, remains `temporary-allowed`, names
native CodeGraph as the delegated upstream owner, records the forbidden generic
scope, and keeps `codegraph:overlay:docs:validate` plus
`codegraph:adapter:gate` as its verification gates.

De-duplication hotspot audit backlog:

| Hotspot | Current status | delegated upstream owner | removal trigger | verification gate |
| --- | --- | --- | --- | --- |
| `collectTypeScript()` | temporary allowed only to attach NanoFlow metadata.relation for Angular, Supabase, tests, and hard-rule overlay edges after native CodeGraph locates generic TypeScript/import/export/reference/call/impact shape; standard-library declaration readers are covered children used only to suppress unresolved platform noise | native CodeGraph owns generic TypeScript symbol/import/export/reference/call/impact discovery | upstream extension point or native projection hook can carry NanoFlow relation metadata without rebuilding generic TypeScript graph shape | `codegraph:overlay:docs:validate` plus `codegraph:adapter:gate` |
| `buildNativeGraph()` | temporary allowed only to preserve native-shaped endpoint fields while projecting NanoFlow-specific relations into strict native JSON/Markdown | native CodeGraph owns node schema, edge schema, indexing, auto-sync, search ranking, callers/callees, and impact traversal | upstream formatter/projection hook accepts NanoFlow relation metadata and strict source-block policy without a parallel native graph projection | `codegraph:overlay:docs:validate` plus `codegraph:adapter:gate` |
| `buildImportAliasIndex()`, `buildExportTargetIndex()`, `resolveReferenceNodeId()` | temporary allowed only to close NanoFlow project-semantic relation endpoints across same-file aliases, imports, re-exports, default exports, namespace imports, and CommonJS require aliases | native CodeGraph owns generic import/export/reference resolution | upstream resolved endpoint API or native projection hook exposes import/export alias closure that NanoFlow can annotate with `metadata.relation` | `codegraph:overlay:docs:validate` plus `codegraph:adapter:gate` |
| `addTypeScriptCallableEdges()` | temporary allowed only while Supabase select/rpc/storage/table-write/incremental predicate edges share traversal with ordinary TypeScript callable discovery | native CodeGraph owns generic call/return/new/reference graph behavior | Supabase-specific relation emission is split from generic `calls`, `returns`, and `instantiates`, or native call graph endpoints can be annotated without local traversal | `codegraph:overlay:docs:validate` plus `codegraph:adapter:gate` |
| `collectAndroid()`, `readAndroidKotlinFileSymbols()`, `readAndroidKotlinMethodCalls()`, `resolveAndroidKotlinCallTarget()`, `resolveAndroidKotlinTypeTarget()`, `addAndroidKotlinTypeReferenceEdges()`, `addAndroidKotlinOverrideEdges()`, `addAndroidKotlinAnnotationEdges()` | Android/Kotlin duplicate hotspots; temporary allowed only to attach NanoFlow Android Manifest/widget/resource/project semantics and `metadata.relation` to native-shaped Kotlin/XML endpoints | native CodeGraph owns generic Kotlin symbol/import/call/type/decorator/override discovery, auto-sync, indexing, generic search ranking, callers/callees, and impact traversal | upstream extension point or native projection hook can carry NanoFlow Android relation metadata and source-evidence policy without rebuilding generic Kotlin/XML graph shape | `codegraph:overlay:docs:validate` plus `codegraph:adapter:gate` |
| `queryOverlay()`, `scoreCandidate()`, `selectGraphResults()` | query/ranking duplicate hotspots; temporary allowed for exact NanoFlow `metadata.relation` filtering, project-semantic boosts, and overlay-only issue/AGENTS/Context7 routing, not for generic search ranking | native CodeGraph owns generic query parsing, candidate ranking, callers/callees, and impact result selection | native search/ranking exposes project relation filters or post-filter hooks so NanoFlow keeps only relation-exact filtering and semantic boosts | `codegraph:overlay:docs:validate` plus `codegraph:adapter:gate` |
| `toNativeJsonFormatterResponse()` | strict-native JSON formatter duplicate hotspot; temporary allowed to preserve upstream field names, falsy/null values, source columns, closed edge endpoints, and relation source evidence while stripping NanoFlow extension fields | native CodeGraph owns the native JSON schema and formatter contract | native formatter accepts NanoFlow relation metadata plus source-evidence policy and emits strict native JSON directly | `codegraph:overlay:docs:validate` plus `codegraph:adapter:gate` |
| `formatStrictNativeMarkdown()` | strict-native formatter duplicate hotspot; temporary allowed to render NanoFlow relation source evidence in native Markdown section order while stripping extension fields, and must not use `formatNativeMarkdown()` or `formatNanoFlowAugmentedMarkdown()` as its source symbol | native CodeGraph owns native Markdown section order, source block framing, related symbols, and relationship display | native formatter accepts NanoFlow relation metadata plus source-evidence policy and emits strict native Markdown directly | `codegraph:overlay:docs:validate` plus `codegraph:adapter:gate` |
| `formatNativeMarkdown()` | augmented/default Markdown projection hotspot; temporary allowed to delegate to `formatNanoFlowAugmentedMarkdown()` for NanoFlow coverage and relation evidence, but not allowed to masquerade as the strict-native formatter | native CodeGraph owns generic native Markdown formatter sections; NanoFlow owns only augmented relation evidence and coverage projection | native formatter accepts NanoFlow relation metadata plus source-evidence policy, leaving only the augmented NanoFlow-specific projection in the adapter | `codegraph:overlay:docs:validate` plus `codegraph:adapter:gate` |
| `contextPackSourceRankingQueryFor()`, `sanitizeContextPackBaseMarkdownSections()` | source-ordering duplicate hotspot entries; temporary allowed for output-quality policy, low-value source suppression, sourceSelection diagnostics, base-section pollution filtering, and localized query-token aliases that drive only those NanoFlow policies | native CodeGraph owns generic query parsing, search ranking, and base exploration source ordering | native context pack exposes source/relationship ordering hooks or stops returning avoidable build/cache/generated/tooling pollution for NanoFlow queries | `codegraph:overlay:docs:validate` plus `codegraph:adapter:gate` |

### Android import default soak and rollback

The Android import resolver precedence is explicit
`--android-import-source <local|native>`, then
`NANOFLOW_CODEGRAPH_ANDROID_IMPORT_SOURCE_DEFAULT`, then the built-in `local`
default. B2a does not flip that built-in default and does not remove the local
parser. The query command accepts the same explicit flag and forwards it only
when a missing, incomplete, or stale overlay must be regenerated; without the
flag, the generator inherits the rollout environment. Selecting `native` is
fail-closed: native database, freshness, identity, or completeness failures are
returned to the caller and never caught to retry with `local`.

Use the environment variable for a reversible native soak. An immediate
rollback is either an explicit `--android-import-source local` on generation or
query regeneration, or restoring/unsetting the environment value so the
built-in `local` default applies. Explicit CLI selection must override even a
conflicting rollout environment.

A future default flip remains blocked until all of the following hold for the
three-import fixture and a representative workspace sample:

- normalized overlay bytes match for built-in local, explicit local,
  environment-selected native, and explicit native runs;
- missing/stale query regeneration observes environment-selected native and an
  explicit local rollback succeeds without changing query output;
- native failures remain fail-closed and the local rollback remains available;
- across at least five warm `--stdout` runs per source, native median elapsed
  time is no more than `1.25x` local median or one second slower, whichever
  permits the larger bound.

Stop the soak on any output mismatch, missing/stale native database failure,
rollback failure, or performance-bound breach. Parser deletion and the built-in
default flip are separate later atoms and must not be combined with this
resolver/soak contract.

The structured manifest records query/formatter and context-pack duplicate
boundaries with `duplicateBoundaryRole`, `outputSurface`, and
`extensionFieldPolicy`. These fields separate strict native projections from
NanoFlow-augmented output and make the adapter contract machine-checkable instead
of prose-only. The docs validator scans query/ranking/strict-native
formatter/source-block helpers in `scripts/query-codegraph-nanoflow-overlay.mjs`
and context-pack source-ordering/filter helpers in
`scripts/codegraph-nanoflow-mcp-stdio.cjs`; any discovered helper must appear in
a hotspot `sourceSymbols` or `coveredChildSymbols` list. A validation failure
there means the adapter grew a new generic-looking search, ranking, formatting,
or source-ordering surface without an explicit upstream-delegation boundary.
Fix it by either delegating the behavior back to native CodeGraph or registering
the helper under the narrow NanoFlow-owned hotspot with its removal trigger and
verification gates.

The active Codex config runs the repository wrapper directly and keeps the
CodeGraph target pinned in `D:\Code\dde\.codex\config.toml`, which overrides
the user-level `C:\Users\MI\.codex\config.toml` for this repository; it does
not use `.vscode/mcp.json` as a Codex repair source. The current config sets
`CODEGRAPH_NO_DAEMON=0`, `CODEGRAPH_NO_WATCH=0`,
`CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS=300000`,
`CODEGRAPH_DAEMON_MAX_IDLE_MS=1800000`,
`NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS=30000`, and
`NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE=0`. The live Codex path respects
that upstream shared-daemon contract: all MCP wrappers proxy to one CodeGraph
daemon, one `MCPEngine`, one SQLite writer, and one watcher. The short-lived
`codegraph:adapter:context` fallback intentionally overrides this with
`CODEGRAPH_NO_DAEMON=1` and `CODEGRAPH_NO_WATCH=1`, so it cannot add another
long-lived watcher while repairing a broken host session. The wrapper supervises the
base CodeGraph child process: if that child exits while the host stdin is still
open, the wrapper records `child.restart.request` and `child.restart`, starts a
fresh child, replays `initialize` / `notifications/initialized` to it, and
suppresses the internal replay response so the host MCP transport remains open.
Child exit and restart-backoff logs include `childExitCodeHex`,
`childExitClass`, `childExitName`, and `childUptimeMs`; `log:guard` also derives
those fields for older raw-code history and aggregates backoff by exit
class/name. This is the first root-cause split for future `Transport closed`
reports: `windows-native-crash`, `nonzero-exit`, `signal`, and `zero-exit`
should be handled differently from overlay query timeouts or stale wrapper
state.
If a stale Codex host still injects `CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS=0` or
`CODEGRAPH_DAEMON_MAX_IDLE_MS=0`, the wrapper now normalizes those non-positive
values to `300000` and `1800000` before spawning the child. It records
`wrapper.env.normalized` with received/effective values, so the repair is both
self-protecting and auditable instead of silently forwarding a zero-lifetime
daemon contract.

The shared JSONL diagnostic log is bounded by
`NANOFLOW_CODEGRAPH_MCP_LOG_MAX_BYTES`, defaulting to 16 MiB. The wrapper keeps
one bounded `.1` archive, serializes writes through a short cross-process lock,
and annotates the first post-rotation event with `diagnosticLogRotation`.
Oversized single events are compacted to identity/failure metadata rather than
allowing one response to break the log budget.
Long request queries are bounded before JSONL serialization: `query` preserves
a 512-character head/tail preview, while `queryChars`, `queryBytes`, and
`queryTruncated` preserve size and truncation evidence. Request history and
`runtime.activeRequests` use the same projection, so a burst of large requests
cannot multiply full query bodies across synchronous diagnostics and delay the
`child.stdin.backpressure` event that should pause client input.
Every `wrapper.start` and `child.spawn` entry records `runtimeTopology.mode`,
`runtimeTopology.watcherOwnership`, `runtimeTopology.fileLockContentionRisk`,
`runtimeTopology.daemonDisabled`, `runtimeTopology.watchDisabled`, and the
effective daemon idle values. Healthy live Codex evidence is
`shared-daemon-proxy` / `shared-daemon-single-watcher` / `single-writer`.
`analyze-codegraph-mcp-log.cjs` preserves these fields in `currentWrapper` and
`activeWrappers`, including `activeWrappers.runtimeTopologyModes`,
`activeWrappers.directWatcherContentionRisk`, and
`activeWrappers.sharedDaemonProxyCount`. `codegraph:adapter:doctor` reports
`currentWrapperRuntimeTopology`, `currentContextWrapperRuntimeTopology`, and
`activeDirectWatcherRuns`; `host-mcp:active-direct-watchers` fails before lock
contention reaches CodeGraph's permanent auto-sync degradation threshold.
Startup topology is not sufficient evidence after a daemon loss. In upstream
CodeGraph 1.5.0, `src/mcp/proxy.ts` sets `daemonStatus='failed'` when the shared
socket closes, permanently routes later requests through `handleLocally()`, and
creates an in-process `MCPEngine`; initialization of that engine may then print
`File watcher active`. With many long-lived Codex wrappers, one daemon loss can
therefore turn one shared watcher into many fallback watchers even though every
`wrapper.start` still says `shared-daemon-proxy`.

The repository wrapper now treats those upstream stderr messages as runtime
topology transitions. `Shared daemon connection lost` records
`child.runtime-topology.transition` to `in-process-fallback`; a coalesced or
later `File watcher active` records `in-process-fallback-watcher` with
`per-wrapper-fallback-watcher` and `multi-wrapper-writers`. Recovery is enabled
by default. It waits for an idle request boundary, logs
`child.shared-daemon-fallback.recovery.request` and any `recovery.deferred`
events, then logs `recovery.restart`, replaces only the base child, replays the
MCP session, and records `child.restart(reason=shared-daemon-fallback)` plus
`child.runtime-topology.reset`. Defaults are a 250 ms initial delay, 250 ms
defer interval, and 30000 ms maximum wait; diagnostic runs may override them
with `NANOFLOW_CODEGRAPH_SHARED_DAEMON_FALLBACK_RECOVERY`,
`NANOFLOW_CODEGRAPH_SHARED_DAEMON_FALLBACK_RECOVERY_DELAY_MS`,
`NANOFLOW_CODEGRAPH_SHARED_DAEMON_FALLBACK_RECOVERY_DEFER_MS`, and
`NANOFLOW_CODEGRAPH_SHARED_DAEMON_FALLBACK_RECOVERY_MAX_WAIT_MS`.

The analyzer applies the latest runtime transition to each active run and
reports `activeWrappers.inProcessFallbackCount`,
`activeWrappers.inProcessFallbackWatcherCount`, the affected run lists, and a
`sharedDaemonFallback` event summary. Doctor reports
`activeSharedDaemonFallbackRuns` and `activeInProcessFallbackWatcherRuns`; its
new topology checks fail before a writer-lock retry budget is exhausted. When
the wrapper intentionally kills the replaced child, that old process logs
`child.exit(currentChild=false)`. The analyzer excludes this stale cleanup exit
from critical transport failures so active requests on the new child cannot be
misattributed to the old PID.
Doctor exposes a safe stale-wrapper cleanup entry for old Codex-host processes
that remain alive after their task is idle:

```powershell
node scripts/codegraph-adapter-doctor.cjs --cleanup-stale-wrappers
node scripts/codegraph-adapter-doctor.cjs --cleanup-stale-wrappers --apply-cleanup --cleanup-run-id <runId>
```

The first command is always a dry run. A candidate must have concrete stale
script/env/target or auto-sync-disabled evidence, no active request/queue work,
and exceed the idle guard. Apply mode re-reads the operating-system process
list, revalidates PID start time, wrapper command line, and CodeGraph target,
then terminates only that wrapper process tree; it never targets the Codex
parent. A complete app-server restart remains the correct way to replace all
healthy-but-old task wrappers at once.
Auto-sync warning extraction from MCP response content is banner-anchored: the
first non-empty response line must be the CodeGraph auto-sync-disabled/index-
frozen banner, with optional Markdown quote, emphasis, or warning-marker
prefixes. Matching text inside returned source code, test fixtures, or later
diagnostic tails is not runtime failure evidence. `child.stderr` remains the
broader diagnostic channel because upstream warnings can be mixed with process
prefixes there. The analyzer and doctor revalidate stored `responseWarnings`
against this rule so historical false-positive log entries do not keep a live
host marked index-frozen after the wrapper is repaired.
If a host reports `Transport closed` immediately after a wrapper script change,
first distinguish stale-wrapper host/session state from a real crash with
`codegraph:adapter:doctor`, `codegraph:mcp:log:guard`, or fresh
`codegraph:mcp:smoke` evidence. If the current host MCP session is stale,
broken, or unavailable and an agent still needs repository facts in the same
turn, the fallback is adapter-first: run
`npm run codegraph:adapter:context -- --query "<search>"` to start a fresh
NanoFlow wrapper process and call `nanoflow_context_pack` plus
`nanoflow_overlay_query`; for focused relations run
`npm run codegraph:overlay:query -- --query "<symbol-or-relation>" --skip-refresh`.
`codegraph:adapter:context` gives the fresh wrapper a smaller internal
`NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS` /
`NANOFLOW_CODEGRAPH_OVERLAY_QUERY_TIMEOUT_MS` budget than the outer CLI request
timeout. This guarantees base `codegraph_explore` hangs are surfaced as
wrapper-owned `base-codegraph-timeout` diagnostics and `nanoflow.context.timeout`
log entries before the adapter CLI itself times out. JSON output includes both
`timeoutMs` and `wrapperRequestTimeoutMs` so operators can verify that separation.
The adapter CLI also forwards `--max-files <n>` into `nanoflow_context_pack`
so broad source-heavy queries can use the same native CodeGraph source-budget
control instead of relying on terminal or agent output truncation. If the first
context-pack attempt returns wrapper-owned `base-codegraph-timeout`, the CLI
automatically retries once with `maxFiles=1` before failing. JSON output records
`maxFiles` and `diagnostics.contextAttempts[]`, including each attempt's
`maxFiles`, `isError`, `mcpIsError`, `partial`, `failureClass`, and byte count.
Use those fields to tell apart three cases: base CodeGraph timeout before any
useful source, a successful smaller context pack after retry, and a partial
context pack where base CodeGraph returned native exploration/source but the
combined NanoFlow overlay section timed out. In that partial case the adapter
CLI exits successfully because repository context is available, while
`mcpIsError=true`, `partial=true`, and `failureClass=overlay-timeout` preserve
the overlay failure evidence for follow-up `codegraph:overlay:query --skip-refresh`.
When skip-refresh detects stale source, direct and context-pack MCP responses
return `isError=true`, exact marker content, and
`_meta.nanoflowFailureClass=overlay-stale-skip-refresh`. The adapter accepts
that exact declared class, preserves it in direct and context diagnostics, and
forces `summary.ok=false` if either path observes it. This does not change
malformed, oversized, timeout, transport, or partial-native recovery precedence.
For screenshot-level truncation or very wide queries, first
retry `npm run codegraph:adapter:context -- --query "<same search>" --max-files 1 --json`;
only then fall through to `codegraph:overlay:query --skip-refresh` or native
CodeGraph CLI location plus targeted disk reads.
Only when those NanoFlow adapter fallbacks also fail should the agent use
`npx -y @colbymchenry/codegraph@1.6.2 ...` as a final native CodeGraph CLI
degradation, and that native result is only a locator until the overlay semantic
layer is restored or explicitly reported unavailable.

If the agent runtime or tool panel does not expose `mcp__codegraph.*`,
`nanoflow_context_pack`, or native CodeGraph tools, classify the first failure
boundary as host tool discovery, not wrapper transport. A tool-discovery miss
can happen before the wrapper receives any request, so
`.codegraph/nanoflow-mcp-wrapper.log` may stay clean or show only healthy
fresh-wrapper evidence. State the unavailability once, then run
`npm run codegraph:adapter:context -- --query "<same search>" --json`. After
adapter fallback succeeds, run `npm run codegraph:adapter:doctor -- --explain`.
For Codex sessions, the doctor reports `mcpConfig: source=codex` and resolves
the active config in precedence order: explicit
`NANOFLOW_CODEGRAPH_CODEX_CONFIG`, `D:\Code\dde\.codex\config.toml`, then
`C:\Users\MI\.codex\config.toml`. Its `mcpConfig` report includes
`codegraphServerConfigured`, `wrapperScriptExists`, `codegraphTarget`, and
`runtimeToolDiscoveryVisible`. `runtimeToolDiscoveryVisible` is intentionally
`unknown-host-state` because the doctor cannot inspect Codex's current tool
registry. If `mcpConfig` is valid, fresh adapter fallback succeeds, and log
guard or smoke evidence shows matching-disk wrapper behavior, root cause is the
host/session tool registry not injecting CodeGraph tools. Restart the MCP
host/session and continue using adapter CLI fallback until the MCP tools are
visible again.

Default package mode:

```json
"${workspaceFolder}/scripts/codegraph-nanoflow-mcp-stdio.cjs",
"@colbymchenry/codegraph@1.6.2",
"serve",
"--mcp",
"--path",
"${workspaceFolder}"
```

Local source mode after building `D:\Code\tools\codegraph`:

```json
"${workspaceFolder}/scripts/codegraph-nanoflow-mcp-stdio.cjs",
"D:/Code/tools/codegraph/dist/bin/codegraph.js",
"serve",
"--mcp",
"--path",
"${workspaceFolder}"
```

Use local source mode only when actively developing CodeGraph itself. Keep the
pinned package mode for normal NanoFlow work. The local source tree belongs in
`D:\Code\tools\codegraph`; the NanoFlow-specific adaptation remains in
`D:\Code\dde` in both modes.

On this workstation, both Codex config scopes set
`npm_config_cache=D:/Code/tools/codegraph-npm-cache`. The first interrupted
`1.5.0` download left the default user `_npx` install without `package.json`, so
letting a restarted host use that cache would fail before the wrapper reached
CodeGraph. The controlled cache contains a verified `1.5.0` package install and
is a runtime artifact only: it is not the adaptation layer and it is not the
optional upstream source clone.

In the default configuration, MCP calls still run the pinned
`@colbymchenry/codegraph@1.6.2` package through the NanoFlow wrapper. The wrapper
queries the overlay, injects `nanoflow_context_pack` and
`nanoflow_overlay_query`, and logs the effective target mode/version to
`.codegraph/nanoflow-mcp-wrapper.log`. Changes under `D:\Code\tools\codegraph`
do not affect Codex MCP calls until the active config is switched to the local
`dist/bin/codegraph.js` path and that local source is rebuilt. In this repository
the active config is normally `D:\Code\dde\.codex\config.toml`; the user config
is only the fallback when the project does not declare the `codegraph` server.

The wrapper startup log also includes `wrapperVersion`, `scriptPath`,
`scriptSha256`, `logPath`, `diagnosticSchemaVersion`, and `outputModes`;
overlay calls log `outputMode` as `markdown`, `json`, `context-json`,
`native-json`, or `native-markdown`, and context pack responses log whether the
final text starts with JSON. Every diagnostic JSON line uses schema v2 fields
`seq`, `sinceStartMs`, `wrapperPid`, and `diagnosticSchemaVersion` so multiple
wrapper processes can be sorted without relying only on wall-clock timestamps.
Every context-pack composition has a `contextId`, and every overlay child query
has a `queryId`.
Use those IDs to correlate `nanoflow.context.overlay.start`,
`overlay.query.start`, `overlay.query.spawn`, `overlay.query.exit` or
`overlay.query.timeout`, and `nanoflow.context.response`. If a live host returns
JSON-wrapped NanoFlow output after these fields exist in source, inspect
`.codegraph/nanoflow-mcp-wrapper.log`: an older `scriptSha256` or missing
`outputModes` means the host has a stale MCP process and must be restarted before
judging the current wrapper. Every client request with an id also receives a
wrapper `requestId` from `client.request.start` through `client.response`.
Overlay tool calls and context packs copy that `requestId` onto
`nanoflow.overlay.*`, `nanoflow.context.*`, and `overlay.query.*` events, so a
post-mortem can correlate the original MCP id, wrapper request, base CodeGraph
internal request, overlay child process, and final client response without
guessing from timestamps.

The wrapper also logs the transport boundary before and after parsing:
`client.stdin.chunk` records input bytes, buffered stdin bytes, client framing
mode before parsing, and a nested `runtime` snapshot; `child.stdout.chunk` records
the base CodeGraph child pid, output bytes, buffered stdout bytes, and the same
runtime snapshot. `client.request.start` adds `rawMessageBytes` and
`argumentKeys`, while `client.response` records the final response summary and
runtime after the request leaves `activeRequests`.

For latency-sensitive MCP calls, `nanoflow_context_pack` uses an internal
`context-json` overlay query. The query script treats `--context-json` itself as
`skipRefresh=true`, and the wrapper also passes `--skip-refresh` plus
`NANOFLOW_OVERLAY_SKIP_REFRESH=1` as belt-and-suspenders protection for stale
wrapper processes. The internal format intentionally omits full `edges`,
`markdown`, `codeBlocks`, and `displayEdges`; it keeps only matches, nodes,
capped relationship groups, blast-radius hints, and coverage. This keeps wide
context-pack queries in the tens-of-kilobytes range instead of megabytes. The
wrapper can still render bounded, line-numbered overlay source blocks from those
compact `nodes` when they correct a base CodeGraph miss; source reads are
restricted to files resolved inside the project root. When the base response
already has a `**Source Code**` or legacy `### Source Code` section, the wrapper injects overlay blocks
before the base source blocks instead of appending them after generic source. If
the base response already contains an overlay-selected file, the wrapper
reorders that existing base block ahead of generic source blocks rather than
duplicating it. Path comparisons normalize Windows separators and casing, so
`Scripts\\Validate-CodeGraph-Overlay-Docs.cjs` and
`scripts/validate-codegraph-overlay-docs.cjs` are treated as the same source
file. When several compact nodes could render source, the wrapper orders those
source blocks by the context pack query and overlay matches before falling back
to path order, so generic `cleanup` / `service` matches do not take the first
source-block slot from an explicitly requested file.

The query formatter also keeps a separate "core match" score for node kind,
name, qualified name, language, and file path. Metadata, docstring, signature,
and relationship text remain searchable, but those weak hits cannot outrank a
core symbol or path hit when choosing `relatedFiles`, default Markdown source
blocks, strict native JSON `codeBlocks`, or strict native Markdown code blocks.
This prevents broad natural-language queries from being filled by files that
only mention the words in metadata while the actual symbol source is pushed down
by alphabetical file order.

When an explicit symbol/path term or a high-entropy diagnostic probe has no
NanoFlow overlay evidence and upstream CodeGraph returns only weak unrelated
symbols without literal evidence for that explicit term, the wrapper collapses
the response to the minimal native-shaped no-hit statement. This quality rule
does not replace upstream generic ranking: ordinary natural-language queries
continue to trust upstream exploration even when they do not contain a literal
token match.

Context-pack overlay query selection strips diagnostic noise terms such as
`context-pack`, `quality`, `source`, `ordering`, `related`, `symbols`,
`codegraph`, `nanoflow`, and `overlay` before querying the overlay when the
query does not explicitly request tests, paths, scripts, logs, wrapper, MCP, or
other tooling intent. For example, a diagnostic query about `floating tree config
context-pack quality source ordering` still uses `floating tree config` as the
overlay query, so AGENTS config evidence and
`FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH` stay ahead of generic debugging terms.
Compound symbol scoring treats dotted all-caps handles as explicit symbol terms.

Context-pack `Related Symbols` uses the same source-file ranking and is bounded
to the first 8 files and first 12 symbols per file, with explicit `+N more`
markers. The full compact node set is still available to diagnostics, but the
rendered context pack cannot bury overlay source blocks behind unbounded weak
symbol lists. If all candidate related nodes are low-value test/spec/helper,
e2e/cypress/playwright, fixture/mock/stub/snapshot, script, generated, icon,
i18n, or static worker paths and the query did not ask for those categories, the
section renders `No overlay symbols matched this query.` rather than filling the
visible answer with weak helper symbols.

Every `nanoflow.context.response` log includes a `queryPlan` object and a
`sourceOrdering` object for this quality path. `queryPlan` records `rawQuery`,
`baseQuery`, `overlayQuery`, `baseQueryFocused`, `maxFilesWasDefaulted`,
`maxFiles`, `baseMaxFiles`, `overlayLimit`, `contextTimeoutMs`, and
`overlayTimeoutMs`, so query focusing, default max-file behavior, and timeout
budgets can be audited from one response/error log entry without stitching
multiple events together. `sourceOrdering.sourceRankingQuery` records the query
actually used to rank rendered and overlay source files after tooling/noise
focus is applied, while `sourceOrdering.sourceVisibilityQuery` preserves the
raw user query used for visibility decisions such as explicit file, test, and
low-value exceptions. `queryClassification` and
`sourceOrdering.queryClassification` record whether the raw query was classified
as CodeGraph tooling, tooling quality, source-pollution, test, Context7 docs, or
de-duplication maintenance work. For de-duplication maintenance they must
preserve `codegraphDedupMaintenance`, `dedupMaintenanceReason`,
`hasCodegraphAnchor`, `hasMaintenanceIntent`, `hasStrongMaintenanceIntent`,
`hasDedupMaintenanceHelperSignal`, and the matched anchor / intent / helper
segments, so helper-only queries such as `selectAngularSemanticApiEdges` or
`summarizeContextPackSourceOrdering` are not misread as generic script
pollution. `sourceOrdering.sourceSectionCount` counts rendered
`**Source Code**`, legacy `### Source Code`, and strict native `### Code`
sections, `sourceOrdering.duplicateSourceSectionCount` must be zero for a
healthy context pack, `sourceOrdering.relationshipsSectionCount` /
`sourceOrdering.duplicateRelationshipsSectionCount` and
`sourceOrdering.relatedSymbolsSectionCount` /
`sourceOrdering.duplicateRelatedSymbolsSectionCount` track duplicated native
`Relationships` and `Related Symbols` sections, and those duplicate counts must
also be zero for a healthy native-shaped context pack. `sourceOrdering.firstSourceFiles` is the final
Markdown source block order, and `sourceOrdering.rankedOverlayFiles` is the
overlay's preferred file order. `sourceOrdering.rankedOverlayFileDetails`
records the first ranked files with `matchRank`, `nodeRank`, `matchScore`,
`nodeScore`, `pathScore`, `symbolScore`, `sourceBlockScore`, and
`lowValuePenalty`, plus `rawLowValuePenalty`, `pathClassLowValue`,
`codegraphToolingSource`, `dedupMaintenanceSource`, `explicitSymbolEvidence`,
`preferredSymbolEvidence`, `explicitFileRequested`, and
`explicitSourcePathRequested`, so a bad first source block can be traced to
match order, graph-node order, path segmentation, symbol matching, rendered
source ownership, de-dup maintenance classification, or low-value file demotion
without re-running the query.
`sourceOrdering.relationshipKindSectionCounts` records per-kind subsection
counts inside the native-shaped `Relationships` section, and
`sourceOrdering.duplicateRelationshipKindSectionCount` must stay zero so merged
overlay evidence appends under an existing `**calls:**`, `**references:**`, or
similar native subsection instead of creating duplicate relation-kind headings.
The log guard aggregates this as `duplicateRelationshipKindSections` beside
`duplicateRelationshipsSections` and `duplicateRelatedSymbolsSections`, so a
single duplicated relation-kind subsection fails current source-ordering quality
even when the top-level `Relationships` section count is still one.
`sourceOrdering.visibleSourceFileDetails` records visible source blocks with
`visibleIndex`, `rankedIndex`, `lowValuePenalty`, `rawLowValuePenalty`,
`pathClassLowValue`, `codegraphToolingSource`, `dedupMaintenanceSource`,
`explicitSymbolEvidence`, `preferredSymbolEvidence`, `explicitPathRequested`,
and `explicitSourcePathRequested`, so a future failure can distinguish "this
file class is normally low value" from "this exact query explicitly asked for
it" or "this script is intentional de-dup maintenance evidence."
`sourceOrdering.rawTopRankedOverlayFile` preserves the unfiltered top ranked
overlay file for root-cause analysis, while `sourceOrdering.topRankedOverlayFile`
is the guard candidate after low-value files that should not enter the source
budget have been skipped. `sourceOrdering.topRankedOverlayFileSelectionReason`
explains that correction (`raw-score-top`, `preferred-symbol-evidence`,
`low-value-source-skipped`, or `clean-source-fallback`) so log readers can tell
whether a helper/source block moved because it was explicitly requested or
because an earlier candidate was filtered. When that skip happens,
`sourceOrdering.topRankedOverlayFileSkippedLowValue` is `true`.
`sourceOrdering.topRankedOverlayFileVisibleIndex` shows where the guard
candidate landed, `sourceOrdering.firstSourceBlockIsTopRankedOverlayFile` proves
that candidate owns the first source-block slot, and
`sourceOrdering.topRankedOverlayFileMissing` flags a complete miss after
low-value skipping. `sourceOrdering.baseSourceReorderAllowed=false` means the
wrapper intentionally preserved native CodeGraph source order because the
overlay evidence was only a generic symbol/match signal, without NanoFlow
`metadata.relation`, explicit source-path intent, tooling cleanup, or low-value
suppression. In that case a visible top-ranked overlay file at index greater than
zero is not a current source-ordering failure. Check these fields before judging
a context-pack result from the rendered Markdown alone.

`nanoflow.context.response.sourceSelection` and
`nanoflow.context.timeout.sourceSelection` record the source-selection decision
surface behind the rendered Markdown. `visibleSourceFiles` lists the final
visible source blocks with rank, low-value penalty, explicit-query flags, and
origin. `filteredSourceFiles` includes both base CodeGraph source blocks removed
from the final answer and NanoFlow overlay candidate files that were skipped by
low-value rules before rendering; each entry keeps `reason`, score components,
raw/effective `lowValuePenalty`, `codegraphToolingSource`,
`dedupMaintenanceSource`, and explicit path/source flags. This makes
generated/protobuf files, broad `scripts/`, `.github`, Cloudflare static assets,
fixtures, mocks, and browser tests auditable from a single response log entry
even when ranked source details are missing or truncated.

`currentContextSourceOrdering.lowValueVisibleSourceBlocks` counts visible source
blocks whose `rankedOverlayFileDetails.lowValuePenalty` is positive, or whose
path matches the analyzer's low-value fallback for test/spec, helper,
e2e/cypress/playwright, fixture/mock/stub/snapshot, icon, i18n,
story/demo/sample/example/playground, generated, `scripts/`, `.github/`, or
`cloudflare/workers-static-assets/` source. `currentContextSourceOrdering.lowValueSourcePollution`
marks avoidable cases where low-value source pollution consumes the first source
budget, or any visible source slot when ranked details are missing but clean
visible alternatives exist; this applies even when the base Source Code block
count is already within the normal source-block budget.
Partial `sourceOrdering` objects are not valid diagnostics: if any required
field is missing, including `sourceRankingQuery` and `sourceVisibilityQuery`,
the log guard must count the response under
`missingDiagnostics` and preserve the missing field list in
`latestMissingDiagnostics`.

`nanoflow.context.response.baseSectionFiltering` and
`nanoflow.context.timeout.baseSectionFiltering` diagnose base CodeGraph metadata
noise before the rendered source-block section. They count low-value lines
filtered from native `Blast radius`, `Relationships`, and `Related Symbols`
sections with `rawLineCount`, `keptLineCount`, `filteredLineCount`,
`filteredByReason`, `sectionsTouched`, and `filteredLineDetails[]`. Each detail
keeps the section, reason, source path or symbol, low-value penalty, and a short
line preview. `baseTextDiagnostics` and `rawBaseTextDiagnostics` record the
post-filter and pre-filter Markdown shape (`bytes`, `lineCount`,
`sourceSectionCount`, `relationshipsSectionCount`, `relatedSymbolsSectionCount`,
`sourceBlockCount`, and `firstHeadings`). When an answer
looks filled with unrelated logger, telemetry, test helper, or generic base
relationships, inspect these fields before changing overlay ranking: they show
whether the noise came from base CodeGraph metadata, overlay source ordering, or
transport/timeout behavior.

For failure triage, `nanoflow.context.response`,
`nanoflow.context.timeout`, `nanoflow.context.error`,
`nanoflow.overlay.response`, `nanoflow.overlay.error`, and their corresponding
`client.response` summaries include `rootCauseSnapshot` when the response is an
error or partial-recovery failure class. The snapshot keeps wrapper script hash,
CodeGraph target/args, project root, runtime queues, active requests, and recent
child/client I/O summaries, so a future MCP crash, timeout, stale wrapper, or
host-environment mismatch can be classified without replaying the whole session.

Do not let the MCP query path synchronously regenerate a stale overlay. Querying
`scripts/query-codegraph-nanoflow-overlay.mjs` without `--skip-refresh` is still
allowed for CLI freshness, but the wrapper must rely on an explicit
`npm run codegraph:overlay` or an opt-in startup refresh. The root-cause
signature for this bug in `.codegraph/nanoflow-mcp-wrapper.log` is
`overlay.query.timeout` plus structured `profilePhases` showing
`checkOverlayFreshness` followed by `ensureOverlay:stale-source`, or `loadOverlay`
taking tens of seconds; that means the query path validated the selected immutable
generation, not that the upstream CodeGraph daemon or MCP
transport crashed.

Run `npm run codegraph:mcp:log:guard` before manual log spelunking. The guard
summarizes `.codegraph/nanoflow-mcp-wrapper.log`, fails on critical transport
evidence such as `child.exit` / `wrapper.exit` while requests are active or any
fatal `wrapper.runtime.diagnostic` / `wrapper.fatal` process-level runtime
error, and also fails on current
context-pack source-ordering regressions through
`--fail-on-current-source-ordering`. A current source-ordering regression means
the latest context-producing wrapper matches the on-disk wrapper script and its
`currentContextSourceOrdering` still has missing diagnostics, duplicate
source code sections, a missing top-ranked overlay file, or a top-ranked
overlay file that did not land first, or
`currentContextSourceOrdering.lowValueSourcePollution > 0`. Historical
source-ordering issues from old or stale wrapper processes remain diagnostic
evidence, not a guard failure. A raw top-ranked low-value helper/spec/script file
that is intentionally filtered from the source budget is not a current missing
top-ranked failure when the guard candidate is a clean visible source file. The
only script-path exception is an explicit adapter-maintenance query: CodeGraph or
NanoFlow MCP diagnostics, wrapper/analyzer work, or de-duplication hotspot /
manifest / validator contract work may legitimately surface
`scripts/generate-codegraph-nanoflow-overlay.mjs` or other adapter scripts as
high-value source. Broad Android/Kotlin runtime, widget lifecycle, application,
or feature queries must still treat `scripts/` source blocks as low-value
pollution when cleaner project source exists.
When the Codex tool call itself reports `Transport closed` or another transport
error, pass that observed error to the analyzer with `--direct-mcp-error` or
`NANOFLOW_CODEGRAPH_DIRECT_MCP_ERROR`; otherwise the analyzer only sees the
shared wrapper log and may lack the current tool-layer failure. The direct error
appears in `observedDirectMcpError`, `observedDirectMcpFailureClass`, and
`diagnosticTriage.primaryEvidence.directMcpError`, so later review can separate
Codex host/session closure from adapter source regressions without guessing.
When the host wrapper target or key environment values drift from
`C:\Users\MI\.codex\config.toml`, the analyzer also mirrors the config
comparison into the first triage object:
`diagnosticTriage.primaryEvidence.currentWrapperTargetComparison`,
`diagnosticTriage.primaryEvidence.currentContextWrapperTargetComparison`,
`diagnosticTriage.primaryEvidence.currentWrapperEnvComparison`,
`diagnosticTriage.primaryEvidence.currentContextWrapperEnvComparison`, and
`diagnosticTriage.primaryEvidence.hostConfigMismatches[]`. Each mismatch entry
must include `scope`, `field`, `expected`, and `actual`; env mismatches also
carry `key`. This keeps text-mode guard output actionable without forcing the
reader to manually correlate later `codexMcpConfig.*` lines before deciding
whether direct MCP is stale or the adapter source is broken.
The guard reports `overlay.query.timeout` separately from expected
`host-stdin-closed` shutdowns. Non-timeout overlay subprocess failures are
summarized under `overlayFailures`; use `overlayFailures.byClass`,
`overlayFailures.byDate`, and `overlayFailures.latest` to separate
`overlay-stale-skip-refresh`, `overlay-nonzero-exit`, `overlay-max-buffer`,
`overlay-json-parse`, and
`overlay-signal-exit` from transport failures before changing wrapper restart or
timeout behavior. Base CodeGraph child startup failures are summarized under
`childSpawnErrors`; use `childSpawnErrors.byCode`, `childSpawnErrors.byDate`,
and `childSpawnErrors.latest.message` to identify ENOENT/PATH or spawn-time
configuration failures before investigating request-time `child.exit` events.
Every `child.spawn.error` entry must carry `target`, `resolvedTarget`, `exists`,
`code`, `message`, `runtime`, and
`investigation.failureBoundary/failureClass/transportShouldStayAlive`, so the
guard can distinguish a bad local CodeGraph target from a transport crash
without relying on stderr text.
Upstream CodeGraph index-freeze warnings are summarized under
`codegraphAutoSyncDisabled`, `currentCodegraphAutoSyncDisabled`,
`activeCodegraphAutoSyncDisabled`, and
`activeCodegraphAutoSyncDisabledRuns`. These buckets are populated from
`child.stderr` text such as `CodeGraph auto-sync is DISABLED`,
`auto-sync disabled`, `file lock`, or `index is frozen`, and their
`latest.textTail` preserves the actionable warning window rather than the tail
of a long source-code response. A later response warning whose `textTail` no
longer contains the auto-sync disabled wording must not overwrite an earlier
`child.stderr` warning that still carries the root-cause text.
`nanoflow.context.response`
must also log `baseResponseWarnings` and `responseWarnings`; when upstream
CodeGraph returns the auto-sync disabled banner inside the response text instead
of stderr, those warning objects carry `codegraphAutoSyncDisabled=true` and are
folded into the same run bucket. `currentCodegraphAutoSyncDisabled` tracks the
latest current wrapper, while `activeCodegraphAutoSyncDisabled` tracks any
recently active wrapper that direct MCP may still route to. When either current
or active bucket is nonzero, treat stale or low-quality context as an index
freshness problem first: release the file lock, run `codegraph sync`, then
retry the MCP or adapter query before changing NanoFlow ranking code.
Every `wrapper.runtime.diagnostic` entry must carry `kind`, `failureClass`,
`fatal`, `activeRequestsAtShutdown`, `runtime`, `rootCauseSnapshot`, and
`investigation.failureBoundary/failureClass/transportShouldStayAlive`.
When the diagnostic explains a host/config boundary, it must also carry
`misdiagnosisGuards[]` and `requiredEvidenceBeforeConclusion[]` so raw log
readers can see which conclusions are blocked before running the analyzer.
For example, a Codex host config mismatch blocks `adapter-source-regression`,
`wrapper-transport-crash`, and `overlay-timeout` until a fresh adapter fallback,
adapter doctor snapshot, or current critical transport event supplies the
missing evidence. Fatal
diagnostics are emitted before the transport closes for wrapper
`uncaughtException`, `unhandledRejection`, and protocol-level
`client-invalid-header` exits; non-fatal diagnostics are emitted for process
warnings and `rejectionHandled`. `client.header.invalid` must also include
`headerPreview`, `headerBytes`, `runtime`, `rootCauseSnapshot`, and
`investigation`, then the wrapper must write a matching `wrapper.exit` with
`transportClosedBy=client-invalid-header` before exiting.
Every `wrapper.fatal` entry must carry `failureClass`, `expectedExit=false`,
`transportClosedBy=wrapper-process-fatal`, `error.name`, `error.message`,
`error.stack`, `runtime`, and
`investigation.failureBoundary/failureClass/transportShouldStayAlive`. These
events are emitted for `uncaughtException` and `unhandledRejection` before the
wrapper exits, so a client-visible `Transport closed` can be traced to the
wrapper process instead of being misclassified as an overlay timeout, host stdin
shutdown, stale-wrapper recycle, or base CodeGraph child restart.
Use `npm run codegraph:mcp:log:guard:strict` when the question is whether the
currently connected MCP host is still serving requests through an old wrapper
script or old Codex MCP configuration. That command adds
`--fail-on-current-autosync-disabled`, `--fail-on-stale-current-wrapper`,
`--fail-on-host-config-mismatch`, and `--fail-on-untrusted-direct-mcp`, so it
exits nonzero when the current wrapper has
`currentCodegraphAutoSyncDisabled.count > 0`, when any recently active wrapper
pushes `activeCodegraphAutoSyncDisabled.count > 0` into
`rootCauseSummary.directMcpTrust`, when `currentWrapper` or
`currentContextWrapper` no longer matches the on-disk
`scripts/codegraph-nanoflow-mcp-stdio.cjs` hash, when
`codexMcpConfig.currentWrapperTarget` / `codexMcpConfig.currentWrapperEnv`
differs from `C:\Users\MI\.codex\config.toml`, or when
`rootCauseSummary.directMcpTrust` starts with `do-not-trust-direct-mcp`.
This strict mode is intended for wrapper repair sessions and release readiness;
the default log guard also carries `--fail-on-untrusted-direct-mcp` so routine
triage fails fast when direct MCP is known untrusted.
When a guard analyzes a gate-owned or other out-of-tree log, pass the repository
explicitly with `--project-root <repo-root>`; log location is not project
identity. Intentional `smoke` / `adapter-fallback` config overrides may prove
`trustedForAdapterJudgment=true`, but remain
`trustedForDirectHostHealth=false`. The untrusted-direct guard therefore does
not fail a successful non-direct probe, while the JSON root-cause summary still
forbids claiming that the connected direct host is healthy.
The regular JSON and text log-guard output must front-load a compact
`diagnosticTriage` object before bulky historical event buckets. That object is
derived from the full root-cause summary and must include
`diagnosticTriage.status`, `diagnosticTriage.failureBoundary`,
`diagnosticTriage.adapterFailureLikely`, `diagnosticTriage.directMcpTrust`,
`diagnosticTriage.failureClasses`, `diagnosticTriage.doNotMisdiagnoseAs`,
`diagnosticTriage.primaryEvidence`, and `diagnosticTriage.nextAction`. Use it
as the first anti-misdiagnosis read: if it says
`adapterFailureLikely=false`, `directMcpTrust=do-not-trust-direct-mcp*`, and
`doNotMisdiagnoseAs` includes adapter source regression, overlay timeout, or
wrapper transport crash, the next action is host/session restart, fresh adapter
fallback, or index freshness repair before changing adapter source.
Each wrapper process also writes its own Codex config alignment evidence at
startup. `wrapper.start.codexConfigAlignment` records the compared wrapper path,
CodeGraph target, and configured env keys. A drift logs
`wrapper.config.mismatch` with `failureClass=mcp-host-config-mismatch`,
`expected`, `actual`, `mismatches[]`, and
`investigation.failureBoundary=codex-mcp-host`. It also carries
`misdiagnosisGuards[]` and `requiredEvidenceBeforeConclusion[]` entries that
explicitly block adapter source regression, wrapper transport crash, and overlay
timeout conclusions until the fresh fallback/doctor/current-wrapper evidence
exists; a clean startup logs
`wrapper.config.match`, while helper/config parse problems log
`wrapper.config.unavailable` without failing MCP startup. Fresh adapter fallback
and smoke diagnostics set `NANOFLOW_CODEGRAPH_CONFIG_ALIGNMENT_MODE` and log
`wrapper.config.override` when they intentionally override timeout or target
values, so those subprocesses are not misclassified as stale direct Codex MCP
hosts. Override events must carry a guard for
`live-codex-host-config-drift`, requiring a direct Codex MCP `wrapper.start`
without override mode before anyone concludes the live host is drifting. The
log analyzer must surface this as
`codexMcpConfig.hostConfigAlignmentOverrides[]` and
`diagnosticTriage.primaryEvidence.hostConfigAlignmentOverrides[]`; target/env
comparisons from these wrapper runs use `ignored=true`,
`ignoredReason=wrapper-config-alignment-intentional-override`, and the concrete
`alignmentMode` such as `adapter-fallback` or `smoke`. These override runs must
not set `codexMcpConfig.mismatch=true`, must not trigger
`--fail-on-host-config-mismatch`, and must not add `mcp-host-config-drift` or
`mcp-host-env-mismatch` failure classes unless a strict/live wrapper also
misaligns with `C:\Users\MI\.codex\config.toml`. This is the immediate
per-process evidence;
`codegraph:adapter:doctor -- --explain` remains the cross-process summary that
correlates live wrapper pids, active stale sessions, and root-cause trust status.
When a wrapper process detects that its startup script hash is stale against the
current disk script, it must log `wrapper.script.stale` once, log
`wrapper.script.stale.continue` for the current NanoFlow extension request, and
let that `nanoflow_context_pack` or `nanoflow_overlay_query` response succeed.
The current Codex contract sets
`NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE=0`, so the stale wrapper logs
`wrapper.script.stale.recycle.skipped` and keeps the stale transport alive until
the host/session is restarted. Only explicit stale-smoke or recycle diagnostic
runs should set `NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE=1`; those runs
log `wrapper.script.stale.recycle.request` and
`wrapper.shutdown.stale-wrapper-script` after the current NanoFlow response
succeeds, then exit gracefully so the host can reconnect to the fresh wrapper.
Codex may surface that explicit diagnostic recycle as client-visible
`Transport closed`; diagnose that case as `stale-wrapper-script` only when
`expectedExit=true`, `transportClosedBy=wrapper-script-stale`, and no active
requests remain at shutdown. Stale is a strict log guard and
human-diagnostic signal, not a
client-visible `isError` response, because failing NanoFlow tools pushes agents
to the native CodeGraph CLI and bypasses the project adapter layer. Native/base
CodeGraph forwarding and `tools/list` stay alive by default, so the current
request can finish and the operator can restart the host/session deliberately to
load the fresh on-disk wrapper.
The JSON summary includes `wrapperStarts.total`,
`wrapperStarts.versions`, `wrapperStarts.latest.scriptSha256`,
`currentWrapper`, `currentWrapper.diskScriptSha256`,
`currentWrapper.matchesDisk`, `currentWrapper.staleAgainstDisk`,
`currentDiskWrapper`, `currentDiskWrapper.latestRequestKind`,
`currentConfiguredWrapper`, `currentConfiguredWrapper.codegraphTarget`,
`currentContextWrapper`, `currentContextWrapper.diskScriptSha256`,
`currentContextWrapper.matchesDisk`, `currentContextWrapper.staleAgainstDisk`,
`currentContextWrapper.latestTs`, `currentContextWrapper.latestRequestId`,
`currentDiskContextWrapper`, `currentDiskContextWrapper.latestRequestKind`,
`currentConfiguredContextWrapper`,
`currentConfiguredContextWrapper.codegraphTarget`,
`currentContextWrapperSupersededByFreshWrapper`,
`currentContextWrapperScriptSupersededByFreshWrapper`,
`currentContextWrapperConfigSupersededByFreshWrapper`,
`currentContextWrapperSupersededReason`,
`currentContextWrapperRawEnv`, `currentContextWrapperRawTarget`,
`activeWrappers`, `hostMcp.liveWrapperLogFilter`,
`hostMcp.liveWrapperLogFilter.applied`,
`hostMcp.liveWrapperLogFilter.liveWrapperPids`,
`hostMcp.liveWrapperLogFilter.liveWrapperProcesses`,
`hostMcp.liveWrapperLogFilter.processStartClockSkewMs`,
`hostMcp.liveWrapperLogFilter.ignoredWrapperStarts`,
`hostMcp.liveWrapperLogFilter.ignoredContextResponses`,
`hostMcp.liveWrapperLogFilter.ignoredPidReuseWrapperStarts`,
`hostMcp.liveWrapperLogFilter.ignoredPidReuseContextResponses`,
`hostMcp.liveProcesses.wrapperProcessCount`,
`hostMcp.liveProcesses.matchingWrapperCount`,
`hostMcp.liveProcesses.auxiliaryProcessCount`,
`hostMcp.liveProcesses.auxiliaryProcesses`,
`hostMcp.liveProcesses.hostParentPids`,
`malformedLineNumbers`, `malformedLineRootCauseClasses`,
`malformedLineDetails`,
`currentContextSourceOrdering`,
`currentContextSourceOrdering.baseSectionFilteredLines`,
`currentContextSourceOrdering.latestBaseSectionFiltering`,
`currentDiskContextSourceOrdering`,
`currentDiskContextSourceOrdering.baseSectionFilteredLines`,
`currentDiskContextSourceOrdering.latestBaseSectionFiltering`,
`contextSourceOrdering`,
`contextSourceOrdering.baseSectionFilteredLines`,
`contextSourceOrdering.latestBaseSectionFiltering`,
`wrapperRuntimeDiagnostics`, `currentWrapperRuntimeDiagnostics`,
`codegraphAutoSyncDisabled`, `currentCodegraphAutoSyncDisabled`,
`activeCodegraphAutoSyncDisabled`, `activeCodegraphAutoSyncDisabledRuns`, and
`codexMcpConfig.hostConfigAlignmentOverrides`, plus top-level log guard fields
`diagnosticTriage`,
`diagnosticTriage.status`, `diagnosticTriage.failureBoundary`,
`diagnosticTriage.adapterFailureLikely`, `diagnosticTriage.directMcpTrust`,
`diagnosticTriage.failureClasses`, `diagnosticTriage.doNotMisdiagnoseAs`,
`diagnosticTriage.primaryEvidence`,
`diagnosticTriage.primaryEvidence.hostConfigAlignmentOverrides`,
`diagnosticTriage.nextAction`,
`rootCauseSummary.status`,
`rootCauseSummary.failureBoundary`, `rootCauseSummary.adapterFailureLikely`,
`rootCauseSummary.failureClasses`, `rootCauseSummary.directMcpTrust`,
`rootCauseSummary.fallback`, and `rootCauseSummary.recovery`.
`codegraph:adapter:doctor` must also emit `hostMcp.rootCauseSummary` after live
wrapper PID filtering. The root-cause summaries must include `status`,
`failureBoundary`, `failureClasses`, `adapterFailureLikely`, `directMcpTrust`,
`fallback`, `recovery`, `expected`, `observed.autoSyncDisabled`,
`observed.activeAutoSyncDisabledCount`, `observed.activeAutoSyncDisabledRuns`,
`observed.activeDirectWatcherCount`, `observed.activeDirectWatcherRuns`,
`observed.liveProcessMismatches`, `observed.directMcpError`, and
`observed.liveWrapperProcessCount`, so a stale Codex MCP host, host transport
closure, stale wrapper script, target/env mismatch, live stale process, and
CodeGraph index freeze are visible without manually correlating every check.
When `adapterFailureLikely=false` and recovery points at restarting Codex/MCP
host or using `codegraph:adapter:context`, the issue is host/session state until
fresh-wrapper evidence proves otherwise.
In `codegraph:adapter:doctor -- --explain`, a wrapper whose startup script hash
matches the current disk file but whose target/env does not match
`C:\Users\MI\.codex\config.toml` must be reported as
`fresh-config-mismatch`, not plain `fresh`; a wrapper whose startup script hash
is stale and whose target/env also mismatches must be reported as
`stale-config-mismatch`, not plain `stale`. In both cases the direct MCP result
is still untrusted until the Codex MCP host/session reconnects.
Use `currentWrapper.scriptSha256` to see which wrapper source the latest live
host logged at startup. Use `currentWrapper.diskScriptSha256` to see the hash
the log guard recalculated from the current on-disk script. If
`currentWrapper.matchesDisk` is `false` or `currentWrapper.staleAgainstDisk` is
`true`, the host is still running an older wrapper process; restart the MCP
host/session before judging whether a transport fix worked. `currentWrapper` is
selected from the latest run with any activity, so it remains the transport
health anchor even when the newest activity is only `initialize` or `tools/list`.
Use `currentDiskWrapper` when stale long-lived sessions are still active but the
log also contains a wrapper whose startup hash matches the current on-disk
script. Its `latestRequestKind` records the newest request class handled by that
fresh wrapper, so current wrapper-code evidence is not masked by a later stale
tools-list or initialize event from an old editor session.
`currentDiskWrapper` proves only that the script bytes match disk; it does not
prove the live host loaded the current Codex `codegraphTarget` or env. Use
`currentConfiguredWrapper` to confirm a recently active wrapper both matches the
current on-disk script and matches `C:\Users\MI\.codex\config.toml` target/env.
If `currentDiskWrapper` is present but `currentConfiguredWrapper` is null,
direct MCP is still untrusted for Codex repair decisions until the MCP
host/session restarts or a fresh adapter smoke proves the current config.
Use `activeWrappers.total`, `activeWrappers.matchingDisk`,
`activeWrappers.staleAgainstDisk`, `activeWrappers.distinctScriptSha256`,
`activeWrappers.activeWindowMs`, `activeWrappers.latest`,
`activeCodegraphAutoSyncDisabled`, and `activeCodegraphAutoSyncDisabledRuns` to
detect mixed long-lived MCP sessions in the recent activity window. If
`activeWrappers.distinctScriptSha256 > 1` or `activeWrappers.staleAgainstDisk > 0`,
multiple wrapper script hashes are still handling requests; treat this as a
host/session refresh problem and verify current wrapper fixes with a fresh
wrapper smoke before blaming overlay query timeouts or base CodeGraph crashes.
If `activeCodegraphAutoSyncDisabled.count > 0`, direct MCP may still route to a
wrapper with a frozen CodeGraph index even when `currentCodegraphAutoSyncDisabled`
is zero; inspect `activeCodegraphAutoSyncDisabledRuns` for runId, pid, target,
and latest warning text.
The `latest` array is capped by `activeWrappers.detailLimit` so guard output
stays readable even when the historical log contains many old runs.
`currentContextWrapper` is selected from the latest run that emitted
`nanoflow.context.response`; use its script hash and disk hash to judge whether
the source-ordering evidence came from the current on-disk wrapper. Prefer
`currentContextSourceOrdering` over historical totals when judging whether the
latest context-pack-producing wrapper still has source-ordering problems. This
keeps a tools-list-only run from resetting context-pack quality diagnostics to
zero. `currentContextWrapper.latestTs` and
`currentContextWrapper.latestRequestId` record the actual context response used
for this judgment; a stale wrapper response that arrives after a fresh wrapper
start is not `supersededByFreshWrapper` and must remain current stale evidence.
If `currentContextWrapper.matchesDisk` is `false` or
`currentContextWrapper.staleAgainstDisk` is `true`, do not treat
`currentContextSourceOrdering` failures as current behavior; restart the MCP
host/session or verify with a fresh wrapper process first, and handle the
ordering issue as stale historical evidence. Use `currentDiskContextWrapper` to
find the latest context-pack-producing wrapper whose startup hash still matches
disk; its `latestRequestKind` should be `nanoflow-context-pack` or otherwise
point at the context-pack request evidence used to judge the current script.
`currentDiskContextSourceOrdering` is the source-ordering summary for that
matching-disk context wrapper even when a later stale wrapper produced the most
recent context response. As with `currentDiskWrapper`, matching disk is not the
same as matching Codex config: `currentConfiguredContextWrapper` is the evidence
that a context-pack-producing wrapper used the current script and the current
Codex `codegraphTarget` / env. If it is null while `currentDiskContextWrapper`
exists, use the disk context evidence only for script-behavior triage and keep
direct MCP marked untrusted until host restart or fresh smoke. Use
`contextSourceOrdering.missingDiagnostics` to spot stale pre-source-ordering
wrapper processes, and use
`contextSourceOrdering.duplicateSourceSections`,
`contextSourceOrdering.duplicateRelationshipsSections`,
`contextSourceOrdering.duplicateRelatedSymbolsSections`,
`contextSourceOrdering.topRankedMissing`, `contextSourceOrdering.topRankedNotFirst`,
`contextSourceOrdering.lowValueVisibleSourceBlocks`,
`contextSourceOrdering.lowValueSourcePollution`, `contextSourceOrdering.latestIssue`, and
`contextSourceOrdering.latestMissingDiagnostics` to triage quality failures
where generic base CodeGraph source blocks hide or split the overlay's
top-ranked project file or where low-value source blocks consume the first
source budget. If `rankedOverlayFileDetails` is missing or truncated, the log
guard still applies the path-based low-value fallback, including non-first
low-value source blocks when clean visible alternatives exist, before treating
the current context pack as clean. Its compact latest-failure and
latest-source-selection records preserve `queryClassification`,
`sourceOrdering.queryClassification`, `codegraphToolingSource`, and
`dedupMaintenanceSource`, so log triage can separate an intentional adapter
maintenance query from accidental low-value script pollution without opening the
raw JSON log first.
Its compact latest-failure records preserve the
timeout query, `queryPlan`, `outputMode`, `contextJson`, `profileMeta`,
`profilePhases`, byte counts, and `lastProfilePhase`, so a wide query stuck in
`selectGraphResults` does not require a separate grep before triage.

Run `npm run codegraph:mcp:smoke` when the question is whether the wrapper
transport survives a real MCP request sequence. The smoke starts the configured
Codex `C:\Users\MI\.codex\config.toml` CodeGraph target when it applies to the
workspace. It does not read or fall back to `.vscode/mcp.json`. If no applicable Codex config exists and no explicit `--codegraph-target` is provided, the smoke uses the pinned default CodeGraph target and still exercises the repository wrapper against that fallback target. It then verifies one process can complete
`tools/list -> nanoflow_context_pack -> nanoflow_overlay_query -> tools/list`.
It writes an isolated wrapper log, closes stdin gracefully, and runs the log
guard over that smoke log. Success requires `transportHealthy=true`,
`criticalTransportFailures=0`, and `overlayTimeouts.count=0` for that fresh
process; this is the process-continuity evidence that one successful MCP tool
call cannot provide.

For post-mortem review, inspect these fields before changing timeouts:

- `requestId`, `clientId`, `requestKind`, `tool`, `query`, and
  `client.response.failureClass` to follow one MCP request end to end.
- `contextId`, `baseElapsedMs`, `overlayElapsedMs`, `totalElapsedMs`, and
  `deadlineRemainingMs` on `nanoflow.context.*` events.
- `queryId`, `pid`, `startedAtMs`, `elapsedMs`, `args`, `outputMode`, and the
  sanitized `env` on `overlay.query.start/spawn/exit/timeout`.
- `overlayFile.path`, `exists`, `bytes`, `mtimeMs`, and `ageMs` to tell whether
  the query used a missing, stale, huge, or recently regenerated overlay file.
- `stdoutBytes`, `stderrBytes`, `stdoutLineCount`, `stderrLineCount`,
  `stdoutStartsWithJson`, `stderrTail`, and `stdoutPreview` to separate malformed
  output from slow execution.
- `profileMeta`, `profilePhases`, `lastProfilePhase`, and `profileParseErrors` to
  identify whether the child process was parsing args, reading JSON, parsing
  JSON, checking freshness, regenerating overlay, querying, formatting, or
  writing output when it failed.
- `failureClass` on overlay/context events before changing timeouts:
  `overlay-timeout`, `overlay-max-buffer`, `overlay-json-parse`,
  `overlay-stale-skip-refresh`,
  `overlay-nonzero-exit`, `overlay-signal-exit`, `base-codegraph-timeout`,
  `base-codegraph-error`, `context-pack-error`, `overlay-wrapper-error`,
  `invalid-params`, or `success`.
- `failureClass`, `expectedExit`, `transportClosedBy`, and
  `activeRequestsAtShutdown` on `wrapper.shutdown.*` and `wrapper.exit`. A
  `host-stdin-closed` class with `expectedExit=true`,
  `transportClosedBy=client-stdin`, and `activeRequestsAtShutdown=0` means the MCP
  host closed the wrapper transport after requests drained; it should not be
  treated as a wrapper crash. If active requests remain, inspect
  `runtime.activeRequests` and preceding `client.stdin.*` events.
- `wrapperRuntimeDiagnostics.latest.kind`, `failureClass`,
  `rootCauseSnapshot`, and `investigation` when `Transport closed` follows a
  fatal wrapper diagnostic such as `uncaughtException`, `unhandledRejection`, or
  `clientInvalidHeader`. `wrapper.fatal.error.name`,
  `wrapper.fatal.error.message`, and `wrapper.fatal.error.stack` remain the
  process-level error detail for uncaught exceptions and unhandled rejections.
  Fatal runtime diagnostics are always critical guard failures because the
  wrapper process is no longer in a known-good state.
- `investigation.failureBoundary`, `transportShouldStayAlive`,
  `likelyRootCause`, and `nextEvidence` on overlay/context/wrapper events before
  deciding whether the failure belongs to the overlay subprocess, the base
  CodeGraph child, the context-pack wrapper, the host transport, or the wrapper
  process itself.
- The nested `runtime` snapshot on `client.response`, `overlay.query.*`,
  `nanoflow.context.*`, `child.exit`, and `child.restart.request`: it includes
  `childPid`, `clientMode`, `stdinBufferBytes`, `bufferedChildStdoutBytes`,
  `childStdinBackpressured`, `clientStdoutBackpressured`,
  `activeRequestCount`, `pendingContextPackCount`, `pendingContextPackIds`,
  `pendingToolsListCount`, `pendingToolsListIds`, queue lengths, and
  `activeRequests`. `child.exit` and `child.restart.request` keep the legacy
  flat fields too, but new reviews should prefer the nested `runtime` object.

## Local CodeGraph Source Setup

```powershell
New-Item -ItemType Directory -Force D:\Code\tools
git clone https://github.com/colbymchenry/codegraph.git D:\Code\tools\codegraph
cd D:\Code\tools\codegraph
npm install
npm run build
```

Verify the local CLI against NanoFlow:

```powershell
node D:\Code\tools\codegraph\dist\bin\codegraph.js status D:\Code\dde --json
```

Rebuild the NanoFlow index when parser behavior changes:

```powershell
Remove-Item -Recurse -Force D:\Code\dde\.codegraph
node D:\Code\tools\codegraph\dist\bin\codegraph.js init -i D:\Code\dde
npm --prefix D:\Code\dde run codegraph:overlay
```

## Adaptation Roadmap

The sidecar overlay is phase 1. It should cover most NanoFlow agent tasks without
forking CodeGraph:

1. Repository fact entry remains CodeGraph MCP.
2. NanoFlow overlay supplies framework and project-specific edges.
3. Agents use targeted file reads only after those two context layers identify the
   relevant modules.

Only fork CodeGraph internals when the sidecar cannot express the needed behavior,
for example parser-level symbol extraction, graph schema changes, or native
CodeGraph tools themselves needing to rank NanoFlow relations before wrapper
composition.

Known phase-2 boundary: the overlay is still generated beside CodeGraph rather
than stored inside CodeGraph's SQLite graph. The default NanoFlow MCP entry
(`nanoflow_context_pack`) now composes native CodeGraph context with NanoFlow
relations in one Markdown response, but direct calls to upstream
`codegraph_explore` remain unchanged.
