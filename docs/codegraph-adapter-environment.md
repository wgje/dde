# CodeGraph Adapter Environment Contract

## Purpose

Keep missing worktree prerequisites from being reported as product/spec regressions or from blocking unrelated tasks.

## Bootstrap

Run from the target worktree:

```powershell
npm run codegraph:adapter:prepare -- --root "<absolute-root>" --source-root "<prepared-source-root>" --json
```

The bootstrapper:

1. Copies only missing, allow-listed CodeGraph runtime/test fixture files.
2. Initializes the target root's own CodeGraph index when `codegraph.db` is absent.
3. Runs the stable overlay generator against the target root and publishes an immutable `CURRENT.json`.
4. Verifies the resulting runtime closure and generation selector.

It never treats a source-root wrapper or source-root index as target-root evidence. Source-root use is preparation only; all later adapter evidence must come from the target root.

## Status contract

- `READY`: adapter-dependent tests may run.\n- `READY_WITH_LOCAL_RUNTIME_CHANGES`: adapter-dependent tests may run, but the receipt lists locally changed closure files; review those task-owned changes separately. Unrelated tasks may proceed.
- `ENVIRONMENT_BLOCKED`: only adapter-dependent tasks are blocked. Unrelated tasks may proceed. Do not count these as correctness failures or request integration review for them.\n- A missing/dirty closure file is never reported as a product/spec failure; it is listed under `runtimeClosure.dirtyConflicts` or `runtimeClosure.missingAfter`.
- `ADAPTER_REGRESSION`: a prepared target still fails runtime/schema/gate checks; this is reviewable.

For a release gate, add `--require-ready`. Exit code `78` means environment blocked; it is intentionally distinct from an implementation/test failure.

## Evidence

Store the JSON bootstrap receipt with the task handoff. It must include `status`, `taskImpact`, `independentTasksMayProceed`, `runtimeClosure.missingAfter`, `index`, `generation`, and `blockingReason` when blocked.
