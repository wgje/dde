import { Injectable, computed, signal } from '@angular/core';
import type { BlackBoxEntry, Project, Task } from '../../models';
import type { StatusMachineEntry, DailySlotEntry, DockEntry } from '../../models/parking-dock';

/** Per-preview state. No storage, auth, timers, HTTP, or root stores. */
@Injectable()
export class DemoPreviewMemoryService {
  readonly projectId = crypto.randomUUID();
  readonly owner = { projectId: this.projectId, generation: 1 };
  readonly tasks = signal<Task[]>([this.task('待恢复的演示任务', 'active', true), this.task('已归档的演示任务', 'archived')]);
  readonly deletedTasks = computed(() => this.tasks().filter(task => !!task.deletedAt));
  readonly activeProject = computed<Project>(() => ({ id: this.projectId, name: '恢复示例', description: '只操作当前预览的虚拟任务', createdDate: '2026-01-01T12:00:00.000Z', tasks: this.tasks(), connections: [] }));
  readonly toastMessage = signal('');
  readonly tick = signal(0);
  readonly muteWaitTone = signal(false);
  readonly isBurnoutActive = signal(false);
  readonly restReminderActive = signal(false);
  readonly fragmentDefenseLevel = signal(0);
  readonly cumulativeHighLoadMs = signal(25 * 60 * 1000);
  readonly cumulativeLowLoadMs = signal(15 * 60 * 1000);
  readonly blankPeriodActive = signal(false);
  readonly statusMachineEntries = signal<StatusMachineEntry[]>([
    this.status('正在写方案', 'focusing', '专注中'),
    this.status('等待编译结束', 'suspended_waiting', '挂起等待', 120, 300),
    this.status('等待下一步', 'queued', '待启动'),
    this.status('已等待完成', 'waiting_done', '等待结束', 0, 300),
    this.status('需要重新安排', 'stalled', '停滞中'),
  ]);
  readonly isReadOnlyFollower = signal(false);
  readonly tier = signal<'T0'>('T0');
  readonly availableDailySlots = signal<DailySlotEntry[]>([]);
  readonly suspendedEntries = signal<DockEntry[]>([]);
  readonly availableFragmentDockTasks = signal<DockEntry[]>([]);
  readonly dailySlotService = {
    addDailySlot: async (title: string, maxCount: number): Promise<string> => {
      const id = crypto.randomUUID();
      this.availableDailySlots.update(slots => [...slots, { id, title, maxDailyCount: Math.max(1, maxCount), todayCompletedCount: 0, isEnabled: true, createdAt: new Date().toISOString() }]);
      return id;
    },
    completeDailySlot: async (id: string): Promise<boolean> => {
      this.availableDailySlots.update(slots => slots.map(slot => slot.id === id ? { ...slot, todayCompletedCount: Math.min(slot.maxDailyCount, slot.todayCompletedCount + 1) } : slot));
      return true;
    },
    removeDailySlot: async (id: string): Promise<boolean> => {
      this.availableDailySlots.update(slots => slots.filter(slot => slot.id !== id)); return true;
    },
  };
  snapshot() {
    return { tasks: this.tasks(), dailySlots: this.availableDailySlots(), blackBoxEntries: this.blackBoxEntries(), statusEntries: this.statusMachineEntries(), muted: this.muteWaitTone(), toastMessage: this.toastMessage() };
  }
  restoreSnapshot(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const rows = (key: string): Record<string, unknown>[] | null => {
      const value = record[key];
      return Array.isArray(value) && value.length <= 100 && value.every(item => !!item && typeof item === 'object') ? value as Record<string, unknown>[] : null;
    };
    const tasks = rows('tasks');
    if (tasks?.every(task => typeof task.id === 'string' && typeof task.title === 'string' && typeof task.content === 'string' && typeof task.createdDate === 'string' && typeof task.displayId === 'string' && typeof task.order === 'number' && typeof task.rank === 'number' && typeof task.x === 'number' && typeof task.y === 'number' && (task.parentId === null || typeof task.parentId === 'string') && (task.stage === null || typeof task.stage === 'number') && ['active', 'completed', 'archived'].includes(String(task.status)))) this.tasks.set(tasks as unknown as Task[]);
    const slots = rows('dailySlots');
    if (slots?.every(slot => typeof slot.id === 'string' && typeof slot.title === 'string' && typeof slot.maxDailyCount === 'number' && typeof slot.todayCompletedCount === 'number' && typeof slot.isEnabled === 'boolean' && typeof slot.createdAt === 'string')) this.availableDailySlots.set(slots as unknown as DailySlotEntry[]);
    const entries = rows('blackBoxEntries');
    if (entries?.every(entry => typeof entry.id === 'string' && typeof entry.content === 'string' && typeof entry.userId === 'string' && typeof entry.date === 'string' && typeof entry.createdAt === 'string' && typeof entry.updatedAt === 'string' && typeof entry.isRead === 'boolean' && typeof entry.isCompleted === 'boolean' && typeof entry.isArchived === 'boolean' && (entry.deletedAt === null || typeof entry.deletedAt === 'string'))) this.blackBoxEntries.set(entries as unknown as BlackBoxEntry[]);
    const status = rows('statusEntries');
    if (status?.every(entry => typeof entry.taskId === 'string' && typeof entry.title === 'string' && ['queued', 'focusing', 'suspended_waiting', 'waiting_done', 'stalled'].includes(String(entry.uiStatus)) && typeof entry.label === 'string' && (entry.waitRemainingSeconds === null || typeof entry.waitRemainingSeconds === 'number') && (entry.waitTotalSeconds === null || typeof entry.waitTotalSeconds === 'number'))) this.statusMachineEntries.set(status as unknown as StatusMachineEntry[]);
    if (typeof record.muted === 'boolean') this.muteWaitTone.set(record.muted);
    if (typeof record.toastMessage === 'string') this.toastMessage.set(record.toastMessage);
  }
  resetDailyState(state: string): void {
    this.availableDailySlots.set([
      { id: crypto.randomUUID(), title: '喝一杯水', maxDailyCount: 3, todayCompletedCount: state === 'daily-completed' ? 3 : 1, isEnabled: true, createdAt: '2026-01-01T12:00:00.000Z' },
      { id: crypto.randomUUID(), title: '站起来走走', maxDailyCount: 1, todayCompletedCount: 1, isEnabled: true, createdAt: '2026-01-01T12:00:00.000Z' },
    ]);
  }
  async createInDock(title: string): Promise<string> { this.toastMessage.set(`已创建虚拟任务：${title}`); return crypto.randomUUID(); }
  startMeasuring(): void {}
  stopMeasuring(): void {}
  readonly fragmentRest = { dismissRestReminder: () => this.restReminderActive.set(false) };
  readonly blackBoxEntries = signal<BlackBoxEntry[]>([this.entry('记下一个想法，之后再处理')]);
  readonly currentEntry = computed(() => this.blackBoxEntries()[0] ?? null);
  readonly progress = computed(() => ({ current: 1, total: this.blackBoxEntries().length || 1 }));
  readonly cardAnimation = signal('idle');
  readonly impactTick = signal(0);

