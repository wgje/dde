import type { WritableSignal } from '@angular/core';

import type { Task } from '../../../../models';
import type {
  ConnectionEditorData,
  ConnectionEditorMode,
  PanelPosition,
} from '../../../../models/flow-view-state';
import {
  type ConnectionEditorDiagramBounds,
  type ConnectionEditorCoordinateRootBounds,
  getConnectionEditorCoordinateRootBounds,
  resolveConnectionEditorPosition,
} from './flow-link-editor-position.helpers';
import {
  createConnectionEditorData,
  type ExistingConnectionEditorAction,
  isSameConnectionEditor,
  resolveExistingConnectionEditorAction,
  scheduleConnectionEditorTextareaResize,
} from './flow-link-editor-state.helpers';

interface OpenConnectionEditorOptions {
  isCrossTree: boolean;
  mode: ConnectionEditorMode;
}

interface FlowLinkConnectionEditorDragPort {
  readonly currentDiagramBounds: ConnectionEditorDiagramBounds | null;
  start(event: MouseEvent | TouchEvent): void;
  updateDiagramBounds(): void;
  dispose(): void;
}

interface FlowLinkConnectionEditorLogger {
  debug(message: string, context?: unknown): void;
  info(message: string, context?: unknown): void;
  warn(message: string, context?: unknown): void;
}

interface FlowLinkEditorOperationOwner {
  projectId: string | null;
  generation: number;
}

interface FlowLinkConnectionEditorControllerOptions {
  connectionEditorData: WritableSignal<ConnectionEditorData | null>;
  connectionEditorPos: WritableSignal<PanelPosition>;
  drag: FlowLinkConnectionEditorDragPort;
  isMobile: () => boolean;
  guardMutation: (actionLabel: string) => boolean;
  getTask: (taskId: string) => Task | null | undefined;
  updateConnectionContent: (
    sourceId: string,
    targetId: string,
    title: string,
    description: string
  ) => void | boolean | Promise<boolean>;
  removeConnection: (sourceId: string, targetId: string) => void | boolean | Promise<boolean>;
  detachTask: (taskId: string) => void | boolean | Promise<boolean>;
  logger: FlowLinkConnectionEditorLogger;
  isDestroyed?: () => boolean;
  captureOperationOwner?: () => FlowLinkEditorOperationOwner;
  isOperationOwnerCurrent?: (owner: FlowLinkEditorOperationOwner) => boolean;
}

interface FlowLinkEditorPublicationTicket {
  readonly operation: 'save' | 'delete';
  readonly sessionGeneration: number;
  readonly instanceGeneration: number;
  readonly attemptGeneration: number;
}

export class FlowLinkConnectionEditorController {
  private connectionEditorIgnoreCloseUntil = 0;
  private lifecycleGeneration = 0;
  private editorSessionGeneration = 0;
  private editorInstanceGeneration = 0;
  private saveAttemptGeneration = 0;
  private deleteAttemptGeneration = 0;
  private observedEditorData: ConnectionEditorData | null;
  private readonly saveTails = new Map<string, Promise<void>>();

  constructor(private readonly options: FlowLinkConnectionEditorControllerOptions) {
    this.observedEditorData = options.connectionEditorData();
  }

  open(
    sourceId: string,
    targetId: string,
    description: string,
    x: number,
    y: number,
    title: string = '',
    openOptions: OpenConnectionEditorOptions = {
      isCrossTree: true,
      mode: 'preview',
    }
  ): void {
    this.options.logger.debug('openConnectionEditor 被调用', {
      sourceId,
      targetId,
      title,
      description,
      x,
      y,
      isMobile: this.options.isMobile(),
      options: openOptions,
    });

    const requestedMode = openOptions.mode;
    const editorMode = this.resolveMode(requestedMode);
    const currentEditor = this.observeEditorData();

    if (isSameConnectionEditor(currentEditor, sourceId, targetId, openOptions.isCrossTree)) {
      this.applyExistingAction(resolveExistingConnectionEditorAction({
        currentEditor,
        title,
        description,
        requestedMode,
        editorMode,
        isMobile: this.options.isMobile(),
      }));
      return;
    }

    const position = this.resolveNewPosition(x, y);
    this.openNew(sourceId, targetId, title, description, openOptions.isCrossTree, editorMode, position);
  }

  close(): void {
    this.options.logger.debug('closeConnectionEditor 被调用');
    this.replaceEditorData(null);
  }

