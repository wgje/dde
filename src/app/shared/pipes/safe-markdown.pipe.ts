import { Pipe, PipeTransform, inject } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { renderMarkdownSafe, renderMarkdownRawSafe } from '../../../utils/markdown';

/**
 * 安全 Markdown 渲染管道
 * 
 * 【P2-24 修复】替代模板中直接调用 renderMarkdown() 方法
 * Angular pure pipe 只在输入值变化时重新计算，避免每次变更检测都重复渲染
 * 
 * 用法（返回 SafeHtml，支持 DomSanitizer）：
 *   <div [innerHTML]="content | safeMarkdown"></div>
 * 
 * 用法（返回 string，经过 DOMPurify 处理但不经过 DomSanitizer）：
 *   <div [innerHTML]="content | safeMarkdown:'raw'"></div>
 */
@Pipe({
  name: 'safeMarkdown',
  standalone: true,
  pure: true,
})
export class SafeMarkdownPipe implements PipeTransform {
  private readonly sanitizer = inject(DomSanitizer);

  transform(content: string | null | undefined, mode?: 'raw'): SafeHtml | string {
    if (!content) return '';
    
    if (mode === 'raw') {
      // 【P2-3 修复】raw 模式也经过 DOMPurify 保持深度防御
      return renderMarkdownRawSafe(content);
    }
    
    return renderMarkdownSafe(content, this.sanitizer);
  }
}
