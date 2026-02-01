/**
 * Markdown 渲染器安全测试
 * 验证 XSS 防护和 URL 清洗功能
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderMarkdown } from './markdown';

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
      expect(result).toContain('#blocked');
    });

    it('should block vbscript: protocol', () => {
      const malicious = '[click me](vbscript:msgbox(1))';
      const result = renderMarkdown(malicious);
      
      expect(result).not.toContain('vbscript:');
      expect(result).toContain('#blocked');
    });

    it('should block data: protocol with HTML', () => {
      const malicious = '[click](data:text/html,<script>alert(1)</script>)';
      const result = renderMarkdown(malicious);
      
      expect(result).not.toContain('data:text/html');
      expect(result).toContain('#blocked');
    });

    it('should block encoded javascript protocol', () => {
      // java&#x73;cript: encoded as javascript:
      const malicious = '[click](java&#x73;cript:alert(1))';
      const result = renderMarkdown(malicious);
      
      // 应该被阻止或转义
      expect(result).not.toMatch(/href="java.*script:/i);
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

    it('should allow relative URLs', () => {
      const safe = '[page](/about)';
      const result = renderMarkdown(safe);
      
      expect(result).toContain('href="/about"');
    });

    it('should add rel="noopener noreferrer" to external links', () => {
      const link = '[external](https://example.com)';
      const result = renderMarkdown(link);
      
      expect(result).toContain('rel="noopener noreferrer"');
      expect(result).toContain('target="_blank"');
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
