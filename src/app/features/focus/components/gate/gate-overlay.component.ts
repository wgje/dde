/**
 * 大门遮罩层组件
 * 
 * 全屏遮罩层，阻止用户访问应用其他部分
 * 直到所有遗留条目处理完毕
 * 底部显示地质层（已完成任务堆叠预览）
 */

import { 
  Component, 
  ChangeDetectionStrategy, 
  inject,
  HostListener,
  OnInit,
  OnDestroy,
  computed
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { GateService } from '../../../../../services/gate.service';
import { StrataService } from '../../../../../services/strata.service';
import { GateCardComponent } from './gate-card.component';
import { GateActionsComponent } from './gate-actions.component';

@Component({
  selector: 'app-gate-overlay',
  standalone: true,
  imports: [CommonModule, GateCardComponent, GateActionsComponent],
  template: `
    <!-- 审查中状态 -->
    @if (gateService.isActive()) {
      <div 
        class="gate-overlay fixed inset-0 z-[9999] flex flex-col items-center justify-center p-4 overflow-hidden"
        data-testid="gate-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gate-title"
        aria-describedby="gate-description"
        tabindex="-1">
        
        <!-- 背景遮罩 (优化性能：移除模糊动画，使用固定模糊) -->
        <div 
          class="absolute inset-0 bg-stone-950/80 backdrop-blur-md"
          aria-hidden="true">
        </div>
        
        <!-- 地质层预览（底部堆叠效果 - 沉积岩风格） -->
        <div class="absolute bottom-0 left-0 right-0 pointer-events-none flex flex-col items-center justify-end overflow-hidden pb-8 sm:pb-12 h-1/2 transform-gpu">
          @for (layer of strataLayers(); track layer.date; let i = $index) {
            @if (i < 5) {
              <!-- 每一层代表一天/一层沉积 -->
              <div 
                class="w-full max-w-2xl mx-auto absolute bottom-0 left-1/2"
                [style.bottom.px]="i * 10"
                [style.transform]="'translate3d(-50%, 0, 0) scale(' + (1 - i * 0.04) + ')'"
                [style.opacity]="1 - i * 0.15"
                [style.z-index]="10 - i">
                
                <div class="mx-4 sm:mx-8">
                   <!-- 岩层实体 (静态背景，避免模糊开销) -->
                   <div class="relative bg-stone-900 border-t border-white/10 
                             rounded-t-xl p-3 shadow-xl overflow-hidden">
                      
                      <!-- 简单的纹理 -->
                      <div class="absolute inset-0 opacity-10 bg-repeat bg-[length:4px_4px]"
                           style="background-image: radial-gradient(circle, #fff 1px, transparent 1px);">
                      </div>

                      <div class="relative flex items-center justify-between gap-4 h-6">
                        <!-- 日期标签 -->
                        <div class="flex items-center gap-2 min-w-0">
                           <div class="w-1 h-4 rounded-full bg-stone-700"></div>
                           <span class="text-[10px] text-stone-500 font-mono tracking-wide">{{ layer.date }}</span>
                        </div>

                        <!-- 条目摘要 -->
                        <div class="flex items-center gap-1.5 overflow-hidden justify-end flex-1">
                          @for (entry of layer.entries.slice(0, 3); track entry.id) {
                            <div class="px-1.5 py-0.5 flex items-center bg-black/30 rounded text-[9px] text-stone-600 truncate max-w-[80px]">
                              {{ entry.content }}
                            </div>
                          }
                        </div>
                      </div>
                   </div>
                </div>
              </div>
            }
          }
        </div>
        
        <!-- 大门卡片 -->
        <div class="relative z-10 w-full max-w-xl flex flex-col gap-6 animate-gate-enter will-change-transform">
          <app-gate-card class="w-full" />
          <app-gate-actions class="w-full" />
        </div>
        
        <!-- 键盘快捷键提示 -->
        <div class="absolute bottom-4 left-1/2 -translate-x-1/2 text-xs text-white/30 
                    font-mono flex gap-4 z-20 pointer-events-none opacity-0 sm:opacity-100 transition-opacity">
          <span><kbd class="keyboard-hint">1</kbd> 已读</span>
          <span><kbd class="keyboard-hint">2</kbd> 完成</span>
          <span><kbd class="keyboard-hint">3</kbd> 稍后</span>
        </div>
      </div>
    }
    
    <!-- 完成状态 - 显示成功提示后消失 -->
    @if (showCompletionMessage()) {
      <div 
        class="gate-completion fixed inset-0 z-[9999] flex items-center justify-center p-4"
        role="status"
        aria-live="polite">
        
        <!-- 背景遮罩（渐隐） -->
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade-out"></div>
        
        <!-- 成功提示 -->
        <div class="relative z-10 text-center animate-success-bounce will-change-transform">
          <div class="w-20 h-20 mx-auto mb-4 rounded-full bg-emerald-500/20 
                      flex items-center justify-center border border-emerald-500/30">
            <span class="text-4xl shadow-emerald-500/50 drop-shadow-lg">✅</span>
          </div>
          <p class="text-xl font-bold text-white mb-1 tracking-tight">全部处理完毕</p>
          <p class="text-sm text-white/50">开始新的一天</p>
        </div>
      </div>
    }
  `,
  styles: [`
    .gate-overlay {
      animation: opacity-in 0.3s ease-out;
    }
    
    @keyframes opacity-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    
    .keyboard-hint {
      @apply inline-block px-1.5 py-0.5 rounded bg-white/10 text-white/70 
             font-mono text-[10px] min-w-[20px] text-center border border-white/5;
    }
    
    /* 完成状态动画 */
    .gate-completion {
      animation: completion-enter 0.3s ease-out;
    }
    
    .animate-fade-out {
      animation: fade-out 1.5s ease-out 0.5s forwards;
    }
    
    @keyframes fade-out {
      0% { opacity: 1; }
      100% { opacity: 0; }
    }
    
    .animate-success-bounce {
      animation: success-bounce 0.6s cubic-bezier(0.34, 1.56, 0.64, 1);
    }
    
    @keyframes success-bounce {
      0% {
        opacity: 0;
        transform: scale(0.8);
      }
      100% {
        opacity: 1;
        transform: scale(1);
      }
    }
    
    @keyframes completion-enter {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .animate-gate-enter {
      animation: gate-enter 0.6s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
    }
  
    /* 更流畅的进入动画 */
    @keyframes gate-enter {
      0% {
        opacity: 0;
        transform: translateY(20px) scale(0.96);
      }
      100% {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class GateOverlayComponent implements OnInit, OnDestroy {
  gateService = inject(GateService);
  private strataService = inject(StrataService);
  
  // 获取地质层数据
  readonly strataLayers = computed(() => this.strataService.layers());

  /**
   * 键盘快捷键
   * 1: 已读, 2: 完成, 3: 稍后
   */
  @HostListener('document:keydown', ['$event'])
  handleKeydown(event: KeyboardEvent): void {
    if (!this.gateService.isActive()) return;
    
    // 忽略带修饰键的情况
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    
    switch (event.key) {
      case '1':
        event.preventDefault();
        this.gateService.markAsRead();
        break;
      case '2':
        event.preventDefault();
        this.gateService.markAsCompleted();
        break;
      case '3':
        event.preventDefault();
        if (this.gateService.canSnooze()) {
          this.gateService.snooze();
        }
        break;
    }
  }
  
  // 是否显示完成提示
  readonly showCompletionMessage = this.gateService.showCompletionMessage;
  
  /**
   * 计算地质层透明度（越深越淡）
   */
  getLayerOpacity(index: number): number {
    return 0.8 - (index * 0.15);
  }
  
  ngOnInit(): void {
    // 大门激活时禁用页面滚动
    if (this.gateService.isActive()) {
      document.body.style.overflow = 'hidden';
    }
  }

  ngOnDestroy(): void {
    document.body.style.overflow = '';
  }
}
