/**
 * Markdown 渲染器安全测试
 * 验证 XSS 防护和 URL 清洗功能
 */
import { describe, it, expect, vi } from 'vitest';
import { renderMarkdown, resolveMarkdownLinkTarget } from './markdown';
import { securityLogger } from './standalone-logger';

function decodeBackslashEntities(value: string | null): string | null {
  return value?.split('&#92;').join('\\') ?? null;
}

describe('Markdown Security', () => {
  describe('XSS Prevention', () => {
    it('should escape HTML tags in plain text', () => {
      const malicious = '<script>alert("xss")</script>';
      const result = renderMarkdown(malicious);
      
      expect(result).not.toContain('<script>');
      expect(result).toContain('&lt;script&gt;');
    });

    it('should escape HTML in inline code', () => {
      const malicious = '`<script>alert("xss")</script>`';
      const result = renderMarkdown(malicious);
      
      expect(result).not.toContain('<script>');
    });

    it('should escape HTML in code blocks', () => {
      const malicious = '```\n<script>alert("xss")</script>\n```';
      const result = renderMarkdown(malicious);
      
      expect(result).not.toContain('<script>alert');
      expect(result).toContain('&lt;script&gt;');
    });

    it('should escape event handlers in text', () => {
      const malicious = '<img onerror="alert(1)" src="x">';
      const result = renderMarkdown(malicious);
      
      // < 被转义，所以整个内容是纯文本，onerror 不会执行
      expect(result).toContain('&lt;img');
      expect(result).not.toContain('<img');
    });

    it('should escape SVG with embedded scripts', () => {
      const malicious = '<svg onload="alert(1)"></svg>';
      const result = renderMarkdown(malicious);
      
      expect(result).not.toContain('<svg');
      expect(result).toContain('&lt;svg');
    });
  });

  describe('URL Sanitization', () => {
    it('should block javascript: protocol', () => {
      const malicious = '[click me](javascript:alert(1))';
      const result = renderMarkdown(malicious);
      
      expect(result).not.toContain('javascript:');
      expect(result).toContain('#__nf_blocked__');
    });

    it('should block vbscript: protocol', () => {
      const malicious = '[click me](vbscript:msgbox(1))';
      const result = renderMarkdown(malicious);
      
      expect(result).not.toContain('vbscript:');
      expect(result).toContain('#__nf_blocked__');
    });

    it('should block data: protocol with HTML', () => {
      const malicious = '[click](data:text/html,<script>alert(1)</script>)';
      const result = renderMarkdown(malicious);
      
      expect(result).not.toContain('data:text/html');
      expect(result).toContain('#__nf_blocked__');
    });

    it('should block encoded javascript protocol', () => {
      // java&#x73;cript: encoded as javascript:
      const malicious = '[click](java&#x73;cript:alert(1))';
      const result = renderMarkdown(malicious);
      
      // 应该被阻止或转义
      expect(result).not.toMatch(/href="java.*script:/i);
    });

    it('should block whitespace-obfuscated dangerous protocols', () => {
      expect(resolveMarkdownLinkTarget('java\tscript:alert(1)')).toMatchObject({
        kind: 'blocked',
        href: '#__nf_blocked__',
      });
      expect(resolveMarkdownLinkTarget('java\nscript:alert(1)')).toMatchObject({
        kind: 'blocked',
        href: '#__nf_blocked__',
      });
      expect(resolveMarkdownLinkTarget('java\rscript:alert(1)')).toMatchObject({
        kind: 'blocked',
        href: '#__nf_blocked__',
      });
    });

    it('should block HTML-entity-obfuscated dangerous protocols', () => {
      expect(resolveMarkdownLinkTarget('javascript&colon;alert(1)')).toMatchObject({
        kind: 'blocked',
        href: '#__nf_blocked__',
      });
      expect(resolveMarkdownLinkTarget('jav&#x61;script:alert(1)')).toMatchObject({
        kind: 'blocked',
        href: '#__nf_blocked__',
      });
      expect(resolveMarkdownLinkTarget('&#106;avascript:alert(1)')).toMatchObject({
        kind: 'blocked',
        href: '#__nf_blocked__',
      });
      expect(resolveMarkdownLinkTarget('vscode&#58;open')).toMatchObject({
        kind: 'blocked',
        href: '#__nf_blocked__',
      });
    });

    it('should handle out-of-range numeric entities without crashing and still block the URL', () => {
      expect(() => resolveMarkdownLinkTarget('&#1114112;javascript:alert(1)')).not.toThrow();
      expect(resolveMarkdownLinkTarget('&#1114112;javascript:alert(1)')).toMatchObject({
        kind: 'blocked',
        href: '#__nf_blocked__',
      });
    });

    it('should allow safe http: URLs', () => {
      const safe = '[link](https://example.com)';
      const result = renderMarkdown(safe);
      
      expect(result).toContain('href="https://example.com"');
    });

    it('should allow safe mailto: URLs', () => {
      const safe = '[email](mailto:test@example.com)';
      const result = renderMarkdown(safe);
      
      expect(result).toContain('href="mailto:test@example.com"');
    });

    it('should allow stable task: links for internal navigation', () => {
      const safe = '[task](task:task-123)';
      const result = renderMarkdown(safe);

      expect(result).toContain('data-link-kind="task"');
      expect(result).toContain('data-task-link-id="task-123"');
      expect(result).toContain('href="#task:task-123"');
    });

    it('should allow relative URLs', () => {
      const safe = '[page](/about)';
      const result = renderMarkdown(safe);
      
      expect(result).toContain('href="/about"');
    });

    it('should convert file: links into local-path sentinel anchors', () => {
      const malicious = '[click](file:///C:/Windows/System32/calc.exe)';
      const container = document.createElement('div');
      container.innerHTML = renderMarkdown(malicious);
      const link = container.querySelector('a');

      expect(container.innerHTML).not.toContain('href="file:///C:/Windows/System32/calc.exe"');
      expect(link?.getAttribute('href')).toBe('#local-path');
      expect(link?.getAttribute('data-link-kind')).toBe('local');
      expect(decodeBackslashEntities(link?.getAttribute('data-local-link-path') ?? null)).toBe('C:\\Windows\\System32\\calc.exe');
    });

    it('should block ambiguous relative URLs that contain backslashes', () => {
      expect(resolveMarkdownLinkTarget('/\\evil.example/path')).toMatchObject({
        kind: 'blocked',
        href: '#__nf_blocked__',
      });
      expect(resolveMarkdownLinkTarget('.\\docs\\guide')).toMatchObject({
        kind: 'blocked',
        href: '#__nf_blocked__',
      });
      expect(resolveMarkdownLinkTarget('..\\logout')).toMatchObject({
        kind: 'blocked',
        href: '#__nf_blocked__',
      });
      expect(resolveMarkdownLinkTarget('docs\\guide')).toMatchObject({
        kind: 'blocked',
        href: '#__nf_blocked__',
      });
    });

    it('should add rel="noopener noreferrer" to external links', () => {
      const link = '[external](https://example.com)';
      const result = renderMarkdown(link);
      
      expect(result).toContain('rel="noopener noreferrer"');
      expect(result).toContain('target="_blank"');
    });

    it('should sanitize control characters in blocked URL logs', () => {
      const warnSpy = vi.spyOn(securityLogger, 'warn').mockImplementation(() => undefined);

      resolveMarkdownLinkTarget('java\nscript:alert(1)');

      const [message] = warnSpy.mock.calls.at(-1) ?? [''];
      expect(String(message)).not.toContain('\n');
      expect(String(message)).not.toContain('\r');

      warnSpy.mockRestore();
    });
  });

  describe('Attribute Injection Prevention', () => {
    it('should escape quotes in URLs', () => {
      const malicious = '[click](https://example.com" onclick="alert(1))';
      const result = renderMarkdown(malicious);
      
      // 引号应该被转义为 &quot;，这样 onclick 不会被解析为属性
      expect(result).toContain('&quot;');
      expect(result).not.toContain('onclick="');  // 原始未转义的引号不应存在
    });

    it('should escape backslashes', () => {
      const malicious = '[click](https://example.com\\"><script>alert(1)</script>)';
      const result = renderMarkdown(malicious);
      
      expect(result).not.toContain('<script>');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty content', () => {
      expect(renderMarkdown('')).toBe('');
      expect(renderMarkdown(null as unknown as string)).toBe('');
      expect(renderMarkdown(undefined as unknown as string)).toBe('');
    });

    it('should handle extremely long content', () => {
      const longContent = 'a'.repeat(100000);
      const result = renderMarkdown(longContent);
      
      expect(result).toContain('a'.repeat(100));
    });

    it('should handle nested markdown syntax', () => {
      const nested = '**bold with [link](https://example.com)**';
      const result = renderMarkdown(nested);
      
      expect(result).toContain('<strong>');
      expect(result).toContain('href="https://example.com"');
    });

    it('should handle unclosed code blocks safely', () => {
      const unclosed = '```javascript\nconst x = 1;\n<script>alert(1)</script>';
      const result = renderMarkdown(unclosed);
      
      // 未闭合的代码块应该被安全处理
      expect(result).not.toMatch(/<script>/i);
    });
  });
});
