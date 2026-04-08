import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import DOMPurify from 'dompurify';
import type { ToastService } from '../services/toast.service';
import { securityLogger } from './standalone-logger';
import { toggleMarkdownTodoState } from './markdown-todo';

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
const ENCODED_PROTOCOL_PATTERN = /^\s*(?:j[\s]*a[\s]*v[\s]*a|v[\s]*b|d[\s]*a[\s]*t[\s]*a)[\s]*(?:&#[xX]?[0-9a-fA-F]+;?|[\s])*:/i;

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

const TASK_LINK_PROTOCOL = 'task:';
const LOCAL_LINK_HREF = '#local-path';
const BLOCKED_LINK_HREF = '#__nf_blocked__';
const AUTOLINK_PATTERN = /(^|[\s(>])((?:https?:\/\/|ftp:\/\/|mailto:|tel:|www\.|task:|file:\/\/)[^\s<]+|(?:[a-zA-Z]:[\\/]|\\\\)[^\s<]+)/gi;
const HIGH_RISK_LOCAL_PATH_EXTENSIONS = new Set([
  '.application',
  '.appx',
  '.appxbundle',
  '.appref-ms',
  '.bat',
  '.cmd',
  '.com',
  '.cpl',
  '.exe',
  '.htm',
  '.html',
  '.hta',
  '.jar',
  '.jse',
  '.js',
  '.lnk',
  '.msc',
  '.msix',
  '.msixbundle',
  '.msi',
  '.msp',
  '.mht',
  '.mhtml',
  '.pif',
  '.ps1',
  '.psm1',
  '.reg',
  '.scf',
  '.scr',
  '.svg',
  '.url',
  '.vbe',
  '.vbs',
  '.wsf',
  '.wsh',
  '.xht',
  '.xhtml',
  '.xml',
]);

export type MarkdownLinkKind = 'external' | 'internal' | 'task' | 'local' | 'blocked';
export type LocalMarkdownLinkActivationResult =
  | 'attempted'
  | 'attempted-and-copied'
  | 'copied'
  | 'copied-network-path'
  | 'copied-risky-path'
  | 'unsupported';

export interface MarkdownLinkTarget {
  kind: MarkdownLinkKind;
  href: string;
  taskId?: string;
  localPath?: string;
}

export interface MarkdownClickTarget extends MarkdownLinkTarget {
  anchor: HTMLAnchorElement;
}

function sanitizeUrlForLog(url: string): string {
  return url
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtmlEntitiesForProtocolCheck(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z]+));?/g, (_, decimal, hexadecimal, namedEntity: string) => {
    if (decimal) {
      const codePoint = Number.parseInt(decimal, 10);
      return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10FFFF
        ? String.fromCodePoint(codePoint)
        : '';
    }

    if (hexadecimal) {
      const codePoint = Number.parseInt(hexadecimal, 16);
      return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10FFFF
        ? String.fromCodePoint(codePoint)
        : '';
    }

    const normalizedEntity = namedEntity.toLowerCase();
    // 解码可能用于混淆危险协议的 HTML 命名实体
    const namedEntityMap: Record<string, string> = {
      colon: ':',
      semi: ';',
      sol: '/',
      bsol: '\\',
      tab: ' ',
      newline: ' ',
      lt: '<',
      gt: '>',
      amp: '&',
      quot: '"',
      apos: "'",
    };
    return namedEntityMap[normalizedEntity] ?? `&${namedEntity};`;
  });
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function normalizeSlashes(path: string): string {
  return path.replace(/\//g, '\\');
}

function normalizeLocalPathInput(localPath: string): string {
  return normalizeSlashes(stripWrappingQuotes(localPath));
}

function parseFileUrlToLocalPath(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') {
      return null;
    }

    const pathname = decodeURIComponent(parsed.pathname);
    if (parsed.host && parsed.host.toLowerCase() !== 'localhost') {
      const uncPath = normalizeSlashes(pathname);
      return `\\\\${parsed.host}${uncPath}`;
    }

    return normalizeSlashes(pathname.replace(/^\/([a-zA-Z]:)/, '$1'));
  } catch {
    return null;
  }
}

