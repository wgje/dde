import { Injectable, inject } from '@angular/core';
import { FLOATING_TREE_CONFIG } from '../config/layout.config';
import { PARKING_CONFIG } from '../config/parking.config';
import { DockEntry, DockLane } from '../models/parking-dock';
import { Task } from '../models';
import { TaskStore } from '../core-bridge';
import { ProjectStateService } from './project-state.service';
import { entryOrder } from './dock-engine.utils';

/**
 * 区域/调度推断服务：从 DockEngineService 拆分，负责 auto-lane 推断、
 * 树距离计算、邻接表缓存、zone rebalance 等纯逻辑。
 */
@Injectable({
  providedIn: 'root',
})
export class DockZoneService {
  private readonly taskStore = inject(TaskStore);
  private readonly projectState = inject(ProjectStateService);

  /** BFS 邻接表缓存（避免每次 computeTreeDistance 重新构建 O(n) 邻接表） */
  private adjacencyCache: {
    projectId: string;
    fingerprint: string;
    adjacency: Map<string, string[]>;
    createdAt: number;
  } | null = null;

  /** M-4: 缓存 TTL（5 分钟），防止长期持有过时邻接表 */
  private static readonly ADJACENCY_CACHE_TTL_MS = 5 * 60 * 1000;

  /**
   * 清除邻接表缓存。
   * 应在项目切换/删除时调用，防止长会话中缓存无限增长。
   */
  clearAdjacencyCache(): void {
    this.adjacencyCache = null;
  }

  // ---------------------------------------------------------------------------
  //  Public API
  // ---------------------------------------------------------------------------

  inferAutoLaneForTask(
    task: Task,
    sourceProjectId: string | null,
    selfTaskId?: string,
    entriesSnapshot: DockEntry[] = [],
  ): { lane: DockLane; relationScore: number | null; relationReason: string | null } {
    const referenceMain = this.pickReferenceMainEntry(selfTaskId, entriesSnapshot);
    if (!referenceMain) {
      return {
        lane: this.pickAutoLaneForNextEntry(entriesSnapshot),
        relationScore: 0,
        relationReason: 'auto:no-main-fallback',
      };
    }

    const referenceTask = this.taskStore.getTask(referenceMain.taskId);
    const referenceProjectId = this.resolveSourceProjectId(referenceMain);
    if (!referenceTask || !sourceProjectId || !referenceProjectId || sourceProjectId !== referenceProjectId) {
      return {
        lane: 'backup',
        relationScore: PARKING_CONFIG.ZONE_SCORE_CROSS_PROJECT_DEFAULT,
        relationReason: 'auto:cross-project-default-backup',
      };
    }

    let score = 0;
    const reasons: string[] = [];

    if (task.parentId === referenceTask.id || referenceTask.parentId === task.id) {
      score += PARKING_CONFIG.ZONE_SCORE_PARENT_CHILD;
      reasons.push('parent-child');
    }

    if (task.parentId && referenceTask.parentId && task.parentId === referenceTask.parentId) {
      score += PARKING_CONFIG.ZONE_SCORE_SHARED_PARENT;
      reasons.push('shared-parent');
    }

    if (this.hasDirectConnection(sourceProjectId, task.id, referenceTask.id)) {
      score += PARKING_CONFIG.ZONE_SCORE_DIRECT_CONNECTION;
      reasons.push('direct-connection');
    }

    // 树距离评分：同一棵树上的距离越近，优先级越高
    const treeDistance = this.computeTreeDistance(sourceProjectId, task.id, referenceTask.id);
    if (treeDistance !== null && treeDistance >= 2) {
      // 距离 2 → 40分，距离 3 → 30分，距离 4 → 20分，距离 5+ → 10分
      const distanceScore = Math.max(
        PARKING_CONFIG.ZONE_SCORE_TREE_DISTANCE_FLOOR,
        PARKING_CONFIG.ZONE_SCORE_TREE_DISTANCE_BASE - treeDistance * PARKING_CONFIG.ZONE_SCORE_TREE_DISTANCE_STEP,
      );
      score += distanceScore;
      reasons.push(`tree-distance:${treeDistance}`);
    }

    if (task.stage !== null && referenceTask.stage !== null && task.stage === referenceTask.stage) {
      score += PARKING_CONFIG.ZONE_SCORE_SAME_STAGE;
      reasons.push('same-stage');
      if (Math.abs((task.order ?? 0) - (referenceTask.order ?? 0)) <= 1) {
        score += PARKING_CONFIG.ZONE_SCORE_ADJACENT_ORDER;
        reasons.push('adjacent-order');
      }
    }

    const normalizedScore = Math.max(0, Math.min(100, score));
    const lane: DockLane = normalizedScore >= PARKING_CONFIG.ZONE_COMBO_THRESHOLD ? 'combo-select' : 'backup';
    return {
      lane,
      relationScore: normalizedScore,
      relationReason: reasons.length > 0
        ? `auto:${reasons.join('|')}`
        : 'auto:same-project-low-relation',
    };
  }

  pickAutoLaneForNextEntry(entriesSnapshot: DockEntry[] = []): DockLane {
    const autoEntries = entriesSnapshot
      .filter(entry => entry.status !== 'completed' && entry.zoneSource === 'auto');
    const comboCount = autoEntries.filter(entry => entry.lane === 'combo-select').length;
    const backupCount = autoEntries.length - comboCount;
    return comboCount <= backupCount ? 'combo-select' : 'backup';
  }

