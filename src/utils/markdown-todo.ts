export interface MarkdownTodoItem {
  index: number;
  text: string;
  checked: boolean;
  lineIndex: number;
}

export interface MarkdownTodoSummary {
  items: MarkdownTodoItem[];
  total: number;
  completed: number;
  pending: number;
  hasIncomplete: boolean;
}

interface FenceState {
  char: '`' | '~';
  length: number;
}

const TODO_LINE_REGEX = /^(\s*[-*+]\s+\[)([ xX])(\]\s*.*)$/;
const TODO_TEXT_REGEX = /^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/;

function readFenceState(line: string): FenceState | null {
  const trimmed = line.trimStart();
  const match = trimmed.match(/^(`{3,}|~{3,})/);
  if (!match) {
    return null;
  }

  const marker = match[1];
  const char = marker[0] as '`' | '~';
  return {
    char,
    length: marker.length,
  };
}

function isFenceClosing(line: string, fence: FenceState): boolean {
  const trimmed = line.trimStart();
  const pattern = fence.char === '`' ? /^`{3,}/ : /^~{3,}/;
  const match = trimmed.match(pattern);
  if (!match) {
    return false;
  }

  return match[0].length >= fence.length;
}

function forEachMarkdownTodoLine(
  content: string,
  visitor: (match: RegExpMatchArray, line: string, lineIndex: number, todoIndex: number) => void,
): void {
  const lines = content.split('\n');
  let fence: FenceState | null = null;
  let todoIndex = 0;

  lines.forEach((line, lineIndex) => {
    if (fence) {
      if (isFenceClosing(line, fence)) {
        fence = null;
      }
      return;
    }

    const nextFence = readFenceState(line);
    if (nextFence) {
      fence = nextFence;
      return;
    }

    const match = line.match(TODO_TEXT_REGEX);
    if (!match) {
      return;
    }

    visitor(match, line, lineIndex, todoIndex);
    todoIndex += 1;
  });
}

export function summarizeMarkdownTodos(content: string): MarkdownTodoSummary {
  const items: MarkdownTodoItem[] = [];
  let completed = 0;

  forEachMarkdownTodoLine(content, (match, _line, lineIndex, index) => {
    const checked = (match[1] ?? '').toLowerCase() === 'x';
    if (checked) {
      completed += 1;
    }

    items.push({
      index,
      text: (match[2] ?? '').trim(),
      checked,
      lineIndex,
    });
  });

  const total = items.length;
  const pending = total - completed;

  return {
    items,
    total,
    completed,
    pending,
    hasIncomplete: pending > 0,
  };
}

export function hasIncompleteMarkdownTodo(content: string): boolean {
  return summarizeMarkdownTodos(content).hasIncomplete;
}

export function setMarkdownTodoChecked(content: string, todoIndex: number, checked: boolean): string {
  if (!content) {
    return content;
  }

  const lines = content.split('\n');
  let updated = false;
  let fence: FenceState | null = null;
  let currentTodoIndex = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? '';

    if (fence) {
      if (isFenceClosing(line, fence)) {
        fence = null;
      }
      continue;
    }

    const nextFence = readFenceState(line);
    if (nextFence) {
      fence = nextFence;
      continue;
    }

    if (!TODO_TEXT_REGEX.test(line)) {
      continue;
    }

    if (currentTodoIndex === todoIndex) {
      lines[lineIndex] = line.replace(TODO_LINE_REGEX, `$1${checked ? 'x' : ' '}$3`);
      updated = true;
      break;
    }

    currentTodoIndex += 1;
  }

  return updated ? lines.join('\n') : content;
}

export function toggleMarkdownTodoState(content: string, todoIndex: number): string {
  if (!content) {
    return content;
  }

  const summary = summarizeMarkdownTodos(content);
  const target = summary.items.find(item => item.index === todoIndex);
  if (!target) {
    return content;
  }

  return setMarkdownTodoChecked(content, todoIndex, !target.checked);
}