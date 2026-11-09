import { describe, expect, it } from 'vitest';

import type { TextViewTaskOpsService } from './text-view-task-ops.service';

export interface TextViewTaskOpsAutoScrollSpecContext {
  service(): TextViewTaskOpsService;
  outerScrollContainer(): HTMLElement;
  stageScrollContainer(): HTMLElement;
  stageTaskList(): HTMLElement;
}

function defineElementMetric(
  element: HTMLElement,
  property: 'clientHeight' | 'scrollHeight',
  value: number,
): void {
  Object.defineProperty(element, property, {
    configurable: true,
    value,
  });
}

function setStageTaskListScrollSize(
  stageTaskList: HTMLElement,
  clientHeight: number,
  scrollHeight: number,
): void {
  defineElementMetric(stageTaskList, 'clientHeight', clientHeight);
  defineElementMetric(stageTaskList, 'scrollHeight', scrollHeight);
}

function setStageScrollContainerSize(
  stageScrollContainer: HTMLElement,
  clientHeight: number,
  scrollHeight: number,
): void {
  defineElementMetric(stageScrollContainer, 'clientHeight', clientHeight);
  defineElementMetric(stageScrollContainer, 'scrollHeight', scrollHeight);
}

export function registerTextViewTaskOpsAutoScrollSpecs(
  context: TextViewTaskOpsAutoScrollSpecContext,
): void {
  describe('auto-scroll container resolution', () => {
    it('should prefer the stage task list when that list can scroll', () => {
      const stageTaskList = context.stageTaskList();
      setStageTaskListScrollSize(stageTaskList, 180, 540);

      expect(context.service().resolveAutoScrollContainer(1)).toBe(stageTaskList);
    });

    it('should fall back to the stage list container when the task list cannot scroll', () => {
      const stageTaskList = context.stageTaskList();
      const stageScrollContainer = context.stageScrollContainer();
      setStageTaskListScrollSize(stageTaskList, 180, 180);

      expect(context.service().resolveAutoScrollContainer(1)).toBe(stageScrollContainer);
      expect(context.service().resolveAutoScrollContainer(null)).toBe(stageScrollContainer);
    });

    it('should fall back to the outer text view container when neither task list nor stage list can scroll', () => {
      const stageTaskList = context.stageTaskList();
      const stageScrollContainer = context.stageScrollContainer();
      const outerScrollContainer = context.outerScrollContainer();
      setStageTaskListScrollSize(stageTaskList, 180, 180);
      setStageScrollContainerSize(stageScrollContainer, 320, 320);

      expect(context.service().resolveAutoScrollContainer(1)).toBe(outerScrollContainer);
      expect(context.service().resolveAutoScrollContainer(null)).toBe(outerScrollContainer);
    });

    it('should keep the outer text view container when pointer is outside the stage list edge zones', () => {
      const stageTaskList = context.stageTaskList();
      setStageTaskListScrollSize(stageTaskList, 180, 180);

      expect(context.service().resolveAutoScrollContainer(null, 250))
        .toBe(context.outerScrollContainer());
    });

    it('should use the stage list when pointer enters its edge zone without an active stage task list', () => {
      const stageTaskList = context.stageTaskList();
      setStageTaskListScrollSize(stageTaskList, 180, 180);

      expect(context.service().resolveAutoScrollContainer(null, 360))
        .toBe(context.stageScrollContainer());
    });

    it('should fall back to the outer text view when the null-stage pointer is in the stage edge zone but the stage list is exhausted', () => {
      const stageTaskList = context.stageTaskList();
      const stageScrollContainer = context.stageScrollContainer();
      setStageTaskListScrollSize(stageTaskList, 180, 180);
      stageScrollContainer.scrollTop = 400;

      expect(context.service().resolveAutoScrollContainer(null, 360))
        .toBe(context.outerScrollContainer());
    });

    it('should fall back to the stage list when the task list is already at the bottom edge', () => {
      const stageTaskList = context.stageTaskList();
      setStageTaskListScrollSize(stageTaskList, 180, 540);
      stageTaskList.scrollTop = 360;

      expect(context.service().resolveAutoScrollContainer(1, 270))
        .toBe(context.stageScrollContainer());
    });

    it('should keep the stage list as the auto-scroll container while it can still scroll downward', () => {
      const stageTaskList = context.stageTaskList();
      setStageTaskListScrollSize(stageTaskList, 180, 540);
      stageTaskList.scrollTop = 120;

      expect(context.service().resolveAutoScrollContainer(1, 270)).toBe(stageTaskList);
    });

    it('should fall back to the stage list when the task list is already at the top edge', () => {
      const stageTaskList = context.stageTaskList();
      const stageScrollContainer = context.stageScrollContainer();
      setStageTaskListScrollSize(stageTaskList, 180, 540);
      stageTaskList.scrollTop = 0;
      stageScrollContainer.scrollTop = 120;

      expect(context.service().resolveAutoScrollContainer(1, 110)).toBe(stageScrollContainer);
    });

    it('should fall back to the outer text view container when task list and stage list are both already at the bottom edge', () => {
      const stageTaskList = context.stageTaskList();
      const stageScrollContainer = context.stageScrollContainer();
      setStageTaskListScrollSize(stageTaskList, 180, 540);
      setStageScrollContainerSize(stageScrollContainer, 320, 720);
      stageTaskList.scrollTop = 360;
      stageScrollContainer.scrollTop = 400;

      expect(context.service().resolveAutoScrollContainer(1, 270))
        .toBe(context.outerScrollContainer());
    });
  });
}
