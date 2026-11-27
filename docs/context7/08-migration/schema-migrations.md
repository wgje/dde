---
title: Schema Migrations
status: canonical
audience: ai-agent, maintainer, operator
last_verified: 2026-06-09
source_paths:
  - supabase/migrations/
  - src/models/
  - src/config/sync.config.ts
---

# Schema Migrations

Use [../migration-playbook.md](../migration-playbook.md) as the full checklist.

## Required Updates

- migration SQL
- model fields
- Supabase row types
- field selectors
- row mappers
- import/export
- tests
- Context7 reference docs

## Verification

```bash
npm run docs:context7:validate
npm run test:run:services
```

## Production drift repair: bounded project-head page

The client-side project probe calls the bounded owner-scoped
`list_project_heads_page(timestamptz, timestamptz, timestamptz, uuid, integer)`
RPC. If a target project has the legacy `list_project_heads_since` function but
not the bounded page function, apply the forward repair migration
`20261127081154_restore_project_head_keyset_rpc.sql`. It changes no business
rows: it restores the stable invoker function, limits pages to 100 rows, keeps
the composite `(updated_at, project_id)` cursor deterministic, grants execute
only to `authenticated`, and revokes the retired unbounded function grant.
