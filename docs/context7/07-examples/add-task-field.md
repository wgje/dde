---
title: Example - Add a Task Field
status: canonical
audience: ai-agent, maintainer
last_verified: 2026-06-09
source_paths:
  - src/models/
  - src/config/sync.config.ts
  - supabase/migrations/
---

# Example - Add a Task Field

## Steps

1. Add the TypeScript field to `Task`.
2. Add a Supabase migration if cloud-persisted.
3. Add the field to task selectors in `FIELD_SELECT_CONFIG`.
4. Update row mapper.
5. Update import/export.
6. Update tests.
7. Update [../reference/model-field-reference.md](../reference/model-field-reference.md).
8. Update [../schemas/nanoflow-domain.schema.json](../schemas/nanoflow-domain.schema.json) if it belongs in public domain summary.
9. Run validation.

## Verification

```bash
npm run docs:context7:validate
npm run test:run:services
```
