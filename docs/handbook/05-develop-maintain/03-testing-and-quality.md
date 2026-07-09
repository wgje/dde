---
title: Testing and Quality
status: canonical
audience: contributor, maintainer, ai-agent
last_verified: 2026-06-15
category: develop-maintain
source_paths:
  - README.md
  - package.json
  - scripts/run-test-matrix.cjs
  - scripts/run-health-gate.cjs
  - vitest.config.mts
  - playwright.config.ts
  - scripts/validate-context7-docs.cjs
---

# Testing and Quality

Use the narrowest meaningful verification command that proves the change, then broaden when shared contracts or high-risk paths are touched.

## In This Article

- [Test levels](#test-levels)
- [Common commands](#common-commands)
- [Choose a gate](#choose-a-gate)
- [Repository health gate](#repository-health-gate)
- [Documentation gates](#documentation-gates)
- [Performance gate](#performance-gate)
- [Next steps](#next-steps)

## Test Levels

| Level | Purpose |
| --- | --- |
| Unit and pure tests | fast logic verification |
| Service tests | business service and sync/service boundaries |
| Component tests | Angular component behavior |
| E2E tests | critical browser flows |
| Contract tests | repository invariants such as secrets, docs coupling, and flow constraints |
| Performance gates | startup, bundle, font, and deployment artifact expectations |

## Common Commands

| Command | Use |
| --- | --- |
| `npm run test:run:pure` | pure logic changes |
| `npm run test:run:services` | service-layer changes |
| `npm run test:run:components` | component changes |
| `npm run test:run` | local default matrix |
| `npm run test:run:verify` | broader local matrix |
| `npm run test:e2e` | browser flows |
| `npm run health` | standard repository health gate before large refactors |
| `npm run health:strict` | ratcheted health gate for debt convergence and stage acceptance |
| `npm run health:full` | slow full health gate with full local tests and e2e |
| `npm run lint` | source lint |
| `npm run quality:baseline` | code health baseline |
| `npm run perf:guard` | startup and performance guard |

## Choose a Gate

| Change | Minimum meaningful verification |
| --- | --- |
| Markdown-only handbook change | `npm run docs:human:validate` |
| Context7 docs change | `npm run docs:context7:validate` |
| Service logic | related spec plus `npm run test:run:services` when broad |
| Component UI | related spec plus component lane when broad |
| Sync, offline, or persistence | targeted specs plus service or full local matrix |
| Supabase migration | migration review, generated types, relevant contract tests |
| Flow/GoJS lifecycle | related Flow specs and mobile behavior checks |

## Repository Health Gate

Run `npm run health` before large refactors or agent-led restructuring to decide whether the current repository is fit for more change. It is the standard admission gate for continued work and runs the existing quality baseline, performance gate, documentation validation, CodeGraph adapter gate, explicit TypeScript typecheck, and the default local test matrix.

Run `npm run health:strict` for debt-convergence checkpoints and stage acceptance. It replaces the quality snapshot with `quality:baseline:ratchet` and broadens the local matrix to `test:run:verify`; current ratchet or performance failures remain hard failures, not warnings.

Run `npm run health:full` when a slow full-health answer is acceptable, such as release readiness, night-before cleanup, or major cross-cutting changes. It keeps the strict front half and then runs `test:run:full` plus Playwright e2e.

## Documentation Gates

Human docs:

```bash
npm run docs:human:validate
```

Context7 docs:

```bash
npm run docs:context7:validate
```

Combined docs:

```bash
npm run docs:validate
```

## Performance Gate

Run `npm run perf:guard` when changes affect startup, shell loading, Flow loading, fonts, Supabase readiness, or deployment artifact shape. If the gate is red, do not describe the performance work as complete.

## Next Steps

- Use [Documentation Maintenance](04-documentation-maintenance.md) when a behavior change requires docs.
- Use [Production Troubleshooting](../04-deploy-operate/04-production-troubleshooting.md) when a gate failure reproduces only after deployment.
