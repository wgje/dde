import type {
  ModalCallbacks,
  WorkspaceModalCoordinatorService,
} from '../../../services/workspace-modal-coordinator.service';

type MaybePromise<T> = T | Promise<T>;
type WarnFn = (message: string, error: unknown) => void;

export interface WorkspaceShellModalCoordinatorLike {
  initCallbacks(callbacks: ModalCallbacks): void;
  isModalLoading(type: string): boolean;
}

export interface WorkspaceShellModalCoordinatorLazyLoadControllerOptions<
  TModalCoord extends WorkspaceShellModalCoordinatorLike,
> {
  createCallbacks: () => MaybePromise<ModalCallbacks>;
  destroyed: () => boolean;
  fallbackModalCoord: TModalCoord;
  loadModalCoord: () => Promise<TModalCoord>;
  warn?: WarnFn;
}

export class WorkspaceShellModalCoordinatorLazyLoadController<
  TModalCoord extends WorkspaceShellModalCoordinatorLike = WorkspaceModalCoordinatorService,
> {
  private modalCoordPromise: Promise<TModalCoord | null> | null = null;
  private modalCoordRef: TModalCoord | null = null;

  constructor(
    private readonly options: WorkspaceShellModalCoordinatorLazyLoadControllerOptions<TModalCoord>,
  ) {}

  get(): Promise<TModalCoord | null> {
    if (this.modalCoordRef) {
      return Promise.resolve(this.modalCoordRef);
    }
    if (this.options.destroyed()) {
      return Promise.resolve(null);
    }

    if (this.modalCoordPromise) {
      return this.modalCoordPromise;
    }

    const modalCoordPromise = this.resolveModalCoord()
      .then(async modalCoord => {
        if (!this.options.destroyed()) {
          const callbacks = await this.options.createCallbacks();
          if (this.options.destroyed()) {
            return null;
          }

          modalCoord.initCallbacks(callbacks);
        }
        if (!this.options.destroyed()) {
          this.modalCoordRef = modalCoord;
          return modalCoord;
        }
        return null;
      })
      .catch(error => {
        this.warn(
          'Workspace shell modal coordinator 懒加载失败，已跳过本次模态入口',
          error,
        );
        return null;
      })
      .finally(() => {
        if (this.modalCoordPromise === modalCoordPromise) {
          this.modalCoordPromise = null;
        }
      });

    this.modalCoordPromise = modalCoordPromise;
    return modalCoordPromise;
  }

  isModalLoading(type: string): boolean {
    return (this.modalCoordRef ?? this.options.fallbackModalCoord).isModalLoading(type);
  }

  private resolveModalCoord(): Promise<TModalCoord> {
    try {
      return Promise.resolve(this.options.loadModalCoord());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private warn(message: string, error: unknown): void {
    try {
      this.options.warn?.(message, error);
    } catch {
      // Warning sinks must not break modal lazy-load fallback paths.
    }
  }
}
