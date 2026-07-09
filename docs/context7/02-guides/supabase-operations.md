---
title: Supabase Operations Guide
status: canonical
audience: ai-agent, maintainer, operator
last_verified: 2026-06-09
source_paths:
  - supabase/functions/
  - supabase/migrations/
  - scripts/supabase-cli.cjs
  - .env.template
---

# Supabase Operations Guide

Use this guide for Supabase schema, functions, storage, and secrets changes.

## Commands

```bash
npm run supabase:login
npm run supabase:link
npm run supabase:db:push
npm run supabase:functions:serve
npm run supabase:functions:deploy
npm run supabase:secrets:set
```

## Secrets

Secrets belong in Supabase Secrets or CI/deployment secrets, not frontend source.

Common secrets:

- `GROQ_API_KEY`
- FCM service account values
- Supabase access/service credentials
- Sentry auth token

## Required Docs

When changing Supabase behavior, update:

- [../reference/supabase-schema-reference.md](../reference/supabase-schema-reference.md)
- [../contracts/security-contract.md](../contracts/security-contract.md)
- [../api-edge-functions.md](../api-edge-functions.md)
- [../migration-playbook.md](../migration-playbook.md)
