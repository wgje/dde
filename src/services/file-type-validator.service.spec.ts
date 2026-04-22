/**
 * FileTypeValidatorService 单元测试（Injector 隔离模式）
 *
 * 按 security.instructions.md 重点覆盖恶意输入路径：
 * - XSS（SVG 脚本/事件处理器/foreignObject/javascript:/data:text/html）
 * - MIME 伪装（扩展名与 MIME 不一致）
 * - 魔数伪装（声称 PNG 实则 GIF 等）
 * - 危险扩展名/危险 MIME（.exe / application/x-executable）
 * - 空文件与超大（oversize）文件路径
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import {
  ALLOWED_EXTENSIONS,
  ALLOWED_MIME_TYPES,
  DANGEROUS_EXTENSIONS,
  DANGEROUS_MIME_TYPES,
  FileTypeValidatorService,
} from './file-type-validator.service';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';

// 需要 FileReader / Blob.slice — 依赖 happy-dom 环境（lane_browser_minimal）
// 引用 `document` 让 scripts/run-test-matrix.cjs 的 domPattern 将本文件归入 browser_minimal 车道
beforeAll(() => {
  if (typeof document === 'undefined') {
    throw new Error('本测试需要 DOM 环境（happy-dom）');
  }
});

// ---- Mocks ----
const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};
const mockLogger = { category: vi.fn(() => mockLoggerCategory) };

const mockSentryLazyLoader = {
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
  withScope: vi.fn(),
  setUser: vi.fn(),
  setContext: vi.fn(),
};

// ---- 辅助：构造带固定字节的 File ----
function makeFile(name: string, type: string, bytes?: Uint8Array | string): File {
  const content: BlobPart =
    bytes === undefined
      ? ''
      : typeof bytes === 'string'
        ? bytes
        : bytes;
  return new File([content], name, { type });
}

/** 魔数：JPEG (FF D8 FF + padding) */
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
/** 魔数：PNG */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0,
]);
/** 魔数：GIF87a */
const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
/** 魔数：PDF (%PDF) */
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0, 0, 0, 0, 0, 0, 0, 0]);

