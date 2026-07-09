import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('local-first write path contract', () => {
  it('does not keep post-commit outbox rollback paths in task record tracking', () => {
    const filePath = path.join(process.cwd(), 'src/services/task-record-tracking.service.ts');
    const source = fs.readFileSync(filePath, 'utf8');

    const forbiddenFragments = [
      'enqueueOutboxDurably(',
      'rollbackLocalMutationAfterOutboxFailure(',
      '本次本地变更已撤回',
    ];

    const violations = forbiddenFragments.filter(fragment => source.includes(fragment));

    expect(violations).toEqual([]);
  });
});
