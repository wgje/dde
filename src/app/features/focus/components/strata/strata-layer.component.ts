/**
 * 地质层单日组件
 * 
 * 显示单日完成的项目
 */

import { 
  Component, 
  ChangeDetectionStrategy, 
  Input,
  inject,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { StrataLayer } from '../../../../../models';
import { StrataService } from '../../../../../services/strata.service';
import { StrataItemComponent } from './strata-item.component';

@Component({
  selector: 'app-strata-layer',
  standalone: true,
  imports: [CommonModule, StrataItemComponent],
  template: `
        <div
          class="strata-layer border-b border-stone-200/30 dark:border-stone-600/20
            last:border-b-0"
          [style.opacity]="layer.opacity"
          data-testid="strata-layer"
          role="listitem">

      <!-- 日期标题 -->
      <div class="px-3 py-1.5 flex items-center gap-2
                  text-[10px] text-stone-400 dark:text-stone-500
                  cursor-pointer select-none"
           role="button"
           tabindex="0"
           (click)="toggleCollapsed()"
           (keydown.enter)="toggleCollapsed()"
           (keydown.space)="toggleCollapsed(); $event.preventDefault()"
           [attr.aria-expanded]="!isCollapsed()"
           data-testid="strata-layer-header">
        <span class="font-mono">{{ getLabel() }}</span>
        <span class="flex-1 h-px" [class]="getLineClass()"></span>
        <span class="font-mono">{{ layer.items.length }} 项</span>
      </div>
      
      <!-- 项目列表 -->
      @if (!isCollapsed()) {
        <div class="px-2 pb-2" data-testid="strata-layer-content">
          @for (item of layer.items; track item.id) {
            <app-strata-item [item]="item" />
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .strata-layer {
      transition: opacity 0.3s ease;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class StrataLayerComponent {
  @Input({ required: true }) layer!: StrataLayer;
  @Input() index: number = 0;
  isCollapsed = signal(false);
  
  private strataService = inject(StrataService);
  
  /**
   * 获取日期标签
   */
  getLabel(): string {
    return this.strataService.getLayerLabel(this.layer.date);
  }
  
  /**
   * 获取分隔线样式
   */
  getLineClass(): string {
    return this.strataService.getLayerColorClass(this.index);
  }

  /**
   * 折叠/展开
   */
  toggleCollapsed(): void {
    this.isCollapsed.update(v => !v);
  }
}
