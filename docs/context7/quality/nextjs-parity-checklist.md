---
title: Next.js Context7 Parity Checklist
status: canonical
audience: ai-agent, maintainer
last_verified: 2026-06-11
source_paths:
  - docs/context7/
  - context7.json
  - llms.txt
  - docs/context7/catalog.json
  - scripts/contracts/check-context7-coupled-changes.cjs
---

# Next.js Context7 Parity Checklist

NanoFlow's Context7 corpus is designed to match the retrieval qualities that make `/vercel/next.js` effective: ordered documentation sections, task guides, API reference, file conventions, architecture pages, error docs, examples, migrations, and AI-specific routing.

## Required Structure

| Capability | NanoFlow path |
| --- | --- |
| Root documentation index | `docs/context7/index.md` |
| Getting started | `docs/context7/01-getting-started/` |
| Guides | `docs/context7/02-guides/` |
| API reference | `docs/context7/03-api-reference/` |
| Architecture | `docs/context7/04-architecture/` |
| File conventions | `docs/context7/05-file-conventions/` |
| Error reference | `docs/context7/06-errors/` |
| Examples | `docs/context7/07-examples/` |
| Migration/versioning | `docs/context7/08-migration/` |
| AI agent guide | `docs/context7/02-guides/ai-agents.md` |
| Machine catalog | `docs/context7/catalog.json` |
| LLM entry route | `llms.txt` |
| Context7 parser config | `context7.json` |

## Required Qualities

| Quality | Requirement |
| --- | --- |
| Ordered navigation | numbered sections sort in intended learning/reference order |
| Accurate retrieval | `llms.txt` maps common questions to exact pages |
| API precision | `03-api-reference` and `reference` pages name exact stores, models, services, configs |
| File conventions | `05-file-conventions` tells agents where code belongs |
| Error routing | `06-errors` maps symptoms to owner layers and fix paths |
| Examples | `07-examples` shows safe change patterns |
| Versioning | `08-migration/versioning.md` and compatibility matrix define baselines |
| Extensibility | new pages require README, `llms.txt`, catalog, metadata, validation |
| Live consistency | source/config/schema changes require a Context7 companion update |
| Machine readability | JSON catalog and schemas are valid |
| Quality gate | `npm run docs:context7:guard` enforces structure and code-doc coupling |

## Parity Verification

Run:

```bash
npm run docs:context7:guard
```

Then confirm:

- catalog contains numbered categories
- root `docs/context7/index.md` explains how to use the corpus
- `llms.txt` references all Context7 pages
- every Markdown page has metadata
- every JSON file parses
- README links every Context7 file
- Context7 rules mention numbered sections, API reference, file conventions, errors, examples, migration, and versioning
- source/config/schema changes are blocked unless the same change updates the matching Context7 docs

## Maintenance Rule

If `/vercel/next.js`-style documentation expectations expand, update this checklist first, then update the validator so the expectation becomes enforceable.
