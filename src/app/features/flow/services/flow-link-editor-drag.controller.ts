import type { WritableSignal } from '@angular/core';

import {
  type ConnectionEditorDiagramBounds,
  getConnectionEditorCoordinateRootBounds,
  resolveConnectionEditorDragPosition,
} from './flow-link-editor-position.helpers';
import {
  type DragState,
  type PanelPosition,
  createInitialDragState,
} from '../../../../models/flow-view-state';

interface FlowLinkEditorDragControllerOptions {
  connectionEditorPos: WritableSignal<PanelPosition>;
  zone: {
    run<T>(callback: () => T): T;
  };
}

export class FlowLinkEditorDragController {
  private dragState: DragState = createInitialDragState();
  private diagramBounds: ConnectionEditorDiagramBounds | null = null;

  constructor(private readonly options: FlowLinkEditorDragControllerOptions) {}

  get currentDiagramBounds(): ConnectionEditorDiagramBounds | null {
    return this.diagramBounds;
  }

  start(event: MouseEvent | TouchEvent): void {
    event.preventDefault();
    this.removeDocumentListeners();

    const pos = this.options.connectionEditorPos();
    const { clientX, clientY } = getPointerClientPosition(event);

    this.dragState = {
      isDragging: true,
      startX: clientX,
      startY: clientY,
      offsetX: pos.x,
      offsetY: pos.y,
    };

    this.updateDiagramBounds();
    this.addDocumentListeners();
  }

  updateDiagramBounds(): void {
    const diagramDiv = document.querySelector('[data-testid="flow-diagram"]');
    if (!diagramDiv) {
      this.diagramBounds = null;
      return;
    }

    const coordinateRoot = getConnectionEditorCoordinateRootBounds();
    const rect = diagramDiv.getBoundingClientRect();
    this.diagramBounds = {
      left: rect.left - coordinateRoot.left,
      top: rect.top - coordinateRoot.top,
      right: rect.right - coordinateRoot.left,
      bottom: rect.bottom - coordinateRoot.top,
    };
  }

  dispose(): void {
    this.removeDocumentListeners();
    this.dragState = createInitialDragState();
    this.diagramBounds = null;
  }

  private readonly handleDrag = (event: MouseEvent | TouchEvent): void => {
    if (!this.dragState.isDragging) return;

    const { clientX, clientY } = getPointerClientPosition(event);
    const nextPosition = resolveConnectionEditorDragPosition({
      dragStartX: this.dragState.startX,
      dragStartY: this.dragState.startY,
      dragOffsetX: this.dragState.offsetX,
      dragOffsetY: this.dragState.offsetY,
      pointerX: clientX,
      pointerY: clientY,
      diagramBounds: this.diagramBounds,
    });

    this.options.zone.run(() => {
      this.options.connectionEditorPos.set(nextPosition);
    });
  };

  private readonly stopDrag = (): void => {
    this.dragState.isDragging = false;
    this.removeDocumentListeners();
  };

  private addDocumentListeners(): void {
    document.addEventListener('mousemove', this.handleDrag);
    document.addEventListener('mouseup', this.stopDrag);
    document.addEventListener('touchmove', this.handleDrag);
    document.addEventListener('touchend', this.stopDrag);
  }

  private removeDocumentListeners(): void {
    this.removeDocumentListener('mousemove', this.handleDrag);
    this.removeDocumentListener('mouseup', this.stopDrag);
    this.removeDocumentListener('touchmove', this.handleDrag);
    this.removeDocumentListener('touchend', this.stopDrag);
  }

  private removeDocumentListener<K extends keyof DocumentEventMap>(
    eventName: K,
    listener: (event: DocumentEventMap[K]) => void,
  ): void {
    try {
      document.removeEventListener(eventName, listener);
    } catch {
      // Listener cleanup must be best-effort so dispose can always reset drag state.
    }
  }
}

function getPointerClientPosition(event: MouseEvent | TouchEvent): { clientX: number; clientY: number } {
  if (event instanceof MouseEvent) {
    return {
      clientX: event.clientX,
      clientY: event.clientY,
    };
  }

  return {
    clientX: event.touches[0].clientX,
    clientY: event.touches[0].clientY,
  };
}
