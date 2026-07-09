const FLOW_SIDECAR_EXPANSION_STORAGE_PREFIX = 'nanoflow.flow-sidecar-expanded.v1';

export interface FlowDiagramSidecarExpansionNode {
  key: string;
  sidecarHasSignals?: boolean;
}

export interface FlowDiagramSidecarExpansionControllerOptions {
  getStorage?: () => Storage | null;
}

export class FlowDiagramSidecarExpansionController {
  private loadedProjectId: string | null = null;
  private expandedTaskIds = new Set<string>();

  constructor(private readonly options: FlowDiagramSidecarExpansionControllerOptions = {}) {}

  get taskIds(): ReadonlySet<string> {
    return this.expandedTaskIds;
  }

  ensureLoaded(projectId: string): void {
    if (this.loadedProjectId === projectId) return;

    this.loadedProjectId = projectId;
    this.expandedTaskIds = this.read(projectId);
  }

  toggle(projectId: string, taskId: string): boolean {
    this.ensureLoaded(projectId);
    const nextExpanded = !this.expandedTaskIds.has(taskId);
    if (nextExpanded) {
      this.expandedTaskIds.add(taskId);
    } else {
      this.expandedTaskIds.delete(taskId);
    }
    this.persist(projectId);
    return nextExpanded;
  }

  prune(nodes: readonly FlowDiagramSidecarExpansionNode[]): boolean {
    if (!this.loadedProjectId || this.expandedTaskIds.size === 0) return false;

    const expandableTaskIds = new Set(nodes
      .filter(node => node.sidecarHasSignals)
      .map(node => node.key));
    let changed = false;
    for (const taskId of Array.from(this.expandedTaskIds)) {
      if (!expandableTaskIds.has(taskId)) {
        this.expandedTaskIds.delete(taskId);
        changed = true;
      }
    }
    if (changed) {
      this.persist(this.loadedProjectId);
    }
    return changed;
  }

  reset(): void {
    this.loadedProjectId = null;
    this.expandedTaskIds.clear();
  }

  private read(projectId: string): Set<string> {
    const storage = this.getStorage();
    if (!storage) return new Set<string>();

    try {
      const raw = storage.getItem(this.getStorageKey(projectId));
      if (!raw) return new Set<string>();
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return new Set<string>();
      return new Set(parsed.filter((value): value is string => typeof value === 'string' && value.length > 0));
    } catch {
      return new Set<string>();
    }
  }

  private persist(projectId: string): void {
    const storage = this.getStorage();
    if (!storage) return;

    try {
      const key = this.getStorageKey(projectId);
      const taskIds = Array.from(this.expandedTaskIds).sort();
      if (taskIds.length === 0) {
        storage.removeItem(key);
        return;
      }
      storage.setItem(key, JSON.stringify(taskIds));
    } catch {
      // Local UI preferences must not block the diagram.
    }
  }

  private getStorageKey(projectId: string): string {
    return `${FLOW_SIDECAR_EXPANSION_STORAGE_PREFIX}.${projectId}`;
  }

  private getStorage(): Storage | null {
    if (this.options.getStorage) {
      return this.options.getStorage();
    }
    if (typeof window === 'undefined') return null;
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      // localStorage may be unavailable in privacy mode or SSR-like environments.
    }
    return storage;
  }
}
