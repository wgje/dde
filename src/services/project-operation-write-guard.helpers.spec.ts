import { describe, expect, it, vi } from 'vitest';
import { blockProjectMutation } from './project-operation-write-guard.helpers';

describe('project-operation-write-guard.helpers', () => {
  it('export-only 优先阻止项目写入并返回导出模式错误', () => {
    const toastInfo = vi.fn();

    const result = blockProjectMutation('创建项目', {
      isExportOnly: () => true,
      isHintOnlyStartupReadOnly: () => true,
      toastInfo,
    });

    expect(result).toEqual({ success: false, error: '导出模式下禁止本地写入' });
    expect(toastInfo).toHaveBeenCalledOnce();
    expect(toastInfo).toHaveBeenCalledWith(
      '导出模式',
      '创建项目暂不可用，旧入口仅允许导出，请前往 https://nanoflow.pages.dev 继续编辑',
    );
  });

  it('hint-only 启动占位阻止项目写入并返回只读错误', () => {
    const toastInfo = vi.fn();

    const result = blockProjectMutation('保存项目设置', {
      isExportOnly: () => false,
      isHintOnlyStartupReadOnly: () => true,
      toastInfo,
    });

    expect(result).toEqual({ success: false, error: '会话确认中，owner 确认完成前暂时只读' });
    expect(toastInfo).toHaveBeenCalledWith(
      '会话确认中',
      '保存项目设置暂不可用，owner 确认完成前保持只读',
    );
  });

  it('普通会话允许项目写入', () => {
    const toastInfo = vi.fn();

    const result = blockProjectMutation('重命名项目', {
      isExportOnly: () => false,
      isHintOnlyStartupReadOnly: () => false,
      toastInfo,
    });

    expect(result).toBeNull();
    expect(toastInfo).not.toHaveBeenCalled();
  });
});
