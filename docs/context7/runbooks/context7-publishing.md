---
title: Context7 Publishing Runbook
status: canonical
audience: maintainer, operator, ai-agent
last_verified: 2026-06-09
source_paths:
  - context7.json
  - llms.txt
  - docs/context7/
  - scripts/validate-context7-docs.cjs
  - .github/workflows/context7-refresh.yml
---

# Context7 Publishing Runbook

Use this runbook to publish, refresh, or troubleshoot NanoFlow's Context7 documentation.

## Publishing Goal

Context7 should retrieve stable, precise, project-level documentation rather than raw source noise or historical planning documents.

The canonical corpus is:

```text
docs/context7/
```

## Pre-Publish Checklist

Run:

```bash
npm run docs:context7:validate
```

Confirm:

- `context7.json` includes only `docs/context7`
- every Markdown page has metadata
- every canonical page is linked from `README.md`
- `llms.txt` references every canonical page
- JSON schema files parse
- no unresolved placeholder markers
- no broken relative links

## Context7 Submission

Public repository:

1. Commit `context7.json`, `llms.txt`, and `docs/context7/**`.
2. Submit the GitHub repository through Context7 add-library.
3. Expected library ID format: `/owner/repo`.
4. After library ID is known, set GitHub variable `CONTEXT7_LIBRARY_ID`.

Private repository:

1. Connect repository in Context7 private sources.
2. Ensure Context7 has access to `context7.json` and `docs/context7/**`.
3. If required, provide a Git token through Context7 private source configuration.

## Refresh Workflow

Workflow:

```text
.github/workflows/context7-refresh.yml
```

Triggers:

- push to `main` when Context7 docs/config changed
- manual workflow dispatch

Required secret:

- `CONTEXT7_API_KEY`

Optional variable:

- `CONTEXT7_LIBRARY_ID`

If the secret is missing, the workflow validates docs and skips refresh.

## Troubleshooting

| Problem | Check |
| --- | --- |
| Context7 returns stale docs | Was refresh workflow triggered? Is `CONTEXT7_API_KEY` configured? |
| Context7 retrieves old plans | Confirm `context7.json.folders = ["docs/context7"]`. |
| Context7 misses new page | Is it under `docs/context7` and referenced from README + `llms.txt`? |
| Parser includes source code | Confirm `src` is excluded and `folders` is narrow. |
| Workflow skipped refresh | Check secret and workflow condition. |
| Docs validator fails | Run local validator and fix exact missing file/link/metadata. |

## Maintenance Rule

Any architecture, sync, data model, security, operations, or agent-rule change must update the matching Context7 page in the same change.
