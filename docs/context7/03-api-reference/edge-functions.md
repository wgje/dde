---
title: Edge Functions API Reference
status: canonical
audience: ai-agent, maintainer, operator
last_verified: 2026-11-10
source_paths:
  - supabase/functions/
  - src/config/focus.config.ts
---

# Edge Functions API Reference

## Functions

| Function | Public purpose | Secret boundary |
| --- | --- | --- |
| `transcribe` | speech-to-text proxy | `GROQ_API_KEY` |
| `virus-scan` | file scan workflow | scanner credentials if configured |
| `cleanup-attachments` | stale attachment cleanup | service-side access |
| `widget-register` | Android widget registration | user auth |
| `widget-summary` | widget summary read | user auth |
| `widget-notify` | widget refresh notification | FCM credentials |
| `widget-black-box-action` | Black Box widget actions | user auth |
| `widget-focus-action` | Focus widget actions | user auth |

## Transcription Config

| Field | Value |
| --- | --- |
| model | `whisper-large-v3` |
| language | `zh` |
| daily quota | `50` |
| max file size | 25 MB |
| function name | `transcribe` |

## Virus Scan Actions

`virus-scan` sets `verify_jwt = false` in `supabase/config.toml` so the function can accept both user requests and the internal cron request. This disables gateway JWT enforcement only; the function self-verifies every supported request path.

### User Actions

The user actions are `health`, `scan`, `status`, `verify-hash`, and `rescan`. They require `Authorization: Bearer <user-jwt>`. The function passes the token to `auth.getUser()`, rejects invalid or missing tokens, and scopes scan records by the verified `user_id`.

`rescan` performs a real re-scan, not a status-only stub:

1. Verify the caller owns the `attachment_scans` record for `fileId`, then mark it `scanning`.
2. Locate the stored object through `tasks.attachments` JSONB (`scanMetadata.fileId`) and download it from the private `attachments` bucket via the service-role client (`userId/projectId/taskId/attachmentId.ext`).
3. Run the same ClamAV scan as upload scanning and update the existing scan record (never insert a second row for the same `fileId`).

Failure paths are structured and fail-closed: missing attachment or storage object returns 404 `{ error: 'File not found in storage' }`, download failure returns 502, scanner failure returns the standard scan-failure shape with `status: 'failed'`; each failure also converges the scan record from `scanning` to `failed`.

### Internal Rescan Cron

`rescan-due` is an internal service-to-service action, not a user action. It does not accept a user JWT as its authorization boundary. The caller must send `x-virus-rescan-secret`, and the function self-verifies that header against the `VIRUS_RESCAN_CRON_SECRET` Edge Function secret before claiming due rows with the service-role RPC.

Configure the Edge Function secret with `supabase secrets set VIRUS_RESCAN_CRON_SECRET=<random-secret>`. The `virus_scan_cron_secret` value stored in Supabase Vault for `scripts/virus-rescan-cron-setup.sql` must contain the same secret. Do not expose either value to browser clients.

## Edge Function Rules

- Validate inputs.
- Check auth for user data.
- Never return secrets.
- Preserve CORS for browser calls.
- Use structured errors.