function parseLocalPathCandidate(url: string): string | null {
  const trimmed = stripWrappingQuotes(url);
  if (!trimmed) {
    return null;
  }

  if (/^file:\/\//i.test(trimmed)) {
    return parseFileUrlToLocalPath(trimmed);
  }

  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) {
    return normalizeSlashes(trimmed);
  }

  if (/^\\\\[^\\/\s]+[\\/][^\\/]+/.test(trimmed)) {
    return normalizeSlashes(trimmed);
  }

  return null;
}

function isAmbiguousRelativeNavigationCandidate(url: string): boolean {
  return url.includes('\\');
}

export function toLocalPathFileUrl(localPath: string): string {
  const normalized = normalizeLocalPathInput(localPath);

  if (normalized.startsWith('\\\\')) {
    const uncParts = normalized.slice(2).split('\\').filter(Boolean);
    if (uncParts.length >= 2) {
      const [host, ...segments] = uncParts;
      return `file://${encodeURIComponent(host)}/${segments.map(segment => encodeURIComponent(segment)).join('/')}`;
    }
  }

  const driveMatch = normalized.match(/^([a-zA-Z]:)(?:\\(.*))?$/);
  if (driveMatch) {
    const [, drive, rest = ''] = driveMatch;
    const encodedPath = rest
      .split('\\')
      .filter(Boolean)
      .map(segment => encodeURIComponent(segment))
      .join('/');
    return encodedPath ? `file:///${drive}/${encodedPath}` : `file:///${drive}/`;
  }

  const encodedFallback = normalized
    .split('\\')
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join('/');
  return `file:///${encodedFallback}`;
}

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

function normalizeExternalAutoLink(candidate: string): string {
  return /^www\./i.test(candidate) ? `https://${candidate}` : candidate;
}

function isInPlaceNavigationHref(href: string): boolean {
  if (href.startsWith('//')) {
    return false;
  }

  return href.startsWith('#') || href.startsWith('/') || href.startsWith('./') || href.startsWith('../');
}

function shouldOpenExternalLinkInNewTab(href: string): boolean {
  return href.startsWith('//') || /^(https?:|ftp:)/i.test(href);
}

function isNetworkLocalPath(localPath: string): boolean {
  return normalizeLocalPathInput(localPath).startsWith('\\\\');
}

function isHighRiskLocalPath(localPath: string): boolean {
  const normalized = normalizeLocalPathInput(localPath);
  const fileName = normalized
    .split('\\')
    .filter(Boolean)
    .at(-1)
    ?.toLowerCase()
    .replace(/[. ]+$/g, '') ?? '';

  if (fileName.includes(':')) {
    return true;
  }

  const extensionStart = fileName.lastIndexOf('.');
  if (extensionStart === -1) {
    return false;
  }

  return HIGH_RISK_LOCAL_PATH_EXTENSIONS.has(fileName.slice(extensionStart));
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') {
    return false;
  }

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function tryOpenLocalPathInCurrentGesture(localPath: string): boolean {
  if (typeof document === 'undefined' || !document.body) {
    return false;
  }

  const anchor = document.createElement('a');
  anchor.href = toLocalPathFileUrl(localPath);
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  anchor.style.position = 'fixed';
  anchor.style.left = '-9999px';

  try {
    document.body.appendChild(anchor);
    anchor.click();
    return true;
  } catch {
    return false;
  } finally {
    anchor.remove();
  }
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

/**
 * 验证 URL 是否安全
 * 采用白名单 + 黑名单双重检查
 */
function isSafeUrl(url: string): boolean {
  if (!url) return false;
  
  const normalized = url.toLowerCase().trim();
  const decodedNormalized = decodeHtmlEntitiesForProtocolCheck(normalized);
  const normalizedForProtocolCheck = decodedNormalized
    .replace(/[\u0000-\u001f\u007f\s]+/g, '');
  
  // 黑名单检查
  if (DANGEROUS_PROTOCOLS.some(proto => normalizedForProtocolCheck.startsWith(proto))) {
    return false;
  }
  
  // 检测编码绕过尝试
  if (ENCODED_PROTOCOL_PATTERN.test(normalizedForProtocolCheck)) {
    return false;
  }
  
  // 检测 data: URI 中的 SVG（可能包含嵌入脚本）
  if (decodedNormalized.startsWith('data:') &&
      (decodedNormalized.includes('svg') || decodedNormalized.includes('<script') || decodedNormalized.includes('onerror'))) {
    return false;
  }
  
  // 相对 URL 和锚点是安全的
  if (decodedNormalized.startsWith('/') || decodedNormalized.startsWith('#') || decodedNormalized.startsWith('./') || decodedNormalized.startsWith('../')) {
    return true;
  }
  
  // 白名单检查：如果包含协议，必须在白名单中
  const hasProtocol = /^[a-z][a-z0-9+.-]*:/i.test(decodedNormalized);
  if (hasProtocol) {
    return SAFE_PROTOCOLS.some(proto => decodedNormalized.startsWith(proto));
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
    // 安全警告：必须保留日志以便追踪潜在攻击
    securityLogger.warn(`Blocked potentially dangerous URL: ${sanitizeUrlForLog(trimmed).substring(0, 50)}`);
    return BLOCKED_LINK_HREF;
  }
  // 转义 URL 中的特殊字符，防止属性注入
  return trimmed
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\\/g, '&#92;'); // 防止反斜杠转义
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

function parseTaskLinkId(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed.toLowerCase().startsWith(TASK_LINK_PROTOCOL)) {
    return null;
  }

  const rawTaskId = trimmed.slice(TASK_LINK_PROTOCOL.length).replace(/^\/+/, '').trim();
  if (!rawTaskId) {
    return null;
  }

  try {
    const decodedTaskId = decodeURIComponent(rawTaskId).trim();
    return decodedTaskId.length > 0 ? decodedTaskId : null;
  } catch {
    return rawTaskId;
  }
}

