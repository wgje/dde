import * as go from 'gojs';

import type { Project } from '../../../../models';
import type { ActiveProjectOwner } from '../../../../services/project-state.service';
import type { FlowViewportOwner, ViewState } from './flow-zoom.service';

export interface FlowDiagramReadinessToken {
  readonly owner: ActiveProjectOwner;
  readonly projectId: string;
  readonly diagram: go.Diagram;
  readonly diagramGeneration: number;
  readonly settlementGeneration: number;
}

export interface FlowDiagramViewportBoundsEvidence {
  readonly documentWidth: number;
  readonly documentHeight: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly scale: number;
  readonly positionX: number;
  readonly positionY: number;
}

export interface FlowDiagramViewportApplicationProof {
  readonly kind: 'VIEW_STATE_APPLIED' | 'FIT_TO_CONTENTS_APPLIED';
  readonly token: FlowDiagramReadinessToken;
  readonly before: FlowDiagramViewportBoundsEvidence;
  readonly after: FlowDiagramViewportBoundsEvidence;
}

interface PendingSettlement {
  readonly token: FlowDiagramReadinessToken;
  readonly viewState: ViewState | null;
  dataCommitted: boolean;
  layoutCompleted: boolean;
  hardRecoveryRequest: {
    readonly viewState: ViewState | null;
    readonly complete: (proof: FlowDiagramViewportApplicationProof | null) => void;
    applying: boolean;
  } | null;
}

interface FlowDiagramViewportReadinessOptions {
  activeView: () => string | null;
  captureActiveProjectOwner: () => ActiveProjectOwner;
  isActiveProjectOwnerCurrent: (owner: ActiveProjectOwner) => boolean;
  fitToContents: (owner: FlowViewportOwner) => void;
  markViewDestroyed: () => void;
  markViewReady: (owner: ActiveProjectOwner) => void;
  markLocalChanges: (type: 'content' | 'structure' | 'position') => void;
  schedulePersist: () => void;
  updateViewState: (projectId: string, viewState: ViewState) => void;
}

export class FlowDiagramViewportReadinessController {
  private diagram: go.Diagram | null = null;
  private diagramGeneration = 0;
  private settlementGeneration = 0;
  private currentProjectId: string | null = null;
  private successfulProjectId: string | null = null;
  private successfulOwner: ActiveProjectOwner | null = null;
  private viewportOwnerProjectId: string | null = null;
  private pending: PendingSettlement | null = null;
  private hardRecoveryActive = false;
  private layoutCompletedDiagram: go.Diagram | null = null;
  private layoutCompletedListener: ((event: go.DiagramEvent) => void) | null = null;
  private viewStateSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private restoreViewStateTimer: ReturnType<typeof setTimeout> | null = null;
  private autoFitTimer: ReturnType<typeof setTimeout> | null = null;
  private viewportProofRafId: number | null = null;
  private viewportProofCancellation: (() => void) | null = null;
  private viewportProofGeneration = 0;
  private flowActivationFitRafIds: number[] = [];
  private pendingAutoFitToContents = false;

  constructor(private readonly options: FlowDiagramViewportReadinessOptions) {}

  get lastSuccessfulProjectId(): string | null {
    return this.successfulOwner && this.options.isActiveProjectOwnerCurrent(this.successfulOwner)
      ? this.successfulProjectId
      : null;
  }

  setDiagram(diagram: go.Diagram | null): void {
    if (this.diagram === diagram) return;
    this.clearTimers();
    this.diagram = diagram;
    this.diagramGeneration += 1;
    this.pending = null;
    this.successfulProjectId = null;
    this.successfulOwner = null;
    this.viewportOwnerProjectId = null;
    this.options.markViewDestroyed();
  }

