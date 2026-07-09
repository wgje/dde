import type { ToastService } from '../services/toast.service';
import { securityLogger } from './standalone-logger';

const TASK_LINK_PROTOCOL = 'task:';
export const LOCAL_LINK_HREF = '#local-path';
export const BLOCKED_LINK_HREF = '#__nf_blocked__';

const DANGEROUS_PROTOCOLS = [
  'javascript:',
  'vbscript:',
  'data:text/html',
  'data:application/javascript',
  'data:application/x-javascript',
  'data:text/javascript',
  'data:image/svg+xml',
  'file:',
  'blob:',
  'mhtml:',
  'x-javascript:',
];

const ENCODED_PROTOCOL_PATTERN = /^\s*(?:j[\s]*a[\s]*v[\s]*a|v[\s]*b|d[\s]*a[\s]*t[\s]*a)[\s]*(?:&#[xX]?[0-9a-fA-F]+;?|[\s])*:/i;
const SAFE_PROTOCOLS = ['http:', 'https:', 'mailto:', 'tel:', 'ftp:', '#'];

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
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }

  if (!parsed || parsed.protocol !== 'file:') {
    return null;
  }

  const pathname = decodeURIComponent(parsed.pathname);
  if (parsed.host && parsed.host.toLowerCase() !== 'localhost') {
    const uncPath = normalizeSlashes(pathname);
    return `\\\\${parsed.host}${uncPath}`;
  }

  return normalizeSlashes(pathname.replace(/^\/([a-zA-Z]:)/, '$1'));
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

export function normalizeExternalAutoLink(candidate: string): string {
  return /^www\./i.test(candidate) ? `https://${candidate}` : candidate;
}

export function isInPlaceNavigationHref(href: string): boolean {
  if (href.startsWith('//')) {
    return false;
  }

  return href.startsWith('#') || href.startsWith('/') || href.startsWith('./') || href.startsWith('../');
}

export function shouldOpenExternalLinkInNewTab(href: string): boolean {
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

function isSafeUrl(url: string): boolean {
  if (!url) return false;

  const normalized = url.toLowerCase().trim();
  const decodedNormalized = decodeHtmlEntitiesForProtocolCheck(normalized);
  const normalizedForProtocolCheck = decodedNormalized
    .replace(/[\u0000-\u001f\u007f\s]+/g, '');

  if (DANGEROUS_PROTOCOLS.some(proto => normalizedForProtocolCheck.startsWith(proto))) {
    return false;
  }

  if (ENCODED_PROTOCOL_PATTERN.test(normalizedForProtocolCheck)) {
    return false;
  }

  if (decodedNormalized.startsWith('data:')
    && (decodedNormalized.includes('svg') || decodedNormalized.includes('<script') || decodedNormalized.includes('onerror'))) {
    return false;
  }

  if (decodedNormalized.startsWith('/') || decodedNormalized.startsWith('#') || decodedNormalized.startsWith('./') || decodedNormalized.startsWith('../')) {
    return true;
  }

  const hasProtocol = /^[a-z][a-z0-9+.-]*:/i.test(decodedNormalized);
  if (hasProtocol) {
    return SAFE_PROTOCOLS.some(proto => decodedNormalized.startsWith(proto));
  }

  return true;
}

export function sanitizeUrl(url: string): string {
  const trimmed = url.trim();
  if (!isSafeUrl(trimmed)) {
    securityLogger.warn(`Blocked potentially dangerous URL: ${sanitizeUrlForLog(trimmed).substring(0, 50)}`);
    return BLOCKED_LINK_HREF;
  }
  return trimmed
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\\/g, '&#92;');
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
    return getTaskClickTarget(anchor, href);
  }

  if (kindAttr === 'blocked') {
    return { kind: 'blocked', href, anchor };
  }

  if (kindAttr === 'internal') {
    return { kind: 'internal', href, anchor };
  }

  if (kindAttr === 'local') {
    return getLocalClickTarget(anchor, href);
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

function getTaskClickTarget(anchor: HTMLAnchorElement, href: string): MarkdownClickTarget | null {
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

function getLocalClickTarget(anchor: HTMLAnchorElement, href: string): MarkdownClickTarget | null {
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

  return false;
}
