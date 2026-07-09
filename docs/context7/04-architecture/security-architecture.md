---
title: Security Architecture
status: canonical
audience: ai-agent, maintainer, operator
last_verified: 2026-06-09
source_paths:
  - supabase/migrations/
  - supabase/functions/
  - .env.template
---

# Security Architecture

Security boundaries:

- browser uses anon key only
- RLS isolates user data
- Edge Functions own secret calls
- Storage bucket `attachments` is private
- Markdown is sanitized
- file uploads are validated

Read:

- [../contracts/security-contract.md](../contracts/security-contract.md)
- [../operations-security.md](../operations-security.md)
- [../reference/supabase-schema-reference.md](../reference/supabase-schema-reference.md)
