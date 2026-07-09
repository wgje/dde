export type ProjectMutationBlockResult = { success: false; error: string };

export interface ProjectMutationGuardRuntime {
  isExportOnly: () => boolean;
  isHintOnlyStartupReadOnly: () => boolean;
  toastInfo: (title: string, message: string) => void;
}

const EXPORT_ONLY_EDIT_URL = 'https://nanoflow.pages.dev';

function blockExportOnlyProjectMutation(
  actionLabel: string,
  runtime: ProjectMutationGuardRuntime,
): ProjectMutationBlockResult | null {
  if (!runtime.isExportOnly()) {
    return null;
  }

  runtime.toastInfo(
    '导出模式',
    `${actionLabel}暂不可用，旧入口仅允许导出，请前往 ${EXPORT_ONLY_EDIT_URL} 继续编辑`,
  );
  return { success: false, error: '导出模式下禁止本地写入' };
}

function blockHintOnlyProjectMutation(
  actionLabel: string,
  runtime: ProjectMutationGuardRuntime,
): ProjectMutationBlockResult | null {
  if (!runtime.isHintOnlyStartupReadOnly()) {
    return null;
  }

  runtime.toastInfo('会话确认中', `${actionLabel}暂不可用，owner 确认完成前保持只读`);
  return { success: false, error: '会话确认中，owner 确认完成前暂时只读' };
}

export function blockProjectMutation(
  actionLabel: string,
  runtime: ProjectMutationGuardRuntime,
): ProjectMutationBlockResult | null {
  return blockExportOnlyProjectMutation(actionLabel, runtime)
    ?? blockHintOnlyProjectMutation(actionLabel, runtime);
}
