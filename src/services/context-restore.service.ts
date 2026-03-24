/**
 * ContextRestoreService — 上下文快照保存与恢复
 *
 * 策划案 A5.2 规范
 * 职责：保存/恢复光标、滚动锚点、结构锚点、Flow 视口
 *
 * 恢复策略：
 * 1. contentHash 匹配 → 精确恢复
 * 2. contentHash 不匹配 → 四级 fallback 降级恢复
 *    - structuralAnchor.label 文本搜索 → cursorPosition.line → scrollPercent → 文档顶部
 * 3. 跨视图降级 → 仅用 structuralAnchor + scrollPercent
 */

import { Injectable, inject, Injector } from '@angular/core';
import { TaskStore, ProjectStore } from './stores';
import { ParkingSnapshot, ParkingStructuralAnchor, ParkingScrollAnchor, ParkingFlowViewport } from '../models';
import { UiStateService } from './ui-state.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { PARKING_CONFIG } from '../config/parking.config';

@Injectable({
  providedIn: 'root'
})
export class ContextRestoreService {
  private readonly taskStore = inject(TaskStore);
  private readonly projectStore = inject(ProjectStore);
  private readonly uiState = inject(UiStateService);
  private readonly toastService = inject(ToastService);
  private readonly logger = inject(LoggerService);
  private readonly injector = inject(Injector);

  /**
   * 保存当前任务的上下文快照
   * 在停泊或关闭页面前调用
   */
  async saveSnapshot(taskId: string): Promise<void> {
    const task = this.taskStore.getTask(taskId);
    if (!task) return;

    const viewMode = this.uiState.activeView() === 'flow' ? 'flow' : 'text';
    const contentHash = this.computeContentHash(task.content);

    const flowViewport = viewMode === 'flow' ? await this.captureFlowViewport() : null;

    const snapshot: ParkingSnapshot = {
      savedAt: new Date().toISOString(),
      contentHash,
      viewMode,
      cursorPosition: viewMode === 'text' ? this.captureCursorPosition() : null,
      scrollAnchor: viewMode === 'text' ? this.captureScrollAnchor() : null,
      structuralAnchor: this.captureStructuralAnchor(task.content, viewMode),
      flowViewport,
    };

    // 将快照写入 parkingMeta
    if (task.parkingMeta) {
      const projectId = this.findProjectId(taskId);
      if (projectId) {
        this.taskStore.setTask(
          {
            ...task,
            parkingMeta: { ...task.parkingMeta, contextSnapshot: snapshot },
            updatedAt: new Date().toISOString(),
          },
          projectId
        );
      }
    }
  }

  /**
   * 恢复任务上下文
   * 先判断 contentHash 是否匹配，不匹配走四级 fallback
   */
  restore(taskId: string, snapshot: ParkingSnapshot): void {
    const task = this.taskStore.getTask(taskId);
    if (!task) return;

    const currentViewMode = this.uiState.activeView() === 'flow' ? 'flow' : 'text';
    const currentHash = this.computeContentHash(task.content);
    const hashMatches = currentHash === snapshot.contentHash;

    // 跨设备/跨视图降级（A5.2.4）
    const isCrossView = currentViewMode !== snapshot.viewMode;

    if (currentViewMode === 'flow') {
      void this.restoreFlowView(snapshot, isCrossView);
    } else {
      this.restoreTextView(snapshot, task.content, hashMatches, isCrossView);
    }
  }

  // ─── Text 视图恢复 ───

  private restoreTextView(
    snapshot: ParkingSnapshot,
    currentContent: string,
    hashMatches: boolean,
    isCrossView: boolean
  ): void {
    if (hashMatches && !isCrossView) {
      // 精确恢复
      this.restoreCursorPosition(snapshot.cursorPosition);
      this.restoreScrollAnchor(snapshot.scrollAnchor);
      this.flashEditLine(snapshot.cursorPosition?.line ?? 1);
      return;
    }

    // 降级恢复——内容已变更或跨视图
    if (!hashMatches) {
      this.toastService.info(
        '内容已变更，已跳转到最近匹配位置',
        undefined,
        {
          action: { label: '跳到顶部', onClick: () => this.scrollToTop() },
        }
      );
    }

    // 四级 fallback（A5.2.3）
    const restored = this.fallbackRestore(snapshot, currentContent, isCrossView);
    if (restored.line) {
      this.flashEditLine(restored.line);
    }
  }

