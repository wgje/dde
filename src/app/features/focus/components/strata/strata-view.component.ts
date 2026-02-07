/**
 * 地质层视图组件
 * 
 * 显示已完成任务的堆叠可视化
 */

import { 
  Component, 
  ChangeDetectionStrategy, 
  inject,
  OnInit,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { StrataService } from '../../../../../services/strata.service';
import { FocusPreferenceService } from '../../../../../services/focus-preference.service';
import { StrataLayerComponent } from './strata-layer.component';

@Component({
  selector: 'app-strata-view',
  standalone: true,
  imports: [CommonModule, StrataLayerComponent],
  template: `
        @if (isEnabled()) {
          <div class="rounded-xl bg-stone-100/60 dark:bg-stone-800/60 
            border border-stone-200/50 dark:border-stone-700/50 
            backdrop-blur-md overflow-hidden"
          data-testid="strata-view">
      
      <!-- 标题栏 -->
            <div
         class="px-3 py-2.5 cursor-pointer flex justify-between items-center
           group select-none hover:bg-stone-200/30 dark:hover:bg-stone-700/30
           transition-colors duration-150"
         role="button"
         tabindex="0"
         [attr.aria-expanded]="isExpanded()"
         aria-label="地质层"
         (click)="toggleExpand()"
         (keydown.enter)="toggleExpand()"
         (keydown.space)="toggleExpand(); $event.preventDefault()"
         data-testid="strata-toggle">
        <span class="font-bold text-stone-700 dark:text-stone-100 text-xs 
                     flex items-center gap-2">
          <span class="w-1.5 h-1.5 rounded-full bg-stone-400 
                       shadow-[0_0_6px_rgba(120,113,108,0.4)]"></span>
          🗻 地质层
          @if (todayCount() > 0) {
            <span class="bg-stone-500 text-white text-[9px] px-1.5 py-0.5 
                         rounded-full font-mono">
              +{{ todayCount() }}
            </span>
          }
        </span>
        <span 
          class="text-stone-300 dark:text-stone-500 text-[10px] 
                 transition-transform duration-300"
          [class.rotate-180]="isExpanded()">
          ▼
        </span>
      </div>
      
      <!-- 内容区 -->
      @if (isExpanded()) {
        <div class="animate-slide-down">
          
          <!-- 统计摘要 -->
          <div class="px-3 py-2 bg-stone-200/30 dark:bg-stone-700/30
                      border-t border-stone-200/50 dark:border-stone-600/30
                      flex items-center justify-between text-[10px]
                      text-stone-500 dark:text-stone-400">
            <span>本周完成 {{ weeklyCount() }} 项</span>
            <span>共 {{ totalCount() }} 项</span>
          </div>
          
          <!-- 地质层列表 -->
          <div class="max-h-64 overflow-y-auto" role="list" aria-label="已完成任务列表">
            @for (layer of layers(); track layer.date; let i = $index) {
              <app-strata-layer 
                [layer]="layer"
                [index]="i" />
            }
            
            <!-- 空状态 -->
            @if (layers().length === 0) {
              <div class="py-6 text-center text-xs text-stone-400 dark:text-stone-500">
                <p class="mb-1">还没有完成的项目</p>
                <p class="opacity-60">完成任务后会在这里堆叠</p>
              </div>
            }
          </div>
          
        </div>
      }
      
      </div>
    }
  `,
  styles: [`
    .animate-slide-down {
      animation: slide-down 0.2s ease-out;
    }
    
    @keyframes slide-down {
      from {
        opacity: 0;
        transform: translateY(-10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class StrataViewComponent implements OnInit {
  private strataService = inject(StrataService);
  private focusPrefs = inject(FocusPreferenceService);
  
  isExpanded = signal(false);
  
  readonly layers = this.strataService.layers;
  readonly todayCount = this.strataService.todayCount;
  readonly totalCount = this.strataService.totalCount;
  readonly isEnabled = () => this.focusPrefs.preferences().strataEnabled;
  
  ngOnInit(): void {
    // 刷新数据
    this.strataService.refresh();
  }
  
  /**
   * 获取本周完成数量
   */
  weeklyCount(): number {
    return this.strataService.getWeeklyCount();
  }
  
  /**
   * 切换展开状态
   */
  toggleExpand(): void {
    this.isExpanded.update(v => !v);
    
    // 展开时刷新数据
    if (this.isExpanded()) {
      this.strataService.refresh();
    }
  }
}
