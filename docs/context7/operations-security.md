---
title: Operations and Security
status: canonical
audience: ai-agent, maintainer, operator
last_verified: 2026-06-09
source_paths:
  - .env.template
  - supabase/migrations/
  - supabase/functions/
  - scripts/contracts/check-secrets.cjs
---

# Operations and Security

NanoFlow's cloud features rely on Supabase and static frontend deployment. Security and recoverability are part of the core architecture.

## Deployment

Recommended deployment target:

- Cloudflare Pages Direct Upload through GitHub Actions

Supported or fallback targets:

- Vercel
- Netlify
- Railway

Required frontend environment variables for cloud features:

- `NG_APP_SUPABASE_URL`
- `NG_APP_SUPABASE_ANON_KEY`

Optional frontend variables:

- `NG_APP_SENTRY_DSN`
- `NG_APP_GOJS_LICENSE_KEY`

## Supabase Setup

Required:

1. Supabase project
2. private Storage bucket named `attachments`
3. database schema, RLS policies, RPC functions, triggers, and indexes
4. frontend env vars for Supabase URL and anon key
5. Edge Function secrets for optional server-side integrations

Never put service-role keys or third-party API secrets into Angular source or public environment variables.

## Secrets

Use Supabase Secrets or deployment platform secrets for:

- `GROQ_API_KEY`
- FCM credentials
- service-role credentials
- backup/alert credentials

Frontend code may use only public anon keys intended for browser usage.

## RLS and Data Isolation

All user data tables must enforce RLS.

Expected isolation:

- project rows by owner/user
- task rows by project ownership
- connection rows by project ownership
- black box and focus rows by user
- storage objects by user or project ownership

When changing schema or policies, verify data isolation with critical E2E tests where possible.

## Input and Rendering Safety

Rules:

- Validate user input at service or boundary layers.
- Sanitize Markdown rendering to prevent XSS.
- Validate uploaded file types and sizes.
- Keep virus scan metadata and scan paths in sync with attachment handling.

## Observability

Sentry is lazy-loaded. Do not eagerly load monitoring in the startup critical path.

Use categorized logging and breadcrumbs for:

- sync transitions
- cloud load failures
- conflict handling
- IndexedDB integrity failures
- permission denied isolation
- recovery events

Global error severity levels:

- `SILENT`
- `NOTIFY`
- `RECOVERABLE`
- `FATAL`

## Recovery and Backup

Recovery paths:

- local IndexedDB persistence
- localStorage emergency fallback for failed IndexedDB writes
- JSON project export/import
- attachment ZIP export/import
- trash restore for deleted and archived tasks
- rejected-data isolation on permission denial
- optional desktop local backups

Do not remove recovery paths as part of cleanup unless an equivalent or stronger recovery path is already implemented and verified.

## Performance Gates

Performance verification includes:

- startup guard
- no-JIT guard
- launch artifact closure checks
- font subset contract
- Supabase-ready contract
- weak-network and resume Playwright tests

Primary command:

```bash
npm run perf:guard
```

See the non-Context7 runbook at `docs/perf-gate-runbook.md` for operational details.
