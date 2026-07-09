---
title: Documentation Contribution Guide
status: canonical
audience: ai-agent, maintainer
last_verified: 2026-06-11
source_paths:
  - docs/context7/
  - scripts/validate-context7-docs.cjs
  - llms.txt
  - context7.json
---

# Documentation Contribution Guide

This guide explains how to add or update Context7 documentation without degrading retrieval quality.

## Page Types

| Type | Directory | Purpose |
| --- | --- | --- |
| Guide | `docs/context7/*.md` | durable conceptual explanations |
| Reference | `docs/context7/reference/` | exact fields, constants, services, schema facts |
| Contract | `docs/context7/contracts/` | invariants code must preserve |
| Runbook | `docs/context7/runbooks/` | operational debugging and recovery procedures |
| ADR | `docs/context7/adr/` | durable architecture decisions |
| Schema | `docs/context7/schemas/` | machine-readable JSON artifacts |
| Quality | `docs/context7/quality/` | documentation gates |

## Required Steps for a New Page

1. Add metadata frontmatter.
2. Put the page in the correct directory.
3. Link it from [index.md](index.md) when it changes top-level retrieval and from [README.md](README.md).
4. Reference it from root [../../llms.txt](../../llms.txt).
5. Add it to `catalog.json` when it belongs to a retrieval category.
6. Run `npm run docs:context7:guard`.

## Metadata Template

```yaml
---
title: Exact Page Title
status: canonical
audience: ai-agent, maintainer
last_verified: 2026-06-11
source_paths:
  - src/or/config/path.ts
---
```

## Writing Rules

- Prefer tables for facts.
- Prefer exact code paths over vague module names.
- Avoid copying long source code.
- Link to related contracts and references.
- State what must not change.
- Include verification commands when behavior can regress.
- Do not put historical brainstorming in canonical docs.

## Review Rules

Before marking docs complete:

```bash
npm run docs:context7:guard
```

Then check:

- every new page is discoverable
- all relative links work
- source paths are real paths, directories, or intentional globs
- field names match source code
- constants match source code
- source/config/schema changes include a Context7 companion update in the same change
