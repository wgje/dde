import { describe, it, expect } from 'vitest';
import { toggleMarkdownTodo, renderMarkdown } from './markdown';

describe('toggleMarkdownTodo', () => {
  it('应将未完成的待办切换为完成', () => {
    const content = '- [ ] 买菜\n- [ ] 做饭';
    const result = toggleMarkdownTodo(content, 0);
    expect(result).toBe('- [x] 买菜\n- [ ] 做饭');
  });

  it('应将完成的待办切换为未完成', () => {
    const content = '- [x] 买菜\n- [ ] 做饭';
    const result = toggleMarkdownTodo(content, 0);
    expect(result).toBe('- [ ] 买菜\n- [ ] 做饭');
  });

  it('应正确切换第二个待办', () => {
    const content = '- [ ] 买菜\n- [ ] 做饭';
    const result = toggleMarkdownTodo(content, 1);
    expect(result).toBe('- [ ] 买菜\n- [x] 做饭');
  });

  it('应处理大写 X 标记', () => {
    const content = '- [X] 已完成任务';
    const result = toggleMarkdownTodo(content, 0);
    expect(result).toBe('- [ ] 已完成任务');
  });

  it('应忽略非待办行', () => {
    const content = '# 标题\n- [ ] 任务一\n普通段落\n- [ ] 任务二';
    const result = toggleMarkdownTodo(content, 1);
    expect(result).toBe('# 标题\n- [ ] 任务一\n普通段落\n- [x] 任务二');
  });

  it('todoIndex 超出范围时不应改变内容', () => {
    const content = '- [ ] 唯一任务';
    const result = toggleMarkdownTodo(content, 5);
    expect(result).toBe('- [ ] 唯一任务');
  });

  it('应处理空内容', () => {
    const result = toggleMarkdownTodo('', 0);
    expect(result).toBe('');
  });

  it('应处理混合完成和未完成状态', () => {
    const content = '- [x] 完成\n- [ ] 未完成\n- [x] 也完成';
    // 切换中间那个（index 1）
    const result = toggleMarkdownTodo(content, 1);
    expect(result).toBe('- [x] 完成\n- [x] 未完成\n- [x] 也完成');
  });

  it('应处理待办与普通列表混合的情况', () => {
    const content = '- 普通列表项\n- [ ] 待办项\n- 另一个普通项';
    const result = toggleMarkdownTodo(content, 0);
    expect(result).toBe('- 普通列表项\n- [x] 待办项\n- 另一个普通项');
  });
});

describe('renderMarkdown - 待办渲染', () => {
  it('应渲染未完成待办带有 data-todo-index', () => {
    const html = renderMarkdown('- [ ] 测试任务');
    expect(html).toContain('data-todo-index="0"');
    expect(html).toContain('☐');
    expect(html).toContain('cursor-pointer');
  });

  it('应渲染完成待办带有 data-todo-index', () => {
    const html = renderMarkdown('- [x] 已完成');
    expect(html).toContain('data-todo-index="0"');
    expect(html).toContain('☑');
  });

  it('多个待办应有递增的 data-todo-index', () => {
    const html = renderMarkdown('- [ ] 第一个\n- [x] 第二个\n- [ ] 第三个');
    expect(html).toContain('data-todo-index="0"');
    expect(html).toContain('data-todo-index="1"');
    expect(html).toContain('data-todo-index="2"');
  });

  it('非待办行不应影响 todo index 计数', () => {
    const html = renderMarkdown('# 标题\n- [ ] 任务一\n普通文字\n- [ ] 任务二');
    expect(html).toContain('data-todo-index="0"');
    expect(html).toContain('data-todo-index="1"');
    expect(html).not.toContain('data-todo-index="2"');
  });

  it('完成态待办应有 line-through 样式', () => {
    const html = renderMarkdown('- [x] 已完成');
    expect(html).toContain('line-through');
  });

  it('未完成态待办不应有 line-through 样式', () => {
    const html = renderMarkdown('- [ ] 未完成');
    expect(html).not.toContain('line-through');
  });
});
