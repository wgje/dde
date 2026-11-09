---
title: AI Agents Guide
status: canonical
audience: ai-agent
last_verified: 2026-06-09
source_paths:
  - AGENTS.md
  - docs/context7/agent-rules.md
  - docs/context7/source-map.md
---

# AI Agents Guide

This page plays the same role as a framework "AI agents" guide: route agents to current project docs instead of relying on stale memory.

## Required Lookup Order

1. Read [../source-map.md](../source-map.md) for source ownership.
2. Read the relevant contract under [../contracts/](../contracts/sync-contract.md).
3. Read exact reference pages under [../reference/](../reference/service-catalog.md).
4. Inspect targeted source files.
5. Update docs and run validation.

## Do Not Guess

If the task touches sync, security, UI lifecycle, data models, or Supabase, use the matching Context7 page first.

## Required Updates

When behavior changes, update:

- the guide page
- the reference page
- the contract
- a runbook if operation changes
- schema/catalog if machine-readable routes change

Run:

```bash
npm run docs:context7:validate
```