  setMode(mode: ConnectionEditorMode): void {
    const data = this.observeEditorData();
    if (!data || data.mode === mode) {
      return;
    }

    if (mode === 'edit' && this.options.guardMutation('编辑关联')) {
      return;
    }

    this.armBackgroundCloseGuard();
    this.setEditorData({
      ...data,
      mode,
    });
  }

  shouldIgnoreBackgroundClose(): boolean {
    return Date.now() < this.connectionEditorIgnoreCloseUntil;
  }

  async saveContent(sourceId: string, targetId: string, title: string, description: string): Promise<boolean> {
    if (this.options.guardMutation('编辑关联')) {
      return false;
    }

    const generation = this.lifecycleGeneration;
    const owner = this.options.captureOperationOwner?.();
    const ticket = this.issuePublicationTicket('save');
    const save = async (): Promise<boolean> => {
      const saved = await this.options.updateConnectionContent(sourceId, targetId, title, description);
      if (saved === false) {
        return false;
      }
      if (generation !== this.lifecycleGeneration
        || (owner && this.options.isOperationOwnerCurrent?.(owner) === false)
        || !this.isPublicationTicketCurrent(ticket)) return true;

      const data = this.observeEditorData();
      if (data && data.sourceId === sourceId && data.targetId === targetId) {
        this.setEditorData({
          ...data,
          title,
          description,
        });
      }

      return true;
    };
    const saveKey = JSON.stringify([generation, owner?.generation, owner?.projectId, sourceId, targetId]);
    const previousTail = this.saveTails.get(saveKey);
    const result = previousTail ? previousTail.then(save, save) : save();
    const tail = result.then(() => undefined, () => undefined);
    this.saveTails.set(saveKey, tail);
    void tail.then(() => {
      if (this.saveTails.get(saveKey) === tail) {
        this.saveTails.delete(saveKey);
      }
    });
    return await result;
  }

  async deleteCurrent(): Promise<boolean> {
    const data = this.observeEditorData();
    if (!data) {
      this.options.logger.warn('deleteCurrentConnection: 没有当前编辑的连接数据');
      return false;
    }

    if (this.options.guardMutation('删除关联')) {
      return false;
    }
    const generation = this.lifecycleGeneration;
    const owner = this.options.captureOperationOwner?.();
    const ticket = this.issuePublicationTicket('delete');

    if (data.isCrossTree) {
      this.options.logger.info('删除跨树连接', { sourceId: data.sourceId, targetId: data.targetId });
      const saved = await this.options.removeConnection(data.sourceId, data.targetId);
      if (saved === false) {
        return false;
      }
    } else {
      this.options.logger.info('解除父子关系', { parentId: data.sourceId, childId: data.targetId });
      const saved = await this.options.detachTask(data.targetId);
      if (saved === false) {
        return false;
      }
    }

    if (generation === this.lifecycleGeneration
      && (!owner || this.options.isOperationOwnerCurrent?.(owner) !== false)
      && this.isPublicationTicketCurrent(ticket)) this.close();
    return true;
  }

  getTasks(): { source: Task | null; target: Task | null } {
    const data = this.observeEditorData();
    if (!data) return { source: null, target: null };

    return {
      source: this.options.getTask(data.sourceId) || null,
      target: this.options.getTask(data.targetId) || null,
    };
  }

  startDrag(event: MouseEvent | TouchEvent): void {
    this.options.drag.start(event);
  }

  updateDiagramBounds(): void {
    this.options.drag.updateDiagramBounds();
  }

  reset(): void {
    this.replaceEditorData(null);
    this.options.connectionEditorPos.set({ x: 0, y: 0 });
    this.connectionEditorIgnoreCloseUntil = 0;
    this.options.drag.dispose();
  }

  dispose(): void {
    this.lifecycleGeneration++;
    this.saveTails.clear();
    this.reset();
  }

  private resolveMode(requestedMode: ConnectionEditorMode): ConnectionEditorMode {
    if (requestedMode !== 'edit') {
      return requestedMode;
    }

    return this.options.guardMutation('编辑关联') ? 'preview' : requestedMode;
  }