  rebalanceAutoZonesEntries(entriesSnapshot: DockEntry[], taskStore?: TaskStore): DockEntry[] {
    const store = taskStore ?? this.taskStore;
    let changed = false;
    const next = entriesSnapshot.map(entry => {
      if (entry.status === 'completed' || entry.zoneSource !== 'auto') return entry;
      const task = store.getTask(entry.taskId);
      if (!task) return entry;
      const sourceProjectId = entry.sourceProjectId ?? store.getTaskProjectId(entry.taskId);
      const inferred = this.inferAutoLaneForTask(task, sourceProjectId, entry.taskId, entriesSnapshot);
      if (
        entry.lane === inferred.lane &&
        (entry.relationScore ?? null) === inferred.relationScore &&
        (entry.relationReason ?? null) === inferred.relationReason
      ) {
        return entry;
      }
      changed = true;
      return {
        ...entry,
        lane: inferred.lane,
        relationScore: inferred.relationScore,
        relationReason: inferred.relationReason,
      };
    });
    return changed ? next : entriesSnapshot;
  }

  pickReferenceMainEntry(
    excludeTaskId?: string,
    entriesSnapshot: DockEntry[] = [],
  ): DockEntry | null {
    const activeEntries = entriesSnapshot.filter(entry => entry.status !== 'completed');
    const focusing = activeEntries.find(
      entry => entry.status === 'focusing' && (!excludeTaskId || entry.taskId !== excludeTaskId),
    );
    if (focusing) return focusing;

    const manualMain = activeEntries
      .filter(
        entry =>
          entry.isMain &&
          entry.manualMainSelected &&
          (!excludeTaskId || entry.taskId !== excludeTaskId),
      )
      .sort((a, b) => b.dockedOrder - a.dockedOrder)[0];
    if (manualMain) return manualMain;

    const fallbackMain = activeEntries
      .filter(entry => entry.isMain && (!excludeTaskId || entry.taskId !== excludeTaskId))
      .sort((a, b) => entryOrder(a) - entryOrder(b))[0];
    return fallbackMain ?? null;
  }

  hasDirectConnection(projectId: string, taskAId: string, taskBId: string): boolean {
    if (!projectId) return false;
    const project = this.projectState.getProject(projectId);
    const connections = Array.isArray(project?.connections) ? project.connections : [];
    return connections.some(connection =>
      (connection.source === taskAId && connection.target === taskBId) ||
      (connection.source === taskBId && connection.target === taskAId),
    );
  }

  computeTreeDistance(projectId: string, taskAId: string, taskBId: string): number | null {
    if (!projectId || taskAId === taskBId) return taskAId === taskBId ? 0 : null;

    const tasks = this.taskStore.getTasksByProject(projectId);
    if (!tasks || tasks.length === 0) return null;

    // 复用缓存的邻接表（同 projectId 且任务数未变则视为有效）
    const adjacency = this.getOrBuildAdjacency(projectId, tasks);

    if (!adjacency.has(taskAId) || !adjacency.has(taskBId)) return null;

    // 迭代 BFS，上限 100 层（避免性能问题）
    const MAX_SEARCH_DEPTH = FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH;
    const visited = new Set<string>([taskAId]);
    let frontier = [taskAId];
    let depth = 0;

    while (frontier.length > 0 && depth < MAX_SEARCH_DEPTH) {
      depth++;
      const nextFrontier: string[] = [];
      for (const nodeId of frontier) {
        const neighbors = adjacency.get(nodeId);
        if (!neighbors) continue;
        for (const neighbor of neighbors) {
          if (neighbor === taskBId) return depth;
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            nextFrontier.push(neighbor);
          }
        }
      }
      frontier = nextFrontier;
    }

    return null;
  }

  getOrBuildAdjacency(projectId: string, tasks: Task[]): Map<string, string[]> {
    const fingerprint = this.buildAdjacencyFingerprint(tasks);
    const now = Date.now();
    if (
      this.adjacencyCache &&
      this.adjacencyCache.projectId === projectId &&
      this.adjacencyCache.fingerprint === fingerprint &&
      now - this.adjacencyCache.createdAt < DockZoneService.ADJACENCY_CACHE_TTL_MS
    ) {
      return this.adjacencyCache.adjacency;
    }

    const adjacency = new Map<string, string[]>();
    for (const t of tasks) {
      if (!adjacency.has(t.id)) adjacency.set(t.id, []);
      if (t.parentId) {
        if (!adjacency.has(t.parentId)) adjacency.set(t.parentId, []);
        adjacency.get(t.id)!.push(t.parentId);
        adjacency.get(t.parentId)!.push(t.id);
      }
    }

    this.adjacencyCache = { projectId, fingerprint, adjacency, createdAt: now };
    return adjacency;
  }

  /** O(n) order-independent fingerprint using additive + XOR hash combination */
  buildAdjacencyFingerprint(tasks: Task[]): string {
    let xor = 0;
    let sum = 0;
    // XOR 和 SUM 运算天然顺序无关，无需排序
    for (const t of tasks) {
      let h = 0x811c9dc5; // FNV-1a offset basis
      const key = `${t.id}:${t.parentId ?? ''}`;
      for (let i = 0; i < key.length; i++) {
        h ^= key.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
      h >>>= 0;
      xor ^= h;
      sum = (sum + h) >>> 0;
    }
    return `${tasks.length}:${xor}:${sum}`;
  }

  resolveSourceProjectId(entry: DockEntry): string | null {
    return entry.sourceProjectId ?? this.taskStore.getTaskProjectId(entry.taskId);
  }

}
