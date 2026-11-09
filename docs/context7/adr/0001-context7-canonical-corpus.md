---
title: ADR 0001 - Context7 Canonical Corpus
status: accepted
audience: ai-agent, maintainer
last_verified: 2026-06-09
source_paths:
  - context7.json
  - llms.txt
  - docs/context7/
---

# ADR 0001 - Context7 Canonical Corpus

## Status

Accepted.

## Context

NanoFlow contains source code, tests, generated files, long historical plans, archived audits, local worktrees, and AI conversation logs. A broad documentation or repository index gives AI tools too much stale or irrelevant context.

Context7 supports `context7.json` with `folders`, `excludeFolders`, `excludeFiles`, and `rules`. This allows the project to expose a curated corpus rather than the whole repository.

## Decision

NanoFlow uses `docs/context7` as its canonical machine-readable documentation corpus.

`context7.json` includes:

```json
{
  "folders": ["docs/context7"]
}
```

All other high-noise folders are excluded.

## Consequences

Positive:

- AI retrieval receives stable, intentional documentation.
- Historical plans do not compete with current architecture.
- Source paths remain discoverable through source maps and references.
- Validation can enforce documentation quality.

Tradeoffs:

- Maintainers must update `docs/context7` when durable behavior changes.
- Context7 may not directly retrieve source code snippets unless docs link to paths.
- The corpus must be actively curated to avoid becoming stale.

## Alternatives Considered

### Index all docs

Rejected because `docs/` contains large historical plans and audits that are valuable to humans but noisy for AI retrieval.

### Index source code directly

Rejected because source code is too broad and often requires repository-aware tools like codegraph. Context7 should answer project-level and usage-level questions first.

### Keep only `README.md`

Rejected because a single README cannot provide enough structure for contracts, runbooks, schemas, and precise retrieval routing.

## Verification

Run:

```bash
npm run docs:context7:validate
```
