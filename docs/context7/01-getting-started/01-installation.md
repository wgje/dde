---
title: Installation
status: canonical
audience: ai-agent, maintainer, operator
last_verified: 2026-06-09
source_paths:
  - package.json
  - .env.template
  - scripts/set-env.cjs
---

# Installation

## Requirements

| Requirement | Version / value |
| --- | --- |
| Node.js | `>= 22.14.0` |
| Package manager | npm with `package-lock.json` |
| Optional cloud backend | Supabase project |
| Optional browser target | Chromium for best PWA/local backup support |

## Install Dependencies

```bash
npm install
```

## Start Local Development

```bash
npm start
```

`npm start` runs `npm run config` first, then starts Angular through `scripts/run-ng.cjs`.

## Environment

For local offline-only usage, Supabase is not required.

For cloud features, copy `.env.template` to `.env.local` and configure:

```bash
NG_APP_SUPABASE_URL=https://your-project.supabase.co
NG_APP_SUPABASE_ANON_KEY=your-anon-key
```

Optional:

```bash
NG_APP_SENTRY_DSN=
NG_APP_GOJS_LICENSE_KEY=
```

Server-side secrets such as `GROQ_API_KEY`, FCM credentials, Supabase service-role keys, and Sentry auth tokens must not be placed in frontend source.

## First Validation

```bash
npm run docs:context7:validate
```
