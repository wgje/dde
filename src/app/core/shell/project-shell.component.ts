import { 
  Component, 
  OnInit, 
  OnDestroy,
  HostListener,
  ChangeDetectionStrategy
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterOutlet } from '@angular/router';
// 【重要】@defer 使用的组件必须直接引用源文件，禁止走 barrel（index.ts）
// barrel 会把所有子组件一起 re-export，导致 esbuild 代码分割时 AOT 元数据丢失，
// 触发运行时 JIT 编译失败（TextStageCardComponent / FlowView 等）
import { TextViewComponent } from '../../features/text/components/text-view.component';
import { FlowViewComponent } from '../../features/flow/components/flow-view.component';
// @defer 使用的组件：直接引用源文件（同上理由）
import { ParkingDockComponent } from '../../features/parking/parking-dock.component';
import { ParkingNoticeComponent } from '../../features/parking/parking-notice.component';
import {
  type ProjectShellFlowIntentSource,
} from './project-shell-flow-intent.controller';
import { createProjectShellControllerGraph } from './project-shell-controller-graph.factory';

/**
 * 项目视图外壳组件
 * 负责管理 text-view 和 flow-view 的切换显示
 * 对应路由: /projects/:projectId, /projects/:projectId/text, /projects/:projectId/flow
 * 
 * 【移动端策略】
 * 使用 @if 条件渲染完全销毁/重建 FlowView 组件。
 * 好处：
 * - 释放 GoJS canvas 占用的内存
 * - 避免僵尸模式下的 canvas 渲染问题
 * - 简化代码，无需手动 suspend/resume
 * 
 * 【Flow 加载策略】
 * 桌面端和移动端都通过 @defer 按需挂载 FlowView，保持 GoJS 运行时代码懒加载。
 * 移动端切回文本时销毁 FlowView，释放 GoJS canvas 占用。
 * Shell 通过 FlowCommandService 与 FlowView 解耦通信。
 */
@Component({
  selector: 'app-project-shell',
  standalone: true,
  // 【P2-22 修复】添加 OnPush 变更检测策略
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, TextViewComponent, FlowViewComponent, RouterOutlet, ParkingDockComponent, ParkingNoticeComponent],
  styleUrl: './project-shell.component.css',
  templateUrl: './project-shell.component.html'
})
export class ProjectShellComponent implements OnInit, OnDestroy {
  private readonly shellGraph = createProjectShellControllerGraph();
  readonly uiState = this.shellGraph.template.uiState;
  readonly projectState = this.shellGraph.template.projectState;
  readonly dockTakeoverPhase = this.shellGraph.template.dockTakeoverPhase;
  readonly dockTakeoverMainHidden = this.shellGraph.template.dockTakeoverMainHidden;
  readonly dockTakeoverMainDimmed = this.shellGraph.template.dockTakeoverMainDimmed;
  readonly dockTakeoverMainNonInteractive = this.shellGraph.template.dockTakeoverMainNonInteractive;
  readonly dockTakeoverMainOpacity = this.shellGraph.template.dockTakeoverMainOpacity;
  readonly dockTakeoverMainFilter = this.shellGraph.template.dockTakeoverMainFilter;
  readonly dockTakeoverMainTransform = this.shellGraph.template.dockTakeoverMainTransform;
  readonly dockTakeoverMainTransition = this.shellGraph.template.dockTakeoverMainTransition;
  readonly isFilterOpen = this.shellGraph.template.isFilterOpen;
  readonly currentFilterLabel = this.shellGraph.template.currentFilterLabel;
  readonly flowIntentActivated = this.shellGraph.template.flowIntentActivated;
  readonly flowPrefetchOnlyActivated = this.shellGraph.template.flowPrefetchOnlyActivated;
  readonly shouldLoadFlowNow = this.shellGraph.template.shouldLoadFlowNow;
  readonly shouldPrefetchFlowChunk = this.shellGraph.template.shouldPrefetchFlowChunk;
  readonly collapseAnimating = this.shellGraph.template.collapseAnimating;

