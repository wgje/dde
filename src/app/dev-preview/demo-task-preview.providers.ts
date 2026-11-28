import { Injectable, computed, inject, signal, type Provider } from '@angular/core';
import type { Task, TaskAttentionDraftItem, TaskAttentionItem, Attachment } from '../../models';
import { TaskOperationAdapterService } from '../../services/task-operation-adapter.service';
import { ProjectStateService, type ActiveProjectOwner } from '../../services/project-state.service';
import { DockEngineService } from '../../services/dock-engine.service';
import { ChangeTrackerService } from '../../services/change-tracker.service';
import { UiStateService } from '../../services/ui-state.service';
import { UndoService } from '../../services/undo.service';
import { AttachmentService } from '../../services/attachment.service';
import { ToastService } from '../../services/toast.service';
import { LoggerService } from '../../services/logger.service';
import { AuthService } from '../../services/auth.service';
import { ExternalSourceLinkService } from '../core/external-sources/external-source-link.service';
import { SiyuanPreviewService } from '../core/external-sources/siyuan/siyuan-preview.service';
import type { ExternalSourceLink } from '../core/external-sources/external-source.model';
import { TextViewTaskOpsService } from '../features/text/services/text-view-task-ops.service';

export function createDemoTask(state: string): Task {
  const date = '2026-11-27T08:00:00.000Z';
  return {
    id: crypto.randomUUID(), title: '准备一次清楚的演示',
    content: '这是一条虚拟任务。\n\n- [ ] 看看修改后的界面\n- [x] 准备演示数据',
    stage: 1, parentId: null, order: 1, rank: 1,
    status: state === 'completed' || state === 'archived' ? state : 'active',
    x: 0, y: 0, createdDate: date, displayId: '1',
    ...(state.startsWith('sidecar') ? {
      expected_minutes: 25, wait_minutes: 10, cognitive_load: 'high' as const,
      attentionMeta: { items: [{ id: crypto.randomUUID(), text: '确认按钮位置和文字',
        level: 'warning' as const, done: false, createdAt: date, updatedAt: date }] },
    } : {}),
  };
}

@Injectable()
export class DemoTaskPreviewMemory {
  readonly projectId = crypto.randomUUID();
  readonly userId = crypto.randomUUID();
  readonly task = signal(createDemoTask('active'));
  readonly additionalTasks = signal<Task[]>([]);
  readonly dockedTaskIds = signal(new Set<string>());
  readonly links = signal<ExternalSourceLink[]>([]);
  readonly message = signal('');
  readonly drafts = new Map<string, unknown>();
  patch(taskId: string, fields: Partial<Task>): Promise<boolean> {
    if (this.task().id === taskId) this.task.update(task => ({ ...task, ...fields }));
    else if (this.additionalTasks().some(task => task.id === taskId)) {
      this.additionalTasks.update(tasks => tasks.map(task => task.id === taskId ? { ...task, ...fields } : task));
    } else return Promise.resolve(false);
    return Promise.resolve(true);
  }
  getTask(id: string): Task | null { return this.task().id === id ? this.task() : this.additionalTasks().find(task => task.id === id) ?? null; }
  addRelative(source: Task, child: boolean): void {
    const task = { ...createDemoTask('active'), title: child ? '新建的子任务' : '新建的同级任务',
      parentId: child ? source.id : source.parentId, stage: child ? (source.stage ?? 0) + 1 : source.stage,
      order: this.additionalTasks().length + 2, rank: this.additionalTasks().length + 2,
      displayId: child ? `${source.displayId},a` : String(this.additionalTasks().length + 2) };
    this.additionalTasks.update(tasks => [...tasks, task]);
  }
  park(id: string): void {
    const task = this.getTask(id); if (!task || task.status !== 'active') return;
    this.dockedTaskIds.update(ids => new Set([...ids, id]));
    void this.patch(id, { parkingMeta: { state: 'parked', parkedAt: new Date().toISOString(), lastVisitedAt: null,
      contextSnapshot: null, reminder: null, pinned: false } });
  }
  remove(id: string): void {
    this.additionalTasks.update(tasks => tasks.filter(task => task.id !== id));
    this.dockedTaskIds.update(ids => new Set([...ids].filter(taskId => taskId !== id)));
  }
  reset(state: string): void { this.drafts.clear(); this.links.set([]); this.additionalTasks.set([]); this.dockedTaskIds.set(new Set()); this.task.set(createDemoTask(state));
    if (state === 'siyuan') {
      this.links.set([{id:crypto.randomUUID(),taskId:this.task().id,sourceType:'siyuan-block',targetId:'20261127080000-demo001',uri:'siyuan://blocks/20261127080000-demo001',label:'虚拟思源文档',hpath:'/演示笔记/产品方案',role:'reference',sortOrder:0,createdAt:'2026-11-27T08:00:00Z',updatedAt:'2026-11-27T08:00:00Z'}]);
    }
  }
}


