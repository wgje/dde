---
title: Edge Functions API Reference
status: canonical
audience: ai-agent, maintainer, operator
last_verified: 2026-06-09
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
| `backup-alert` | backup alerting | alert credentials |
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

## Edge Function Rules

- Validate inputs.
- Check auth for user data.
- Never return secrets.
- Preserve CORS for browser calls.
- Use structured errors.
