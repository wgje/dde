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
          [ngClass]="{
            'border-dashed border-amber-300': isPressed(),
            'dark:border-stone-500': isPressed(),
            'border-solid': !isPressed()
          }"
          [class]="'block w-full px-2 py-1.5 rounded-lg text-sm border-2 transition-colors duration-200 focus:outline-none focus:border-dashed focus:border-amber-400 dark:focus:border-amber-500 resize-none ' + textareaToneClass()"
          rows="2"
          placeholder="记录你的想法..."
          (keydown.enter)="onEnterKey($event)"
          (touchstart)="isPressed.set(true)"
          (touchend)="isPressed.set(false)"
          (touchcancel)="isPressed.set(false)"
          aria-label="输入想法"
          data-testid="black-box-text-input">
        </textarea>
        
        <!-- 提交按钮 -->
        <button
          class="absolute right-1 bottom-1 px-2.5 py-0.5 rounded-br-md rounded-tl-md text-xs font-medium
                 transition-all duration-200 border-l border-t"
          [class]="submitBtnClass()"
          [disabled]="!inputText.trim()"
          (click)="submit()"
          aria-label="提交"
          data-testid="black-box-submit">
          保存
        </button>
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: block;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class BlackBoxTextInputComponent {
  inputText = '';
  @Input() showFallbackHint = true;
  @Input() appearance: 'default' | 'obsidian' = 'default';
  isPressed = signal(false);
  
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
    const text = this.inputText.trim();
    if (text) {
      this.submitted.emit(text);
      this.inputText = '';
    }
  }

  textareaToneClass(): string {
    if (this.appearance === 'obsidian') {
      return `bg-stone-900/70 border-stone-700/80 text-stone-200
              placeholder:text-stone-500`;
    }
    return `bg-amber-50/80 dark:bg-stone-700/80 text-stone-700 dark:text-stone-200
            placeholder:text-stone-400 dark:placeholder:text-stone-500`;
  }

  submitBtnClass(): string {
    const hasContent = !!this.inputText.trim();
    
    if (this.appearance === 'obsidian') {
      if (hasContent) {
        return `bg-amber-500/5 text-amber-500/20 border-stone-700/30
                hover:bg-amber-500 hover:text-white hover:border-amber-500 hover:opacity-100
                active:scale-95 cursor-pointer`;
      }
      return 'bg-transparent text-stone-600/10 border-transparent cursor-not-allowed';
    }

    // Default appearance
    if (hasContent) {
      return `bg-amber-500/5 text-amber-600/30 border-amber-200/30
              dark:text-amber-400/20 dark:border-stone-600/30
              hover:bg-amber-500 hover:text-white hover:border-amber-500 hover:opacity-100
              active:scale-95 cursor-pointer`;
    }
    return 'bg-transparent text-stone-400/10 dark:text-stone-500/10 border-transparent cursor-not-allowed';
  }
}
