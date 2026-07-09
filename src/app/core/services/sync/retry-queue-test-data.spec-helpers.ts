import type { Connection, Project, Task } from '../../../../models';
import type { BlackBoxEntry } from '../../../../models/focus';

const uuidCache = new Map<string, string>();

export function resetRetryQueueSpecUuidCache(): void {
  uuidCache.clear();
}

/** 生成稳定的 UUID 供测试去重使用，同一 label 返回同一 UUID */
export function stableUUID(label: string): string {
  if (!uuidCache.has(label)) {
    uuidCache.set(label, crypto.randomUUID());
  }
  return uuidCache.get(label)!;
}

export function createTask(label: string): Task {
  const id = stableUUID(label);
  const now = new Date().toISOString();
  return {
    id,
    title: `Task ${label}`,
    content: '',
    stage: null,
    parentId: null,
    order: 0,
    rank: 0,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: now,
    displayId: label,
    updatedAt: now,
  };
}

export function createProject(label: string): Project {
  const id = stableUUID(`project-${label}`);
  const now = new Date().toISOString();
  return {
    id,
    name: `Project ${label}`,
    description: '',
    createdDate: now,
    updatedAt: now,
    tasks: [],
    connections: [],
  };
}

export function createConnection(label: string, sourceLabel = `${label}-source`, targetLabel = `${label}-target`): Connection {
  return {
    id: stableUUID(`connection-${label}`),
    source: stableUUID(sourceLabel),
    target: stableUUID(targetLabel),
  };
}

export function createBlackBoxEntry(label: string, overrides: Partial<BlackBoxEntry> = {}): BlackBoxEntry {
  const now = new Date().toISOString();
  return {
    id: stableUUID(`blackbox-${label}`),
    projectId: null,
    userId: 'test-user',
    content: `BlackBox ${label}`,
    date: '2026-04-21',
    createdAt: now,
    updatedAt: now,
    isRead: false,
    isCompleted: false,
    isArchived: false,
    deletedAt: null,
    snoozeCount: 0,
    ...overrides,
  };
}

export function setVisibilityState(state: DocumentVisibilityState): void {
  const targetDocument = ensureVisibilityStateDocument();
  Object.defineProperty(targetDocument, 'visibilityState', {
    configurable: true,
    value: state,
  });
}

function ensureVisibilityStateDocument(): Document {
  if (typeof document !== 'undefined') {
    installMissingDocumentTestApis(document);
    return document;
  }

  const testDocument = createVisibilityStateTestDocument();
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: testDocument,
  });
  return testDocument;
}

function createVisibilityStateTestDocument(): Document {
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  return {
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject | null) => {
      if (!listener) return;
      const typeListeners = listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
      typeListeners.add(listener);
      listeners.set(type, typeListeners);
    },
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject | null) => {
      if (!listener) return;
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent: (event: Event) => {
      for (const listener of listeners.get(event.type) ?? []) {
        if (typeof listener === 'function') {
          listener.call(globalThis.document, event);
        } else {
          listener.handleEvent(event);
        }
      }
      return true;
    },
    getElementById: () => null,
    querySelector: () => null,
  } as unknown as Document;
}

function installMissingDocumentTestApis(targetDocument: Document): void {
  const fallbackDocument = createVisibilityStateTestDocument();
  for (const key of ['addEventListener', 'removeEventListener', 'dispatchEvent', 'getElementById', 'querySelector'] as const) {
    if (typeof targetDocument[key] === 'function') {
      continue;
    }
    Object.defineProperty(targetDocument, key, {
      configurable: true,
      value: fallbackDocument[key].bind(fallbackDocument),
    });
  }
}
