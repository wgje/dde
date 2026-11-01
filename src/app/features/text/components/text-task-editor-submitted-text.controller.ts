import { signal } from '@angular/core';

export type TextTaskEditorSubmittedField = 'title' | 'content';

interface SubmittedTextValue {
  taskId: string;
  value: string;
}

interface PendingSubmission extends SubmittedTextValue {
  submit: () => Promise<boolean>;
  resolve: (saved: boolean) => void;
}

export class TextTaskEditorSubmittedTextController {
  readonly saveState = signal<'idle' | 'saving' | 'failed'>('idle');

  private readonly lastSubmittedValues = new Map<TextTaskEditorSubmittedField, SubmittedTextValue>();
  private readonly inFlightFields = new Set<TextTaskEditorSubmittedField>();
  private readonly pendingSubmissions = new Map<TextTaskEditorSubmittedField, PendingSubmission>();
  private readonly protectedDrafts = new Map<TextTaskEditorSubmittedField, SubmittedTextValue>();
  private saveSequence = 0;

  reconcile(field: TextTaskEditorSubmittedField, taskId: string, value: string): void {
    const lastSubmitted = this.lastSubmittedValues.get(field);
    if (!lastSubmitted) return;
    if (lastSubmitted.taskId !== taskId || lastSubmitted.value !== value) {
      this.lastSubmittedValues.delete(field);
    }
  }

  async submit(
    field: TextTaskEditorSubmittedField,
    taskId: string,
    value: string,
    submit: () => Promise<boolean>,
  ): Promise<boolean> {
    if (this.inFlightFields.has(field)) {
      return new Promise<boolean>(resolve => {
        this.pendingSubmissions.get(field)?.resolve(false);
        this.pendingSubmissions.set(field, { taskId, value, submit, resolve });
      });
    }

    const lastSubmitted = this.lastSubmittedValues.get(field);
    if (lastSubmitted?.taskId === taskId && lastSubmitted.value === value) {
      return true;
    }

    return this.runSubmission(field, taskId, value, submit);
  }

  startProtectedSubmission(
    field: TextTaskEditorSubmittedField,
    taskId: string,
    value: string,
  ): number {
    this.saveSequence += 1;
    this.protectedDrafts.set(field, { taskId, value });
    this.saveState.set('saving');
    return this.saveSequence;
  }

  finishProtectedSubmission(
    sequence: number,
    saved: boolean,
    field: TextTaskEditorSubmittedField,
    taskId: string,
    value: string,
  ): boolean {
    if (saved) {
      this.clearProtectionIfMatches(field, taskId, value);
    }
    if (sequence !== this.saveSequence) {
      return false;
    }

    this.saveState.set(this.protectedDrafts.size === 0 ? 'idle' : 'failed');
    return true;
  }

  shouldKeepProtectedDraft(
    field: TextTaskEditorSubmittedField,
    taskId: string,
    incomingValue: string,
  ): boolean {
    const protectedDraft = this.protectedDrafts.get(field);
    return !!protectedDraft
      && protectedDraft.taskId === taskId
      && protectedDraft.value !== incomingValue;
  }

  clearSettledProtection(
    field: TextTaskEditorSubmittedField,
    taskId: string,
    value: string,
  ): void {
    const protectedDraft = this.protectedDrafts.get(field);
    if (!protectedDraft) return;
    if (protectedDraft.taskId !== taskId || protectedDraft.value === value) {
      this.protectedDrafts.delete(field);
    }
  }

  clearProtectionIfMatches(
    field: TextTaskEditorSubmittedField,
    taskId: string,
    value: string,
  ): void {
    const protectedDraft = this.protectedDrafts.get(field);
    if (protectedDraft?.taskId === taskId && protectedDraft.value === value) {
      this.protectedDrafts.delete(field);
    }
  }

  clearFailedSaveStateWhenSettled(): void {
    if (this.protectedDrafts.size === 0 && this.saveState() === 'failed') {
      this.saveState.set('idle');
    }
  }

  private async runSubmission(
    field: TextTaskEditorSubmittedField,
    taskId: string,
    value: string,
    submit: () => Promise<boolean>,
  ): Promise<boolean> {
    this.inFlightFields.add(field);
    this.lastSubmittedValues.set(field, { taskId, value });
    let saved = false;
    try {
      saved = await submit();
      if (!saved) {
        this.clearSubmittedValueIfMatches(field, taskId, value);
      }
      return saved;
    } catch (error) {
      this.clearSubmittedValueIfMatches(field, taskId, value);
      throw error;
    } finally {
      this.inFlightFields.delete(field);

      const pending = this.pendingSubmissions.get(field);
      if (pending) {
        this.pendingSubmissions.delete(field);
        if (saved && pending.taskId === taskId && pending.value === value) {
          pending.resolve(true);
        } else {
          void this.runSubmission(field, pending.taskId, pending.value, pending.submit)
            .then(pending.resolve, () => pending.resolve(false));
        }
      }
    }
  }

  private clearSubmittedValueIfMatches(
    field: TextTaskEditorSubmittedField,
    taskId: string,
    value: string,
  ): void {
    const currentSubmitted = this.lastSubmittedValues.get(field);
    if (currentSubmitted?.taskId === taskId && currentSubmitted.value === value) {
      this.lastSubmittedValues.delete(field);
    }
  }
}
