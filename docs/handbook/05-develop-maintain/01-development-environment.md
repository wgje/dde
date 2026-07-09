---
title: Development Environment
status: canonical
audience: contributor, maintainer
last_verified: 2026-06-11
category: develop-maintain
source_paths:
  - README.md
  - package.json
  - .env.template
  - scripts/set-env.cjs
  - vitest.config.mts
---

# Development Environment

Use this page to prepare a local environment for changing NanoFlow.

## In This Article

- [Requirements](#requirements)
- [Install and run](#install-and-run)
- [Environment files](#environment-files)
- [Common commands](#common-commands)
- [When to use Supabase locally](#when-to-use-supabase-locally)
- [Next steps](#next-steps)

## Requirements

- Node.js `>= 22.14.0`.
- npm compatible with the committed lockfile.
- A browser suitable for Angular PWA testing.
- Supabase CLI path through the repository wrapper when backend work is needed.

## Install and Run

```bash
npm install
npm start
```

The start script runs environment preparation and then launches Angular through `scripts/run-ng.cjs`.

## Environment Files

Use `.env.template` as the reference for local settings. Keep real secrets out of committed files.

Public frontend values can include:

- Supabase URL;
- Supabase anon key;
- development flags intended for the browser.

Secrets belong in Supabase Secrets, the hosting provider, or local untracked files.

## Common Commands

| Command | Use |
| --- | --- |
| `npm start` | local development server |
| `npm run build` | production build path used by normal deployment |
| `npm run build:strict` | stricter production build with environment validation |
| `npm run test:run` | local default test matrix |
| `npm run lint` | ESLint over `src` |
| `npm run docs:human:validate` | validate human handbook |
| `npm run docs:context7:validate` | validate machine-readable docs |

## When To Use Supabase Locally

Use local Supabase when changing:

- migrations;
- RLS;
- Edge Functions;
- generated database types;
- sync behavior that depends on cloud rows.

Pure UI, local persistence, and many service tests do not require a running local Supabase instance.

## Next Steps

- Find code ownership with [Repository Map](02-repository-map.md).
- Choose verification with [Testing and Quality](03-testing-and-quality.md).
