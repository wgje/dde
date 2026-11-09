import type { CognitiveLoad, DockLane } from '../../../../models/parking-dock';
import { parseOptionalMinutes } from './dock-format';

export interface InlineDockTaskDraftInput {
  showAdvancedUi: boolean;
  canUseInlineDockCreate: boolean;
  titleInput: string;
  lane: DockLane;
  load: CognitiveLoad;
  expectedMinutesInput: string | number;
  waitMinutesInput: string | number;
  detailInput: string;
}

export interface InlineDockTaskDraft {
  title: string;
  lane: DockLane;
  load: CognitiveLoad;
  options: {
    expectedMinutes: number | null;
    waitMinutes: number | null;
    detail: string;
  };
}

export interface InlineDockTaskFormState {
  newTaskTitle: string;
  newTaskExpectedMinutes: string | number;
  newTaskWaitMinutes: string | number;
  newTaskDetail: string;
  showNewTaskForm: {
    set(value: boolean): void;
  };
}

export function buildInlineDockTaskDraft(input: InlineDockTaskDraftInput): InlineDockTaskDraft | null {
  if (!input.showAdvancedUi) return null;
  if (!input.canUseInlineDockCreate) return null;

  const title = input.titleInput.trim();
  if (!title) return null;

  return {
    title,
    lane: input.lane,
    load: input.load,
    options: {
      expectedMinutes: parseOptionalMinutes(input.expectedMinutesInput),
      waitMinutes: parseOptionalMinutes(input.waitMinutesInput),
      detail: input.detailInput.trim(),
    },
  };
}

export function shouldClearInlineDockTaskForm(createdId: string | null): createdId is string {
  return Boolean(createdId);
}

export function clearInlineDockTaskForm(form: InlineDockTaskFormState): void {
  form.newTaskTitle = '';
  form.newTaskExpectedMinutes = '';
  form.newTaskWaitMinutes = '';
  form.newTaskDetail = '';
  form.showNewTaskForm.set(false);
}
