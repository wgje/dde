export type ModalLoadFailureDecision =
  | { kind: 'retry'; delayMs: number }
  | { kind: 'stale-chunk' }
  | { kind: 'exhausted' };

export interface ModalLoadFailureInput {
  attempt: number;
  maxRetries: number;
  staleChunk: boolean;
}

export interface ModalLoadFailureToast {
  title: string;
  message: string;
}

export function classifyModalLoadFailure(input: ModalLoadFailureInput): ModalLoadFailureDecision {
  if (input.staleChunk) {
    return { kind: 'stale-chunk' };
  }

  if (input.attempt < input.maxRetries) {
    return { kind: 'retry', delayMs: 1000 * (input.attempt + 1) };
  }

  return { kind: 'exhausted' };
}

export function getModalLoadFailureToast(failures: number): ModalLoadFailureToast {
  return failures >= 3
    ? {
        title: '网络连接不稳定',
        message: '建议稍后重试或检查网络连接',
      }
    : {
        title: '加载失败',
        message: '正在重试，请稍候...',
      };
}