  /**
   * 四级 fallback 恢复算法
   * 1. structuralAnchor.label 精确文本搜索
   * 2. cursorPosition.line（如在文档范围内，跨视图不尝试）
   * 3. scrollPercent 按比例滚动
   * 4. 文档顶部
   */
  private fallbackRestore(
    snapshot: ParkingSnapshot,
    currentContent: string,
    isCrossView: boolean
  ): { line: number | null } {
    // Level 1: structuralAnchor.label 文本搜索
    if (snapshot.structuralAnchor?.label) {
      const line = this.findLineByText(currentContent, snapshot.structuralAnchor.label);
      if (line !== null) {
        this.scrollToLine(line);
        return { line };
      }
    }

    // Level 2: cursorPosition.line（跨视图不尝试）
    if (!isCrossView && snapshot.cursorPosition) {
      const totalLines = currentContent.split('\n').length;
      if (snapshot.cursorPosition.line <= totalLines) {
        this.scrollToLine(snapshot.cursorPosition.line);
        return { line: snapshot.cursorPosition.line };
      }
    }

    // Level 3: scrollPercent 百分比滚动
    if (snapshot.scrollAnchor?.scrollPercent !== undefined) {
      this.scrollToPercent(snapshot.scrollAnchor.scrollPercent);
      return { line: null };
    }

    // Level 4: 文档顶部
    this.scrollToTop();
    return { line: null };
  }

  // ─── Flow 视图恢复（A5.2.5） ───

  /**
   * 【性能优化 2026-03-24】改用 import() 替代 require()，打破 GoJS 静态依赖链。
   * require() 会被 esbuild 静态分析并打包，导致 1.3MB GoJS 进入首屏 bundle。
   * import() 是真正的动态导入，只在运行时按需加载。
   */
  private async restoreFlowView(snapshot: ParkingSnapshot, isCrossView: boolean): Promise<void> {
    if (isCrossView || !snapshot.flowViewport) {
      // 跨视图降级——仅尝试 structuralAnchor
      return;
    }

    try {
      // 动态 import()：真正的代码分割，不会被 esbuild 静态打包
      const { FlowDiagramService } = await import('../app/features/flow/services/flow-diagram.service');
      const flowService = this.injector.get(FlowDiagramService, null);
      if (!flowService) return;

      const { FlowZoomService } = await import('../app/features/flow/services/flow-zoom.service');
      const zoomService = this.injector.get(FlowZoomService, null);

      // 恢复缩放比例
      if (zoomService && snapshot.flowViewport.scale) {
        zoomService.setZoom(snapshot.flowViewport.scale);
      }

      // 恢复选中节点
      if (snapshot.flowViewport.selectedNodeId) {
        flowService.selectNode(snapshot.flowViewport.selectedNodeId);
      }

      this.logger.info('ContextRestoreService', 'Flow 视图已恢复', {
        scale: snapshot.flowViewport.scale,
        selectedNodeId: snapshot.flowViewport.selectedNodeId,
      });
    } catch {
      this.logger.info('ContextRestoreService', 'Flow 服务未加载，跳过视口恢复');
    }
  }

  // ─── 捕获方法 ───

  private captureCursorPosition(): { line: number; column: number } | null {
    // 通过 DOM 获取编辑器光标位置
    // 实际实现依赖具体编辑器组件的光标 API
    try {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return null;

      const range = selection.getRangeAt(0);
      const editorEl = document.querySelector('.text-editor, .markdown-editor, [contenteditable]');
      if (!editorEl || !editorEl.contains(range.startContainer)) return null;

      // 简化：计算行号
      const textBefore = this.getTextBeforeRange(editorEl, range);
      const line = (textBefore.match(/\n/g) || []).length + 1;
      const lastNewline = textBefore.lastIndexOf('\n');
      const column = lastNewline === -1 ? textBefore.length + 1 : textBefore.length - lastNewline;

      return { line, column };
    } catch {
      // eslint-disable-next-line no-restricted-syntax -- DOM 光标捕获失败是正常降级，非业务错误
      return null;
    }
  }

