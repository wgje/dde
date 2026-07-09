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
