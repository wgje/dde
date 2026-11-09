---
title: NanoFlow Context7 Documentation
status: canonical
audience: ai-agent, maintainer, operator
last_verified: 2026-06-11
source_paths:
  - context7.json
  - llms.txt
  - docs/context7/
  - scripts/contracts/check-context7-coupled-changes.cjs
---

# NanoFlow Context7 Documentation

This directory is the canonical, machine-readable documentation corpus for NanoFlow. It is intentionally smaller and more structured than the full repository documentation so Context7 and AI coding assistants can retrieve precise project facts without pulling historical plans, generated output, or implementation noise.

## Project Identity

- **Name:** NanoFlow
- **Package:** `nanoflow-project-tracker`
- **Type:** private Angular PWA
- **Primary user:** one person using multiple devices
- **Core promise:** offline-first task workflow with immediate local writes and background cloud sync
- **Current date baseline:** 2026-06-09

## Guides

| Page | Use when the question is about |
| --- | --- |
| [index.md](index.md) | root Context7 entry point and Next.js-style documentation usage guide |
| [01-getting-started/index.md](01-getting-started/index.md) | Next.js-style onboarding path: install, structure, concepts, verification |
| [02-guides/index.md](02-guides/index.md) | task-oriented guides |
| [03-api-reference/index.md](03-api-reference/index.md) | exact technical API reference |
| [04-architecture/index.md](04-architecture/index.md) | layered architecture reference |
| [05-file-conventions/index.md](05-file-conventions/index.md) | file placement conventions |
| [06-errors/index.md](06-errors/index.md) | error reference and fix routes |
| [07-examples/index.md](07-examples/index.md) | implementation examples |
| [08-migration/index.md](08-migration/index.md) | migration and versioning |
| [overview.md](overview.md) | product scope, capabilities, boundaries |
| [architecture.md](architecture.md) | modules, stores, services, rendering, dependency rules |
| [data-model.md](data-model.md) | Task, Project, Connection, Parking Dock, Focus, Black Box fields |
| [sync-offline.md](sync-offline.md) | IndexedDB, Supabase sync, RetryQueue, LWW, conflict handling |
| [feature-workflows.md](feature-workflows.md) | Text, Flow, Parking Dock, Focus, Black Box, Android widget workflows |
| [api-edge-functions.md](api-edge-functions.md) | Supabase Edge Functions, storage, speech transcription, widget APIs |
| [development.md](development.md) | setup, commands, tests, quality gates |
| [operations-security.md](operations-security.md) | deployment, observability, RLS, secrets, recovery |
| [agent-rules.md](agent-rules.md) | rules AI agents must follow when changing the project |
| [context7-maintenance.md](context7-maintenance.md) | how Context7 indexing is configured and maintained |
| [source-map.md](source-map.md) | route common AI questions to source paths and docs |

## Reference

| Page | Use when the question is about |
| --- | --- |
| [reference/configuration-reference.md](reference/configuration-reference.md) | exact config constants, feature flags, timeouts, quotas |
| [reference/service-catalog.md](reference/service-catalog.md) | service ownership and source boundaries |
| [reference/model-field-reference.md](reference/model-field-reference.md) | field-level TypeScript domain model reference |
| [reference/supabase-schema-reference.md](reference/supabase-schema-reference.md) | cloud schema concepts, migrations, Edge Functions, RLS expectations |

## Contracts

| Page | Use when the question is about |
| --- | --- |
| [contracts/sync-contract.md](contracts/sync-contract.md) | offline-first sync invariants, retry queue, tombstones, field selectors |
| [contracts/security-contract.md](contracts/security-contract.md) | secrets, RLS, Edge Functions, uploads, sanitization |
| [contracts/ui-lifecycle-contract.md](contracts/ui-lifecycle-contract.md) | mobile default, GoJS lifecycle, shell startup, Focus/Parking UI |

## Runbooks

| Page | Use when the question is about |
| --- | --- |
| [runbooks/sync-debugging.md](runbooks/sync-debugging.md) | stale data, retry loops, tombstone issues, field loss |
| [runbooks/data-recovery.md](runbooks/data-recovery.md) | missing data, IndexedDB fallback, imports, rejected writes |
| [runbooks/context7-publishing.md](runbooks/context7-publishing.md) | publishing, refreshing, and troubleshooting Context7 indexing |

## Decisions, Schemas, Quality

