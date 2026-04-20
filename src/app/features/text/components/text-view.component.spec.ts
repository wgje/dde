import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

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

  it('应在 touchcancel 时清理尚未完成的触摸拖拽状态', () => {
    const sourcePath = join(process.cwd(), 'src/app/features/text/components/text-view.component.ts');
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).toContain('onTouchCancel(_event: TouchEvent) {');
    expect(source).toContain('this.cleanupTouchGestureState();');
    expect(source).toContain('if (!this.dragDropService.draggingTaskId() && !this.dragDropService.touchDragTask) return;');
  });

  it('应在 stage dragleave 时继续走 null-stage 自动滚动解析，而不是直接跳最外层', () => {
    const sourcePath = join(process.cwd(), 'src/app/features/text/components/text-view.component.ts');
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).toContain('this.dragDropService.updateAutoScrollContainer(this.ops.resolveAutoScrollContainer(null, event.clientY), event.clientY);');
    expect(source).not.toContain('this.dragDropService.updateAutoScrollContainer(this.ops.getScrollContainer(), event.clientY);');
  });
});
