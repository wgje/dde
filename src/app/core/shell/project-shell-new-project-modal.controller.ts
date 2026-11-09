import type { Injector } from '@angular/core';

import { DynamicModalService } from '../../../services/dynamic-modal.service';
import { AppProjectCoordinatorService } from '../services/app-project-coordinator.service';
import { ModalLoaderService } from '../services/modal-loader.service';

export interface ProjectShellNewProjectModalControllerOptions {
  injector: Injector;
  logger: {
    error(message: string, error: unknown): void;
  };
  toast: {
    error(title: string, message: string): void;
  };
}

export class ProjectShellNewProjectModalController {
  constructor(
    private readonly options: ProjectShellNewProjectModalControllerOptions,
  ) {}

  async open(): Promise<void> {
    try {
      const component = await this.options.injector
        .get(ModalLoaderService)
        .loadNewProjectModal();
      const dynamicModal = this.options.injector.get(DynamicModalService);
      dynamicModal.open(component, {
        outputs: {
          close: () => dynamicModal.close(),
          confirm: (data: unknown) => {
            const { name, description } = data as {
              name: string;
              description: string;
            };
            dynamicModal.close();
            void this.options.injector
              .get(AppProjectCoordinatorService)
              .confirmCreateProject(name, description);
          },
        },
      });
    } catch (error) {
      this.options.toast.error(
        '新建项目组件加载失败',
        '请检查网络连接后重试',
      );
      this.options.logger.error('Failed to load new project modal', error);
    }
  }
}
