# Personal Data Safety Stop-Loss Design

## Status

Approved by the user on 2026-07-16: authority boundary + exact mutation intent + fail-closed validation.

This document specializes the broader protocol in `docs/personal-data-safety-protocol.md`. It defines the prevention and repair work required for the observed failure class where tasks unexpectedly become unassigned, disappear from the flow, or cannot be restored to their original topology.

Where this approved design tightens package versions or audit-persistence behavior, it supersedes the current protocol text. The implementation batch must update the broader protocol in the same change so the two documents do not remain divergent.

## Goal

Make personal data safety the first constraint on project, task, connection, sync, migration, backup, and restore changes.

The implementation must close four guarantees:

- Exportable: current entity data, sync cursors, pending queues, tombstones, conflicts, and recent write evidence remain exportable at any time.
- Restorable: a valid package restores IDs and topology exactly, or rejects before any write. Restore never guesses missing structure.
- Replayable: pending actions preserve their original operation identity and deterministic order; historical audit entries remain inspect-only.
- Explainable: the latest write states who wrote which entity, the before/after revision and topology, queue/RPC outcome, LWW decision, conflict evidence, and `lastSyncTime` effect.

Success also requires preventing the known task-loss mechanisms found during the July 2026 audit.

## Preserved Constraints

- IndexedDB remains the local source of durability.
- Supabase incremental sync, RetryQueue, ActionQueue, CAS/LWW, and existing RPCs remain in place.
- No new global state library or facade Store is introduced.
- Entity IDs remain client-generated with `crypto.randomUUID()` and are never remapped during restore.
- Every task payload and restored task continues to require string `content`.
- Existing owner isolation and metadata-only project hydration behavior remain intact.
- Ambiguous data is preserved for export and diagnosis; it is not silently normalized into a plausible shape.

## Current Facts

The audit confirmed the following destructive boundaries.

### Metadata shells can become entity authority

`ProjectStore` is a metadata shell. `TaskStore` and `ConnectionStore` hold current entity data. `ProjectStateService.getProjectWithCurrentData()` and `getProjectsWithCurrentData()` correctly reconstruct full projects, but several write paths still read `projects()` or `getProject()` and later persist or replay those shells as full snapshots.

Confirmed affected paths include:

- local autosave in `SyncCoordinatorRuntimeService`;
- project metadata CRUD and pre-commit snapshots in `ProjectOperationService`;
- optimistic snapshots and full rollback in `OptimisticStateService`;
- conflict baselines and pre-commit snapshots in `ProjectOperationConflictService`;
- active-project refresh baselines that use a shell instead of current task/connection stores.

A shell containing `tasks: []` is valid metadata but invalid full-project authority. Persisting or replaying it can erase or rewrite task topology on the next full `setProjects()`.

### Full replacement does not clear omitted project indexes

`ProjectStateService.setProjects()` replaces the project catalog, but the bulk task and connection setters only clean project IDs present in the incoming list. Replacing `[A, B]` with `[B]` can leave A's task and connection indexes behind.

### Rejected delete conflicts create false local deletion evidence

For task delete RPC results `remote-newer` and `deleted-remote-newer`, the server did not accept the local delete. The current soft-delete path still creates local tombstones for all requested IDs. A later pull can materialize those tombstones and hide a task that still exists remotely.

### Unassigned drag lacks an exact target

The palette exposes a container-level drop. When an unassigned task is dropped, the service chooses the first task in the complete unassigned list instead of the hovered task. Hidden or paginated tasks can therefore become the parent.

### Import and restore accept incomplete topology

The user-facing backup conversion can silently drop task or connection rows whose `projectId` is absent, default a missing `stage` to `null`, repair missing parents or cycles, and discard invalid connections. Deleted tasks do not round-trip all `deletedMeta` and `deletedConnections` needed for exact trash restore.

The canonical data-safety package validates IDs, arrays, owner, checksum, cursors, and task `content`, but it does not yet enforce all project/task/parent/connection cross-references before destructive replacement.

## Architecture Decision

Use the existing stores, queues, snapshot services, audit persistence, and RPCs. Harden their boundaries with pure validators and explicit intent. Do not introduce a second persistence model or integrity journal Store.

The design has five cooperating boundaries:

