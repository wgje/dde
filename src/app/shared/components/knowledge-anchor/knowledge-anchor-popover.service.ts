import { DestroyRef, Injectable, inject } from '@angular/core';
import { Overlay, OverlayRef, type ConnectedPosition, type FlexibleConnectedPositionStrategyOrigin } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { SIYUAN_CONFIG } from '../../../../config/siyuan.config';
import type { ExternalSourceLink } from '../../../core/external-sources/external-source.model';
import { KnowledgeAnchorPopoverComponent } from './knowledge-anchor-popover.component';

type PopoverOrigin = FlexibleConnectedPositionStrategyOrigin;

@Injectable({ providedIn: 'root' })
export class KnowledgeAnchorPopoverService {
  private readonly overlay = inject(Overlay);
  private overlayRef?: OverlayRef;
  private originRef?: PopoverOrigin;
  private pendingOriginRef?: PopoverOrigin;
  private activeOwner?: object;
  private pendingOwner?: object;
  private openTimer?: ReturnType<typeof setTimeout>;
  private closeTimer?: ReturnType<typeof setTimeout>;
  private closeOwner?: object;

  constructor() {
    // 单例 service 在 root 注入器销毁时（HMR/SSR teardown）一并 dispose 掉 OverlayRef，避免内存与 DOM 泄漏。
    inject(DestroyRef).onDestroy(() => this.dispose());
  }

  readonly positions: ConnectedPosition[] = [
    { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetY: 8 },
    { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom', offsetY: -8 },
    { originX: 'end', originY: 'center', overlayX: 'start', overlayY: 'center', offsetX: 8 },
    { originX: 'start', originY: 'center', overlayX: 'end', overlayY: 'center', offsetX: -8 },
  ];

  scheduleOpen(link: ExternalSourceLink, origin: PopoverOrigin, owner: object = origin as object): void {
    this.cancelClose();
    this.cancelOpen();
    this.pendingOriginRef = origin;
    this.pendingOwner = owner;
    this.openTimer = setTimeout(() => {
      this.openTimer = undefined;
      this.pendingOriginRef = undefined;
      this.pendingOwner = undefined;
      if (origin instanceof HTMLElement && !origin.isConnected) return;
      this.open(link, origin, owner);
    }, SIYUAN_CONFIG.HOVER_OPEN_DELAY_MS);
  }

  openNow(link: ExternalSourceLink, origin: PopoverOrigin, owner: object = origin as object): void {
    this.cancelClose();
    this.cancelOpen();
    this.open(link, origin, owner);
  }

  scheduleClose(owner?: object): void {
    const closeOwner = owner ?? this.activeOwner ?? this.pendingOwner;
    const ownsActiveOverlay = closeOwner !== undefined && this.activeOwner === closeOwner;
    const ownsPendingOpen = closeOwner !== undefined && this.pendingOwner === closeOwner;
    if (closeOwner && !ownsActiveOverlay && !ownsPendingOpen) return;
    if (ownsPendingOpen) this.cancelOpen();
    if (!ownsActiveOverlay) return;
    this.cancelClose();
    this.closeOwner = closeOwner;
    this.closeTimer = setTimeout(() => {
      this.closeTimer = undefined;
      const timerOwner = this.closeOwner;
      this.closeOwner = undefined;
      if (timerOwner) this.closeForOwner(timerOwner);
      else this.close();
    }, SIYUAN_CONFIG.HOVER_CLOSE_GRACE_MS);
  }

  keepOpen(owner?: object): void {
    if (owner && this.closeOwner !== owner) return;
    this.cancelClose();
  }

  close(options: { restoreFocus?: boolean } = {}): void {
    this.cancelOpen();
    this.cancelClose();
    this.closeOverlay(options);
  }

  private closeOverlay(options: { restoreFocus?: boolean } = {}): void {
    this.cancelClose();
    this.overlayRef?.detach();
    if (options.restoreFocus && this.originRef instanceof HTMLElement) {
      this.originRef.focus();
    }
    this.originRef = undefined;
    this.activeOwner = undefined;
  }

  closeForHost(host: HTMLElement, options: { restoreFocus?: boolean } = {}): void {
    this.closeForOwner(host, options);
  }

  closeForOwner(owner: object, options: { restoreFocus?: boolean } = {}): void {
    if (this.pendingOwner === owner) this.cancelOpen();
    if (this.activeOwner === owner) this.closeOverlay(options);
  }

  dispose(): void {
    this.close();
    this.overlayRef?.dispose();
    this.overlayRef = undefined;
  }

  private open(link: ExternalSourceLink, origin: PopoverOrigin, owner: object): void {
    this.originRef = origin;
    this.activeOwner = owner;
    const positionStrategy = this.overlay.position()
      .flexibleConnectedTo(origin)
      .withPositions(this.positions)
      .withPush(true)
      .withViewportMargin(8);

    if (!this.overlayRef) {
      this.overlayRef = this.overlay.create({
        positionStrategy,
        scrollStrategy: this.overlay.scrollStrategies.reposition(),
        hasBackdrop: false,
        panelClass: 'knowledge-anchor-overlay-panel',
      });
      this.overlayRef.keydownEvents().subscribe(event => {
        if (event.key === 'Escape') {
          const currentOwner = this.activeOwner;
          if (currentOwner) this.closeForOwner(currentOwner, { restoreFocus: true });
          else this.close({ restoreFocus: true });
        }
      });
    } else {
      this.overlayRef.updatePositionStrategy(positionStrategy);
      this.overlayRef.detach();
    }

    const componentRef = this.overlayRef.attach(new ComponentPortal(KnowledgeAnchorPopoverComponent));
    componentRef.setInput('link', link);
    componentRef.instance.hoverInside.subscribe(() => this.keepOpen(owner));
    componentRef.instance.hoverOutside.subscribe(() => this.scheduleClose(owner));
    componentRef.instance.closeRequested.subscribe(() => this.closeForOwner(owner));
  }

  private cancelOpen(): void {
    if (this.openTimer !== undefined) {
      clearTimeout(this.openTimer);
      this.openTimer = undefined;
    }
    this.pendingOriginRef = undefined;
    this.pendingOwner = undefined;
  }

  private cancelClose(): void {
    if (this.closeTimer !== undefined) {
      clearTimeout(this.closeTimer);
      this.closeTimer = undefined;
    }
    this.closeOwner = undefined;
  }
}
