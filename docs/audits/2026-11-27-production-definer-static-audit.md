# Production SECURITY DEFINER static audit — 2026-11-27

## Status and evidence boundary

**STATIC REVIEW COMPLETE; ADVISOR WARNINGS REMAIN; DYNAMIC NEGATIVES UNVERIFIED.**

This document records the read-only production catalog/body inspection performed
in this task. It does not authorize database changes, suppress findings, prove
an authenticated security test, or constitute production-release acceptance.
No production business rows, Auth rows, credentials or customer payloads were
read or included. No business RPC was invoked. No migration, index, ACL, policy,
Auth configuration, database branch, deployment or source change was performed
as part of the database inspection.

- Target confirmed by Supabase `get_project_url`:
  `https://fkhihclpghmmtbbywvoj.supabase.co`.
- Security Advisor `observed_at`: **2026-11-27T14:19:58.177Z** for the 13 function
  findings and two receipt-table findings.
- Catalog/body queries followed that Advisor call in the same task. Their tool
  responses did not provide a server observation timestamp; this document does
  not fabricate one or claim every query was a single transaction snapshot.
- Evidence provenance: official Supabase MCP `search_docs`, `get_project_url`,
  `get_advisors(type=security)` and read-only `execute_sql` catalog queries.
- Hash convention: every body hash below is PostgreSQL **MD5 of `pg_proc.prosrc`**.
  It identifies the stored function body only, not the complete DDL, ACL or
  search-path configuration, and is not a cryptographic authenticity proof.
- The report stores catalog facts and predicate summaries, not full function
  bodies or user data. Re-query before relying on it after database changes.

## Official guidance consulted

- [0029: authenticated SECURITY DEFINER execution](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable)
- [0008: RLS enabled without policy](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)
- [Row Level Security and auth.uid()](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Leaked password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)

The official 0029 guidance describes an exposed privileged API surface: any
signed-in user with EXECUTE can call it. The lint does not prove that function
body authorization is absent. An intentionally exposed per-user operation may
remain a finding even with correct checks. Conversely, a fixed search_path or
an owner predicate alone does not prove the whole operation safe.

## Current Advisor state

| Finding | Count | Actual disposition in this audit |
| --- | ---: | --- |
| authenticated_security_definer_function_executable | 13 WARN | Still reported; per-function static authorization review below |
| rls_enabled_no_policy | 2 INFO | Closed client ACL confirmed; do not add an open policy to silence the lint |
| auth_leaked_password_protection | 1 WARN | Still reported; enabling it is outside this task's agreed scope |

No Advisor finding was suppressed or marked resolved through the platform.
The 13 functions should be described as **intentionally exposed, restricted
APIs with static owner/ACL evidence**, not as 13 proven cross-owner exploits or
13 fully cleared false positives. Authenticated negative and concurrency tests
remain necessary before a stronger conclusion.

## Common catalog findings

All 13 functions are in `public`, owned by `postgres`, and are SECURITY DEFINER.
All have explicit authenticated EXECUTE and no PUBLIC or anon EXECUTE. No
PL/pgSQL dynamic-SQL `EXECUTE` token was found in these 13 stored bodies; this
observation is not a full semantic proof about every downstream helper.

ACL labels used below:

- **A**: `authenticated:EXECUTE`, `postgres:EXECUTE`,
  `service_role:EXECUTE`.
- **B**: `authenticated:EXECUTE`, `postgres:EXECUTE` only.

Fixed search-path labels used below, retaining the catalog's declared order:

- **P**: `public, pg_temp`.
- **E**: `public, extensions, pg_temp`.
- **C**: `pg_catalog, pg_temp`.
- **F**: `pg_catalog, public, extensions, pg_temp`.
- **H**: `public, pg_catalog`.

Catalog checks also confirmed authenticated and anon have no CREATE privilege
on either `public` or `extensions`. These checks reduce object-shadowing risk;
this is not a full transitive privilege audit of every role or future grant.

The following owner columns were confirmed NOT NULL:
`projects.owner_id`, `black_box_entries.user_id`, `focus_sessions.user_id`,
`routine_tasks.user_id`, and `sync_operation_log.user_id`. NULL owner predicates
must be interpreted with these schema constraints rather than assumed to allow
takeover of existing normal rows.

## The 13 exposed functions

Each signature below is schema-qualified by `public`. Each has owner postgres,
SECURITY DEFINER true, authenticated EXECUTE true, anon/PUBLIC EXECUTE false,
and no dynamic EXECUTE token in its own stored body.

