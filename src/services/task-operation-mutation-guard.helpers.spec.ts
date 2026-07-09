import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { blockTaskMutation } from './task-operation-mutation-guard.helpers';

describe('task-operation-mutation-guard.helpers', () => {
  it('export-only 优先阻止任务写入并返回导出模式错误', () => {
    const toastInfo = vi.fn();

    const result = blockTaskMutation('移动任务', {
      isExportOnly: () => true,
      isHintOnlyStartupReadOnly: () => true,
      toastInfo,
    });

    expect(result).toEqual({
      errorMessage: '导出模式下禁止本地写入',
    });
    expect(toastInfo).toHaveBeenCalledOnce();
    expect(toastInfo).toHaveBeenCalledWith(
      '导出模式',
      '移动任务暂不可用，旧入口仅允许导出，请前往 https://nanoflow.pages.dev 继续编辑',
    );
  });

  it('hint-only 启动占位阻止任务写入并返回只读错误', () => {
    const toastInfo = vi.fn();

    const result = blockTaskMutation('编辑任务', {
      isExportOnly: () => false,
      isHintOnlyStartupReadOnly: () => true,
      toastInfo,
    });

    expect(result).toEqual({
      errorMessage: '会话确认中，owner 确认完成前暂时只读',
    });
    expect(toastInfo).toHaveBeenCalledWith(
      '会话确认中',
      '编辑任务暂不可用，owner 确认完成前保持只读',
    );
  });

  it('toast=false 时阻止写入但不提示', () => {
    const toastInfo = vi.fn();

    const result = blockTaskMutation('移动任务', {
      isExportOnly: () => true,
      isHintOnlyStartupReadOnly: () => false,
      toastInfo,
    }, { toast: false });

    expect(result).toEqual({
      errorMessage: '导出模式下禁止本地写入',
    });
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it('普通会话允许任务写入', () => {
    const toastInfo = vi.fn();

    const result = blockTaskMutation('创建任务', {
      isExportOnly: () => false,
      isHintOnlyStartupReadOnly: () => false,
      toastInfo,
    });

    expect(result).toBeNull();
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it('TaskOperationAdapterService 委托 helper，避免守卫状态机回流到大服务', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/services/task-operation-adapter.service.ts'),
      'utf8',
    );

    expect(source).toContain("from './task-operation-mutation-guard.helpers'");
    expect(source).not.toContain('private blockExportOnlyMutation(');
    expect(source).not.toContain('private blockHintOnlyMutation(');
  });
});
