import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

function getMethodBody(source: string, methodName: string): string {
  const marker = `${methodName}(`;
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);

  const bodyStart = source.indexOf('{', start);
  expect(bodyStart).toBeGreaterThanOrEqual(0);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) {
      return source.slice(bodyStart + 1, index);
    }
  }

  throw new Error(`Method ${methodName} body was not closed`);
}

describe('text-view.component.ts', () => {
  it('应将文本视图中的任务链接输出绑定到共享跳转逻辑', () => {
    const sourcePath = join(process.cwd(), 'src/app/features/text/components/text-view.component.ts');
    const source = readFileSync(sourcePath, 'utf8');

    const binding = '(openLinkedTask)="ops.onOpenLinkedTask($event)"';

    expect(source).toContain(binding);
    expect(source.match(/\(openLinkedTask\)=\"ops\.onOpenLinkedTask\(\$event\)\"/g)?.length).toBe(2);
  });

  it('应将触摸起点携带的手势模式继续传递给拖拽服务', () => {
    const sourcePath = join(process.cwd(), 'src/app/features/text/components/text-view.component.ts');
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).toContain('gestureMode: data.gestureMode');
    expect(source.match(/startTouchDrag\(task, touch, \(\) => \{}, \{ gestureMode: data\.gestureMode \}\)/g)?.length).toBe(2);
  });

  it('应允许选中任务通过移动端显式手柄发起触摸拖拽', () => {
    const sourcePath = join(process.cwd(), 'src/app/features/text/components/text-view.component.ts');
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).toContain("data.gestureMode !== 'handle'");
    expect(source).toContain("if (!task || (this.selectedTaskId() === task.id && data.gestureMode !== 'handle')) return;");
  });

  it('应在 touchcancel 时清理尚未完成的触摸拖拽状态', () => {
    const sourcePath = join(process.cwd(), 'src/app/features/text/components/text-view.component.ts');
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).toContain('onTouchCancel(_event: TouchEvent) {');
    expect(source).toContain('this.cleanupTouchGestureState();');
    expect(source).toContain('if (!this.dragDropService.draggingTaskId() && !this.dragDropService.touchDragTask) return;');
  });

  it('全局 touchend 即使处于 DOM 更新窗口也必须完成触摸拖拽清理', () => {
    const sourcePath = join(process.cwd(), 'src/app/features/text/components/text-view.component.ts');
    const source = readFileSync(sourcePath, 'utf8');

    const touchEndBody = getMethodBody(source, 'handleGlobalTouchEnd');
    const pointerUpBody = getMethodBody(source, 'handleGlobalPointerUp');

    expect(touchEndBody).not.toContain('isDOMUpdating');
    expect(touchEndBody).toContain('this.ngZone.run(() => this.onTouchEnd(event));');
    expect(pointerUpBody).not.toContain('isDOMUpdating');
    expect(pointerUpBody).toContain('this.onTouchEnd(event as unknown as TouchEvent);');
  });

  it('应在 stage dragleave 时继续走 null-stage 自动滚动解析，而不是直接跳最外层', () => {
    const sourcePath = join(process.cwd(), 'src/app/features/text/components/text-view.component.ts');
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).toContain('this.dragDropService.updateAutoScrollContainer(this.ops.resolveAutoScrollContainer(null, event.clientY), event.clientY);');
    expect(source).not.toContain('this.dragDropService.updateAutoScrollContainer(this.ops.getScrollContainer(), event.clientY);');
  });

  it('stage drop 必须拒绝来自其他项目的拖拽 payload（跨窗口/项目切换边界）', () => {
    const sourcePath = join(process.cwd(), 'src/app/features/text/components/text-view.component.ts');
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).toContain('const payloadProjectId = payload?.fromProjectId ?? payload?.projectId ?? null;');
    expect(source).toContain("if (payloadProjectId && payloadProjectId !== this.projectState.activeProjectId()) {");
    expect(source).toContain('任务来自其他项目，无法移动到当前项目的阶段');
  });

  it('鼠标拖拽丢失自愈事件必须与 dragend 走同一清理路径并在销毁时移除监听', () => {
    const sourcePath = join(process.cwd(), 'src/app/features/text/components/text-view.component.ts');
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).toContain("document.addEventListener('mouseDragLost', this.boundMouseDragLost);");
    expect(source).toContain("document.removeEventListener('mouseDragLost', this.boundMouseDragLost);");
    expect(source).toContain('private handleMouseDragLost(_event: Event) {');
    expect(source).toContain('this.ngZone.run(() => this.onDragEnd());');
  });

  it('drop 成功后目标 stage 不得进入自动收起队列，且 dragend 在 drop 在途时让位', () => {
    const sourcePath = join(process.cwd(), 'src/app/features/text/components/text-view.component.ts');
    const source = readFileSync(sourcePath, 'utf8');

    // drop 的 finally 统一消费拖拽状态，成功时排除目标 stage
    expect(source).toContain('this.stageDropInProgress = true;');
    expect(source).toContain('? mouseExpandedStages.filter(stage => stage !== stageNumber)');
    // dragend 在 drop 在途时不得抢先把目标 stage 排进 rAF 收起队列
    expect(source).toContain('if (this.stageDropInProgress) return;');
  });
});
