---
title: Production Recovery and CI Compatibility
status: canonical
audience: ai-agent, maintainer, operator
last_verified: 2026-11-26
source_paths:
  - .github/workflows/test-full-suite.yml
  - .github/workflows/perf-and-resume-gates.yml
  - scripts/contracts/codegraph-overlay-generation-v1.json
  - scripts/contracts/codegraph-nanoflow-overlay-v1.json
  - scripts/lib/codegraph-nanoflow-overlay-v1-schema-graph.cjs
  - src/app/features/flow/
  - src/app/features/parking/
  - src/services/
---

# Production Recovery and CI Compatibility

This page records the compatibility boundary used while recovering NanoFlow production paths. It is a companion to the architecture, sync, and operations pages; it does not authorize a production release.

## CodeGraph ordering contract

The overlay schema uses the `pinned-icu-collator-v1` ordering contract with locale `zh-CN` and ICU `77.1`. The validator compares the runtime collator options and ICU major version before accepting an artifact. CI jobs that execute CodeGraph or perf/resume checks therefore pin Node `24.11.1`, whose bundled ICU matches the contract. A floating `node-version: 24` is not equivalent: GitHub can advance it to a different ICU major and fail before the adapter query runs.

The generation contract's `overlaySchemaDigest` must equal the authoritative `schemaDigest` in `codegraph-nanoflow-overlay-v1.json`. A stable publisher must be used to rebuild and atomically select a generation; do not edit `CURRENT.json` or delete a prior generation by hand.

## Startup and client state boundaries

The launch path remains offline-first: local IndexedDB state and pending queues are available before cloud refresh. Flow remains deferred on mobile and must not hold a live GoJS diagram under `visibility:hidden`. Parking/Dock state is owner-scoped and must not populate authenticated users with development demo data. Changes to shell, Flow, Parking, or service state require a matching Context7 documentation update and focused tests.

## Release evidence

A green local or preview build is not production proof. Keep `NO_RELEASE`, `productionProof=false`, and `productionWrites=0` until the candidate has passed full CI, type/lint gates, migration replay and rollback, artifact checks, deployment SHA readback, bounded startup/login/sync smoke, and owner-isolation readback.

## Entry static-closure follow-up (candidate)

Service Worker provider code is loaded in the existing parallel startup-module batch rather than the main static import closure. The composed worker URL, production enablement, post-handoff registration delay and fallback remain unchanged. This reduces eager entry bytes without deleting caches, changing IndexedDB, modifying queues or removing offline registration. Static import-count and byte budgets remain unchanged and must pass against rebuilt production artifacts; source regression checks also retain the provider/strategy contract.

## Font asset recovery (candidate)

Supplementary WenKai Screen 1.7.0 regular WOFF2 faces are served from the same origin rather than a second full CDN stylesheet. Later overlapping font-face declarations take precedence, so the old CDN stylesheet could override already-local subsets. The supplement contains only the remaining 83 subsets, preserving the 14 existing files and their bytes. Keep font-display swap, interaction/timeout loading and the local-fonts lazy service-worker group; do not prefetch every font or wait for fonts before displaying the workspace. Carry upstream SHA evidence and MIT/OFL notices. Uncached glyphs on the first fully offline visit still use system fallback; no claim is made that every glyph is pre-cached.