/** Every effectful dependency is replaced locally; never constructs a root writer. */
export const DEMO_TASK_PREVIEW_PROVIDERS: Provider[] = [
  DemoTaskPreviewMemory,
  { provide: TaskOperationAdapterService, useFactory: () => {
    const memory = inject(DemoTaskPreviewMemory);
    return {
      updateTaskTitle: (id: string, title: string) => memory.patch(id, { title }),
      updateTaskContent: (id: string, content: string) => memory.patch(id, { content }),
      updateTaskExpectedMinutes: (id: string, expected_minutes: number | null) => memory.patch(id, { expected_minutes }),
      updateTaskWaitMinutes: (id: string, wait_minutes: number | null) => memory.patch(id, { wait_minutes }),
      updateTaskCognitiveLoad: (id: string, cognitive_load: 'high' | 'low' | null) => memory.patch(id, { cognitive_load }),
      updateTaskAttachments: (id: string, attachments: Attachment[]) => memory.patch(id, { attachments }),
      updateTaskAttentionItems: (id: string, rows: TaskAttentionDraftItem[]) => {
        const date = new Date().toISOString();
        const items: TaskAttentionItem[] = rows.map(row => ({ id: row.id ?? crypto.randomUUID(), text: row.text,
          level: row.level ?? 'info', done: row.done ?? false, createdAt: row.createdAt ?? date, updatedAt: date }));
        return memory.patch(id, { attentionMeta: { items, updatedAt: date } });
      },
      addTodoItem: (id: string, text: string) => memory.patch(id, { content: `${memory.getTask(id)?.content ?? ""}\n- [ ] ${text}` }),
    };
  } },
  { provide: ProjectStateService, useFactory: () => {
    const memory = inject(DemoTaskPreviewMemory);
    return { activeProjectId: () => memory.projectId, captureActiveProjectOwner: () => ({ projectId: memory.projectId, generation: 1 }),
      isActiveProjectOwnerCurrent: (owner: ActiveProjectOwner) => owner.projectId === memory.projectId && owner.generation === 1,
      registerBeforeActiveProjectChange: () => () => {}, compressDisplayId: (id: string) => id,
      getTask: (id: string) => memory.getTask(id), getTaskConnections: (id: string) => ({
        outgoing: memory.additionalTasks().filter(task => task.parentId === id).map(task => ({targetId:task.id,targetTask:task,description:'后续任务'})),
        incoming: memory.getTask(id)?.parentId ? [{sourceId:memory.getTask(id)!.parentId!,sourceTask:memory.getTask(memory.getTask(id)!.parentId!),description:'上级任务'}] : [],
      }) };
  } },
  { provide: DockEngineService, useFactory: () => ({ dockedTaskIds: inject(DemoTaskPreviewMemory).dockedTaskIds, focusingEntry: signal(null) }) },
  { provide: ChangeTrackerService, useValue: { lockTaskField: () => {}, unlockTaskField: () => {} } },
  { provide: UiStateService, useValue: { markEditing: () => {} } },
  { provide: UndoService, useFactory: () => ({ appliedReplay: signal(null) }) },
  { provide: AttachmentService, useFactory: () => ({ uploadFile: async () => ({ success: false, error: '预览不上传文件' }),
      markAsDeleted: (attachment: Attachment) => ({ ...attachment, deletedAt: new Date().toISOString() }) }) },
  { provide: ToastService, useFactory: () => {
    const memory = inject(DemoTaskPreviewMemory); const show = (message: string) => memory.message.set(message);
    return { info: show, warning: show, success: show, error: show };
  } },
  { provide: LoggerService, useFactory: () => { const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, category: () => logger }; return logger; } },
  { provide: AuthService, useFactory: () => { const memory = inject(DemoTaskPreviewMemory); return { currentUserId: computed(() => memory.userId), captureAuthIdentityFence: () => memory.userId }; } },
  { provide: ExternalSourceLinkService, useFactory: () => {
    const memory = inject(DemoTaskPreviewMemory);
    return { links: memory.links, activeLinksForTask: (id: string) => memory.links().filter(link => link.taskId === id && !link.deletedAt),
      bindSiyuanBlock: async () => { memory.message.set('预览不连接外部知识库'); return null; },
      replaceSiyuanBlock: async () => null, removeLink: async (id: string) => { memory.links.update(links => links.filter(link => link.id !== id)); },
      openLink: () => memory.message.set('预览不打开外部链接') };
  } },
  { provide: SiyuanPreviewService, useValue: { preview: (link: ExternalSourceLink) => Promise.resolve({ status: 'ready', origin:'cache', preview:{blockId:link.targetId,linkId:link.id,title:'虚拟思源文档',hpath:'/演示笔记/产品方案',excerpt:'这里是一段虚拟思源块正文。可以查看僚机里的知识引用。',plainText:'这里是一段虚拟思源块正文。',childBlocks:[{id:'demo-child',content:'虚拟子块：验证代码变化',type:'p'}],truncated:false,fetchedAt:'2026-11-27T08:00:00Z',fetchStatus:'ready'} }) } },
  { provide: TextViewTaskOpsService, useValue: { armContainerClickGuard: () => {} } },
];
