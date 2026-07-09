import { describe, expect, it } from 'vitest';
import { checkIndexedDBStoreRecords } from './indexeddb-health-record-check.helpers';

describe('checkIndexedDBStoreRecords', () => {
  it('reports non-object records when JSON parse checks are enabled', () => {
    const result = checkIndexedDBStoreRecords({
      records: [null, 'broken'],
      storeName: 'tasks',
      requiredFields: ['id', 'title'],
      checkJsonParse: true,
      checkRequiredFields: true,
    });

    expect(result.checked).toBe(2);
    expect(result.failed).toBe(2);
    expect(result.issues).toEqual([
      {
        type: 'json-parse-error',
        severity: 'error',
        message: '[tasks] 记录不是有效的对象',
        store: 'tasks',
        recovery: 'prompt-recovery',
      },
      {
        type: 'json-parse-error',
        severity: 'error',
        message: '[tasks] 记录不是有效的对象',
        store: 'tasks',
        recovery: 'prompt-recovery',
      },
    ]);
  });

  it('reports the first missing required field once per record', () => {
    const result = checkIndexedDBStoreRecords({
      records: [
        { id: 'task-1', title: 'Ready' },
        { id: 'task-2' },
        { title: 'Missing id too' },
      ],
      storeName: 'tasks',
      requiredFields: ['id', 'title'],
      checkJsonParse: true,
      checkRequiredFields: true,
    });

    expect(result.checked).toBe(3);
    expect(result.failed).toBe(2);
    expect(result.issues).toEqual([
      {
        type: 'schema-mismatch',
        severity: 'warning',
        message: '[tasks] 记录缺少必填字段 "title"',
        store: 'tasks',
        recordId: 'task-2',
        recovery: 'prompt-recovery',
      },
      {
        type: 'schema-mismatch',
        severity: 'warning',
        message: '[tasks] 记录缺少必填字段 "id"',
        store: 'tasks',
        recordId: undefined,
        recovery: 'prompt-recovery',
      },
    ]);
  });

  it('skips disabled validation stages', () => {
    const result = checkIndexedDBStoreRecords({
      records: [null, { id: 'project-1' }],
      storeName: 'projects',
      requiredFields: ['id', 'name'],
      checkJsonParse: false,
      checkRequiredFields: false,
    });

    expect(result).toEqual({
      checked: 2,
      failed: 0,
      issues: [],
    });
  });
});
