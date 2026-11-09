import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  signal,
  type OnDestroy,
  type OnInit,
  ViewChild,
} from '@angular/core';
import { DatePipe, NgClass, NgComponentOutlet } from '@angular/common';

import { SyncStatusComponent } from '../../shared/components/sync-status.component';
import type { WorkspaceShellTemplateSurface } from './workspace-shell-template-surface.factory';
import {
  WorkspaceSidebarFocusToolsLoadStateController,
  type WorkspaceSidebarFocusTool,
} from './workspace-sidebar-focus-tools-load-state.controller';
import type {
  WorkspaceShellPanelToolsIntentSubscription,
} from './workspace-shell-tool-controllers.factory';

/**
 * 侧栏面板：项目列表、统一搜索、工具区（专注/录音）、同步状态与用户操作区。
 *
 * 从 workspace-shell.component.html 提取的纯视图子组件；
 * host 使用 display: contents，保持 aside 在 app-container flex 布局中的关系不变。
 */
@Component({
  selector: 'app-workspace-sidebar-panel',
  standalone: true,
  imports: [DatePipe, NgClass, NgComponentOutlet, SyncStatusComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
  templateUrl: './workspace-sidebar-panel.component.html',
})
export class WorkspaceSidebarPanelComponent implements OnDestroy, OnInit {
  readonly template = input.required<WorkspaceShellTemplateSurface>();
  readonly focusTool: WorkspaceSidebarFocusTool = 'FOCUS_SESSION_TRIGGER';
  readonly recorderTool: WorkspaceSidebarFocusTool = 'BLACK_BOX_RECORDER';

  private readonly outletVersion = signal(0);
  private focusOutletValue?: NgComponentOutlet;
  private recorderOutletValue?: NgComponentOutlet;

  @ViewChild('focusToolOutlet', { read: NgComponentOutlet })
  private set focusOutlet(outlet: NgComponentOutlet | undefined) {
    if (outlet === this.focusOutletValue) return;
    this.focusOutletValue = outlet;
    this.outletVersion.update(version => version + 1);
  }

  @ViewChild('recorderToolOutlet', { read: NgComponentOutlet })
  private set recorderOutlet(outlet: NgComponentOutlet | undefined) {
    if (outlet === this.recorderOutletValue) return;
    this.recorderOutletValue = outlet;
    this.outletVersion.update(version => version + 1);
  }
  @ViewChild('focusToolSlot', { static: true })
  private focusSlot?: ElementRef<HTMLElement>;
  @ViewChild('recorderToolSlot')
  private recorderSlot?: ElementRef<HTMLElement>;
  private readonly focusTools = new WorkspaceSidebarFocusToolsLoadStateController({
    onToolsIntent: () => this.template().tools.sidebar.onToolsIntent(),
    isBlackBoxEnabled: () => this.template().state.focusPrefs.isBlackBoxEnabled(),
    loadFocusSessionTrigger: () =>
      this.template().tools.sidebar.loadFocusSessionTriggerComponent(),
    loadBlackBoxRecorder: () =>
      this.template().tools.sidebar.loadBlackBoxRecorderComponent(),
    getFocusSessionTriggerComponent: () =>
      this.template().tools.bindings.focusSessionTriggerComponent(),
    getBlackBoxRecorderComponent: () =>
      this.template().tools.bindings.blackBoxRecorderComponent(),
  });
  private panelToolsIntentSubscription: WorkspaceShellPanelToolsIntentSubscription | null = null;

  constructor() {
    afterRenderEffect({
      write: () => {
        this.outletVersion();
        const recorderEnabled = this.template().state.focusPrefs.isBlackBoxEnabled();
        this.handoffFocus(
          this.focusTool,
          this.focusOutletValue?.componentInstance,
          this.focusSlot,
        );
        if (recorderEnabled) {
          this.handoffFocus(
            this.recorderTool,
            this.recorderOutletValue?.componentInstance,
            this.recorderSlot,
          );
        } else {
          this.focusTools.setFallbackFocused(this.recorderTool, false);
        }
      },
    });
  }

  ngOnInit(): void {
    this.panelToolsIntentSubscription = this.template()
      .tools.panelToolsIntent
      ?.register(() => this.onToolsIntent()) ?? null;
  }

  focusToolState() {
    return this.focusTools.state(this.focusTool);
  }

  recorderToolState() {
    return this.focusTools.state(this.recorderTool);
  }

  onToolsIntent(): void {
    this.focusTools.onToolsIntent();
  }

  activate(tool: WorkspaceSidebarFocusTool): void {
    void this.focusTools.activate(tool);
  }

  setFallbackFocused(
    tool: WorkspaceSidebarFocusTool,
    focused: boolean,
  ): void {
    this.focusTools.setFallbackFocused(tool, focused);
  }

  setFallbackBlurred(
    tool: WorkspaceSidebarFocusTool,
    event: FocusEvent,
    fallback: HTMLElement,
  ): void {
    const replacementAllowed = tool !== this.recorderTool
      || this.template().state.focusPrefs.isBlackBoxEnabled();
    const isExactDisconnectedFallback = replacementAllowed
      && event.currentTarget === fallback
      && !fallback.isConnected;
    this.focusTools.setFallbackFocused(tool, false, isExactDisconnectedFallback);
  }

  ngOnDestroy(): void {
    this.panelToolsIntentSubscription?.unregister();
    this.panelToolsIntentSubscription = null;
    this.focusTools.teardown();
  }

  private handoffFocus(
    tool: WorkspaceSidebarFocusTool,
    componentInstance: unknown,
    slot: ElementRef<HTMLElement> | undefined,
  ): void {
    const state = this.focusTools.state(tool);
    if (!componentInstance) return;
    if (!this.focusTools.consumeFocusHandoff(tool, state.attempt)) return;

    const focusable = componentInstance as {
      focusPrimaryAction?: () => boolean;
    };
    let focused = false;
    if (typeof focusable.focusPrimaryAction === 'function') {
      try {
        focused = focusable.focusPrimaryAction.call(componentInstance) === true;
      } catch {
        focused = false;
      }
    }
    if (!focused) {
      slot?.nativeElement.focus();
    }
  }
}