  private captureScrollAnchor(): ParkingScrollAnchor | null {
    try {
      const editorContainer = document.querySelector('.text-view-container, .text-column');
      if (!editorContainer) return null;

      const scrollTop = editorContainer.scrollTop;
      const scrollHeight = editorContainer.scrollHeight - editorContainer.clientHeight;
      const scrollPercent = scrollHeight > 0 ? scrollTop / scrollHeight : 0;

      // 搜索当前视口中第一个可见的 heading
      const headings = editorContainer.querySelectorAll('h1, h2, h3, h4, h5, h6');
      for (let i = 0; i < headings.length; i++) {
        const heading = headings[i] as HTMLElement;
        const rect = heading.getBoundingClientRect();
        const containerRect = editorContainer.getBoundingClientRect();
        if (rect.top >= containerRect.top && rect.top <= containerRect.bottom) {
          return {
            anchorType: 'heading',
            anchorIndex: i,
            anchorOffset: rect.top - containerRect.top,
            scrollPercent,
          };
        }
      }

      return {
        anchorType: 'line',
        anchorIndex: Math.floor(scrollTop / 20), // 粗略行号估算
        scrollPercent,
      };
    } catch {
      // eslint-disable-next-line no-restricted-syntax -- DOM 滚动捕获失败是正常降级，非业务错误
      return null;
    }
  }

  private captureStructuralAnchor(content: string, viewMode: string): ParkingStructuralAnchor | null {
    if (viewMode === 'flow') {
      // Flow 视图：使用选中节点作为结构锚点
      // 实际实现需 FlowSelectionService
      return { type: 'fallback', label: '' };
    }

    // Text 视图：查找最近的 Markdown 标题
    const lines = content.split('\n');
    const cursor = this.captureCursorPosition();
    const targetLine = cursor?.line ?? 1;

    // 从光标行向上搜索最近的标题
    for (let i = Math.min(targetLine - 1, lines.length - 1); i >= 0; i--) {
      const match = lines[i].match(/^#{1,6}\s+(.+)/);
      if (match) {
        return {
          type: 'heading',
          label: match[1].trim(),
          line: i + 1,
        };
      }
    }

    // 无标题——使用行号 fallback
    return {
      type: 'line',
      label: `Line ${targetLine}`,
      line: targetLine,
    };
  }

  /**
   * 【性能优化 2026-03-24】改用 import() 替代 require()，打破 GoJS 静态依赖链。
   */
  private async captureFlowViewport(): Promise<ParkingFlowViewport | null> {
    try {
      const { FlowDiagramService } = await import('../app/features/flow/services/flow-diagram.service');
      const flowService = this.injector.get(FlowDiagramService, null);
      if (!flowService) return null;
      return flowService.getFlowParkingSnapshot() ?? null;
    } catch {
      return null;
    }
  }

  // ─── 恢复辅助方法 ───

  private restoreCursorPosition(pos: { line: number; column: number } | null): void {
    if (!pos) return;
    if (typeof document === 'undefined' || typeof window === 'undefined') return;

    try {
      const editor = this.findPrimaryTextEditor();
      if (!editor) return;

      if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
        const value = editor.value ?? '';
        const offset = this.lineColumnToTextOffset(value, pos.line, pos.column);
        editor.focus();
        editor.setSelectionRange(offset, offset);
        return;
      }

      const host = editor as HTMLElement;
      const plainText = host.textContent ?? '';
      const offset = this.lineColumnToTextOffset(plainText, pos.line, pos.column);
      const target = this.resolveTextNodeOffset(host, offset);
      if (!target) {
        this.scrollToLine(pos.line);
        return;
      }

      const selection = window.getSelection();
      if (!selection) return;

      const range = document.createRange();
      range.setStart(target.node, target.offset);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      host.focus();
    } catch {
      // 光标恢复失败时退化为按行滚动，不中断主流程
      this.scrollToLine(pos.line);
    }
  }

