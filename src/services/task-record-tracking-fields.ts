import type { Connection, Task } from '../models';

export const TRACKED_TASK_FIELDS: Array<keyof Task & string> = [
  'title',
  'content',
  'status',
  'stage',
  'parentId',
  'order',
  'rank',
  'x',
  'y',
  'priority',
  'dueDate',
  'expected_minutes',
  'cognitive_load',
  'wait_minutes',
  'attachments',
  'deletedAt',
];

export const TRACKED_CONNECTION_FIELDS: Array<keyof Connection> = [
  'source',
  'target',
  'title',
  'deletedAt',
  'description',
];
