import { AUTH_CONFIG } from '../config/auth.config';

export type ProjectProcessorStopDecision =
  | { kind: 'continue' }
  | { kind: 'warn'; message: string; data: Record<string, unknown> }
  | { kind: 'quarantine'; reason: string };

export function buildConflictingOwnerHintsReason(
  actionType: string,
  candidates: Array<string | null | undefined>,
): string | null {
  const ownerHints = [...new Set(candidates.filter((candidate): candidate is string =>
    typeof candidate === 'string' && candidate.length > 0
  ))];
  return ownerHints.length <= 1
    ? null
    : `${actionType} 队列 owner 元数据冲突 (${ownerHints.join(' vs ')})，已转入失败记录`;
}

export function resolveProjectMutationStopDecision(input: {
  actionType: 'create' | 'update';
  currentProjectSyncSource?: 'local-only' | 'synced';
  payloadProjectSyncSource?: 'local-only' | 'synced';
  projectId: string;
  sourceUserId?: string;
  userId: string;
}): ProjectProcessorStopDecision {
  if (input.userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
    return {
      kind: 'warn',
      message: `project:${input.actionType} 跳过：本地模式不进入云端队列`,
      data: { projectId: input.projectId },
    };
  }

  const currentProjectSynced = input.currentProjectSyncSource === 'synced';
  if ((input.payloadProjectSyncSource === 'local-only' || input.currentProjectSyncSource === 'local-only') && !currentProjectSynced) {
    return {
      kind: 'warn',
      message: `project:${input.actionType} 跳过：local-only 项目不进入云端队列`,
      data: { projectId: input.projectId },
    };
  }

  if (input.sourceUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
    return {
      kind: 'quarantine',
      reason: `project:${input.actionType} legacy local-user 队列项禁止自动上云，请人工确认后重试`,
    };
  }

  if (input.sourceUserId && input.sourceUserId !== input.userId) {
    return {
      kind: 'quarantine',
      reason: `project:${input.actionType} 队列来源用户 ${input.sourceUserId} 与当前账号 ${input.userId} 不匹配，已转入失败记录`,
    };
  }

  if (typeof input.sourceUserId !== 'string') {
    return {
      kind: 'quarantine',
      reason: `project:${input.actionType} legacy 队列项缺少来源元数据，无法安全判断归属，已转入失败记录`,
    };
  }

  return { kind: 'continue' };
}

export function resolveProjectDeleteStopDecision(input: {
  projectId: string;
  sourceUserId: string | null;
  userId: string;
}): ProjectProcessorStopDecision {
  const { projectId, sourceUserId, userId } = input;

  if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
    return {
      kind: 'warn',
      message: 'project:delete 跳过：本地模式不进入云端队列',
      data: { projectId },
    };
  }

  if (sourceUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
    return {
      kind: 'quarantine',
      reason: 'project:delete legacy local-user 删除队列项禁止自动上云，请人工确认后重试',
    };
  }

  if (!sourceUserId) {
    return {
      kind: 'quarantine',
      reason: 'project:delete legacy 队列项缺少来源元数据，无法安全判断归属，已转入失败记录',
    };
  }

  if (sourceUserId !== userId) {
    return {
      kind: 'quarantine',
      reason: `project:delete 队列来源用户 ${sourceUserId} 与当前账号 ${userId} 不匹配，已转入失败记录`,
    };
  }

  return { kind: 'continue' };
}