export function resolveMarkdownLinkTarget(url: string): MarkdownLinkTarget {
  const normalizedUrl = normalizeExternalAutoLink(url.trim());
  const taskId = parseTaskLinkId(normalizedUrl);
  if (taskId) {
    return {
      kind: 'task',
      taskId,
      href: `#task:${encodeURIComponent(taskId)}`,
    };
  }

  const localPath = parseLocalPathCandidate(normalizedUrl);
  if (localPath) {
    return {
      kind: 'local',
      localPath,
      href: LOCAL_LINK_HREF,
    };
  }

  if (isAmbiguousRelativeNavigationCandidate(normalizedUrl)) {
    securityLogger.warn(`Blocked ambiguous relative URL: ${sanitizeUrlForLog(normalizedUrl).substring(0, 50)}`);
    return { kind: 'blocked', href: BLOCKED_LINK_HREF };
  }

  const safeUrl = sanitizeUrl(normalizedUrl);
  if (safeUrl === BLOCKED_LINK_HREF) {
    return { kind: 'blocked', href: safeUrl };
  }

  if (isInPlaceNavigationHref(safeUrl)) {
    return { kind: 'internal', href: safeUrl };
  }

  return { kind: 'external', href: safeUrl };
}

function findClosestElementWithAttribute(target: EventTarget | null, attribute: string): HTMLElement | null {
  if (target instanceof HTMLElement) {
    return target.closest<HTMLElement>(`[${attribute}]`);
  }

  if (target instanceof Node) {
    return target.parentElement?.closest<HTMLElement>(`[${attribute}]`) ?? null;
  }

  return null;
}

