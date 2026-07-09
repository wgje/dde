import { Injectable, inject } from '@angular/core';
import { LoggerService } from './logger.service';

export type QueueStalePolicy = 'discard' | 'settle-owner';

@Injectable({
  providedIn: 'root',
})
export class ActionQueueViewStateService {
  private readonly logger = inject(LoggerService).category('ActionQueue');
  private queueViewGeneration = 0;
  private projectMutationViewGeneration = 0;
  private projectMutationViewByKey = new Map<string, number>();
  private queueInvalidations: Array<{ generation: number; stalePolicy: QueueStalePolicy }> = [];

  get currentQueueViewGeneration(): number {
    return this.queueViewGeneration;
  }

  invalidateQueueView(reason: string, stalePolicy: QueueStalePolicy = 'discard'): number {
    this.queueViewGeneration += 1;
    this.queueInvalidations.push({ generation: this.queueViewGeneration, stalePolicy });
    if (this.queueInvalidations.length > 16) {
      this.queueInvalidations = this.queueInvalidations.slice(-16);
    }
    this.logger.debug('队列视图已失效，旧处理循环将停止收尾', {
      reason,
      generation: this.queueViewGeneration,
      stalePolicy,
    });
    return this.queueViewGeneration;
  }

  isStaleProcess(processGeneration: number): boolean {
    return processGeneration !== this.queueViewGeneration;
  }

  isQueueViewCurrent(queueViewGeneration: number, ownerMatches: boolean): boolean {
    return queueViewGeneration === this.queueViewGeneration && ownerMatches;
  }

  getProjectMutationViewGeneration(projectId: string, ownerUserId: string): number {
    return this.projectMutationViewByKey.get(this.getProjectMutationViewKey(projectId, ownerUserId)) ?? 0;
  }

  invalidateProjectMutationView(projectId: string, ownerUserId: string): number {
    const key = this.getProjectMutationViewKey(projectId, ownerUserId);
    const generation = ++this.projectMutationViewGeneration;
    this.projectMutationViewByKey.set(key, generation);
    if (this.projectMutationViewByKey.size > 128) {
      const oldestKey = this.projectMutationViewByKey.keys().next().value as string | undefined;
      if (oldestKey) {
        this.projectMutationViewByKey.delete(oldestKey);
      }
    }

    this.logger.debug('项目 mutation 视图已失效，旧 project processor 将停止收尾', {
      projectId,
      ownerUserId,
      generation,
    });
    return generation;
  }

  getStaleProcessPolicy(processGeneration: number): QueueStalePolicy {
    return [...this.queueInvalidations]
      .reverse()
      .find(entry => entry.generation > processGeneration)?.stalePolicy ?? 'discard';
  }

  reset(): void {
    this.queueViewGeneration = 0;
    this.projectMutationViewGeneration = 0;
    this.projectMutationViewByKey.clear();
    this.queueInvalidations = [];
  }

  private getProjectMutationViewKey(projectId: string, ownerUserId: string): string {
    return `${ownerUserId}::${projectId}`;
  }
}
