---
title: Context7 Maintenance
status: canonical
audience: ai-agent, maintainer, operator
last_verified: 2026-06-11
source_paths:
  - context7.json
  - llms.txt
  - scripts/validate-context7-docs.cjs
  - .github/workflows/context7-refresh.yml
---

# Context7 Maintenance

NanoFlow uses a dedicated Context7 documentation corpus to make AI retrieval precise.

## Files

| File | Purpose |
| --- | --- |
| `context7.json` | Context7 indexing metadata and parsing policy |
| `llms.txt` | AI retrieval map for tools that read LLM entry files |
| `docs/context7/index.md` | root Next.js-style documentation entry point |
| `docs/context7/README.md` | canonical docs table of contents |
| `docs/context7/*.md` | focused machine-readable pages |
| `scripts/validate-context7-docs.cjs` | local validator |
| `scripts/contracts/check-context7-coupled-changes.cjs` | live consistency guard for source/config/schema changes |
| `.github/workflows/context7-refresh.yml` | optional validation and Context7 refresh workflow |

## Indexing Policy

`context7.json` includes:

```json
{
  "folders": ["docs/context7"]
}
```

The include list is intentionally narrow.

Excluded material includes:

- source code
- tests
- build output
- archives
- historical plans
- generated reports
- local worktrees
- AI conversation logs
- dependency folders

This prevents Context7 from retrieving stale plans or noisy implementation details when the user asks project-level questions.

## When to Update Docs

Update `docs/context7` when changing:

- architecture
- state stores
- sync/offline behavior
- database models
- Supabase functions
- security rules
- feature workflows
- verification commands
- Context7 indexing behavior
- AI agent instructions

Do not duplicate every code detail. The canonical docs should explain durable contracts and point to source paths for exact implementation.

## Live Consistency Guard

NanoFlow code changes continuously, so Context7 accuracy is enforced in two layers:

1. `npm run docs:context7:validate` checks that the corpus is internally valid: required files exist, links resolve, JSON parses, metadata is present, `source_paths` resolve, and catalog/LLM routes cover the pages.
2. `npm run docs:context7:guard` checks the current working tree. Source, model, config, migration, Edge Function, sync, security, and UI lifecycle changes must include a companion Context7 documentation update in the same working tree.
3. `npm run quality:guard:context7-coupled` checks staged files or the current commit range. Use this for commit hooks and CI because it proves the submitted change itself contains the documentation companion.

Use:

```bash
npm run docs:context7:guard
```

This command runs both layers. It is the preferred gate when code and documentation may have drifted.

## Validation

Run:

```bash
npm run docs:context7:guard
```

The validator checks:

- required canonical files exist
- `context7.json` parses
- Context7 schema URL is present
- included folders contain `docs/context7`
- common noisy folders are excluded
- rules include core NanoFlow constraints
- relative Markdown links resolve
- `llms.txt` references canonical docs
- `source_paths` resolve to real files, directories, or glob matches
- implementation-affecting changes include a Context7 companion update

## Context7 Submission

For public indexing:

1. Ensure the repository is accessible to Context7.
2. Keep `context7.json` at the repository root.
3. Submit the repository through the Context7 add-library flow.
4. Expected public library ID format for GitHub repositories is `/owner/repo`.

For private indexing:

1. Connect the private repository or source in Context7.
2. Provide access through the supported private source mechanism.
3. Keep `context7.json` committed so the parser has the same include policy.

## Refresh Automation

A refresh workflow is provided at `.github/workflows/context7-refresh.yml`. It validates the canonical docs on pushes to Context7-relevant files and calls the Context7 refresh API when `CONTEXT7_API_KEY` is configured.

Configuration:

- GitHub secret: `CONTEXT7_API_KEY`
- optional GitHub variable: `CONTEXT7_LIBRARY_ID`
- default library ID in the workflow: `/dydyde/dde`

Example shape:

```yaml
name: Refresh Context7 Docs

on:
  push:
    branches:
      - main
    paths:
      - "context7.json"
      - "llms.txt"
      - "docs/context7/**"

jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger Context7 Refresh
        run: |
          curl -s -X POST https://context7.com/api/v1/refresh \
            -H "Content-Type: application/json" \
            -H "Authorization: Bearer ${{ secrets.CONTEXT7_API_KEY }}" \
            -d '{"libraryName": "/owner/repo"}'
```

Replace `/owner/repo` with the actual Context7 library ID after submission.

## Writing Style

Good Context7 pages:

- start with one clear purpose
- use stable headings
- list exact paths and symbols
- use tables for facts
- keep historical discussion out
- avoid unresolved placeholder markers
- state constraints as direct rules
- keep examples short and current
- update the matching Context7 page in the same change as code when behavior, contracts, configuration, or schema changes
