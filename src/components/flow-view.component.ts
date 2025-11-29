import { Component, inject, signal, computed, ElementRef, ViewChild, AfterViewInit, OnDestroy, effect, NgZone, HostListener, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { StoreService } from '../services/store.service';
import { Task } from '../models';
import * as go from 'gojs';

@Component({
  selector: 'app-flow-view',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="flex flex-col h-full bg-[#F9F8F6] relative">
       
       <!-- Top Palette Area (Resizable) -->
       <div class="flex-none flex flex-col overflow-hidden transition-none" [style.height.px]="paletteHeight()">
           <!-- 1. 待完成区域 (To-Do) -->
           <div class="flex-none mx-4 mt-4 px-4 pb-2 transition-all duration-300 overflow-hidden rounded-2xl bg-orange-50/60 border border-orange-100/50 backdrop-blur-sm z-10 relative">
               <div (click)="store.isFlowUnfinishedOpen.set(!store.isFlowUnfinishedOpen())" 
                    class="py-3 cursor-pointer flex justify-between items-center group select-none">
                   <span class="font-bold text-stone-700 text-sm flex items-center gap-2 tracking-tight">
                       <span class="w-1.5 h-1.5 rounded-full bg-orange-500 shadow-[0_0_6px_rgba(249,115,22,0.4)]"></span>
                       待办事项
                   </span>
                   <span class="text-stone-300 text-xs transition-transform duration-300 group-hover:text-stone-500" [class.rotate-180]="!store.isFlowUnfinishedOpen()">▼</span>
               </div>
               
               @if (store.isFlowUnfinishedOpen()) {
                   <div class="pb-4 animate-slide-down max-h-32 overflow-y-auto">
                       <ul class="space-y-2">
                           @for (item of store.unfinishedItems(); track item.taskId + item.text) {
                               <li class="text-xs text-stone-600 flex items-center gap-3 bg-white/80 backdrop-blur-sm border border-stone-100/50 p-2 rounded-lg hover:border-orange-200 cursor-pointer group shadow-sm transition-all" (click)="centerOnNode(item.taskId)">
                                   <span class="w-1 h-1 rounded-full bg-stone-200 group-hover:bg-orange-400 transition-colors ml-1"></span>
                                   <span class="font-bold text-retro-muted text-[9px] tracking-wider">{{store.compressDisplayId(item.taskDisplayId)}}</span>
                                   <span class="truncate flex-1 group-hover:text-stone-900 transition-colors">{{item.text}}</span>
                               </li>
                           }
                           @if (store.unfinishedItems().length === 0) {
                               <li class="text-xs text-stone-400 italic px-2 font-light">暂无待办</li>
                           }
                       </ul>
                   </div>
               }
           </div>

           <!-- 2. 待分配区域 (To-Assign) - 可拖动到流程图 -->
           <div class="flex-none mx-4 mt-2 mb-4 px-4 pb-2 transition-all duration-300 overflow-hidden rounded-2xl bg-teal-50/60 border border-teal-100/50 backdrop-blur-sm z-10 relative">
               <div (click)="store.isFlowUnassignedOpen.set(!store.isFlowUnassignedOpen())" 
                    class="py-3 cursor-pointer flex justify-between items-center group select-none">
                   <span class="font-bold text-stone-700 text-sm flex items-center gap-2 tracking-tight">
                       <span class="w-1.5 h-1.5 rounded-full bg-teal-500 shadow-[0_0_6px_rgba(20,184,166,0.4)]"></span>
                       待分配
                   </span>
                   <span class="text-stone-300 text-xs transition-transform duration-300 group-hover:text-stone-500" [class.rotate-180]="!store.isFlowUnassignedOpen()">▼</span>
               </div>

               @if (store.isFlowUnassignedOpen()) {
                   <div class="pb-4 animate-slide-down max-h-32 overflow-y-auto">
                       <div class="flex flex-wrap gap-2" id="unassignedPalette">
                           @for (task of store.unassignedTasks(); track task.id) {
                               <div 
                                   draggable="true" 
                                   (dragstart)="onDragStart($event, task)"
                                   (touchstart)="onUnassignedTouchStart($event, task)"
                                   (touchmove)="onUnassignedTouchMove($event)"
                                   (touchend)="onUnassignedTouchEnd($event)"
                                   (click)="onUnassignedTaskClick(task)"
                                   class="px-3 py-1.5 bg-white/80 backdrop-blur-sm border border-stone-200/50 rounded-md text-xs font-medium hover:border-teal-300 hover:text-teal-700 cursor-pointer shadow-sm transition-all active:scale-95 text-stone-500"
                                   [class.bg-teal-100]="unassignedDraggingId() === task.id"
                                   [class.border-teal-400]="unassignedDraggingId() === task.id">
                                   {{task.title}}
                               </div>
                           }
                           <button (click)="createUnassigned()" class="px-3 py-1.5 bg-white/50 hover:bg-teal-50 text-stone-400 hover:text-teal-600 rounded-md text-xs font-medium border border-transparent transition-all">+ 新建</button>
                       </div>
                   </div>
               }
           </div>
       </div>

       <!-- Resizer Handle -->
       <div class="h-3 bg-transparent hover:bg-stone-200 cursor-row-resize z-20 flex-shrink-0 relative group transition-all flex items-center justify-center touch-none"
            [class.h-4]="store.isMobile()"
            [class.bg-stone-100]="store.isMobile()"
            (mousedown)="startPaletteResize($event)"
            (touchstart)="startPaletteResizeTouch($event)">
            <div class="w-12 h-1 rounded-full bg-stone-300 group-hover:bg-stone-400 transition-colors"
                 [class.w-16]="store.isMobile()"
                 [class.h-1.5]="store.isMobile()"></div>
       </div>

       <!-- 3. 流程图区域 -->
       <div class="flex-1 relative overflow-hidden bg-[#F9F8F6] mt-0 mx-0 border-t border-stone-200/50">
           <!-- GoJS Diagram Div -->
           <div #diagramDiv class="absolute inset-0 w-full h-full z-0"></div>

           <!-- 手机端返回文本视图按钮 -->
           @if (store.isMobile()) {
             <button 
               (click)="goBackToText.emit()"
               class="absolute top-2 left-2 z-10 bg-white/90 backdrop-blur rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 text-stone-600 p-1.5 flex items-center gap-1">
               <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                 <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
               </svg>
               <span class="text-[10px] font-medium">文本</span>
             </button>
           }

           <!-- Zoom Controls -->
           <div class="absolute z-10 flex gap-2"
                [class.transition-all]="!isResizingDrawerSignal()"
                [class.duration-200]="!isResizingDrawerSignal()"
                [class.flex-col]="!store.isMobile()"
                [class.flex-row]="store.isMobile()"
                [class.bottom-4]="!store.isMobile()"
                [class.left-4]="!store.isMobile()"
                [class.left-2]="store.isMobile()"
                [style.bottom.px]="store.isMobile() ? (store.isFlowDetailOpen() ? (drawerHeight() * window.innerHeight / 100 + 8) : 8) : 16">
               <button (click)="zoomIn()" 
                       class="bg-white/90 backdrop-blur rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 text-stone-600"
                       [class.p-2]="!store.isMobile()"
                       [class.p-1.5]="store.isMobile()"
                       title="放大">
                   <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                        [class.h-5]="!store.isMobile()" [class.w-5]="!store.isMobile()"
                        [class.h-4]="store.isMobile()" [class.w-4]="store.isMobile()">
                     <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
                   </svg>
               </button>
               <button (click)="zoomOut()" 
                       class="bg-white/90 backdrop-blur rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 text-stone-600"
                       [class.p-2]="!store.isMobile()"
                       [class.p-1.5]="store.isMobile()"
                       title="缩小">
                   <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                        [class.h-5]="!store.isMobile()" [class.w-5]="!store.isMobile()"
                        [class.h-4]="store.isMobile()" [class.w-4]="store.isMobile()">
                     <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 12H4" />
                   </svg>
               </button>
               <!-- 自动布局按钮 -->
               <button 
                 (click)="applyAutoLayout()" 
                 class="bg-white/90 backdrop-blur rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 text-stone-600"
                 [class.p-2]="!store.isMobile()"
                 [class.p-1.5]="store.isMobile()"
                 title="自动整理布局">
                   <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                        [class.h-5]="!store.isMobile()" [class.w-5]="!store.isMobile()"
                        [class.h-4]="store.isMobile()" [class.w-4]="store.isMobile()">
                     <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" />
                   </svg>
               </button>
               <!-- 连接模式按钮 -->
               <button (click)="toggleLinkMode()" class="backdrop-blur rounded-lg shadow-sm border transition-all hover:bg-stone-50" [class.p-2]="!store.isMobile()" [class.p-1.5]="store.isMobile()" [class.bg-indigo-500]="isLinkMode()" [class.text-white]="isLinkMode()" [class.border-indigo-500]="isLinkMode()" [class.bg-white]="!isLinkMode()" [class.text-stone-600]="!isLinkMode()" [class.border-stone-200]="!isLinkMode()" title="连接模式">
                   <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" [class.h-5]="!store.isMobile()" [class.w-5]="!store.isMobile()" [class.h-4]="store.isMobile()" [class.w-4]="store.isMobile()">
                     <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                   </svg>
               </button>
           </div>
           
           <!-- 连接模式提示 -->
           @if (isLinkMode()) {
             <div class="absolute z-10 bg-indigo-500 text-white font-medium rounded-lg shadow-lg animate-fade-in flex items-center px-3 py-2 text-xs top-4 left-4" [ngClass]="{'top-2 left-1/2 -translate-x-1/2 px-2 py-1.5 max-w-[90vw]': store.isMobile(), 'text-[10px]': store.isMobile()}">
               @if (linkSourceTask()) {
                 <span class="truncate">已选: <span class="font-bold">{{ linkSourceTask()?.title }}</span></span>
                 <span class="mx-1">&rarr;</span>
                 <span>点击目标</span>
               } @else {
                 点击源节点
               }
               <button (click)="cancelLinkMode()" class="ml-2 px-1.5 py-0.5 bg-white/20 rounded hover:bg-white/30 transition-colors">取消</button>
             </div>
           }

           <!-- 4. 详情区域 - 桌面端可拖动浮动面板 -->
           @if (!store.isMobile() && store.isFlowDetailOpen()) {
             <div class="absolute z-20 pointer-events-auto"
                  [style.right.px]="taskDetailPos().x < 0 ? 0 : null"
                  [style.top.px]="taskDetailPos().y < 0 ? 24 : taskDetailPos().y"
                  [style.left.px]="taskDetailPos().x >= 0 ? taskDetailPos().x : null">
                <!-- Content Panel - 桌面端可拖动 -->
                <div class="w-64 max-h-96 bg-white/95 backdrop-blur-xl border border-stone-200/50 shadow-xl overflow-hidden flex flex-col rounded-xl">
                    
                    <!-- 可拖动标题栏 -->
                    <div class="px-3 py-2 border-b border-stone-100 flex justify-between items-center cursor-move select-none bg-gradient-to-r from-stone-50 to-white"
                         (mousedown)="startDragTaskDetail($event)"
                         (touchstart)="startDragTaskDetail($event)">
                        <div class="flex items-center gap-1.5">
                            <span class="text-[8px] text-stone-400">☰</span>
                            <h3 class="font-bold text-stone-700 text-xs">任务详情</h3>
                        </div>
                        <button (click)="store.isFlowDetailOpen.set(false)" class="text-stone-400 hover:text-stone-600 p-1">
                          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                    </div>
                        
                    <div class="flex-1 overflow-y-auto px-3 py-2 space-y-2">
                        @if (selectedTask(); as task) {
                            <div class="space-y-2">
                                <div class="flex items-center gap-2 text-[10px]">
                                    <span class="font-bold text-retro-muted bg-stone-100 px-1.5 py-0.5 rounded">{{store.compressDisplayId(task.displayId)}}</span>
                                    <span class="text-stone-400">{{task.createdDate | date:'MM-dd'}}</span>
                                    <span class="px-1.5 py-0.5 rounded"
                                          [class.bg-emerald-100]="task.status === 'completed'"
                                          [class.text-emerald-700]="task.status === 'completed'"
                                          [class.bg-amber-100]="task.status !== 'completed'"
                                          [class.text-amber-700]="task.status !== 'completed'">
                                      {{task.status === 'completed' ? '完成' : '进行中'}}
                                    </span>
                                </div>
                                
                                <input type="text" [ngModel]="task.title" (ngModelChange)="updateTaskTitle(task.id, $event)"
                                    class="w-full text-xs font-medium text-stone-800 border border-stone-200 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-300 bg-white"
                                    placeholder="任务标题">
                                
                                <textarea [ngModel]="task.content" (ngModelChange)="updateTaskContent(task.id, $event)" rows="4"
                                    class="w-full text-[11px] text-stone-600 border border-stone-200 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-300 bg-white resize-none font-mono leading-relaxed"
                                    placeholder="输入内容..."></textarea>

                                <div class="flex gap-1.5 pt-1">
                                    <button (click)="addSiblingTask(task)"
                                        class="flex-1 px-2 py-1 bg-retro-teal/10 hover:bg-retro-teal text-retro-teal hover:text-white border border-retro-teal/30 text-[10px] font-medium rounded transition-all">
                                        +同级
                                    </button>
                                    <button (click)="addChildTask(task)"
                                        class="flex-1 px-2 py-1 bg-retro-rust/10 hover:bg-retro-rust text-retro-rust hover:text-white border border-retro-rust/30 text-[10px] font-medium rounded transition-all">
                                        +下级
                                    </button>
                                    <button (click)="toggleTaskStatus(task)"
                                        class="flex-1 px-2 py-1 text-[10px] font-medium rounded transition-all border"
                                        [class.bg-emerald-50]="task.status !== 'completed'"
                                        [class.text-emerald-700]="task.status !== 'completed'"
                                        [class.border-emerald-200]="task.status !== 'completed'"
                                        [class.bg-stone-50]="task.status === 'completed'"
                                        [class.text-stone-600]="task.status === 'completed'"
                                        [class.border-stone-200]="task.status === 'completed'">
                                        {{task.status === 'completed' ? '撤销' : '完成'}}
                                    </button>
                                    <button (click)="deleteTask(task)"
                                        class="px-2 py-1 bg-stone-50 hover:bg-red-500 text-stone-400 hover:text-white border border-stone-200 text-[10px] font-medium rounded transition-all">
                                        删除
                                    </button>
                                </div>
                            </div>
                        } @else if (store.activeProject()) {
                            <div class="text-[11px] space-y-1">
                                <div class="font-bold text-stone-800">{{store.activeProject()?.name}}</div>
                                <div class="text-stone-400 font-mono text-[10px]">{{store.activeProject()?.createdDate | date:'yyyy-MM-dd'}}</div>
                                <div class="text-stone-500 mt-1">{{store.activeProject()?.description}}</div>
                            </div>
                        } @else {
                            <div class="py-4 text-center text-stone-400 text-[10px]">
                                双击节点查看详情
                            </div>
                        }
                    </div>
                </div>
             </div>
           }
           <!-- 桌面端详情开启按钮 -->
             @if (!store.isMobile() && !store.isFlowDetailOpen()) {
               <button (click)="store.isFlowDetailOpen.set(true)" 
                       class="absolute top-6 right-2 z-20 bg-white/90 backdrop-blur border border-stone-200 rounded-lg p-2 shadow-sm hover:bg-white text-stone-400 hover:text-stone-600 transition-all flex items-center gap-1">
                   <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                     <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                   </svg>
                   <span class="text-[10px] font-medium">详情</span>
               </button>
             }

           <!-- 4. 详情区域 - 手机端底部抽屉 -->
           @if (store.isMobile()) {
             <!-- 底部小型标签触发器 -->
             @if (!store.isFlowDetailOpen()) {
               <button 
                 (click)="store.isFlowDetailOpen.set(true)"
                 class="absolute bottom-2 right-2 z-20 bg-white/90 backdrop-blur rounded-lg shadow-sm border border-stone-200 px-2 py-1 flex items-center gap-1 text-stone-500 hover:text-stone-700">
                 <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                   <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                 </svg>
                 <span class="text-[10px] font-medium">详情</span>
               </button>
             }
             
             <!-- 底部抽屉面板 -->
             @if (store.isFlowDetailOpen()) {
               <div class="absolute bottom-0 left-0 right-0 z-20 bg-white/95 backdrop-blur-xl border-t border-stone-200 shadow-[0_-4px_20px_rgba(0,0,0,0.1)] rounded-t-2xl flex flex-col"
                    [style.max-height.vh]="drawerHeight()"
                    style="transform: translateZ(0); backface-visibility: hidden;">
                 <!-- 拖动条 - 可拖动调整高度 -->
                 <div class="flex justify-center py-2 cursor-grab active:cursor-grabbing touch-none flex-shrink-0"
                      (touchstart)="startDrawerResize($event)">
                   <div class="w-12 h-1.5 bg-stone-300 rounded-full"></div>
                 </div>
                 
                 <!-- 标题栏 -->
                 <div class="px-3 pb-2 flex justify-between items-center flex-shrink-0">
                   <h3 class="font-bold text-stone-700 text-xs">任务详情</h3>
                   <button (click)="store.isFlowDetailOpen.set(false)" class="text-stone-400 hover:text-stone-600 p-1">
                     <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                       <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                     </svg>
                   </button>
                 </div>
                 
                 <!-- 内容区域 - 优化移动端滚动性能 -->
                 <div class="flex-1 overflow-y-auto px-3 pb-3 overscroll-contain"
                      style="-webkit-overflow-scrolling: touch; touch-action: pan-y; transform: translateZ(0);">
                   @if (selectedTask(); as task) {
                     <!-- 紧凑的任务信息 -->
                     <div class="flex items-center gap-2 mb-2">
                       <span class="font-bold text-retro-muted text-[8px] tracking-wider bg-stone-100 px-1.5 rounded">{{store.compressDisplayId(task.displayId)}}</span>
                       <span class="text-[9px] text-stone-400">{{task.createdDate | date:'MM-dd HH:mm'}}</span>
                       <span class="text-[9px] px-1.5 py-0.5 rounded"
                             [class.bg-emerald-100]="task.status === 'completed'"
                             [class.text-emerald-700]="task.status === 'completed'"
                             [class.bg-amber-100]="task.status !== 'completed'"
                             [class.text-amber-700]="task.status !== 'completed'">
                         {{task.status === 'completed' ? '已完成' : '进行中'}}
                       </span>
                     </div>
                     
                     <!-- 标题输入 -->
                     <input type="text" [ngModel]="task.title" (ngModelChange)="updateTaskTitle(task.id, $event)"
                       class="w-full text-xs font-medium text-stone-800 border border-stone-200 rounded px-2 py-1.5 mb-2 focus:outline-none focus:ring-1 focus:ring-indigo-300 bg-white"
                       placeholder="任务标题">
                     
                     <!-- 内容输入 -->
                     <textarea [ngModel]="task.content" (ngModelChange)="updateTaskContent(task.id, $event)" rows="2"
                       class="w-full text-[11px] text-stone-600 border border-stone-200 rounded px-2 py-1.5 mb-2 focus:outline-none focus:ring-1 focus:ring-indigo-300 bg-white resize-none font-mono"
                       placeholder="任务内容..."></textarea>
                     
                     <!-- 快速待办输入 -->
                     <div class="flex items-center gap-1 bg-retro-rust/5 border border-retro-rust/20 rounded overflow-hidden p-0.5 mb-2">
                       <span class="text-retro-rust flex-shrink-0 text-[10px] pl-1.5">☐</span>
                       <input
                         #flowQuickTodoInput
                         type="text"
                         (keydown.enter)="addQuickTodo(task.id, flowQuickTodoInput)"
                         class="flex-1 bg-transparent border-none outline-none text-stone-600 placeholder-stone-400 text-[11px] py-1 px-1"
                         placeholder="输入待办，回车添加...">
                       <button
                         (click)="addQuickTodo(task.id, flowQuickTodoInput)"
                         class="flex-shrink-0 bg-retro-rust/10 hover:bg-retro-rust text-retro-rust hover:text-white rounded p-1 mr-0.5 transition-all"
                         title="添加待办">
                         <svg class="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                       </button>
                     </div>
                     
                     <!-- 操作按钮 - 横向紧凑排列 -->
                     <div class="flex gap-1.5">
                       <button (click)="addSiblingTask(task)"
                         class="flex-1 px-2 py-1 bg-retro-teal/10 text-retro-teal border border-retro-teal/30 text-[10px] font-medium rounded transition-all">
                         +同级
                       </button>
                       <button (click)="addChildTask(task)"
                         class="flex-1 px-2 py-1 bg-retro-rust/10 text-retro-rust border border-retro-rust/30 text-[10px] font-medium rounded transition-all">
                         +下级
                       </button>
                       <button (click)="toggleTaskStatus(task)"
                         class="flex-1 px-2 py-1 text-[10px] font-medium rounded border transition-all"
                         [class.bg-emerald-50]="task.status !== 'completed'"
                         [class.text-emerald-700]="task.status !== 'completed'"
                         [class.border-emerald-200]="task.status !== 'completed'"
                         [class.bg-stone-50]="task.status === 'completed'"
                         [class.text-stone-600]="task.status === 'completed'"
                         [class.border-stone-200]="task.status === 'completed'">
                         {{task.status === 'completed' ? '未完成' : '完成'}}
                       </button>
                       <button (click)="deleteTask(task)"
                         class="px-2 py-1 bg-stone-50 text-stone-400 border border-stone-200 text-[10px] font-medium rounded transition-all">
                         删除
                       </button>
                     </div>
                   } @else {
                     <div class="text-center text-stone-400 text-xs py-4">双击节点查看详情</div>
                   }
                 </div>
               </div>
             }
           }
       </div>
       
       <!-- 删除确认弹窗 -->
       @if (deleteConfirmTask()) {
         <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in"
              (click)="deleteConfirmTask.set(null); deleteKeepChildren.set(false)">
           <div class="bg-white rounded-2xl shadow-2xl border border-stone-200 overflow-hidden animate-scale-in mx-4"
                [ngClass]="{'w-80': store.isMobile(), 'w-96': !store.isMobile()}"
                (click)="$event.stopPropagation()">
             <div class="px-5 pt-5 pb-4">
               <div class="flex items-center gap-3 mb-3">
                 <div class="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
                   <svg class="w-5 h-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                     <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                   </svg>
                 </div>
                 <div>
                   <h3 class="text-lg font-bold text-stone-800">删除任务</h3>
                   <p class="text-xs text-stone-500">此操作不可撤销</p>
                 </div>
               </div>
               <p class="text-sm text-stone-600 leading-relaxed">
                 确定删除任务 <span class="font-semibold text-stone-800">"{{ deleteConfirmTask()?.title }}"</span> 吗？
               </p>
               
               <!-- 保留子任务选项 -->
               @if (hasChildren(deleteConfirmTask()!)) {
                 <div class="mt-3 p-3 bg-amber-50 border border-amber-100 rounded-lg">
                   <label class="flex items-start gap-2 cursor-pointer">
                     <input 
                       type="checkbox" 
                       [checked]="deleteKeepChildren()"
                       (change)="deleteKeepChildren.set(!deleteKeepChildren())"
                       class="mt-0.5 w-4 h-4 rounded border-amber-300 text-amber-600 focus:ring-amber-500">
                     <div>
                       <span class="text-xs font-medium text-amber-800">保留子任务</span>
                       <p class="text-[10px] text-amber-600 mt-0.5">子任务将提升到当前任务的父级</p>
                     </div>
                   </label>
                 </div>
               } @else {
                 <p class="text-xs text-stone-400 mt-1">这将同时删除其所有子任务。</p>
               }
             </div>
             <div class="flex border-t border-stone-100">
               <button 
                 (click)="deleteConfirmTask.set(null); deleteKeepChildren.set(false)"
                 class="flex-1 px-4 py-3 text-sm font-medium text-stone-600 hover:bg-stone-50 transition-colors">
                 取消
               </button>
               <button 
                 (click)="confirmDelete()"
                 class="flex-1 px-4 py-3 text-sm font-medium text-white bg-red-500 hover:bg-red-600 transition-colors">
                 删除
               </button>
             </div>
           </div>
         </div>
       }
       
       <!-- 移动端连接线删除提示 -->
       @if (store.isMobile() && linkDeleteHint(); as hint) {
         <div class="fixed z-50 animate-scale-in"
              [style.left.px]="hint.x - 60"
              [style.top.px]="hint.y - 50">
           <div class="bg-white rounded-lg shadow-xl border border-stone-200 p-2 flex gap-2">
             <button 
               (click)="confirmLinkDelete()"
               class="px-3 py-1.5 bg-red-500 text-white text-xs font-medium rounded hover:bg-red-600 transition-all">
               删除连接
             </button>
             <button 
               (click)="cancelLinkDelete()"
               class="px-3 py-1.5 bg-stone-100 text-stone-600 text-xs font-medium rounded hover:bg-stone-200 transition-all">
               取消
             </button>
           </div>
         </div>
       }
       
       <!-- 联系块内联编辑器 - 浮动在连接线附近，可拖动 -->
       @if (connectionEditorData(); as connData) {
         <div class="absolute z-30 animate-scale-in"
              [style.left.px]="connectionEditorPos().x"
              [style.top.px]="connectionEditorPos().y">
           <div class="bg-white rounded-xl shadow-xl border border-violet-200 overflow-hidden w-52"
                (click)="$event.stopPropagation()">
             <!-- 可拖动标题栏 -->
             <div class="px-3 py-2 bg-gradient-to-r from-violet-50 to-indigo-50 border-b border-violet-100 flex items-center justify-between cursor-move select-none"
                  (mousedown)="startDragConnEditor($event)"
                  (touchstart)="startDragConnEditor($event)">
               <div class="flex items-center gap-1.5">
                 <span class="text-sm">🔗</span>
                 <span class="text-xs font-medium text-violet-700">编辑关联</span>
                 <span class="text-[8px] text-violet-400 ml-1">☰ 拖动</span>
               </div>
               <button (click)="closeConnectionEditor(); $event.stopPropagation()" class="text-stone-400 hover:text-stone-600 p-0.5">
                 <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                   <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                 </svg>
               </button>
             </div>
             
             <!-- 连接的两个任务 - 紧凑显示 -->
             <div class="px-3 py-2 bg-stone-50/50 border-b border-stone-100">
               <div class="flex items-center gap-1 text-[10px]">
                 @if (getConnectionTasks().source; as source) {
                   <span class="font-bold text-violet-500 truncate max-w-[70px]">{{store.compressDisplayId(source.displayId)}}</span>
                 }
                 <svg class="w-3 h-3 text-violet-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                   <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 8l4 4m0 0l-4 4m4-4H3" />
                 </svg>
                 @if (getConnectionTasks().target; as target) {
                   <span class="font-bold text-indigo-500 truncate max-w-[70px]">{{store.compressDisplayId(target.displayId)}}</span>
                 }
               </div>
             </div>
             
             <!-- 描述输入 - 自动调整高度 -->
             <div class="px-3 py-2">
               <textarea 
                 #descInput
                 id="connectionDescTextarea"
                 (keydown.escape)="closeConnectionEditor()"
                 (input)="autoResizeTextarea($event)"
                 class="w-full text-xs text-stone-700 border border-stone-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-violet-300 focus:border-violet-400 bg-white resize-none"
                 placeholder="输入关联描述..."
                 [style.min-height.px]="28"
                 [style.max-height.px]="120"
                 autofocus>{{connData.description}}</textarea>
             </div>
             
             <!-- 操作按钮 - 紧凑 -->
             <div class="flex border-t border-stone-100">
               <button 
                 (click)="closeConnectionEditor()"
                 class="flex-1 px-2 py-1.5 text-[10px] font-medium text-stone-500 hover:bg-stone-50 transition-colors">
                 取消
               </button>
               <button 
                 (click)="saveConnectionDescription(descInput.value)"
                 class="flex-1 px-2 py-1.5 text-[10px] font-medium text-white bg-violet-500 hover:bg-violet-600 transition-colors">
                 保存
               </button>
             </div>
           </div>
         </div>
       }
    </div>
  `
})
export class FlowViewComponent implements AfterViewInit, OnDestroy {
  @ViewChild('diagramDiv') diagramDiv!: ElementRef;
  @Output() goBackToText = new EventEmitter<void>();
  
  store = inject(StoreService);
    private readonly zone = inject(NgZone);
  
  // 暴露 window 给模板使用
  readonly window = typeof window !== 'undefined' ? window : { innerHeight: 800 };
  
  private diagram: any;
  private resizeObserver: ResizeObserver | null = null;
  
  // 选中的任务ID
  selectedTaskId = signal<string | null>(null);
  
  // 删除确认状态
  deleteConfirmTask = signal<Task | null>(null);
  deleteKeepChildren = signal(false); // 是否保留子任务
  
  // 连接模式状态
  isLinkMode = signal(false);
  linkSourceTask = signal<Task | null>(null);
  
  // 移动端连接线删除提示
  linkDeleteHint = signal<{ link: any; x: number; y: number } | null>(null);
  
  // 联系块编辑器状态 - 包含位置信息用于内联显示
  connectionEditorData = signal<{ sourceId: string; targetId: string; description: string; x: number; y: number } | null>(null);
  // 联系块编辑器拖动位置（独立 signal 以便拖动时实时更新）
  connectionEditorPos = signal<{ x: number; y: number }>({ x: 0, y: 0 });
  private connEditorDragState = { isDragging: false, startX: 0, startY: 0, offsetX: 0, offsetY: 0 };
  
  // 任务详情面板拖动位置（桐端）
  taskDetailPos = signal<{ x: number; y: number }>({ x: -1, y: -1 }); // -1 表示使用默认位置
  private taskDetailDragState = { isDragging: false, startX: 0, startY: 0, offsetX: 0, offsetY: 0 };
  
  // 计算属性: 获取选中的任务对象
  selectedTask = computed(() => {
    const id = this.selectedTaskId();
    if (!id) return null;
    return this.store.tasks().find(t => t.id === id) || null;
  });

  // Resizing State
  isResizingPalette = false;
  paletteHeight = signal(200); // Initial height for the top palette area
  private startY = 0;
  private startHeight = 0;
  
  // 底部抽屉拖动状态
  drawerHeight = signal(35); // 以 vh 为单位的高度
  private isResizingDrawer = false;
  isResizingDrawerSignal = signal(false); // 用于模板绑定，拖动时禁用按钮过渡动画
  
  // 抽屉内容滚动状态 - 用于区分滚动和拖动
  private isDrawerScrolling = false;
  private drawerScrollStartY = 0;
  
  // 移动端待分配块拖动状态
  unassignedDraggingId = signal<string | null>(null);
  private unassignedTouchState = {
    task: null as Task | null,
    startX: 0,
    startY: 0,
    isDragging: false,
    longPressTimer: null as any,
    ghost: null as HTMLElement | null
  };
  private drawerStartY = 0;
  private drawerStartHeight = 0;
  
  // 性能优化：位置保存防抖定时器
  private positionSaveTimer: ReturnType<typeof setTimeout> | null = null;

  // 连接模式方法
  toggleLinkMode() {
    this.isLinkMode.update(v => !v);
    this.linkSourceTask.set(null);
  }
  
  cancelLinkMode() {
    this.isLinkMode.set(false);
    this.linkSourceTask.set(null);
  }
  
  // 处理连接模式下的节点点击
  handleLinkModeClick(taskId: string) {
    const task = this.store.tasks().find(t => t.id === taskId);
    if (!task) return;
    
    const source = this.linkSourceTask();
    if (!source) {
      // 选择源节点
      this.linkSourceTask.set(task);
    } else if (source.id !== taskId) {
      // 选择目标节点，创建连接
      this.store.addCrossTreeConnection(source.id, taskId);
      this.linkSourceTask.set(null);
      this.isLinkMode.set(false);
      // 刷新图表以显示新连接
      setTimeout(() => this.updateDiagram(this.store.tasks()), 50);
    }
  }
  
  // 打开联系块编辑器 - 在点击位置附近显示
  openConnectionEditor(sourceId: string, targetId: string, description: string, x: number, y: number) {
    // 调整位置，稍微向左和上偏移以便编辑框出现在点击位置旁边
    const adjustedX = Math.max(10, x - 100);
    const adjustedY = Math.max(10, y - 20);
    this.connectionEditorData.set({ sourceId, targetId, description, x: adjustedX, y: adjustedY });
    this.connectionEditorPos.set({ x: adjustedX, y: adjustedY });
    
    // 编辑器打开后自动调整 textarea 高度
    setTimeout(() => {
      const textarea = document.querySelector('#connectionDescTextarea') as HTMLTextAreaElement;
      if (textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(120, Math.max(28, textarea.scrollHeight)) + 'px';
      }
    }, 10);
  }
  
  // 开始拖动联系块编辑器
  startDragConnEditor(event: MouseEvent | TouchEvent) {
    event.preventDefault();
    const pos = this.connectionEditorPos();
    const clientX = event instanceof MouseEvent ? event.clientX : event.touches[0].clientX;
    const clientY = event instanceof MouseEvent ? event.clientY : event.touches[0].clientY;
    
    this.connEditorDragState = {
      isDragging: true,
      startX: clientX,
      startY: clientY,
      offsetX: pos.x,
      offsetY: pos.y
    };
    
    // 添加全局事件监听
    document.addEventListener('mousemove', this.onDragConnEditor);
    document.addEventListener('mouseup', this.stopDragConnEditor);
    document.addEventListener('touchmove', this.onDragConnEditor);
    document.addEventListener('touchend', this.stopDragConnEditor);
  }
  
  // 拖动中
  private onDragConnEditor = (event: MouseEvent | TouchEvent) => {
    if (!this.connEditorDragState.isDragging) return;
    
    const clientX = event instanceof MouseEvent ? event.clientX : event.touches[0].clientX;
    const clientY = event instanceof MouseEvent ? event.clientY : event.touches[0].clientY;
    
    const deltaX = clientX - this.connEditorDragState.startX;
    const deltaY = clientY - this.connEditorDragState.startY;
    
    const newX = Math.max(0, this.connEditorDragState.offsetX + deltaX);
    const newY = Math.max(0, this.connEditorDragState.offsetY + deltaY);
    
    this.zone.run(() => {
      this.connectionEditorPos.set({ x: newX, y: newY });
    });
  };
  
  // 停止拖动
  private stopDragConnEditor = () => {
    this.connEditorDragState.isDragging = false;
    document.removeEventListener('mousemove', this.onDragConnEditor);
    document.removeEventListener('mouseup', this.stopDragConnEditor);
    document.removeEventListener('touchmove', this.onDragConnEditor);
    document.removeEventListener('touchend', this.stopDragConnEditor);
  };
  
  // 开始拖动任务详情面板
  startDragTaskDetail(event: MouseEvent | TouchEvent) {
    event.preventDefault();
    const pos = this.taskDetailPos();
    const clientX = event instanceof MouseEvent ? event.clientX : event.touches[0].clientX;
    const clientY = event instanceof MouseEvent ? event.clientY : event.touches[0].clientY;
    
    // 如果是默认位置，计算当前实际位置
    const diagramDiv = this.diagram?.div;
    let currentX = pos.x;
    let currentY = pos.y;
    if (pos.x < 0 && diagramDiv) {
      const rect = diagramDiv.getBoundingClientRect();
      currentX = rect.width - 256 - 8; // w-64 = 256px, 右边距8px
      currentY = 24;
    }
    
    this.taskDetailDragState = {
      isDragging: true,
      startX: clientX,
      startY: clientY,
      offsetX: currentX,
      offsetY: currentY
    };
    
    document.addEventListener('mousemove', this.onDragTaskDetail);
    document.addEventListener('mouseup', this.stopDragTaskDetail);
    document.addEventListener('touchmove', this.onDragTaskDetail);
    document.addEventListener('touchend', this.stopDragTaskDetail);
  }
  
  // 拖动任务详情面板中
  private onDragTaskDetail = (event: MouseEvent | TouchEvent) => {
    if (!this.taskDetailDragState.isDragging) return;
    
    const clientX = event instanceof MouseEvent ? event.clientX : event.touches[0].clientX;
    const clientY = event instanceof MouseEvent ? event.clientY : event.touches[0].clientY;
    
    const deltaX = clientX - this.taskDetailDragState.startX;
    const deltaY = clientY - this.taskDetailDragState.startY;
    
    const newX = Math.max(0, this.taskDetailDragState.offsetX + deltaX);
    const newY = Math.max(0, this.taskDetailDragState.offsetY + deltaY);
    
    this.zone.run(() => {
      this.taskDetailPos.set({ x: newX, y: newY });
    });
  };
  
  // 停止拖动任务详情面板
  private stopDragTaskDetail = () => {
    this.taskDetailDragState.isDragging = false;
    document.removeEventListener('mousemove', this.onDragTaskDetail);
    document.removeEventListener('mouseup', this.stopDragTaskDetail);
    document.removeEventListener('touchmove', this.onDragTaskDetail);
    document.removeEventListener('touchend', this.stopDragTaskDetail);
  };
  
  // 关闭联系块编辑器
  closeConnectionEditor() {
    this.connectionEditorData.set(null);
  }
  
  // 保存联系块描述
  saveConnectionDescription(description: string) {
    const data = this.connectionEditorData();
    if (data) {
      this.store.updateConnectionDescription(data.sourceId, data.targetId, description);
      this.closeConnectionEditor();
      // 刷新图表以显示新描述
      setTimeout(() => this.updateDiagram(this.store.tasks()), 50);
    }
  }
  
  // 自动调整 textarea 高度
  autoResizeTextarea(event: Event) {
    const textarea = event.target as HTMLTextAreaElement;
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(120, Math.max(28, textarea.scrollHeight)) + 'px';
  }
  
  // 获取连接的源任务和目标任务
  getConnectionTasks(): { source: Task | null; target: Task | null } {
    const data = this.connectionEditorData();
    if (!data) return { source: null, target: null };
    const tasks = this.store.tasks();
    return {
      source: tasks.find(t => t.id === data.sourceId) || null,
      target: tasks.find(t => t.id === data.targetId) || null
    };
  }

  constructor() {
      // 监听任务数据变化，更新图表
      effect(() => {
          const tasks = this.store.tasks();
          if (this.diagram) {
              this.updateDiagram(tasks);
          }
      });
      
      // 跨视图选中状态同步：监听外部选中任务的变化
      effect(() => {
          const selectedId = this.selectedTaskId();
          if (selectedId && this.diagram) {
              const node = this.diagram.findNodeForKey(selectedId);
              if (node && !node.isSelected) {
                  // 自动定位到选中的节点（不打开详情面板）
                  this.diagram.select(node);
                  // 如果节点不在视图中，滚动到节点位置
                  if (!this.diagram.viewportBounds.containsRect(node.actualBounds)) {
                      this.diagram.centerRect(node.actualBounds);
                  }
              }
          }
      });
  }

  public refreshLayout() {
      if (this.diagram) {
          this.diagram.requestUpdate();
      }
  }
  
  // 应用自动布局（一次性整理）
  applyAutoLayout() {
      if (!this.diagram) return;
      
      const $ = go.GraphObject.make;
      // 临时应用有序布局
      this.diagram.startTransaction('auto-layout');
      this.diagram.layout = $(go.LayeredDigraphLayout, {
          direction: 0,
          layerSpacing: 100,
          columnSpacing: 40,
          setsPortSpots: false
      });
      this.diagram.layoutDiagram(true);
      
      // 布局完成后保存所有位置并恢复为无操作布局
      setTimeout(() => {
          this.saveAllNodePositions();
          this.diagram.layout = $(go.Layout); // 恢复无操作布局
          this.diagram.commitTransaction('auto-layout');
      }, 50);
  }
  
  // 保存所有节点位置到 store
  saveAllNodePositions() {
      if (!this.diagram) return;
      
      this.diagram.nodes.each((node: any) => {
          const loc = node.location;
          if (node.data && node.data.key && loc.isReal()) {
              this.store.updateTaskPosition(node.data.key, loc.x, loc.y);
          }
      });
  }

  zoomIn() {
      if (this.diagram) {
          this.diagram.commandHandler.increaseZoom();
      }
  }

  zoomOut() {
      if (this.diagram) {
          this.diagram.commandHandler.decreaseZoom();
      }
  }

  // 更新任务标题
  updateTaskTitle(taskId: string, title: string) {
      this.store.updateTaskTitle(taskId, title);
  }

  // 更新任务内容
  updateTaskContent(taskId: string, content: string) {
      this.store.updateTaskContent(taskId, content);
  }

  // 快速添加待办
  addQuickTodo(taskId: string, inputElement: HTMLInputElement) {
      const text = inputElement.value.trim();
      if (!text) return;
      
      this.store.addTodoItem(taskId, text);
      inputElement.value = '';
      inputElement.focus();
  }

  // 添加同级任务
  addSiblingTask(task: Task) {
      const newTaskId = this.store.addTask('新同级任务', '', task.stage, task.parentId, true);
      if (newTaskId) {
          this.selectedTaskId.set(newTaskId);
      }
  }

  // 添加子任务
  addChildTask(task: Task) {
      const nextStage = (task.stage || 0) + 1;
      const newTaskId = this.store.addTask('新子任务', '', nextStage, task.id, false);
      if (newTaskId) {
          this.selectedTaskId.set(newTaskId);
      }
  }

  // 切换任务状态
  toggleTaskStatus(task: Task) {
      const newStatus = task.status === 'completed' ? 'active' : 'completed';
      this.store.updateTaskStatus(task.id, newStatus);
  }

  // 删除任务
  deleteTask(task: Task) {
      this.deleteConfirmTask.set(task);
  }

  confirmDelete() {
      const task = this.deleteConfirmTask();
      if (task) {
          this.selectedTaskId.set(null);
          
          // 根据选项决定是否保留子任务
          if (this.deleteKeepChildren()) {
              this.store.deleteTaskKeepChildren(task.id);
          } else {
              this.store.deleteTask(task.id);
          }
          
          this.deleteConfirmTask.set(null);
          this.deleteKeepChildren.set(false);
      }
  }
  
  // 检查任务是否有子任务
  hasChildren(task: Task): boolean {
      return this.store.tasks().some(t => t.parentId === task.id);
  }

  startPaletteResize(e: MouseEvent) {
      e.preventDefault();
      this.isResizingPalette = true;
      this.startY = e.clientY;
      this.startHeight = this.paletteHeight();
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      
      const onMove = (ev: MouseEvent) => {
          if (!this.isResizingPalette) return;
          const delta = ev.clientY - this.startY;
          const newHeight = Math.max(100, Math.min(600, this.startHeight + delta));
          this.paletteHeight.set(newHeight);
      };
      
      const onUp = () => {
          this.isResizingPalette = false;
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
      };
      
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
  }

  startPaletteResizeTouch(e: TouchEvent) {
      if (e.touches.length !== 1) return;
      e.preventDefault();
      this.isResizingPalette = true;
      this.startY = e.touches[0].clientY;
      this.startHeight = this.paletteHeight();
      
      const onMove = (ev: TouchEvent) => {
          if (!this.isResizingPalette || ev.touches.length !== 1) return;
          ev.preventDefault();
          const delta = ev.touches[0].clientY - this.startY;
          const newHeight = Math.max(80, Math.min(500, this.startHeight + delta));
          this.paletteHeight.set(newHeight);
      };
      
      const onEnd = () => {
          this.isResizingPalette = false;
          window.removeEventListener('touchmove', onMove);
          window.removeEventListener('touchend', onEnd);
          window.removeEventListener('touchcancel', onEnd);
      };
      
      window.addEventListener('touchmove', onMove, { passive: false });
      window.addEventListener('touchend', onEnd);
      window.addEventListener('touchcancel', onEnd);
  }

  // 底部抽屉拖动开始
  startDrawerResize(event: TouchEvent) {
      if (event.touches.length !== 1) return;
      event.preventDefault();
      this.isResizingDrawer = true;
      this.isResizingDrawerSignal.set(true); // 开始拖动，禁用按钮过渡
      this.drawerStartY = event.touches[0].clientY;
      this.drawerStartHeight = this.drawerHeight();
      
      const onMove = (ev: TouchEvent) => {
          if (!this.isResizingDrawer || ev.touches.length !== 1) return;
          ev.preventDefault();
          // 向上拖动增加高度，向下拖动减少高度
          const deltaY = this.drawerStartY - ev.touches[0].clientY;
          const deltaVh = (deltaY / window.innerHeight) * 100;
          const newHeight = Math.max(15, Math.min(70, this.drawerStartHeight + deltaVh));
          this.drawerHeight.set(newHeight);
      };
      
      const onEnd = () => {
          this.isResizingDrawer = false;
          this.isResizingDrawerSignal.set(false); // 结束拖动，恢复按钮过渡
          // 如果高度太小，关闭抽屉
          if (this.drawerHeight() < 20) {
              this.store.isFlowDetailOpen.set(false);
              this.drawerHeight.set(35); // 重置高度
          }
          window.removeEventListener('touchmove', onMove);
          window.removeEventListener('touchend', onEnd);
          window.removeEventListener('touchcancel', onEnd);
      };
      
      window.addEventListener('touchmove', onMove, { passive: false });
      window.addEventListener('touchend', onEnd);
      window.addEventListener('touchcancel', onEnd);
  }

  // 抽屉内容区域触摸事件 - 允许内容滚动
  onDrawerTouchStart(e: TouchEvent) {
    // 如果是在拖动条上开始的触摸，不处理
    if ((e.target as HTMLElement).closest('.touch-none')) return;
    this.drawerScrollStartY = e.touches[0].clientY;
    this.isDrawerScrolling = false;
  }
  
  onDrawerTouchMove(e: TouchEvent) {
    // 如果正在调整高度，不处理
    if (this.isResizingDrawer) return;
    
    const deltaY = e.touches[0].clientY - this.drawerScrollStartY;
    // 检查内容区域是否可以滚动
    const contentEl = (e.currentTarget as HTMLElement).querySelector('.overflow-y-auto');
    if (contentEl) {
      const canScrollUp = contentEl.scrollTop > 0;
      const canScrollDown = contentEl.scrollTop < contentEl.scrollHeight - contentEl.clientHeight;
      
      // 如果内容可以滚动，让它正常滚动
      if ((deltaY > 0 && canScrollUp) || (deltaY < 0 && canScrollDown)) {
        this.isDrawerScrolling = true;
        return; // 允许默认滚动行为
      }
    }
  }
  
  onDrawerTouchEnd(e: TouchEvent) {
    this.isDrawerScrolling = false;
  }

  // 移动端待分配块触摸拖动
  onUnassignedTouchStart(e: TouchEvent, task: Task) {
    if (e.touches.length !== 1) return;
    
    const touch = e.touches[0];
    this.unassignedTouchState = {
      task,
      startX: touch.clientX,
      startY: touch.clientY,
      isDragging: false,
      longPressTimer: null,
      ghost: null
    };
    
    // 长按 200ms 后开始拖拽
    this.unassignedTouchState.longPressTimer = setTimeout(() => {
      this.unassignedTouchState.isDragging = true;
      this.unassignedDraggingId.set(task.id);
      this.createUnassignedGhost(task, touch.clientX, touch.clientY);
      if (navigator.vibrate) navigator.vibrate(50);
    }, 200);
  }
  
  onUnassignedTouchMove(e: TouchEvent) {
    if (!this.unassignedTouchState.task || e.touches.length !== 1) return;
    
    const touch = e.touches[0];
    const deltaX = Math.abs(touch.clientX - this.unassignedTouchState.startX);
    const deltaY = Math.abs(touch.clientY - this.unassignedTouchState.startY);
    
    // 如果移动超过阈值但还没开始拖拽，取消长按
    if (!this.unassignedTouchState.isDragging && (deltaX > 10 || deltaY > 10)) {
      if (this.unassignedTouchState.longPressTimer) {
        clearTimeout(this.unassignedTouchState.longPressTimer);
        this.unassignedTouchState.longPressTimer = null;
      }
      return;
    }
    
    if (this.unassignedTouchState.isDragging) {
      e.preventDefault();
      // 更新幽灵元素位置
      if (this.unassignedTouchState.ghost) {
        this.unassignedTouchState.ghost.style.left = `${touch.clientX - 40}px`;
        this.unassignedTouchState.ghost.style.top = `${touch.clientY - 20}px`;
      }
    }
  }
  
  onUnassignedTouchEnd(e: TouchEvent) {
    if (this.unassignedTouchState.longPressTimer) {
      clearTimeout(this.unassignedTouchState.longPressTimer);
    }
    
    const { task, isDragging } = this.unassignedTouchState;
    
    // 移除幽灵元素
    if (this.unassignedTouchState.ghost) {
      this.unassignedTouchState.ghost.remove();
    }
    
    if (task && isDragging && this.diagram) {
      // 获取触摸结束位置
      const touch = e.changedTouches[0];
      const diagramRect = this.diagramDiv.nativeElement.getBoundingClientRect();
      
      // 检查是否在流程图区域内
      if (touch.clientX >= diagramRect.left && touch.clientX <= diagramRect.right &&
          touch.clientY >= diagramRect.top && touch.clientY <= diagramRect.bottom) {
        // 转换为流程图坐标
        const x = touch.clientX - diagramRect.left;
        const y = touch.clientY - diagramRect.top;
        const pt = new go.Point(x, y);
        const loc = this.diagram.transformViewToDoc(pt);
        
        // 查找插入位置
        const insertInfo = this.findInsertPosition(loc);
        
        if (insertInfo.parentId) {
          const parentTask = this.store.tasks().find(t => t.id === insertInfo.parentId);
          if (parentTask) {
            const newStage = (parentTask.stage || 1) + 1;
            this.store.moveTaskToStage(task.id, newStage, insertInfo.beforeTaskId, insertInfo.parentId);
            setTimeout(() => this.store.updateTaskPosition(task.id, loc.x, loc.y), 100);
          }
        } else if (insertInfo.beforeTaskId || insertInfo.afterTaskId) {
          const refTask = this.store.tasks().find(t => t.id === (insertInfo.beforeTaskId || insertInfo.afterTaskId));
          if (refTask?.stage) {
            this.store.moveTaskToStage(task.id, refTask.stage, insertInfo.beforeTaskId, refTask.parentId);
            setTimeout(() => this.store.updateTaskPosition(task.id, loc.x, loc.y), 100);
          }
        } else {
          // 没有靠近任何节点，只更新位置
          this.store.updateTaskPosition(task.id, loc.x, loc.y);
        }
      }
    }
    
    this.unassignedDraggingId.set(null);
    this.unassignedTouchState = {
      task: null, startX: 0, startY: 0, isDragging: false, longPressTimer: null, ghost: null
    };
  }
  
  private createUnassignedGhost(task: Task, x: number, y: number) {
    const ghost = document.createElement('div');
    ghost.className = 'fixed z-[9999] px-3 py-2 bg-teal-500/90 text-white rounded-lg shadow-xl text-xs font-medium pointer-events-none whitespace-nowrap';
    ghost.textContent = task.title || '未命名';
    ghost.style.left = `${x - 40}px`;
    ghost.style.top = `${y - 20}px`;
    document.body.appendChild(ghost);
    this.unassignedTouchState.ghost = ghost;
  }

  ngAfterViewInit() {
      this.initDiagram();
      // 初始化完成后立即加载图表数据
      setTimeout(() => {
          if (this.diagram) {
              this.updateDiagram(this.store.tasks());
          }
      }, 100);
      
      // 监听容器大小变化（侧边栏拖动时触发）
      this.setupResizeObserver();
  }
  
  ngOnDestroy() {
      // 清理 ResizeObserver
      if (this.resizeObserver) {
          this.resizeObserver.disconnect();
          this.resizeObserver = null;
      }
      // 清理定时器
      if (this.positionSaveTimer) {
          clearTimeout(this.positionSaveTimer);
          this.positionSaveTimer = null;
      }
      if (this.resizeDebounceTimer) {
          clearTimeout(this.resizeDebounceTimer);
          this.resizeDebounceTimer = null;
      }
      // 清理待分配块长按定时器
      if (this.unassignedTouchState.longPressTimer) {
          clearTimeout(this.unassignedTouchState.longPressTimer);
      }
      // 清理幽灵元素
      if (this.unassignedTouchState.ghost) {
          this.unassignedTouchState.ghost.remove();
      }
  }
  
  private setupResizeObserver() {
      if (!this.diagramDiv?.nativeElement) return;
      
      this.resizeObserver = new ResizeObserver((entries) => {
          // 防抖动处理
          if (this.resizeDebounceTimer) {
              clearTimeout(this.resizeDebounceTimer);
          }
          this.resizeDebounceTimer = setTimeout(() => {
              if (this.diagram) {
                  // 获取新的容器尺寸
                  const div = this.diagramDiv.nativeElement;
                  const width = div.clientWidth;
                  const height = div.clientHeight;
                  
                  // 如果尺寸有效，重新设置 diagram 的 div 并请求更新
                  if (width > 0 && height > 0) {
                      // 强制 GoJS 重新计算画布大小
                      this.diagram.div = null;
                      this.diagram.div = div;
                      this.diagram.requestUpdate();
                  }
              }
          }, 100);
      });
      
      this.resizeObserver.observe(this.diagramDiv.nativeElement);
  }
  
  private resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  initDiagram() {
      if (typeof go === 'undefined') {
          console.warn('❌ GoJS not loaded');
          return;
      }
      
      const $ = go.GraphObject.make;

      this.diagram = $(go.Diagram, this.diagramDiv.nativeElement, {
          // 禁用 GoJS 内置的 UndoManager，避免与 Store 状态分裂
          // 撤销/重做应通过全局状态管理实现
          "undoManager.isEnabled": false,
          "animationManager.isEnabled": false, // 禁用动画提升性能
          "allowDrop": true,
          // 默认不使用自动布局，保持用户手动调整的位置
          layout: $(go.Layout),
          
          // === 性能优化配置 ===
          "autoScale": go.Diagram.None,
          "initialAutoScale": go.Diagram.None,
          "scrollMargin": 100,
          "draggingTool.isGridSnapEnabled": false
      });
      
      // 监听节点移动完成（拖动结束时才保存，而非实时保存）
      this.diagram.addDiagramListener('SelectionMoved', (e: any) => {
          // 使用防抖，避免多选拖动时频繁保存
          if (this.positionSaveTimer) {
              clearTimeout(this.positionSaveTimer);
          }
          this.positionSaveTimer = setTimeout(() => {
              e.subject.each((part: any) => {
                  if (part instanceof go.Node) {
                      const loc = part.location;
                      this.zone.run(() => {
                          this.store.updateTaskPosition(part.data.key, loc.x, loc.y);
                      });
                  }
              });
          }, 300);
      });
      
      // 监听节点拖拽结束
      this.diagram.addDiagramListener('PartResized', (e: any) => {
          // 保存所有节点位置
          this.saveAllNodePositions();
      });

      // Helper to create ports
      function makePort(name: string, spot: any, output: boolean, input: boolean) {
        return $(go.Shape, "Circle",
          {
            fill: "transparent",
            stroke: null,
            desiredSize: new go.Size(10, 10),
            alignment: spot,
            alignmentFocus: spot,
            portId: name,
            fromLinkable: output,
            toLinkable: input,
            cursor: "pointer",
            fromSpot: spot,
            toSpot: spot,
            mouseEnter: (e: any, port: any) => { if (!e.diagram.isReadOnly) port.fill = "#a8a29e"; },
            mouseLeave: (e: any, port: any) => port.fill = "transparent"
          });
      }

      // Node Template
      this.diagram.nodeTemplate =
          $(go.Node, "Spot",
            { 
                locationSpot: go.Spot.Center,
                selectionAdorned: true,
                click: (e: any, node: any) => {
                    if (e.diagram.lastInput.dragging) return;
                    this.zone.run(() => {
                        // 检查是否在连接模式
                        if (this.isLinkMode()) {
                            this.handleLinkModeClick(node.data.key);
                        } else {
                            // 单击选中节点
                            this.selectedTaskId.set(node.data.key);
                        }
                    });
                },
                doubleClick: (e: any, node: any) => {
                    // 双击打开详情面板并选中节点
                    this.zone.run(() => {
                        this.selectedTaskId.set(node.data.key);
                        this.store.isFlowDetailOpen.set(true);
                    });
                }
            },
            new go.Binding("location", "loc", go.Point.parse).makeTwoWay(go.Point.stringify),
            
            // Main Content - 待分配任务节点更小更紧凑，已分配任务节点正常大小
            $(go.Panel, "Auto",
                new go.Binding("width", "isUnassigned", (isUnassigned: boolean) => isUnassigned ? 140 : 200),
                $(go.Shape, "RoundedRectangle", 
                  { 
                      fill: "white", 
                      stroke: "#e7e5e4", 
                      strokeWidth: 1, 
                      parameter1: 10,
                      // Make the body NOT linkable, so it's draggable
                      portId: "", 
                      fromLinkable: false, 
                      toLinkable: false, 
                      cursor: "move" 
                  },
                  new go.Binding("fill", "color"),
                  // 待分配任务使用深青色边框和背景，已分配任务使用默认边框
                  new go.Binding("stroke", "", (data: any, obj: any) => {
                      if (obj.part.isSelected) return "#0d9488"; // teal-600
                      return data.isUnassigned ? "#14b8a6" : "#e7e5e4"; // teal-500 vs stone-200
                  }).ofObject(),
                  new go.Binding("strokeWidth", "isUnassigned", (isUnassigned: boolean) => isUnassigned ? 2 : 1)
                ),
                $(go.Panel, "Vertical",
                    new go.Binding("margin", "isUnassigned", (isUnassigned: boolean) => isUnassigned ? 10 : 16),
                    $(go.TextBlock, { font: "bold 9px sans-serif", stroke: "#78716C", alignment: go.Spot.Left },
                        new go.Binding("text", "displayId"),
                        new go.Binding("visible", "isUnassigned", (isUnassigned: boolean) => !isUnassigned)),
                    $(go.TextBlock, { margin: new go.Margin(4, 0, 0, 0), font: "400 12px sans-serif", stroke: "#57534e" },
                        new go.Binding("text", "title"),
                        new go.Binding("font", "isUnassigned", (isUnassigned: boolean) => isUnassigned ? "500 11px sans-serif" : "400 12px sans-serif"),
                        new go.Binding("stroke", "isUnassigned", (isUnassigned: boolean) => isUnassigned ? "#0f766e" : "#57534e"), // teal-700 vs stone-600
                        new go.Binding("maxSize", "isUnassigned", (isUnassigned: boolean) => isUnassigned ? new go.Size(120, NaN) : new go.Size(160, NaN)))
                )
            ),

            // Ports
            makePort("T", go.Spot.Top, true, true),
            makePort("L", go.Spot.Left, true, true),
            makePort("R", go.Spot.Right, true, true),
            makePort("B", go.Spot.Bottom, true, true)
          );

      // Link Template - 支持父子连接和跨树连接的不同样式
      this.diagram.linkTemplate =
          $(go.Link, 
            { 
                routing: go.Link.AvoidsNodes, 
                curve: go.Link.JumpOver, 
                corner: 12,
                toShortLength: 4,
                relinkableFrom: true,
                relinkableTo: true,
                reshapable: true,
                resegmentable: true,
                // 点击连接线 - 移动端长按删除
                click: (e: any, link: any) => {
                    // 选中连接线
                    e.diagram.select(link);
                },
                // 右键菜单删除连接
                contextMenu: $(go.Adornment, "Vertical",
                  $("ContextMenuButton",
                    $(go.TextBlock, "删除连接", { margin: 5 }),
                    { click: (e: any, obj: any) => this.deleteLinkFromContext(obj.part) }
                  )
                )
            },
            // Transparent fat line for easier selection - 移动端加粗方便点击
            $(go.Shape, { isPanelMain: true, strokeWidth: this.store.isMobile() ? 16 : 8, stroke: "transparent" }),
            // Visible line - 根据连接类型显示不同样式
            $(go.Shape, { isPanelMain: true, strokeWidth: 2 },
              new go.Binding("stroke", "isCrossTree", (isCross: boolean) => isCross ? "#6366f1" : "#94a3b8"),
              new go.Binding("strokeDashArray", "isCrossTree", (isCross: boolean) => isCross ? [6, 3] : null)
            ),
            // Arrowhead
            $(go.Shape, { toArrow: "Standard", stroke: null, scale: 1.2 },
              new go.Binding("fill", "isCrossTree", (isCross: boolean) => isCross ? "#6366f1" : "#94a3b8")
            ),
            // 联系块 - 只在跨树连接（虚线）上显示，紧凑设计
            $(go.Panel, "Auto",
              { 
                segmentIndex: NaN,  // 自动居中于连接线
                segmentFraction: 0.5,
                cursor: "pointer",
                click: (e: any, panel: any) => {
                  // 阻止事件冒泡，避免选中连接线
                  e.handled = true;
                  const linkData = panel.part?.data;
                  if (linkData?.isCrossTree) {
                    // 获取点击位置相对于流程图容器
                    const diagramDiv = this.diagram?.div;
                    if (diagramDiv) {
                      const rect = diagramDiv.getBoundingClientRect();
                      const clickX = e.event.pageX - rect.left;
                      const clickY = e.event.pageY - rect.top;
                      this.zone.run(() => {
                        this.openConnectionEditor(linkData.from, linkData.to, linkData.description || '', clickX, clickY);
                      });
                    }
                  }
                }
              },
              new go.Binding("visible", "isCrossTree", (isCross: boolean) => isCross),
              // 联系块背景 - 更小更紧凑
              $(go.Shape, "RoundedRectangle", 
                { 
                  fill: "#f5f3ff", // violet-50
                  stroke: "#8b5cf6", // violet-500
                  strokeWidth: 1,
                  parameter1: 4
                }
              ),
              // 联系块内容 - 紧凑布局
              $(go.Panel, "Horizontal",
                { margin: 3, defaultAlignment: go.Spot.Center },
                // 联系图标
                $(go.TextBlock, "🔗", { font: "8px sans-serif" }),
                // 描述文本（如果有）- 只显示简短文本
                $(go.TextBlock, 
                  { 
                    font: "500 8px sans-serif", 
                    stroke: "#6d28d9", // violet-700
                    maxSize: new go.Size(50, 14),
                    overflow: go.TextBlock.OverflowEllipsis,
                    margin: new go.Margin(0, 0, 0, 2)
                  },
                  new go.Binding("text", "description", (desc: string) => desc ? desc.substring(0, 6) : "...")
                )
              )
            )
          );
      
      // 移动端: 连接线长按删除
      if (this.store.isMobile()) {
        let linkLongPressTimer: any = null;
        let longPressedLink: any = null;
        
        this.diagram.addDiagramListener('ObjectSingleClicked', (e: any) => {
          const part = e.subject.part;
          if (part instanceof go.Link) {
            // 选中连接线时显示删除提示
            this.zone.run(() => {
              this.showLinkDeleteHint(part);
            });
          }
        });
      }

      // Initialize model with linkKeyProperty for proper merging
      this.diagram.model = new go.GraphLinksModel([], [], { 
          linkKeyProperty: 'key',
          nodeKeyProperty: 'key'
      });

      // Handle External Drops - 支持拖放到两个节点之间插入
      this.diagram.div.addEventListener("dragover", (e: DragEvent) => {
          e.preventDefault();
          if (e.dataTransfer) {
              e.dataTransfer.dropEffect = 'move';
          }
      });

      this.diagram.div.addEventListener("drop", (e: DragEvent) => {
          e.preventDefault();
          // 尝试两种数据格式
          let data = e.dataTransfer?.getData("application/json") || e.dataTransfer?.getData("text");
          if (!data) return;
          
          try {
              const task = JSON.parse(data);
              const pt = this.diagram.lastInput.viewPoint;
              const loc = this.diagram.transformViewToDoc(pt);
              
              // 查找拖放位置附近的节点，判断是否插入到两个节点之间
              const insertInfo = this.findInsertPosition(loc);
              
              if (insertInfo.parentId) {
                  // 插入为某个节点的子节点
                  const parentTask = this.store.tasks().find(t => t.id === insertInfo.parentId);
                  if (parentTask) {
                      const newStage = (parentTask.stage || 1) + 1;
                      this.store.moveTaskToStage(task.id, newStage, insertInfo.beforeTaskId, insertInfo.parentId);
                      // 更新拖放位置
                      setTimeout(() => {
                          this.store.updateTaskPosition(task.id, loc.x, loc.y);
                      }, 100);
                  }
              } else if (insertInfo.beforeTaskId) {
                  // 插入到某个节点之前（同级）
                  const beforeTask = this.store.tasks().find(t => t.id === insertInfo.beforeTaskId);
                  if (beforeTask && beforeTask.stage) {
                      this.store.moveTaskToStage(task.id, beforeTask.stage, insertInfo.beforeTaskId, beforeTask.parentId);
                      // 更新拖放位置
                      setTimeout(() => {
                          this.store.updateTaskPosition(task.id, loc.x, loc.y);
                      }, 100);
                  }
              } else if (insertInfo.afterTaskId) {
                  // 插入到某个节点之后（同级）
                  const afterTask = this.store.tasks().find(t => t.id === insertInfo.afterTaskId);
                  if (afterTask && afterTask.stage) {
                      // 找到 afterTask 的下一个同级节点
                      const siblings = this.store.tasks()
                          .filter(t => t.stage === afterTask.stage && t.parentId === afterTask.parentId)
                          .sort((a, b) => a.rank - b.rank);
                      const afterIndex = siblings.findIndex(t => t.id === afterTask.id);
                      const nextSibling = siblings[afterIndex + 1];
                      this.store.moveTaskToStage(task.id, afterTask.stage, nextSibling?.id || null, afterTask.parentId);
                      // 更新拖放位置
                      setTimeout(() => {
                          this.store.updateTaskPosition(task.id, loc.x, loc.y);
                      }, 100);
                  }
              } else {
                  // 如果没有靠近任何节点，保持待分配状态，只更新位置让它显示在流程图中
                  this.store.updateTaskPosition(task.id, loc.x, loc.y);
              }
          } catch (err) {
              console.error('Drop error:', err);
          }
      });

      this.diagram.addDiagramListener('LinkDrawn', (e: any) => this.handleLinkGesture(e));
      this.diagram.addDiagramListener('LinkRelinked', (e: any) => this.handleLinkGesture(e));
      
      // 点击背景时关闭联系块编辑器
      this.diagram.addDiagramListener('BackgroundSingleClicked', () => {
        this.zone.run(() => {
          this.closeConnectionEditor();
        });
      });
  }
  
  // 根据拖放位置查找插入点
  private findInsertPosition(loc: any): { parentId?: string; beforeTaskId?: string; afterTaskId?: string } {
      if (!this.diagram) return {};
      
      const threshold = 120; // 检测范围（像素）- 增大以便更容易捕获
      let closestNode: any = null;
      let closestDistance = Infinity;
      let insertPosition: string = 'after';
      
      // 遍历所有节点找最近的（只查找已分配的节点，跳过待分配节点）
      this.diagram.nodes.each((node: any) => {
          // 跳过待分配节点（isUnassigned 为 true 或 stage 为 null）
          if (node.data?.isUnassigned || node.data?.stage === null) {
              return;
          }
          
          const nodeLoc = node.location;
          const dx = loc.x - nodeLoc.x;
          const dy = loc.y - nodeLoc.y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          
          if (distance < threshold && distance < closestDistance) {
              closestDistance = distance;
              closestNode = node;
              
              // 根据相对位置判断插入方式
              // 如果在节点右侧较远，可能是子节点
              // 如果在节点上方，插入到前面
              // 如果在节点下方，插入到后面
              if (dx > 100) {
                  insertPosition = 'child';
              } else if (dy < -30) {
                  insertPosition = 'before';
              } else {
                  insertPosition = 'after';
              }
          }
      });
      
      if (!closestNode) return {};
      
      const nodeId = closestNode.data.key;
      
      if (insertPosition === 'child') {
          return { parentId: nodeId };
      } else if (insertPosition === 'before') {
          return { beforeTaskId: nodeId };
      } else {
          return { afterTaskId: nodeId };
      }
  }

  updateDiagram(tasks: Task[]) {
      if (!this.diagram) {
          console.warn('❌ updateDiagram: diagram not initialized');
          return;
      }
      
      const model = this.diagram.model;
      if (!model) {
          console.warn('❌ updateDiagram: model not found');
          return;
      }
      
      const project = this.store.activeProject();
      if (!project) {
          console.warn('❌ updateDiagram: no active project');
          return;
      }
      
      // 检查更新类型：如果是仅位置更新，跳过重建
      const lastUpdateType = this.store.getLastUpdateType();
      if (lastUpdateType === 'position') {
          // 位置更新已由 SelectionMoved 监听器处理，不需要重建
          return;
      }
      
      // 获取所有任务（包括待分配的），只要任务有位置信息或 stage 就显示
      // 待分配任务如果被拖入流程图（有位置信息）也会显示
      // stage 可能是 null 或 undefined，都要处理
      const tasksToShow = tasks.filter(t => t.stage != null || (t.x !== 0 || t.y !== 0));
      
      // 保存当前选中状态
      const selectedKeys = new Set<string>();
      this.diagram.selection.each((part: any) => {
          if (part.data?.key) {
              selectedKeys.add(part.data.key);
          }
      });
      
      // Build a map of existing node data to detect actual changes
      const existingNodeMap = new Map<string, any>();
      (model as any).nodeDataArray.forEach((n: any) => {
          if (n.key) {
              existingNodeMap.set(n.key, n);
          }
      });
      
      const nodeDataArray: any[] = [];
      const linkDataArray: any[] = [];
      
      // 构建父子关系集合
      const parentChildPairs = new Set<string>();
      tasksToShow.filter(t => t.parentId).forEach(t => {
          parentChildPairs.add(`${t.parentId}->${t.id}`);
      });
      
      // 用于新节点的位置计算
      let newNodeIndex = 0;

      tasksToShow.forEach(t => {
          const existingNode = existingNodeMap.get(t.id);
          let loc: string;
          
          if (existingNode?.loc) {
              // 优先保持现有位置（用户拖动后的位置）
              loc = existingNode.loc;
          } else if (t.x !== 0 || t.y !== 0) {
              // 使用 store 中保存的位置
              loc = `${t.x} ${t.y}`;
          } else {
              // 新节点：根据阶段和顺序计算初始位置
              const stageX = ((t.stage || 1) - 1) * 150;
              const indexY = newNodeIndex * 100;
              loc = `${stageX} ${indexY}`;
              newNodeIndex++;
          }
          
          // 待分配任务使用较深的青色背景，已分配任务使用白色/绿色背景
          const nodeColor = t.stage === null ? '#ccfbf1' : (t.status === 'completed' ? '#f0fdf4' : 'white'); // teal-100 vs white
          const borderColor = t.stage === null ? '#14b8a6' : '#e7e5e4'; // teal-500 vs stone-200
          
          nodeDataArray.push({
              key: t.id,
              title: t.title || '未命名任务',
              displayId: this.store.compressDisplayId(t.displayId),
              stage: t.stage, // Add stage info for drag computation
              loc: loc,
              color: nodeColor,
              borderColor: borderColor,
              isUnassigned: t.stage === null,
              isSelected: false // handled by diagram selection
          });
          
          // 添加父子连接（实线）
          if (t.parentId) {
              linkDataArray.push({ 
                  key: `${t.parentId}-${t.id}`,
                  from: t.parentId, 
                  to: t.id,
                  isCrossTree: false
              });
          }
      });
      
      // 添加跨树连接（虚线）- 从 project.connections 中获取非父子关系的连接
      project.connections.forEach(conn => {
          const pairKey = `${conn.source}->${conn.target}`;
          // 如果不是父子关系，则是跨树连接
          if (!parentChildPairs.has(pairKey)) {
              // 确保两个节点都在当前显示的任务中
              const sourceExists = tasksToShow.some(t => t.id === conn.source);
              const targetExists = tasksToShow.some(t => t.id === conn.target);
              if (sourceExists && targetExists) {
                  linkDataArray.push({
                      key: `cross-${conn.source}-${conn.target}`,
                      from: conn.source,
                      to: conn.target,
                      isCrossTree: true,
                      description: conn.description || '' // 联系块描述
                  });
              }
          }
      });

      this.diagram.startTransaction('update');
      
      // Skip layout temporarily to prevent view reset
      this.diagram.skipsUndoManager = true;
      
      // Use merge methods to preserve diagram state (zoom, pan, etc.)
      (model as any).mergeNodeDataArray(nodeDataArray);
      (model as any).mergeLinkDataArray(linkDataArray);
      
      // Remove stale nodes/links not present anymore
      const nodeKeys = new Set(nodeDataArray.map(n => n.key));
      const linkKeys = new Set(linkDataArray.map(l => l.key));
      
      // 先收集要删除的节点，再统一删除（避免遍历时修改数组）
      const nodesToRemove = (model as any).nodeDataArray
        .filter((n: any) => !nodeKeys.has(n.key));
      nodesToRemove.forEach((n: any) => (model as any).removeNodeData(n));
      
      const linksToRemove = (model as any).linkDataArray
        .filter((l: any) => !linkKeys.has(l.key));
      linksToRemove.forEach((l: any) => (model as any).removeLinkData(l));
      
      this.diagram.skipsUndoManager = false;
      this.diagram.commitTransaction('update');
      
      // 恢复选中状态
      if (selectedKeys.size > 0) {
          this.diagram.nodes.each((node: any) => {
              if (selectedKeys.has(node.data?.key)) {
                  node.isSelected = true;
              }
          });
      }
  }

  createUnassigned() {
      this.store.addTask('新任务', '', null, null, false);
  }

  onDragStart(event: DragEvent, task: Task) {
      if (event.dataTransfer) {
          event.dataTransfer.setData("text", JSON.stringify(task));
          event.dataTransfer.effectAllowed = "move";
      }
  }

  // 点击待分配任务块，在流程图中定位到该任务节点
  onUnassignedTaskClick(task: Task) {
      // 如果任务有位置信息（已被拖入过流程图），则定位到它
      if (task.x !== 0 || task.y !== 0) {
          this.centerOnNode(task.id);
      } else {
          // 没有位置信息，只选中任务显示详情
          this.selectedTaskId.set(task.id);
          this.store.isFlowDetailOpen.set(true);
      }
  }

  centerOnNode(taskId: string, openDetail: boolean = true) {
      if (!this.diagram) return;
      const node = this.diagram.findNodeForKey(taskId);
      if (node) {
          this.diagram.centerRect(node.actualBounds);
          this.diagram.select(node);
          // 选中任务
          this.selectedTaskId.set(taskId);
          if (openDetail) {
              this.store.isFlowDetailOpen.set(true);
          }
      } else {
          // 任务可能未分配阶段，仍然选中
          this.selectedTaskId.set(taskId);
          if (openDetail) {
              this.store.isFlowDetailOpen.set(true);
          }
      }
  }

  // 窗口大小变化时重新调整图表（ResizeObserver 会处理容器大小变化，这里主要处理全屏等场景）
  @HostListener('window:resize')
  onWindowResize() {
      // ResizeObserver 已经在监听容器变化，这里不需要重复处理
      // 但保留作为后备
      if (this.diagram && !this.resizeObserver) {
          setTimeout(() => {
              this.diagram.requestUpdate();
          }, 100);
      }
  }

  @HostListener('window:keydown', ['$event'])
  handleDiagramShortcut(event: KeyboardEvent) {
      if (!this.diagram) return;
      if (!event.altKey) return;
      
      const key = event.key.toLowerCase();
      
      // Alt+Z: 解除父子关系
      if (key === 'z') {
          const targets: string[] = [];
          const it = this.diagram.selection?.iterator;
          if (it) {
              while (it.next()) {
                  const part = it.value;
                  const nodeKey = part?.data?.key;
                  const isNode = typeof go !== 'undefined' ? part instanceof go.Node : !part?.category;
                  if (isNode && nodeKey) {
                      targets.push(nodeKey);
                  }
              }
          }

          if (!targets.length) return;
          event.preventDefault();
          event.stopPropagation();

          this.zone.run(() => {
              targets.forEach(id => this.store.detachTask(id));
          });
          return;
      }
      
      // Alt+X: 删除选中的连接线（跨树连接）
      if (key === 'x') {
          const linksToDelete: any[] = [];
          const it = this.diagram.selection?.iterator;
          if (it) {
              while (it.next()) {
                  const part = it.value;
                  // 判断是否是连接线：有 fromNode 和 toNode 属性，或者是 go.Link 实例
                  const isLink = part && (part.fromNode !== undefined || part instanceof go.Link);
                  if (isLink && part?.data?.isCrossTree) {
                      linksToDelete.push(part);
                  }
              }
          }
          
          if (!linksToDelete.length) return;
          event.preventDefault();
          event.stopPropagation();
          
          this.zone.run(() => {
              linksToDelete.forEach(link => {
                  const fromKey = link.data?.from;
                  const toKey = link.data?.to;
                  if (fromKey && toKey) {
                      this.store.removeConnection(fromKey, toKey);
                  }
              });
              setTimeout(() => this.updateDiagram(this.store.tasks()), 50);
          });
          return;
      }
  }

    private handleLinkGesture(e: any) {
            if (!this.diagram) return;
            const link = e.subject;
            const fromNode = link?.fromNode;
            const toNode = link?.toNode;
            const parentId = fromNode?.data?.key;
            const childId = toNode?.data?.key;
            if (!parentId || !childId || parentId === childId) return;

            // 检查目标节点是否已有父节点
            const childTask = this.store.tasks().find(t => t.id === childId);
            if (childTask?.parentId) {
                // 如果已有父节点，创建跨树连接（虚线）而不是父子关系
                this.diagram.remove(link);
                this.zone.run(() => {
                    this.store.addCrossTreeConnection(parentId, childId);
                    setTimeout(() => this.updateDiagram(this.store.tasks()), 50);
                });
                return;
            }

            const parentStage = typeof fromNode.data?.stage === 'number' ? fromNode.data.stage : null;
            const childStage = typeof toNode.data?.stage === 'number' ? toNode.data.stage : null;
            const nextStage = parentStage !== null ? parentStage + 1 : (childStage ?? 1);

            this.diagram.remove(link);
            this.zone.run(() => {
                    this.store.moveTaskToStage(childId, nextStage, undefined, parentId);
            });
    }
    
    // 移动端显示连接线删除提示
    showLinkDeleteHint(link: any) {
        if (!link || !this.diagram) return;
        
        // 获取连接线中点位置
        const midPoint = link.midPoint;
        if (!midPoint) return;
        
        // 转换为视口坐标
        const viewPt = this.diagram.transformDocToView(midPoint);
        const diagramRect = this.diagramDiv.nativeElement.getBoundingClientRect();
        
        this.linkDeleteHint.set({
            link,
            x: diagramRect.left + viewPt.x,
            y: diagramRect.top + viewPt.y
        });
        
        // 3秒后自动隐藏
        setTimeout(() => {
            if (this.linkDeleteHint()?.link === link) {
                this.linkDeleteHint.set(null);
            }
        }, 3000);
    }
    
    // 确认删除连接线
    confirmLinkDelete() {
        const hint = this.linkDeleteHint();
        if (!hint?.link) return;
        
        this.deleteLinkFromContext(hint.link);
        this.linkDeleteHint.set(null);
    }
    
    // 取消删除提示
    cancelLinkDelete() {
        this.linkDeleteHint.set(null);
    }
    
    // 从右键菜单删除连接
    private deleteLinkFromContext(link: any) {
        if (!link) return;
        const fromKey = link.data?.from;
        const toKey = link.data?.to;
        const isCrossTree = link.data?.isCrossTree;
        
        if (fromKey && toKey) {
            this.zone.run(() => {
                if (isCrossTree) {
                    // 删除跨树连接
                    this.store.removeConnection(fromKey, toKey);
                } else {
                    // 删除父子连接 - 将子任务解除父子关系
                    this.store.detachTask(toKey);
                }
                // 刷新图表
                setTimeout(() => this.updateDiagram(this.store.tasks()), 50);
            });
        }
    }
}