  beginProjectUpdate(
    project: Pick<Project, 'id'>,
    viewState: ViewState | null,
  ): FlowDiagramReadinessToken | null {
    const owner = this.options.captureActiveProjectOwner();
    if (!this.diagram || owner.projectId !== project.id || !this.options.isActiveProjectOwnerCurrent(owner)) {
      return null;
    }
    if (this.currentProjectId !== project.id) {
      this.currentProjectId = project.id;
      this.pendingAutoFitToContents = false;
      this.cancelPendingViewStateSave();
    }
    this.cancelPendingWork();
    const token: FlowDiagramReadinessToken = Object.freeze({
      owner: Object.freeze({ ...owner }),
      projectId: project.id,
      diagram: this.diagram,
      diagramGeneration: this.diagramGeneration,
      settlementGeneration: ++this.settlementGeneration,
    });
    this.pending = {
      token,
      viewState: viewState ? { ...viewState } : null,
      dataCommitted: false,
      layoutCompleted: false,
      hardRecoveryRequest: null,
    };
    this.armLayoutCompletedListener(this.pending);
    this.options.markViewDestroyed();
    return token;
  }

  commitProjectUpdate(token?: FlowDiagramReadinessToken): boolean {
    const pending = this.pending;
    if (!pending) return token === undefined;
    if ((token && pending.token !== token) || !this.isTokenCurrent(pending.token)) return false;
    pending.dataCommitted = true;
    this.settlePending(pending);
    return true;
  }

  abortProjectUpdate(token: FlowDiagramReadinessToken): boolean {
    const pending = this.pending;
    if (!pending || pending.token !== token) return false;
    this.cancelPendingWork();
    this.pending = null;
    return true;
  }

  beginHardRecovery(): boolean {
    const owner = this.options.captureActiveProjectOwner();
    if (owner.projectId === null || !this.options.isActiveProjectOwnerCurrent(owner)) return false;
    this.hardRecoveryActive = true;
    this.cancelPendingWork();
    this.pending = null;
    this.options.markViewDestroyed();
    return true;
  }

  applyHardRecoveryViewport(
    viewState: ViewState | null,
    complete: (proof: FlowDiagramViewportApplicationProof | null) => void,
  ): boolean {
    const pending = this.pending;
    if (!this.hardRecoveryActive || !pending || !this.isPendingCurrent(pending)
      || pending.hardRecoveryRequest) return false;
    pending.hardRecoveryRequest = {
      viewState: viewState ? { ...viewState } : null,
      complete,
      applying: false,
    };
    this.settlePending(pending);
    return true;
  }

  completeHardRecovery(proof: FlowDiagramViewportApplicationProof | null): boolean {
    if (!proof || !this.hardRecoveryActive) return false;
    return this.completeSettlement(proof.token, proof);
  }

  abortHardRecovery(): void {
    this.hardRecoveryActive = false;
    this.cancelPendingWork();
    this.pending = null;
    this.options.markViewDestroyed();
  }

  saveViewState(project: Pick<Project, 'id'>): void {
    const token = this.captureSettledToken(project.id);
    if (!token) return;
    const viewState: ViewState = {
      scale: token.diagram.scale,
      positionX: token.diagram.position.x,
      positionY: token.diagram.position.y,
    };
    if (this.viewStateSaveTimer !== null) clearTimeout(this.viewStateSaveTimer);
    const timer = setTimeout(() => {
      if (this.viewStateSaveTimer !== timer) return;
      try {
        if (!this.isTokenCurrent(token) || this.viewportOwnerProjectId !== token.projectId) return;
        this.options.updateViewState(token.projectId, viewState);
        this.options.markLocalChanges('position');
        this.options.schedulePersist();
      } finally {
        if (this.viewStateSaveTimer === timer) this.viewStateSaveTimer = null;
      }
    }, 1000);
    this.viewStateSaveTimer = timer;
  }

  cancelPendingViewStateSave(): void {
    if (this.viewStateSaveTimer === null) return;
    clearTimeout(this.viewStateSaveTimer);
    this.viewStateSaveTimer = null;
  }

