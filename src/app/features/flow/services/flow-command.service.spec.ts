import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FlowCommandService,
  type CenterNodeCommandClaim,
} from './flow-command.service';
import {
  ProjectStateService,
  type ActiveProjectOwner,
} from '../../../../services/project-state.service';
import { LoggerService } from '../../../../services/logger.service';

describe('FlowCommandService', () => {
  const activeProjectId = signal<string | null>('project-a');
  let generation = 1;
  let service: FlowCommandService;

  const captureOwner = (): ActiveProjectOwner => ({
    projectId: activeProjectId(),
    generation,
  });
  const isOwnerCurrent = (owner: ActiveProjectOwner): boolean => (
    owner.projectId === activeProjectId() && owner.generation === generation
  );
  const switchProject = (projectId: string): void => {
    generation += 1;
    activeProjectId.set(projectId);
  };

  beforeEach(() => {
    activeProjectId.set('project-a');
    generation = 1;
    TestBed.configureTestingModule({
      providers: [
        FlowCommandService,
        {
          provide: ProjectStateService,
          useValue: {
            activeProjectId,
            captureActiveProjectOwner: captureOwner,
            isActiveProjectOwnerCurrent: isOwnerCurrent,
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({ debug: vi.fn() }),
          },
        },
      ],
    });
    service = TestBed.inject(FlowCommandService);
  });

  it('claims without consuming and acknowledges only the exact issued command', () => {
    service.centerOnNode('task-a', true);

    const first = service.claimPendingCenterCommand();
    expect(first).toMatchObject({
      payload: { taskId: 'task-a', openDetail: true },
      owner: { projectId: 'project-a', generation: 1 },
    });
    expect(service.claimPendingCenterCommand()).toBe(first);

    service.centerOnNode('task-b', false);
    const second = service.claimPendingCenterCommand();
    expect(second?.payload.taskId).toBe('task-b');
    expect(service.acknowledgePendingCenterCommand(first!)).toBe(false);
    expect(service.claimPendingCenterCommand()).toBe(second);
    expect(service.acknowledgePendingCenterCommand(second!)).toBe(true);
    expect(service.claimPendingCenterCommand()).toBeNull();
  });

  it('retires an A command across A to B to A owner rebinding', () => {
    service.centerOnNode('stale-a');
    switchProject('project-b');
    switchProject('project-a');

    expect(service.centerNodeCommand()).toBeNull();
    expect(service.claimPendingCenterCommand()).toBeNull();
  });

  it('binds readiness to the exact ActiveProjectOwner generation', () => {
    const ownerA1 = captureOwner();
    service.markViewReady(ownerA1);
    expect(service.isViewReady()).toBe(true);

    switchProject('project-b');
    switchProject('project-a');
    expect(service.isViewReady()).toBe(false);

    service.markViewReady(ownerA1);
    expect(service.isViewReady()).toBe(false);
    service.markViewReady(captureOwner());
    expect(service.isViewReady()).toBe(true);
  });

  it('keeps a same-owner pending command while readiness is retired', () => {
    service.centerOnNode('task-recovery');
    service.markViewReady(captureOwner());

    service.markViewDestroyed();

    expect(service.isViewReady()).toBe(false);
    const claim = service.claimPendingCenterCommand() as CenterNodeCommandClaim;
    expect(claim.payload.taskId).toBe('task-recovery');
  });
});
