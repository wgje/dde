---
title: Example - Add a Context7 Doc Page
status: canonical
audience: ai-agent, maintainer
last_verified: 2026-06-09
source_paths:
  - docs/context7/
  - scripts/validate-context7-docs.cjs
  - llms.txt
  - docs/context7/catalog.json
---

# Example - Add a Context7 Doc Page

## Steps

1. Choose the correct directory.
2. Add metadata frontmatter.
3. Add H1 and stable headings.
4. Link from `docs/context7/README.md`.
5. Reference from `llms.txt`.
6. Categorize in `docs/context7/catalog.json`.
7. Run validation.

## Metadata Template

```yaml
---
title: New Page
status: canonical
audience: ai-agent, maintainer
last_verified: 2026-06-09
source_paths:
  - src/path-or-doc-path
---
```
