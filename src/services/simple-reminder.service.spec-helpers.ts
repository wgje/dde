import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { ProjectStore, TaskStore } from '../app/core/state/stores';
import type { Task } from '../models';
import { LoggerService } from './logger.service';
import { ParkingService } from './parking.service';
import { SessionRuntimeResetRegistry } from './session-runtime-reset.service';
import { SimpleReminderService } from './simple-reminder.service';
import { TaskOperationAdapterService } from './task-operation-adapter.service';

type SpecMock = ReturnType<typeof vi.fn>;

export interface SimpleReminderSpecHarness {
  service: SimpleReminderService;
  mockTaskStore: {
    parkedTasks: WritableSignal<Task[]>;
    getTask: SpecMock;
    setTask: SpecMock;
    parkedTaskIds: WritableSignal<Set<string>>;
    getTaskProjectId: SpecMock;
  };
  mockProjectStore: {
    projects: WritableSignal<unknown[]>;
    activeProjectId: WritableSignal<string>;
  };
  mockParkingService: {
    showNotice: SpecMock;
    recordReminderFadeout: SpecMock;
    clearBadge: SpecMock;
    parkTask: SpecMock;
  };
  mockTaskOpsAdapter: {
    updateTaskParkingMeta: SpecMock;
  };
  mockLogger: {
    info: SpecMock;
    warn: SpecMock;
    error: SpecMock;
    debug: SpecMock;
  };
  sessionRuntimeReset: SessionRuntimeResetRegistry;
}

export function createSimpleReminderSpecTask(overrides: Partial<Task> = {}): Task {
  return {
    id: crypto.randomUUID(),
    title: '测试任务',
    content: '',
    stage: 0,
    parentId: null,
    order: 0,
    rank: 10000,
    status: 'active',
    x: 0,
    y: 0,
    displayId: 'T-1',
    createdDate: new Date().toISOString(),
    deletedAt: null,
    parkingMeta: null,
    ...overrides,
  };
}

export function setupSimpleReminderSpecHarness(): SimpleReminderSpecHarness {
  const mockTaskStore: SimpleReminderSpecHarness['mockTaskStore'] = {
    parkedTasks: signal<Task[]>([]),
    getTask: vi.fn(),
    setTask: vi.fn(),
    parkedTaskIds: signal(new Set<string>()),
    getTaskProjectId: vi.fn(() => 'proj-1'),
  };

  const mockProjectStore: SimpleReminderSpecHarness['mockProjectStore'] = {
    projects: signal([]),
    activeProjectId: signal('proj-1'),
  };

  const mockParkingService: SimpleReminderSpecHarness['mockParkingService'] = {
    showNotice: vi.fn(),
    recordReminderFadeout: vi.fn(),
    clearBadge: vi.fn(),
    parkTask: vi.fn().mockResolvedValue(true),
  };

  const mockTaskOpsAdapter: SimpleReminderSpecHarness['mockTaskOpsAdapter'] = {
    updateTaskParkingMeta: vi.fn().mockResolvedValue(true),
  };

  const mockLogger: SimpleReminderSpecHarness['mockLogger'] = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  TestBed.configureTestingModule({
    providers: [
      SimpleReminderService,
      SessionRuntimeResetRegistry,
      { provide: TaskStore, useValue: mockTaskStore },
      { provide: ProjectStore, useValue: mockProjectStore },
      { provide: ParkingService, useValue: mockParkingService },
      { provide: TaskOperationAdapterService, useValue: mockTaskOpsAdapter },
      { provide: LoggerService, useValue: mockLogger },
    ],
  });

  return {
    service: TestBed.inject(SimpleReminderService),
    mockTaskStore,
    mockProjectStore,
    mockParkingService,
    mockTaskOpsAdapter,
    mockLogger,
    sessionRuntimeReset: TestBed.inject(SessionRuntimeResetRegistry),
  };
}

export function getSimpleReminderCheckInterval(service: SimpleReminderService): unknown {
  return (service as unknown as { checkInterval: unknown }).checkInterval;
}

export function checkSimpleReminderNow(service: SimpleReminderService): void {
  (service as unknown as { checkReminders: () => void }).checkReminders();
}

export async function flushSimpleReminderEffects(): Promise<void> {
  await Promise.resolve();
  TestBed.flushEffects();
  await Promise.resolve();
}

export function cleanupSimpleReminderSpecHarness(service: SimpleReminderService): void {
  vi.useRealTimers();
  service.ngOnDestroy();
  TestBed.resetTestingModule();
}
