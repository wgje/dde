import type { ProjectSaveResult } from './sync/project-save-flight-coordinator.service';

export function normalizeSimpleSyncProjectExecutionResult(
  result: ProjectSaveResult,
  fallbackVersion: number | undefined,
): ProjectSaveResult {
  return { ...result, newVersion: result.newVersion ?? fallbackVersion };
}