  restoreViewState(project: Pick<Project, 'id'>, viewState: ViewState | null): void {
    const token = this.captureSettledToken(project.id);
    if (!token) return;
    if (this.successfulProjectId === project.id) {
      if (this.layoutCompletedListener || !viewState) return;
      this.applyViewState(token.diagram, viewState);
      this.viewportOwnerProjectId = project.id;
      return;
    }
    if (this.currentProjectId !== null) return;
    if (viewState) {
      this.applyViewState(token.diagram, viewState);
      return;
    }
    if (this.restoreViewStateTimer !== null) clearTimeout(this.restoreViewStateTimer);
    const timer = setTimeout(() => {
      if (this.restoreViewStateTimer !== timer) return;
      try {
        if (!this.isTokenCurrent(token)) return;
        if (this.options.activeView() !== 'flow') {
          this.pendingAutoFitToContents = true;
          return;
        }
        this.scheduleAutoFitToContents(token);
      } finally {
        if (this.restoreViewStateTimer === timer) this.restoreViewStateTimer = null;
      }
    }, 200);
    this.restoreViewStateTimer = timer;
  }

  onFlowActivated(project: Pick<Project, 'id'>, viewState: ViewState | null): void {
    const pending = this.pending;
    if (!pending || pending.token.projectId !== project.id
      || this.options.activeView() !== 'flow' || !this.pendingAutoFitToContents) return;
    this.pendingAutoFitToContents = false;
    const firstRafId = requestAnimationFrame(() => {
      if (!this.takeRaf(firstRafId) || !this.isPendingCurrent(pending)) return;
      const secondRafId = requestAnimationFrame(() => {
        if (!this.takeRaf(secondRafId) || !this.isPendingCurrent(pending)) return;
        this.applyViewport(pending, viewState, proof => {
          if (proof) this.completeSettlement(pending.token, proof);
        });
      });
      this.flowActivationFitRafIds.push(secondRafId);
    });
    this.flowActivationFitRafIds.push(firstRafId);
  }

  clearTimers(): void {
    this.cancelPendingWork();
    this.cancelPendingViewStateSave();
    for (const key of ['restoreViewStateTimer', 'autoFitTimer'] as const) {
      const timer = this[key];
      if (timer !== null) clearTimeout(timer);
      this[key] = null;
    }
    for (const rafId of this.flowActivationFitRafIds) cancelAnimationFrame(rafId);
    this.flowActivationFitRafIds = [];
  }

  dispose(): void {
    this.clearTimers();
    this.diagram = null;
    this.diagramGeneration += 1;
    this.settlementGeneration += 1;
    this.currentProjectId = null;
    this.successfulProjectId = null;
    this.successfulOwner = null;
    this.viewportOwnerProjectId = null;
    this.pending = null;
    this.hardRecoveryActive = false;
    this.pendingAutoFitToContents = false;
    this.options.markViewDestroyed();
  }

  private handleLayoutCompleted(
    pending: PendingSettlement,
    listener: (event: go.DiagramEvent) => void,
  ): void {
    if (this.layoutCompletedListener !== listener || !this.isPendingCurrent(pending)) return;
    if (!this.readUsableBounds(pending.token.diagram)) return;
    pending.layoutCompleted = true;
    this.cancelLayoutCompletedListener();
    this.settlePending(pending);
  }

  private settlePending(pending: PendingSettlement): void {
    if (!pending.dataCommitted || !pending.layoutCompleted || !this.isPendingCurrent(pending)) return;
    if (this.hardRecoveryActive) {
      const request = pending.hardRecoveryRequest;
      if (!request || request.applying) return;
      request.applying = true;
      const accepted = this.applyViewport(pending, request.viewState, proof => {
        if (pending.hardRecoveryRequest !== request) return;
        pending.hardRecoveryRequest = null;
        request.complete(proof);
      });
      if (!accepted) {
        request.applying = false;
        if (this.isPendingCurrent(pending)) {
          pending.layoutCompleted = false;
          this.armLayoutCompletedListener(pending);
        }
      }
      return;
    }
    if (!pending.viewState && this.options.activeView() !== 'flow') {
      this.pendingAutoFitToContents = true;
      return;
    }
    this.applyViewport(pending, pending.viewState, proof => {
      if (proof) this.completeSettlement(pending.token, proof);
    });
  }

