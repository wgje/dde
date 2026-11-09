import { describe, expect, it } from 'vitest';

import {
  computeTaskDetailAutoDrawerHeightVh,
  computeTaskDetailDragState,
  computeTaskDetailDragPosition,
  computeTaskDetailDrawerResizeHeightVh,
  measureTaskDetailIntrinsicContentHeight,
  resolveTaskDetailContentMaxHeightClass,
  resolveTaskDetailMobileDrawerElements,
  shouldEmitTaskDetailDrawerHeight,
} from './flow-task-detail-layout.helpers';

describe('flow-task-detail-layout.helpers', () => {
  it('从 ViewChild 或 host fallback 解析移动抽屉元素', () => {
    const host = document.createElement('div');
    host.innerHTML = `
      <section class="absolute left-0 right-0 z-30">
        <header class="flex-shrink-0"></header>
        <main class="overflow-y-auto"></main>
        <button class="touch-none flex-shrink-0"></button>
      </section>
    `;

    const elements = resolveTaskDetailMobileDrawerElements({ host });

    expect(elements?.container).toBe(host.querySelector('.absolute.left-0.right-0.z-30'));
    expect(elements?.title).toBe(host.querySelector('header'));
    expect(elements?.content).toBe(host.querySelector('main'));
    expect(elements?.handle).toBe(host.querySelector('button'));
  });

  it('缺少移动抽屉必要元素时返回 null', () => {
    const host = document.createElement('div');
    host.innerHTML = '<section class="absolute left-0 right-0 z-30"></section>';

    expect(resolveTaskDetailMobileDrawerElements({ host })).toBeNull();
  });

  it('测量内容区子元素固有高度、padding 与 margin', () => {
    const content = document.createElement('div');
    content.style.paddingTop = '2px';
    content.style.paddingBottom = '3px';

    const child = document.createElement('div');
    child.style.marginTop = '4px';
    child.style.marginBottom = '6px';
    Object.defineProperty(child, 'getBoundingClientRect', {
      value: () => ({ height: 50 }),
    });
    content.appendChild(child);
    document.body.appendChild(content);

    try {
      expect(measureTaskDetailIntrinsicContentHeight(content)).toBe(65);
    } finally {
      content.remove();
    }
  });

  it('根据抽屉高度选择内容最大高度 class', () => {
    expect(resolveTaskDetailContentMaxHeightClass(8)).toBe('max-h-8');
    expect(resolveTaskDetailContentMaxHeightClass(15)).toBe('max-h-16');
    expect(resolveTaskDetailContentMaxHeightClass(25)).toBe('max-h-24');
    expect(resolveTaskDetailContentMaxHeightClass(35)).toBe('max-h-28');
  });

  it('计算移动抽屉自动高度并限制在最小/最大 vh 内', () => {
    expect(computeTaskDetailAutoDrawerHeightVh({
      titleHeight: 48,
      handleHeight: 24,
      intrinsicContentHeight: 300,
      viewportHeight: 800,
      guardPx: 4,
      minVh: 8,
      maxVh: 70,
    })).toBeCloseTo(47, 5);

    expect(computeTaskDetailAutoDrawerHeightVh({
      titleHeight: 20,
      handleHeight: 10,
      intrinsicContentHeight: 0,
      viewportHeight: 1000,
      guardPx: 4,
      minVh: 8,
      maxVh: 70,
    })).toBe(8);

    expect(computeTaskDetailAutoDrawerHeightVh({
      titleHeight: 100,
      handleHeight: 40,
      intrinsicContentHeight: 2000,
      viewportHeight: 1000,
      guardPx: 4,
      minVh: 8,
      maxVh: 70,
    })).toBe(70);
  });

  it('viewport 不可测时自动高度返回 null', () => {
    expect(computeTaskDetailAutoDrawerHeightVh({
      titleHeight: 20,
      handleHeight: 10,
      intrinsicContentHeight: 100,
      viewportHeight: 0,
      guardPx: 4,
      minVh: 8,
      maxVh: 70,
    })).toBeNull();
  });

  it('按 epsilon 判断是否需要发射抽屉高度变化', () => {
    expect(shouldEmitTaskDetailDrawerHeight(35, 35.2, 0.3)).toBe(false);
    expect(shouldEmitTaskDetailDrawerHeight(35, 35.31, 0.3)).toBe(true);
  });

  it('计算拖拽调整后的抽屉高度并 clamp 到边界', () => {
    expect(computeTaskDetailDrawerResizeHeightVh({
      currentY: 500,
      startY: 300,
      startHeight: 35,
      viewportHeight: 1000,
      minVh: 8,
      maxVh: 70,
    })).toBe(55);

    expect(computeTaskDetailDrawerResizeHeightVh({
      currentY: -1000,
      startY: 300,
      startHeight: 35,
      viewportHeight: 1000,
      minVh: 8,
      maxVh: 70,
    })).toBe(8);

    expect(computeTaskDetailDrawerResizeHeightVh({
      currentY: 2000,
      startY: 300,
      startHeight: 35,
      viewportHeight: 1000,
      minVh: 8,
      maxVh: 70,
    })).toBe(70);
  });

  it('计算桌面详情面板拖动位置并限制在视口内', () => {
    expect(computeTaskDetailDragPosition({
      startClientX: 100,
      startClientY: 120,
      currentClientX: 210,
      currentClientY: 20,
      offsetX: 40,
      offsetY: 80,
      viewportWidth: 320,
      viewportHeight: 420,
      panelWidth: 256,
      panelHeight: 384,
      marginPx: 20,
    })).toEqual({ x: 44, y: 0 });

    expect(computeTaskDetailDragPosition({
      startClientX: 100,
      startClientY: 100,
      currentClientX: -100,
      currentClientY: -100,
      offsetX: 10,
      offsetY: 10,
      viewportWidth: 200,
      viewportHeight: 200,
      panelWidth: 256,
      panelHeight: 384,
      marginPx: 20,
    })).toEqual({ x: 0, y: 0 });
  });

  it('根据面板与父容器矩形计算拖动初始状态', () => {
    expect(computeTaskDetailDragState({
      clientX: 210,
      clientY: 320,
      panelRect: { left: 140, top: 200 },
      parentRect: { left: 20, top: 40 },
    })).toEqual({
      startX: 210,
      startY: 320,
      offsetX: 120,
      offsetY: 160,
    });
  });
});
