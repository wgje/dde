# Context7 Commercial-Grade Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade NanoFlow's Context7 corpus from a machine-readable summary to commercial/open-source-grade documentation with references, contracts, runbooks, ADRs, schemas, metadata, and quality gates.

**Architecture:** Preserve the narrow Context7 include path (`docs/context7`) but expand it into a structured documentation product. Add frontmatter-like metadata to every page, split durable facts into reference/runbook/ADR/schema/quality pages, and strengthen validation so the corpus stays precise.

**Tech Stack:** Markdown, Context7 `context7.json`, `llms.txt`, Node.js validation script, GitHub Actions refresh workflow.

---

### Task 1: Define Documentation Product Structure

**Files:**
- Modify: `docs/context7/README.md`
- Modify: `llms.txt`
- Modify: `context7.json`

- [ ] Add commercial-grade categories: guides, reference, contracts, runbooks, ADR, schemas, quality, source map.
- [ ] Add metadata expectations and retrieval routing.
- [ ] Expand Context7 rules so agents preserve the docs system when architecture changes.

### Task 2: Add Reference and Contract Pages

**Files:**
- Create: `docs/context7/reference/configuration-reference.md`
- Create: `docs/context7/reference/service-catalog.md`
- Create: `docs/context7/reference/model-field-reference.md`
- Create: `docs/context7/reference/supabase-schema-reference.md`
- Create: `docs/context7/contracts/sync-contract.md`
- Create: `docs/context7/contracts/security-contract.md`
- Create: `docs/context7/contracts/ui-lifecycle-contract.md`

- [ ] Document config constants, feature flags, stores, services, models, Supabase functions, migrations, sync invariants, security invariants, and UI lifecycle invariants.

### Task 3: Add Runbooks, ADRs, Schemas, and Quality Pages

**Files:**
- Create: `docs/context7/runbooks/sync-debugging.md`
- Create: `docs/context7/runbooks/data-recovery.md`
- Create: `docs/context7/runbooks/context7-publishing.md`
- Create: `docs/context7/adr/0001-context7-canonical-corpus.md`
- Create: `docs/context7/adr/0002-offline-first-lww-sync.md`
- Create: `docs/context7/schemas/context7-doc-page.schema.json`
- Create: `docs/context7/schemas/nanoflow-domain.schema.json`
- Create: `docs/context7/quality/documentation-quality-gate.md`

- [ ] Add operational procedures, architectural decisions, machine-readable schema artifacts, and quality gates.

### Task 4: Strengthen Validation

**Files:**
- Modify: `scripts/validate-context7-docs.cjs`

- [ ] Require all canonical docs and subdirectory docs.
- [ ] Require metadata fields in every Markdown page.
- [ ] Require README and `llms.txt` to reference every canonical doc.
- [ ] Validate JSON schemas.
- [ ] Enforce minimum breadth: required categories and core keywords.

### Task 5: Verify

**Files:**
- Run: `npm run docs:context7:validate`
- Run: JSON parse checks for `context7.json` and schema JSON files.

- [ ] Confirm validation passes.
- [ ] Audit that the corpus covers detailed precision, maintainability, and Context7 parsing goals.
