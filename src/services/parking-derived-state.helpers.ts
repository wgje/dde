export interface ParkingStateTask {
  id?: string;
  parkingMeta?: {
    state?: string;
    reminder?: {
      reminderAt?: string | null;
    } | null;
  } | null;
}

export interface ParkingProjectRef {
  id: string;
  deletedAt?: string | null;
}

export function findFocusedParkingTask<T extends ParkingStateTask>(tasks: readonly T[]): T | null {
  return tasks.find(task => task.parkingMeta?.state === 'focused') ?? null;
}

export function hasUpcomingParkingReminder(
  tasks: readonly ParkingStateTask[],
  nowMs: number,
  upcomingWindowMs: number,
): boolean {
  return tasks.some(task => {
    const reminderAt = task.parkingMeta?.reminder?.reminderAt;
    if (!reminderAt) return false;
    const diff = new Date(reminderAt).getTime() - nowMs;
    return diff > 0 && diff < upcomingWindowMs;
  });
}

export function getActiveParkingProjectIds(projects: readonly ParkingProjectRef[]): string[] {
  const projectIds = new Set<string>();
  for (const project of projects) {
    if (!project.deletedAt) {
      projectIds.add(project.id);
    }
  }
  return Array.from(projectIds);
}

export function isParkingOverSoftLimit(parkedCount: number, softLimit: number): boolean {
  return parkedCount >= softLimit;
}