| Page | Use when the question is about |
| --- | --- |
| [adr/0001-context7-canonical-corpus.md](adr/0001-context7-canonical-corpus.md) | why Context7 indexes only this corpus |
| [adr/0002-offline-first-lww-sync.md](adr/0002-offline-first-lww-sync.md) | why NanoFlow uses offline-first LWW sync |
| [schemas/context7-doc-page.schema.json](schemas/context7-doc-page.schema.json) | metadata contract for documentation pages |
| [schemas/nanoflow-domain.schema.json](schemas/nanoflow-domain.schema.json) | machine-readable domain model summary |
| [quality/documentation-quality-gate.md](quality/documentation-quality-gate.md) | documentation quality bar and validation rules |
| [quality/nextjs-parity-checklist.md](quality/nextjs-parity-checklist.md) | checklist for `/vercel/next.js`-style Context7 parity |

## Governance and Catalog

| Page | Use when the question is about |
| --- | --- |
| [catalog.json](catalog.json) | machine-readable category and retrieval route catalog |
| [glossary.md](glossary.md) | shared terminology and naming rules |
| [compatibility-matrix.md](compatibility-matrix.md) | supported toolchain, browser, cloud, and deployment baseline |
| [migration-playbook.md](migration-playbook.md) | database/model/sync/documentation migration sequence |
| [documentation-contribution.md](documentation-contribution.md) | how to add or update Context7 documentation without degrading retrieval |

## Numbered Section Pages

These pages intentionally mirror the `/vercel/next.js` style of sorted documentation sections.

| Section | Pages |
| --- | --- |
| `01-getting-started` | [01-installation.md](01-getting-started/01-installation.md), [02-project-structure.md](01-getting-started/02-project-structure.md), [03-core-concepts.md](01-getting-started/03-core-concepts.md), [04-verification.md](01-getting-started/04-verification.md) |
| `02-guides` | [ai-agents.md](02-guides/ai-agents.md), [sync-workflow.md](02-guides/sync-workflow.md), [focus-parking-workflow.md](02-guides/focus-parking-workflow.md), [supabase-operations.md](02-guides/supabase-operations.md) |
| `03-api-reference` | [stores.md](03-api-reference/stores.md), [sync-services.md](03-api-reference/sync-services.md), [models.md](03-api-reference/models.md), [edge-functions.md](03-api-reference/edge-functions.md), [configuration.md](03-api-reference/configuration.md) |
| `04-architecture` | [runtime-architecture.md](04-architecture/runtime-architecture.md), [sync-architecture.md](04-architecture/sync-architecture.md), [security-architecture.md](04-architecture/security-architecture.md), [ui-lifecycle.md](04-architecture/ui-lifecycle.md) |
| `05-file-conventions` | [angular-files.md](05-file-conventions/angular-files.md), [service-files.md](05-file-conventions/service-files.md), [supabase-files.md](05-file-conventions/supabase-files.md), [documentation-files.md](05-file-conventions/documentation-files.md) |
| `06-errors` | [sync-errors.md](06-errors/sync-errors.md), [auth-security-errors.md](06-errors/auth-security-errors.md), [ui-runtime-errors.md](06-errors/ui-runtime-errors.md) |
| `07-examples` | [add-task-field.md](07-examples/add-task-field.md), [add-edge-function.md](07-examples/add-edge-function.md), [add-context7-doc-page.md](07-examples/add-context7-doc-page.md) |
| `08-migration` | [versioning.md](08-migration/versioning.md), [schema-migrations.md](08-migration/schema-migrations.md), [docs-migrations.md](08-migration/docs-migrations.md) |

## Machine Retrieval Contract

Use these documents as the stable source of truth for project-level explanations. Use source files only when a task requires current implementation details beyond these docs.

Rules for maintaining this corpus:

1. Keep pages topic-focused.
2. Prefer explicit names, paths, commands, field names, and config values.
3. Avoid vague roadmap prose.
4. Link to canonical source paths when useful.
5. Update docs in the same change as architecture, sync, model, security, or workflow changes.
6. Include metadata on every Markdown page.
7. Run `npm run docs:context7:guard` before submitting code or documentation changes that can affect Context7 accuracy.

## Context7 Configuration

The root `context7.json` includes only `docs/context7`. That is deliberate. Existing files in `docs/` include large plans and historical audits; they remain available to maintainers, but they are not the primary machine-consumption corpus.
