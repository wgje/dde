---
title: Compatibility Matrix
status: canonical
audience: ai-agent, maintainer, operator
last_verified: 2026-06-09
source_paths:
  - package.json
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
| npm | bundled with supported Node | Use package lock. |
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
