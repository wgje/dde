import type { Task, TaskAttentionDraftItem } from '../../../../models';
import type { ActiveProjectOwner } from '../../../../services/project-state.service';
import { taskAttentionMetaToDraftItems } from '../../../../utils/task-sidecar';
import { buildTextTaskEditorPlannerDraftState } from './text-task-editor.helpers';
import {
  clearTextTaskEditorDraftField,
  readTextTaskEditorDraft,
  writeTextTaskEditorDraftField,
  type TextTaskEditorDraftField,
  type TextTaskEditorDraftRecord,
  type TextTaskEditorDraftScope,
  type TextTaskEditorPlannerDraftField,
  type TextTaskEditorStringDraftField,
} from './text-task-editor-draft-storage';
import {
  TextTaskEditorSubmittedTextController,
  type TextTaskEditorSubmittedField,
} from './text-task-editor-submitted-text.controller';

export type TextTaskEditorDraftOwner = Readonly<ActiveProjectOwner & { taskId: string }>;
type DraftValue = string | TaskAttentionDraftItem[];
type DraftTicket = Readonly<{
  owner: TextTaskEditorDraftOwner;
  scope: TextTaskEditorDraftScope;
  scopeKey: string;
  userGeneration: number;
  submissionKey: string;
}>;
type ProvisionalField = {
  source: DraftTicket;
  bound: DraftTicket | null;
  value: DraftValue;
  revision: number;
};

interface TextTaskEditorDraftPersistenceControllerOptions {
  getTask(): Task;
  getUserId(): string | null;
  captureOwner(taskId: string): TextTaskEditorDraftOwner | null;
  isOwnerCurrent(owner: TextTaskEditorDraftOwner): boolean;
  retireSidecarSaveState(): void;
  startPlannerSave(): void;
  finishPlannerSave(saved: boolean): void;
  startAttentionSave(): number;
  finishAttentionSave(sequence: number, saved: boolean): boolean;
  areAttentionRowsEqual(left: readonly TaskAttentionDraftItem[], right: readonly TaskAttentionDraftItem[]): boolean;
  markForCheck(): void;
}
const DRAFT_FIELDS: readonly TextTaskEditorDraftField[] = ['title', 'content', 'expectedMinutes', 'waitMinutes', 'cognitiveLoad', 'attentionRows'];

export class TextTaskEditorDraftPersistenceController {
  private readonly submittedText = new TextTaskEditorSubmittedTextController();
  readonly textSaveState = this.submittedText.saveState;
  private readonly provisional = new Map<TextTaskEditorDraftField, ProvisionalField>();
  private provisionalRevision = 0;
  private observedUserId: string | null = null;
  private userGeneration = 0;
  constructor(private readonly options: TextTaskEditorDraftPersistenceControllerOptions) {}
  observeUserId(userId: string | null): void {
    if (this.userGeneration > 0 && this.observedUserId === userId) return;
    this.observedUserId = userId;
    this.userGeneration += 1;
    if (this.userGeneration > 1) this.retireSaveState();
  }
  retireCurrentOwner(): void { this.retireSaveState(); }
  readDraft(taskId: string): TextTaskEditorDraftRecord | null {
    const ticket = this.captureTicket(taskId);
    if (!ticket) return null;
    this.clearLegacyOwnerless(ticket);
    if (ticket.scope.userId) this.stampProvisional(ticket);
    const persisted = ticket.scope.userId ? readTextTaskEditorDraft(ticket.scope) : null;
    for (const [field, entry] of this.provisional) {
      if (persisted && entry.bound?.scopeKey === ticket.scopeKey) delete persisted[field];
    }
    return persisted;
  }
  syncTextField(field: TextTaskEditorSubmittedField, taskId: string, value: string, apply: (value: string) => void): void {
    const ticket = this.captureTicket(taskId);
    if (!ticket || this.isCurrentProvisional(ticket, field)
      || this.submittedText.shouldKeepProtectedDraft(field, ticket.submissionKey, value)) return;
    apply(value);
    this.submittedText.reconcile(field, ticket.submissionKey, value);
  }
  shouldKeepSidecarDraft(taskId: string): boolean {
    const ticket = this.captureTicket(taskId);
    return !!ticket && DRAFT_FIELDS.slice(2).some(field => this.isCurrentProvisional(ticket, field));
  }
  settleTextFailures(task: Task): void {
    const ticket = this.captureTicket(task.id);
    if (!ticket) return;
    this.submittedText.clearSettledProtection('title', ticket.submissionKey, task.title || '');
    this.submittedText.clearSettledProtection('content', ticket.submissionKey, task.content || '');
    this.submittedText.clearFailedSaveStateWhenSettled();
  }

