---
title: Configuration Reference
status: canonical
audience: ai-agent, maintainer
last_verified: 2026-06-09
source_paths:
  - src/config/sync.config.ts
  - src/config/focus.config.ts
  - src/config/parking.config.ts
  - src/config/layout.config.ts
  - src/config/timeout.config.ts
  - src/config/auth.config.ts
  - src/config/feature-flags.config.ts
---

# Configuration Reference

This page is the machine-readable reference for NanoFlow configuration constants that affect architecture, sync behavior, UX lifecycle, security posture, and verification.

## Runtime Requirements

| Item | Value | Source |
| --- | --- | --- |
| Node.js | `>= 22.14.0` | `package.json` |
| Angular | `19.2.x` | `package.json` |
| TypeScript | `~5.8.0` | `package.json` |
| Supabase JS | `^2.84.0` or newer in current package | `package.json` |
| GoJS | `^3.1.1` | `package.json` |
| Vitest | `^4.0.14` | `package.json` |
| Playwright | `^1.48.0` | `package.json` |

## Sync Configuration

Source: `src/config/sync.config.ts`.

| Constant | Value | Contract |
| --- | --- | --- |
| `SYNC_CONFIG.DEBOUNCE_DELAY` | `3000` | Cloud pushes wait for a stable edit window. |
| `SYNC_CONFIG.EDITING_TIMEOUT` | `5000` | Local editing receives a grace period before remote interference. |
| `SYNC_CONFIG.REMOTE_CHANGE_DELAY` | `2000` | Remote changes are delayed to reduce local edit disruption. |
| `SYNC_CONFIG.CONFLICT_TIME_THRESHOLD` | `10000` | Conflict threshold for timestamp ambiguity. |
| `SYNC_CONFIG.CLOUD_LOAD_TIMEOUT` | `30000` | Cloud project loads should not hang indefinitely. |
| `SYNC_CONFIG.LOCAL_AUTOSAVE_INTERVAL` | `3000` | Local persistence cadence. |
| `SYNC_CONFIG.CONNECTIVITY_PROBE_INTERVAL` | `15000` | Network recovery probe cadence. |
| `SYNC_CONFIG.CONNECTIVITY_PROBE_TIMEOUT` | `5000` | Probe timeout. |
| `SYNC_CONFIG.MAX_RETRY_QUEUE_SIZE` | `100` | localStorage queue soft bound. |
| `SYNC_CONFIG.MAX_RETRY_QUEUE_SIZE_INDEXEDDB` | `1000` | IndexedDB-backed queue bound. |
| `SYNC_CONFIG.MAX_RETRY_ITEM_AGE` | 24 hours | Old retry items should not live forever. |
| `SYNC_CONFIG.POLLING_INTERVAL` | `600000` | Idle polling fallback. |
| `SYNC_CONFIG.POLLING_ACTIVE_INTERVAL` | `120000` | Active polling fallback. |
| `SYNC_CONFIG.USER_ACTIVE_TIMEOUT` | `60000` | Active/idle classification. |
| `SYNC_CONFIG.TOMBSTONE_CACHE_TTL` | 30 minutes | Tombstone query cache TTL. |
| `SYNC_CONFIG.CURSOR_SAFETY_LOOKBACK_MS` | `30000` | Delta sync safety lookback. |
| `SYNC_CONFIG.DIRTY_PROTECTION_WINDOW_MS` | 10 minutes | Protects local dirty fields from premature remote overwrite. |
| `SYNC_CONFIG.TOMBSTONE_RETENTION_MS` | 30 days | Local tombstone retention. |
| `SYNC_CONFIG.BLACKBOX_PULL_FRESHNESS_WINDOW` | `30000` | Black Box repeated pull suppression. |

## Field Selection Configuration

Source: `FIELD_SELECT_CONFIG` in `src/config/sync.config.ts`.

Task reads must include:

- `id`
- `title`
- `content`
- `stage`
- `parent_id`
- `order`
- `rank`
- `status`
- `x`
- `y`
- `updated_at`
- `deleted_at`
- `short_id`
- `attachments`
- `tags`
- `priority`
- `due_date`
- `expected_minutes`
- `cognitive_load`
- `wait_minutes`
- `created_at`
- `completed_at`
- `parking_meta`
- `attention_meta`

