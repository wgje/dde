import { describe, expect, it } from 'vitest';
import {
  buildInlineDockTaskDraft,
  clearInlineDockTaskForm,
  shouldClearInlineDockTaskForm,
} from './dock-task-form';

describe('dock-task-form', () => {
  describe('buildInlineDockTaskDraft', () => {
    it('returns null when the advanced UI or inline create gate is closed', () => {
      expect(buildInlineDockTaskDraft({
        showAdvancedUi: false,
        canUseInlineDockCreate: true,
        titleInput: 'Task',
        lane: 'backup',
        load: 'low',
        expectedMinutesInput: '',
        waitMinutesInput: '',
        detailInput: '',
      })).toBeNull();

      expect(buildInlineDockTaskDraft({
        showAdvancedUi: true,
        canUseInlineDockCreate: false,
        titleInput: 'Task',
        lane: 'backup',
        load: 'low',
        expectedMinutesInput: '',
        waitMinutesInput: '',
        detailInput: '',
      })).toBeNull();
    });

    it('returns null for blank titles', () => {
      expect(buildInlineDockTaskDraft({
        showAdvancedUi: true,
        canUseInlineDockCreate: true,
        titleInput: '   ',
        lane: 'backup',
        load: 'low',
        expectedMinutesInput: '',
        waitMinutesInput: '',
        detailInput: '',
      })).toBeNull();
    });

    it('trims text fields and normalizes optional minute fields', () => {
      expect(buildInlineDockTaskDraft({
        showAdvancedUi: true,
        canUseInlineDockCreate: true,
        titleInput: '  Task  ',
        lane: 'combo-select',
        load: 'high',
        expectedMinutesInput: '12.9',
        waitMinutesInput: '0',
        detailInput: '  detail  ',
      })).toEqual({
        title: 'Task',
        lane: 'combo-select',
        load: 'high',
        options: {
          expectedMinutes: 12,
          waitMinutes: null,
          detail: 'detail',
        },
      });
    });
  });

  describe('shouldClearInlineDockTaskForm', () => {
    it('clears the form only after a task was created', () => {
      expect(shouldClearInlineDockTaskForm('task-1')).toBe(true);
      expect(shouldClearInlineDockTaskForm(null)).toBe(false);
      expect(shouldClearInlineDockTaskForm('')).toBe(false);
    });
  });

  describe('clearInlineDockTaskForm', () => {
    it('resets inline task form fields and closes the form', () => {
      const showNewTaskForm = { value: true, set(value: boolean): void { this.value = value; } };
      const form = {
        newTaskTitle: 'Task',
        newTaskExpectedMinutes: 25 as string | number,
        newTaskWaitMinutes: 5 as string | number,
        newTaskDetail: 'detail',
        showNewTaskForm,
      };

      clearInlineDockTaskForm(form);

      expect(form.newTaskTitle).toBe('');
      expect(form.newTaskExpectedMinutes).toBe('');
      expect(form.newTaskWaitMinutes).toBe('');
      expect(form.newTaskDetail).toBe('');
      expect(showNewTaskForm.value).toBe(false);
    });
  });
});
