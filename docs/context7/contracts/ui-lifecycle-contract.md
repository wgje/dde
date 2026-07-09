---
title: UI Lifecycle Contract
status: canonical
audience: ai-agent, maintainer
last_verified: 2026-06-09
source_paths:
  - src/app/features/text/
  - src/app/features/flow/
  - src/app/features/focus/
  - src/app/features/parking/
  - src/app/core/shell/
  - src/config/layout.config.ts
---

# UI Lifecycle Contract

This contract protects mobile usability, GoJS lifecycle, shell startup, and feature-specific UI ownership.

## Invariant Summary

| ID | Invariant | Evidence |
| --- | --- | --- |
| UI-001 | Mobile defaults to Text view. | shell/route/component tests |
| UI-002 | Flow view lazy-loads GoJS. | bundle/lazy-load tests |
| UI-003 | Flow diagram instances are destroyed/recreated instead of hidden alive. | Flow lifecycle tests |
| UI-004 | Flow rendering does not own sync semantics. | source ownership review |
| UI-005 | Touch targets stay at least `44px` where mobile controls apply. | UI tests or visual review |
| UI-006 | Focus Console state persists through its documented snapshot path. | Focus/Dock tests |
| UI-007 | Parking Dock preserves snapshot compatibility. | Dock snapshot tests |
| UI-008 | Text view remains the ergonomic editing surface. | Text component tests |
| UI-009 | Startup shell must not eagerly load heavy optional services. | perf guard |
| UI-010 | User-facing text must not overlap or overflow in compact controls. | visual/browser verification |

## Text View Contract

Text view owns daily editing ergonomics:

- task tree editing
- Markdown content editing
- search and filtering
- mobile-first interaction

Text view may call domain services. It must not bypass sync or persistence ownership.

## Flow View Contract

Flow view owns graph rendering, not sync.

Required:

- lazy-load GoJS and Flow-specific heavy code
- use established Flow services
- emit events through Flow event boundaries
- dispose diagram resources on lifecycle transitions
- avoid hidden live diagrams

Disallowed:

- direct Supabase writes from Flow components
- unbounded recursion in tree layout
- persistent mobile Flow as default view

## Focus and Parking Contract

Focus and Parking share attention-management behavior but keep separate responsibilities:

- Parking Dock stores task parking and dock session state.
- Focus Mode runs Gate, Strata, command stack, and execution workflows.
- Black Box is capture and review input.

Snapshot changes must preserve backward compatibility or provide migration logic.

## Shell and Startup Contract

Startup should prioritize usable UI:

- local data first
- heavy services lazy or idle-loaded
- Sentry lazy-loaded
- route guards should avoid blocking UI longer than configured guard timeouts

Performance-sensitive changes should run:

```bash
npm run perf:guard
```

## UI Change Checklist

1. Identify affected invariant IDs.
2. Confirm mobile default behavior.
3. Confirm GoJS lifecycle if Flow is touched.
4. Confirm state ownership boundaries.
5. Run component or E2E tests for changed workflow.
6. Update this contract if lifecycle semantics change.
