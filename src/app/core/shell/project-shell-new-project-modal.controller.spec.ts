import type { Injector, Type } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import { AppProjectCoordinatorService } from '../services/app-project-coordinator.service';
import { ModalLoaderService } from '../services/modal-loader.service';
import { DynamicModalService } from '../../../services/dynamic-modal.service';
import {
  ProjectShellNewProjectModalController,
} from './project-shell-new-project-modal.controller';

function createContext() {
  const component = class TestNewProjectModal {} as Type<unknown>;
  const modalLoader = {
    loadNewProjectModal: vi.fn().mockResolvedValue(component),
  };
  const dynamicModal = {
    open: vi.fn(),
    close: vi.fn(),
  };
  const projectCoordinator = {
    confirmCreateProject: vi.fn(),
  };
  const injector = {
    get: vi.fn((token: unknown) => {
      if (token === ModalLoaderService) return modalLoader;
      if (token === DynamicModalService) return dynamicModal;
      if (token === AppProjectCoordinatorService) return projectCoordinator;
      throw new Error('unexpected injector token');
    }),
  } as unknown as Injector;
  const toast = { error: vi.fn() };
  const logger = { error: vi.fn() };

  return {
    component,
    dynamicModal,
    injector,
    logger,
    modalLoader,
    projectCoordinator,
    toast,
  };
}

describe('ProjectShellNewProjectModalController', () => {
  it('resolves modal services lazily and wires close and confirm outputs', async () => {
    const context = createContext();
    const controller = new ProjectShellNewProjectModalController({
      injector: context.injector,
      logger: context.logger,
      toast: context.toast,
    });

    expect(context.injector.get).not.toHaveBeenCalled();

    await controller.open();

    expect(context.modalLoader.loadNewProjectModal).toHaveBeenCalledOnce();
    expect(context.dynamicModal.open).toHaveBeenCalledWith(
      context.component,
      expect.objectContaining({ outputs: expect.any(Object) }),
    );

    const config = context.dynamicModal.open.mock.calls[0]?.[1] as {
      outputs: {
        close(): void;
        confirm(data: unknown): void;
      };
    };
    config.outputs.close();
    config.outputs.confirm({ name: 'Roadmap', description: 'Launch plan' });

    expect(context.dynamicModal.close).toHaveBeenCalledTimes(2);
    expect(context.projectCoordinator.confirmCreateProject).toHaveBeenCalledWith(
      'Roadmap',
      'Launch plan',
    );
  });

  it('reports loading failures without rejecting', async () => {
    const context = createContext();
    const error = new Error('chunk failed');
    context.modalLoader.loadNewProjectModal.mockRejectedValue(error);
    const controller = new ProjectShellNewProjectModalController({
      injector: context.injector,
      logger: context.logger,
      toast: context.toast,
    });

    await expect(controller.open()).resolves.toBeUndefined();

    expect(context.dynamicModal.open).not.toHaveBeenCalled();
    expect(context.toast.error).toHaveBeenCalledWith(
      '新建项目组件加载失败',
      '请检查网络连接后重试',
    );
    expect(context.logger.error).toHaveBeenCalledWith(
      'Failed to load new project modal',
      error,
    );
  });
});
