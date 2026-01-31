import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import DOMPurify from 'dompurify';

/**
 * 安全的 Markdown 渲染器
 * 支持基础语法：标题、粗体、斜体、删除线、链接、代码、列表、待办
 * 
 * 安全特性：
 * - 转义所有 HTML 特殊字符（防止 XSS）
 * - 验证和清洗 URL（阻止 javascript:、vbscript:、data: 等危险协议）
 * - 限制允许的 HTML 标签和属性
 * - 所有用户输入都经过转义处理
 * - 链接添加 rel="noopener noreferrer" 防止 tabnabbing 攻击
 * - 🔒 使用 DOMPurify 作为额外安全层（防御深度）
 */

/**
 * 危险 URL 协议列表 - 完整版
 * 这些协议可能被用于执行恶意代码
 */
const DANGEROUS_PROTOCOLS = [
  'javascript:',
  'vbscript:',
  'data:text/html',
  'data:application/javascript',
  'data:application/x-javascript',
  'data:text/javascript',
  'data:image/svg+xml',  // SVG 可以包含脚本
  'file:',
  'blob:',
  // IE 特有的危险协议
  'mhtml:',
  'x-javascript:',
];

/**
 * 危险协议的编码变体正则
 * 检测如 java&#x73;cript: 这样的编码绕过
 */
const ENCODED_PROTOCOL_PATTERN = /^\s*(?:j[\s]*a[\s]*v[\s]*a|v[\s]*b|d[\s]*a[\s]*t[\s]*a)[\s]*(?:&#[xX]?[0-9a-fA-F]+;?|&#?\d+;?|[\s])*:/i;

/**
 * 允许的 URL 协议白名单
 */
const SAFE_PROTOCOLS = [
  'http:',
  'https:',
  'mailto:',
  'tel:',
  'ftp:',
  '#', // 页内锚点
];

/**
 * 验证 URL 是否安全
 * 采用白名单 + 黑名单双重检查
 */
function isSafeUrl(url: string): boolean {
  if (!url) return false;
  
  const normalized = url.toLowerCase().trim();
  
  // 黑名单检查
  if (DANGEROUS_PROTOCOLS.some(proto => normalized.startsWith(proto))) {
    return false;
  }
  
  // 检测编码绕过尝试
  if (ENCODED_PROTOCOL_PATTERN.test(normalized)) {
    return false;
  }
  
  // 检测 data: URI 中的 SVG（可能包含嵌入脚本）
  if (normalized.startsWith('data:') && 
      (normalized.includes('svg') || normalized.includes('<script') || normalized.includes('onerror'))) {
    return false;
  }
  
  // 相对 URL 和锚点是安全的
  if (normalized.startsWith('/') || normalized.startsWith('#') || normalized.startsWith('./') || normalized.startsWith('../')) {
    return true;
  }
  
  // 白名单检查：如果包含协议，必须在白名单中
  const hasProtocol = /^[a-z][a-z0-9+.-]*:/i.test(normalized);
  if (hasProtocol) {
    return SAFE_PROTOCOLS.some(proto => normalized.startsWith(proto));
  }
  
  // 无协议的 URL（如 www.example.com）视为安全
  return true;
}

/**
 * 清洗 URL，返回安全的 URL 或空字符串
 */
function sanitizeUrl(url: string): string {
  const trimmed = url.trim();
  if (!isSafeUrl(trimmed)) {
    console.warn('[Security] Blocked potentially dangerous URL:', trimmed.substring(0, 50));
    return '#blocked';
  }
  // 转义 URL 中的特殊字符，防止属性注入
  return trimmed
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\\/g, '&#92;'); // 防止反斜杠转义
}

/**
 * 转义 HTML 特殊字符
 * 这是防止 XSS 攻击的核心函数
 */
function escapeHtml(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\\/g, '&#92;'); // 防止反斜杠在某些上下文中的转义
}

/**
 * 解析内联 Markdown 语法（安全版本）
 */
function parseInline(text: string): string {
  let result = escapeHtml(text);
  
  // 代码块 `code` - 深色模式自动适应
  result = result.replace(/`([^`]+)`/g, '<code class="px-1 py-0.5 bg-stone-100 dark:bg-stone-700 rounded text-xs font-mono text-pink-600 dark:text-pink-400">$1</code>');
  
  // 粗体 **text** 或 __text__
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  result = result.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  
  // 斜体 *text* 或 _text_
  result = result.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  result = result.replace(/_([^_]+)_/g, '<em>$1</em>');
  
  // 删除线 ~~text~~ - 深色模式自动适应
  result = result.replace(/~~([^~]+)~~/g, '<del class="text-stone-400 dark:text-stone-500">$1</del>');
  
  // 链接 [text](url) - 使用安全的 URL 处理，深色模式自动适应
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
    const safeUrl = sanitizeUrl(url);
    return `<a href="${safeUrl}" class="text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 underline" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });
  
  return result;
}

/**
 * 渲染 Markdown 为 HTML
 */
