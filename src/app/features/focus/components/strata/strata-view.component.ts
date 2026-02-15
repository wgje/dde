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
  computed
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
          <div data-testid="strata-view" class="h-full flex flex-col">
      
      <!-- 统计摘要 -->
      <div class="px-3 py-2 bg-stone-800/70
                  border-b border-stone-700/70
                  flex items-center justify-between text-[10px]
                  text-stone-300 shrink-0">
        <span>本周完成 {{ weeklyCount() }} 项</span>
        <span>共 {{ totalCount() }} 项</span>
      </div>
      
      <!-- 地质层列表 -->
      <div class="flex-1 overflow-y-auto" role="list" aria-label="已完成任务列表">
        @for (layer of layers(); track layer.date; let i = $index) {
          <app-strata-layer 
            [layer]="layer"
            [index]="i" />
        }
        
        <!-- 空状态 -->
        @if (layers().length === 0) {
          <div class="py-6 text-center text-xs text-stone-500">
            <p class="mb-1">还没有完成的项目</p>
            <p class="opacity-60">完成任务后会在这里堆叠</p>
          </div>
        }
      </div>
      
      </div>
    }
  `,
  styles: [],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class StrataViewComponent implements OnInit {
  private strataService = inject(StrataService);
  private focusPrefs = inject(FocusPreferenceService);
  
  readonly layers = this.strataService.layers;
  readonly todayCount = this.strataService.todayCount;
  readonly totalCount = this.strataService.totalCount;
  readonly isEnabled = computed(() => this.focusPrefs.preferences().strataEnabled);
  
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
}
