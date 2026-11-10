---
title: API and Edge Functions
status: canonical
audience: ai-agent, maintainer, operator
last_verified: 2026-11-10
source_paths:
  - supabase/functions/
  - src/config/focus.config.ts
  - src/services/speech-to-text*.ts
  - src/config/virus-scan.config.ts
---

# API and Edge Functions

NanoFlow uses Supabase for cloud auth, storage, database access, and Edge Functions. Frontend code must never call third-party APIs with sensitive credentials directly.

## Supabase Responsibilities

| Supabase area | Responsibility |
| --- | --- |
| Auth | user sessions and account identity |
| PostgreSQL | projects, tasks, connections, black box entries, focus/dock support tables |
| RLS | owner/user isolation |
| Storage | private attachment bucket named `attachments` |
| Edge Functions | transcription, widget APIs, cleanup, virus scan |
| Secrets | Groq API key, FCM credentials, service credentials |

## Edge Function Directory

Current function directories under `supabase/functions/`:

- `_shared`
- `cleanup-attachments`
- `transcribe`
- `virus-scan`
- `widget-black-box-action`
- `widget-focus-action`
- `widget-notify`
- `widget-register`
- `widget-summary`

## Speech Transcription

Frontend config:

- `FOCUS_CONFIG.SPEECH_TO_TEXT.MODEL = 'whisper-large-v3'`
- `FOCUS_CONFIG.SPEECH_TO_TEXT.LANGUAGE = 'zh'`
- `FOCUS_CONFIG.SPEECH_TO_TEXT.DAILY_QUOTA = 50`
- `FOCUS_CONFIG.SPEECH_TO_TEXT.EDGE_FUNCTION_NAME = 'transcribe'`
- max file size is 25 MB
- client timeout is 30 seconds

Secrets:

- `GROQ_API_KEY` belongs in Supabase Secrets

Frontend behavior:

1. record audio using supported MIME types
2. cache offline audio if needed
3. call `transcribe` through Supabase Edge Function
4. create or update `BlackBoxEntry`
5. preserve quota and error state for recovery

## Attachment Storage

Storage bucket:

- name: `attachments`
- visibility: private

Rules:

- Validate file type.
- Use signed or controlled access paths.
- Preserve attachment metadata in task sync fields.
- Use virus scanning paths where configured.
- Never expose service-role credentials in frontend code.

## Widget API Functions

Android widget functions support external summaries and actions:

- `widget-register`: register widget/device state
- `widget-summary`: read summary data for widget display
- `widget-notify`: notify widget refresh, optionally through FCM
- `widget-black-box-action`: process Black Box widget actions
- `widget-focus-action`: process Focus widget actions

Expected degradation:

- With FCM configured, dirty push can wake refresh paths.
- Without FCM, widget uses manual, unlock-triggered, or scheduled refresh.

## Error Handling

Supabase errors should be normalized through `supabaseErrorToError()`.

Application errors should use the Result Pattern:

- `success(data)`
- `failure(ErrorCodes.XXX, message)`

Global error severity levels:

- `SILENT`
- `NOTIFY`
- `RECOVERABLE`
- `FATAL`

Critical errors should be reported through lazy Sentry loading. Avoid loading Sentry eagerly on startup.

## Security Rules

- All user tables must have RLS.
- Data must be isolated by user ID or owner ID.
- Service-role operations must stay server-side.
- Third-party API keys must be configured through Supabase Secrets or deployment platform secrets.
- Markdown rendering must be sanitized to prevent XSS.
- File upload paths must validate MIME type and size and use virus scanning where enabled.
