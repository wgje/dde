/**
 * 黑匣子文字输入组件
 * 
 * 降级方案：当浏览器不支持录音时使用
 */

import { 
  Component, 
  ChangeDetectionStrategy, 
  Output,
  EventEmitter,
  signal,
  Input
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-black-box-text-input',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="black-box-text-input">
      <!-- 不支持录音提示 -->
      @if (showFallbackHint) {
        <div class="mb-2 px-2 py-1.5 bg-stone-100 dark:bg-stone-700 
                    rounded-lg text-xs text-stone-500 dark:text-stone-400
                    flex items-center gap-2">
          <span>📝</span>
          <span>当前浏览器不支持录音，请使用文字输入</span>
        </div>
      }
      
      <!-- 输入框 -->
      <div class="relative">
        <textarea
          [(ngModel)]="inputText"
          class="w-full px-3 py-2.5 rounded-xl text-sm
                 bg-amber-50/80 dark:bg-stone-700/80
                 border-2 border-dashed border-amber-300 dark:border-stone-500
                 text-stone-700 dark:text-stone-200
                 placeholder:text-stone-400 dark:placeholder:text-stone-500
                 focus:outline-none focus:border-amber-400 dark:focus:border-amber-500
                 resize-none"
          rows="3"
          placeholder="记录你的想法..."
          (keydown.enter)="onEnterKey($event)"
          aria-label="输入想法"
          data-testid="black-box-text-input">
        </textarea>
        
        <!-- 提交按钮 -->
        <button
          class="absolute right-2 bottom-2 px-3 py-1.5 rounded-lg text-xs font-medium
                 transition-all duration-150"
          [class]="inputText().trim() 
            ? 'bg-amber-500 text-white hover:bg-amber-600 active:scale-95' 
            : 'bg-stone-200 dark:bg-stone-600 text-stone-400 cursor-not-allowed'"
          [disabled]="!inputText().trim()"
          (click)="submit()"
          aria-label="提交"
          data-testid="black-box-submit">
          保存
        </button>
      </div>
      
      <!-- 提示 -->
      <p class="mt-1.5 text-center text-[10px] text-stone-400 dark:text-stone-500">
        按 Ctrl+Enter 快速保存
      </p>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class BlackBoxTextInputComponent {
  inputText = signal('');
  @Input() showFallbackHint = true;
  
  @Output() submitted = new EventEmitter<string>();
  
  /**
   * 处理 Enter 键
   */
  onEnterKey(event: KeyboardEvent): void {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      this.submit();
    }
  }
  
  /**
   * 提交文字
   */
  submit(): void {
    const text = this.inputText().trim();
    if (text) {
      this.submitted.emit(text);
      this.inputText.set('');
    }
  }
}