function findClosestAnchor(target: EventTarget | null): HTMLAnchorElement | null {
  if (target instanceof HTMLAnchorElement) {
    return target;
  }

  if (target instanceof HTMLElement) {
    return target.closest<HTMLAnchorElement>('a');
  }

  if (target instanceof Node) {
    return target.parentElement?.closest<HTMLAnchorElement>('a') ?? null;
  }

  return null;
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

interface MarkdownFenceState {
  char: '`' | '~';
  length: number;
}

function readMarkdownFence(line: string): MarkdownFenceState | null {
  const trimmed = line.trimStart();
  const match = trimmed.match(/^(`{3,}|~{3,})/);
  if (!match) {
    return null;
  }

  const marker = match[1];
  return {
    char: marker[0] as '`' | '~',
    length: marker.length,
  };
}

function isMarkdownFenceClosing(line: string, fence: MarkdownFenceState): boolean {
  const trimmed = line.trimStart();
  const pattern = fence.char === '`' ? /^`{3,}/ : /^~{3,}/;
  const match = trimmed.match(pattern);
  if (!match) {
    return false;
  }

  return match[0].length >= fence.length;
}

/**
 * 渲染 Markdown 为 HTML
 */
export function renderMarkdown(content: string): string {
  if (!content) return '';
  
  const lines = content.split('\n');
  const htmlLines: string[] = [];
  let codeFence: MarkdownFenceState | null = null;
  let codeBlockContent: string[] = [];
  let listItems: string[] = [];
  let todoIndex = 0; // 待办事项索引，用于交互式切换
  
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
    const nextFence = readMarkdownFence(line);
    if (nextFence) {
      if (codeFence) {
        if (!isMarkdownFenceClosing(line, codeFence)) {
          codeBlockContent.push(line);
          continue;
        }

        // 结束代码块
        htmlLines.push(`<pre class="bg-stone-800 text-stone-100 rounded-lg p-3 text-xs font-mono overflow-x-auto my-2"><code>${escapeHtml(codeBlockContent.join('\n'))}</code></pre>`);
        codeBlockContent = [];
        codeFence = null;
      } else {
        // 开始代码块
        flushList();
        codeFence = nextFence;
      }
      continue;
    }
    
    if (codeFence) {
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
    const todoMatch = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s*(.*)$/);
    if (todoMatch) {
      flushList();
      const isChecked = todoMatch[2].toLowerCase() === 'x';
      const text = parseInline(todoMatch[3]);
      const checkedClass = isChecked ? 'line-through text-stone-400 dark:text-stone-500' : 'text-stone-700 dark:text-stone-300';
      const checkboxClass = isChecked ? 'text-emerald-500' : 'text-stone-300 dark:text-stone-500';
      const currentIndex = todoIndex++;
      htmlLines.push(`<div class="flex items-start gap-2 my-1">
        <span class="${checkboxClass} cursor-pointer hover:scale-110 transition-transform select-none" data-todo-index="${currentIndex}" role="checkbox" aria-checked="${isChecked}">${isChecked ? '☑' : '☐'}</span>
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
  if (codeFence && codeBlockContent.length > 0) {
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
  ALLOWED_ATTR: ['href', 'class', 'target', 'rel', 'data-todo-index', 'data-link-kind', 'data-task-link-id', 'data-local-link-path', 'role', 'aria-checked'],
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

/**
 * 从点击事件中提取待办索引（如果点击了待办 checkbox）
 * @returns 待办索引，如果不是点击 checkbox 则返回 null
 */
export function getTodoIndexFromClick(event: MouseEvent): number | null {
  const element = findClosestElementWithAttribute(event.target, 'data-todo-index');
  const todoIndexAttr = element?.getAttribute('data-todo-index');
  if (todoIndexAttr !== null && todoIndexAttr !== undefined) {
    const index = parseInt(todoIndexAttr, 10);
    return isNaN(index) ? null : index;
  }
  return null;
}

export function getMarkdownLinkFromClick(event: MouseEvent): MarkdownClickTarget | null {
  const anchor = findClosestAnchor(event.target);
  if (!anchor) {
    return null;
  }

  const href = anchor.getAttribute('href') ?? '';
  const kindAttr = anchor.getAttribute('data-link-kind');

  if (kindAttr === 'task') {
    const taskId = anchor.getAttribute('data-task-link-id');
    if (!taskId) {
      return null;
    }

    return {
      kind: 'task',
      href,
      taskId,
      anchor,
    };
  }

  if (kindAttr === 'blocked') {
    return {
      kind: 'blocked',
      href,
      anchor,
    };
  }

  if (kindAttr === 'internal') {
    return {
      kind: 'internal',
      href,
      anchor,
    };
  }

  if (kindAttr === 'local') {
    const localPath = anchor.getAttribute('data-local-link-path');
    if (!localPath) {
      return null;
    }

    return {
      kind: 'local',
      href,
      localPath,
      anchor,
    };
  }

  if (!href) {
    return null;
  }

  return {
    kind: 'external',
    href,
    anchor,
  };
}

export async function activateLocalMarkdownLink(localPath: string): Promise<LocalMarkdownLinkActivationResult> {
  const normalizedPath = normalizeLocalPathInput(localPath);
  if (!normalizedPath) {
    return 'unsupported';
  }

  if (isNetworkLocalPath(normalizedPath)) {
    const copied = await copyTextToClipboard(normalizedPath);
    return copied ? 'copied-network-path' : 'unsupported';
  }

  if (isHighRiskLocalPath(normalizedPath)) {
    const copied = await copyTextToClipboard(normalizedPath);
    return copied ? 'copied-risky-path' : 'unsupported';
  }

  const attemptedOpen = tryOpenLocalPathInCurrentGesture(normalizedPath);
  const copied = await copyTextToClipboard(normalizedPath);
  if (attemptedOpen) {
    return copied ? 'attempted-and-copied' : 'attempted';
  }

  return copied ? 'copied' : 'unsupported';
}

export function notifyLocalMarkdownLinkResult(
  result: LocalMarkdownLinkActivationResult,
  toast: Pick<ToastService, 'info' | 'warning'>,
): void {
  if (result === 'attempted-and-copied') {
    toast.info('已尝试打开本地路径', '若浏览器拦截，路径已复制到剪贴板');
    return;
  }

  if (result === 'attempted') {
    toast.info('已尝试打开本地路径', '若浏览器未放行，请改用资源管理器或运行窗口打开');
    return;
  }

  if (result === 'copied') {
    toast.warning('浏览器限制已拦截本地路径', '路径已复制到剪贴板，可粘贴到资源管理器或运行窗口');
    return;
  }

  if (result === 'copied-network-path') {
    toast.warning('已阻止直接打开网络共享路径', '为避免意外访问远程共享，路径已复制到剪贴板');
    return;
  }

  if (result === 'copied-risky-path') {
    toast.warning('已阻止直接启动高风险本地文件', '该路径已复制到剪贴板，请确认可信后再手动打开');
    return;
  }

  toast.warning('无法直接打开本地路径', '当前环境不支持本地路径跳转，请手动复制后打开');
}

/**
 * 统一处理 Markdown 预览区的链接点击
 *
 * 返回值含义：
 * - `MarkdownClickTarget`（kind=task）：调用方需处理任务跳转
 * - `false`：链接已检测到且内部消化（blocked / internal / local / external）
 * - `null`：点击目标不是 Markdown 链接
 *
 * blocked / internal / local 会自动 preventDefault + stopPropagation；
 * external 仅 stopPropagation（保留浏览器默认的新标签页打开行为）。
 */
export function handleMarkdownLinkAction(
  event: MouseEvent,
  toast: Pick<ToastService, 'info' | 'warning'>,
): MarkdownClickTarget | false | null {
  const linkTarget = getMarkdownLinkFromClick(event);
  if (!linkTarget) {
    return null;
  }

  event.stopPropagation();

  if (linkTarget.kind === 'blocked' || linkTarget.kind === 'internal') {
    event.preventDefault();
    return false;
  }

  if (linkTarget.kind === 'task') {
    event.preventDefault();
    return linkTarget;
  }

  if (linkTarget.kind === 'local' && linkTarget.localPath) {
    event.preventDefault();
    void activateLocalMarkdownLink(linkTarget.localPath).then(result =>
      notifyLocalMarkdownLinkResult(result, toast),
    );
    return false;
  }

  // external: 默认浏览器行为（target="_blank" + rel="noopener noreferrer"）
  return false;
}

/**
 * 提取纯文本摘要（用于预览）
 */
function extractPlainText(content: string, maxLength: number = 100): string {
  if (!content) return '';
  
  // 移除 Markdown 语法
  let text = content
    .replace(/(```|~~~)[\s\S]*?\1/g, '') // 代码块
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
    .replace(/^\s*[-*+]\s+\[([ xX])\]\s*/gm, '') // 待办
    .replace(/\n+/g, ' ') // 换行转空格
    .trim();
  
  if (text.length > maxLength) {
    text = text.slice(0, maxLength) + '...';
  }
  
  return text;
}

