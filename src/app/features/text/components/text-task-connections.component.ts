import { Component, inject, Input, Output, EventEmitter, signal, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ProjectStateService, TaskConnectionInfo } from '../../../../services/project-state.service';
import { Task } from '../../../../models';

let nextConnectionsRegionId = 0;

/**
 * 任务关联区域组件
 * 显示任务的出入关联，支持折叠和跳转
 */
@Component({
  selector: 'app-text-task-connections',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (connections && (connections.outgoing.length > 0 || connections.incoming.length > 0)) {
      <div class="text-task-connections-panel transition-[width,padding,border-color,background-color,color] duration-200" [ngClass]="{
        'flex-shrink-0 border-l border-violet-100 pl-2': !isMobile,
        'w-36': !isMobile && !isCollapsed(),
        'w-8': !isMobile && isCollapsed(),
        'border-t border-violet-100 pt-2 mt-2': isMobile
      }">
        
        <!-- 标题栏：点击可折叠/展开 -->
        <button type="button"
             class="text-task-connections-header flex w-full items-center gap-1 border-0 bg-transparent p-0 text-left select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500"
             [ngClass]="{'mb-1.5': !isCollapsed(), 'flex-col': !isMobile && isCollapsed()}"
             [attr.aria-label]="'任务关联，共 ' + (connections.outgoing.length + connections.incoming.length) + ' 条'"
             [attr.aria-expanded]="!isCollapsed()"
             [attr.aria-controls]="regionId"
             (click)="toggleCollapse($event)">
          <span class="text-task-connections-icon text-violet-500 text-xs" aria-hidden="true">🔗</span>
          @if (!isCollapsed()) {
            <span class="text-[10px] font-medium text-violet-700">关联</span>
            <span class="text-[9px] text-violet-400">({{connections.outgoing.length + connections.incoming.length}})</span>
          } @else {
            <span class="text-[9px] text-violet-400 font-bold">{{connections.outgoing.length + connections.incoming.length}}</span>
          }
          <svg class="text-task-connections-chevron w-3 h-3 text-violet-400 transition-transform ml-auto"
               [ngClass]="{'rotate-180': isCollapsed(), '-rotate-90': !isMobile && !isCollapsed(), 'rotate-0': isMobile && !isCollapsed()}"
               aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
          </svg>
        </button>
        
        <!-- 关联内容：可折叠 -->
          <div class="text-task-connections-region"
               [id]="regionId"
               [class.animate-collapse-open]="!isCollapsed()"
               [hidden]="isCollapsed()"
               [attr.inert]="isCollapsed() ? '' : null"
               [attr.aria-hidden]="isCollapsed()">
            <!-- 发出的关联（本任务指向其他任务） -->
            @if (connections.outgoing.length > 0) {
              <div class="mb-2">
                <div class="text-[10px] text-stone-400 mb-1 flex items-center gap-1">
                  <svg class="w-3 h-3" aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 8l4 4m0 0l-4 4m4-4H3"/>
                  </svg>
                  关联到
                </div>
                <div class="text-task-connections-list space-y-1">
                  @for (conn of connections.outgoing; track conn.targetId) {
                    <button type="button"
                         class="text-task-connection-card flex w-full min-w-0 items-start gap-2 p-1.5 bg-violet-50/50 rounded-lg border border-violet-100 group enabled:cursor-pointer enabled:hover:bg-violet-100/50 disabled:cursor-default disabled:border-stone-200 disabled:bg-stone-50 disabled:opacity-70 transition-colors text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500"
                         [disabled]="!conn.targetTask"
                         [attr.aria-label]="conn.targetTask ? '打开关联任务：' + (conn.targetTask.title || conn.targetTask.id) : '关联任务不可用：' + conn.targetId"
                         (click)="onOpenTask(conn.targetTask!, $event)">
                      <span class="flex-1 min-w-0">
                        <span class="flex items-center gap-1.5">
                          <span class="flex-shrink-0 text-[9px] font-bold text-violet-400">{{projectState.compressDisplayId(conn.targetTask?.displayId || '?')}}</span>
                          <span class="text-[11px] text-violet-700 truncate font-medium">{{conn.targetTask?.title || '未命名'}}</span>
                        </span>
                        @if (conn.description) {
                          <span class="block text-[10px] text-violet-500 mt-0.5 italic truncate">"{{conn.description}}"</span>
                        }
                      </span>
                      <svg class="w-3 h-3 flex-shrink-0"
                           [ngClass]="conn.targetTask ? 'text-violet-400 group-hover:text-violet-600' : 'text-stone-300'"
                           aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
                      </svg>
                    </button>
                  }
                </div>
              </div>
            }
            
            <!-- 接收的关联（其他任务指向本任务） -->
            @if (connections.incoming.length > 0) {
              <div>
                <div class="text-[10px] text-stone-400 mb-1 flex items-center gap-1">
                  <svg class="w-3 h-3" aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16l-4-4m0 0l4-4m-4 4h18"/>
                  </svg>
                  被关联
                </div>
                <div class="text-task-connections-list space-y-1">
                  @for (conn of connections.incoming; track conn.sourceId) {
                    <button type="button"
                         class="text-task-connection-card flex w-full min-w-0 items-start gap-2 p-1.5 bg-indigo-50/50 rounded-lg border border-indigo-100 group enabled:cursor-pointer enabled:hover:bg-indigo-100/50 disabled:cursor-default disabled:border-stone-200 disabled:bg-stone-50 disabled:opacity-70 transition-colors text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500"
                         [disabled]="!conn.sourceTask"
                         [attr.aria-label]="conn.sourceTask ? '打开来源任务：' + (conn.sourceTask.title || conn.sourceTask.id) : '来源任务不可用：' + conn.sourceId"
                         (click)="onOpenTask(conn.sourceTask!, $event)">
                      <span class="flex-1 min-w-0">
                        <span class="flex items-center gap-1.5">
                          <span class="flex-shrink-0 text-[9px] font-bold text-indigo-400">{{projectState.compressDisplayId(conn.sourceTask?.displayId || '?')}}</span>
                          <span class="text-[11px] text-indigo-700 truncate font-medium">{{conn.sourceTask?.title || '未命名'}}</span>
                        </span>
                        @if (conn.description) {
                          <span class="block text-[10px] text-indigo-500 mt-0.5 italic truncate">"{{conn.description}}"</span>
                        }
                      </span>
                      <svg class="w-3 h-3 flex-shrink-0"
                           [ngClass]="conn.sourceTask ? 'text-indigo-400 group-hover:text-indigo-600' : 'text-stone-300'"
                           aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
                      </svg>
                    </button>
                  }
                </div>
              </div>
            }
          </div>
      </div>
    }
  `,
  styles: [`
    :host {
      display: block;
      max-width: 100%;
      min-width: 0;
    }

    .text-task-connections-panel {
      max-width: 100%;
      overflow: hidden;
    }

    .text-task-connection-card {
      max-width: 100%;
    }

    @container (max-width: 36rem) {
      .text-task-connections-panel {
        border-left-width: 0;
        border-top: 1px solid rgba(139, 92, 246, 0.2);
        margin-top: 0.5rem;
        padding-left: 0;
        padding-top: 0.5rem;
        width: 100%;
      }

      .text-task-connections-panel .text-task-connections-header {
        align-items: center;
        flex-direction: row;
      }

      .text-task-connections-chevron {
        margin-left: auto;
      }
    }

    .animate-collapse-open { 
      animation: collapseOpen 0.15s ease-out; 
    }
    @keyframes collapseOpen { 
      from { opacity: 0; transform: translateY(-4px); } 
      to { opacity: 1; transform: translateY(0); } 
    }
  `]
})
export class TextTaskConnectionsComponent {
  readonly projectState = inject(ProjectStateService);
  readonly regionId = `text-task-connections-region-${++nextConnectionsRegionId}`;
  
  @Input() connections: TaskConnectionInfo | null = null;
  @Input() isMobile = false;
  
  @Output() openTask = new EventEmitter<{ taskId: string; event: Event }>();
  
  readonly isCollapsed = signal(false);
  
  toggleCollapse(event: Event) {
    event.stopPropagation();
    this.isCollapsed.update(v => !v);
  }
  
  onOpenTask(task: Task, event: Event) {
    event.stopPropagation();
    if (task) {
      this.openTask.emit({ taskId: task.id, event });
    }
  }
}