The `content` field is mandatory. Removing it can overwrite local task bodies during merge.

## Durability Configuration

| Constant | Value | Meaning |
| --- | --- | --- |
| `SYNC_DURABILITY_CONFIG.DROP_POLICY` | `'soft-overflow'` | Do not discard user writes just because soft queue size is exceeded. |
| `SYNC_DURABILITY_CONFIG.STORAGE_PRESSURE_MODE` | `'memory-fallback'` | Prefer recoverable fallback over freezing normal work. |
| `SYNC_DURABILITY_CONFIG.CURSOR_STRATEGY` | `'max-server-updated-at'` | Delta cursors advance from server-observed timestamps. |

## Request Throttle Configuration

| Constant | Value |
| --- | --- |
| `REQUEST_THROTTLE_CONFIG.MAX_CONCURRENT` | `4` |
| `REQUEST_THROTTLE_CONFIG.DEFAULT_TIMEOUT` | `60000` |
| `REQUEST_THROTTLE_CONFIG.BATCH_SYNC_TIMEOUT` | `90000` |
| `REQUEST_THROTTLE_CONFIG.INDIVIDUAL_OPERATION_TIMEOUT` | `30000` |
| `REQUEST_THROTTLE_CONFIG.DEFAULT_RETRIES` | `3` |
| `REQUEST_THROTTLE_CONFIG.MAX_QUEUE_SIZE` | `100` |
| `REQUEST_THROTTLE_CONFIG.SEQUENTIAL_OP_DELAY_MS` | `200` |

## Circuit Breaker Configuration

| Constant | Value |
| --- | --- |
| `CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD` | `3` |
| `CIRCUIT_BREAKER_CONFIG.RECOVERY_TIME` | `30000` |
| `CIRCUIT_BREAKER_CONFIG.HALF_OPEN_REQUESTS` | `1` |
| trigger types | `NetworkError`, `NetworkTimeoutError`, `GatewayError`, `ServiceUnavailableError`, `UnknownServerError` |

## Permission Denied Configuration

| Constant | Value | Meaning |
| --- | --- | --- |
| `PERMISSION_DENIED_CONFIG.ON_PERMISSION_DENIED` | `'isolate-and-notify'` | Keep rejected local data recoverable. |
| `PERMISSION_DENIED_CONFIG.REJECTED_DATA_RETENTION` | 7 days | Retention for isolated rejected data. |
| `PERMISSION_DENIED_CONFIG.MAX_ISOLATE_SIZE` | 10 MB | Larger payloads should force download/export. |
| `PERMISSION_DENIED_CONFIG.TRIGGER_EMERGENCY_EXPORT` | `true` | Emergency export is enabled. |

## Focus Configuration

Source: `src/config/focus.config.ts`.

| Constant | Value | Meaning |
| --- | --- | --- |
| `FOCUS_CONFIG.GATE.PENDING_DAYS_RANGE` | `7` | Gate scans recent pending entries. |
| `FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY` | `3` | Daily snooze hard limit. |
| `FOCUS_CONFIG.GATE.READ_REAPPEAR_COOLDOWN_MS` | 30 minutes | Read incomplete entries can reappear later. |
| `FOCUS_CONFIG.STRATA.MAX_DISPLAY_DAYS` | `30` | Strata history window. |
| `FOCUS_CONFIG.BLACK_BOX.TRANSCRIBE_TIMEOUT` | `30000` | Transcription client timeout. |
| `FOCUS_CONFIG.SPEECH_TO_TEXT.MODEL` | `'whisper-large-v3'` | Groq model. |
| `FOCUS_CONFIG.SPEECH_TO_TEXT.LANGUAGE` | `'zh'` | Speech language. |
| `FOCUS_CONFIG.SPEECH_TO_TEXT.DAILY_QUOTA` | `50` | Daily transcription quota. |
| `FOCUS_CONFIG.SPEECH_TO_TEXT.EDGE_FUNCTION_NAME` | `'transcribe'` | Supabase Edge Function name. |
| `FOCUS_CONFIG.SPEECH_TO_TEXT.MAX_FILE_SIZE` | 25 MB | Groq upload limit. |

