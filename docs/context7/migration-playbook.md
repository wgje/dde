---
title: Migration Playbook
status: canonical
audience: ai-agent, maintainer, operator
last_verified: 2026-06-09
source_paths:
  - supabase/migrations/
  - src/models/
  - src/app/core/services/sync/
  - src/services/import*.ts
  - src/services/export*.ts
---

# Migration Playbook

Use this playbook for database, model, sync, and document-corpus migrations.

## Migration Classes

| Class | Examples | Required docs |
| --- | --- | --- |
| Model field migration | add `attentionMeta`, planning field, completion timestamp | model field reference, domain schema |
| Sync behavior migration | cursor strategy, RetryQueue semantics, tombstone policy | sync contract, sync runbook |
| Supabase schema migration | new table, RLS policy, RPC, index | Supabase schema reference, security contract |
| UI lifecycle migration | Flow lifecycle, Focus snapshot, mobile default | UI lifecycle contract |
| Documentation corpus migration | new category, new validator rules | Context7 maintenance, quality gate, ADR if architectural |

## Required Sequence

1. Define the invariant being changed.
2. Update database migration if cloud-persisted.
3. Update TypeScript models.
4. Update row mappers and field selectors.
5. Update local persistence and import/export if needed.
6. Update tests.
7. Update Context7 docs.
8. Run validation and targeted tests.

## Cloud Field Migration Checklist

For a new persisted task field:

1. Add migration.
2. Add TypeScript field.
3. Add Supabase row mapping.
4. Add field to `FIELD_SELECT_CONFIG`.
5. Add local persistence support.
6. Add import/export support.
7. Add conflict or LWW behavior.
8. Add tests.
9. Update [reference/model-field-reference.md](reference/model-field-reference.md).
10. Update [schemas/nanoflow-domain.schema.json](schemas/nanoflow-domain.schema.json) if the field is part of the public domain summary.

## Rollback Rules

- Do not roll back by deleting local user data.
- Prefer additive migrations.
- If a destructive migration is required, create a backup/export path first.
- Keep old snapshot readers until migration is proven.
- Document rollback in the same change.

## Verification

Minimum:

```bash
npm run docs:context7:validate
npm run test:run:services
```

For database migrations, add Supabase-specific validation or contract tests.