  private armLayoutCompletedListener(pending: PendingSettlement): void {
    this.cancelLayoutCompletedListener();
    const listener = () => this.handleLayoutCompleted(pending, listener);
    this.layoutCompletedDiagram = pending.token.diagram;
    this.layoutCompletedListener = listener;
    pending.token.diagram.addDiagramListener('LayoutCompleted', listener);
  }

  private applyViewport(
    pending: PendingSettlement,
    viewState: ViewState | null,
    complete: (proof: FlowDiagramViewportApplicationProof | null) => void,
  ): boolean {
    const token = pending.token;
    if (!this.isPendingCurrent(pending)) return false;
    const before = this.readUsableBounds(token.diagram);
    if (!before) return false;
    const kind = viewState ? 'VIEW_STATE_APPLIED' : 'FIT_TO_CONTENTS_APPLIED';
    if (viewState) this.applyViewState(token.diagram, viewState);
    else this.options.fitToContents(this.toZoomOwner(token));
    if (!this.isPendingCurrent(pending)) return false;
    this.scheduleViewportProof(() => {
      const after = this.isPendingCurrent(pending) ? this.readUsableBounds(token.diagram) : null;
      if (!after || !this.matchesViewportApplication(token.diagram, kind, viewState, before, after)) {
        complete(null);
        return;
      }
      complete(Object.freeze({ kind, token, before, after }));
    }, () => complete(null));
    return true;
  }

  private completeSettlement(
    token: FlowDiagramReadinessToken,
    proof: FlowDiagramViewportApplicationProof,
  ): boolean {
    const pending = this.pending;
    if (!pending?.dataCommitted || !pending.layoutCompleted || proof.token !== token) return false;
    if (!this.isPendingCurrent(pending)) return false;
    this.pending = null;
    this.hardRecoveryActive = false;
    this.successfulProjectId = token.projectId;
    this.successfulOwner = token.owner;
    this.viewportOwnerProjectId = token.projectId;
    this.options.markViewReady(token.owner);
    return true;
  }

  private captureSettledToken(projectId: string): FlowDiagramReadinessToken | null {
    if (!this.diagram || this.successfulProjectId !== projectId) return null;
    const owner = this.successfulOwner;
    if (!owner || owner.projectId !== projectId || !this.options.isActiveProjectOwnerCurrent(owner)) return null;
    return Object.freeze({
      owner: Object.freeze({ ...owner }),
      projectId,
      diagram: this.diagram,
      diagramGeneration: this.diagramGeneration,
      settlementGeneration: this.settlementGeneration,
    });
  }

  private isPendingCurrent(pending: PendingSettlement): boolean {
    return this.pending === pending && this.isTokenCurrent(pending.token);
  }

  private isTokenCurrent(token: FlowDiagramReadinessToken): boolean {
    return this.diagram === token.diagram
      && this.diagramGeneration === token.diagramGeneration
      && this.settlementGeneration === token.settlementGeneration
      && this.currentProjectId === token.projectId
      && this.options.isActiveProjectOwnerCurrent(token.owner);
  }

