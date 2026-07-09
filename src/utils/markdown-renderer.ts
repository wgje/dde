export interface MarkdownRendererDeps {
  readonly parseInline: (text: string) => string;
  readonly escapeHtml: (text: string) => string;
}

interface MarkdownFenceState {
  char: '`' | '~';
  length: number;
}

interface MarkdownRenderState {
  codeFence: MarkdownFenceState | null;
  codeBlockContent: string[];
  listItems: string[];
  todoIndex: number;
}

export function renderMarkdownHtml(content: string, deps: MarkdownRendererDeps): string {
  if (!content) return '';

  const lines = content.split('\n');
  const htmlLines: string[] = [];
  const state: MarkdownRenderState = {
    codeFence: null,
    codeBlockContent: [],
    listItems: [],
    todoIndex: 0,
  };

  for (const line of lines) {
    renderMarkdownLine(line, htmlLines, state, deps);
  }

  flushOpenCodeBlock(htmlLines, state, deps);
  flushMarkdownList(htmlLines, state);

  return htmlLines.join('');
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

function renderMarkdownLine(
  line: string,
  htmlLines: string[],
  state: MarkdownRenderState,
  deps: MarkdownRendererDeps,
): void {
  if (handleCodeFenceLine(line, htmlLines, state, deps)) return;
  if (state.codeFence) {
    state.codeBlockContent.push(line);
    return;
  }
  if (handleBlankMarkdownLine(line, htmlLines, state)) return;
  if (handleHeadingMarkdownLine(line, htmlLines, state, deps)) return;
  if (handleTodoMarkdownLine(line, htmlLines, state, deps)) return;
  if (handleUnorderedMarkdownLine(line, state, deps)) return;
  if (handleOrderedMarkdownLine(line, htmlLines, state, deps)) return;
  if (handleHorizontalRuleLine(line, htmlLines, state)) return;
  if (handleBlockquoteMarkdownLine(line, htmlLines, state, deps)) return;
  flushMarkdownList(htmlLines, state);
  htmlLines.push(`<p class="text-stone-600 my-1">${deps.parseInline(line)}</p>`);
}

function handleCodeFenceLine(
  line: string,
  htmlLines: string[],
  state: MarkdownRenderState,
  deps: MarkdownRendererDeps,
): boolean {
  const nextFence = readMarkdownFence(line);
  if (!nextFence) return false;

  if (state.codeFence) {
    if (!isMarkdownFenceClosing(line, state.codeFence)) {
      state.codeBlockContent.push(line);
      return true;
    }

    appendCodeBlock(htmlLines, state.codeBlockContent, deps);
    state.codeBlockContent = [];
    state.codeFence = null;
    return true;
  }

  flushMarkdownList(htmlLines, state);
  state.codeFence = nextFence;
  return true;
}

function handleBlankMarkdownLine(
  line: string,
  htmlLines: string[],
  state: MarkdownRenderState,
): boolean {
  if (line.trim() !== '') return false;
  flushMarkdownList(htmlLines, state);
  htmlLines.push('<br/>');
  return true;
}

function handleHeadingMarkdownLine(
  line: string,
  htmlLines: string[],
  state: MarkdownRenderState,
  deps: MarkdownRendererDeps,
): boolean {
  const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
  if (!headingMatch) return false;
  flushMarkdownList(htmlLines, state);
  const level = headingMatch[1].length;
  const text = deps.parseInline(headingMatch[2]);
  const sizeClass = ['text-xl font-bold', 'text-lg font-bold', 'text-base font-semibold', 'text-sm font-semibold', 'text-xs font-semibold', 'text-xs font-medium'][level - 1];
  htmlLines.push(`<h${level} class="${sizeClass} text-stone-800 my-2">${text}</h${level}>`);
  return true;
}

function handleTodoMarkdownLine(
  line: string,
  htmlLines: string[],
  state: MarkdownRenderState,
  deps: MarkdownRendererDeps,
): boolean {
  const todoMatch = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s*(.*)$/);
  if (!todoMatch) return false;
  flushMarkdownList(htmlLines, state);
  const isChecked = todoMatch[2].toLowerCase() === 'x';
  const text = deps.parseInline(todoMatch[3]);
  const checkedClass = isChecked ? 'line-through text-stone-400 dark:text-stone-500' : 'text-stone-700 dark:text-stone-300';
  const checkboxClass = isChecked ? 'text-emerald-500' : 'text-stone-300 dark:text-stone-500';
  const currentIndex = state.todoIndex++;
  htmlLines.push(`<div class="flex items-start gap-2 my-1">
        <span class="${checkboxClass} cursor-pointer hover:scale-110 transition-transform select-none" data-todo-index="${currentIndex}" role="checkbox" aria-checked="${isChecked}">${isChecked ? '☑' : '☐'}</span>
        <span class="${checkedClass}">${text}</span>
      </div>`);
  return true;
}