  async submitText(
    field: TextTaskEditorSubmittedField,
    taskId: string,
    value: string,
    submit: () => Promise<boolean>,
  ): Promise<boolean> {
    const ticket = this.captureTicket(taskId);
    if (!ticket) return false;
    const currentTask = this.options.getTask();
    const currentValue = field === 'title' ? currentTask.title ?? '' : currentTask.content ?? '';
    this.persistField(ticket, field, value, currentValue);
    if (!ticket.scope.userId || !this.isCurrent(ticket)) return false;
    const sequence = this.submittedText.startProtectedSubmission(field, ticket.submissionKey, value);
    try {
      const saved = await this.submittedText.submit(field, ticket.submissionKey, value, async () => {
        if (!this.isCurrent(ticket)) return false;
        const result = await submit();
        return this.isCurrent(ticket) && result;
      });
      if (!this.isCurrent(ticket)) return false;
      if (saved) this.clearFieldIfMatches(ticket, field, value);
      if (!this.isCurrent(ticket)) return false;
      if (this.submittedText.finishProtectedSubmission(sequence, saved, field, ticket.submissionKey, value)) {
        if (this.isCurrent(ticket)) this.options.markForCheck();
      }
      return saved;
    } catch {
      if (!this.isCurrent(ticket)) return false;
      if (this.submittedText.finishProtectedSubmission(sequence, false, field, ticket.submissionKey, value)) {
        if (this.isCurrent(ticket)) this.options.markForCheck();
      }
      return false;
    }
  }

  submitPlanner(field: TextTaskEditorPlannerDraftField, taskId: string, value: string,
    submit: () => Promise<boolean>): Promise<boolean> {
    return this.submitSidecar(
      field, taskId, value, buildTextTaskEditorPlannerDraftState(this.options.getTask())[field], submit, 'planner',
    );
  }

  submitAttention(taskId: string, rows: TaskAttentionDraftItem[],
    submit: () => Promise<boolean>): Promise<boolean> {
    return this.submitSidecar(
      'attentionRows', taskId, rows, taskAttentionMetaToDraftItems(this.options.getTask().attentionMeta), submit, 'attention',
    );
  }

  private async submitSidecar(
    field: TextTaskEditorPlannerDraftField | 'attentionRows',
    taskId: string,
    value: DraftValue,
    currentValue: DraftValue,
    submit: () => Promise<boolean>,
    kind: 'planner' | 'attention',
  ): Promise<boolean> {
    const ticket = this.captureTicket(taskId);
    if (!ticket) return false;
    this.persistField(ticket, field, value, currentValue);
    if (!ticket.scope.userId || !this.isCurrent(ticket)) return false;
    const sequence = kind === 'attention' ? this.options.startAttentionSave() : 0;
    if (kind === 'planner') this.options.startPlannerSave();
    let saved = false;
    try {
      if (!this.isCurrent(ticket)) return false;
      saved = await submit();
    } catch {
      saved = false;
    }
    if (!this.isCurrent(ticket)) return false;
    if (saved) this.clearFieldIfMatches(ticket, field, value);
    if (!this.isCurrent(ticket)) return false;
    const publish = kind === 'attention'
      ? this.options.finishAttentionSave(sequence, saved)
      : (this.options.finishPlannerSave(saved), true);
    if (publish && this.isCurrent(ticket)) this.options.markForCheck();
    return saved;
  }

  private captureTicket(taskId: string): DraftTicket | null {
    if (this.userGeneration === 0 || this.options.getUserId() !== this.observedUserId) return null;
    const owner = this.options.captureOwner(taskId);
    if (!owner) return null;
    const scope = { userId: this.observedUserId, projectId: owner.projectId, taskId };
    return Object.freeze({
      owner, scope, scopeKey: JSON.stringify([scope.userId, owner.projectId, taskId]), userGeneration: this.userGeneration,
      submissionKey: JSON.stringify([scope.userId, this.userGeneration, owner.projectId, owner.generation, taskId]),
    });
  }

  private isCurrent(ticket: DraftTicket): boolean {
    return this.userGeneration > 0
      && ticket.userGeneration === this.userGeneration
      && ticket.scope.userId === this.observedUserId
      && this.options.getUserId() === ticket.scope.userId
      && this.options.getTask().id === ticket.scope.taskId
      && this.options.isOwnerCurrent(ticket.owner);
  }
  private isCurrentProvisional(ticket: DraftTicket, field: TextTaskEditorDraftField): boolean {
    return (this.provisional.get(field)?.bound ?? this.provisional.get(field)?.source)?.submissionKey
      === ticket.submissionKey;
  }