1. authoritative project materialization;
2. exact topology mutation intent;
3. deletion evidence discipline;
4. fail-closed import and restore;
5. durable structural write explanation.

## 1. Authoritative Project Materialization

### API rule

`projectState.projects()` and `projectState.getProject()` are shell-only APIs. They may be used for metadata display and metadata-only hydration. They must not be used as input to:

- durable snapshots;
- cloud writes or queue payloads;
- optimistic snapshots or full rollback;
- conflict comparison or resolution baselines;
- project mutation replacement objects;
- integrity manifests.

Those paths must use `getProjectsWithCurrentData()` or `getProjectWithCurrentData()`.

### Autosave

Autosave first materializes the exact full snapshot that will be written. Its dirty check is computed from that materialized payload, not only project `updatedAt` and `version` metadata. The hash must change when any persisted task or connection field changes, even if a caller failed to advance the project shell revision.

The hash is updated only after the snapshot write succeeds. A failed write remains pending for the next autosave tick.

### Project mutation and rollback

Project metadata updates create replacement objects from the current full project. Pre-commit snapshots contain full current projects. Optimistic snapshots capture full current projects, and full rollback replays only those full snapshots.

Narrow task rollback remains narrow. It must not replace unrelated project entities.

### Full replacement cleanup

Before `setProjects()` replaces the catalog, it computes removed project IDs from the previous catalog. Task and connection stores clear every removed project before applying incoming entries. `setProjectsMetadataOnly()` remains metadata-only and performs no task/connection cleanup.

## 2. Exact Topology Mutation Intent

### Unassigned drag

An unassigned task card emits its exact target task ID. The target card handles and stops the drop event. The palette container handles only assigned-to-unassigned detach.

Rules:

- unassigned task + explicit target ID: reparent under that exact target;
- unassigned task + container without target: no topology mutation;
- assigned task + container: preserve the existing explicit single-node detach semantics, including child promotion, and audit that intent;
- source and target must belong to the active project and still exist at commit time;
- hidden or paginated tasks cannot become implicit targets.

### Link insertion and stage invariants

Link insertion uses the same cycle, parent-stage, and stage-capacity checks as ordinary moves. If the moved task has descendants, their stages are updated consistently or the operation is rejected before local commit.

### Projection fidelity

After a structural change, persisted `x` and `y` win over an existing keyed GoJS node location. Pure non-structural refreshes may preserve the existing view location.

Trash restore preserves an originally unassigned task as `stage: null` when its prior parent cannot be restored. It must not coerce that task to stage 1.

## 3. Deletion Evidence Discipline

Local tombstones mean that a delete was either accepted remotely or durably preserved for retry. They are not generic evidence that the user once attempted a delete.

For task delete RPC results:

- `applied` or `idempotent-replay`: keep tombstones for affected IDs;
- retryable rejection with durable RetryQueue records: keep tombstones only for the IDs confirmed queued;
- `remote-newer` or `deleted-remote-newer`: do not create tombstones for conflict IDs and remove any provisional tombstone created for the same operation;
- terminal non-retry rejection: do not create tombstones;
- mixed outcomes: compute the tombstone set from applied and durably queued IDs, never from the original request array.

Conflict IDs retain conflict evidence and the original operation ID. A subsequent pull decides visibility from remote data plus valid deletion evidence.

## 4. Fail-Closed Import And Restore

### Shared graph validator

A pure validator checks a candidate graph before any clear, merge, normalization, queue replay, or callback:

- project, task, and connection IDs are non-empty and unique;
- every task has a string `content` field;
- every task belongs to an existing project;
- `stage` is present and is either `null` or a valid stage number;
- every non-null parent exists in the same project;
- parent relationships are acyclic;
- assigned parent/child stage relationships satisfy layout invariants;
- every connection belongs to an existing project;
- connection endpoints exist in that same project;
- deleted tasks include the metadata required for exact restore;
- queue, conflict, tombstone, cursor, and snapshot owner scopes match the package owner.

Validation returns stable machine-readable error codes and entity IDs. It does not mutate the candidate.

### No silent normalizer on restore

`validateAndFixTree()` remains available for an explicit user repair workflow, but import and data-safety restore do not call it to make an invalid package acceptable. A missing parent, cycle, missing stage, cross-project edge, or missing deleted-task metadata rejects the package before writes.

