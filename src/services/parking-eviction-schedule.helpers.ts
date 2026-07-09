import type { Task } from '../models';

export function selectStaleParkingEvictionCandidates(
  tasks: readonly Task[],
  now: number,
  staleThresholdMs: number,
): Task[] {
  return tasks.filter(task => isStaleParkingEvictionCandidate(task, now, staleThresholdMs));
}

function isStaleParkingEvictionCandidate(
  task: Task,
  now: number,
  staleThresholdMs: number,
): boolean {
  const parkingMeta = task.parkingMeta;
  if (!parkingMeta || parkingMeta.state === 'focused') {
    return false;
  }

  if (parkingMeta.pinned) {
    return false;
  }

  const lastVisited = resolveParkingLastVisitedTimestamp(task, now);
  return lastVisited !== null && now - lastVisited >= staleThresholdMs;
}

function resolveParkingLastVisitedTimestamp(task: Task, now: number): number | null {
  const parkingMeta = task.parkingMeta;
  if (!parkingMeta) {
    return null;
  }

  if (parkingMeta.lastVisitedAt) {
    return parseParkingTimestamp(parkingMeta.lastVisitedAt);
  }

  if (parkingMeta.parkedAt) {
    return parseParkingTimestamp(parkingMeta.parkedAt);
  }

  return now;
}

function parseParkingTimestamp(value: string): number | null {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}