  private readUsableBounds(diagram: go.Diagram): FlowDiagramViewportBoundsEvidence | null {
    const documentBounds = diagram.documentBounds;
    const viewportBounds = diagram.viewportBounds;
    const position = diagram.position;
    if (!documentBounds.isReal() || documentBounds.width <= 0 || documentBounds.height <= 0
      || !viewportBounds.isReal() || viewportBounds.width <= 0 || viewportBounds.height <= 0
      || !Number.isFinite(diagram.scale) || diagram.scale <= 0
      || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return null;
    return Object.freeze({
      documentWidth: documentBounds.width,
      documentHeight: documentBounds.height,
      viewportWidth: viewportBounds.width,
      viewportHeight: viewportBounds.height,
      scale: diagram.scale,
      positionX: position.x,
      positionY: position.y,
    });
  }

  private captureViewState(diagram: go.Diagram): ViewState {
    return { scale: diagram.scale, positionX: diagram.position.x, positionY: diagram.position.y };
  }

  private matchesViewportApplication(
    diagram: go.Diagram,
    kind: FlowDiagramViewportApplicationProof['kind'],
    requested: ViewState | null,
    before: FlowDiagramViewportBoundsEvidence,
    after: FlowDiagramViewportBoundsEvidence,
  ): boolean {
    const tolerance = 0.000001;
    if (kind === 'VIEW_STATE_APPLIED') {
      return requested !== null
        && Math.abs(after.scale - requested.scale) < tolerance
        && Math.abs(after.positionX - requested.positionX) < tolerance
        && Math.abs(after.positionY - requested.positionY) < tolerance;
    }

    const expectedScale = Math.max(0.3, Math.min(1.5, Math.min(
      before.viewportWidth / (before.documentWidth + 100),
      before.viewportHeight / (before.documentHeight + 100),
    )));
    const documentCenter = diagram.documentBounds.center;
    const viewportCenter = diagram.viewportBounds.center;
    return Math.abs(after.scale - expectedScale) < tolerance
      && Math.abs(documentCenter.x - viewportCenter.x) < tolerance
      && Math.abs(documentCenter.y - viewportCenter.y) < tolerance;
  }

  private applyViewState(diagram: go.Diagram, viewState: ViewState): void {
    this.pendingAutoFitToContents = false;
    diagram.scale = viewState.scale;
    diagram.position = new go.Point(viewState.positionX, viewState.positionY);
  }

  private toZoomOwner(token: FlowDiagramReadinessToken): FlowViewportOwner {
    return { projectId: token.projectId, diagram: token.diagram, isCurrent: () => this.isTokenCurrent(token) };
  }

  private scheduleAutoFitToContents(token: FlowDiagramReadinessToken): void {
    if (this.autoFitTimer !== null) clearTimeout(this.autoFitTimer);
    const timer = setTimeout(() => {
      if (this.autoFitTimer !== timer) return;
      try {
        if (!this.isTokenCurrent(token) || !this.readUsableBounds(token.diagram)) return;
        this.options.fitToContents(this.toZoomOwner(token));
        this.viewportOwnerProjectId = token.projectId;
      } finally {
        if (this.autoFitTimer === timer) this.autoFitTimer = null;
      }
    }, 300);
    this.autoFitTimer = timer;
  }

  private takeRaf(rafId: number): boolean {
    if (!this.flowActivationFitRafIds.includes(rafId)) return false;
    this.flowActivationFitRafIds = this.flowActivationFitRafIds.filter(id => id !== rafId);
    return true;
  }

  private scheduleViewportProof(callback: () => void, cancel: () => void): void {
    this.cancelViewportProof();
    const generation = ++this.viewportProofGeneration;
    let settled = false;
    const settle = (completion: () => void): void => {
      if (settled) return;
      settled = true;
      this.viewportProofCancellation = null;
      completion();
    };
    this.viewportProofCancellation = () => settle(cancel);
    let completedSynchronously = false;
    const rafId = requestAnimationFrame(() => {
      completedSynchronously = true;
      if (this.viewportProofGeneration !== generation) return;
      this.viewportProofRafId = null;
      settle(callback);
    });
    if (!completedSynchronously) this.viewportProofRafId = rafId;
  }

  private cancelViewportProof(): void {
    this.viewportProofGeneration += 1;
    if (this.viewportProofRafId !== null) cancelAnimationFrame(this.viewportProofRafId);
    this.viewportProofRafId = null;
    const cancel = this.viewportProofCancellation;
    this.viewportProofCancellation = null;
    cancel?.();
  }

  private cancelPendingWork(): void {
    const pending = this.pending;
    this.cancelLayoutCompletedListener();
    this.cancelViewportProof();
    const request = pending?.hardRecoveryRequest;
    if (!request) return;
    pending.hardRecoveryRequest = null;
    request.complete(null);
  }

  private cancelLayoutCompletedListener(): void {
    if (this.layoutCompletedDiagram && this.layoutCompletedListener) {
      this.layoutCompletedDiagram.removeDiagramListener('LayoutCompleted', this.layoutCompletedListener);
    }
    this.layoutCompletedDiagram = null;
    this.layoutCompletedListener = null;
  }
}
