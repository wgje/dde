---
title: Documentation File Conventions
status: canonical
audience: ai-agent, maintainer
last_verified: 2026-06-09
source_paths:
  - docs/context7/
  - scripts/validate-context7-docs.cjs
---

# Documentation File Conventions

## Numbered Sections

NanoFlow mirrors Next.js-style sorted documentation sections:

- `01-getting-started`
- `02-guides`
- `03-api-reference`
- `04-architecture`
- `05-file-conventions`
- `06-errors`
- `07-examples`
- `08-migration`

## Canonical Support Sections

- `reference`
- `contracts`
- `runbooks`
- `adr`
- `schemas`
- `quality`

## Page Requirements

Every Markdown page requires metadata:

- `title`
- `status`
- `audience`
- `last_verified`
- `source_paths`

Every page must be discoverable through README, `llms.txt`, and `catalog.json`.
