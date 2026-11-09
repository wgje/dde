import type { ProviderToken } from '@angular/core';
import type { Task } from '../models';
import type { DockEngineService } from './dock-engine.service';
import type { DEFAULT_FOCUS_PREFERENCES } from '../models/focus';

export interface DockEngineMockFn {
  mockClear(): unknown;
  mock: { calls: unknown[][] };
}

export interface DockEngineReturnValueMockFn extends DockEngineMockFn {
  mockReturnValueOnce(value: unknown): unknown;
}

export interface DockEngineResolvedValueMockFn extends DockEngineMockFn {
  mockResolvedValueOnce(value: unknown): unknown;
}

export interface DockEngineSpecContext {
  service: () => DockEngineService;
  seedTask: (id: string, options?: Partial<Task> & { projectId?: string }) => void;
  taskMap: Map<string, Task>;
  taskProjectMap: Map<string, string>;
  mockActionQueue: {
    enqueueForOwner: DockEngineMockFn;
    enqueueDurablyForOwner: DockEngineMockFn;
  };
  mockBlackBoxService: {
    create: DockEngineReturnValueMockFn;
    createDurably: DockEngineResolvedValueMockFn;
    archive: DockEngineMockFn;
    archiveDurably: DockEngineMockFn;
    markAsCompleted: DockEngineMockFn;
    markAsCompletedDurably: DockEngineMockFn;
  };
  mockTaskOps: {
    updateTaskStatus: DockEngineResolvedValueMockFn;
  };
  mockTaskStore: {
    setTask: DockEngineMockFn & ((task: Task, projectId: string) => unknown);
  };
  mockToast: {
    info: DockEngineMockFn;
    warning: DockEngineMockFn;
  };
  mockFocusAttention: {
    updateBadge: DockEngineMockFn;
    notify: DockEngineMockFn;
  };
  mockFocusHudWindow: {
    isActive: {
      set(value: boolean): unknown;
    };
  };
  mockFocusPreferenceService: {
    update: (updates: Partial<typeof DEFAULT_FOCUS_PREFERENCES>) => unknown;
  };
  testBed: {
    flushEffects(): void;
    inject<T>(token: ProviderToken<T>): T;
  };
}
