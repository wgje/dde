/**
 * 沉积岩层视图组件（项目历史回顾）
 * 
 * 设计原则：
 * - 化石质感：暗色基底，低饱和度配色
 * - 阶梯感：越近的层越厚越亮，越远的层越薄越暗
 * - 支持将任务从历史中"挖掘"恢复为进行中
 */

import {
  Component,
  ChangeDetectionStrategy,
  inject,
  OnInit,
  computed,
  input,
  output,
  effect
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { StrataService } from '../../../../../services/strata.service';
import { FocusPreferenceService } from '../../../../../services/focus-preference.service';
import { ProjectStateService } from '../../../../../services/project-state.service';
import { StrataLayerComponent, StrataRestoreEvent } from './strata-layer.component';

@Component({
  selector: 'app-strata-view',
  standalone: true,
  imports: [CommonModule, StrataLayerComponent],
  template: `
    @if (shouldRender()) {
      <div data-testid="strata-view" class="h-full flex flex-col bg-stone-950/80 overflow-hidden">
      
        <!-- 统计摘要栏 -->
        <div class="px-3 py-1.5 bg-stone-950/90
                    border-b border-stone-800/40
                    flex items-center justify-between text-[9px]
                    text-stone-500 shrink-0">
          <span class="flex items-center gap-1.5">
            <span class="w-1 h-1 rounded-full bg-amber-700/50"></span>
            <span class="font-mono">本周 {{ weeklyCount() }} 项</span>
          </span>
          <span class="font-mono tracking-wider text-stone-600">
            {{ totalDays() }}天 · {{ totalCount() }}项
          </span>
        </div>
      
        <!-- 主内容区：深度标尺 + 沉积层 -->
        <div class="flex-1 overflow-y-auto strata-scroll" role="list" aria-label="项目历史沉积层">

          @if (layers().length > 0) {
            @for (layer of layers(); track layer.date; let i = $index) {
              <div class="flex strata-row">
                <!-- 深度标尺（紧凑） -->
                <div class="depth-ruler-cell w-7 shrink-0 relative flex items-start justify-end">
                  <div class="absolute inset-y-0 right-0 w-px bg-amber-700/15"></div>
                  <div class="absolute right-0 top-[9px]"
                       [class]="strataService.isMajorTick(layer.date) ? 'w-2 h-px bg-amber-600/35' : 'w-1 h-px bg-amber-700/20'">
                  </div>
                  <span class="text-[10px] font-mono leading-none mt-[5px] mr-1.5 select-none whitespace-nowrap"
                        [class]="strataService.isMajorTick(layer.date) ? 'text-amber-500/50' : 'text-stone-600/40'">
                    {{ strataService.getDepthLabel(layer.date) }}
                  </span>
                </div>
                <!-- 沉积岩层 -->
                <div class="flex-1 min-w-0" [style.margin-bottom.px]="1">
                  <app-strata-layer 
                    [layer]="layer"
                    [index]="i"
                    (restoreItem)="onRestoreItem($event)" />
                </div>
              </div>
            }
          
            <!-- 远古装饰层 -->
            @if (layers().length > 3) {
              <div class="flex strata-row">
                <div class="w-7 shrink-0 relative">
                  <div class="absolute inset-y-0 right-0 w-px bg-amber-700/10"></div>
                </div>
                <div class="flex-1 space-y-[1px] mt-[1px] opacity-30 pointer-events-none" aria-hidden="true">
                  <div class="h-[2px] bg-zinc-900/50 rounded-sm border-l-2 border-zinc-900/30"></div>
                  <div class="h-[2px] bg-zinc-950/40 rounded-sm border-l-2 border-zinc-950/20"></div>
                  <div class="h-[1px] bg-zinc-950/25 rounded-sm"></div>
                </div>
              </div>
            }
          }
        
          <!-- 空状态 -->
          @if (layers().length === 0) {
            <div class="py-8 text-center text-xs text-stone-700">
              <div class="mb-2 opacity-20 text-lg">◇</div>
              <p class="mb-1 text-stone-600/60 text-[10px]">尚无沉积层</p>
              <p class="text-[9px] text-stone-700/40">完成任务后会在这里形成地质层</p>
            </div>
          }
          
          <!-- 基岩标记 -->
          @if (layers().length > 0) {
            <div class="flex strata-row">
              <div class="w-7 shrink-0 relative">
                <div class="absolute top-0 h-1/2 right-0 w-px bg-amber-700/8"></div>
                <div class="absolute right-0 top-[7px] w-2 h-px bg-stone-700/20"></div>
              </div>
              <div class="flex-1 mt-1 mb-3 text-center opacity-15 select-none pointer-events-none">
                <span class="text-[7px] uppercase tracking-[0.3em] text-stone-700 font-mono">基岩层</span>
              </div>
            </div>
          }
        </div>
      
      </div>
    }
  `,
  styles: [`
    .strata-scroll::-webkit-scrollbar {
      width: 2px;
    }
    .strata-scroll::-webkit-scrollbar-track {
      background: transparent;
    }
    .strata-scroll::-webkit-scrollbar-thumb {
      background: rgba(87, 83, 78, 0.2);
      border-radius: 4px;
    }
    /* 每行标尺+层对齐 */
    .strata-row {
      min-height: 0;
    }
    /* 标尺单元格：高度由层内容驱动 */
    .depth-ruler-cell {
      align-self: stretch;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class StrataViewComponent implements OnInit {
  readonly strataService = inject(StrataService);
  private focusPrefs = inject(FocusPreferenceService);
  private projectState = inject(ProjectStateService);
  
  /** 绕过 strataEnabled 偏好检查，始终显示 */
  readonly alwaysShow = input<boolean>(false);

  /** 条目恢复事件：将 {id, type} 传递给宿主处理 */
  readonly restoreItem = output<StrataRestoreEvent>();

  readonly layers = this.strataService.layers;
  readonly todayCount = this.strataService.todayCount;
  readonly totalCount = this.strataService.totalCount;
  readonly totalDays = this.strataService.totalDays;

  readonly shouldRender = computed(() =>
    this.alwaysShow() || this.focusPrefs.preferences().strataEnabled
  );

  /** 响应式刷新 */
  private refreshEffect = effect(() => {
    this.projectState.tasks();
    this.strataService.refresh();
  });
  
  ngOnInit(): void {
    this.strataService.refresh();
  }
  
  weeklyCount(): number {
    return this.strataService.getWeeklyCount();
  }

  /**
   * 转发层的恢复事件（task 或 black_box）
   */
  onRestoreItem(event: StrataRestoreEvent): void {
    this.restoreItem.emit(event);
  }
}
