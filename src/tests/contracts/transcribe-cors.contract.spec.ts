/**
 * Transcribe CORS 域名允许/拒绝测试
 *
 * 验证 Edge Function 的 CORS 白名单只接受受控域名，
 * 拒绝任意 .vercel.app 子域名。
 *
 * 注意：这是纯逻辑测试，复刻了 getCorsHeaders 的判断逻辑，
 * 因为 Deno Edge Function 无法直接在 Node/Vitest 中导入。
 *
 * @see supabase/functions/transcribe/index.ts
 */
import { describe, it, expect } from 'vitest';

// 复刻 Edge Function 中的 CORS 逻辑以进行验证
const ALLOWED_ORIGINS = [
  'https://dde-eight.vercel.app',
  'https://nanoflow.app',
  'http://localhost:4200',
  'http://localhost:5173',
];

const VERCEL_PREVIEW_PREFIX = 'dde-';

function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return false;
  return ALLOWED_ORIGINS.includes(origin) ||
    (origin.endsWith('.vercel.app') && origin.includes(`://${VERCEL_PREVIEW_PREFIX}`));
}

describe('Transcribe CORS 域名策略 (CORS Allow/Deny)', () => {
  describe('应允许的域名', () => {
    it('应允许生产域名 dde-eight.vercel.app', () => {
      expect(isOriginAllowed('https://dde-eight.vercel.app')).toBe(true);
    });

    it('应允许自定义域名 nanoflow.app', () => {
      expect(isOriginAllowed('https://nanoflow.app')).toBe(true);
    });

    it('应允许开发环境 localhost:4200', () => {
      expect(isOriginAllowed('http://localhost:4200')).toBe(true);
    });

    it('应允许 Vite 开发服务器 localhost:5173', () => {
      expect(isOriginAllowed('http://localhost:5173')).toBe(true);
    });

    it('应允许项目级前缀的 Vercel 预览域名', () => {
      expect(isOriginAllowed('https://dde-abc123.vercel.app')).toBe(true);
      expect(isOriginAllowed('https://dde-preview-42.vercel.app')).toBe(true);
    });
  });

  describe('应拒绝的域名', () => {
    it('应拒绝任意非项目前缀的 .vercel.app 子域', () => {
      expect(isOriginAllowed('https://evil-site.vercel.app')).toBe(false);
      expect(isOriginAllowed('https://malicious.vercel.app')).toBe(false);
      expect(isOriginAllowed('https://random-project.vercel.app')).toBe(false);
    });

    it('应拒绝 null origin', () => {
      expect(isOriginAllowed(null)).toBe(false);
    });

    it('应拒绝完全不相关的域名', () => {
      expect(isOriginAllowed('https://attacker.com')).toBe(false);
      expect(isOriginAllowed('https://example.com')).toBe(false);
    });

    it('应拒绝只包含前缀但不以 .vercel.app 结尾的域名', () => {
      expect(isOriginAllowed('https://dde-fake.notvercel.app')).toBe(false);
    });
  });
});
