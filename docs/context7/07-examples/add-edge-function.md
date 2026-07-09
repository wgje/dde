---
title: Example - Add an Edge Function
status: canonical
audience: ai-agent, maintainer, operator
last_verified: 2026-06-09
source_paths:
  - supabase/functions/
  - docs/context7/reference/supabase-schema-reference.md
---

# Example - Add an Edge Function

## Steps

1. Create `supabase/functions/<function-name>/`.
2. Put shared helpers in `supabase/functions/_shared/` when needed.
3. Validate input at function boundary.
4. Check auth for user data.
5. Store secrets in Supabase Secrets.
6. Update [../03-api-reference/edge-functions.md](../03-api-reference/edge-functions.md).
7. Update [../reference/supabase-schema-reference.md](../reference/supabase-schema-reference.md).
8. Update [../contracts/security-contract.md](../contracts/security-contract.md).

## Verification

```bash
npm run docs:context7:validate
npm run audit:secrets
```
