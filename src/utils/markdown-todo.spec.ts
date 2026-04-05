import { describe, expect, it } from 'vitest';

import {
  hasIncompleteMarkdownTodo,
  setMarkdownTodoChecked,
  summarizeMarkdownTodos,
  toggleMarkdownTodoState,
} from './markdown-todo';

describe('markdown-todo', () => {
  it('应统计缩进待办并跳过 fenced code block', () => {
    const summary = summarizeMarkdownTodos([
      '- [ ] 顶层待办',
      '  - [x] 缩进待办',
      '```md',
      '- [ ] 代码块中的待办',
      '```',
      '~~~ts',
      '- [ ] 波浪线代码块中的待办',
      '~~~',
    ].join('\n'));

    expect(summary.total).toBe(2);
    expect(summary.completed).toBe(1);
    expect(summary.pending).toBe(1);
    expect(summary.items.map(item => item.text)).toEqual(['顶层待办', '缩进待办']);
  });

  it('应把未闭合 fenced code block 后的待办排除在外', () => {
    expect(hasIncompleteMarkdownTodo('- [ ] 可见待办\n```md\n- [ ] 不应计入')).toBe(true);
    expect(summarizeMarkdownTodos('```md\n- [ ] 不应计入').total).toBe(0);
  });

  it('应按索引切换重复文案待办，而不是按文本误命中', () => {
    const content = ['- [ ] 重复事项', '- [ ] 重复事项', '- [ ] 第三项'].join('\n');

    expect(toggleMarkdownTodoState(content, 1)).toBe([
      '- [ ] 重复事项',
      '- [x] 重复事项',
      '- [ ] 第三项',
    ].join('\n'));
  });

  it('setMarkdownTodoChecked 应支持把指定索引直接设为完成', () => {
    const content = ['- [ ] 第一项', '- [ ] 第二项'].join('\n');

    expect(setMarkdownTodoChecked(content, 0, true)).toBe([
      '- [x] 第一项',
      '- [ ] 第二项',
    ].join('\n'));
  });
});