## Parking Configuration

Source: `src/config/parking.config.ts`.

High-impact constants:

| Constant | Value | Meaning |
| --- | --- | --- |
| `PARKING_CONFIG.PARKED_TASK_SOFT_LIMIT` | `10` | Soft UX limit for parked tasks. |
| `PARKING_CONFIG.MAX_SNOOZE_COUNT` | `5` | Dock reminder snooze cap. |
| `PARKING_CONFIG.MIN_TOUCH_TARGET` | `44` | Mobile touch target baseline. |
| `PARKING_CONFIG.DOCK_CONSOLE_SOFT_LIMIT` | `15` | Focus console soft count. |
| `PARKING_CONFIG.DOCK_CONSOLE_HARD_LIMIT` | `30` | Focus console hard count. |
| `PARKING_CONFIG.BURNOUT_WINDOW_MS` | 2 hours | Burnout sliding window. |
| `PARKING_CONFIG.BURNOUT_HIGH_LOAD_THRESHOLD` | `3` | High-load completions before burnout. |
| `PARKING_CONFIG.BURNOUT_COOLDOWN_MS` | 20 minutes | Cooldown. |
| `PARKING_CONFIG.REST_REMINDER_HIGH_LOAD_THRESHOLD_MS` | 90 minutes | Rest reminder for high load. |
| `PARKING_CONFIG.REST_REMINDER_LOW_LOAD_THRESHOLD_MS` | 30 minutes | Rest reminder for low load. |

## Layout and GoJS Configuration

Source: `src/config/layout.config.ts`.

| Constant | Value | Meaning |
| --- | --- | --- |
| `LAYOUT_CONFIG.STAGE_SPACING` | `260` | Horizontal stage spacing. |
| `LAYOUT_CONFIG.ROW_SPACING` | `140` | Task row spacing. |
| `FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH` | `100` | Hard traversal cap. |
| `GOJS_CONFIG.LAYER_SPACING` | `100` | GoJS layer spacing. |
| `GOJS_CONFIG.COLUMN_SPACING` | `40` | GoJS column spacing. |
| `GOJS_CONFIG.POSITION_SAVE_DEBOUNCE` | `300` | Flow position persistence debounce. |

## Auth and Guard Configuration

Source: `src/config/auth.config.ts`.

| Constant | Value |
| --- | --- |
| `AUTH_CONFIG.SESSION_CHECK_TIMEOUT` | `3000` |
| `AUTH_CONFIG.REMEMBER_ME_EXPIRY` | 24 hours |
| `AUTH_CONFIG.MIN_PASSWORD_LENGTH` | `8` |
| `AUTH_CONFIG.LOCAL_MODE_USER_ID` | `'local-user'` |
| `GUARD_CONFIG.DATA_INIT_TIMEOUT` | `8000` |
| `GUARD_CONFIG.SESSION_CHECK_TIMEOUT` | `2000` |

## Timeout Configuration

Source: `src/config/timeout.config.ts`.

| Constant | Value |
| --- | --- |
| `TIMEOUT_CONFIG.QUICK` | `5000` |
| `TIMEOUT_CONFIG.STANDARD` | `10000` |
| `TIMEOUT_CONFIG.HEAVY` | `30000` |
| `TIMEOUT_CONFIG.UPLOAD` | `60000` |
| `TIMEOUT_CONFIG.REALTIME` | `15000` |

## Critical Feature Flags

Source: `src/config/feature-flags.config.ts`.

Critical protective flags include:

- `CIRCUIT_BREAKER_ENABLED`
- `SESSION_EXPIRED_CHECK_ENABLED`
- `LOGOUT_CLEANUP_ENABLED`
- `CONNECTION_TOMBSTONE_ENABLED`
- `SYNC_STRICT_SUCCESS_ENABLED`
- `SYNC_DURABILITY_FIRST_ENABLED`
- `MIGRATION_SNAPSHOT_ENABLED`
- `MIGRATION_CONFIRMATION_REQUIRED`
- `SYNC_SERVER_CURSOR_ENABLED`
- `SYNC_TASK_LEVEL_CALLBACK_ENABLED`

Disabling these flags is a high-risk change and requires explicit verification plus documentation updates.
