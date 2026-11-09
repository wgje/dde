---
title: Versioning
status: canonical
audience: ai-agent, maintainer, operator
last_verified: 2026-06-09
source_paths:
  - package.json
  - docs/context7/compatibility-matrix.md
---

# Versioning

NanoFlow is currently a private application package. Compatibility is documented through:

- `package.json`
- [../compatibility-matrix.md](../compatibility-matrix.md)
- Supabase migrations
- Context7 `last_verified` metadata

## Rules

- Toolchain upgrades update compatibility docs.
- Schema changes use timestamped migrations.
- Snapshot format changes update version fields and migration logic.
- Context7 docs use `last_verified` to show review date.