  private findPrimaryTextEditor(): HTMLElement | HTMLInputElement | HTMLTextAreaElement | null {
    const selectors = [
      'textarea.text-editor',
      'textarea.markdown-editor',
      '.text-editor[contenteditable="true"]',
      '.markdown-editor[contenteditable="true"]',
      '[contenteditable="true"]',
      'textarea',
    ];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el instanceof HTMLElement || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        return el as HTMLElement | HTMLInputElement | HTMLTextAreaElement;
      }
    }
    return null;
  }

  private lineColumnToTextOffset(text: string, line: number, column: number): number {
    if (line <= 1) {
      return Math.max(0, Math.min(text.length, column - 1));
    }

    const lines = text.split('\n');
    const clampedLine = Math.max(1, Math.min(lines.length, line));
    let offset = 0;
    for (let i = 0; i < clampedLine - 1; i++) {
      offset += lines[i].length + 1; // +1 for '\n'
    }

    const lineContent = lines[clampedLine - 1] ?? '';
    const columnOffset = Math.max(0, Math.min(lineContent.length, column - 1));
    return Math.min(text.length, offset + columnOffset);
  }

  private resolveTextNodeOffset(
    host: HTMLElement,
    targetOffset: number
  ): { node: Text; offset: number } | null {
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let consumed = 0;
    let current = walker.nextNode();

    while (current) {
      const textNode = current as Text;
      const length = textNode.textContent?.length ?? 0;
      if (targetOffset <= consumed + length) {
        return {
          node: textNode,
          offset: Math.max(0, targetOffset - consumed),
        };
      }
      consumed += length;
      current = walker.nextNode();
    }

    return null;
  }

  private restoreScrollAnchor(anchor: ParkingScrollAnchor | null): void {
    if (!anchor) return;

    if (anchor.anchorType === 'heading') {
      const editorContainer = document.querySelector('.text-view-container, .text-column');
      if (!editorContainer) return;
      const headings = editorContainer.querySelectorAll('h1, h2, h3, h4, h5, h6');
      if (headings[anchor.anchorIndex]) {
        (headings[anchor.anchorIndex] as HTMLElement).scrollIntoView({ behavior: 'auto' });
        return;
      }
    }

    // fallback: scrollPercent
    this.scrollToPercent(anchor.scrollPercent);
  }

  private flashEditLine(line: number): void {
    // 三段式闪烁：亮起→保持→淡出（共 1000ms）
    // 检查 prefers-reduced-motion，降级为静态高亮
    const prefersReduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const duration = PARKING_CONFIG.EDIT_LINE_FLASH_DURATION;

    // 查找对应行的 DOM 元素
    const editorContainer = document.querySelector('.text-view-container, .text-column');
    if (!editorContainer) return;

    // 创建高亮覆盖层
    const highlightEl = document.createElement('div');
    highlightEl.className = 'parking-restore-highlight';
    highlightEl.style.cssText = `
      position: absolute;
      left: 0; right: 0;
      height: 24px;
      top: ${(line - 1) * 24}px;
      background: rgba(255, 213, 79, 0.4);
      pointer-events: none;
      z-index: 10;
      transition: opacity ${prefersReduced ? '0ms' : `${duration}ms`} ease-out;
    `;
    editorContainer.appendChild(highlightEl);

    if (prefersReduced) {
      // 静态高亮 1s 后移除
      setTimeout(() => highlightEl.remove(), duration);
    } else {
      // 三段式：亮起 200ms → 保持 500ms → 淡出 300ms
      setTimeout(() => {
        highlightEl.style.opacity = '0';
        setTimeout(() => highlightEl.remove(), 300);
      }, 700);
    }
  }

  private scrollToLine(line: number): void {
    const editorContainer = document.querySelector('.text-view-container, .text-column');
    if (!editorContainer) return;
    editorContainer.scrollTop = Math.max(0, (line - 1) * 20);
  }

  private scrollToPercent(percent: number): void {
    const editorContainer = document.querySelector('.text-view-container, .text-column');
    if (!editorContainer) return;
    const maxScroll = editorContainer.scrollHeight - editorContainer.clientHeight;
    editorContainer.scrollTop = maxScroll * Math.max(0, Math.min(1, percent));
  }

  private scrollToTop(): void {
    const editorContainer = document.querySelector('.text-view-container, .text-column');
    if (!editorContainer) return;
    editorContainer.scrollTop = 0;
  }

  private findLineByText(content: string, searchText: string): number | null {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(searchText)) {
        return i + 1;
      }
    }
    return null;
  }

  // ─── 工具函数 ───

  /**
   * 计算内容哈希（简化版——取前 256 字符 + 长度的组合哈希）
   * 用于检测停泊期间内容是否变更，不需要密码学安全性
   */
  private computeContentHash(content: string): string {
    const str = `${content.length}:${content.substring(0, 256)}`;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0; // 转为 32 位整数
    }
    return hash.toString(36);
  }

  private getTextBeforeRange(container: Element, range: Range): string {
    const preRange = document.createRange();
    preRange.setStart(container, 0);
    preRange.setEnd(range.startContainer, range.startOffset);
    return preRange.toString();
  }

  private findProjectId(taskId: string): string | null {
    return this.taskStore.getTaskProjectId(taskId)
      ?? this.projectStore.activeProjectId()
      ?? null;
  }
}
