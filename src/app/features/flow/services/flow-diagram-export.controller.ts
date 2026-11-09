import * as go from 'gojs';

export interface FlowDiagramExportControllerOptions {
  projectName: () => string;
  toast: {
    error: (title: string, message?: string) => void;
    success: (title: string, message?: string) => void;
  };
  logger: {
    error: (message: string, error?: unknown) => void;
  };
  sentry: {
    captureException: (error: unknown, context?: Record<string, unknown>) => void;
  };
  downloadBlob: (blob: Blob, filename: string) => void;
}

export class FlowDiagramExportController {
  constructor(readonly options: FlowDiagramExportControllerOptions) {}

  async exportToPng(diagram: go.Diagram | null): Promise<Blob | null> {
    if (!diagram) {
      this.options.toast.error('导出失败', '流程图未加载');
      return null;
    }

    try {
      const imgData = diagram.makeImageData({
        scale: 2,
        background: '#F5F2E9',
        type: 'image/png',
        maxSize: new go.Size(4096, 4096),
      }) as string;

      if (!imgData) {
        this.options.toast.error('导出失败', '无法生成图片');
        return null;
      }

      const response = await fetch(imgData);
      const blob = await response.blob();

      this.options.downloadBlob(blob, `流程图_${this.getExportFileName()}.png`);
      this.options.toast.success('导出成功', 'PNG 图片已下载');

      return blob;
    } catch (error) {
      this.options.logger.error('导出 PNG 失败', error);
      this.options.sentry.captureException(error, { tags: { operation: 'exportToPng' } });
      this.options.toast.error('导出失败', '生成图片时发生错误');
      // eslint-disable-next-line no-restricted-syntax -- 返回 null 语义正确：导出失败已通过 toast 通知用户
      return null;
    }
  }

  async exportToSvg(diagram: go.Diagram | null): Promise<Blob | null> {
    if (!diagram) {
      this.options.toast.error('导出失败', '流程图未加载');
      return null;
    }

    try {
      const svg = diagram.makeSvg({
        scale: 1,
        background: '#F5F2E9',
        maxSize: new go.Size(4096, 4096),
      });

      if (!svg) {
        this.options.toast.error('导出失败', '无法生成 SVG');
        return null;
      }

      const serializer = new XMLSerializer();
      const svgString = serializer.serializeToString(svg);
      const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });

      this.options.downloadBlob(blob, `流程图_${this.getExportFileName()}.svg`);
      this.options.toast.success('导出成功', 'SVG 图片已下载');

      return blob;
    } catch (error) {
      this.options.logger.error('导出 SVG 失败', error);
      this.options.sentry.captureException(error, { tags: { operation: 'exportToSvg' } });
      this.options.toast.error('导出失败', '生成 SVG 时发生错误');
      // eslint-disable-next-line no-restricted-syntax -- 返回 null 语义正确：导出失败已通过 toast 通知用户
      return null;
    }
  }

  private getExportFileName(): string {
    const projectName = this.options.projectName() || '未命名项目';
    const date = new Date().toISOString().slice(0, 10);
    return `${projectName}_${date}`;
  }
}
