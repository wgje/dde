import type { WritableSignal } from '@angular/core';
import type {
  LinkActionMenu,
  LinkDataRef,
  LinkDeleteHint,
} from '../../../../models/flow-view-state';

const LINK_DELETE_HINT_AUTO_HIDE_MS = 3000;
const LINK_ACTION_MENU_AUTO_HIDE_MS = 5000;

interface FlowLinkTransientUiControllerOptions {
  isDestroyed: () => boolean;
  linkDeleteHint: WritableSignal<LinkDeleteHint | null>;
  linkActionMenu: WritableSignal<LinkActionMenu | null>;
}

export class FlowLinkTransientUiController {
  private linkDeleteHintTimer: ReturnType<typeof setTimeout> | null = null;
  private linkActionMenuTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: FlowLinkTransientUiControllerOptions) {}

  showDeleteHint(linkData: LinkDataRef['data'], x: number, y: number): void {
    this.options.linkDeleteHint.set({
      link: { data: linkData },
      x,
      y,
      isCrossTree: !!linkData['isCrossTree'],
    });

    this.armDeleteHintAutoHide(linkData);
  }

  cancelDeleteHint(): void {
    this.options.linkDeleteHint.set(null);
    this.clearDeleteHintTimer();
  }

  showActionMenu(linkData: LinkDataRef['data'], x: number, y: number): void {
    this.cancelDeleteHint();
    this.options.linkActionMenu.set({
      link: { data: linkData },
      x,
      y,
      isCrossTree: !!linkData['isCrossTree'],
    });

    this.armActionMenuAutoHide(linkData);
  }

  cancelActionMenu(): void {
    this.options.linkActionMenu.set(null);
    this.clearActionMenuTimer();
  }

  clearAll(): void {
    this.cancelDeleteHint();
    this.cancelActionMenu();
  }

  private armDeleteHintAutoHide(linkData: LinkDataRef['data']): void {
    this.clearDeleteHintTimer();
    this.linkDeleteHintTimer = setTimeout(() => {
      if (this.options.isDestroyed()) return;

      const currentHint = this.options.linkDeleteHint();
      if (currentHint?.link?.data === linkData) {
        this.options.linkDeleteHint.set(null);
      }

      this.linkDeleteHintTimer = null;
    }, LINK_DELETE_HINT_AUTO_HIDE_MS);
  }

  private armActionMenuAutoHide(linkData: LinkDataRef['data']): void {
    this.clearActionMenuTimer();
    this.linkActionMenuTimer = setTimeout(() => {
      if (this.options.isDestroyed()) return;

      const currentMenu = this.options.linkActionMenu();
      if (currentMenu?.link?.data === linkData) {
        this.options.linkActionMenu.set(null);
      }

      this.linkActionMenuTimer = null;
    }, LINK_ACTION_MENU_AUTO_HIDE_MS);
  }

  private clearDeleteHintTimer(): void {
    if (this.linkDeleteHintTimer === null) return;
    clearTimeout(this.linkDeleteHintTimer);
    this.linkDeleteHintTimer = null;
  }

  private clearActionMenuTimer(): void {
    if (this.linkActionMenuTimer === null) return;
    clearTimeout(this.linkActionMenuTimer);
    this.linkActionMenuTimer = null;
  }
}
