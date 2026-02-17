/**
 * 沉积岩层单日组件
 * 
 * 设计原则：
 * - 化石质感：低饱和度、暗色调，文字如磨损的刻痕
 * - 内容始终可见（不依赖 CSS opacity/max-height 隐藏）
 * - 所有条目（task / black_box）均可恢复
 * - hover 时亮度微增，保持地质层感觉
 */

import { 
  Component, 
  ChangeDetectionStrategy, 
  inject,
  computed,
  input,
  output
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { StrataLayer, StrataItem } from '../../../../../models';
import { StrataService, StrataColorTier } from '../../../../../services/strata.service';

/** 恢复事件载体：需要 id + type 才能分别处理 task 和 black_box */
export interface StrataRestoreEvent {
  id: string;
  type: 'task' | 'black_box';
}

@Component({
  selector: 'app-strata-layer',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div
      class="strata-layer relative group
             border-l-[3px] rounded-sm"
      [class]="colorTier().bgClass + ' ' + colorTier().borderClass"
      [style.opacity]="layer().opacity"
      data-testid="strata-layer"
      role="listitem"
      [attr.aria-label]="label() + '，' + layer().items.length + '项完成'">

      <!-- 层头部 -->
      <div class="flex items-center justify-between px-2 py-1 min-h-[20px]">
        <span class="text-[9px] font-mono uppercase tracking-widest select-none"
              [class]="colorTier().textClass">
          {{ label() }}
        </span>
        <span class="text-[8px] font-mono tabular-nums select-none"
              [class]="colorTier().subTextClass">
          {{ layer().items.length }}项
        </span>
      </div>

      <!-- 条目列表：始终渲染 -->
      @if (visibleItems().length > 0) {
        <div class="px-2 pb-1.5">
          @for (item of visibleItems(); track item.id) {
            <div class="strata-fossil-item flex items-center gap-1 min-w-0 py-[3px]">
              <!-- 类型指示符 -->
              <span class="w-1.5 h-1.5 rounded-full shrink-0"
                    [class]="item.type === 'black_box' ? 'bg-amber-600/50' : 'bg-stone-400/40'">
              </span>
              <!-- 标题 -->
              <span class="text-[10px] truncate leading-tight flex-1 min-w-0"
                    [class]="colorTier().subTextClass"
                    [title]="item.title || '无标题'">
                {{ item.title || '无标题' }}
              </span>
              <!-- 恢复按钮：所有条目都可恢复 -->
              <button
                class="strata-restore-btn shrink-0 text-[9px] px-1.5 py-0.5 rounded
                       bg-amber-800/40 hover:bg-amber-700/60 active:bg-amber-600/70
                       text-amber-300/90 hover:text-amber-200
                       transition-all duration-150 whitespace-nowrap
                       border border-amber-600/30 hover:border-amber-500/60"
                (click)="onRestore($event, item)"
                [title]="item.type === 'task' ? '恢复为进行中任务' : '恢复为待处理条目'">
                ↑ 恢复
              </button>
            </div>
          }
          @if (layer().items.length > maxVisibleItems()) {
            <span class="text-[8px] italic block mt-0.5 select-none"
                  [class]="colorTier().subTextClass">
              +{{ layer().items.length - maxVisibleItems() }} 更多…
            </span>
          }
        </div>
      }

      <!-- 层间细线 -->
      <div class="absolute bottom-0 left-0 right-0 h-px"
           [class]="colorTier().lineClass">
      </div>
    </div>
  `,
  styles: [`
    .strata-layer {
      transition: filter 300ms ease;
    }
    .strata-layer:hover {
      z-index: 5;
      filter: brightness(1.08);
    }

    .strata-fossil-item {
      transition: background-color 200ms ease;
      border-radius: 2px;
      padding-left: 2px;
      padding-right: 2px;
    }
    .strata-fossil-item:hover {
      background-color: rgba(255, 255, 255, 0.04);
    }

    .strata-restore-btn {
      min-width: 38px;
      text-align: center;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class StrataLayerComponent {
  /** 层数据 */
  readonly layer = input.required<StrataLayer>();
  /** 层索引（0 = 今天） */
  readonly index = input<number>(0);
  
  /** 恢复条目事件：传递 {id, type} 给父组件分别处理 */
  readonly restoreItem = output<StrataRestoreEvent>();

  private strataService = inject(StrataService);
  
  /** 最多展示的条目数（近期层多展示，老层少展示） */
  readonly maxVisibleItems = computed(() => {
    const idx = this.index();
    if (idx <= 2) return 8;
    if (idx <= 6) return 5;
    return 3;
  });
  
  /** 日期标签 */
  readonly label = computed(() => this.strataService.getLayerLabel(this.layer().date));

  /** 可见条目 */
  readonly visibleItems = computed(() => this.layer().items.slice(0, this.maxVisibleItems()));

  /** 颜色分级 */
  readonly colorTier = computed<StrataColorTier>(() => {
    return this.strataService.getColorTier(this.index());
  });

  /**
   * 恢复条目：task → active, black_box → 取消完成
   */
  onRestore(event: Event, item: StrataItem): void {
    event.stopPropagation();
    this.restoreItem.emit({ id: item.id, type: item.type });
  }
}
