import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import DOMPurify from 'dompurify';
import { toggleMarkdownTodoState } from './markdown-todo';
import { renderMarkdownHtml } from './markdown-renderer';
import {
  BLOCKED_LINK_HREF,
  LOCAL_LINK_HREF,
  normalizeExternalAutoLink,
  resolveMarkdownLinkTarget,
  shouldOpenExternalLinkInNewTab,
  type MarkdownLinkTarget,
} from './markdown-links';

export {
  activateLocalMarkdownLink,
  getMarkdownLinkFromClick,
  getTodoIndexFromClick,
  handleMarkdownLinkAction,
  notifyLocalMarkdownLinkResult,
  resolveMarkdownLinkTarget,
  toLocalPathFileUrl,
  type LocalMarkdownLinkActivationResult,
  type MarkdownClickTarget,
  type MarkdownLinkKind,
  type MarkdownLinkTarget,
} from './markdown-links';

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

const AUTOLINK_PATTERN = /(^|[\s(>])((?:https?:\/\/|ftp:\/\/|mailto:|tel:|www\.|task:|file:\/\/)[^\s<]+|(?:[a-zA-Z]:[\\/]|\\\\)[^\s<]+)/gi;

function trimAutoLinkCandidate(candidate: string): { core: string; trailing: string } {
  let core = candidate;
  let trailing = '';

  while (/[.,!?;:]$/.test(core)) {
    trailing = core.slice(-1) + trailing;
    core = core.slice(0, -1);
  }

  while (core.endsWith(')')) {
    const opening = (core.match(/\(/g) ?? []).length;
    const closing = (core.match(/\)/g) ?? []).length;
    if (closing <= opening) {
      break;
    }

    trailing = ')' + trailing;
    core = core.slice(0, -1);
  }

  return { core, trailing };
}

function isEscapedMarkdownCharacter(text: string, index: number): boolean {
  let backslashCount = 0;

  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor--) {
    backslashCount += 1;
  }

  return backslashCount % 2 === 1;
}

function findClosingMarkdownLabel(text: string, startIndex: number): number {
  let depth = 1;

  for (let index = startIndex; index < text.length; index++) {
    if (isEscapedMarkdownCharacter(text, index)) {
      continue;
    }

    const char = text[index];
    if (char === '[') {
      depth += 1;
      continue;
    }

    if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function stripOptionalMarkdownLinkTitle(destination: string): string {
  const trimmed = destination.trim();
  const titleMatch = trimmed.match(/^(.*?)(?:\s+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^)\\]|\\.)*\)))\s*$/);
  const candidateDestination = titleMatch?.[1]?.trim();
  return candidateDestination || trimmed;
}