  private retireSaveState(): void {
    this.submittedText.saveState.set('idle');
    this.options.retireSidecarSaveState();
  }
  private persistField(ticket: DraftTicket, field: TextTaskEditorDraftField, value: DraftValue, current: DraftValue): void {
    if (!this.isCurrent(ticket)) return;
    const retained = this.provisional.get(field);
    if (retained?.bound?.scopeKey === ticket.scopeKey) {
      const latest = this.replaceProvisional(field, retained.source, ticket, value);
      this.confirmProvisional(ticket, field, latest);
      return;
    }
    if (this.valuesEqual(field, value, current)) {
      this.clearFieldIfMatches(ticket, field, value);
      return;
    }
    if (!ticket.scope.userId) {
      this.replaceProvisional(field, ticket, null, value);
      return;
    }
    this.writeAndConfirm(ticket, field, value);
  }

  private clearFieldIfMatches(ticket: DraftTicket, field: TextTaskEditorDraftField, value: DraftValue): void {
    if (!this.isCurrent(ticket)) return;
    const provisional = this.provisional.get(field);
    if (provisional?.bound?.scopeKey === ticket.scopeKey) return;
    if (provisional && (provisional.bound ?? provisional.source).submissionKey === ticket.submissionKey
      && this.valuesEqual(field, provisional.value, value)) this.provisional.delete(field);
    if (!ticket.scope.userId) return;
    const draft = readTextTaskEditorDraft(ticket.scope);
    if (draft?.[field] !== undefined && this.valuesEqual(field, draft[field] as DraftValue, value)
      && this.isCurrent(ticket)) clearTextTaskEditorDraftField(ticket.scope, field);
  }

  private clearLegacyOwnerless(ticket: DraftTicket): void {
    const scope = { ...ticket.scope, userId: null };
    const legacy = readTextTaskEditorDraft(scope);
    if (!legacy) return;
    for (const field of DRAFT_FIELDS) {
      if (!this.isCurrent(ticket)) return;
      if (legacy[field] !== undefined) clearTextTaskEditorDraftField(scope, field);
    }
  }

  private stampProvisional(ticket: DraftTicket): void {
    for (const [field, entry] of this.provisional) {
      let candidate = entry;
      if (!entry.bound && entry.source.scope.userId === null
        && entry.source.userGeneration + 1 === ticket.userGeneration
        && entry.source.owner.projectId === ticket.owner.projectId
        && entry.source.owner.generation === ticket.owner.generation
        && entry.source.owner.taskId === ticket.owner.taskId) {
        candidate = { ...entry, bound: ticket };
        this.provisional.set(field, candidate);
      }
      if (!candidate.bound || candidate.bound.submissionKey !== ticket.submissionKey
        || !this.isCurrent(ticket)) continue;
      this.confirmProvisional(ticket, field, candidate);
    }
  }

  private replaceProvisional(
    field: TextTaskEditorDraftField,
    source: DraftTicket,
    bound: DraftTicket | null,
    value: DraftValue,
  ): ProvisionalField {
    const draftValue = Array.isArray(value) ? value.map(row => ({ ...row })) : value;
    const entry = { source, bound, value: draftValue, revision: ++this.provisionalRevision };
    this.provisional.set(field, entry);
    return entry;
  }

  private confirmProvisional(
    ticket: DraftTicket,
    field: TextTaskEditorDraftField,
    entry: ProvisionalField,
  ): void {
    if (!this.writeAndConfirm(ticket, field, entry.value)) return;
    const latest = this.provisional.get(field);
    if (latest === entry && latest.revision === entry.revision
      && this.valuesEqual(field, latest.value, entry.value)) this.provisional.delete(field);
  }

  private writeAndConfirm(ticket: DraftTicket, field: TextTaskEditorDraftField, value: DraftValue): boolean {
    if (!this.isCurrent(ticket)) return false;
    if (field === 'attentionRows') writeTextTaskEditorDraftField(ticket.scope, field, value as TaskAttentionDraftItem[]);
    else writeTextTaskEditorDraftField(ticket.scope, field as TextTaskEditorStringDraftField, value as string);
    const readback = readTextTaskEditorDraft(ticket.scope);
    return this.isCurrent(ticket) && readback?.[field] !== undefined
      && this.valuesEqual(field, readback[field] as DraftValue, value);
  }
  private valuesEqual(field: TextTaskEditorDraftField, left: DraftValue, right: DraftValue): boolean {
    return field === 'attentionRows'
      ? this.options.areAttentionRowsEqual(left as TaskAttentionDraftItem[], right as TaskAttentionDraftItem[])
      : left === right;
  }
}
