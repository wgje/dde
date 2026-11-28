import { ChangeDetectionStrategy, Component, Injectable, Input, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import type { Task } from '../../models';
import type { ConnectionEditorData, LinkActionMenu, LinkDeleteHint, LinkTypeDialogData } from '../../models/flow-view-state';
import { FlowBatchToolbarComponent } from '../features/flow/components/flow-batch-toolbar.component';
import { FlowBatchDeleteDialogComponent, type BatchDeleteDialogData } from '../features/flow/components/flow-batch-delete-dialog.component';
import { FlowCascadeAssignDialogComponent, type CascadeAssignDialogData } from '../features/flow/components/flow-cascade-assign-dialog.component';
import { FlowConnectionEditorComponent, type ConnectionEditorSavePayload } from '../features/flow/components/flow-connection-editor.component';
import { FlowDeleteConfirmComponent } from '../features/flow/components/flow-delete-confirm.component';
import { FlowLinkActionMenuComponent } from '../features/flow/components/flow-link-action-menu.component';
import { FlowLinkDeleteHintComponent } from '../features/flow/components/flow-link-delete-hint.component';
import { FlowLinkTypeDialogComponent } from '../features/flow/components/flow-link-type-dialog.component';
import { FlowToolbarComponent } from '../features/flow/components/flow-toolbar.component';
import { FlowSelectionService } from '../features/flow/services/flow-selection.service';
import { UiStateService } from '../../services/ui-state.service';
import { ProjectStateService } from '../../services/project-state.service';
import { UserSessionService } from '../../services/user-session.service';
import { LoggerService } from '../../services/logger.service';
import { ToastService } from '../../services/toast.service';

@Injectable()
export class DemoFlowControlsMemory {
  readonly selectedCount = signal(3);
  readonly hasMultipleSelection = computed(() => this.selectedCount() > 1);
  readonly selectionCount = this.selectedCount.asReadonly();
  readonly mobile = signal(false);
  readonly isMobile = this.mobile.asReadonly();
  readonly isFlowDetailOpen = signal(false);
  readonly currentUserId = () => null;
  readonly message = signal('');
  clearSelection(): void { this.selectedCount.set(0); this.message.set('虚拟选择已清空'); }
  warning(title: string, body: string): void { this.message.set(`${title} ${body}`); }
  category(): { debug: () => void; warn: () => void } { return { debug: () => {}, warn: () => {} }; }
}

@Component({
  selector: 'app-demo-flow-controls-preview', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FlowBatchToolbarComponent, FlowBatchDeleteDialogComponent, FlowCascadeAssignDialogComponent, FlowConnectionEditorComponent, FlowDeleteConfirmComponent, FlowLinkActionMenuComponent, FlowLinkDeleteHintComponent, FlowLinkTypeDialogComponent, FlowToolbarComponent],
  providers: [DemoFlowControlsMemory,
    { provide: FlowSelectionService, useExisting: DemoFlowControlsMemory },
    { provide: UiStateService, useExisting: DemoFlowControlsMemory },
    { provide: ProjectStateService, useExisting: DemoFlowControlsMemory },
    { provide: UserSessionService, useExisting: DemoFlowControlsMemory },
    { provide: LoggerService, useExisting: DemoFlowControlsMemory },
    { provide: ToastService, useExisting: DemoFlowControlsMemory },
  ],
  template: `
    <section class="control-preview" [attr.data-flow-control]="state()">
      @switch (state()) {
        @case ('batch-toolbar') { <app-flow-batch-toolbar (batchDelete)="result('请求批量删除 3 个虚拟任务')" /> }
        @case ('batch-toolbar-mobile') { <app-flow-batch-toolbar [isMobile]="true" [bottomOffset]="'16px'" (batchDelete)="result('请求批量删除 3 个虚拟任务')" /> }
        @case ('batch-delete') { <app-flow-batch-delete-dialog [data]="batchData" (confirm)="result('已删除虚拟任务')" (cancel)="result('已取消删除')" /> }
        @case ('cascade-assign') { <app-flow-cascade-assign-dialog [data]="cascadeData" (confirm)="result('已将虚拟子树分配到阶段 2')" (cancel)="result('已取消分配')" /> }
        @case ('delete-confirm') { <app-flow-delete-confirm [task]="source" [hasChildren]="true" [keepChildren]="keepChildren()" (keepChildrenChange)="keepChildren.set($event)" (confirm)="result($event ? '删除虚拟任务，保留子任务' : '删除虚拟任务和子任务')" (cancel)="result('已取消删除')" /> }
        @case ('link-type') { <app-flow-link-type-dialog [data]="linkTypeData" (parentChildLink)="result('已建立虚拟父子关系')" (crossTreeLink)="result('已建立虚拟跨树关系')" (cancel)="result('已取消连线')" /> }
        @case ('link-action') { <app-flow-link-action-menu [menu]="linkMenu" (edit)="result('已请求编辑虚拟关联')" (view)="result('已请求查看虚拟关联')" (deleteLink)="result('已解除虚拟关联')" (cancel)="result('已关闭菜单')" /> }
        @case ('link-action-parent') { <app-flow-link-action-menu [menu]="parentMenu" (edit)="result('已请求编辑虚拟关系')" (view)="result('已请求查看虚拟关系')" (deleteLink)="result('已解除虚拟父子关系')" (cancel)="result('已关闭菜单')" /> }
        @case ('link-delete-hint') { <app-flow-link-delete-hint [hint]="deleteHint" (confirm)="result('已解除虚拟关联')" (cancel)="result('保留虚拟关联')" /> }
        @case ('connection-preview') { <ng-container *ngTemplateOutlet="editor" /> }
        @case ('connection-edit') { <ng-container *ngTemplateOutlet="editor" /> }
        @case ('connection-parent') { <ng-container *ngTemplateOutlet="editor" /> }
        @case ('toolbar') { <ng-container *ngTemplateOutlet="toolbar" /> }
        @case ('toolbar-mobile') { <ng-container *ngTemplateOutlet="toolbar" /> }
        @case ('toolbar-link') { <ng-container *ngTemplateOutlet="toolbar" /> }
      }
      <ng-template #editor><app-flow-connection-editor [data]="connection()" [position]="{x:16,y:32}" [connectionTasks]="{source:source,target:target}" (save)="saveConnection($event)" (modeChange)="connectionMode($event)" (close)="result('已关闭虚拟编辑器')" (delete)="result('已删除虚拟关联')" (openTask)="result('定位到虚拟任务')" /></ng-template>
      <ng-template #toolbar><app-flow-toolbar [isLinkMode]="linkMode()" [linkSourceTask]="linkMode() ? source : null" [isPaletteOpen]="false" [relationDisplayMode]="relationMode()" (zoomIn)="result('虚拟画布放大')" (zoomOut)="result('虚拟画布缩小')" (autoLayout)="result('虚拟布局已整理')" (toggleLinkMode)="linkMode.update(toggle)" (cancelLinkMode)="linkMode.set(false)" (toggleRelationDisplayMode)="cycleRelation()" (exportPng)="result('虚拟 PNG 导出（没有下载）')" (exportSvg)="result('虚拟 SVG 导出（没有下载）')" (exportStrategicReview)="result('虚拟 Markdown 导出（没有下载）')" (toggleSidebar)="result('已切换虚拟侧栏')" (goBackToText)="result('返回虚拟文本视图')" /></ng-template>
    </section>
    <p role="status" class="control-result">{{ memory.message() }}</p>
  `,
  styles: [':host{display:block}.control-preview{position:relative;transform:translateZ(0);isolation:isolate;min-height:520px;overflow:hidden;border-radius:16px;background:var(--theme-bg,#fafaf9)}.control-result{min-height:24px;padding:8px;font-size:12px}'],
})
export class DemoFlowControlsPreviewComponent {
  readonly state = signal('batch-toolbar');
  @Input({ alias: 'state' }) set stateInput(value: string) { this.state.set(value); }
  readonly memory = inject(DemoFlowControlsMemory);
  readonly source = this.task('准备方案', 1);
  readonly target = this.task('实现功能', 2);
  readonly keepChildren = signal(false);
  readonly linkMode = signal(false);
  readonly relationMode = signal<'all' | 'focused' | 'hidden'>('all');
  readonly toggle = (value: boolean) => !value;
  readonly batchData: BatchDeleteDialogData = { selectedIds: [this.source.id, this.target.id], impact: { total: 3, explicit: 2, cascaded: 1 } };
  readonly cascadeData: CascadeAssignDialogData = { show: true, taskId: this.source.id, taskTitle: this.source.title, targetStage: 2, subtreeCount: 3, targetParentId: this.target.id, targetParentTitle: this.target.title, subtreeDepth: 2 };
  readonly linkTypeData: LinkTypeDialogData = { show: true, sourceId: this.source.id, targetId: this.target.id, sourceTask: this.source, targetTask: this.target, x: 160, y: 200 };
  readonly linkMenu: LinkActionMenu = { link: { data: {} }, x: 160, y: 220, isCrossTree: true };
  readonly parentMenu = { ...this.linkMenu, isCrossTree: false };
  readonly deleteHint: LinkDeleteHint = { link: { data: {} }, x: 160, y: 160, isCrossTree: true };
  readonly connection = signal<ConnectionEditorData>({ sourceId: this.source.id, targetId: this.target.id, title: '方案完成后开始实现', description: '这是一条可编辑的虚拟关联。', isCrossTree: true, mode: 'preview', x: 16, y: 32 });
  constructor() { effect(() => { const state = this.state(); this.memory.mobile.set(state === 'toolbar-mobile'); this.linkMode.set(state === 'toolbar-link'); this.connection.update(value => ({ ...value, mode: state === 'connection-edit' ? 'edit' : 'preview', isCrossTree: state !== 'connection-parent' })); }); }
  private task(title: string, stage: number): Task { return { id: crypto.randomUUID(), title, content: '可放心操作的虚拟任务', stage, parentId: null, order: 1, rank: 100, status: 'active', x: 0, y: 0, createdDate: '2026-01-01T12:00:00.000Z', displayId: String(stage) }; }
  result(message: string): void { this.memory.message.set(message); }
  saveConnection(payload: ConnectionEditorSavePayload): void { this.connection.update(value => ({ ...value, title: payload.title, description: payload.description })); this.result('虚拟关联已保存'); }
  connectionMode(mode: 'preview' | 'edit'): void { this.connection.update(value => ({ ...value, mode })); }
  cycleRelation(): void { this.relationMode.update(value => value === 'all' ? 'focused' : value === 'focused' ? 'hidden' : 'all'); }
}