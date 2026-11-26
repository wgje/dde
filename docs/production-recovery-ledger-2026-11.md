# NanoFlow Production Recovery Ledger

Updated: 2026-11-26 (Asia/Shanghai)

## Release State

- `NO_RELEASE`
- `productionProof=false`
- `productionWrites=0`
- Production URL: `https://nanoflow.pages.dev`
- Production SHA observed in the prior bounded read-only check: `61e79ea4fe8e32841fe08328b5f0babe582f134a`
- Candidate PR: [#78](https://github.com/wgje/dde/pull/78), draft, base `main`
- Candidate branch: `codex/production-recovery-20261124`
- Candidate HEAD verified from Git and GitHub: `cbea7309455afb8acf80eee6bf24c39860ab6320`

No production deployment, migration, business-data write, Auth user edit, cache clear, or Service Worker removal was performed in this review slice.

## Candidate CI Evidence

GitHub Actions run `45730639047` (test-full-suite) and associated PR checks were read on 2026-11-26. The run is for candidate HEAD `cbea7309`.

Passed:

- Cloudflare Pages preview check (`139611947296`)
- SQL and sync contracts (`139611481680`)
- CodeGraph Windows read-identity check (`139611482551`)
- Vitest performance check (`139611482142`)
- validate-and-refresh (`139611481687`)

Failed:

- CodeGraph adapter gate (`139611482376`)
- Full Vitest shards 1-4 (`139611482505`, `139611482546`, `139611482559`, `139611482543`)
- Build, Determinism, Local Pages Smoke (`139611482507`)
- Test Without Deploy Secrets (`139611481732`)
- perf-and-resume-gates (`139611481508`)

GitHub REST exposed only the terminal step annotations (`Process completed with exit code 1`), not the failing command output. Ego Lite's Actions detail navigation timed out (`ERR_CONNECTION_TIMED_OUT`) in the current TaskSpace. GitHub MCP exposes check summaries but not Actions job logs. Therefore the underlying failures are not yet classified as code defects versus runner/environment failures. Do not patch based only on red check names. Obtain authenticated job logs or a faithful local reproduction before fixing these gates.

## Local CodeGraph Evidence

- Direct CodeGraph MCP context returned usable context in this session.
- Exact-root adapter doctor for `D:\Code\dde` failed pre-generation: `.codegraph/nanoflow-generations/CURRENT.json` is present but the pointed generation validates as `PAYLOAD_INVALID`; doctor classified freshness as `corrupt` and failed `overlay:file` / `overlay:freshness`.
- Exact-root adapter context returned base context but failed closed for the overlay with `overlay-current-invalid`; its wrapper later exited with `host-stdin-closed`.
- The current selector points to generation `g-eac0245dab18ed151b9a26cc7ad3cbcec692b1ce8e45339de1892f524e2c1f3e`, sequence `26`. The directory and selector exist, but `readOverlayCurrentReceipt()` returns `{ok:false,errorCode:"PAYLOAD_INVALID"}`.
- No generation was deleted, overwritten, or force-rebuilt. Preserve this evidence until the invalid payload boundary is identified; do not use this overlay as validated semantic evidence.
- Adapter doctor reported zero active file leases. Its live wrapper configuration matches the project contract, but several matching wrapper processes were present; no config change was made.

## Git Proxy Connectivity Finding

The earlier claim that the configured Git proxy was the root failure is not supported by this turn's checks:

- No Git global/repository `http.*.proxy` setting was found.
- No persistent User or Machine `ALL_PROXY` / `HTTP_PROXY` / `HTTPS_PROXY` value was found; this process inherits `ALL_PROXY=http://127.0.0.1:7897`.
- Local `127.0.0.1:7897` is listening under `verge-mihomo.exe`.
- With the inherited proxy, `git ls-remote https://github.com/wgje/dde.git refs/heads/codex/production-recovery-20261124` succeeded and returned candidate HEAD `cbea7309`.
- When the proxy environment variable was cleared for a direct-connect comparison, GitHub reset the direct connection. That test demonstrated the direct route is unavailable; it did not demonstrate proxy failure.

No Git, user, or machine proxy setting was changed. Current actionable state: the proxy path is working; the cause of any earlier transient failure is unproven. Recheck socket and `git ls-remote` if it recurs, without clearing the inherited proxy.

## Worktree Preservation

- Main workspace remains on local `main`, at `cbea7309`, with user modifications and untracked files preserved.
- The main workspace is ahead of `origin/main`; do not merge, reset, clean, stage, or publish the unrelated dirty work as part of this ledger update.
- `D:\Code\dde-ci-candidate-20261126` is a separate detached worktree at `0b0c7a66` with existing modifications in `.github/workflows/test-full-suite.yml`, `docs/codegraph-nanoflow-adaptation.md`, and `src/tests/contracts/codegraph-locale-ci.contract.spec.ts`. It was not modified.

## Next Evidence Required

1. Retrieve authenticated Actions logs for the failed CodeGraph, Vitest, build, secrets-free, and perf/resume jobs; reproduce each distinct failure against exact candidate SHA `cbea7309` before editing.
2. Identify which generation payload file or schema invariant makes the main-root CodeGraph selector invalid. Preserve the existing generation and use the repository's supported publication/recovery path; do not bypass doctor or `--require-ready` gates.
3. Re-run full tests, typecheck, lint, migration replay/rollback, deterministic build, and deploy-artifact validation on the exact candidate.
4. Keep the PR draft and production gates closed until all required checks pass.
5. Only after release gates pass, use the authorized production release workflow and verify deployment SHA, headers, cold/warm cached and bypass launch, login, sync replay/LWW, account isolation readback, and rollback evidence.

## Follow-up: CodeGraph Contract and Runner ICU (2026-11-26)

The previous CI run's exact adapter-gate stderr was retrieved through the GitHub Actions page with Ego Lite. It reported:

- `OVERLAY_SCHEMA_ORDERING_RUNTIME_MISMATCH`
- runner Node `v24.22.3`, runtime ICU `78.3`
- contract ICU `77.1`
- collator resolved options equal to the contract (`zh-CN`, `usage=sort`, `sensitivity=variant`, `numeric=false`, `caseFirst=false`)

The failure was caused by a floating Node 24 workflow version, not by the proxy or a production database issue. The CodeGraph ordering contract intentionally checks the ICU major version, so the fix keeps that invariant and pins the affected CI jobs to Node `24.11.1` (the local contract ICU `77.1`) in `test-full-suite.yml` and `perf-and-resume-gates.yml`. A CI contract test now rejects a floating `node-version: 24` entry.

The earlier local `PAYLOAD_INVALID` was a separate contract drift: the generation contract's `overlaySchemaDigest` did not equal the authoritative schema contract digest. The generation contract and its tests now use the authoritative `0cf35177...e22` digest. The supported stable publisher produced sequence `27` (`g-63c380db...703b`), and the current receipt now validates successfully with 150,814 graph nodes and 286,795 graph edges. Exact-root doctor is currently `ok=true`, `freshness=fresh`, with zero active file leases.

Focused verification after these changes: `79/79` tests green across the locale CI contract, overlay generation format, overlay stability, and full overlay schema suites. This is not full release evidence; production remains `NO_RELEASE`, `productionProof=false`, and `productionWrites=0`.

The earlier “no generation was ... force-rebuilt” statement describes the pre-fix observation. The supported stable publisher has since created the new immutable sequence 27 generation; the old generation was retained.
## Follow-up: Fresh Migration Ledger (2026-11-26)

A read-only Supabase query against `supabase_migrations.schema_migrations` returned 172 rows with max version `20261124095737`. The checked-in snapshot had 170 rows and was beyond its 24-hour freshness window, so `quality:guard:migration-dry-run` correctly failed closed with `migration-ledger-snapshot-stale`.

The snapshot was refreshed from that read-only result, adding versions `20261124091012` (`sync_rpc_single_device_canary`) and `20261124095737` (`rollback_sync_rpc_canary_until_client_release`), updating the capture time and evidence query id, and recomputing `canonicalRowsSha256` as `ACA51E6945D8F9E364241675EEC98DFA9A9709B325E2847532316B9766138962`. The migration dry-run/rollback validator now passes and reports 235 migration files, 218 transaction-safe, 11 out-of-transaction, and 17 requiring data-safety export review. No migration was applied.
## Follow-up: CI Native CodeGraph Bootstrap (2026-11-26)

GitHub Actions run `45749783979` on candidate `d93a3dea` still failed the CodeGraph adapter gate. Its exact log showed the runner's `Prepare exact-root CodeGraph worktree` step completed in `0s`; the later adapter preflight saw `.codegraph/nanoflow-generations/CURRENT.json` missing, and `codegraph:overlay:sync` failed with `native-db-missing` for `.codegraph/codegraph.db` while collecting Android Kotlin endpoints.

Root cause: `npm run codex:worktree:setup` delegates to a helper specifically for linked worktrees. On a standard GitHub checkout, `.git` is a directory equal to `--git-common-dir`; the helper intentionally returns `MAIN_ROOT_UNCHANGED` without bootstrapping. The workflow therefore reported a successful no-op rather than preparing native index and overlay artifacts.

The workflow now invokes `scripts/codegraph-worktree-bootstrap.cjs` directly with `$GITHUB_WORKSPACE` as both exact root and source root, plus `--require-ready --json`. That path is the canonical fail-closed bootstrap: it initializes the native CodeGraph index when needed, generates the immutable overlay, and exits nonzero unless both are ready. A contract test rejects reintroduction of the worktree-only helper in this CI job.

Regression evidence: before workflow change, the new test failed because the bootstrap step was absent (`1 failed / 11 passed`); after change, `codegraph-locale-ci.contract.spec.ts` passed `12/12`. The latest verified local migration dry-run remains green (235 files: 218 transaction-safe, 11 out-of-transaction, 6 explicit-transaction, 17 requiring data-safety export). Candidate CI must rerun before this fix is considered verified remotely. Production remains `NO_RELEASE`, `productionProof=false`, `productionWrites=0`.
## Follow-up: GitHub Actions Main-Checkout Bootstrap (2026-11-26)

Run `45749783979` on candidate `d93a3dea` confirmed the previous ICU fix: the CodeGraph schema runtime initialized under Node `v24.11.1`, but the adapter gate then failed when overlay generation called the native Android Kotlin sidecar. The log reported `native-db-missing` at `.codegraph/codegraph.db`; preflight also showed `CURRENT_MISSING`.

The cause was the CI step invoking `npm run codex:worktree:setup`, whose supported behavior is for linked Git worktrees. GitHub Actions checkout is a main checkout with a `.git` directory; the helper detects that identity and deliberately returns `MAIN_ROOT_UNCHANGED` in 0s. Therefore no native index or overlay was prepared. The workflow now calls `scripts/codegraph-worktree-bootstrap.cjs` directly for `$GITHUB_WORKSPACE`, with the same root as source root and `--require-ready --json`. This runs the existing canonical native-index bootstrap and immutable overlay publication, and fails closed if readiness is not achieved. The contract test first failed as expected (1 failed, 11 passed), then passed 12/12 after the workflow change.

The local focused CI contract is green. The previous broad contract command is currently blocked by unpaired Context7 documentation for concurrent user Flow/Parking/config changes; those code changes were not modified or staged here. GitHub Actions detail routing became intermittently unreachable through Ego Lite; the Vitest shard failure summaries remain red, but their exact assertion output is not yet verified and will not be guessed. Production remains `NO_RELEASE`, `productionProof=false`, and `productionWrites=0`.
## Follow-up: Linux npm Cache Selection (2026-11-26)

GitHub Actions run `45757925435` on candidate `3a2acc80` executed the new exact-root bootstrap and failed closed: `index.status=failed`, exit `127`, `stderrTail="sh: 1: codegraph: not found"`; no native DB or `CURRENT.json` was produced. npm registry metadata confirms `@colbymchenry/codegraph@1.6.2` declares `bin.codegraph`; npm 11 documentation says the `--package` executable is exposed on PATH. An isolated fresh-cache run on local Windows Node `v24.11.1` / npm `11.6.2` returned CodeGraph `1.6.2`, but that does not prove Linux runner behavior.

Inspection found `ensureNativeIndex()` defaulted npm cache to the Windows-only `D:/Code/tools/codegraph-npm-cache`. The fix adds a shared `resolveNpmCache()` rule: honor lowercase/uppercase npm cache variables or the project override; otherwise preserve the Windows shared cache on Windows and use `<home>/.npm` on POSIX. `ensureNativeIndex()` and both npm subprocesses in `setup-codegraph-worktree.cjs` now use that resolver; it is exported from the bootstrap module. A Linux-targeted test was first red because it captured the Windows process cache, then green after the change.

Focused verification: locale/workflow contract `12/12`, bootstrap `16/16`, package launcher `3/3` (`31/31` total); full TypeScript typecheck passed; lint passed with `0 errors` and `95 warnings`; encoding guard passed. Migration dry-run/rollback classification passed for 235 migrations (218 transaction-safe, 11 out-of-transaction, 6 explicit-transaction, 17 requiring data-safety export review). Exact-root CodeGraph doctor reports a fresh generation and zero leases.

A Linux container reproduction was attempted but Docker Desktop could not pull `node:24.11.1-slim` because its daemon has no HTTPS proxy; no container was created. A subsequent local stable-overlay refresh failed closed on source-manifest drift in `scripts/lib/codegraph-overlay-worker-pool.cjs` and `scripts/query-codegraph-nanoflow-overlay.mjs`, which are user-modified paths; they were not changed or reverted, and the current generation was retained. The cache fix remains pending a fresh GitHub Linux run. Production stays `NO_RELEASE`, `productionProof=false`, `productionWrites=0`.
## Follow-up: Remote Bootstrap Green, Adapter Fixture Still Red (2026-11-26)

Candidate `1f075d42` run `45775179972` verified the POSIX cache fix: the bootstrap step completed with `exitCode: 0`, `index.status=ready`, created `/home/runner/work/dde/dde/.codegraph/codegraph.db`, indexed 3,369 files (75,614 nodes / 226,386 edges), and published generation `g-4af30c...`. This closes the previous Linux `codegraph: not found` / native-db-missing root cause.

The subsequent adapter gate failed in the stale-wrapper smoke/infra lane, not during bootstrap. Its log reports 44 adapter tests with 41 failures and 612 passes; the principal failed assertion is `codegraph-mcp-smoke-stale-wrapper.spec-helpers.ts:48` where the smoke child exits `1`, alongside fake-wrapper environment mismatch diagnostics. The same smoke spec was run locally and reproduces 20 failures, all failing at `scripts/smoke-codegraph-mcp-wrapper.cjs:381` with `MCP initialize instructions did not preserve upstream CodeGraph guidance`. That wrapper file is an existing user-modified, unstaged path and was not changed or reverted. Treat this as a separate adapter-fixture/user-change gate; do not misattribute it to the npm cache fix.

Other latest remote results: Cloudflare Preview, SQL/sync contracts, CodeGraph Windows identity, and Vitest perf passed; build/determinism/smoke, perf/resume, and Vitest shards remain red; deploy-secret-free testing was still running at the last read. Production remains `NO_RELEASE`, `productionProof=false`, `productionWrites=0`.