---
title: Auth and Security Errors
status: canonical
audience: ai-agent, maintainer, operator
last_verified: 2026-06-09
source_paths:
  - src/services/auth*.ts
  - supabase/migrations/
  - scripts/contracts/check-secrets.cjs
---

# Auth and Security Errors

| Symptom | Likely cause | Fix route |
| --- | --- | --- |
| user cannot read own project | RLS policy mismatch or wrong owner field | inspect migration and auth user |
| offline edits rejected after reconnect | permission denied after local writes | use rejected-data isolation |
| secret detected in source | key committed or template misuse | run `npm run audit:secrets` |
| Edge Function CORS error | function response missing expected headers | inspect function boundary |
| upload denied | storage policy or path ownership mismatch | inspect storage RLS |

Read [../contracts/security-contract.md](../contracts/security-contract.md).
