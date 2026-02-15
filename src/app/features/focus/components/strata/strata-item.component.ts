/**
 * 地质层项目组件
 * 
 * 显示单个已完成项目
 */

import { 
  Component, 
  ChangeDetectionStrategy, 
  Input
} from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { StrataItem } from '../../../../../models';

@Component({
  selector: 'app-strata-item',
  standalone: true,
  imports: [CommonModule, DatePipe],
  template: `
    <div 
      class="strata-item p-1.5 rounded-lg mb-1 last:mb-0
             bg-stone-800/70
             hover:bg-stone-700/75
             transition-all duration-150"
      role="article"
      [attr.aria-label]="'已完成: ' + item.title"
      data-testid="strata-item">
      
      <div class="flex items-start gap-2">
        <!-- 类型图标 -->
        <span class="text-xs flex-shrink-0 mt-0.5">
          {{ item.type === 'black_box' ? '📦' : '✅' }}
        </span>
        
        <!-- 内容 -->
        <div class="flex-1 min-w-0">
          <p class="text-xs text-stone-300 
                    truncate leading-relaxed">
            {{ item.title }}
          </p>
          
          <!-- 时间 -->
          <span class="text-[9px] text-stone-500 font-mono">
            {{ item.completedAt | date:'HH:mm' }}
          </span>
        </div>
      </div>
    </div>
  `,
  styles: [`
    /* 入场动画已移至全局 CSS（focus.animations.css） */
    .strata-item.entering {
      animation: strata-sink 0.3s ease-out;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class StrataItemComponent {
  @Input({ required: true }) item!: StrataItem;
}
