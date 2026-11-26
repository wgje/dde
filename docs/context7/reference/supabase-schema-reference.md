---
title: Supabase Schema Reference
status: canonical
audience: ai-agent, maintainer, operator
last_verified: 2026-11-25
source_paths:
  - supabase/migrations/
  - supabase/functions/
  - src/models/supabase-types.ts
  - src/config/sync.config.ts
---

# Supabase Schema Reference

NanoFlow uses Supabase for Auth, PostgreSQL, Storage, Edge Functions, and server-side secrets. This reference summarizes the cloud-facing contract.

## Cloud Ownership

| Layer | Owner |
| --- | --- |
| Authentication | Supabase Auth |
| Relational data | Supabase PostgreSQL |
| Authorization | PostgreSQL RLS policies |
| Files | Supabase Storage private bucket `attachments` |
| Third-party secret calls | Supabase Edge Functions |
| Public browser access | Supabase anon key only |

## Core Tables and Row Concepts

The exact SQL is migration-owned. Current app code expects these row concepts:

| Concept | Required fields or semantics |
| --- | --- |
| projects | `id`, owner/user column, `title`, `description`, `created_date`, `updated_at`, `version`, `deleted_at`, migration marker |
| tasks | `id`, `project_id`, `title`, `content`, tree/order fields, `updated_at`, `deleted_at`, attachments, planning fields, `parking_meta`, `attention_meta` |
| connections | `id`, `project_id`, `source_id`, `target_id`, `title`, `description`, `deleted_at`, `updated_at` |
| task tombstones | deleted task identity, project identity, deletion timestamp |
| connection tombstones | deleted connection identity, project identity, deletion timestamp |
| black box entries | user identity, project identity, content, status, snooze fields, `updated_at`, `deleted_at` |
| focus preferences | user identity, preference payload, `updated_at` |
| dock/focus snapshots | user identity, snapshot payload, `updated_at` |
| attachment metadata | private object paths and scan metadata |

## Migrations of Interest

Recent migration files include:

| Migration | Purpose |
| --- | --- |
| `20260531070000_task_change_audit_forensics.sql` | task change audit and forensic support |
| `20260531120000_database_hardening_dr_controls.sql` | database hardening and disaster recovery controls |
| `20260531123000_advisor_followup_rls_and_function_exposure.sql` | RLS and function exposure follow-up |
| `20260531125000_quarantine_digest_and_audit_origin_hardening.sql` | quarantine digest and audit origin hardening |
| `20260603120000_black_box_completed_at.sql` | Black Box completion timestamp |
| `20260605062000_task_attention_meta.sql` | task sidecar attention metadata |
| `20260606050000_security_sync_followup.sql` | sync/security hardening |
| `20260606051000_sync_upsert_task_stale_result.sql` | stale-result handling for task upsert |
| `20260606052000_transcription_quota_and_cleanup_hardening.sql` | transcription quota and cleanup hardening |
| `20260609010000_task_attachment_payload_sync.sql` | attachment payload sync |
| `20260609020000_drop_entity_uuid_defaults.sql` | remove database UUID defaults to enforce client IDs |
| `20260609020100_active_connections_view_permissions.sql` | active connections view permissions |
| `20261125120000_offline_command_quarantine_connection_delete.sql` | keep connection-delete out of server domain apply until tombstone translation is verified; index owner-scoped domain-apply receipts |

## Offline Command Storage

The command transport schema is additive and remains opt-in. `sync_protocol_state.capabilities` defaults to an empty JSON array; fresh-init repairs only malformed or null values and does not clear explicitly configured capabilities. Keep the legacy durable queue active unless the corresponding server and client replay paths have been separately enabled and verified.

Internal command state is stored in `sync_command_log`, `sync_command_projection`, and `sync_command_domain_apply_log`. These tables use forced RLS, authenticated owner-scoped reads where required, and service-role writes. The receipt table has an index on `user_id` for its owner policy; this supports the same RLS filter and does not grant additional access.

`connection.delete` remains quarantined from server domain apply. The legacy connection upsert path is not a verified tombstone translation, so enabling this command there could acknowledge a delete without applying the correct tombstone semantics. Other replayable commands remain bounded by the final domain-apply allowlist.

## Storage Contract

Bucket:

- `attachments`
- private

Rules:

- Browser code uses user-scoped access only.
- Upload paths must be validated.
- Scan metadata must remain associated with attachment metadata.
- Large files use upload timeouts from `TIMEOUT_CONFIG.UPLOAD`.

## Edge Functions

Function directories:

- `_shared`
- `cleanup-attachments`
- `transcribe`
- `virus-scan`
- `widget-black-box-action`
- `widget-focus-action`
- `widget-notify`
- `widget-register`
- `widget-summary`

## Edge Function Contracts

| Function | Purpose | Sensitive inputs |
| --- | --- | --- |
| `transcribe` | proxy speech audio to Groq `whisper-large-v3` | `GROQ_API_KEY` |
| `virus-scan` | scan uploaded files or record scan state | scanner service credentials if configured |
| `cleanup-attachments` | remove stale or deleted attachment objects | service-side access |
| `widget-register` | register Android widget/device context | user auth |
| `widget-summary` | serve widget summary | user auth |
| `widget-notify` | notify widget refresh, optionally FCM | FCM credentials |
| `widget-black-box-action` | handle widget Black Box actions | user auth |
| `widget-focus-action` | handle widget Focus actions | user auth |

## RLS Contract

RLS must enforce:

- users can access only their projects
- tasks inherit project ownership
- connections inherit project ownership
- black box and focus rows are scoped by user
- storage objects are not public by default
- server-side maintenance functions use explicit security boundaries

## Sync Query Contract

Project queries must include `updated_at` and `deleted_at`.

Task queries must include `content`, `attachments`, `parking_meta`, `attention_meta`, `updated_at`, and `deleted_at`.

Connection queries must include `source_id`, `target_id`, `updated_at`, and `deleted_at`.

Incremental sync uses `updated_at > last_sync_time` with a safety lookback where configured.

## Schema Change Checklist

1. Write a migration.
2. Ensure RLS policies still isolate user data.
3. Update TypeScript models.
4. Update Supabase row types or generated types.
5. Update mappers and field selectors.
6. Update import/export and recovery paths.
7. Update Context7 docs under `docs/context7`.
8. Run `npm run docs:context7:validate`.
9. Run affected service and contract tests.

## Fresh-init execution order

Create `public.projects` before SQL-language owner/access helpers that reference it. The initial `active_tasks` view must use an explicit stable column prefix compatible with its final replacement; a changing `SELECT t.*` prefix can make PostgreSQL reject the later view. Validate a fresh database with function-body checks enabled. Local replay and rollback receipts do not establish production parity.