  ngOnInit(): void {
    this.shellGraph.controllers.lifecycle.initialize();
  }

  /**
   * Flow 视图意图触发器
   * 默认只在用户有明确意图时加载 GoJS 大块代码
   */
  activateFlowIntent(source: ProjectShellFlowIntentSource): void {
    this.shellGraph.controllers.flowIntent.activate(source);
  }
  
  ngOnDestroy(): void {
    this.shellGraph.controllers.lifecycle.destroy();
  }
  
  // ========== 视图切换 ==========
  
  /**
   * 切换到流程图视图
   * 移动端：使用条件渲染，FlowView 组件会被完全销毁/重建
   */
  switchToFlow() {
    this.shellGraph.controllers.viewActions.switchToFlow();
  }
  
  switchToText() {
    this.shellGraph.controllers.viewActions.switchToText();
  }
  
  // ========== 侧边栏控制 ==========
  
  toggleSidebar() {
    this.shellGraph.controllers.uiActions.toggleSidebar();
  }

  toggleDockFocusSession(): void {
    this.shellGraph.controllers.uiActions.toggleDockFocusSession();
  }

  // ========== 文本栏折叠控制（桌面端） ==========

  /** 切换文本栏的折叠/展开状态 */
  toggleTextColumn() {
    this.shellGraph.controllers.uiActions.toggleTextColumn();
  }

  /** 从折叠状态展开文本栏到最小可用宽度（25%） */
  expandTextColumnToMin() {
    this.shellGraph.controllers.uiActions.expandTextColumnToMin();
  }
  
  // ========== 流程图节点定位 ==========
  
  onFocusFlowNode(taskId: string) {
    this.shellGraph.controllers.viewActions.focusFlowNode(taskId);
  }
  
  startContentResize(e: MouseEvent) {
    this.shellGraph.controllers.contentResize.start(e);
  }

  @HostListener('document:mousemove', ['$event'])
  onMouseMove(e: MouseEvent) {
    this.shellGraph.controllers.contentResize.move(e);
  }
  
  @HostListener('document:mouseup')
  onMouseUp() {
    this.shellGraph.controllers.contentResize.end();
  }
  
  // ========== 文本视图滑动手势 ==========
  // 允许从文本视图向左滑动切换到流程图
  // 流程图视图不处理滑动手势，避免与画布操作冲突
  
  onTextViewTouchStart(e: TouchEvent) {
    this.shellGraph.controllers.textViewSwipe.onTouchStart(e);
  }
  
  onTextViewTouchMove(e: TouchEvent) {
    this.shellGraph.controllers.textViewSwipe.onTouchMove(e);
  }
  
  onTextViewTouchEnd(e: TouchEvent) {
    this.shellGraph.controllers.textViewSwipe.onTouchEnd(e);
  }
  
  // ========== 错误边界重试回调 ==========
  
  /**
   * 重试加载文本视图
   */
  retryTextView(): void {
    this.shellGraph.controllers.viewActions.retryTextView();
  }
  
  /**
   * 重试加载流程图视图
   * 移动端 FlowViewComponent 通过 @defer 延迟加载；桌面端直接向已挂载的 FlowView 发送重试命令。
   */
  retryFlowView(): void {
    this.shellGraph.controllers.viewActions.retryFlowView();
  }
  
  /**
   * 打开新建项目模态框
   * 当没有活动项目时，点击占位区域触发
   */
  async openNewProjectModal(): Promise<void> {
    return this.shellGraph.controllers.newProjectModal.open();
  }
  
  /**
   * 刷新页面 - 用于 @defer 加载失败时的恢复
   * 强制清除所有缓存并刷新，避免 Service Worker 再次返回过期/损坏的 chunk
   */
  reloadPage(): void {
    this.shellGraph.controllers.cacheReload.reloadPage();
  }
}