  private applyExistingAction(action: ExistingConnectionEditorAction): void {
    if (action.kind === 'none') {
      return;
    }

    if (action.kind === 'preserve-edit') {
      this.options.logger.debug('同一关联块已在编辑态，保持当前会话');
      return;
    }

    if (action.kind === 'promote-mobile-preview') {
      this.promoteMobilePreview(action.data);
      return;
    }

    this.options.logger.debug('同一关联块同步内容/切换模式', {
      from: this.options.connectionEditorData()?.mode,
      to: action.data.mode,
      contentChanged: action.contentChanged,
    });

    if (action.modeChanged) {
      this.armBackgroundCloseGuard();
    }

    this.setEditorData(action.data);
  }

  private promoteMobilePreview(nextData: ConnectionEditorData): void {
    if (this.options.guardMutation('编辑关联')) {
      return;
    }

    this.options.logger.debug('移动端同一跨树关联二次点击，切换到编辑态');
    this.armBackgroundCloseGuard();
    this.setEditorData(nextData);
  }

  private resolveNewPosition(x: number, y: number): PanelPosition {
    const coordinateRoot = getConnectionEditorCoordinateRootBounds();
    const isMobile = this.options.isMobile();

    if (!isMobile) {
      this.updateDiagramBounds();
    }

    const position = resolveConnectionEditorPosition({
      tapX: x,
      tapY: y,
      isMobile,
      coordinateRoot,
      diagramBounds: this.options.drag.currentDiagramBounds,
    });

    if (isMobile) {
      this.logMobilePosition(position, x, y, coordinateRoot);
    }

    return position;
  }

  private openNew(
    sourceId: string,
    targetId: string,
    title: string,
    description: string,
    isCrossTree: boolean,
    mode: ConnectionEditorMode,
    position: PanelPosition
  ): void {
    const editorData = createConnectionEditorData({
      sourceId,
      targetId,
      title,
      description,
      isCrossTree,
      mode,
      position,
    });
    this.options.logger.debug('设置 connectionEditorData', editorData);
    this.armBackgroundCloseGuard();
    this.replaceEditorData(editorData);
    this.options.connectionEditorPos.set(position);
    const generation = this.lifecycleGeneration;
    scheduleConnectionEditorTextareaResize(() =>
      !!this.options.isDestroyed?.() || generation !== this.lifecycleGeneration
    );
  }

  private logMobilePosition(
    position: PanelPosition,
    tapX: number,
    tapY: number,
    coordinateRoot: ConnectionEditorCoordinateRootBounds
  ): void {
    this.options.logger.debug('移动端：锚定定位', {
      adjustedX: position.x,
      adjustedY: position.y,
      tapX,
      tapY,
      rootLeft: coordinateRoot.left,
      rootTop: coordinateRoot.top,
      rootWidth: coordinateRoot.width,
      rootHeight: coordinateRoot.height,
    });
  }

  private armBackgroundCloseGuard(durationMs: number = 300): void {
    this.connectionEditorIgnoreCloseUntil = Date.now() + durationMs;
  }

  private issuePublicationTicket(
    operation: FlowLinkEditorPublicationTicket['operation']
  ): FlowLinkEditorPublicationTicket {
    this.observeEditorData();
    const attemptGeneration = operation === 'save'
      ? ++this.saveAttemptGeneration
      : ++this.deleteAttemptGeneration;
    return {
      operation,
      sessionGeneration: this.editorSessionGeneration,
      instanceGeneration: this.editorInstanceGeneration,
      attemptGeneration,
    };
  }

  private isPublicationTicketCurrent(ticket: FlowLinkEditorPublicationTicket): boolean {
    this.observeEditorData();
    const attemptGeneration = ticket.operation === 'save'
      ? this.saveAttemptGeneration
      : this.deleteAttemptGeneration;
    return ticket.sessionGeneration === this.editorSessionGeneration
      && ticket.instanceGeneration === this.editorInstanceGeneration
      && ticket.attemptGeneration === attemptGeneration;
  }

  private observeEditorData(): ConnectionEditorData | null {
    const data = this.options.connectionEditorData();
    if (data !== this.observedEditorData) {
      this.editorSessionGeneration++;
      this.editorInstanceGeneration++;
      this.observedEditorData = data;
    }
    return data;
  }

  private replaceEditorData(data: ConnectionEditorData | null): void {
    this.editorSessionGeneration++;
    this.editorInstanceGeneration++;
    this.setEditorData(data);
  }

  private setEditorData(data: ConnectionEditorData | null): void {
    this.observedEditorData = data;
    this.options.connectionEditorData.set(data);
  }
}
