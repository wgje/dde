---
title: Compatibility Matrix
status: canonical
audience: ai-agent, maintainer, operator
last_verified: 2026-11-09
source_paths:
  - package.json
  - package-lock.json
  - angular.json
  - playwright.config.ts
  - vitest.config.mts
  - .env.template
---

# Compatibility Matrix

This page states the supported development and runtime baseline for NanoFlow.

## Toolchain

| Component | Supported baseline | Notes |
| --- | --- | --- |
| Node.js | `>= 22.14.0` | Required by `package.json`. |
| npm | npm 10.x bundled with the Node 22 CI baseline | Keep `package-lock.json` synchronized with the manifest and validate it with the same npm major used by CI. |
| Angular | `19.2.x` | Standalone components and Signals. |
| TypeScript | `~5.8.0` | Strict typing expected. |
| Vite | `^6.2.0` | Used by Angular tooling. |
| Vitest | `^4.0.14` | Unit/service/component tests. |
| Playwright | `^1.48.0` | E2E and perf verification. |

## Browser and Platform

| Platform | Status | Notes |
| --- | --- | --- |
| Desktop Chromium | primary | Best support for PWA, local backup, and Flow. |
| Android Chrome / TWA | supported | Android widget path uses TWA host. |
| iOS Safari | supported with constraints | Audio MIME fallback required. |
| Desktop widget runtime | retired | Do not reintroduce as active path without ADR. |

## CI Lockfile Contract

GitHub Actions installs the project with Node 22 and `npm ci` (some deployment
jobs add `--prefer-offline --no-audit`). `npm ci` treats `package-lock.json` as
frozen input: the lockfile must describe the same dependency graph as
`package.json`, including optional peer edges, or the install fails before tests
run. Generate and validate lockfile changes with the npm major used by the CI
baseline rather than relying on a newer local npm serializer.

The current lockfile records the optional peer graph required by
`@napi-rs/wasm-runtime`: `@emnapi/core@1.11.3` and
`@emnapi/runtime@1.11.3` are parallel optional peers. Only
`@emnapi/core@1.11.3` depends on `@emnapi/wasi-threads@1.2.3`;
`@emnapi/runtime@1.11.3` has no `wasi-threads` edge. Keeping all three entries
and their peer metadata in the lockfile prevents npm 10 CI installs from
rejecting an otherwise unchanged manifest.

Validate lockfile reachability with `npm ls --package-lock-only --all`: this
must return no `problems`. On hosts that omit the optional `wasm32-wasi`
parent package, an installed-tree `npm ls` can report the platform-pruned peer
packages as extraneous; that platform result does not indicate a missing or
inconsistent lockfile edge.

## Cloud Services

| Service | Baseline | Notes |
| --- | --- | --- |
| Supabase JS | current package baseline | Browser uses anon key. |
| Supabase CLI | current devDependency baseline | Managed through `scripts/supabase-cli.cjs`. |
| Supabase Storage | private `attachments` bucket | Public bucket is not allowed. |
| Groq transcription | `whisper-large-v3` | Called through Edge Function. |
| Sentry | lazy-loaded client SDK | Optional DSN. |
| FCM | optional | Android widget dirty push; fallback paths exist. |

## Deployment Targets

| Target | Status | Notes |
| --- | --- | --- |
| Cloudflare Pages | recommended | Direct Upload via GitHub Actions. |
| Vercel | fallback | Static frontend deployment. |
| Netlify | fallback | Static frontend deployment. |
| Railway | fallback | Static frontend deployment. |

## Compatibility Change Checklist

1. Update package and lock files.
2. Update this matrix.
3. Update [reference/configuration-reference.md](reference/configuration-reference.md).
4. Run `npm run docs:context7:validate`.
5. Run build/test lanes appropriate to the changed dependency.