  private task(title: string, status: Task['status'], deleted = false): Task {
    return { id: crypto.randomUUID(), title, content: '这是虚拟数据，可以放心恢复或删除。', stage: 1, parentId: null, order: 1, rank: 100, status, x: 0, y: 0, createdDate: '2026-01-01T12:00:00.000Z', displayId: '1', deletedAt: deleted ? new Date().toISOString() : null, deletedMeta: deleted ? { parentId: null, stage: 1, order: 1, rank: 100, x: 0, y: 0 } : undefined };
  }
  private status(title: string, uiStatus: StatusMachineEntry['uiStatus'], label: StatusMachineEntry['label'], remaining: number | null = null, total: number | null = null): StatusMachineEntry {
    return { taskId: crypto.randomUUID(), title, uiStatus, label, waitRemainingSeconds: remaining, waitTotalSeconds: total };
  }
  private entry(content: string): BlackBoxEntry {
    return { id: crypto.randomUUID(), projectId: this.projectId, userId: 'local-user', content, date: '2026-01-01', createdAt: '2026-01-01T12:00:00.000Z', updatedAt: '2026-01-01T12:00:00.000Z', isRead: false, isCompleted: false, isArchived: false, deletedAt: null };
  }
  resetStatusState(state: string): void {
    const states: Record<string, StatusMachineEntry> = {
      focusing: this.status('正在写方案', 'focusing', '专注中'),
      waiting: this.status('等待编译结束', 'suspended_waiting', '挂起等待', 120, 300),
      queued: this.status('等待下一步', 'queued', '待启动'),
      'waiting-done': this.status('已等待完成', 'waiting_done', '等待结束', 0, 300),
      stalled: this.status('需要重新安排', 'stalled', '停滞中'),
    };
    this.statusMachineEntries.set(states[state] ? [states[state]] : Object.values(states));
  }
  resetRecoveryState(state: string): void {
    this.tasks.set([this.task('待恢复的演示任务', 'active', state !== 'restored'), this.task('已归档的演示任务', 'archived')]);
    this.toastMessage.set(state === 'restored' ? '演示任务已恢复到主视图，可刷新重新开始。' : '');
  }
  resetBlackBoxState(state: string): void {
    const entry = this.entry('记下一个想法，之后再处理');
    this.blackBoxEntries.set([{ ...entry, isRead: state === 'read' || state === 'completed', isCompleted: state === 'completed' }]);
  }
  readonly canPublishUi = () => true;
  async restoreTask(id: string): Promise<boolean> { return this.patchTask(id, { deletedAt: null }); }
  async updateTaskStatus(id: string, status: Task['status']): Promise<boolean> { return this.patchTask(id, { status }); }
  private patchTask(id: string, patch: Partial<Task>): boolean {
    if (!this.tasks().some(task => task.id === id)) return false;
    this.tasks.update(tasks => tasks.map(task => task.id === id ? { ...task, ...patch } : task));
    return true;
  }
  async permanentlyDeleteTaskWithOutcome(id: string, canPublish: () => boolean): Promise<{ status: 'success' | 'blocked' }> {
    if (!canPublish()) return { status: 'blocked' };
    this.tasks.update(tasks => tasks.filter(task => task.id !== id));
    return { status: 'success' };
  }
  async emptyTrash(canPublish: () => boolean): Promise<boolean> {
    if (!canPublish()) return false;
    this.tasks.update(tasks => tasks.filter(task => !task.deletedAt));
    return true;
  }
  success(title: string, body = ''): void { this.toastMessage.set(`${title} ${body}`.trim()); }
  warning(title: string, body = ''): void { this.toastMessage.set(`${title} ${body}`.trim()); }
  async switchToTask(id: string): Promise<boolean> {
    this.statusMachineEntries.update(entries => entries.map(entry => ({ ...entry, uiStatus: entry.taskId === id ? 'focusing' : entry.uiStatus === 'focusing' ? 'queued' : entry.uiStatus, label: entry.taskId === id ? '专注中' : entry.uiStatus === 'focusing' ? '待启动' : entry.label })));
    return true;
  }
  async toggleMuteWaitTone(): Promise<void> { this.muteWaitTone.update(value => !value); }
  markBlackBoxRead(id: string): void { this.blackBoxEntries.update(entries => entries.map(entry => entry.id === id ? { ...entry, isRead: true } : entry)); }
  markBlackBoxCompleted(id: string): void { this.blackBoxEntries.update(entries => entries.map(entry => entry.id === id ? { ...entry, isRead: true, isCompleted: true } : entry)); }
  deleteBlackBox(id: string): void { this.blackBoxEntries.update(entries => entries.filter(entry => entry.id !== id)); }
  markAsRead(): void { const id = this.currentEntry()?.id; if (id) this.markBlackBoxRead(id); }
  markAsCompleted(): void { const id = this.currentEntry()?.id; if (id) this.markBlackBoxCompleted(id); }
  notifyAnimationStarted(): void {}
  onEnteringComplete(): void { this.cardAnimation.set('idle'); }
  onHeaveReadComplete(): void { this.cardAnimation.set('idle'); }
  onHeavyDropComplete(): void { this.cardAnimation.set('idle'); }
  onSettlingComplete(): void { this.cardAnimation.set('idle'); }
}