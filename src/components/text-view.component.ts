
import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { StoreService, Task } from '../services/store.service';

@Component({
  selector: 'app-text-view',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="flex flex-col h-full bg-slate-50">
      
      <!-- Top Section: Unassigned & Unfinished -->
      <div class="flex-none space-y-2 p-4">
        <!-- Unfinished Tasks -->
        <div class="bg-white rounded-lg border border-red-100 shadow-sm overflow-hidden">
          <div (click)="toggleUnfinished()" class="px-4 py-2 bg-red-50 cursor-pointer flex justify-between items-center hover:bg-red-100 transition-colors">
            <span class="font-medium text-red-700 text-sm flex items-center gap-2">
              <span class="w-2 h-2 rounded-full bg-red-500"></span>
              未完成任务
            </span>
            <span class="text-red-400 text-xs">{{ isUnfinishedOpen() ? '收起' : '展开' }} ({{store.unfinishedItems().length}})</span>
          </div>
          
          @if (isUnfinishedOpen()) {
            <div class="p-3 max-h-40 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 bg-white animate-slide-down">
              @for (item of store.unfinishedItems(); track item.taskId + item.text) {
                <div (dblclick)="jumpToTask(item.taskId)" class="p-2 border border-slate-100 rounded hover:border-red-200 hover:shadow-sm cursor-pointer group transition-all">
                  <div class="text-xs font-bold text-slate-500 mb-1">{{item.taskDisplayId}}</div>
                  <div class="flex items-start gap-2">
                     <input type="checkbox" class="mt-0.5 cursor-not-allowed opacity-50" disabled>
                     <span class="text-sm text-slate-700 line-clamp-2 group-hover:text-red-600">{{item.text}}</span>
                  </div>
                </div>
              }
              @if (store.unfinishedItems().length === 0) {
                  <div class="text-xs text-slate-400 italic p-2">所有任务已完成！</div>
              }
            </div>
          }
        </div>

        <!-- Unassigned Tasks (Fisheye) -->
        <div class="bg-white rounded-lg border border-slate-200 shadow-sm">
           <div class="px-4 py-2 border-b border-slate-100 text-xs font-bold text-slate-500 uppercase tracking-wider">未分配任务</div>
           <div class="fisheye-container">
              @for (task of store.unassignedTasks(); track task.id) {
                <div 
                  class="fisheye-item group relative"
                  (click)="selectTask(task)">
                   <span class="z-10 font-mono font-bold text-slate-700 group-hover:text-blue-600 transition-colors">{{task.title.substring(0, 4)}}</span>
                   <!-- Expanded detail on hover handled by CSS + layout logic, simply showing full title here -->
                   <div class="absolute inset-0 bg-blue-50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-center p-1 text-[10px] leading-tight font-medium text-blue-800">
                       {{task.title}}
                   </div>
                </div>
              }
              @if (store.unassignedTasks().length === 0) {
                  <div class="text-sm text-slate-400 px-4">暂无任务。请拖拽或新建。</div>
                  <button (click)="createUnassigned()" class="ml-auto mr-4 px-2 py-1 bg-blue-50 hover:bg-blue-100 text-blue-600 rounded text-xs font-bold">+ 新建</button>
              }
           </div>
        </div>
      </div>

      <!-- Main Stages Area -->
      <div class="flex-1 overflow-x-auto overflow-y-hidden p-4">
        <div class="flex h-full gap-6">
          @for (stage of store.stages(); track stage.stageNumber) {
            <div class="w-80 flex-shrink-0 flex flex-col h-full bg-white rounded-xl border border-slate-200 shadow-sm">
              <!-- Stage Header -->
              <div class="p-3 border-b border-slate-100 bg-slate-50 rounded-t-xl flex justify-between items-center">
                <h3 class="font-bold text-slate-700">阶段 {{stage.stageNumber}}</h3>
                <span class="bg-slate-200 text-slate-600 text-xs px-2 py-0.5 rounded-full">{{stage.tasks.length}}</span>
              </div>

              <!-- Tasks List -->
              <div class="flex-1 overflow-y-auto p-2 space-y-3">
                @for (task of stage.tasks; track task.id) {
                  @if (shouldShow(task)) {
                    <div 
                      (click)="selectTask(task)"
                      class="task-card relative bg-white border rounded-lg p-3 cursor-pointer hover:shadow-md hover:border-blue-300 group transition-all duration-300"
                      [class.border-blue-500]="selectedTaskId() === task.id"
                      [class.ring-2]="selectedTaskId() === task.id"
                      [class.ring-blue-100]="selectedTaskId() === task.id"
                      [class.task-card-expanded]="selectedTaskId() === task.id">
                      
                      <!-- Header -->
                      <div class="flex justify-between items-start mb-2">
                         <span class="font-mono text-xs font-bold text-blue-500 bg-blue-50 px-1.5 py-0.5 rounded">{{task.displayId}}</span>
                         <div class="text-xs text-slate-400">{{task.createdDate | date:'shortTime'}}</div>
                      </div>
                      
                      <div class="font-semibold text-slate-800 mb-1">{{task.title}}</div>
                      
                      <!-- Collapsed Content Preview -->
                      @if (selectedTaskId() !== task.id) {
                          <div class="text-xs text-slate-500 line-clamp-2">{{task.content}}</div>
                      }

                      <!-- Expanded Editing Area -->
                      @if (selectedTaskId() === task.id) {
                        <div class="mt-3 space-y-3 animate-fade-in">
                           <textarea 
                              #contentInput
                              [value]="task.content"
                              (input)="updateContent(task.id, contentInput.value)"
                              class="w-full h-32 text-sm p-2 border rounded focus:ring-2 focus:ring-blue-200 focus:border-blue-400 outline-none font-mono text-slate-600 bg-slate-50"
                              placeholder="输入 Markdown 内容..."></textarea>
                           
                           <!-- Actions -->
                           <div class="flex flex-wrap gap-2 pt-2 border-t border-slate-100">
                              <button (click)="addSibling(task, $event)" class="flex-1 px-2 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-medium rounded flex items-center justify-center gap-1" title="添加同级任务">
                                <span class="text-lg leading-none">+</span> 同阶段
                              </button>
                              <button (click)="addChild(task, $event)" class="flex-1 px-2 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 text-xs font-medium rounded flex items-center justify-center gap-1" title="添加下一级任务">
                                <span class="text-lg leading-none">→</span> 下阶段
                              </button>
                              <button (click)="askAI(task, $event)" class="px-2 py-1.5 bg-purple-50 hover:bg-purple-100 text-purple-700 text-xs font-medium rounded" title="AI 助手">
                                AI
                              </button>
                           </div>
                        </div>
                      }
                    </div>
                  }
                }
              </div>
            </div>
          }
          
          <!-- Add Stage Placeholder -->
          <div class="w-16 flex-shrink-0 flex items-center justify-center">
             <button (click)="addNewStage()" class="w-10 h-10 rounded-full bg-white border-2 border-dashed border-slate-300 text-slate-400 hover:border-blue-400 hover:text-blue-500 hover:scale-110 transition-all flex items-center justify-center shadow-sm">
                <span class="text-2xl font-light">+</span>
             </button>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .animate-slide-down { animation: slideDown 0.3s ease-out; }
    .animate-fade-in { animation: fadeIn 0.3s ease-out; }
    @keyframes slideDown { from { opacity:0; transform: translateY(-10px); } to { opacity:1; transform: translateY(0); } }
    @keyframes fadeIn { from { opacity:0; } to { opacity:1; } }
  `]
})
export class TextViewComponent {
  store = inject(StoreService);
  isUnfinishedOpen = signal(true);
  selectedTaskId = signal<string | null>(null);

  toggleUnfinished() {
    this.isUnfinishedOpen.update(v => !v);
  }
  
  selectTask(task: Task) {
      if (this.selectedTaskId() === task.id) {
          this.selectedTaskId.set(null); // toggle off
      } else {
          this.selectedTaskId.set(task.id);
      }
  }
  
  jumpToTask(id: string) {
      this.selectedTaskId.set(id);
      // logic to scroll to element would go here
  }

  shouldShow(task: Task) {
      const filter = this.store.filterMode();
      if (filter === 'all') return true;
      // Filter logic: Show if task.id == filter OR task.parentId == filter OR recursive check
      // Simplified: check if displayId starts with the filter root's displayId
      const root = this.store.rootTasks().find(r => r.id === filter);
      if (!root) return true;
      return task.displayId.startsWith(root.displayId);
  }
  
  updateContent(id: string, content: string) {
      this.store.updateTaskContent(id, content);
  }
  
  addSibling(task: Task, e: Event) {
      e.stopPropagation();
      this.store.addTask("新同级任务", "详情...", task.stage, task.parentId, true);
  }
  
  addChild(task: Task, e: Event) {
      e.stopPropagation();
      const nextStage = (task.stage || 0) + 1;
      this.store.addTask("新子任务", "详情...", nextStage, task.id, false);
  }
  
  createUnassigned() {
      this.store.addTask("新未分配任务", "...", null, null, false);
  }
  
  addNewStage() {
      // Adds a task to a new max stage + 1
      const maxStage = Math.max(...this.store.stages().map(s => s.stageNumber), 0);
      this.store.addTask("新阶段任务", "开始...", maxStage + 1, null, false);
  }
  
  async askAI(task: Task, e: Event) {
      e.stopPropagation();
      const res = await this.store.think(`为任务 "${task.title}" 建议一个详细的检查清单。`);
      this.store.updateTaskContent(task.id, task.content + '\n\n**AI 建议:**\n' + res);
  }
}
