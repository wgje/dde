import { describe, it, expect, vi } from 'vitest';
import { toggleMarkdownTodo, renderMarkdown, getMarkdownLinkFromClick, resolveMarkdownLinkTarget, activateLocalMarkdownLink } from './markdown';

function decodeBackslashEntities(value: string | null): string | null {
  return value?.split('&#92;').join('\\') ?? null;
}

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

  it('应按索引切换重复文案待办', () => {
    const content = '- [ ] 重复事项\n- [ ] 重复事项';
    const result = toggleMarkdownTodo(content, 1);
    expect(result).toBe('- [ ] 重复事项\n- [x] 重复事项');
  });

  it('应忽略 fenced code block 中的待办索引', () => {
    const content = '- [ ] 可切换\n```md\n- [ ] 不可切换\n```\n- [ ] 第二个可切换';
    const result = toggleMarkdownTodo(content, 1);
    expect(result).toBe('- [ ] 可切换\n```md\n- [ ] 不可切换\n```\n- [x] 第二个可切换');
  });

  it('应支持切换带缩进的待办', () => {
    const content = '  - [ ] 缩进待办';
    const result = toggleMarkdownTodo(content, 0);
    expect(result).toBe('  - [x] 缩进待办');
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

  it('~~~ fenced code block 中的待办不应被渲染为可交互待办', () => {
    const html = renderMarkdown('~~~md\n- [ ] 代码块待办\n~~~\n- [ ] 正常待办');
    expect(html).toContain('data-todo-index="0"');
    expect(html).not.toContain('data-todo-index="1"');
    expect(html).toContain('正常待办');
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

describe('renderMarkdown - 链接渲染', () => {
  it('应将 task: 链接渲染为稳定任务链接属性', () => {
    const html = renderMarkdown('[关联任务](task:task-123)');

    expect(html).toContain('data-link-kind="task"');
    expect(html).toContain('data-task-link-id="task-123"');
    expect(html).toContain('href="#task:task-123"');
    expect(html).not.toContain('target="_blank"');
  });

  it('应支持显式 Markdown 链接中的平衡括号 URL', () => {
    const html = renderMarkdown('[维基](https://en.wikipedia.org/wiki/Function_(mathematics))');

    expect(html).toContain('href="https://en.wikipedia.org/wiki/Function_(mathematics)"');
  });

  it('应支持显式 Markdown 链接标签中的嵌套方括号', () => {
    const html = renderMarkdown('[路线 [v2]](https://example.com/docs)');

    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('>路线 [v2]<');
  });

  it('应在外链标签内保留行内 Markdown 格式', () => {
    const html = renderMarkdown('[**粗体**说明](https://example.com/docs)');

    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('<strong>粗体</strong>说明');
  });

  it('应在任务链接标签内保留行内 Markdown 格式', () => {
    const html = renderMarkdown('[`任务`说明](task:task-123)');

    expect(html).toContain('data-link-kind="task"');
    expect(html).toContain('<code class="px-1 py-0.5');
    expect(html).toContain('任务');
  });

  it('应忽略显式 Markdown 链接里的可选 title 并保留真实 href', () => {
    const html = renderMarkdown('[官网](https://example.com/docs "外部标题")');

    expect(html).toContain('href="https://example.com/docs"');
    expect(html).not.toContain('&quot;外部标题&quot;');
  });

  it('应支持显式本地路径链接中的括号', () => {
    const container = document.createElement('div');
    container.innerHTML = renderMarkdown('[文档](C:\\Docs\\Folder (Archive)\\Plan.md)');
    const link = container.querySelector('a');

    expect(link?.getAttribute('data-link-kind')).toBe('local');
    expect(decodeBackslashEntities(link?.getAttribute('data-local-link-path'))).toBe('C:\\Docs\\Folder (Archive)\\Plan.md');
  });

  it('应支持显式 UNC 共享路径中的空格', () => {
    const container = document.createElement('div');
    container.innerHTML = renderMarkdown('[共享](\\\\server\\My Share\\report.md)');
    const link = container.querySelector('a');

    expect(link?.getAttribute('data-link-kind')).toBe('local');
    expect(decodeBackslashEntities(link?.getAttribute('data-local-link-path'))).toBe('\\\\server\\My Share\\report.md');
  });

  it('应保留外链的 target 和 rel 安全属性', () => {
    const html = renderMarkdown('[官网](https://example.com)');

    expect(html).toContain('data-link-kind="external"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('应将显式 www. 链接规范化为 https 外链', () => {
    const html = renderMarkdown('[官网](www.example.com/docs)');

    expect(html).toContain('href="https://www.example.com/docs"');
    expect(html).toContain('data-link-kind="external"');
  });

  it('应将页内锚点链接标记为站内导航且不强制新开页', () => {
    const html = renderMarkdown('[跳转](#section-1)');

    expect(html).toContain('data-link-kind="internal"');
    expect(html).toContain('href="#section-1"');
    expect(html).not.toContain('target="_blank"');
  });

  it('应将相对路径链接标记为站内导航且不强制新开页', () => {
    const html = renderMarkdown('[相对](./docs/guide)');

    expect(html).toContain('data-link-kind="internal"');
    expect(html).toContain('href="./docs/guide"');
    expect(html).not.toContain('target="_blank"');
  });

  it('应将协议相对 URL 视为外链而不是站内导航', () => {
    const html = renderMarkdown('[外链](//example.com/docs)');

    expect(html).toContain('data-link-kind="external"');
    expect(html).toContain('href="//example.com/docs"');
    expect(html).toContain('target="_blank"');
  });

  it('应保留 mailto 链接但不强制新开页', () => {
    const html = renderMarkdown('[邮件](mailto:test@example.com)');

    expect(html).toContain('data-link-kind="external"');
    expect(html).toContain('href="mailto:test@example.com"');
    expect(html).not.toContain('target="_blank"');
  });

  it('应将危险协议渲染为 blocked 链接', () => {
    const html = renderMarkdown('[危险](javascript:alert(1))');

    expect(html).toContain('data-link-kind="blocked"');
    expect(html).toContain('href="#__nf_blocked__"');
  });

  it('应将 file 链接渲染为受控本地路径链接', () => {
    const container = document.createElement('div');
    container.innerHTML = renderMarkdown('[危险](file:///C:/secret.txt)');
    const link = container.querySelector('a');

    expect(link?.getAttribute('data-link-kind')).toBe('local');
    expect(link?.getAttribute('href')).toBe('#local-path');
    expect(decodeBackslashEntities(link?.getAttribute('data-local-link-path'))).toBe('C:\\secret.txt');
    expect(container.innerHTML).not.toContain('href="file:///C:/secret.txt"');
  });

  it('应自动将裸 http 链接渲染为外链', () => {
    const html = renderMarkdown('访问 https://example.com/docs 查看说明');

    expect(html).toContain('data-link-kind="external"');
    expect(html).toContain('href="https://example.com/docs"');
  });

  it('应自动识别大小写混合的裸外链协议', () => {
    const html = renderMarkdown('访问 HTTPS://example.com/docs 查看说明');

    expect(html).toContain('data-link-kind="external"');
    expect(html).toContain('href="HTTPS://example.com/docs"');
  });

  it('应自动将裸 task: 引用渲染为内部任务链接', () => {
    const html = renderMarkdown('关联任务 task:task-123');

    expect(html).toContain('data-link-kind="task"');
    expect(html).toContain('data-task-link-id="task-123"');
  });

  it('应自动识别大小写混合的裸 task: 引用', () => {
    const html = renderMarkdown('关联任务 TASK:task-123');

    expect(html).toContain('data-link-kind="task"');
    expect(html).toContain('data-task-link-id="task-123"');
  });

  it('应将裸 Windows 路径渲染为本地路径链接', () => {
    const container = document.createElement('div');
    container.innerHTML = renderMarkdown('打开 C:\\Work\\Plan.md');
    const link = container.querySelector('a');

    expect(link?.getAttribute('data-link-kind')).toBe('local');
    expect(decodeBackslashEntities(link?.getAttribute('data-local-link-path'))).toBe('C:\\Work\\Plan.md');
    expect(link?.getAttribute('href')).toBe('#local-path');
  });

  it('应将 host-based file URL 渲染为本地路径链接', () => {
    const container = document.createElement('div');
    container.innerHTML = renderMarkdown('打开 file://server/share/report.md');
    const link = container.querySelector('a');

    expect(link?.getAttribute('data-link-kind')).toBe('local');
    expect(decodeBackslashEntities(link?.getAttribute('data-local-link-path'))).toBe('\\\\server\\share\\report.md');
    expect(link?.getAttribute('href')).toBe('#local-path');
  });

  it('应将 file://localhost 视为本地路径而不是网络共享', () => {
    const container = document.createElement('div');
    container.innerHTML = renderMarkdown('打开 file://localhost/C:/Docs/Plan.md');
    const link = container.querySelector('a');

    expect(link?.getAttribute('data-link-kind')).toBe('local');
    expect(decodeBackslashEntities(link?.getAttribute('data-local-link-path'))).toBe('C:\\Docs\\Plan.md');
  });

  it('应保留与旧占位符文本同名的普通内容', () => {
    const html = renderMarkdown('保留 %%NANOFLOWSLOT0%% 文本和 [链接](https://example.com)');

    expect(html).toContain('%%NANOFLOWSLOT0%%');
    expect(html).toContain('href="https://example.com"');
  });
});

describe('markdown link helpers', () => {
  it('应将 task 链接目标解析为内部任务引用', () => {
    expect(resolveMarkdownLinkTarget('task:task-123')).toEqual({
      kind: 'task',
      taskId: 'task-123',
      href: '#task:task-123',
    });
  });

  it('应从点击事件中提取任务链接目标', () => {
    const container = document.createElement('div');
    container.innerHTML = renderMarkdown('[跳转](task:task-123)');
    const link = container.querySelector('a');

    const target = getMarkdownLinkFromClick({ target: link } as unknown as MouseEvent);

    expect(target).toMatchObject({
      kind: 'task',
      taskId: 'task-123',
      href: '#task:task-123',
    });
  });

  it('应从点击事件中提取外链目标', () => {
    const container = document.createElement('div');
    container.innerHTML = renderMarkdown('[官网](https://example.com)');
    const link = container.querySelector('a');

    const target = getMarkdownLinkFromClick({ target: link } as unknown as MouseEvent);

    expect(target).toMatchObject({
      kind: 'external',
      href: 'https://example.com',
    });
  });

  it('应支持从锚点内部嵌套节点提取任务链接目标', () => {
    const anchor = document.createElement('a');
    anchor.setAttribute('href', '#task:task-123');
    anchor.setAttribute('data-link-kind', 'task');
    anchor.setAttribute('data-task-link-id', 'task-123');
    const inner = document.createElement('strong');
    anchor.appendChild(inner);

    const target = getMarkdownLinkFromClick({ target: inner } as unknown as MouseEvent);

    expect(target).toMatchObject({
      kind: 'task',
      taskId: 'task-123',
      href: '#task:task-123',
    });
  });

  it('应从点击事件中提取 blocked 链接目标', () => {
    const anchor = document.createElement('a');
    anchor.setAttribute('href', '#__nf_blocked__');
    anchor.setAttribute('data-link-kind', 'blocked');
    const inner = document.createElement('strong');
    anchor.appendChild(inner);

    const target = getMarkdownLinkFromClick({ target: inner } as unknown as MouseEvent);

    expect(target).toMatchObject({
      kind: 'blocked',
      href: '#__nf_blocked__',
    });
  });

  it('应从点击事件中提取站内导航链接目标', () => {
    const anchor = document.createElement('a');
    anchor.setAttribute('href', '#section-1');
    anchor.setAttribute('data-link-kind', 'internal');

    const target = getMarkdownLinkFromClick({ target: anchor } as unknown as MouseEvent);

    expect(target).toMatchObject({
      kind: 'internal',
      href: '#section-1',
    });
  });

  it('应从点击事件中提取本地路径链接目标', () => {
    const anchor = document.createElement('a');
    anchor.setAttribute('href', '#local-path');
    anchor.setAttribute('data-link-kind', 'local');
    anchor.setAttribute('data-local-link-path', 'C:\\Work\\Plan.md');

    const target = getMarkdownLinkFromClick({ target: anchor } as unknown as MouseEvent);

    expect(target).toMatchObject({
      kind: 'local',
      href: '#local-path',
      localPath: 'C:\\Work\\Plan.md',
    });
  });

  it('应在激活本地路径时先尝试打开再执行剪贴板回退', async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const steps: string[] = [];
    const writeText = vi.fn().mockImplementation(async () => {
      steps.push('clipboard');
    });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      steps.push('click');
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    try {
      const result = await activateLocalMarkdownLink('C:\\Work\\Plan.md');

      expect(result).toBe('attempted-and-copied');
      expect(steps).toEqual(['click', 'clipboard']);
      expect(writeText).toHaveBeenCalledWith('C:\\Work\\Plan.md');
      expect(clickSpy).toHaveBeenCalled();
    } finally {
      clickSpy.mockRestore();
      if (originalClipboard) {
        Object.defineProperty(navigator, 'clipboard', originalClipboard);
      } else {
        Reflect.deleteProperty(navigator as object, 'clipboard');
      }
    }
  });

  it('应对网络共享路径仅复制不直接尝试打开', async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    try {
      const result = await activateLocalMarkdownLink('\\\\server\\share\\report.md');

      expect(result).toBe('copied-network-path');
      expect(writeText).toHaveBeenCalledWith('\\\\server\\share\\report.md');
      expect(clickSpy).not.toHaveBeenCalled();
    } finally {
      clickSpy.mockRestore();
      if (originalClipboard) {
        Object.defineProperty(navigator, 'clipboard', originalClipboard);
      } else {
        Reflect.deleteProperty(navigator as object, 'clipboard');
      }
    }
  });

  it('应对高风险可执行路径仅复制不直接尝试打开', async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    try {
      const result = await activateLocalMarkdownLink('C:\\Windows\\System32\\calc.exe');

      expect(result).toBe('copied-risky-path');
      expect(writeText).toHaveBeenCalledWith('C:\\Windows\\System32\\calc.exe');
      expect(clickSpy).not.toHaveBeenCalled();
    } finally {
      clickSpy.mockRestore();
      if (originalClipboard) {
        Object.defineProperty(navigator, 'clipboard', originalClipboard);
      } else {
        Reflect.deleteProperty(navigator as object, 'clipboard');
      }
    }
  });

  it('应将带尾部点的高风险本地文件视为复制优先', async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    try {
      const result = await activateLocalMarkdownLink('C:\\Users\\Public\\payload.exe.');

      expect(result).toBe('copied-risky-path');
      expect(writeText).toHaveBeenCalledWith('C:\\Users\\Public\\payload.exe.');
      expect(clickSpy).not.toHaveBeenCalled();
    } finally {
      clickSpy.mockRestore();
      if (originalClipboard) {
        Object.defineProperty(navigator, 'clipboard', originalClipboard);
      } else {
        Reflect.deleteProperty(navigator as object, 'clipboard');
      }
    }
  });

  it('应将带 NTFS stream 后缀的高风险本地文件视为复制优先', async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    try {
      const result = await activateLocalMarkdownLink('C:\\Users\\Public\\payload.exe::$DATA');

      expect(result).toBe('copied-risky-path');
      expect(writeText).toHaveBeenCalledWith('C:\\Users\\Public\\payload.exe::$DATA');
      expect(clickSpy).not.toHaveBeenCalled();
    } finally {
      clickSpy.mockRestore();
      if (originalClipboard) {
        Object.defineProperty(navigator, 'clipboard', originalClipboard);
      } else {
        Reflect.deleteProperty(navigator as object, 'clipboard');
      }
    }
  });

  it('应将扩展高风险文件类型视为复制优先', async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    try {
      const result = await activateLocalMarkdownLink('C:\\Users\\Public\\legacy-launcher.pif');

      expect(result).toBe('copied-risky-path');
      expect(writeText).toHaveBeenCalledWith('C:\\Users\\Public\\legacy-launcher.pif');
      expect(clickSpy).not.toHaveBeenCalled();
    } finally {
      clickSpy.mockRestore();
      if (originalClipboard) {
        Object.defineProperty(navigator, 'clipboard', originalClipboard);
      } else {
        Reflect.deleteProperty(navigator as object, 'clipboard');
      }
    }
  });
});
