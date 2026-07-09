---
title: Documentation Migrations
status: canonical
audience: ai-agent, maintainer
last_verified: 2026-06-09
source_paths:
  - docs/context7/
  - docs/context7/catalog.json
  - scripts/validate-context7-docs.cjs
---

# Documentation Migrations

When changing the Context7 documentation structure:

1. Add or move pages under `docs/context7`.
2. Preserve metadata frontmatter.
3. Update README.
4. Update `llms.txt`.
5. Update `catalog.json`.
6. Update validator rules when category requirements change.
7. Run validation.

```bash
npm run docs:context7:validate
```
