---
title: Documentation Quality Gate
status: canonical
audience: ai-agent, maintainer
last_verified: 2026-06-11
source_paths:
  - scripts/validate-context7-docs.cjs
  - scripts/contracts/check-context7-coupled-changes.cjs
  - context7.json
  - llms.txt
  - docs/context7/
---

# Documentation Quality Gate

NanoFlow treats Context7 documentation as a maintained product. This page defines the quality bar.

## Required Qualities

| Quality | Requirement |
| --- | --- |
| Precise | Names exact files, symbols, constants, and commands. |
| Current | States `last_verified` and uses current source paths. |
| Machine-readable | Uses stable headings, tables, metadata, and short retrieval routes. |
| Complete | Covers overview, architecture, models, sync, security, UI lifecycle, operations, and source maps. |
| Actionable | Tells maintainers what to inspect, run, or update. |
| Non-noisy | Excludes archives, generated output, source dumps, and historical plans from Context7. |
| Testable | Has a validator, live consistency guard, and CI refresh workflow. |
| Drift-resistant | Source/config/schema changes must include a Context7 companion update. |

## Metadata Gate

Every Markdown page under `docs/context7` must include metadata:

```yaml
---
title: Page Title
status: canonical
audience: ai-agent, maintainer
last_verified: 2026-06-11
source_paths:
  - path/or/glob
---
```

ADR pages may use `status: accepted`.

## Linking Gate

Every canonical page must be:

- present under `docs/context7`
- linked or mentioned from `docs/context7/README.md`
- referenced from `llms.txt`
- included in the validator required file list

## Live Consistency Gate

Code changes must not silently make Context7 stale. The live consistency guard checks changed files and blocks implementation-affecting changes that do not include a matching Context7 documentation update.

Use `npm run docs:context7:guard` for the current working tree. Use `npm run quality:guard:context7-coupled` for staged files or CI commit ranges.

| Changed surface | Expected Context7 companion |
| --- | --- |
| Architecture, stores, features, services, models | `docs/context7/architecture.md`, `docs/context7/source-map.md`, API reference, or related guide |
| Sync/offline/retry/conflict behavior | `docs/context7/sync-offline.md`, `docs/context7/contracts/sync-contract.md`, sync API reference, or runbook |
| Config, toolchain, verification commands | `docs/context7/reference/configuration-reference.md`, `docs/context7/development.md`, compatibility/versioning docs |
| Supabase migrations, schema, Edge Functions | model field reference, Supabase schema reference, Edge Function API, migration docs |
| Auth, secrets, upload, Sentry, operational behavior | security contract, operations-security, error docs, or runbook |

## Content Gate

Each topic page should answer:

1. What is this?
2. What source paths own it?
3. What invariants must be preserved?
4. What commands verify it?
5. What related page should be updated if behavior changes?

## Validation Command

Run:

```bash
npm run docs:context7:guard
```

The guard runs the validator and the live consistency check. The validator checks:

- required file existence
- metadata presence
- Context7 config fields
- `llms.txt` coverage
- README coverage
- relative Markdown links
- JSON schema parsing
- no unresolved placeholder markers
- `source_paths` resolve to real files, directories, or glob matches
- root and numbered Next.js-style section indexes are present

The live consistency check verifies that source/config/schema changes include a Context7 companion update in the same change.

## Review Checklist

Before merging documentation changes:

1. Run `npm run docs:context7:guard`.
2. Check that new docs are discoverable from README and `llms.txt`.
3. Confirm source paths exist or intentionally use globs/directories.
4. Confirm the page is not a historical plan disguised as canonical documentation.
5. Confirm exact commands and constants match current files.
