export type RetryQueueItemTerminalReason =
  | 'missing-project-id'
  | 'invalid-data-id'
  | 'task-upsert-missing-updated-at'
  | 'drop-legacy-local-user'
  | 'drop-legacy-missing-source-user';
