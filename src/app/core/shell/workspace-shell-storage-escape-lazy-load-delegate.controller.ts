import { WorkspaceShellLazyDelegateCallHostController } from './workspace-shell-lazy-delegate-call-host.controller';
import {
  createWorkspaceShellStorageEscapeControllerLoader,
} from './workspace-shell-storage-escape-controller-loader.factory';
import type {
  WorkspaceShellStorageEscapeLazyLoadDelegate,
  WorkspaceShellStorageEscapeLazyLoadDelegateOptions,
} from './workspace-shell-storage-escape-lazy-load-delegate.factory';

const STORAGE_ESCAPE_SETUP_FAILURE_MESSAGE =
  'Storage escape controller 懒加载失败，已跳过本次注册';
const STORAGE_ESCAPE_CONTROLLER_SETUP_FAILURE_MESSAGE =
  'Storage escape controller 注册失败，已跳过本次注册';
const STORAGE_ESCAPE_TEARDOWN_FAILURE_MESSAGE =
  'Storage escape controller 清理失败，已跳过';

export class WorkspaceShellStorageEscapeLazyLoadDelegateController
implements WorkspaceShellStorageEscapeLazyLoadDelegate {
  private readonly host: WorkspaceShellLazyDelegateCallHostController<
    WorkspaceShellStorageEscapeLazyLoadDelegate
  >;
  private readonly loadStorageEscapeController:
    () => Promise<WorkspaceShellStorageEscapeLazyLoadDelegate>;

  constructor(
    private readonly options: WorkspaceShellStorageEscapeLazyLoadDelegateOptions,
  ) {
    this.loadStorageEscapeController =
      createWorkspaceShellStorageEscapeControllerLoader({
        createStorageEscapeController: options.createStorageEscapeController,
        options,
      });
    this.host = new WorkspaceShellLazyDelegateCallHostController({
      createDelegate: () => this.loadStorageEscapeController(),
      loadFailureMessage: STORAGE_ESCAPE_SETUP_FAILURE_MESSAGE,
      teardownFailureMessage: STORAGE_ESCAPE_TEARDOWN_FAILURE_MESSAGE,
      warn: options.warn,
    });
  }

  setup(): void {
    this.host.run(
      controller => controller.setup(),
      STORAGE_ESCAPE_CONTROLLER_SETUP_FAILURE_MESSAGE,
      STORAGE_ESCAPE_SETUP_FAILURE_MESSAGE,
    );
  }

  close(): void {
    this.options.closeStorageEscapeModal();
  }

  teardown(): void {
    this.host.teardown();
  }
}
