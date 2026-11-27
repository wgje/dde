# NanoFlow Production Recovery Ledger

Updated: 2026-11-26 (Asia/Shanghai)

## Release State

- `PRODUCTION_DEPLOYED_PENDING_ACCEPTANCE`
- `productionProof=false`
- `productionWrites=UNVERIFIED` (bounded post-deploy edge-log window below observed no mutating request with the production referer)
- Production URL: `https://nanoflow.pages.dev`
- Current production SHA verified from `/version.json` and Cloudflare Pages deployment API: `02254645471c0d6a878f807a56df85f4e17ca856`
- PR [#78](https://github.com/wgje/dde/pull/78) merged by the repository account at `2026-11-26T13:56:30Z`; candidate branch `codex/production-recovery-20261124`, candidate HEAD `da472c97598d963ea80accb12ff924fa82da5508`
- Main workspace fast-forwarded to merge commit `02254645471c0d6a878f807a56df85f4e17ca856`; the pre-existing 54 dirty/untracked entries were preserved.

A production deployment has occurred; completion is still on HOLD. No migration was applied, no Auth user row was edited, and no browser cache or Service Worker was cleared/removed.

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
## Follow-up: Cold Startup Reproduction and Deferred Focus Queue Error (2026-11-26)

### Production reproduction (Ego Lite, read-only)

- Direct cold navigation to a same-account `#/projects/<project>/text` route reproduced the production loader timeout on SHA `61e79ea4fe8e32841fe08328b5f0babe582f134a`, with the production Service Worker still controlling the page. `/version.json` reported `deploymentTarget=production` and NGSW hash `95076a73e8a4a80a1e147becd65f2f57784e251c55e41b8a17486a06317206e9`.
- At ~1.2s the page remained in `launch-shell`, had no `<main>`, and the startup trace ended after `app.bootstrap_complete` and `user_session.snapshot_prehydrate`; no `handoff.resolve` or `handoff.trigger` had occurred. By ~8s the visible loader reported timeout. Sampled JS resources returned HTTP 200; no JS exception or 4xx resource was observed in this capture.
- A same-tab route navigation to `#/projects` completed `handoff.resolve` / `handoff.trigger`, reached boot stage `ready`, and rendered `<main>` with the existing account's workspace. No cache, Service Worker, IndexedDB, localStorage, Auth row, or business data was cleared or edited.
- The source-order defect is reproducible against the production baseline: `src/services/guards/project.guard.ts` captures the project guard's session fence before calling `prehydrateFromSnapshot()`. Candidate HEAD `c4451ed5567ed082568934280b3c18a936f603ea` moves verified snapshot prehydration before the async fence and allows only a first-owner establishment without a generation change; it has tests for a valid cold deep link and real owner/generation changes. This matches the observed missing handoff and route recovery, but production remains on the old SHA, so the candidate fix is not yet live.
- Stale expired local writer lease records were not the root cause: the production baseline tracker already drops expired non-local writer records when reading active writers. No production cleanup was performed.

### Errors after the workspace rendered

- After route recovery, the workspace reached `ready` but emitted repeated `focus-session:update` processor errors. Read-only console diagnostics identified `FOCUS_CONSOLE_SAVE_FAILED`, `reason=sync-rpc-unavailable`, `retryable=true`, `deferred=true`, `featureEnabled=false`, `clientRejected=false`.
- The supported client behavior is to skip legacy direct remote writes and retain this operation for queue retry while the Sync RPC capability is unavailable. No Sync RPC was enabled and no queue/payload was changed. The logging defect was that `isDeferredQueueError()` recognized browser suspension but not the explicit retryable+deferred contract, so expected deferrals were surfaced as `ERROR`.
- Local-only fix now recognizes explicit `{retryable:true, deferred:true}` errors and logs the retry as `DEBUG` with an accurate generic deferral reason. A focused regression was added to `src/services/action-queue-processors.focus-routine.spec.ts`. This does not activate the disabled capability or claim that the pending operation has synchronized remotely.

### Local verification and release gate

- Startup / route / restore / action queue focused matrix: `8/8` files, `217/217` tests passed; final action-queue processor subset after the logging change: `2/2` files, `111/111` tests passed.
- `npm run typecheck` passed after the final source change. Targeted ESLint had no errors; one existing complexity warning remains at `src/services/action-queue-task-focus-processors.service.ts:284`. `git diff --check` passed for the three changed files.
- `npm run build` completed after the fix. It still reports known budget warnings: initial JS 526.40 kB vs 520 kB and `dock-radar-zone.component.scss` 19.80 kB vs 16 kB. The local build identifies itself as `deploymentTarget=local`; it is not deploy evidence.
- `npm run build:strict` is blocked before compilation because this machine lacks the required deployment identity values `NG_APP_SENTRY_ENVIRONMENT`, `NG_APP_DEPLOYMENT_TARGET`, and `NG_APP_SUPABASE_PROJECT_ALIAS`. No values were read or fabricated. Local deploy-artifact validation is consequently incomplete.
- GitHub PR #78 remains Draft/Open at candidate HEAD `c4451ed5`; latest observed checks are 5 success, 9 failure, and 4 skipped. Failures include full-suite shards, CodeGraph adapter gate, determinism/local Pages smoke, perf-and-resume, and test-without-deploy-secrets. The Cloudflare Pages check is a preview check, not a production deployment. No merge or deploy was performed.

At this earlier checkpoint (before the subsequent PR merge and Pages deployment), state was `NO_RELEASE`, `productionProof=false`, and `productionWrites=0`. Outstanding: get the guard fix and deferral logging fix through full CI and strict production artifact gates, deploy through the formal production workflow, then verify cold/warm direct entry, authenticated startup, queue replay, owner isolation, and the remaining Auth/database issues with task-bound evidence.
## Follow-up: Bounded Production Auth and Database Log Review (2026-11-26)

Window: `2026-11-25T13:20:00Z` to `2026-11-26T13:20:00Z` (24 hours). Only aggregate log fields and error prefixes were queried; no user rows or SQL statement payloads were read.

- `auth_logs`: 27 rows were retained in the interval (first observed `2026-11-25T23:54:31Z`, last `2026-11-26T12:29:48Z`); aggregate `level=error` count 0, HTTP 5xx count 0, and `confirmation_token` message mentions 0.
- `edge_logs`: no HTTP 4xx/5xx rows were returned for this interval.
- `postgres_logs`: two ERROR events were observed: `42702` (`column reference "oid" is ambiguous`) at `2026-11-25T15:06:29Z`, and `42703` (`column "stats_since" does not exist`) at `2026-11-25T18:25:11Z`. Both were `client backend` / `http_server`; no matching `edge_logs` or `postgrest_logs` request was found in the bounded five-second windows. `stats_since` has no match in the repository's `supabase`, `src`, `scripts`, or `docs` sources. Attribution remains `UNATTRIBUTED`; do not patch application SQL from these two events without a request/source correlation.
- Read-only SQL confirmed PostgreSQL `17.6`, 21 Auth users, and 0 NULL `confirmation_token` values. No Auth user row was changed.
- These aggregate findings do not explain the cold launch timeout or the client-side deferred focus RPC queue event. No production write was performed.

## Follow-up: Merged Startup Fix, Production Deployment, and NG0600 Root Cause (2026-11-26)

### Merge, deployment, and production entry

- GitHub reports PR #78 merged at `2026-11-26T13:56:30Z` with merge commit `02254645471c0d6a878f807a56df85f4e17ca856`. Local `main` was fast-forwarded from `da472c97` to that exact merge commit after verifying identical trees and a clean index; 54 unrelated dirty/untracked entries remained preserved.
- Cloudflare Pages API confirms project `nanoflow` uses GitHub source `wgje/dde`, production branch `main`, build command `npm run build:strict`, destination `dist/browser`. Deployment `455ef072-a338-4c23-a0a6-47375f263728` was triggered by `github:push` on `main`, commit SHA `02254645`; both Cloudflare `build` and `deploy` stages succeeded. Therefore, the earlier assumption that only a manual workflow_dispatch could deploy is not the live Pages configuration. The GitHub PR check `Build, Validate, Deploy` was skipped; this is separate from the Pages project integration.
- Ego Lite read `/version.json`: SHA `02254645471c0d6a878f807a56df85f4e17ca856`, target `production`, build `2026-11-26T13:57:46Z`. After a direct project deep-link reload, the first sample at ~1.4s still showed `launch-shell` and no `<main>`; handoff completed at ~5.86s, and the page reached `ready` with `<main>` before the ~8s loader timeout. A subsequent warm direct reload completed handoff at ~1.66s. Service Worker/cache/local storage were retained.
- Browser diagnostics after deployment captured 0 JS console errors and 0 uncaught JS exceptions in the sampled reload. Warnings were still present: repeated anchor hydration `NG0600`, deferred focus RPC warnings, and one optional font fallback warning. Thus entry is improved and verified on the deployed SHA, but not every post-entry error is resolved.

### Post-deploy bounded data-write observation

- Supabase Edge logs were queried from `2026-11-26T13:56:00Z` through `2026-11-26T15:13:00Z`, filtered to the `nanoflow.pages.dev` referer and HTTP method POST/PUT/PATCH/DELETE. The query observed only 7 successful read RPC requests: `get_server_time` (2), `get_resume_recovery_probe` (2), `get_user_projects_watermark` (2), `get_black_box_sync_watermark` (1). No mutating request was observed in that bounded log query. This does not prove no writes occurred outside retained edge logs or through another channel; keep `productionWrites=UNVERIFIED`, not zero.

### Focus/RPC state remains a production issue

- Sampled deferred focus operations still report `FOCUS_CONSOLE_SAVE_FAILED`, `reason=sync-rpc-unavailable`, `retryable=true`, `deferred=true`, `featureEnabled=false`, `clientRejected=false`. Runtime feature flag `syncRpcEnabled` is generated false by default when `NG_APP_SYNC_RPC_ENABLED` is absent; the deployed Cloudflare Pages deployment exposes no `NG_APP_SYNC_RPC_ENABLED` variable (only the variable name/type was checked, never its values). Do not enable this flag until exact production protocol/owner/ACL/queue-replay gates pass. Existing behavior intentionally avoids the legacy direct write and keeps operations queued; warning noise was reduced, but remote replay has not been proven.

### Confirmed post-entry NG0600 fix in the local workspace (not deployed)

- Reproduced `NG0600: Writing to signals is not allowed in a computed` in a synthetic owner-switch test. A cached owner-A link is loaded; a reactive read calls `activeLinksForTask` / `firstActiveLinkForTask`; those methods immediately invoke `ensureLoaded()`, whose pre-await owner isolation clears the old Store and writes `visibleOwnerId=null` during the reactive computation. Before the fix the regression logged two NG0600 warnings (one per getter).
- The local fix defers only those background hydration starts to a microtask using `Promise.resolve().then(() => ensureLoaded())`. Both getters still return the current local result synchronously; owner filtering remains in place; the test proves no premature remote/cache load within the reactive read, then verifies the new owner's link hydrates and no background warning is logged.
- Verification after the change: focused external-source/knowledge-anchor/restore/owner-RLS contract matrix `10/10` files, `101/101` tests passed; TypeScript typecheck passed; targeted ESLint and `git diff --check` passed. Local `npm run build` passed with existing budget warnings (initial JS 526.40kB > 520kB; radar-zone Sass 19.80kB > 16kB). The strict production build cannot run in this host because its deployment-identity environment values are absent, but the current deployed commit's Cloudflare Pages build stage reports success for the configured `build:strict` command. The local NG0600 fix is not yet committed, pushed, or deployed.

### Release/review status and remaining proof

- PR #78 head SHA `da472c97` checks were not green at merge time: all four Vitest shards, CodeGraph adapter gate, build/determinism/local Pages smoke, perf/resume, test-without-deploy-secrets, and Copilot setup failed; several individual checks passed. The successful Pages production integration build does not make these independent checks green.
- Remaining: submit the NG0600 fix as a separate review candidate; resolve or attribute post-entry warning/error classes; obtain green relevant/full CI before the next production promotion; verify exact deployed launch and cached/bypass worker behavior under no-data-loss conditions; establish synthetic-owner offline queue replay/idempotency/conflict and account isolation; run migration replay/rollback; finish ACL/owner review and slow-query attribution. Keep `productionProof=false` and overall acceptance on HOLD until these task-bound proofs exist.

## Follow-up: NG0600 Reactive Hydration Hotfix Candidate (2026-11-26)

- Local change set is intentionally isolated to `src/app/core/external-sources/external-source-link.service.ts` and its regression spec. `activeLinksForTask` and `firstActiveLinkForTask` now schedule `ensureLoaded()` through a microtask before entering the background operation; their synchronous return remains owner-filtered and side-effect free. This prevents the owner-switch signal writes that Angular rejected inside a `computed`.
- Regression coverage seeds owner-A data, switches to owner B, reads both task-link getters from computed signals, asserts no immediate cache load/write, then waits for the B owner hydration and verifies the B link is visible with no background NG0600 warning.
- Targeted proof: external-source / knowledge-anchor / restore / owner-RLS contract matrix `10/10` files and `101/101` tests passed; startup/deep-link/guard smoke subset `5/5` files and `116/116` tests passed; TypeScript typecheck passed; targeted ESLint passed with no errors; diff check passed; local build passed with existing JS/Sass budget warnings.
- Full local matrix was attempted. Browser minimal lanes passed; testbed service lane had one unrelated failure in the pre-existing untracked `src/services/demo-workspace.service.spec.ts` (`DemoWorkspaceService > marks and resets the isolated development demo in order`), and other lanes exposed pre-existing user-change failures (`project-shell-controller-delegation`, data-safety Angular harness, undo integration, tooling-security tracked-closure). The full contract wrapper also stops at the existing Context7 coupled-change gate because unrelated Flow/Parking/config changes lack matching docs. These are red gates, not attributed to this hotfix.
- CodeGraph adapter doctor after the test run reports `fresh` overlay but `runtimeOk=false`, `pendingHostRestart=true`, and live wrapper configuration drift; no CodeGraph files or configuration were changed. Active local file/resource leases are zero at the last status check, with expired lease records retained as evidence.
- This hotfix is not deployed. It is being prepared as a separate candidate branch from production merge SHA `02254645471c0d6a878f807a56df85f4e17ca856`; production remains on that SHA until candidate CI, artifact, smoke, and release evidence are acceptable.


## Clean candidate gate recheck (2026-11-27)

- Verification worktree D:/Code/dde-ng0600-verify-20261127 is on local candidate 0b471d2f, based on c60e1e07. Its migration fixture-clock fix and Context7 source-map companion passed the original commit hooks. test:contracts completed: 111 files / 1106 tests passed. This clears the candidate documentation companion gate but is not full-suite or production proof.
- CodeGraph MCP smoke independently passed all 28 tests in 149.43s, without source changes or higher timeout. The stale-wrapper subset also passed. This contradicts attributing the original 15-minute segment timeout solely to MCP smoke.
- The remaining nine-file tool batch was stopped after more than ten minutes without completion; it is incomplete, not green. The native graph sidecar suite had 32 passes; overlay schema had one observed failure.
- The schema artifact case was independently reproduced: ENOENT opening .codegraph/nanoflow-overlay.json. Current setup publishes compatibility bytes under immutable CURRENT-selected generation directories, whereas this test requires an absent legacy path AND the historical 250558329-byte artifact digest. Earlier wording suggesting the failure was first a differing generated digest was inaccurate. Changing only the path or re-pinning a digest would not establish historical fixture equivalence. Keep the historical known-answer check distinct from current-generation integration.
- No main push, production deployment, database write or unrelated user work cleanup occurred. Remaining red/incomplete gates include callback-manifest source identity, historical schema artifact provisioning, the stalled tool batch and full-suite acceptance.


## Production entry revalidation (2026-11-27)

- Previous Ego TaskSpace 49 no longer exists. Listed spaces first and preserved user GitHub and Parking QA tabs. Recreated this closed goal space as TaskSpace 52; no cache, cookies, Service Worker or persisted business data was cleared.
- Production version read: 02254645471c0d6a878f807a56df85f4e17ca856, target production. First entry reached handoff at 766ms, main present, boot ready, no loader timeout and no observed resource HTTP >=400. A second reload also reached ready/main. This is a bounded entry check, not all startup/owner/offline acceptance.
- Post-entry console observation still reports ExternalSourceLink background failure warnings (62) and deferred FocusConsoleSync save warnings (117), with no uncaught JS exception in that observation. The NG0600 hotfix is not on production; focus sync remains deferred. Counts may include console events retained by the page session and are not global rates.
- No main push or deployment was performed; overall productionProof=false. Continue fixing post-entry behavior and candidate gates rather than declaring completion based on this successful entry.


## Focus replay protocol priming candidate (2026-11-27)

- Read-only server inspection confirms sync_check_protocol exists, public protocol state is min version 1 / epoch 0, and focus upsert checks auth owner, operation identity, payload digest and LWW baseline. No production mutation or environment flag change was performed.
- Client checkProtocol already auto-enables accepted capabilities; focus mutation paths instead checked the initially disabled flag without priming the probe. Prior attribution to the absent build variable alone was incomplete.
- Added local protocol priming to focus-session, routine-task and routine-completion mutation paths, preserving existing operation-ID requirements and no legacy writes. Captured owner/session generation/replay lease are rechecked after the probe await.
- RED: new focus startup-disabled and expired-lease probe cases failed. GREEN: 4 files / 121 tests passed, including protocol client and action-queue focus processors; typecheck, targeted ESLint and diff check passed. Added unavailable/rejected/owner-change no-write cases. Candidate not deployed; production replay/owner isolation and full release gates remain unproven.


## Focus probe suspension fence follow-up (2026-11-27)

- Adversarial review of candidate 422852fc exposed a missing network suspension recheck after awaiting protocol priming. Three new tests (focus session, routine task, completion) transitioned the browser to hidden during probing and initially observed RPC success instead of a deferred result.
- Added a suspension-window recheck after the owner/generation/lease fence and before RPC dispatch on all three paths. No production write or feature flag change occurred.
- RED: three cases failed. GREEN: four related suites / 124 tests passed; TypeScript, targeted ESLint and diff check passed. This is a correction to the previous candidate, not a claim that its earlier tests covered this boundary. Production replay and full release acceptance remain unproven.


## Enabled-capability await identity fence (2026-11-27)

- Adversarial review found that the enabled-RPC fast path still yields at await. A microtask owner change or session runtime reset after the helper computed true could reach mutation dispatch. New focus tests failed for owner change and reset; lease abort was already rejected.
- Each mutation caller now captures the runtime generation before capability priming and checks that generation plus owner after await, in addition to existing lease and suspension guards. Expanded the cases across all three mutation kinds and owner-change/session-reset/lease-abort transitions.
- Four related suites: 133/133 passed. TypeScript, targeted ESLint, diff and documentation validation passed. No production flag, data, migration or deployment changed. This closes a candidate-introduced async gap; production acceptance and remaining tool gates remain open.


## Focus candidate handbook companion (2026-11-27)

- Running test:contracts after eb3c9c45 exposed the missing Chinese handbook companion for sync behavior. Added user-facing pending-focus-state meaning, safe preservation guidance, candidate-only protocol priming and identity/suspension guard boundaries to the mapped sync/conflicts page. No gate was bypassed and no production readiness claim was added.

## Context7 restored, expanded candidate verification and read-only DB findings (2026-11-27)

- DIRECT_MCP: Context7 resolve_library_id(Angular) and query_docs(/websites/angular_dev) both succeeded. Official https://angular.dev/errors/NG0600 confirms computed derivations must not write other signals. This verifies documentation transport recovery, not production recovery.
- Candidate revision 6f393a5e107f76d63dacbe6f06aacf056a1f3915: expanded focus/replay/action-queue/dock/audit/export matrix 10 files / 294 tests passed; external-source and owner/data-safety matrix 5 files / 75 tests passed. Reports: test-results/recovery-expanded-20261127.json and test-results/recovery-owner-safety-20261127.json. A mistakenly supplied src/services/external-source-link.service.spec.ts filter matched no file in the first run; the correct src/app/core/external-sources/external-source-link.service.spec.ts ran in the second (46 tests). No test count is attributed to the unmatched filter.
- Typecheck and git diff --check passed. Local npm run build passed, including shared launch markers, SW HTML hashes and launch asset closure. Artifact version is development/local at 6f393a5e; this is NOT a production artifact or deployment. Budget warnings remain: initial bundle 526.40kB versus 520kB and dock radar Sass 18.70kB versus 16kB.
- npm run build:strict failed before compilation: this isolated worktree has no Supabase URL/browser key or Sentry/deployment/project identity configured. No dummy production values were supplied to bypass this check. Log: test-results/recovery-build-strict-20261127.log.
- Exact-root CodeGraph doctor reports fresh CURRENT and no active file leases before this ledger claim, but config applicability is false: isolated root lacks project config, user fallback targets main checkout, and worker environment fields are missing. Direct explore returned source but must not be treated as fresh exact-root runtime/config proof. No configuration or shared host changed in this round.
- Parallel DIRECT_MCP Supabase read-only audit confirmed target project and identified three source-level protocol gaps, not authenticated production reproductions: (1) focus RPC raw payload digest includes release metadata rather than using normalized replay digest; (2) legacy replay receipt with NULL normalized digest and unequal/NULL raw digest can return its old result without proving payload equivalence; (3) routine completion event-ID conflict returns idempotent replay without validating stored owner/routine/date tuple. Normal routine owner/auth checks, private internal-function ACL, locks, and RLS are present. Audit did not call business writes or expose customer payloads.
- Next: local synthetic RED/GREEN SQL replay cases for these gaps, preserve legacy receipts/queues and fail-closed handling, resolve independent full-suite tooling failures, obtain target-bound production build/release evidence, then live entry/replay/owner smoke. No Auth rows, receipts, production flags, migrations, remote main or deployment changed in this round. productionProof=false; productionWrites=UNVERIFIED; NO_RELEASE remains.

## Production console review and Focus conflict export correction (2026-11-27)

- Ego Lite production review on SHA `016b4ac8dc4cdc8b53254fe2495bc2a9dbbfed64` reached `ready` with `<main>` present. The account page showed one Focus dead letter. Read-only owner-scoped queue inspection confirmed its operation remains in the local dead-letter backup; no record was removed, edited or replayed in this round.
- The same operation has an owner-matched Supabase receipt with status `applied`, and the focus-session row exists. The deployed function returned `stale_payload=true` to a later write, so the LWW guard retained the newer remote snapshot and rejected the stale local write. This is a version conflict, not proof of data loss. The production function body currently uses raw `payload::text` digest replay checks, and its active definition differs from the July stable-digest candidate; do not retry this stale operation automatically or deploy an unreviewed migration.
- Console observation also saw 4 `ERR_FAILED` font subset requests from jsDelivr and an earlier `ActionQueueTaskFocusProcessors` Focus business-error log. After a page reload, no new console errors were captured during the bounded observation; prior buffered errors are observations, not a rate. Main UI remained available.
- Source review found the red-panel `downloadBackup()` exported only dead-letter metadata, omitting each operation payload. Replaced it with the established `downloadEscapeExport()` path, whose export serializes complete pending actions and dead-letter items. The panel now labels the recognized remote-newer Focus outcome as a retained conflict, avoids presenting it as generic data loss, and suppresses the futile retry button only for that classified item. It preserves explicit user dismissal and makes no automatic queue/storage mutation.
- RED/GREEN verification: component test covers retained-focus-conflict messaging, no retry control, full queue export invocation and unchanged dead-letter payload; generic dead letters retain the critical warning and retry affordance. Focused panel/action-queue/backup-restore matrix: 3 files / 153 tests passed. TypeScript typecheck passed. Context7 and human-doc coupled guards passed after updating mapped docs. Candidate change is not yet built/deployed; production live state is unchanged. `productionProof=false`; `productionWrites=UNVERIFIED`; database replay and account-isolation acceptance remain open.

## Production project-head drift repair and panel coverage follow-up (2026-11-27)

- Client commit bb5ae295 was pushed to main and deployed successfully as d1a23f35-74e5-45aa-8009-00516d21b25d. Production version readback matched the full SHA. Cold/reload reached ready with main rendered. This does not close overall incident acceptance.
- Fresh console observation exposed list_project_heads_page HTTP 404. Direct production catalog and migration-ledger checks confirmed both function and original July migration absent. Applied forward DDL through Supabase MCP, actual version 20261127081154, name restore_project_head_keyset_rpc. It creates a STABLE SECURITY INVOKER bounded owner-scoped page and revokes the retired unbounded RPC grant; no business DML/Auth row changes. Local migration filename matches the server-assigned version; comment/whitespace-normalized SQL MD5 matches remote statements: 5aa3f78af283a6b8dc8c267a570654cc.
- Production read-only transaction with authenticated role and test-owner claim returned 5 heads, all owner matched. This is database role-level evidence, not browser-JWT end-to-end proof. Anonymous API probe reached the function and received expected 42501 privilege denial rather than missing-function 404. A fresh Ego page observed no errors during a bounded startup window, but no claim is made that absence alone proves the background RPC ran.
- Local Postgres rollback-only synthetic regression passed after production application: equal-timestamp pagination, both-owner isolation, deleted-row exclusion, upper/since watermarks, invalid cursor/page limit, and retired-RPC denial. Transaction ended ROLLBACK. This was post-application validation, NOT a pre-release dry-run or full migration replay/rollback proof.
- Review found bb5ae295 omitted the full/compact-expanded panel. Candidate adds its retained-conflict explanation, complete ActionQueue export button, and disabled retry for the stale Focus item, leaving generic failures retryable and payloads untouched. ActionQueue escape export is not an entire account/project/cursor/attachment backup. Overall productionProof=false; production business writes remain UNVERIFIED; Auth, replay, remaining migration and full-suite acceptance are still open.

## Font root-cause candidate and explicit remaining release gates (2026-11-27)

- Candidate 49487e3c: typecheck, targeted lint and 112 contract files / 1109 tests passed. Bound strict production build and startup/no-JIT gates passed. This is candidate evidence only; no main push in this round. Existing full-suite CodeGraph historical-fixture/callback gates and shared IndexedDB interference remain unresolved.
- Font review proved later CDN font-face definitions overlap the 14 existing local subsets and therefore take precedence (CSS Fonts composite-face reverse declaration matching). A local subset can consequently still request CDN assets; observed subset-108 failure fits this pattern. Host probes reproduced cdn.jsdelivr.net connection failure while identical versioned assets were reachable at another mirror. That does not prove every user's network cause.
- Candidate preserves the original 14 WOFF2 files/CSS byte-for-byte, adds the remaining 83 regular WOFF2 files (4,345,056 bytes), MIT/OFL notices and a per-file source/hash manifest. Supplement CSS has exactly 83 disjoint faces, same-origin URLs and font-display swap. Runtime retains interaction/timeout scheduling and destroy/error cleanup. /fonts/** remains lazy; uncached glyphs on a first offline visit still fall back to system fonts.
- RED: two scheduler assertions failed because production code inserted an external stylesheet rather than the required same-origin supplement. GREEN: scheduler/Flow redraw/asset-contract matrix 3 files / 19 tests passed; all 97 font sizes, WOFF2 magic and SHA values verified. Typecheck, targeted ESLint and 113 contract files / 1112 tests passed. Strict candidate build and startup guard passed with initialStatic=338.0KB, mainStaticImports=10. No claim of browser production font recovery yet.
- Artifact trend gate is RED: totalBytes 8,399,899 -> 12,884,576 (+53.4%), exceeding the unchanged 30% relative-growth policy; file/ngsw counts also warn. No baseline/budget was changed or bypassed. This must be explicitly resolved before promoting the font candidate; adding lazy resources is not the same as increasing eager entry size, but the current gate still fails.
- Supabase read-only recheck: 21 users, zero NULL confirmation tokens. Bounded 2026-11-26T09:25Z..2026-11-27T09:25Z logs had no matching NULL-token/scan/user-find/500 patterns, which is absence of observation, not full Auth acceptance. Statement-statistics review identified a 460.64ms mean query as SELECT name FROM pg_timezone_names (administrative metadata), and the previously unattributed high-call query as batched net._http_response retention. Lifetime stats are not a current incident window and do not establish browser callers. No indexes, Auth rows or maintenance queries changed.
- Correction to earlier queue attribution: the 2026-11-24 pending operation receipt and the later 2026-11-27 dead-letter action share a focus-session entity, but are not proven the same business operation. An applied receipt alone does not prove payload equivalence or that replaying another operation is safe. The stale Focus snapshot remains locally preserved; no deletion or forced retry is part of this candidate. productionProof=false; production business writes=UNVERIFIED; overall objective remains active.

## Preview font readback and fixture regression closure (2026-11-27)

- Cloudflare preview 1e05fe97-402a-4718-bf84-7453bbb90e57 deployed SHA 43c1cdef successfully. Ego Lite on that exact preview reached ready, rendered main, registered 97 WenKai font faces, and loaded the same-origin supplement. Observed base and supplemental WOFF2/CSS resource requests were HTTP 200 on the preview host, with no CDN font requests or captured runtime/network errors in this bounded interaction. This is preview-only; artifact-trend gate remains red and remote main remains bb5ae295. The agent-created preview space was finished and closed, preserving user spaces.
- Commit a45b0494 fixes only the Focus IndexedDB test fixture: use adaptive open instead of reopening repaired v5 schemas at v4. Two new tests reproduced NotFoundError/VersionError before the change, then both passed while retaining the original Black Box sentinel through seed/read/clear. Independent recheck: 2 files / 86 tests passed. Shared-worker cached idb-keyval connection/deletion blocking remains a separate unresolved failure; do not claim a full-matrix pass. No production database, queue, Auth, deployment configuration or main ref was mutated in this round.