function findClosingMarkdownDestination(text: string, startIndex: number): number {
  let depth = 1;

  for (let index = startIndex; index < text.length; index++) {
    if (isEscapedMarkdownCharacter(text, index)) {
      continue;
    }

    const char = text[index];
    if (char === '(') {
      depth += 1;
      continue;
    }

    if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function replaceExplicitMarkdownLinks(text: string, store: ReturnType<typeof createInlinePlaceholderStore>): string {
  let result = '';
  let cursor = 0;

  while (cursor < text.length) {
    const openBracket = text.indexOf('[', cursor);
    if (openBracket === -1) {
      result += text.slice(cursor);
      break;
    }

    if (isEscapedMarkdownCharacter(text, openBracket)) {
      result += text.slice(cursor, openBracket + 1);
      cursor = openBracket + 1;
      continue;
    }

    const closeBracket = findClosingMarkdownLabel(text, openBracket + 1);
    if (closeBracket === -1 || text[closeBracket + 1] !== '(') {
      result += text.slice(cursor, openBracket + 1);
      cursor = openBracket + 1;
      continue;
    }

    const destinationStart = closeBracket + 2;
    const destinationEnd = findClosingMarkdownDestination(text, destinationStart);
    if (destinationEnd === -1) {
      result += text.slice(cursor, openBracket + 1);
      cursor = openBracket + 1;
      continue;
    }

    const label = text.slice(openBracket + 1, closeBracket);
    const destination = stripOptionalMarkdownLinkTitle(text.slice(destinationStart, destinationEnd));
    if (!destination) {
      result += text.slice(cursor, openBracket + 1);
      cursor = openBracket + 1;
      continue;
    }

    result += text.slice(cursor, openBracket);
    result += store.store(renderResolvedLink(label, resolveMarkdownLinkTarget(destination)));
    cursor = destinationEnd + 1;
  }

  return result;
}

function createInlinePlaceholderStore() {
  const placeholders: string[] = [];
  const placeholderSalt = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

  return {
    store(html: string): string {
      const token = `%%NANOFLOWHOLDER${placeholderSalt}${placeholders.length}%%`;
      placeholders.push(html);
      return token;
    },
    restore(text: string): string {
      let restored = text;

      for (let index = placeholders.length - 1; index >= 0; index--) {
        restored = restored
          .split(`%%NANOFLOWHOLDER${placeholderSalt}${index}%%`)
          .join(placeholders[index] ?? '');
      }

      return restored;
    },
  };
}

function sanitizeAttributeValue(value: string): string {
  return escapeHtml(value);
}

function renderResolvedLink(label: string, target: MarkdownLinkTarget): string {
  const safeLabel = renderLinkLabelInline(label);
  const linkClass = 'text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 underline';
  const blockedLinkClass = 'text-stone-400 dark:text-stone-500 underline decoration-dotted cursor-not-allowed';

  if (target.kind === 'task' && target.taskId) {
    const safeTaskId = sanitizeAttributeValue(target.taskId);
    const safeHref = sanitizeAttributeValue(target.href);
    return `<a href="${safeHref}" class="${linkClass}" data-link-kind="task" data-task-link-id="${safeTaskId}">${safeLabel}</a>`;
  }

  if (target.kind === 'local' && target.localPath) {
    const safeLocalPath = sanitizeAttributeValue(target.localPath);
    return `<a href="${LOCAL_LINK_HREF}" class="${linkClass}" data-link-kind="local" data-local-link-path="${safeLocalPath}" rel="noopener noreferrer">${safeLabel}</a>`;
  }

  if (target.kind === 'blocked') {
    return `<a href="${BLOCKED_LINK_HREF}" class="${blockedLinkClass}" data-link-kind="blocked" rel="noopener noreferrer">${safeLabel}</a>`;
  }

  if (target.kind === 'internal') {
    return `<a href="${target.href}" class="${linkClass}" data-link-kind="internal" rel="noopener noreferrer">${safeLabel}</a>`;
  }

  const openInNewTab = shouldOpenExternalLinkInNewTab(target.href);
  const targetAttribute = openInNewTab ? ' target="_blank"' : '';
  return `<a href="${target.href}" class="${linkClass}" data-link-kind="external"${targetAttribute} rel="noopener noreferrer">${safeLabel}</a>`;
}

function autoLinkPlainText(text: string, store: ReturnType<typeof createInlinePlaceholderStore>): string {
  return text.replace(AUTOLINK_PATTERN, (match, prefix: string, candidate: string) => {
    const { core, trailing } = trimAutoLinkCandidate(candidate);
    if (!core) {
      return match;
    }

    const normalizedCandidate = normalizeExternalAutoLink(core);
    const target = resolveMarkdownLinkTarget(normalizedCandidate);
    if (target.kind === 'blocked') {
      return match;
    }

    const rendered = renderResolvedLink(core, target);
    return `${prefix}${store.store(`${rendered}${escapeHtml(trailing)}`)}`;
  });
}

function applyBasicInlineFormatting(text: string): string {
  let result = text;

  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  result = result.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  result = result.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  result = result.replace(/_([^_]+)_/g, '<em>$1</em>');
  result = result.replace(/~~([^~]+)~~/g, '<del class="text-stone-400 dark:text-stone-500">$1</del>');

  return result;
}

function renderLinkLabelInline(label: string): string {
  return label
    .split(/(`[^`]+`)/g)
    .map(segment => {
      if (/^`[^`]+`$/.test(segment)) {
        const code = segment.slice(1, -1);
        return `<code class="px-1 py-0.5 bg-stone-100 dark:bg-stone-700 rounded text-xs font-mono text-pink-600 dark:text-pink-400">${escapeHtml(code)}</code>`;
      }

      return applyBasicInlineFormatting(escapeHtml(segment));
    })
    .join('');
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
  const store = createInlinePlaceholderStore();
  let result = text;

  result = result.replace(/`([^`]+)`/g, (_, code: string) => store.store(
    `<code class="px-1 py-0.5 bg-stone-100 dark:bg-stone-700 rounded text-xs font-mono text-pink-600 dark:text-pink-400">${escapeHtml(code)}</code>`
  ));

  result = replaceExplicitMarkdownLinks(result, store);

  result = autoLinkPlainText(result, store);
  result = escapeHtml(result);

  result = applyBasicInlineFormatting(result);

  return store.restore(result);
}

/**
 * 渲染 Markdown 为 HTML
 */
export function renderMarkdown(content: string): string {
  return renderMarkdownHtml(content, { parseInline, escapeHtml });
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
  ALLOWED_ATTR: ['href', 'class', 'target', 'rel', 'data-todo-index', 'data-link-kind', 'data-task-link-id', 'data-local-link-path', 'role', 'aria-checked'],
  ALLOW_DATA_ATTR: false,
  ADD_ATTR: ['target', 'rel'], // 确保链接安全属性被保留
  // data-local-link-path 是应用内部点击处理读取的路径载荷，不是浏览器导航 URI。
  ADD_URI_SAFE_ATTR: ['data-local-link-path'],
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
 * 渲染 Markdown 并返回经过 DOMPurify 处理的纯 HTML 字符串
 * 【P2-3 修复】用于 raw 模式，不经过 Angular DomSanitizer 但仍有 DOMPurify 深度防御
 */
export function renderMarkdownRawSafe(content: string): string {
  const html = renderMarkdown(content);
  return DOMPurify.sanitize(html, DOMPURIFY_CONFIG) as string;
}

/**
 * 切换 Markdown 内容中指定索引的待办事项状态
 * 将 - [ ] 切换为 - [x]，或将 - [x] 切换为 - [ ]
 * @param content 原始 Markdown 内容
 * @param todoIndex 待办事项索引（从 0 开始，按出现顺序）
 * @returns 切换后的 Markdown 内容
 */
export function toggleMarkdownTodo(content: string, todoIndex: number): string {
  return toggleMarkdownTodoState(content, todoIndex);
}
