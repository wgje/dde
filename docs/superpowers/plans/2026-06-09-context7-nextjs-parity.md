# Context7 Next.js-Parity Documentation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make NanoFlow's Context7 recognition system match the accuracy, detail, and extensibility patterns of `/vercel/next.js`.

**Architecture:** Keep `docs/context7` as the canonical Context7 root, and add a Next.js-style layered information architecture: getting started, guides, API reference, architecture, file conventions, errors, examples, migration, and versioning. Preserve existing reference/contracts/runbooks, then add machine routing and validator rules that require this structure.

**Tech Stack:** Markdown, JSON catalog metadata, Context7 `context7.json`, `llms.txt`, Node.js validation script.

---

### Task 1: Add Next.js-Style IA

**Files:**
- Create `docs/context7/01-getting-started/*`
- Create `docs/context7/02-guides/*`
- Create `docs/context7/03-api-reference/*`
- Create `docs/context7/04-architecture/*`
- Create `docs/context7/05-file-conventions/*`
- Create `docs/context7/06-errors/*`
- Create `docs/context7/07-examples/*`
- Create `docs/context7/08-migration/*`

- [ ] Add index pages and high-value reference pages matching Next.js retrieval categories.

### Task 2: Extend Routing Metadata

**Files:**
- Modify `docs/context7/catalog.json`
- Modify `llms.txt`
- Modify `context7.json`
- Modify `docs/context7/README.md`

- [ ] Add numbered IA categories and query routes.
- [ ] Add file convention, error, example, and versioning routes.

### Task 3: Strengthen Validation

**Files:**
- Modify `scripts/validate-context7-docs.cjs`

- [ ] Require Next.js-style categories.
- [ ] Require error catalog, examples, file conventions, and migration/versioning pages.
- [ ] Keep catalog, README, and `llms.txt` coverage strict.

### Task 4: Verify

**Files:**
- Run `npm run docs:context7:validate`
- Run JSON parse and coverage audits.

- [ ] Validate docs.
- [ ] Audit category counts and retrieval routes.
