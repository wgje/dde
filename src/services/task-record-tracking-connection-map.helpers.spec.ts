import { describe, expect, it, vi } from 'vitest';

import { createConnection } from './task-record-tracking.service.spec-helpers';
import { buildTaskRecordTrackingConnectionMap } from './task-record-tracking-connection-map.helpers';

describe('task-record-tracking-connection-map.helpers', () => {
  it('按 connection id 建立追踪 map', () => {
    const connection = createConnection({ id: 'conn-1' });
    const logger = { error: vi.fn() };

    const map = buildTaskRecordTrackingConnectionMap([connection], logger);

    expect(map.get('conn-1')).toBe(connection);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('跳过缺少 id 的连接并记录 source/target', () => {
    const logger = { error: vi.fn() };
    const connection = createConnection({ id: '', source: 'source-task', target: 'target-task' });

    const map = buildTaskRecordTrackingConnectionMap([connection], logger);

    expect(map.size).toBe(0);
    expect(logger.error).toHaveBeenCalledWith('连接缺少 id，已跳过变更追踪', {
      source: 'source-task',
      target: 'target-task',
    });
  });
});
