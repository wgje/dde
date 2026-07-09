import type { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import type { ProjectStateService } from '../../../../services/project-state.service';
import type { Task } from '../../../../models';
import { readTaskDragPayload } from '../../../../utils/task-drag-payload';
import * as go from 'gojs';

interface FlowDiagramDropLogger {
  error(message: string, error?: unknown): void;
}

export interface FlowDiagramDropHandlersInput {
  diagram: go.Diagram;
  diagramDiv: HTMLDivElement;
  projectState: ProjectStateService;
  logger: FlowDiagramDropLogger;
  sentryLazyLoader: SentryLazyLoaderService;
  onDrop: (taskData: Task, docPoint: go.Point) => void;
}

export function installFlowDiagramDropHandlers(input: FlowDiagramDropHandlersInput): () => void {
  const dragoverHandler = (event: DragEvent) => {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
  };

  const dropHandler = (event: DragEvent) => {
    event.preventDefault();
    handleFlowDiagramDrop(event, input);
  };

  input.diagramDiv.addEventListener('dragover', dragoverHandler);
  input.diagramDiv.addEventListener('drop', dropHandler);

  return () => {
    input.diagramDiv.removeEventListener('dragover', dragoverHandler);
    input.diagramDiv.removeEventListener('drop', dropHandler);
  };
}

function handleFlowDiagramDrop(event: DragEvent, input: FlowDiagramDropHandlersInput): void {
  if (!event.dataTransfer) return;

  try {
    const task = resolveDroppedTask(event.dataTransfer, input.projectState);
    if (!task) return;

    const rect = input.diagramDiv.getBoundingClientRect();
    const viewX = event.clientX - rect.left;
    const viewY = event.clientY - rect.top;
    const loc = input.diagram.transformViewToDoc(new go.Point(viewX, viewY));
    input.onDrop(task, loc);
  } catch (error) {
    input.logger.error('Drop error:', error);
    input.sentryLazyLoader.captureException(error, { tags: { operation: 'drop' } });
  }
}

function resolveDroppedTask(dataTransfer: DataTransfer, projectState: ProjectStateService): Task | null {
  const payload = readTaskDragPayload(dataTransfer);
  const payloadTask = payload ? projectState.getTask(payload.taskId) ?? null : null;
  if (payloadTask) return payloadTask;

  const jsonData = dataTransfer.getData('application/json');
  const textData = dataTransfer.getData('text');
  const data = jsonData || textData;
  if (!data) return null;

  const trimmed = data.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return projectState.getTask(trimmed) ?? null;
  }

  const raw = JSON.parse(data) as Partial<Task> & { id?: unknown };
  const candidateId = typeof raw.id === 'string' ? raw.id : null;
  return candidateId ? projectState.getTask(candidateId) ?? (raw as Task) : null;
}
