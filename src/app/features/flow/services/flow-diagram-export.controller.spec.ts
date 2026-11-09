import { describe, expect, it, vi, afterEach } from 'vitest';
import * as go from 'gojs';
import { FlowDiagramExportController } from './flow-diagram-export.controller';

describe('FlowDiagramExportController', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function createController() {
    return new FlowDiagramExportController({
      projectName: () => 'Project A',
      toast: { error: vi.fn(), success: vi.fn() },
      logger: { error: vi.fn() },
      sentry: { captureException: vi.fn() },
      downloadBlob: vi.fn(),
    });
  }

  it('没有 diagram 时 PNG 导出返回 null 并提示错误', async () => {
    const controller = createController();

    await expect(controller.exportToPng(null)).resolves.toBeNull();

    expect(controller.options.toast.error).toHaveBeenCalledWith('导出失败', '流程图未加载');
  });

  it('PNG 导出会生成 blob 并使用项目名与日期下载', async () => {
    vi.setSystemTime(new Date('2026-06-09T10:00:00.000Z'));
    const blob = new Blob(['png'], { type: 'image/png' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ blob: vi.fn().mockResolvedValue(blob) }));
    const controller = createController();
    const diagram = {
      makeImageData: vi.fn(() => 'data:image/png;base64,abc'),
    } as unknown as go.Diagram;

    await expect(controller.exportToPng(diagram)).resolves.toBe(blob);

    expect(diagram.makeImageData).toHaveBeenCalledWith({
      scale: 2,
      background: '#F5F2E9',
      type: 'image/png',
      maxSize: expect.any(go.Size),
    });
    expect(controller.options.downloadBlob).toHaveBeenCalledWith(blob, '流程图_Project A_2026-06-09.png');
    vi.useRealTimers();
  });

  it('SVG 生成失败时上报异常并提示错误', async () => {
    const controller = createController();
    const error = new Error('svg failed');
    const diagram = {
      makeSvg: vi.fn(() => {
        throw error;
      }),
    } as unknown as go.Diagram;

    await expect(controller.exportToSvg(diagram)).resolves.toBeNull();

    expect(controller.options.logger.error).toHaveBeenCalledWith('导出 SVG 失败', error);
    expect(controller.options.sentry.captureException).toHaveBeenCalledWith(error, { tags: { operation: 'exportToSvg' } });
    expect(controller.options.toast.error).toHaveBeenCalledWith('导出失败', '生成 SVG 时发生错误');
  });
});