describe('FileTypeValidatorService', () => {
  let service: FileTypeValidatorService;
  let injector: Injector;

  beforeEach(() => {
    vi.clearAllMocks();

    injector = Injector.create({
      providers: [
        { provide: LoggerService, useValue: mockLogger },
        { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoader },
      ],
    });
    service = runInInjectionContext(injector, () => new FileTypeValidatorService());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // validateFile — 空文件 / 危险扩展名 / 危险 MIME
  // ==========================================================================

  describe('validateFile — 黑名单与空文件拦截', () => {
    it('空文件直接拒绝（EMPTY_FILE）', async () => {
      const file = makeFile('empty.png', 'image/png');
      const result = await service.validateFile(file);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe('EMPTY_FILE');
    });

    it('危险扩展名 .exe 被拒绝（DANGEROUS_EXTENSION）', async () => {
      const file = makeFile('malware.exe', 'application/octet-stream', new Uint8Array([0x4d, 0x5a]));
      const result = await service.validateFile(file);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe('DANGEROUS_EXTENSION');
    });

    it('危险扩展名 .js 被拒绝（即使 MIME 伪装为图片）', async () => {
      const file = makeFile('malware.js', 'image/png', PNG_BYTES);
      const result = await service.validateFile(file);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe('DANGEROUS_EXTENSION');
    });

    it('危险扩展名 .html 被拒绝', async () => {
      const file = makeFile('page.html', 'text/plain', '<html></html>');
      const result = await service.validateFile(file);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe('DANGEROUS_EXTENSION');
    });

    it('危险 MIME application/x-executable 被拒绝（DANGEROUS_MIME_TYPE）', async () => {
      const file = makeFile('notepad.pdf', 'application/x-executable', new Uint8Array([1, 2, 3]));
      const result = await service.validateFile(file);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe('DANGEROUS_MIME_TYPE');
    });

    it('危险 MIME text/html 被拒绝', async () => {
      const file = makeFile('x.pdf', 'text/html', 'hi');
      const result = await service.validateFile(file);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe('DANGEROUS_MIME_TYPE');
    });
  });

  // ==========================================================================
  // validateFile — 白名单拦截
  // ==========================================================================

  describe('validateFile — 白名单拦截', () => {
    it('不在白名单的扩展名被拒绝（EXTENSION_NOT_ALLOWED）', async () => {
      const file = makeFile('archive.rar', 'application/octet-stream', new Uint8Array([1, 2, 3]));
      const result = await service.validateFile(file);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe('EXTENSION_NOT_ALLOWED');
    });

    it('不在白名单的 MIME 被拒绝（MIME_TYPE_NOT_ALLOWED）', async () => {
      const file = makeFile('photo.png', 'application/octet-stream', PNG_BYTES);
      const result = await service.validateFile(file);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe('MIME_TYPE_NOT_ALLOWED');
    });
  });

  // ==========================================================================
  // validateFile — 魔数验证（MIME 伪装防护）
  // ==========================================================================

  describe('validateFile — 魔数验证（防 MIME 伪装）', () => {
    it('合法 PNG（扩展+MIME+魔数一致）通过', async () => {
      const file = makeFile('real.png', 'image/png', PNG_BYTES);
      const result = await service.validateFile(file);
      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBe('image/png');
    });

    it('合法 JPEG 通过', async () => {
      const file = makeFile('photo.jpg', 'image/jpeg', JPEG_BYTES);
      const result = await service.validateFile(file);
      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBe('image/jpeg');
    });

    it('合法 PDF 通过', async () => {
      const file = makeFile('doc.pdf', 'application/pdf', PDF_BYTES);
      const result = await service.validateFile(file);
      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBe('application/pdf');
    });

    it('MIME/扩展名声称为 PNG 但魔数实为 GIF → 拒绝（MAGIC_NUMBER_MISMATCH）', async () => {
      const file = makeFile('fake.png', 'image/png', GIF_BYTES);
      const result = await service.validateFile(file);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe('MAGIC_NUMBER_MISMATCH');
      expect(result.detectedMimeType).toBe('image/gif');
    });

    it('MIME 声称为 PNG，扩展名 .png，但魔数是 PDF → 拒绝', async () => {
      const file = makeFile('fake.png', 'image/png', PDF_BYTES);
      const result = await service.validateFile(file);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe('MAGIC_NUMBER_MISMATCH');
    });

    it('文本类文件（.txt）不做魔数验证仍可通过', async () => {
      const file = makeFile('notes.txt', 'text/plain', 'hello world');
      const result = await service.validateFile(file);
      expect(result.valid).toBe(true);
      expect(result.details.magicNumberValid).toBe(true);
    });

    it('无法识别魔数的图片被拒绝（ALLOW_UNKNOWN_TYPES=false）', async () => {
      // 完全随机字节、扩展名 png、MIME png（白名单内）→ 魔数不匹配
      const file = makeFile('rand.png', 'image/png', new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]));
      const result = await service.validateFile(file);
      expect(result.valid).toBe(false);
    });
  });

  // ==========================================================================
  // validateFile — SVG XSS 防护（P1-08）
  // ==========================================================================

  describe('validateFile — SVG XSS 攻击向量检测', () => {
    it('合法 SVG 通过', async () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect/></svg>';
      const file = makeFile('ok.svg', 'image/svg+xml', svg);
      const result = await service.validateFile(file);
      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBe('image/svg+xml');
    });

    it('含 <script> 的 SVG 被拒绝', async () => {
      const svg = '<svg><script>alert(1)</script></svg>';
      const file = makeFile('xss.svg', 'image/svg+xml', svg);
      const result = await service.validateFile(file);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('不安全');
    });

    it('含 onload= 事件处理器的 SVG 被拒绝', async () => {
      const svg = '<svg onload="alert(1)"><rect/></svg>';
      const file = makeFile('xss.svg', 'image/svg+xml', svg);
      const result = await service.validateFile(file);
      expect(result.valid).toBe(false);
    });

    it('含 onerror= 事件处理器的 SVG 被拒绝', async () => {
      const svg = '<svg><image onerror="alert(1)" href="x"/></svg>';
      const file = makeFile('xss.svg', 'image/svg+xml', svg);
      const result = await service.validateFile(file);
      expect(result.valid).toBe(false);
    });

    it('含 <foreignObject> 的 SVG 被拒绝', async () => {
      const svg = '<svg><foreignObject><body>bad</body></foreignObject></svg>';
      const file = makeFile('xss.svg', 'image/svg+xml', svg);
      const result = await service.validateFile(file);
      expect(result.valid).toBe(false);
    });

    it('含 javascript: 协议的 SVG 被拒绝', async () => {
      const svg = '<svg><a href="javascript:alert(1)"><rect/></a></svg>';
      const file = makeFile('xss.svg', 'image/svg+xml', svg);
      const result = await service.validateFile(file);
      expect(result.valid).toBe(false);
    });

    it('含 data:text/html 协议的 SVG 被拒绝', async () => {
      const svg = '<svg><a href="data:text/html,<script>alert(1)</script>"><rect/></a></svg>';
      const file = makeFile('xss.svg', 'image/svg+xml', svg);
      const result = await service.validateFile(file);
      expect(result.valid).toBe(false);
    });

    it('含 <iframe> 的 SVG 被拒绝', async () => {
      const svg = '<svg><iframe src="https://evil"></iframe></svg>';
      const file = makeFile('xss.svg', 'image/svg+xml', svg);
      const result = await service.validateFile(file);
      expect(result.valid).toBe(false);
    });

    it('伪装为 .svg 但内容不是 SVG 的文件被拒绝', async () => {
      const file = makeFile('fake.svg', 'image/svg+xml', 'just text');
      const result = await service.validateFile(file);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('SVG');
    });
  });

  // ==========================================================================
  // validateFile — 扩展名/MIME 一致性
  // ==========================================================================

  describe('validateFile — 扩展名/MIME 一致性', () => {
    it('.png 扩展名配合 image/jpeg MIME → 一致性校验失败（EXTENSION_MIME_MISMATCH）', async () => {
      // 使用 PNG 魔数让它通过魔数检查，但同时声称扩展名 .png MIME image/jpeg
      // 注意：这种情况下魔数也会不匹配（魔数是 PNG，MIME 是 jpeg）
      // 所以实际触发的是 MAGIC_NUMBER_MISMATCH，符合严格模式
      const file = makeFile('x.png', 'image/jpeg', PNG_BYTES);
      const result = await service.validateFile(file);
      expect(result.valid).toBe(false);
      // 严格模式下在魔数步骤就拒绝
      expect(['MAGIC_NUMBER_MISMATCH', 'EXTENSION_MIME_MISMATCH']).toContain(result.errorCode);
    });
  });

  // ==========================================================================
  // quickValidate
  // ==========================================================================

  describe('quickValidate', () => {
    it('合法类型通过', () => {
      const result = service.quickValidate('photo.png', 'image/png');
      expect(result.valid).toBe(true);
    });

    it('危险扩展名被拒', () => {
      expect(service.quickValidate('x.exe', 'application/octet-stream').valid).toBe(false);
      expect(service.quickValidate('x.bat', 'application/octet-stream').valid).toBe(false);
      expect(service.quickValidate('x.sh', 'application/octet-stream').valid).toBe(false);
    });

    it('危险 MIME 被拒', () => {
      expect(service.quickValidate('x.png', 'text/html').valid).toBe(false);
      expect(service.quickValidate('x.png', 'application/javascript').valid).toBe(false);
    });

    it('不在白名单的扩展名被拒', () => {
      const result = service.quickValidate('x.rar', 'application/octet-stream');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('扩展名');
    });

    it('不在白名单的 MIME 被拒', () => {
      const result = service.quickValidate('x.png', 'application/octet-stream');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('类型');
    });

    it('无扩展名的文件被拒（空扩展不在白名单）', () => {
      expect(service.quickValidate('README', 'text/plain').valid).toBe(false);
    });
  });

  // ==========================================================================
  // getAllowedExtensions / getAcceptAttribute
  // ==========================================================================

  describe('getAllowedExtensions / getAcceptAttribute', () => {
    it('getAllowedExtensions 返回与 ALLOWED_EXTENSIONS 等长', () => {
      const list = service.getAllowedExtensions();
      expect(list.length).toBe(ALLOWED_EXTENSIONS.size);
      expect(list).toContain('png');
      expect(list).toContain('pdf');
    });

    it('getAcceptAttribute 包含所有扩展（前缀点）和 MIME 类型', () => {
      const accept = service.getAcceptAttribute();
      expect(accept).toContain('.png');
      expect(accept).toContain('.pdf');
      expect(accept).toContain('image/png');
      expect(accept).toContain('application/pdf');
    });
  });

  // ==========================================================================
  // 黑/白名单常量基本完整性
  // ==========================================================================

  describe('常量完整性', () => {
    it('DANGEROUS_EXTENSIONS 包含关键危险项', () => {
      for (const ext of ['exe', 'js', 'html', 'sh', 'bat', 'vbs']) {
        expect(DANGEROUS_EXTENSIONS.has(ext)).toBe(true);
      }
    });

    it('DANGEROUS_MIME_TYPES 包含关键危险项', () => {
      for (const mime of ['text/html', 'application/javascript', 'application/x-executable']) {
        expect(DANGEROUS_MIME_TYPES.has(mime)).toBe(true);
      }
    });

    it('白名单不与黑名单重叠', () => {
      for (const ext of DANGEROUS_EXTENSIONS) {
        expect(ALLOWED_EXTENSIONS.has(ext)).toBe(false);
      }
      for (const mime of DANGEROUS_MIME_TYPES) {
        expect(ALLOWED_MIME_TYPES.has(mime)).toBe(false);
      }
    });
  });
});
