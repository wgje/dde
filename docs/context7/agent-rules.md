---
title: Agent Implementation Rules
status: canonical
audience: ai-agent
last_verified: 2026-06-11
source_paths:
  - AGENTS.md
  - .github/instructions/
  - docs/context7/
---

# Agent Implementation Rules

This page is optimized for AI coding agents that retrieve NanoFlow documentation through Context7.

## Required Working Order

1. Establish repository facts with codegraph MCP. In NanoFlow, prefer the MCP tool
   `nanoflow_context_pack` when available because it combines native
   `codegraph_explore` output with the NanoFlow overlay.
2. Use external docs such as Context7 only for framework or library behavior.
3. Read targeted files after locating them.
4. Make minimal, reversible changes.
5. Run verification matched to the change scope.

If `nanoflow_context_pack` is unavailable, use the native codegraph MCP tools
for repository facts. When a task touches Angular components, `inject()`
dependencies, template/style references, dynamic imports, Supabase
migrations/functions, same-directory tests, or AGENTS hard rules, follow the
native codegraph result with `nanoflow_overlay_query`.

If codegraph MCP fails, the next repository-fact action must be the pinned
codegraph CLI fallback from `AGENTS.md`; do not replace it with ordinary search
or broad file reads.

## Non-Negotiable Project Rules

### IDs

- All persisted entity IDs are client-generated strings.
- New persisted entities use `crypto.randomUUID()`.
- Do not introduce database auto-increment IDs.
- Do not introduce temporary IDs that later require server mapping.

### Offline-First Writes

The user-facing write path is:

```text
local write -> immediate UI update -> debounce cloud push -> RetryQueue on failure
```

Never block normal editing on cloud sync unless the user explicitly enters a cloud-only administrative flow.

### Sync and Conflict

- LWW depends on `updatedAt` / `updated_at`.
- Soft deletes use `deletedAt` / `deleted_at`.
- Supabase task queries must include `content`.
- Failed writes must be recoverable through retry, isolation, or export.
- Supabase errors must be converted through `supabaseErrorToError()`.

### State Management

- Use Angular Signals and concrete stores.
- Allowed concrete stores: `TaskStore`, `ProjectStore`, `ConnectionStore`.
- Do not add NgRx, Redux, RxJS Store, or facade store aggregators.
- Keep state flat and avoid deep nested signal objects.

### Angular

- Use standalone components.
- Use `ChangeDetectionStrategy.OnPush`.
- Prefer Angular 19 function APIs for new component code.
- Use strict TypeScript.
- Use `unknown` plus type guards instead of `any`.

### GoJS and Mobile

- Mobile defaults to Text view.
- Flow view must lazy-load GoJS.
- Destroy/recreate diagrams when hiding or leaving Flow.
- Do not keep a live diagram hidden with `visibility:hidden`.

### Tree Traversal

- Use iterative traversal.
- Respect `FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH = 100`.
- Do not add unbounded recursion for task trees.

### Security

- No hard-coded API keys.
- Third-party APIs requiring secrets must be called through Edge Functions.
- User data tables must use RLS.
- Markdown output must be sanitized.
- File uploads must validate type and size and keep scan metadata coherent.

## Documentation Rule

When changing architecture, data models, sync behavior, security behavior, feature workflows, or agent rules, update the matching file under `docs/context7/` and run:

```bash
npm run docs:context7:guard
```

## Verification Expectations

Match verification to risk:

- docs only: `npm run docs:context7:validate`
- code plus docs: `npm run docs:context7:guard`
- service logic: targeted Vitest and usually `npm run test:run:services`
- components: targeted Vitest and/or `npm run test:run:components`
- sync/offline: relevant service tests and critical path tests when practical
- GoJS rendering: browser verification when UI lifecycle changes
- security/schema: policy or contract tests plus secret audit

Do not claim completion without fresh command output.
