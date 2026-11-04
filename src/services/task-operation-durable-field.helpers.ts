export interface TaskDurableFieldMutationRuntime {
  blockLocalMutation: (actionLabel: string) => boolean;
  markContentEditing: () => void;
  warn: (message: string, data: Record<string, unknown>) => void;
}

export interface TaskDurableFieldMutationOptions {
  actionLabel: string;
  failureMessage: string;
  failureData: Record<string, unknown>;
  mutate: () => Promise<boolean>;
}

export async function runTaskDurableFieldMutation(
  options: TaskDurableFieldMutationOptions,
  runtime: TaskDurableFieldMutationRuntime,
): Promise<boolean> {
  if (runtime.blockLocalMutation(options.actionLabel)) {
    return false;
  }

  runtime.markContentEditing();
  let saved: boolean;
  try {
    saved = await options.mutate();
  } catch (error) {
    runtime.warn(options.failureMessage, {
      ...options.failureData,
      error,
    });
    return false;
  }
  if (!saved) {
    runtime.warn(options.failureMessage, options.failureData);
  }
  return saved;
}
