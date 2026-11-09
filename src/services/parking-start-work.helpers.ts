import type { Task, TaskParkingMeta } from '../models';

export interface ParkingStartWorkUpdate {
  taskId: string;
  parkingMeta: TaskParkingMeta;
}

export interface BuildParkingStartWorkUpdatesInput {
  targetTask: Task;
  currentFocused: Task | null;
  now: string;
}

export function buildParkingStartWorkUpdates(
  input: BuildParkingStartWorkUpdatesInput,
): ParkingStartWorkUpdate[] {
  const { targetTask, currentFocused, now } = input;
  const updates: ParkingStartWorkUpdate[] = [];

  if (currentFocused && currentFocused.id !== targetTask.id && currentFocused.parkingMeta) {
    updates.push({
      taskId: currentFocused.id,
      parkingMeta: {
        ...currentFocused.parkingMeta,
        state: 'parked',
        parkedAt: now,
        lastVisitedAt: now,
      },
    });
  }

  updates.push({
    taskId: targetTask.id,
    parkingMeta: targetTask.parkingMeta
      ? { ...targetTask.parkingMeta, state: 'focused', lastVisitedAt: now }
      : {
        state: 'focused',
        parkedAt: null,
        lastVisitedAt: now,
        contextSnapshot: null,
        reminder: null,
        pinned: false,
      },
  });

  return updates;
}
