import { Injectable, inject, NgZone } from '@angular/core';
import * as go from 'gojs';
import { LoggerService } from '../../../../services/logger.service';

@Injectable({ providedIn: 'root' })
export class FlowDiagramFontRedrawService {
  private readonly logger = inject(LoggerService).category('FlowDiagramFontRedraw');
  private readonly zone = inject(NgZone);

  private fontLoadingDoneHandler: (() => void) | null = null;
  private fontRedrawDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  schedulePostFontLoadRedraw(getDiagram: () => go.Diagram | null, shouldSkip: () => boolean): void {
    if (typeof document === 'undefined' || !document.fonts) return;

    void document.fonts.ready.then(() => {
      this.redrawForFontChange(getDiagram, shouldSkip);
    });

    this.fontLoadingDoneHandler = () => {
      if (this.fontRedrawDebounceTimer !== null) {
        clearTimeout(this.fontRedrawDebounceTimer);
      }
      this.fontRedrawDebounceTimer = setTimeout(() => {
        this.redrawForFontChange(getDiagram, shouldSkip);
        this.fontRedrawDebounceTimer = null;
      }, 500);
    };
    document.fonts.addEventListener('loadingdone', this.fontLoadingDoneHandler);
  }

  cleanupFontLoadListener(): void {
    if (this.fontLoadingDoneHandler && typeof document !== 'undefined' && document.fonts) {
      document.fonts.removeEventListener('loadingdone', this.fontLoadingDoneHandler);
      this.fontLoadingDoneHandler = null;
    }
    if (this.fontRedrawDebounceTimer !== null) {
      clearTimeout(this.fontRedrawDebounceTimer);
      this.fontRedrawDebounceTimer = null;
    }
  }

  private redrawForFontChange(getDiagram: () => go.Diagram | null, shouldSkip: () => boolean): void {
    const diagram = getDiagram();
    if (!diagram || shouldSkip()) return;

    this.zone.runOutsideAngular(() => {
      diagram.updateAllTargetBindings();
      diagram.requestUpdate();
      this.logger.debug('字体变化，GoJS Canvas 已重绘');
    });
  }
}
