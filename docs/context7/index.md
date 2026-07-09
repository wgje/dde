---
title: NanoFlow Documentation Index
status: canonical
audience: ai-agent, maintainer, operator
last_verified: 2026-06-11
source_paths:
  - context7.json
  - llms.txt
  - docs/context7/README.md
  - docs/context7/catalog.json
  - scripts/contracts/check-context7-coupled-changes.cjs
---

# NanoFlow Documentation Index

This is the root Context7 entry point for NanoFlow. It mirrors the role of the Next.js documentation index: explain how to use the documentation, route common questions to ordered sections, and keep AI retrieval focused on stable project facts.

## How To Use These Docs

Start with the section that matches the task:

| Task | Start here |
| --- | --- |
| Learn or onboard | [01-getting-started/index.md](01-getting-started/index.md) |
| Implement a workflow | [02-guides/index.md](02-guides/index.md) |
| Look up exact stores, models, services, Edge Functions, or configuration | [03-api-reference/index.md](03-api-reference/index.md) |
| Understand system boundaries and data flow | [04-architecture/index.md](04-architecture/index.md) |
| Decide where a new file belongs | [05-file-conventions/index.md](05-file-conventions/index.md) |
| Diagnose a symptom or error | [06-errors/index.md](06-errors/index.md) |
| Copy a safe change pattern | [07-examples/index.md](07-examples/index.md) |
| Change schema, docs, or version policy | [08-migration/index.md](08-migration/index.md) |

## Core Retrieval Routes

| Question | Primary page |
| --- | --- |
| What is NanoFlow? | [overview.md](overview.md) |
| Where is behavior implemented? | [source-map.md](source-map.md) |
| Which service owns this behavior? | [reference/service-catalog.md](reference/service-catalog.md) |
| What fields exist and how are they persisted? | [reference/model-field-reference.md](reference/model-field-reference.md) |
| What sync rules must not regress? | [contracts/sync-contract.md](contracts/sync-contract.md) |
| What security rules must not regress? | [contracts/security-contract.md](contracts/security-contract.md) |
| What UI lifecycle rules must not regress? | [contracts/ui-lifecycle-contract.md](contracts/ui-lifecycle-contract.md) |
| How should an AI agent work in this repo? | [02-guides/ai-agents.md](02-guides/ai-agents.md) |
| How are docs kept accurate while code changes? | [context7-maintenance.md](context7-maintenance.md) |

## Machine-Readable Entry Points

| Entry point | Purpose |
| --- | --- |
| [README.md](README.md) | full human-readable table of contents for this corpus |
| [catalog.json](catalog.json) | machine-readable categories and retrieval routes |
| [../../context7.json](../../context7.json) | Context7 parser configuration from the repository root |
| [../../llms.txt](../../llms.txt) | LLM-oriented retrieval map |

## Retrieval Rules

- Prefer pages under `docs/context7` before historical plans, generated output, or source-wide searches.
- Use exact paths, symbols, constants, and field names from reference pages.
- Use contracts before changing sync, security, offline behavior, GoJS lifecycle, or data model behavior.
- When code, config, schema, or behavior changes, update the matching Context7 page in the same change.
- Run `npm run docs:context7:guard` before treating Context7 as current.