function handleUnorderedMarkdownLine(
  line: string,
  state: MarkdownRenderState,
  deps: MarkdownRendererDeps,
): boolean {
  const ulMatch = line.match(/^[-*+]\s+(.+)$/);
  if (!ulMatch) return false;
  state.listItems.push(deps.parseInline(ulMatch[1]));
  return true;
}

function handleOrderedMarkdownLine(
  line: string,
  htmlLines: string[],
  state: MarkdownRenderState,
  deps: MarkdownRendererDeps,
): boolean {
  const olMatch = line.match(/^\d+\.\s+(.+)$/);
  if (!olMatch) return false;
  flushMarkdownList(htmlLines, state);
  htmlLines.push(`<div class="flex items-start gap-2 my-1">
        <span class="text-stone-400 text-xs">•</span>
        <span class="text-stone-600">${deps.parseInline(olMatch[1])}</span>
      </div>`);
  return true;
}

function handleHorizontalRuleLine(
  line: string,
  htmlLines: string[],
  state: MarkdownRenderState,
): boolean {
  if (!/^[-*_]{3,}$/.test(line.trim())) return false;
  flushMarkdownList(htmlLines, state);
  htmlLines.push('<hr class="my-3 border-stone-200"/>');
  return true;
}

function handleBlockquoteMarkdownLine(
  line: string,
  htmlLines: string[],
  state: MarkdownRenderState,
  deps: MarkdownRendererDeps,
): boolean {
  if (!line.startsWith('>')) return false;
  flushMarkdownList(htmlLines, state);
  const text = deps.parseInline(line.slice(1).trim());
  htmlLines.push(`<blockquote class="border-l-4 border-stone-300 pl-3 my-2 text-stone-500 italic">${text}</blockquote>`);
  return true;
}

function flushOpenCodeBlock(
  htmlLines: string[],
  state: MarkdownRenderState,
  deps: MarkdownRendererDeps,
): void {
  if (state.codeFence && state.codeBlockContent.length > 0) {
    appendCodeBlock(htmlLines, state.codeBlockContent, deps);
  }
}

function appendCodeBlock(
  htmlLines: string[],
  codeBlockContent: readonly string[],
  deps: MarkdownRendererDeps,
): void {
  htmlLines.push(`<pre class="bg-stone-800 text-stone-100 rounded-lg p-3 text-xs font-mono overflow-x-auto my-2"><code>${deps.escapeHtml(codeBlockContent.join('\n'))}</code></pre>`);
}

function flushMarkdownList(htmlLines: string[], state: MarkdownRenderState): void {
  if (state.listItems.length === 0) return;
  htmlLines.push('<ul class="list-disc list-inside space-y-1 my-2">');
  for (const item of state.listItems) {
    htmlLines.push(`<li class="text-stone-600">${item}</li>`);
  }
  htmlLines.push('</ul>');
  state.listItems = [];
}
