---
title: Development and Verification
status: canonical
audience: ai-agent, maintainer
last_verified: 2026-06-09
source_paths:
  - package.json
  - scripts/run-test-matrix.cjs
  - vitest.config.mts
  - playwright.config.ts
---

# Development and Verification

This page lists the development commands and verification expectations for NanoFlow.

## Environment

Requirements:

- Node.js `>= 22.14.0`
- npm
- optional Supabase project for auth, sync, attachments, speech, and widget features

Install:

```bash
npm install
```

Run local app:

```bash
npm start
```

`npm start` runs `npm run config` first, then starts Angular through `scripts/run-ng.cjs`.

## Build Commands

```bash
npm run build
npm run build:dev
npm run build:strict
```

Production build performs additional launch artifact work:

- generate launch HTML
- inject modulepreload
- patch Angular service worker HTML hashes
- validate launch markers
- validate artifact closure
- generate version JSON
- generate artifact manifest

## Test Commands

Local default:

```bash
npm run test
```

Equivalent to:

```bash
npm run test:run
```

Verification lanes:

```bash
npm run test:run:verify
npm run test:run:full
npm run test:run:pure
npm run test:run:services
npm run test:run:components
```

E2E:

```bash
npm run test:e2e
npm run test:e2e:ui
```

Performance:

```bash
npm run perf:guard
npm run test:e2e:perf
```

Quality:

```bash
npm run lint
npm run quality:guard:encoding
npm run audit:secrets
npx knip
```

Database types:

```bash
npm run db:types
```

## Test Matrix

The primary test runner is `scripts/run-test-matrix.cjs`.

It supports:

- lane sharding
- quarantine filtering
- longest-processing-time scheduling
- CI weighted strategy

Local default uses `lane_node_minimal` and `lane_browser_minimal` excluding quarantine.

## Documentation Validation

Context7 docs are validated with:

```bash
npm run docs:context7:validate
```

This validates:

- required canonical docs exist
- `context7.json` has expected metadata and include folders
- `llms.txt` points to canonical docs
- relative Markdown links resolve

Run this after changing:

- `context7.json`
- `llms.txt`
- `docs/context7/**`
- project-level architecture or hard rules
- README documentation navigation

## Change-Scope Verification Guide

| Change area | Minimum useful verification |
| --- | --- |
| Markdown docs only | `npm run docs:context7:validate` |
| Config or scripts | relevant script plus `npm run lint` if JS/TS is touched |
| Models or pure helpers | `npm run test:run:pure` or targeted Vitest |
| Services or sync | `npm run test:run:services` plus relevant targeted tests |
| Components | `npm run test:run:components` |
| Offline/sync behavior | service tests plus at least one critical Playwright flow when practical |
| GoJS Flow lifecycle | component/feature tests plus browser verification when rendering changes |
| Supabase schema or functions | Supabase local validation or deployment dry-run plus affected tests |

Do not claim work is complete without fresh verification output.

## Environment Variables

Common frontend variables:

- `NG_APP_SUPABASE_URL`
- `NG_APP_SUPABASE_ANON_KEY`
- `NG_APP_SENTRY_DSN`
- `NG_APP_GOJS_LICENSE_KEY`

Widget and transcription secrets must not be exposed to frontend builds.
