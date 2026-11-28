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

## 2026-11-28 sync safety migrations

- `20261128090000_atomic_focus_routine_owner_upsert.sql`: drift-gated forward patch for Focus Session and routine-task RPC conflict updates. The live body MD5 must match the reviewed preimage; otherwise the migration fails closed. The conflict `UPDATE` is filtered by `user_id = auth.uid()` and a zero-row `RETURNING` result is logged as `unauthorized`. No business rows or Auth rows are rewritten.
- `20261128100000_offline_command_receipt_identity.sql`: adds nullable `sync_command_log.command_digest`, installs a stable identity helper, and binds normal/unique-violation replay to the identity and digest. Historical NULL-digest receipts remain reconciliation-pending. The fresh-init script contains the same final convergence block.

Before production application, capture target-bound migration and function evidence, run the migration in a disposable clone or approved branch, verify readback and owner-isolation behavior, and retain a rollback/export path. A generated Supabase type snapshot reflects the linked schema at generation time and does not prove either migration has been deployed.