export function renderMarkdown(content: string): string {
  if (!content) return '';
  
  const lines = content.split('\n');
  const htmlLines: string[] = [];
  let inCodeBlock = false;
  let codeBlockContent: string[] = [];
  let listItems: string[] = [];
  
  const flushList = () => {
    if (listItems.length > 0) {
      htmlLines.push('<ul class="list-disc list-inside space-y-1 my-2">');
      listItems.forEach(item => {
        htmlLines.push(`<li class="text-stone-600">${item}</li>`);
      });
      htmlLines.push('</ul>');
      listItems = [];
    }
  };
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // 代码块开始/结束
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        // 结束代码块
        htmlLines.push(`<pre class="bg-stone-800 text-stone-100 rounded-lg p-3 text-xs font-mono overflow-x-auto my-2"><code>${escapeHtml(codeBlockContent.join('\n'))}</code></pre>`);
        codeBlockContent = [];
        inCodeBlock = false;
      } else {
        // 开始代码块
        flushList();
        const _codeBlockLang = line.slice(3).trim();
        inCodeBlock = true;
      }
      continue;
    }
    
    if (inCodeBlock) {
      codeBlockContent.push(line);
      continue;
    }
    
    // 空行
    if (line.trim() === '') {
      flushList();
      htmlLines.push('<br/>');
      continue;
    }
    
    // 标题
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushList();
      const level = headingMatch[1].length;
      const text = parseInline(headingMatch[2]);
      const sizeClass = ['text-xl font-bold', 'text-lg font-bold', 'text-base font-semibold', 'text-sm font-semibold', 'text-xs font-semibold', 'text-xs font-medium'][level - 1];
      htmlLines.push(`<h${level} class="${sizeClass} text-stone-800 my-2">${text}</h${level}>`);
      continue;
    }
    
    // 待办事项（特殊处理）
    const todoMatch = line.match(/^-\s*\[([ xX])\]\s*(.+)$/);
    if (todoMatch) {
      flushList();
      const isChecked = todoMatch[1].toLowerCase() === 'x';
      const text = parseInline(todoMatch[2]);
      const checkedClass = isChecked ? 'line-through text-stone-400' : 'text-stone-700';
      const checkboxClass = isChecked ? 'text-emerald-500' : 'text-stone-300';
      htmlLines.push(`<div class="flex items-start gap-2 my-1">
        <span class="${checkboxClass}">${isChecked ? '☑' : '☐'}</span>
        <span class="${checkedClass}">${text}</span>
      </div>`);
      continue;
    }
    
    // 无序列表
    const ulMatch = line.match(/^[-*+]\s+(.+)$/);
    if (ulMatch) {
      listItems.push(parseInline(ulMatch[1]));
      continue;
    }
    
    // 有序列表
    const olMatch = line.match(/^\d+\.\s+(.+)$/);
    if (olMatch) {
      flushList();
      htmlLines.push(`<div class="flex items-start gap-2 my-1">
        <span class="text-stone-400 text-xs">•</span>
        <span class="text-stone-600">${parseInline(olMatch[1])}</span>
      </div>`);
      continue;
    }
    
    // 分割线
    if (/^[-*_]{3,}$/.test(line.trim())) {
      flushList();
      htmlLines.push('<hr class="my-3 border-stone-200"/>');
      continue;
    }
    
    // 引用
    if (line.startsWith('>')) {
      flushList();
      const text = parseInline(line.slice(1).trim());
      htmlLines.push(`<blockquote class="border-l-4 border-stone-300 pl-3 my-2 text-stone-500 italic">${text}</blockquote>`);
      continue;
    }
    
    // 普通段落
    flushList();
    htmlLines.push(`<p class="text-stone-600 my-1">${parseInline(line)}</p>`);
  }
  
  // 处理未闭合的代码块
  if (inCodeBlock && codeBlockContent.length > 0) {
    htmlLines.push(`<pre class="bg-stone-800 text-stone-100 rounded-lg p-3 text-xs font-mono overflow-x-auto my-2"><code>${escapeHtml(codeBlockContent.join('\n'))}</code></pre>`);
  }
  
  // 处理未闭合的列表
  flushList();
  
  return htmlLines.join('');
}

/**
 * DOMPurify 配置
 * 允许的标签和属性白名单
 */
const DOMPURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr',
    'ul', 'ol', 'li',
    'strong', 'em', 'del', 'code', 'pre',
    'a', 'blockquote', 'div', 'span',
  ],
  ALLOWED_ATTR: ['href', 'class', 'target', 'rel'],
  ALLOW_DATA_ATTR: false,
  ADD_ATTR: ['target', 'rel'], // 确保链接安全属性被保留
};

/**
 * 渲染 Markdown 并返回安全的 HTML（用于 Angular）
 * 
 * 双重防护：
 * 1. renderMarkdown 内部的 escapeHtml + sanitizeUrl
 * 2. DOMPurify 作为最终安全网
 */
export function renderMarkdownSafe(content: string, sanitizer: DomSanitizer): SafeHtml {
  const html = renderMarkdown(content);
  // 🔒 使用 DOMPurify 作为额外安全层
  const cleanHtml = DOMPurify.sanitize(html, DOMPURIFY_CONFIG) as string;
  return sanitizer.bypassSecurityTrustHtml(cleanHtml);
}

/**
 * 提取纯文本摘要（用于预览）
 */
export function extractPlainText(content: string, maxLength: number = 100): string {
  if (!content) return '';
  
  // 移除 Markdown 语法
  let text = content
    .replace(/```[\s\S]*?```/g, '') // 代码块
    .replace(/`[^`]+`/g, '') // 行内代码
    .replace(/\*\*([^*]+)\*\*/g, '$1') // 粗体
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1') // 斜体
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1') // 删除线
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // 链接
    .replace(/^#+\s+/gm, '') // 标题
    .replace(/^[-*+]\s+/gm, '') // 列表
    .replace(/^\d+\.\s+/gm, '') // 有序列表
    .replace(/^>\s+/gm, '') // 引用
    .replace(/^[-*_]{3,}$/gm, '') // 分割线
    .replace(/-\s*\[([ xX])\]\s*/g, '') // 待办
    .replace(/\n+/g, ' ') // 换行转空格
    .trim();
  
  if (text.length > maxLength) {
    text = text.slice(0, maxLength) + '...';
  }
  
  return text;
}