### Versioning

New user-facing exports set both `BackupData.version` and `BackupData.payloadVersion` to `2.1.0`. New canonical exports use `DataSafetyExportPackage.schemaVersion` `1.1.0`.

Readers remain compatible with `2.0.0` and `1.0.0` when the package already contains enough information for exact restoration. Compatibility is deterministic:

- an explicit `stage: null` is a valid unassigned state;
- an absent `stage` is not inferred and rejects restore;
- a legacy package containing deleted tasks without complete restore metadata rejects restore;
- a package with no affected legacy rows can be upgraded in memory without changing IDs or timestamps.

New export schemas include `deletedMeta` and `deletedConnections` for deleted tasks.

### Dry-run manifest

Before writes, restore produces a manifest containing:

- owner and schema versions;
- package checksum and coverage flags;
- sorted project/task/connection IDs;
- entity counts by project;
- queue operation IDs and payload digests;
- cursor and tombstone maxima;
- graph validation result;
- expected post-restore integrity hash.

The restore marker stores the current-state manifest and snapshots needed for rollback. After restore, the adapter rereads stores and compares the actual manifest with the expected manifest. A mismatch triggers rollback and keeps the marker until recovery is proven.

### Repair policy

Automatic repair is allowed only when intent is unambiguous:

- clear indexes for a project explicitly omitted by an authoritative full replacement;
- remove a tombstone only when a matching conflict audit record identifies the task and operation, and a current remote row proves the entity still exists; task ID or timestamp proximity alone is insufficient proof;
- rebuild a visual projection from persisted task state;
- replay a complete rollback marker.

Ambiguous topology is never guessed. The app preserves raw bytes, blocks destructive persistence and cloud propagation for the affected project, records an integrity report, and keeps export available. Recovery then uses a validated prior snapshot, a valid export package, or explicit remote conflict resolution.

## 5. Structural Replay And Write Explanation

The existing bounded, owner-scoped audit log remains the persistence mechanism. Schema `1.1.0` adds optional structural evidence so old audit entries remain readable.

```ts
interface DataSafetyEntityState {
  updatedAt: string | null;
  task?: {
    stage: number | null;
    parentId: string | null;
    deletedAt: string | null;
    x: number | null;
    y: number | null;
    contentHash: string;
  };
  project?: {
    taskIds: string[];
    connectionIds: string[];
    manifestHash: string;
  };
}

interface DataSafetyMutationIntent {
  kind: string;
  sourceProjectId?: string;
  sourceParentId?: string | null;
  sourceStage?: number | null;
  targetProjectId?: string;
  targetTaskId?: string | null;
  targetParentId?: string | null;
  targetStage?: number | null;
}
```

`DataSafetyLastWriteExplain` and its replay entry add:

- `beforeState` and `afterState`;
- `intent`;
- `localCommit` result;
- affected child IDs for structural cascades;
- explicit tombstone result;
- existing queue, RPC, conflict, LWW, and `lastSyncTime` fields.

The audit stores a content hash rather than duplicating task content. The export package still contains the authoritative task `content`.

Every guarded project/task/connection write persists an initial explanation under the final operation ID before the mutation is reported as locally successful. If that initial audit record cannot be persisted, the mutation fails closed and the entity/queue state is rolled back. An RPC attempt updates the same operation's explanation; it does not invent a new operation ID. If a later terminal audit update fails, the durable initial entry remains with an explicit `rpc.status: 'unknown'` and incomplete-audit reason so export and replay inspection do not falsely claim a complete result.

## Failure Handling

- Local durable snapshot or queue failure: do not report the mutation as successful; restore the full pre-mutation state from an authoritative snapshot.
- Initial audit persistence failure: fail the local mutation and roll back entity and queue state. Terminal RPC audit-update failure: keep the already durable local write and initial audit record, mark the RPC outcome unknown, and retain the operation for later reconciliation.
- Invalid import package: perform zero writes and return all validation errors.
- Restore mismatch: rollback primary stores and local state, retain the marker, and block normal persistence until startup recovery succeeds.
- Delete conflict: keep the remote entity visible, preserve conflict evidence, and do not advance `lastSyncTime` unless the existing sync protocol independently proves cursor advancement.
- Integrity violation in live state: keep export available, stop destructive snapshot/cloud propagation for the affected project, and preserve the last known valid snapshot.

