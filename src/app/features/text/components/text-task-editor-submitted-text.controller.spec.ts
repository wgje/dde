import { describe, expect, it, vi } from 'vitest';

import { TextTaskEditorSubmittedTextController } from './text-task-editor-submitted-text.controller';

describe('TextTaskEditorSubmittedTextController', () => {
  it('deduplicates repeated submissions for the same task field and value', () => {
    const controller = new TextTaskEditorSubmittedTextController();
    const submit = vi.fn(() => Promise.resolve(true));

    controller.submit('title', 'task-1', 'Draft', submit);
    controller.submit('title', 'task-1', 'Draft', submit);

    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('allows submission again after the submitted value is reconciled to a different task value', async () => {
    const controller = new TextTaskEditorSubmittedTextController();
    const submit = vi.fn(() => Promise.resolve(true));

    await controller.submit('content', 'task-1', 'Draft', submit);
    controller.reconcile('content', 'task-1', 'Remote');
    await controller.submit('content', 'task-1', 'Draft', submit);

    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('allows retrying the same value when durable local submission fails', async () => {
    const controller = new TextTaskEditorSubmittedTextController();
    const submit = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await controller.submit('content', 'task-1', 'Draft', submit);
    await controller.submit('content', 'task-1', 'Draft', submit);

    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('does not let an older failed submission clear a newer submitted value', async () => {
    const controller = new TextTaskEditorSubmittedTextController();
    let resolveOld!: (saved: boolean) => void;
    const oldSubmit = vi.fn(() => new Promise<boolean>(resolve => {
      resolveOld = resolve;
    }));
    const newSubmit = vi.fn().mockResolvedValue(true);

    const oldResult = controller.submit('content', 'task-1', 'Old draft', oldSubmit);
    const newResult = controller.submit('content', 'task-1', 'New draft', newSubmit);

    expect(newSubmit).not.toHaveBeenCalled();
    resolveOld(false);
    await oldResult;
    await newResult;

    await controller.submit('content', 'task-1', 'New draft', newSubmit);

    expect(newSubmit).toHaveBeenCalledTimes(1);
  });

  it('queues the latest value for a field while another submission is in flight', async () => {
    const controller = new TextTaskEditorSubmittedTextController();
    let resolveFirst!: (saved: boolean) => void;
    const submitFirst = vi.fn(() => new Promise<boolean>(resolve => {
      resolveFirst = resolve;
    }));
    const submitLatest = vi.fn().mockResolvedValue(true);

    const firstResult = controller.submit('title', 'task-1', 'A', submitFirst);
    const latestResult = controller.submit('title', 'task-1', 'AB', submitLatest);

    expect(submitLatest).not.toHaveBeenCalled();

    resolveFirst(true);
    await firstResult;
    await latestResult;

    expect(submitFirst).toHaveBeenCalledTimes(1);
    expect(submitLatest).toHaveBeenCalledTimes(1);
  });

  it('resolves superseded pending submissions when a newer value replaces them', async () => {
    const controller = new TextTaskEditorSubmittedTextController();
    let resolveFirst!: (saved: boolean) => void;
    const submitFirst = vi.fn(() => new Promise<boolean>(resolve => {
      resolveFirst = resolve;
    }));
    const submitSuperseded = vi.fn().mockResolvedValue(true);
    const submitLatest = vi.fn().mockResolvedValue(true);

    const firstResult = controller.submit('content', 'task-1', 'A', submitFirst);
    const supersededResult = controller.submit('content', 'task-1', 'AB', submitSuperseded);
    const latestResult = controller.submit('content', 'task-1', 'ABC', submitLatest);

    const supersededSettled = vi.fn();
    void supersededResult.then(supersededSettled);

    await vi.waitFor(() => {
      expect(supersededSettled).toHaveBeenCalledWith(false);
    });
    expect(submitSuperseded).not.toHaveBeenCalled();
    expect(submitLatest).not.toHaveBeenCalled();

    resolveFirst(true);
    await firstResult;
    await latestResult;

    expect(submitFirst).toHaveBeenCalledTimes(1);
    expect(submitSuperseded).not.toHaveBeenCalled();
    expect(submitLatest).toHaveBeenCalledTimes(1);
  });

  it('protects submitted drafts until the same value is saved or hydrated', () => {
    const controller = new TextTaskEditorSubmittedTextController();
    const sequence = controller.startProtectedSubmission('title', 'task-1', 'Draft');

    expect(controller.saveState()).toBe('saving');
    expect(controller.shouldKeepProtectedDraft('title', 'task-1', 'Remote')).toBe(true);

    controller.clearSettledProtection('title', 'task-1', 'Draft');

    expect(controller.shouldKeepProtectedDraft('title', 'task-1', 'Remote')).toBe(false);
    expect(controller.finishProtectedSubmission(sequence, true, 'title', 'task-1', 'Draft')).toBe(true);
    expect(controller.saveState()).toBe('idle');
  });

  it('keeps older text save results from overwriting newer save state', () => {
    const controller = new TextTaskEditorSubmittedTextController();
    const first = controller.startProtectedSubmission('content', 'task-1', 'Old');
    const second = controller.startProtectedSubmission('content', 'task-1', 'New');

    expect(controller.finishProtectedSubmission(second, true, 'content', 'task-1', 'New')).toBe(true);
    expect(controller.saveState()).toBe('idle');
    expect(controller.finishProtectedSubmission(first, false, 'content', 'task-1', 'Old')).toBe(false);
    expect(controller.saveState()).toBe('idle');
  });
});
