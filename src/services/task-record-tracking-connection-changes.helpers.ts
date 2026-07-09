import type { Connection, Project } from '../models';
import type { ChangeTrackerService } from './change-tracker.service';
import type { CategoryLogger } from './logger.service';
import { hasTrackedConnectionFieldChanged } from './task-record-tracking-outbox.helpers';
import { getTaskRecordTrackingConnectionKey } from './task-record-tracking-connection-map.helpers';

export interface TrackTaskRecordConnectionChangesOptions {
  afterProject: Project;
  beforeConnectionMap: Map<string, Connection>;
  changeTracker: Pick<
    ChangeTrackerService,
    'trackConnectionCreate' | 'trackConnectionUpdate' | 'trackConnectionDelete'
  >;
  logger: Pick<CategoryLogger, 'error'>;
}

export function trackTaskRecordConnectionChanges({
  afterProject,
  beforeConnectionMap,
  changeTracker,
  logger,
}: TrackTaskRecordConnectionChangesOptions): void {
  const afterConnectionMap = new Map<string, Connection>();
  for (const connection of afterProject.connections) {
    const key = getTaskRecordTrackingConnectionKey(connection, logger);
    if (!key) {
      continue;
    }
    afterConnectionMap.set(key, connection);
    const beforeConnection = beforeConnectionMap.get(key);

    if (!beforeConnection) {
      changeTracker.trackConnectionCreate(afterProject.id, connection);
      continue;
    }

    if (!hasTrackedConnectionFieldChanged(beforeConnection, connection)) {
      continue;
    }

    changeTracker.trackConnectionUpdate(afterProject.id, connection);
  }

  for (const [key, beforeConnection] of beforeConnectionMap) {
    if (afterConnectionMap.has(key)) {
      continue;
    }

    changeTracker.trackConnectionDelete(afterProject.id, beforeConnection);
  }
}
