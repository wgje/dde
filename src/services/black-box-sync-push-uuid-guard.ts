import type { BlackBoxEntry } from '../models/focus';
import { isValidUUID } from '../utils/validation';

export function isValidBlackBoxId(id: string): boolean {
  return isValidUUID(id);
}

export function isValidBlackBoxProjectId(projectId: string | null | undefined): boolean {
  return projectId == null || isValidUUID(projectId);
}

export function isBlackBoxPushUuidValid(entry: BlackBoxEntry): boolean {
  return isValidBlackBoxId(entry.id) && isValidBlackBoxProjectId(entry.projectId);
}
