import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FlowLinkRelinkService } from './flow-link-relink.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';

describe('FlowLinkRelinkService', () => {
  let service: FlowLinkRelinkService;

  const mockProjectState = {
    tasks: signal([]),
    activeProject: vi.fn(() => ({ connections: [] })),
    getTask: vi.fn((taskId: string) => {
      if (taskId === 'old-source' || taskId === 'new-source') {
        return { id: taskId, title: '源任务', stage: 1, parentId: null };
      }
      if (taskId === 'old-target' || taskId === 'new-target') {
        return { id: taskId, title: '目标任务', stage: 2, parentId: null };
      }
      return null;
    }),
  };

  const mockTaskOps = {
    isHintOnlyStartupReadOnly: vi.fn(() => false),
    connectionAdapter: {
      relinkCrossTreeConnection: vi.fn(),
    },
    getDirectChildren: vi.fn(() => []),
    replaceChildSubtreeWithUnassigned: vi.fn(() => ({ ok: true })),
    assignUnassignedToTask: vi.fn(() => ({ ok: true })),
    moveSubtreeToNewParent: vi.fn(() => ({ ok: true })),
    detachTaskWithSubtree: vi.fn(() => ({ ok: true })),
    moveTaskToStage: vi.fn(() => ({ ok: true })),
  };

  const mockToast = {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockTaskOps.isHintOnlyStartupReadOnly.mockReturnValue(false);

    TestBed.configureTestingModule({
      providers: [
        FlowLinkRelinkService,
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: TaskOperationAdapterService, useValue: mockTaskOps },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
        { provide: ToastService, useValue: mockToast },
      ],
    });

    service = TestBed.inject(FlowLinkRelinkService);
  });

  it('hint-only 时跨树重连不应显示成功提示', () => {
    mockTaskOps.isHintOnlyStartupReadOnly.mockReturnValue(true);

    const result = service.handleCrossTreeRelink('old-source', 'old-target', 'new-source', 'new-target', 'to');

    expect(result).toBe('cancelled');
    expect(mockTaskOps.connectionAdapter.relinkCrossTreeConnection).not.toHaveBeenCalled();
    expect(mockToast.info).toHaveBeenCalledWith('会话确认中', '重连关联暂不可用，owner 确认完成前保持只读');
    expect(mockToast.success).not.toHaveBeenCalled();
  });
});