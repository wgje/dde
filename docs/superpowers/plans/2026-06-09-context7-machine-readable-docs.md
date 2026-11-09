# Context7 Machine-Readable Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a canonical project-level documentation structure that Context7 can parse with high signal and low noise.

**Architecture:** Keep the existing user-facing README and historical docs intact, but add a small canonical documentation corpus under `docs/context7/`. Root-level `context7.json` limits Context7 indexing to that corpus, while `llms.txt` and a validator script provide AI-facing navigation and maintenance checks.

**Tech Stack:** Markdown, Context7 `context7.json`, Node.js validation script, existing Angular/Supabase/NanoFlow architecture facts.

---

### Task 1: Add Context7 Indexing Configuration

**Files:**
- Create: `context7.json`
- Create: `llms.txt`

- [ ] **Step 1: Create `context7.json`**

Include only `docs/context7` so Context7 avoids historical plans, archives, generated artifacts, test output, and implementation noise.

- [ ] **Step 2: Create `llms.txt`**

Expose a concise AI-readable map with canonical docs, hard rules, and common retrieval topics.

### Task 2: Build Canonical Documentation Corpus

**Files:**
- Create: `docs/context7/README.md`
- Create: `docs/context7/overview.md`
- Create: `docs/context7/architecture.md`
- Create: `docs/context7/data-model.md`
- Create: `docs/context7/sync-offline.md`
- Create: `docs/context7/feature-workflows.md`
- Create: `docs/context7/api-edge-functions.md`
- Create: `docs/context7/development.md`
- Create: `docs/context7/operations-security.md`
- Create: `docs/context7/agent-rules.md`
- Create: `docs/context7/context7-maintenance.md`

- [ ] **Step 1: Write overview and navigation docs**

Make `README.md` the canonical table of contents. Keep each page focused on one retrieval topic.

- [ ] **Step 2: Write architecture, data, sync, and feature docs**

Use current code facts: Angular 19, Signals stores, Supabase, IndexedDB, RetryQueue, GoJS, Parking Dock, Focus, Black Box, Android widget, Edge Functions.

- [ ] **Step 3: Write development, operations, agent rules, and maintenance docs**

Document commands, verification lanes, security constraints, Context7 refresh flow, and update rules.

### Task 3: Connect Existing Project Entry Points

**Files:**
- Modify: `README.md`
- Modify: `package.json`

- [ ] **Step 1: Update README document navigation**

Add `docs/context7/README.md`, `context7.json`, and `llms.txt` to the documentation navigation section.

- [ ] **Step 2: Add validation scripts**

Add package scripts for running the Context7 documentation validator.

### Task 4: Add Validation

**Files:**
- Create: `scripts/validate-context7-docs.cjs`

- [ ] **Step 1: Validate required files**

Check that `context7.json`, `llms.txt`, and all canonical docs exist.

- [ ] **Step 2: Validate Context7 config**

Check schema URL, title, description, folders, exclusions, and rules.

- [ ] **Step 3: Validate docs cross-links**

Parse Markdown links in `docs/context7`, `README.md`, and `llms.txt`, and fail on missing relative targets.

### Task 5: Verify

**Files:**
- Run: `npm run docs:context7:validate`
- Run: `node -e "JSON.parse(require('fs').readFileSync('context7.json','utf8')); console.log('context7.json valid')"`

- [ ] **Step 1: Run validator**

Expected: exit code 0.

- [ ] **Step 2: Parse JSON**

Expected: `context7.json valid`.
