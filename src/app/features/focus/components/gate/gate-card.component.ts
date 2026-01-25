/**
 * 大门卡片组件
 * 
 * 显示当前待处理的遗留条目
 */

import { 
  Component, 
  ChangeDetectionStrategy, 
  inject 
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { GateService } from '../../../../../services/gate.service';

@Component({
  selector: 'app-gate-card',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="gate-card-stack" data-testid="gate-card">
       <div class="gate-card bg-white dark:bg-[#1c1c1e]
             rounded-3xl shadow-2xl shadow-black/20 overflow-hidden
             border border-stone-100 dark:border-white/5 relative"
         [class.sinking]="cardAnimation() === 'sinking'"
         [class.emerging]="cardAnimation() === 'emerging'">
      
      <!-- 顶栏：标签与进度 -->
      <div class="px-8 pt-8 flex items-center justify-between">
         <div class="flex items-center gap-2 px-3 py-1.5 rounded-full bg-stone-50 dark:bg-white/5 border border-stone-100 dark:border-white/5">
            <span class="w-1.5 h-1.5 rounded-full bg-orange-500"></span>
            <span class="text-[10px] font-bold tracking-wider text-stone-500 dark:text-stone-400 uppercase">昨日遗留</span>
         </div>
         <div class="font-mono text-xs font-medium text-stone-300 dark:text-stone-600 tracking-tight">
             <span class="text-stone-900 dark:text-stone-200">{{ progress().current }}</span> / {{ progress().total }}
         </div>
      </div>

      <!-- 内容区 -->
      @if (currentEntry(); as entry) {
        <div class="px-10 pb-12 pt-8 flex flex-col min-h-[220px]">
            <!-- 条目内容 -->
            <p id="gate-description" 
               class="text-2xl md:text-3xl text-stone-900 dark:text-stone-100 
                      leading-tight font-medium whitespace-pre-wrap tracking-tight selection:bg-orange-100 dark:selection:bg-orange-900/30">
              {{ entry.content }}
            </p>
            
            <div class="flex-1"></div>

            <!-- 底部信息 -->
            <div class="mt-10 flex items-center justify-between">
                <!-- 时间戳 -->
                <div class="font-mono text-[10px] text-stone-400 dark:text-stone-600">
                  {{ entry.createdAt | date:'MM月dd日 HH:mm' }}
                </div>

                <!-- 跳过次数 -->
                @if (entry.snoozeCount && entry.snoozeCount > 0) {
                   <div class="flex items-center gap-1.5 px-2 py-1 rounded-md bg-stone-50 dark:bg-white/5 text-stone-400 dark:text-stone-500 text-[10px] font-medium">
                      <span>已推迟 {{ entry.snoozeCount }} 次</span>
                   </div>
                }
            </div>
        </div>
      }
      
      <!-- 底部细进度条 -->
      <div class="absolute bottom-0 left-0 right-0 h-1 bg-stone-50 dark:bg-white/5">
        <div class="h-full bg-orange-500 transition-all duration-300 ease-out"
             [style.width.%]="(progress().current / progress().total) * 100">
        </div>
      </div>
      </div>
    </div>
  `,
  styles: [`
    .gate-card-stack {
      position: relative;
      isolation: isolate;
    }

    /* 沉积岩效果：不同深度的灰色层 */
    .gate-card-stack::before,
    .gate-card-stack::after {
      content: '';
      position: absolute;
      left: 0;
      right: 0;
      top: 0;
      bottom: 0;
      border-radius: 1.5rem;
      background: #f5f5f4; /* stone-100 */
      border: 1px solid #e7e5e4; /* stone-200 */
      z-index: -1;
      pointer-events: none;
      transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

    @media (prefers-color-scheme: dark) {
      .gate-card-stack::before {
        background: #292524; /* stone-800 */
        border-color: #44403c; /* stone-700 */
      }
      .gate-card-stack::after {
        background: #1c1917; /* stone-900 */
        border-color: #292524; /* stone-800 */
      }
    }

    /* 第一层岩石 */
    .gate-card-stack::before {
      transform: translateY(8px) scale(0.96);
      opacity: 0.6;
    }

    /* 第二层岩石 */
    .gate-card-stack::after {
      transform: translateY(16px) scale(0.92);
      opacity: 0.4;
    }

    .gate-card {
      box-shadow: 
        0 20px 25px -5px rgba(0, 0, 0, 0.1),
        0 8px 10px -6px rgba(0, 0, 0, 0.1);
      /* 性能优化：启用硬件加速 */
      will-change: transform, opacity;
      transform: translate3d(0, 0, 0);
      backface-visibility: hidden;
      /* 放置 jitter: 确保高度在动画期间稳定 */
      min-height: 220px;
    }

    /* 下沉动画优化 - 减少位移距离，避免过大变动导致掉帧 */
    .gate-card.sinking {
      animation: task-sink 0.35s cubic-bezier(0.4, 0, 0.2, 1) forwards;
    }

    /* 浮现动画优化 */
    .gate-card.emerging {
      animation: task-emerge 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    }
    
    @keyframes task-sink {
      0% {
        opacity: 1;
        transform: translate3d(0, 0, 0) scale(1);
      }
      100% {
        opacity: 0;
        /* 增加Z轴位移以利用GPU */
        transform: translate3d(0, 20px, 0) scale(0.95);
      }
    }
    
    @keyframes task-emerge {
      0% {
        opacity: 0;
        transform: translate3d(0, -20px, 0) scale(0.98);
      }
      100% {
        opacity: 1;
        transform: translate3d(0, 0, 0) scale(1);
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class GateCardComponent {
  private gateService = inject(GateService);
  
  readonly currentEntry = this.gateService.currentEntry;
  readonly progress = this.gateService.progress;
  readonly cardAnimation = this.gateService.cardAnimation;
}
