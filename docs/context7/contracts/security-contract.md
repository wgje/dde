---
title: Security Contract
status: canonical
audience: ai-agent, maintainer, operator
last_verified: 2026-11-09
source_paths:
  - .env.template
  - scripts/contracts/check-secrets.cjs
  - supabase/migrations/
  - supabase/functions/
  - src/config/virus-scan.config.ts
---

# Security Contract

This contract defines security behavior that must hold across frontend, Supabase, Edge Functions, and operations.

## Invariant Summary

| ID | Invariant | Evidence |
| --- | --- | --- |
| SEC-001 | Frontend source contains no service-role keys or third-party secrets. | `npm run audit:secrets` |
| SEC-002 | Browser uses only Supabase anon public key. | env template and config review |
| SEC-003 | Third-party secret calls go through Edge Functions. | Edge Function implementation |
| SEC-004 | User data is protected by RLS. | migrations and policy tests |
| SEC-005 | Storage bucket `attachments` is private. | Supabase setup and policies |
| SEC-006 | Markdown rendering is sanitized. | renderer tests and DOMPurify usage |
| SEC-007 | Upload paths validate type and size. | file validation tests |
| SEC-008 | Virus scan metadata stays coherent with attachments. | attachment tests and migrations |
| SEC-009 | Logout cleanup prevents cross-user local data leakage. | auth/logout tests |
| SEC-010 | Permission denied sync paths preserve rejected local data. | sync/recovery tests |

## Secret Boundary

Allowed in frontend:

- `NG_APP_SUPABASE_URL`
- `NG_APP_SUPABASE_ANON_KEY`
- `NG_APP_SENTRY_DSN`
- `NG_APP_GOJS_LICENSE_KEY`
- non-secret demo flags

Server-side only:

- `GROQ_API_KEY`
- FCM private key and service account fields
- Supabase service-role key
- Sentry auth token
- deployment provider tokens

## Supabase RLS Boundary

Tables must isolate by:

- authenticated user ID
- project ownership
- row owner ID
- storage path ownership

Any migration that adds a table must include RLS decisions in the same change.

## Edge Function Boundary

Edge Functions may use secrets. Frontend code must call Edge Functions through authenticated Supabase paths instead of direct third-party APIs when credentials are required.

Function implementations must:

- validate input
- check auth where user data is involved
- avoid returning secrets
- return structured errors
- preserve CORS behavior for expected browser calls

## Upload Boundary

Upload code must validate:

- MIME type
- size
- storage path ownership
- scan status where scan is required

Attachment metadata and storage objects must not drift.

## Security Verification

Minimum commands for security-sensitive changes:

```bash
npm run audit:secrets
npm run quality:guard:encoding
npm run docs:context7:validate
```

Add targeted service or E2E tests based on the touched layer.

## Auth Callback Test Isolation

Auth callback unit and forced-isolate tests must inject a non-production Supabase URL and a dummy anon key through the test module boundary. These values are deterministic fixtures only; they are never runtime credentials and must not be copied into deployment environment files. The exchange and session calls remain mocked in this layer, while browser integration tests provide the separate evidence for configured Supabase environments.

## Security Change Checklist

1. Identify affected invariant IDs.
2. Confirm no frontend secret exposure.
3. Confirm RLS still isolates rows.
4. Confirm Edge Functions validate inputs.
5. Confirm upload and Markdown sanitization paths still hold when touched.
6. Update this contract if security behavior changes.
