import type {
  Attachment,
  AttachmentType,
  Connection,
  Project,
  Task,
  TaskStatus,
} from '../../models';

export function createCompleteAttachment(id: string): Attachment {
  return {
    id,
    type: 'image' as AttachmentType,
    name: `attachment-${id}.png`,
    url: `https://storage.example.com/${id}`,
    thumbnailUrl: `https://storage.example.com/${id}/thumb`,
    mimeType: 'image/png',
    size: 1024 * 100,
    createdAt: '2024-01-15T10:30:00.000Z',
    signedAt: '2024-01-15T10:30:00.000Z',
  };
}

export function createCompleteTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    content: `# Markdown Content for ${id}\n\nThis is **bold** and *italic*.`,
    stage: 1,
    parentId: null,
    order: 0,
    rank: 10000,
    status: 'active' as TaskStatus,
    x: 150.5,
    y: 250.75,
    createdDate: '2024-01-10T08:00:00.000Z',
    updatedAt: '2024-01-15T14:30:00.000Z',
    displayId: '1',
    shortId: 'NF-A1B2',
    hasIncompleteTask: true,
    deletedAt: null,
    tags: ['important', 'urgent'],
    priority: 'high',
    dueDate: '2024-02-01T00:00:00.000Z',
    attachments: [createCompleteAttachment(`att-${id}-1`)],
    deletedConnections: [],
    deletedMeta: undefined,
    ...overrides,
  };
}

export function createCompleteConnection(id: string, source: string, target: string): Connection {
  return {
    id,
    source,
    target,
    title: `Connection ${id} Title`,
    description: `Detailed description for connection ${id}`,
    deletedAt: null,
  };
}

export function createCompleteProject(): Project {
  const task1 = createCompleteTask('task-1');
  const task2 = createCompleteTask('task-2', {
    parentId: 'task-1',
    displayId: '1,a',
    stage: 2,
  });
  const task3 = createCompleteTask('task-3', {
    deletedAt: '2024-01-14T00:00:00.000Z',
  });

  const conn1 = createCompleteConnection('conn-1', 'task-1', 'task-2');
  const conn2 = createCompleteConnection('conn-2', 'task-2', 'task-3');
  conn2.deletedAt = '2024-01-14T00:00:00.000Z';

  return {
    id: 'project-complete',
    name: 'Complete Test Project',
    description: 'A project with all fields populated for integrity testing',
    createdDate: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-15T18:00:00.000Z',
    version: 5,
    tasks: [task1, task2, task3],
    connections: [conn1, conn2],
    viewState: {
      scale: 1.5,
      positionX: 100,
      positionY: 200,
    },
    flowchartUrl: 'https://storage.example.com/flowchart.png',
    flowchartThumbnailUrl: 'https://storage.example.com/flowchart-thumb.png',
  };
}
