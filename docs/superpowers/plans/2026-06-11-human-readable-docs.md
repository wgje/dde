# Human-Readable Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a human-readable NanoFlow documentation corpus with GitHub Docs-style navigation depth, article structure, and validation.

**Architecture:** Keep `docs/context7` as the machine-readable source for AI retrieval and add `docs/handbook` as the human-readable reading layer. The handbook uses a root index, category landing pages, article pages, and a catalog consumed by a validation script.

**Tech Stack:** Markdown, Node.js validation script, existing `npm run docs:*` command surface.

---

## File Structure

- Create `docs/README.md` as the documentation portal for humans and maintainers.
- Create `docs/handbook/index.md` as the human docs root.
- Create `docs/handbook/catalog.json` as the required page catalog and navigation manifest.
- Create `docs/handbook/01-get-started/*` for onboarding and setup.
- Create `docs/handbook/02-use-nanoflow/*` for product usage.
- Create `docs/handbook/03-data-sync-safety/*` for data, sync, recovery, and security.
- Create `docs/handbook/04-deploy-operate/*` for deployment and operations.
- Create `docs/handbook/05-develop-maintain/*` for contributor and maintenance docs.
- Create `scripts/validate-human-docs.cjs` to enforce structure, links, metadata, and catalog coverage.
- Modify `package.json` to add `docs:human:validate` and include it in `docs:validate`.
- Modify `README.md` to route readers to the new handbook.

## Tasks

### Task 1: Add the docs portal and handbook root

**Files:**
- Create: `docs/README.md`
- Create: `docs/handbook/index.md`
- Create: `docs/handbook/catalog.json`

- [x] **Step 1: Create the root portal**

Add `docs/README.md` with links to the human handbook, Context7 corpus, runbooks, design notes, and archive.

- [x] **Step 2: Create the handbook index**

Add `docs/handbook/index.md` with category routing, reader paths, and maintenance rules.

- [x] **Step 3: Create the catalog**

Add `docs/handbook/catalog.json` containing every category, landing page, article path, and article purpose.

### Task 2: Add GitHub Docs-style category pages and articles

**Files:**
- Create: `docs/handbook/01-get-started/*.md`
- Create: `docs/handbook/02-use-nanoflow/*.md`
- Create: `docs/handbook/03-data-sync-safety/*.md`
- Create: `docs/handbook/04-deploy-operate/*.md`
- Create: `docs/handbook/05-develop-maintain/*.md`

- [x] **Step 1: Create category landing pages**

Each section index includes overview, recommended path, article table, and next steps.

- [x] **Step 2: Create articles**

Each article includes metadata, `In This Article`, prerequisites when useful, concrete procedures, behavior notes, troubleshooting, and next steps.

### Task 3: Add validation

**Files:**
- Create: `scripts/validate-human-docs.cjs`
- Modify: `package.json`

- [x] **Step 1: Add validation script**

The script reads `docs/handbook/catalog.json`, checks required files, front matter, relative links, source paths, title matching, placeholders, and article structure.

- [x] **Step 2: Wire npm scripts**

Add:

```json
"docs:human:validate": "node scripts/validate-human-docs.cjs",
"docs:validate": "npm run docs:context7:guard && npm run docs:human:validate"
```

### Task 4: Verify

**Files:**
- Verify all new and modified docs files.

- [ ] **Step 1: Run the narrow documentation gate**

Run: `npm run docs:human:validate`

Expected: `Human documentation validation passed`.

- [ ] **Step 2: Run the combined docs gate if feasible**

Run: `npm run docs:validate`

Expected: Context7 validation and human docs validation both pass. If unrelated dirty staged files trigger coupled-change checks, report that separately.
