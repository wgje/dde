---
title: Verification
status: canonical
audience: ai-agent, maintainer
last_verified: 2026-06-09
source_paths:
  - package.json
  - scripts/run-test-matrix.cjs
  - scripts/validate-context7-docs.cjs
---

# Verification

## Documentation

```bash
npm run docs:context7:validate
```

## Unit and Service Tests

```bash
npm run test:run:pure
npm run test:run:services
npm run test:run:components
```

## Local Default

```bash
npm run test
```

## Full Local Verification

```bash
npm run test:run:verify
```

## E2E

```bash
npm run test:e2e
```

## Performance Gate

```bash
npm run perf:guard
```

## Change-to-Verification Routing

| Change | Minimum verification |
| --- | --- |
| Context7 docs | `npm run docs:context7:validate` |
| model fields | targeted tests plus docs validation |
| sync services | `npm run test:run:services` plus docs validation |
| UI components | `npm run test:run:components` |
| Flow/GoJS lifecycle | component tests plus browser verification when rendering changes |
| security/schema | secret audit, contract tests, docs validation |