## Migration And RPC Strategy

The first stop-loss batch requires no Postgres schema migration. It changes local authority boundaries, UI intent plumbing, validators, and audit payloads.

Any later RPC or migration change must:

1. pass `supabase test db` or the repository's equivalent pgTAP contracts;
2. run locally or on a disposable branch;
3. capture row counts, owner counts, IDs, cursor maxima, function definitions, grants, policies, and package checksum before change;
4. validate that task `content`, client UUID defaults, operation IDs, payload digests, LWW status vocabulary, and locked `search_path` remain intact;
5. provide transaction rollback or an exact manifest-declared rollback script;
6. rerun the same evidence queries after rollback.

No migration is accepted based on inferred prior state.

## Test-Driven Implementation Order

### Batch 1: stop loss

Write failing regressions for:

- autosave after metadata-only hydration persists current TaskStore and ConnectionStore entities;
- project rename, metadata update, flowchart URL update, add, delete, and import snapshots preserve current entity authority;
- optimistic full rollback captured during metadata-only state restores full entities;
- conflict baselines and snapshots use reconstructed current data;
- full replacement `[A, B] -> [B]` clears A's task/connection indexes;
- unassigned A dropped on B targets B, including with hidden candidates;
- unassigned container drop without a target performs no reparent;
- `remote-newer` and `deleted-remote-newer` task delete results create no local tombstone;
- mixed delete outcomes tombstone only applied or durably queued IDs;
- link insertion validates and cascades descendant stages;
- structural projection uses persisted coordinates after a move;
- trash restore preserves an unassigned task as unassigned.

### Batch 2: fail-closed restore

Write failing regressions for:

- orphan task and connection `projectId` values;
- absent task `stage` versus explicit `stage: null`;
- missing parent, cycle, invalid stage relationship, and missing connection endpoint;
- deleted task metadata round trip;
- canonical package referential integrity before destructive clear;
- restore idempotency and exact ID preservation;
- post-restore manifest mismatch rollback;
- legacy schema deterministic acceptance or rejection.

### Batch 3: explainability and gates

Write failing regressions for:

- move/detach/reparent before and after structural state;
- explicit target intent and affected child IDs;
- RetryQueue replay preserving operation ID and intent;
- LWW remote-kept explanation with no false tombstone and no false cursor advancement;
- audit schema backward compatibility;
- migration/RPC contracts preserving task `content`, UUID policy, payload digest replay, and status vocabulary;
- targeted static contracts forbidding shell APIs from being used to build entity payloads in named persistence, mutation, rollback, refresh, and conflict methods; legitimate metadata-only reads remain allowed.

## Verification Gates

At minimum, completion requires explicit pass/fail output for:

```text
npx vitest run --config vitest.config.mts <new stop-loss specs> --maxWorkers=1 --no-file-parallelism
npx vitest run --config vitest.config.mts <new restore specs> --maxWorkers=1 --no-file-parallelism
npx vitest run --config vitest.config.mts <new replay/explain specs> --maxWorkers=1 --no-file-parallelism
npm run typecheck
npm run lint
npm run quality:guard:migration-dry-run
npm run test:contracts
npm run build:dev -- --configuration development --output-path dist/data-safety-stop-loss
git diff --check
```

The broader personal-data-safety matrix in `docs/personal-data-safety-protocol.md` must also pass. A green existing suite is insufficient unless the newly confirmed loss paths have dedicated regressions.

## Completion Criteria

This design is complete only when all of the following are proven:

- no persistence, queue, rollback, or conflict path can turn a metadata shell into full entity authority;
- an authoritative full replacement leaves no omitted-project entity indexes;
- a rejected delete conflict cannot hide a still-existing remote task;
- an unassigned drag cannot choose an implicit or hidden parent;
- import and restore reject incomplete topology before any write;
- deleted tasks round-trip enough evidence for exact restore;
- pending writes replay with stable operation identity;
- the latest structural write explains its exact before/after topology and sync outcome;
- ambiguous corruption remains exportable and is never silently repaired;
- all targeted and broad gates report explicit results.
