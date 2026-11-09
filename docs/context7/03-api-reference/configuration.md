---
title: Configuration API Reference
status: canonical
audience: ai-agent, maintainer
last_verified: 2026-06-09
source_paths:
  - src/config/
  - docs/context7/reference/configuration-reference.md
---

# Configuration API Reference

Use [../reference/configuration-reference.md](../reference/configuration-reference.md) for exact values.

## Config Modules

| Module | Purpose |
| --- | --- |
| `sync.config.ts` | sync, retry, throttling, circuit breaker, cache |
| `focus.config.ts` | Gate, Strata, Black Box, speech-to-text |
| `parking.config.ts` | Dock, Focus Console, scheduling, animation |
| `layout.config.ts` | Flow layout, GoJS, floating tree |
| `timeout.config.ts` | timeout and retry policies |
| `auth.config.ts` | auth and route guard timing |
| `feature-flags.config.ts` | static and runtime feature flags |

## Config Rules

- Do not duplicate magic numbers.
- Update reference docs when changing constants.
- Critical feature flags require risk review.
