---
title: Supabase File Conventions
status: canonical
audience: ai-agent, maintainer, operator
last_verified: 2026-06-09
source_paths:
  - supabase/functions/
  - supabase/migrations/
  - scripts/supabase-cli.cjs
---

# Supabase File Conventions

## Migrations

Path:

```text
supabase/migrations/
```

Rules:

- Use timestamped filenames.
- Include RLS changes with new tables.
- Prefer additive migrations.
- Document destructive migrations and recovery path.

## Edge Functions

Path:

```text
supabase/functions/<function-name>/
```

Rules:

- shared code belongs in `_shared`.
- validate input at the function boundary.
- keep secrets server-side.
- update [../03-api-reference/edge-functions.md](../03-api-reference/edge-functions.md).
