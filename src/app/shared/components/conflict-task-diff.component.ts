import { Component, computed, input, output, signal, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Task } from '../../../models';
import type { TaskResolutionRecommendation } from '../../../services/conflict-auto-resolver.service';

/** 单个字段的差异描述 */
export interface FieldDiff {
  field: string;
  label: string;
  localValue: string;
  remoteValue: string;
}

/** 增强的任务差异条目，包含字段级差异和系统推荐 */
export interface TaskDiffItem {
  id: string;
  title: string;
  inLocal: boolean;
  inRemote: boolean;
  status: 'same' | 'modified' | 'local-only' | 'remote-only';
  fieldDiffs: FieldDiff[];
  /** 用户为此任务选择的保留策略（仅 selectable 模式） */
  resolution: 'local' | 'remote' | 'auto';
  /** 系统自动解决推荐（来自 ConflictAutoResolverService） */
  recommendation?: TaskResolutionRecommendation;
}

/** 用户对每个任务的保留选择映射 */
export type TaskResolutionMap = Map<string, 'local' | 'remote'>;

type FilterType = 'all' | 'modified' | 'local-only' | 'remote-only';

/**
 * 冲突任务差异对比组件
 * 展示字段级差异、支持逐任务展开详情和选择性保留
 */
@Component({
  selector: 'app-conflict-task-diff',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- 过滤栏 + 统计 -->
    <div class="flex flex-wrap items-center gap-1.5 mb-3">
      @for (f of filters; track f.type) {
        <button
          (click)="activeFilter.set(f.type)"
          class="px-2 py-1 rounded-md text-[10px] font-medium transition-colors border"
          [ngClass]="{
            'bg-indigo-50 dark:bg-indigo-900/40 border-indigo-300 dark:border-indigo-600 text-indigo-700 dark:text-indigo-300': activeFilter() === f.type,
            'bg-white dark:bg-stone-800 border-stone-200 dark:border-stone-600 text-stone-500 dark:text-stone-400 hover:border-stone-300 dark:hover:border-stone-500': activeFilter() !== f.type
          }">
          {{ f.label }}
          <span class="ml-1 px-1 py-0.5 rounded text-[9px]"
                [ngClass]="{
                  'bg-indigo-200 dark:bg-indigo-800 text-indigo-700 dark:text-indigo-200': activeFilter() === f.type,
                  'bg-stone-100 dark:bg-stone-700 text-stone-500 dark:text-stone-400': activeFilter() !== f.type
                }">
            {{ f.type === 'all' ? allDiffs().length : countByStatus(f.type) }}
          </span>
        </button>
      }
    </div>

    <!-- 差异列表 -->
    <div class="space-y-1.5 max-h-80 overflow-y-auto custom-scrollbar pr-1">
      @for (diff of filteredDiffs(); track diff.id) {
        <div class="rounded-lg border transition-all"
             [ngClass]="{
               'border-green-200 dark:border-green-800/50 bg-green-50/50 dark:bg-green-900/10': diff.status === 'same',
               'border-amber-200 dark:border-amber-800/50 bg-amber-50/50 dark:bg-amber-900/10': diff.status === 'modified',
               'border-indigo-200 dark:border-indigo-800/50 bg-indigo-50/50 dark:bg-indigo-900/10': diff.status === 'local-only',
               'border-teal-200 dark:border-teal-800/50 bg-teal-50/50 dark:bg-teal-900/10': diff.status === 'remote-only'
             }">
          <!-- 任务行（可点击展开） -->
          <div class="flex items-center gap-2 px-3 py-2 cursor-pointer select-none"
               (click)="toggleExpand(diff.id)">
            <!-- 选择性保留 toggle（仅 modified 时可选） -->
            @if (selectable() && diff.status !== 'same') {
              <div class="flex gap-0.5 rounded-md overflow-hidden border border-stone-200 dark:border-stone-600 flex-shrink-0"
                   (click)="$event.stopPropagation()">
                <button
                  (click)="setResolution(diff.id, 'local')"
                  class="px-1.5 py-0.5 text-[9px] font-medium transition-colors"
                  [ngClass]="{
                    'bg-indigo-500 text-white': getResolution(diff.id) === 'local',
                    'bg-white dark:bg-stone-800 text-stone-500 dark:text-stone-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/30': getResolution(diff.id) !== 'local'
                  }">本地</button>
                <button
                  (click)="setResolution(diff.id, 'remote')"
                  class="px-1.5 py-0.5 text-[9px] font-medium transition-colors"
                  [ngClass]="{
                    'bg-teal-500 text-white': getResolution(diff.id) === 'remote',
                    'bg-white dark:bg-stone-800 text-stone-500 dark:text-stone-400 hover:bg-teal-50 dark:hover:bg-teal-900/30': getResolution(diff.id) !== 'remote'
                  }">云端</button>
              </div>
            }

            <!-- 状态标签 -->
            <span class="px-1.5 py-0.5 rounded text-[9px] font-medium flex-shrink-0"
                  [ngClass]="{
                    'bg-green-200 dark:bg-green-800/60 text-green-700 dark:text-green-300': diff.status === 'same',
                    'bg-amber-200 dark:bg-amber-800/60 text-amber-700 dark:text-amber-300': diff.status === 'modified',
                    'bg-indigo-200 dark:bg-indigo-800/60 text-indigo-700 dark:text-indigo-300': diff.status === 'local-only',
                    'bg-teal-200 dark:bg-teal-800/60 text-teal-700 dark:text-teal-300': diff.status === 'remote-only'
                  }">
              {{ getStatusLabel(diff.status) }}
            </span>

            <!-- 系统推荐标签 -->
            @if (diff.recommendation && diff.status === 'modified') {
              <span class="px-1.5 py-0.5 rounded text-[9px] font-medium flex-shrink-0"
                    [ngClass]="{
                      'bg-green-100 dark:bg-green-900/40 text-green-600 dark:text-green-400': diff.recommendation.confidence === 'auto',
                      'bg-sky-100 dark:bg-sky-900/40 text-sky-600 dark:text-sky-400': diff.recommendation.confidence === 'suggest',
                      'bg-orange-100 dark:bg-orange-900/40 text-orange-600 dark:text-orange-400': diff.recommendation.confidence === 'manual'
                    }">
                {{ getConfidenceLabel(diff.recommendation.confidence) }}
                →
                {{ diff.recommendation.recommendation === 'local' ? '本地' : '云端' }}
              </span>
            }

            <!-- 任务标题 -->
            <span class="flex-1 text-xs text-stone-700 dark:text-stone-200 truncate">
              {{ diff.title }}
            </span>

            <!-- 变更字段数 -->
            @if (diff.fieldDiffs.length > 0) {
              <span class="text-[9px] text-amber-600 dark:text-amber-400 bg-amber-100 dark:bg-amber-900/40 px-1.5 py-0.5 rounded flex-shrink-0">
                {{ diff.fieldDiffs.length }} 处变更
              </span>
            }

            <!-- 展开/收起箭头 -->
            <svg class="w-3.5 h-3.5 text-stone-400 dark:text-stone-500 transition-transform flex-shrink-0"
                 [class.rotate-180]="isExpanded(diff.id)"
                 fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </div>

          <!-- 系统推荐理由（展开时显示） -->
          @if (isExpanded(diff.id) && diff.recommendation && diff.status !== 'same') {
            <div class="mx-3 mb-2 p-2 rounded-lg text-[10px] border"
                 [ngClass]="{
                   'bg-green-50/50 dark:bg-green-900/10 border-green-100 dark:border-green-800/40': diff.recommendation.confidence === 'auto',
                   'bg-sky-50/50 dark:bg-sky-900/10 border-sky-100 dark:border-sky-800/40': diff.recommendation.confidence === 'suggest',
                   'bg-orange-50/50 dark:bg-orange-900/10 border-orange-100 dark:border-orange-800/40': diff.recommendation.confidence === 'manual'
                 }">
              <div class="flex items-center gap-1.5 mb-1">
                <span class="font-medium text-stone-600 dark:text-stone-300">系统判断：</span>
                <span class="text-stone-700 dark:text-stone-200">{{ diff.recommendation.reason }}</span>
              </div>
              <!-- 详细推理过程（可展开） -->
              <button
                (click)="toggleReasoningExpand(diff.id); $event.stopPropagation()"
                class="text-[9px] text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300 underline">
                {{ isReasoningExpanded(diff.id) ? '收起推理过程' : '查看推理过程' }}
              </button>
              @if (isReasoningExpanded(diff.id)) {
                <ul class="mt-1 space-y-0.5 text-stone-500 dark:text-stone-400 pl-3">
                  @for (step of diff.recommendation.reasoning; track $index) {
                    <li class="flex items-start gap-1">
                      <span class="text-[9px] mt-0.5 flex-shrink-0">{{ $index + 1 }}.</span>
                      <span>{{ step }}</span>
                    </li>
                  }
                </ul>
              }
            </div>
          }

          <!-- 展开的字段级差异对比 -->
          @if (isExpanded(diff.id) && diff.status === 'modified') {
            <div class="px-3 pb-3 pt-1 border-t border-stone-100 dark:border-stone-700/50 space-y-2">
              <!-- 列标题 -->
              <div class="grid grid-cols-[80px_1fr_1fr] gap-2 text-[9px] font-bold text-stone-400 dark:text-stone-500 uppercase tracking-wider">
                <span>字段</span>
                <span class="flex items-center gap-1">
                  <span class="w-1.5 h-1.5 rounded-full bg-indigo-400 inline-block"></span>
                  本地
                </span>
                <span class="flex items-center gap-1">
                  <span class="w-1.5 h-1.5 rounded-full bg-teal-400 inline-block"></span>
                  云端
                </span>
              </div>

              @for (fd of diff.fieldDiffs; track fd.field) {
                <div class="grid grid-cols-[80px_1fr_1fr] gap-2 items-start">
                  <span class="text-[10px] font-medium text-stone-500 dark:text-stone-400 pt-1">{{ fd.label }}</span>
                  <div class="p-1.5 rounded-md bg-indigo-50 dark:bg-indigo-900/30 border border-indigo-100 dark:border-indigo-800/50 text-[11px] text-indigo-700 dark:text-indigo-300 break-words min-h-[28px]">
                    {{ fd.localValue || '(空)' }}
                  </div>
                  <div class="p-1.5 rounded-md bg-teal-50 dark:bg-teal-900/30 border border-teal-100 dark:border-teal-800/50 text-[11px] text-teal-700 dark:text-teal-300 break-words min-h-[28px]">
                    {{ fd.remoteValue || '(空)' }}
                  </div>
                </div>
              }
            </div>
          }

          <!-- 仅本地/仅云端的展开视图：显示任务主要信息 -->
          @if (isExpanded(diff.id) && (diff.status === 'local-only' || diff.status === 'remote-only')) {
            <div class="px-3 pb-3 pt-1 border-t border-stone-100 dark:border-stone-700/50">
              <div class="grid grid-cols-2 gap-2 text-[10px]">
                @for (fd of diff.fieldDiffs; track fd.field) {
                  <div class="flex items-start gap-1.5">
                    <span class="font-medium text-stone-500 dark:text-stone-400 whitespace-nowrap">{{ fd.label }}:</span>
                    <span class="text-stone-700 dark:text-stone-200 break-words">
                      {{ (diff.status === 'local-only' ? fd.localValue : fd.remoteValue) || '(空)' }}
                    </span>
                  </div>
                }
              </div>
            </div>
          }
        </div>
      }

      @if (filteredDiffs().length === 0) {
        <div class="text-center py-6 text-xs text-stone-400 dark:text-stone-500">
          {{ activeFilter() === 'all' ? '没有差异数据' : '没有匹配的任务' }}
        </div>
      }
    </div>

    <!-- 选择性保留汇总（仅 selectable 模式） -->
    @if (selectable() && selectableDiffCount() > 0) {
      <div class="mt-3 px-3 py-2 bg-violet-50 dark:bg-violet-900/20 rounded-lg border border-violet-200 dark:border-violet-700 text-[10px] text-violet-700 dark:text-violet-300 flex items-center justify-between">
        <span>
          已选择: {{ resolvedCount() }} / {{ selectableDiffCount() }} 个差异任务
        </span>
        <div class="flex gap-2">
          <button
            (click)="setAllResolutions('local')"
            class="px-2 py-0.5 rounded text-[9px] font-medium bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-200 dark:hover:bg-indigo-800/50 transition-colors">
            全选本地
          </button>
          <button
            (click)="setAllResolutions('remote')"
            class="px-2 py-0.5 rounded text-[9px] font-medium bg-teal-100 dark:bg-teal-900/40 text-teal-700 dark:text-teal-300 hover:bg-teal-200 dark:hover:bg-teal-800/50 transition-colors">
            全选云端
          </button>
        </div>
      </div>
    }
  `
})
export class ConflictTaskDiffComponent {
  /** 本地任务列表 */
  localTasks = input<Task[]>([]);
  /** 云端任务列表 */
  remoteTasks = input<Task[]>([]);
  /** 是否允许用户逐任务选择保留策略 */
  selectable = input(false);
  /** 系统自动解决推荐列表 */
  recommendations = input<TaskResolutionRecommendation[]>([]);

  /** 当用户更改任务保留选择时触发 */
  selectionChange = output<TaskResolutionMap>();

  readonly activeFilter = signal<FilterType>('all');
  /** 存储展开状态的任务 ID */
  private readonly expandedIds = signal<Set<string>>(new Set());
  /** 存储用户逐任务选择的保留策略 */
  private readonly resolutions = signal<Map<string, 'local' | 'remote'>>(new Map());
  /** 存储展开推荐理由的任务 ID */
  private readonly expandedReasoningIds = signal<Set<string>>(new Set());

  /** 推荐映射（快速查找） */
  private readonly recommendationMap = computed(() => {
    const map = new Map<string, TaskResolutionRecommendation>();
    for (const rec of this.recommendations()) {
      map.set(rec.taskId, rec);
    }
    return map;
  });

  readonly filters: { type: FilterType; label: string }[] = [
    { type: 'all', label: '全部' },
    { type: 'modified', label: '有修改' },
    { type: 'local-only', label: '仅本地' },
    { type: 'remote-only', label: '仅云端' },
  ];

  /** 计算所有任务的字段级差异 */
  readonly allDiffs = computed<TaskDiffItem[]>(() => {
    const local = this.localTasks();
    const remote = this.remoteTasks();
    const recMap = this.recommendationMap();

    const localMap = new Map<string, Task>(local.map(t => [t.id, t]));
    const remoteMap = new Map<string, Task>(remote.map(t => [t.id, t]));
    const allIds = new Set<string>([...localMap.keys(), ...remoteMap.keys()]);

    const diffs: TaskDiffItem[] = [];

    allIds.forEach(id => {
      const lt = localMap.get(id);
      const rt = remoteMap.get(id);
      const rec = recMap.get(id);

      if (lt && rt) {
        const fieldDiffs = this.compareFields(lt, rt);
        diffs.push({
          id,
          title: lt.title || rt.title || '未命名',
          inLocal: true,
          inRemote: true,
          status: fieldDiffs.length === 0 ? 'same' : 'modified',
          fieldDiffs,
          resolution: 'auto',
          recommendation: rec,
        });
      } else if (lt) {
        diffs.push({
          id,
          title: lt.title || '未命名',
          inLocal: true,
          inRemote: false,
          status: 'local-only',
          fieldDiffs: this.describeTask(lt, 'local'),
          resolution: 'local',
          recommendation: rec,
        });
      } else {
        diffs.push({
          id,
          title: rt!.title || '未命名',
          inLocal: false,
          inRemote: true,
          status: 'remote-only',
          fieldDiffs: this.describeTask(rt!, 'remote'),
          resolution: 'remote',
          recommendation: rec,
        });
      }
    });

    // 排序：modified > local-only > remote-only > same
    const order: Record<string, number> = { 'modified': 0, 'local-only': 1, 'remote-only': 2, 'same': 3 };
    return diffs.sort((a, b) => order[a.status] - order[b.status]);
  });

  /** 按当前过滤条件筛选 */
  readonly filteredDiffs = computed(() => {
    const filter = this.activeFilter();
    if (filter === 'all') return this.allDiffs();
    return this.allDiffs().filter(d => d.status === filter);
  });

  readonly modifiedCount = computed(() => this.allDiffs().filter(d => d.status === 'modified').length);
  readonly selectableDiffCount = computed(() => this.allDiffs().filter(d => d.status !== 'same').length);
  readonly resolvedCount = computed(() => this.resolutions().size);

  countByStatus(status: FilterType): number {
    return this.allDiffs().filter(d => d.status === status).length;
  }

  toggleExpand(id: string): void {
    this.expandedIds.update(set => {
      const next = new Set(set);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
  }

  isExpanded(id: string): boolean {
    return this.expandedIds().has(id);
  }

  toggleReasoningExpand(id: string): void {
    this.expandedReasoningIds.update(set => {
      const next = new Set(set);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
  }

  isReasoningExpanded(id: string): boolean {
    return this.expandedReasoningIds().has(id);
  }

  getConfidenceLabel(confidence: 'auto' | 'suggest' | 'manual'): string {
    const labels: Record<string, string> = {
      auto: '自动',
      suggest: '建议',
      manual: '需确认',
    };
    return labels[confidence] || confidence;
  }

  setResolution(taskId: string, resolution: 'local' | 'remote'): void {
    this.resolutions.update(map => {
      const next = new Map(map);
      next.set(taskId, resolution);
      return next;
    });
    this.selectionChange.emit(this.resolutions());
  }

  getResolution(taskId: string): 'local' | 'remote' | undefined {
    return this.resolutions().get(taskId);
  }

  setAllResolutions(resolution: 'local' | 'remote'): void {
    const diffIds = this.allDiffs().filter(d => d.status !== 'same').map(d => d.id);
    this.resolutions.update(() => {
      const next = new Map<string, 'local' | 'remote'>();
      diffIds.forEach(id => next.set(id, resolution));
      return next;
    });
    this.selectionChange.emit(this.resolutions());
  }

  getStatusLabel(status: string): string {
    const labels: Record<string, string> = {
      'same': '一致',
      'modified': '有修改',
      'local-only': '仅本地',
      'remote-only': '仅云端',
    };
    return labels[status] || status;
  }

  /** 比较两个任务的具体字段差异 */
  private compareFields(local: Task, remote: Task): FieldDiff[] {
    const diffs: FieldDiff[] = [];
    const fields: { key: keyof Task; label: string; format?: (v: unknown) => string }[] = [
      { key: 'title', label: '标题' },
      { key: 'content', label: '内容', format: v => this.truncate(String(v || ''), 120) },
      { key: 'status', label: '状态', format: v => this.formatStatus(String(v || '')) },
      { key: 'priority', label: '优先级', format: v => this.formatPriority(String(v || '')) },
      { key: 'dueDate', label: '截止日期' },
      { key: 'tags', label: '标签', format: v => (v as string[] || []).join(', ') },
      { key: 'expected_minutes', label: '预估耗时', format: v => v ? `${v} 分钟` : '' },
      { key: 'cognitive_load', label: '认知负荷', format: v => v === 'high' ? '高' : v === 'low' ? '低' : '' },
      { key: 'wait_minutes', label: '等待时间', format: v => v ? `${v} 分钟` : '' },
      { key: 'attachments', label: '附件', format: v => this.formatAttachments(v) },
      { key: 'parkingMeta', label: '停泊状态', format: v => this.formatJson(v) },
      { key: 'stage', label: '阶段', format: v => String(v ?? '') },
      { key: 'order', label: '排序', format: v => String(v ?? '') },
      { key: 'parentId', label: '父任务', format: v => String(v ?? '') },
      { key: 'rank', label: '层级排序', format: v => String(v ?? '') },
      { key: 'x', label: 'X坐标', format: v => String(v ?? '') },
      { key: 'y', label: 'Y坐标', format: v => String(v ?? '') },
    ];

    for (const f of fields) {
      const lv = local[f.key];
      const rv = remote[f.key];
      if (!this.fieldEqual(lv, rv)) {
        const fmt = f.format || (v => String(v ?? ''));
        diffs.push({
          field: f.key,
          label: f.label,
          localValue: fmt(lv),
          remoteValue: fmt(rv),
        });
      }
    }
    return diffs;
  }

  /** 描述仅存在于一侧的任务主要字段 */
  private describeTask(task: Task, _side: 'local' | 'remote'): FieldDiff[] {
    const result: FieldDiff[] = [];
    if (task.title) {
      result.push({ field: 'title', label: '标题', localValue: task.title, remoteValue: task.title });
    }
    if (task.content) {
      result.push({ field: 'content', label: '内容', localValue: this.truncate(task.content, 120), remoteValue: this.truncate(task.content, 120) });
    }
    if (task.status) {
      result.push({ field: 'status', label: '状态', localValue: this.formatStatus(task.status), remoteValue: this.formatStatus(task.status) });
    }
    if (task.priority) {
      result.push({ field: 'priority', label: '优先级', localValue: this.formatPriority(task.priority), remoteValue: this.formatPriority(task.priority) });
    }
    return result;
  }

  private fieldEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a == null && b == null) return true;
    if (Array.isArray(a) && Array.isArray(b)) {
      return JSON.stringify(a) === JSON.stringify(b);
    }
    if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
      return JSON.stringify(a) === JSON.stringify(b);
    }
    return false;
  }

  private truncate(text: string, maxLen: number): string {
    return text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
  }

  private formatStatus(status: string): string {
    const map: Record<string, string> = { open: '待办', in_progress: '进行中', done: '已完成', closed: '关闭' };
    return map[status] || status;
  }

  private formatPriority(priority: string): string {
    const map: Record<string, string> = { low: '低', medium: '中', high: '高', urgent: '紧急' };
    return map[priority] || priority;
  }

  private formatJson(value: unknown): string {
    if (value == null) {
      return '';
    }

    try {
      return this.truncate(JSON.stringify(value), 120);
    } catch {
      return String(value);
    }
  }

  private formatAttachments(value: unknown): string {
    if (!Array.isArray(value) || value.length === 0) {
      return '';
    }

    return value
      .map(item => {
        if (typeof item !== 'object' || item === null) {
          return String(item);
        }

        const attachment = item as { name?: string; id?: string; url?: string };
        return attachment.name || attachment.id || attachment.url || '附件';
      })
      .join(', ');
  }
}
