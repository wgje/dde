import type { HealthIssue } from './indexeddb-health.service';

export interface IndexedDBStoreRecordCheckOptions {
  records: unknown[];
  storeName: string;
  requiredFields: readonly string[];
  checkJsonParse: boolean;
  checkRequiredFields: boolean;
}

export interface IndexedDBStoreRecordCheckResult {
  checked: number;
  failed: number;
  issues: HealthIssue[];
}

export function checkIndexedDBStoreRecords(
  options: IndexedDBStoreRecordCheckOptions,
): IndexedDBStoreRecordCheckResult {
  const issues: HealthIssue[] = [];
  let checked = 0;
  let failed = 0;

  for (const record of options.records) {
    checked++;

    if (options.checkJsonParse && !isRecord(record)) {
      failed++;
      issues.push(createJsonParseIssue(options.storeName));
      continue;
    }

    if (options.checkRequiredFields && isRecord(record)) {
      const issue = findRequiredFieldIssue(record, options.storeName, options.requiredFields);
      if (issue) {
        failed++;
        issues.push(issue);
      }
    }
  }

  return { checked, failed, issues };
}

function createJsonParseIssue(storeName: string): HealthIssue {
  return {
    type: 'json-parse-error',
    severity: 'error',
    message: `[${storeName}] 记录不是有效的对象`,
    store: storeName,
    recovery: 'prompt-recovery',
  };
}

function findRequiredFieldIssue(
  record: Record<string, unknown>,
  storeName: string,
  requiredFields: readonly string[],
): HealthIssue | null {
  for (const field of requiredFields) {
    if (record[field] === undefined || record[field] === null) {
      return {
        type: 'schema-mismatch',
        severity: 'warning',
        message: `[${storeName}] 记录缺少必填字段 "${field}"`,
        store: storeName,
        recordId: typeof record['id'] === 'string' ? record['id'] : undefined,
        recovery: 'prompt-recovery',
      };
    }
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}