| Signature | Body MD5 | ACL | Search path |
| --- | --- | --- | --- |
| sync_apply_offline_command(jsonb) | ec10ff29526e8741703d7c8b71f73fe5 | A | E |
| sync_delete_project(jsonb) | 320f0a29e1002c76fcefad3080d85cd5 | A | P |
| sync_delete_tasks(jsonb) | 0f32c820db5f7fdc5f985faf1b2042e9 | A | P |
| sync_increment_routine_completion(jsonb) | 82ab96dfd0a643722b4f6716f887bf7c | B | F |
| sync_upsert_blackbox_entry(jsonb) | fad6d03279d5cee3943f28527c16e192 | A | C |
| sync_upsert_connection(jsonb) | ff9617ce61f6354a9f50fd80c3f57260 | A | P |
| sync_upsert_focus_session(jsonb) | e23feb0b6836d4ffdd25f068cef07e2d | A | F |
| sync_upsert_project(jsonb) | 0deb49ab6bc849ed4a83db07ed53823c | A | P |
| sync_upsert_routine_task(jsonb) | b6f81140b419a5a02b81103995a82341 | A | F |
| sync_upsert_task(jsonb) | e9362d1b5bfa8e83489a0b81f694dc4f | B | F |
| sync_upsert_user_preferences(jsonb) | 3c4023116de6d255049999c84158b2a9 | A | F |
| user_has_project_access(uuid) | 19c50b5cc4e9e3d774f06eeea030fc57 | A | H |
| user_is_project_owner(uuid) | 19c50b5cc4e9e3d774f06eeea030fc57 | A | H |

### Owner/authentication predicates inspected

1. **sync_apply_offline_command** obtains `v_user` from `auth.uid()` and rejects
   NULL. It validates envelope/command identity, writes its command record with
   that user, and rejects an existing operation owned by another user. The
   capability checks can quarantine unsupported commands. Its shadow/projection
   behavior must not be mistaken for a confirmed domain write. Trigger checks
   are summarized below; this function alone does not validate every domain
   entity's ownership before shadow capture.
2. **sync_delete_project** requires auth, operation and project IDs. It locks the
   project and rejects an owner IS DISTINCT FROM the authenticated user before
   calling `soft_delete_project`. A missing row returns a zero-delete result.
   Existing-operation replay is user-bound, not fully raw-payload-bound.
3. **sync_delete_tasks** first requires an owned project. Per-task baseline
   reads are limited to that project, and the chosen soft-delete/purge helper
   receives that project ID. It does not authorize deletion merely because the
   caller supplies task IDs. Baseline handling and downstream concurrency were
   not dynamically exercised in this review.
4. **sync_increment_routine_completion** is a wrapper over a private replay
   resolver and private implementation. The implementation requires target
   user equal to auth.uid and locks a routine belonging to that user before
   recording/counting the completion.
5. **sync_upsert_blackbox_entry** rejects an existing entry with another owner;
   an optional project must belong to auth.uid. Insert user_id comes from auth,
   not a caller-supplied owner. NOT NULL user_id constrains the nullable-owner
   guard interpretation. It also has content/focus metadata size bounds.
6. **sync_upsert_connection** requires an owned target project, both live task
   endpoints in that project, and a matching existing connection project/owner.
   Tombstone checks and stale handling exist. Stale text overwrite and replay
   integrity remain residual issues, separately from ownership checks.
7. **sync_upsert_focus_session** requires payload user_id equal to auth.uid and
   rejects an existing session owned by another user. Its current production
   body still compares server updated_at together with snapshot savedAt. This
   is not the uncommitted logical-clock/reconciliation candidate.
8. **sync_upsert_project** locks an existing row and rejects a different owner.
   New row owner_id is auth.uid, not the payload owner. A remotely deleted row
   is not silently resurrected by this entrypoint.
9. **sync_upsert_routine_task** requires target user equal to auth.uid and rejects
   an existing routine task with another owner. The current NOT NULL user_id
   constraint applies to existing rows.
10. **sync_upsert_task** uses an owner-filtered changed-fields helper, then a
    private implementation that checks both target-project ownership and the
    existing task's project/owner. The wrapper's quarantine path is reached only
    after changed-fields evidence for a task joined to an owned project. Its
    private resolver still has the legacy replay limitation described below.
11. **sync_upsert_user_preferences** requires target user equal to auth.uid;
    existing preference access and upsert use that target. It does not accept a
    different payload owner as authorization.
12. **user_has_project_access** returns only EXISTS for the requested project ID
    with owner_id equal to `public.current_user_id()`.
13. **user_is_project_owner** has the same body/predicate as the preceding helper.
    `current_user_id()` is SECURITY INVOKER and its body is `SELECT auth.uid()`;
    body MD5: `ecebe343f1261298ac451006b34f3faa`.

These are static body predicates, not successful authenticated cross-owner
negative test results. No claim is made that all check-then-write concurrency
or all helper side effects have been exhaustively verified.

## Private helper and trigger evidence

The following inspected helpers are postgres-owned SECURITY DEFINER functions
with authenticated and anon EXECUTE both false:

| Signature | Body MD5 | Fixed search_path |
| --- | --- | --- |
| sync_upsert_task__unguarded_20260628(jsonb) | 062a87f0447431ebd5ce929ee528da2f | pg_catalog, pg_temp |
| sync_increment_routine_completion__unguarded_20260628(jsonb) | cdd60c9c86dbc29bd2b25c3db27ce70d | pg_catalog, pg_temp |
| sync_task_changed_fields(uuid,jsonb) | 86b33a18fa8de2f4cd4fd7c41021e86f | pg_catalog, pg_temp |
| sync_resolve_operation_replay(uuid,uuid,jsonb) | 844c0645856e4cbe270027e659b09bcf | pg_catalog, public, extensions, pg_temp |
| sync_apply_command_projection() | 8f53683386419b584fa101ac9d03fb4d | public, extensions, pg_temp |
| sync_apply_command_domain_tables() | 57a692b7e8639f7aef91a0cc03150571 | public, extensions, pg_temp |

The command log has two inspected non-internal AFTER INSERT triggers:
`trg_sync_command_projection` and `zzz_sync_command_domain_apply`.
The projection uses capability `field-lww-v1` and keys its projection by
NEW.user_id/entity type/entity ID. Domain apply uses capability `domain-apply-v1`
and routes supported commands to the domain RPCs. This is transitive static
inspection, not proof of every helper's race behavior or of active capability
configuration; no business configuration row was queried for this report.

## Receipt tables with zero policies

| Table | RLS | FORCE RLS | Policy count | Current table ACL | authenticated/anon DML |
| --- | --- | --- | ---: | --- | --- |
| public.widget_black_box_action_receipts | true | true | 0 | postgres=arwdDxtm/postgres | none |
| public.widget_focus_action_receipts | true | true | 0 | postgres=arwdDxtm/postgres | none |

The privilege check covered SELECT/INSERT/UPDATE/DELETE. Catalog ACL shows only
postgres table grants, rather than direct service_role table grants. Therefore
these should be described as privileged-function/service-mediated storage,
not as tables directly writable by the service role through a table ACL.
Do not add client policies to silence the two INFO findings.

The inspected Widget entrypoints are postgres-owned SECURITY DEFINER, deny
EXECUTE to authenticated and anon, and declare empty search_path:

| Signature | Body MD5 |
| --- | --- |
| apply_widget_black_box_action(uuid,uuid,uuid,text,integer,uuid) | a0864ccda79e94b01dd8b116559aba5d |
| apply_widget_focus_action(uuid,uuid,integer,uuid,text,uuid,integer,boolean,uuid,timestamp with time zone,jsonb,jsonb,timestamp with time zone,uuid,text,integer) | 624b53b2283509f4ce5d44fb64ca23c8 |

This receipt-table finding is consistent with intentional closed-client storage.
The audit did not broaden permissions or test Widget writes.

## Residual risks and unfinished acceptance

### Legacy replay integrity remains unresolved

Several older RPCs replay by operation ID and user without strict raw-payload
identity. The inspected `sync_resolve_operation_replay` rejects a mismatch when
an existing replay_payload_digest is non-NULL. When it is NULL, it backfills only
if the raw digest matches; otherwise it still returns the existing result.
That is a legacy payload-binding gap, not evidence that a different owner can
read another user's receipt. It affects deterministic replay/explainability and
must not be relabeled as safe merely because owner checks exist.

### LWW and Focus recovery remain unresolved

- `sync_upsert_connection` still permits a stale payload to replace title and
  description while preserving certain identity/deletion fields. Owner
  isolation does not prove this is acceptable LWW data-safety behavior.
- The production Focus body still uses historical mixed server/logical freshness.
  No logical-clock candidate, historical timestamp backfill or explicit CAS
  recovery migration was applied by this audit.
- The client preserving old payloads is not equivalent to implementing a
  user-confirmed local/remote recovery or resolving unknown outcomes.

### Dynamic negative/concurrency matrix not executed

Remaining evidence includes authenticated owner A/B calls, foreign project and
entity references, forged payload owners, operation-ID/digest reuse, direct-table
write interleavings, concurrent same-ID inserts, session refresh/owner switch,
trigger propagation, and target-bound rollback/replay verification. No such
production business operations were performed here.

The static review found no newly confirmed cross-owner bypass in the inspected
bodies. It does **not** prove absence of bypasses under all concurrent states,
all downstream helpers or future privilege changes.

## Recommended disposition

- Record the 13 WARNs as intentional restricted RPC exposure with current static
  owner/ACL evidence, while keeping dynamic negatives, concurrency and legacy
  replay issues UNRESOLVED. Do not report Advisor count zero.
- Record the two receipt INFOs as intentional closed-client ACL/no-policy
  storage. No client-policy relaxation is warranted by this finding alone.
- Keep leaked-password protection unchanged within the agreed scope.
- Do not revoke all authenticated RPC execution or convert functions to INVOKER
  merely to remove warnings: those changes require compatibility and privilege
  analysis, explicit authorization and separate tests.
- Revalidate function body hashes, ACLs, constraints and Advisor state after any
  relevant deployment; a later catalog snapshot supersedes this document.
