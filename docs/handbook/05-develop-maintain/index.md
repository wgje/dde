---
title: Develop and Maintain
status: canonical
audience: contributor, maintainer, ai-agent
last_verified: 2026-06-11
category: develop-maintain
source_paths:
  - AGENTS.md
  - package.json
  - src/
  - scripts/
  - docs/context7/
---

# Develop and Maintain

This section is for contributors and AI-assisted maintainers. It explains how to work in the repository without breaking offline-first behavior, sync contracts, mobile performance, or documentation accuracy.

## In This Article

- [Recommended path](#recommended-path)
- [Articles](#articles)
- [Maintenance rules](#maintenance-rules)
- [Next steps](#next-steps)

## Recommended Path

1. Prepare the environment with [Development Environment](01-development-environment.md).
2. Locate ownership boundaries with [Repository Map](02-repository-map.md).
3. Pick the smallest meaningful verification gate with [Testing and Quality](03-testing-and-quality.md).
4. Use [Runtime Entry and Activity Audit](05-runtime-entry-activity-audit.md) when changing interaction entries, timers, subscriptions, background queues, or recovery flows.
5. Keep docs current with [Documentation Maintenance](04-documentation-maintenance.md).

## Articles

| Article | Use it when |
| --- | --- |
| [Development Environment](01-development-environment.md) | You need to install, run, or configure local tooling |
| [Repository Map](02-repository-map.md) | You need to find the right source area |
| [Testing and Quality](03-testing-and-quality.md) | You need to choose a verification command |
| [Documentation Maintenance](04-documentation-maintenance.md) | You changed behavior, data, operations, or docs |
| [Runtime Entry and Activity Audit](05-runtime-entry-activity-audit.md) | You need to harden interaction entries, self-running activities, and async business chains |

## Maintenance Rules

- Start repository work from CodeGraph context when an agent is doing the change.
- Reuse existing stores and services instead of adding parallel abstractions.
- Keep sync, offline, GoJS lifecycle, and security hard rules intact.
- Update the human handbook for reader-facing behavior changes.
- Update Context7 docs for source contracts, APIs, schemas, and agent retrieval.

## Next Steps

- Use [Repository Map](02-repository-map.md) to find the owner of a behavior.
- Run [Testing and Quality](03-testing-and-quality.md) before claiming a change is complete.
- Continue chain hardening from [Runtime Entry and Activity Audit](05-runtime-entry-activity-audit.md).
