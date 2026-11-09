import { describe, expect, it, vi } from 'vitest';

import {
  FlowMinimapAttentionController,
  projectMinimapAttentionPoint,
} from './flow-minimap-attention.controller';
import type { MinimapFrameHandle } from './flow-minimap-geometry';

function createSchedulerHarness() {
  const frames = new Map<number, FrameRequestCallback>();
  const timers = new Map<number, () => void>();
  const frameCallbacks = new Map<number, FrameRequestCallback>();
  const timerCallbacks = new Map<number, () => void>();
  let nextFrameId = 1;
  let nextTimerId = 1;

  return {
    frames,
    timers,
    requestFrame: (callback: FrameRequestCallback): MinimapFrameHandle => {
      const id = nextFrameId++;
      frames.set(id, callback);
      frameCallbacks.set(id, callback);
      return { id, kind: 'raf' };
    },
    cancelFrame: (handle: MinimapFrameHandle): void => {
      frames.delete(handle.id);
    },
    scheduleTimer: (callback: () => void, delay: number): ReturnType<typeof setTimeout> => {
      expect(delay).toBe(240);
      const id = nextTimerId++;
      timers.set(id, callback);
      timerCallbacks.set(id, callback);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (handle: ReturnType<typeof setTimeout>): void => {
      timers.delete(handle as unknown as number);
    },
    flushFrame(): void {
      const entry = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
      if (!entry) return;
      frames.delete(entry[0]);
      entry[1](0);
    },
    flushTimer(): void {
      const entry = timers.entries().next().value as [number, () => void] | undefined;
      if (!entry) return;
      timers.delete(entry[0]);
      entry[1]();
    },
    invokeFrame(id: number): void {
      frameCallbacks.get(id)?.(0);
    },
    invokeTimer(id: number): void {
      timerCallbacks.get(id)?.();
    },
  };
}

describe('projectMinimapAttentionPoint', () => {
  it('将 client 坐标换算为 0..1 镜头坐标并钳制越界值', () => {
    const rect = { left: 10, top: 20, width: 100, height: 80 };

    expect(projectMinimapAttentionPoint(60, 40, rect)).toEqual({ x: 0.5, y: 0.25 });
    expect(projectMinimapAttentionPoint(-30, 200, rect)).toEqual({ x: 0, y: 1 });
  });

  it('无有效尺寸时返回 null', () => {
    expect(projectMinimapAttentionPoint(10, 10, { left: 0, top: 0, width: 0, height: 80 })).toBeNull();
  });
});

describe('FlowMinimapAttentionController', () => {
  it('有效交互持续 240ms 后才同时显示镜头与图例，离开后收起', () => {
    const scheduler = createSchedulerHarness();
    const setActive = vi.fn();
    const setLegendVisible = vi.fn();
    const controller = new FlowMinimapAttentionController({
      ...scheduler,
      setLens: vi.fn(),
      setActive,
      setLegendVisible,
    });

    controller.pointerEntered();
    expect(setActive).not.toHaveBeenCalledWith(true);
    expect(setLegendVisible).not.toHaveBeenCalledWith(true);

    scheduler.flushTimer();
    expect(setActive).toHaveBeenLastCalledWith(true);
    expect(setLegendVisible).toHaveBeenLastCalledWith(true);

    controller.pointerLeft();
    expect(setActive).toHaveBeenLastCalledWith(false);
    expect(setLegendVisible).toHaveBeenLastCalledWith(false);
  });

  it('120 次同帧 pointermove 最多提交一次镜头状态', () => {
    const scheduler = createSchedulerHarness();
    const setLens = vi.fn();
    const controller = new FlowMinimapAttentionController({
      ...scheduler,
      setLens,
      setActive: vi.fn(),
      setLegendVisible: vi.fn(),
    });

    controller.pointerEntered();
    for (let index = 0; index < 120; index += 1) {
      controller.pointerMoved({ x: index / 119, y: 0.75 });
    }

    expect(setLens).not.toHaveBeenCalled();
    expect(scheduler.frames.size).toBe(1);

    scheduler.flushFrame();
    expect(setLens).toHaveBeenCalledTimes(1);
    expect(setLens).toHaveBeenLastCalledWith({ x: 1, y: 0.75 });
  });

  it('旧激活 timer 晚到时不得提前打开新一轮图例或清除新 timer 所有权', () => {
    const scheduler = createSchedulerHarness();
    const setLegendVisible = vi.fn();
    const controller = new FlowMinimapAttentionController({
      ...scheduler,
      setLens: vi.fn(),
      setActive: vi.fn(),
      setLegendVisible,
    });

    controller.pointerEntered();
    controller.pointerLeft();
    controller.pointerEntered();
    expect(scheduler.timers.has(2)).toBe(true);

    scheduler.invokeTimer(1);

    expect(setLegendVisible).not.toHaveBeenCalledWith(true);
    expect(scheduler.timers.has(2)).toBe(true);
    scheduler.invokeTimer(2);
    expect(setLegendVisible).toHaveBeenLastCalledWith(true);
  });

  it('旧镜头 RAF 晚到时不得清除新 RAF 或消费新一轮 pending lens', () => {
    const scheduler = createSchedulerHarness();
    const setLens = vi.fn();
    const controller = new FlowMinimapAttentionController({
      ...scheduler,
      setLens,
      setActive: vi.fn(),
      setLegendVisible: vi.fn(),
    });

    controller.pointerEntered();
    controller.pointerMoved({ x: 0.1, y: 0.2 });
    controller.pointerLeft();
    setLens.mockClear();
    controller.pointerEntered();
    controller.pointerMoved({ x: 0.8, y: 0.9 });
    expect(scheduler.frames.has(2)).toBe(true);

    scheduler.invokeFrame(1);

    expect(setLens).not.toHaveBeenCalled();
    expect(scheduler.frames.has(2)).toBe(true);
    scheduler.invokeFrame(2);
    expect(setLens).toHaveBeenLastCalledWith({ x: 0.8, y: 0.9 });
  });

  it('键盘等非指针交互更新镜头后，失焦会收起全部注意力状态', () => {
    const scheduler = createSchedulerHarness();
    const setLens = vi.fn();
    const setActive = vi.fn();
    const setLegendVisible = vi.fn();
    const controller = new FlowMinimapAttentionController({
      ...scheduler,
      setLens,
      setActive,
      setLegendVisible,
    });

    controller.focused();
    scheduler.flushTimer();
    expect(setLegendVisible).toHaveBeenLastCalledWith(true);
    controller.interacted({ x: 0.5, y: 0.5 });
    scheduler.flushFrame();
    expect(setLens).toHaveBeenLastCalledWith({ x: 0.5, y: 0.5 });

    controller.blurred();

    expect(setActive).toHaveBeenLastCalledWith(false);
    expect(setLegendVisible).toHaveBeenLastCalledWith(false);
    expect(setLens).toHaveBeenLastCalledWith(null);
  });

  it('筛选固定图例时离开不收起，解除固定后恢复静止态', () => {
    const scheduler = createSchedulerHarness();
    const setActive = vi.fn();
    const setLegendVisible = vi.fn();
    const controller = new FlowMinimapAttentionController({
      ...scheduler,
      setLens: vi.fn(),
      setActive,
      setLegendVisible,
    });

    controller.setLegendPinned(true);
    controller.pointerLeft();
    expect(setLegendVisible).toHaveBeenLastCalledWith(true);

    controller.setLegendPinned(false);
    expect(setActive).toHaveBeenLastCalledWith(false);
    expect(setLegendVisible).toHaveBeenLastCalledWith(false);
  });

  it('销毁会取消 RAF 与计时器，晚到回调不得写状态', () => {
    const scheduler = createSchedulerHarness();
    const setLens = vi.fn();
    const setLegendVisible = vi.fn();
    const controller = new FlowMinimapAttentionController({
      ...scheduler,
      setLens,
      setActive: vi.fn(),
      setLegendVisible,
    });

    controller.pointerEntered();
    controller.pointerMoved({ x: 0.25, y: 0.5 });
    controller.destroy();

    expect(scheduler.frames.size).toBe(0);
    expect(scheduler.timers.size).toBe(0);
    scheduler.flushFrame();
    scheduler.flushTimer();
    expect(setLens).not.toHaveBeenCalled();
    expect(setLegendVisible).not.toHaveBeenCalledWith(true);
  });
});
