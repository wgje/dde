import type { Connection } from '../models';

interface TaskRecordConnectionMapLogger {
  error(message: string, data?: Record<string, unknown>): void;
}

export function getTaskRecordTrackingConnectionKey(
  connection: Pick<Connection, 'id' | 'source' | 'target'>,
  logger: TaskRecordConnectionMapLogger,
): string | null {
  if (!connection.id) {
    logger.error('连接缺少 id，已跳过变更追踪', {
      source: connection.source,
      target: connection.target,
    });
    return null;
  }

  return connection.id;
}

export function buildTaskRecordTrackingConnectionMap(
  connections: Connection[],
  logger: TaskRecordConnectionMapLogger,
): Map<string, Connection> {
  const connectionMap = new Map<string, Connection>();
  for (const connection of connections) {
    const key = getTaskRecordTrackingConnectionKey(connection, logger);
    if (key) {
      connectionMap.set(key, connection);
    }
  }
  return connectionMap;
}
