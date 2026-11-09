export interface TaskMutationGuardRuntime {
  isExportOnly: () => boolean;
  isHintOnlyStartupReadOnly: () => boolean;
  toastInfo: (title: string, message: string) => void;
}

export interface TaskMutationBlockOptions {
  toast?: boolean;
}

export interface TaskMutationBlockResult {
  errorMessage: string;
}

const EXPORT_ONLY_EDIT_URL = 'https://nanoflow.pages.dev';

function blockExportOnlyTaskMutation(
  actionLabel: string,
  runtime: TaskMutationGuardRuntime,
  options?: TaskMutationBlockOptions,
): TaskMutationBlockResult | null {
  if (!runtime.isExportOnly()) {
    return null;
  }

  if (options?.toast !== false) {
    runtime.toastInfo(
      '导出模式',
      `${actionLabel}暂不可用，旧入口仅允许导出，请前往 ${EXPORT_ONLY_EDIT_URL} 继续编辑`,
    );
  }
  return { errorMessage: '导出模式下禁止本地写入' };
}

function blockHintOnlyTaskMutation(
  actionLabel: string,
  runtime: TaskMutationGuardRuntime,
  options?: TaskMutationBlockOptions,
): TaskMutationBlockResult | null {
  if (!runtime.isHintOnlyStartupReadOnly()) {
    return null;
  }

  if (options?.toast !== false) {
    runtime.toastInfo('会话确认中', `${actionLabel}暂不可用，owner 确认完成前保持只读`);
  }
  return { errorMessage: '会话确认中，owner 确认完成前暂时只读' };
}

export function blockTaskMutation(
  actionLabel: string,
  runtime: TaskMutationGuardRuntime,
  options?: TaskMutationBlockOptions,
): TaskMutationBlockResult | null {
  return blockExportOnlyTaskMutation(actionLabel, runtime, options)
    ?? blockHintOnlyTaskMutation(actionLabel, runtime, options);
}
