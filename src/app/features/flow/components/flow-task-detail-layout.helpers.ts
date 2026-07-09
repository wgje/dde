export interface ComputeTaskDetailAutoDrawerHeightInput {
  titleHeight: number;
  handleHeight: number;
  intrinsicContentHeight: number;
  viewportHeight: number;
  guardPx: number;
  minVh: number;
  maxVh: number;
}

export interface ComputeTaskDetailDrawerResizeHeightInput {
  currentY: number;
  startY: number;
  startHeight: number;
  viewportHeight: number;
  minVh: number;
  maxVh: number;
}

export interface ComputeTaskDetailDragPositionInput {
  startClientX: number;
  startClientY: number;
  currentClientX: number;
  currentClientY: number;
  offsetX: number;
  offsetY: number;
  viewportWidth: number;
  viewportHeight: number;
  panelWidth: number;
  panelHeight: number;
  marginPx: number;
}

export interface TaskDetailDragRectLike {
  left: number;
  top: number;
}

export interface ComputeTaskDetailDragStateInput {
  clientX: number;
  clientY: number;
  panelRect: TaskDetailDragRectLike;
  parentRect: TaskDetailDragRectLike;
}

export interface ResolveTaskDetailMobileDrawerElementsInput {
  host: HTMLElement;
  container?: HTMLElement | null;
  title?: HTMLElement | null;
  content?: HTMLElement | null;
  handle?: HTMLElement | null;
}

export interface TaskDetailMobileDrawerElements {
  container: HTMLElement;
  title: HTMLElement;
  content: HTMLElement;
  handle: HTMLElement;
}

export function resolveTaskDetailMobileDrawerElements(
  input: ResolveTaskDetailMobileDrawerElementsInput,
): TaskDetailMobileDrawerElements | null {
  const container = input.container ?? input.host.querySelector<HTMLElement>('.absolute.left-0.right-0.z-30');
  if (!container) return null;

  const title = input.title ?? container.querySelector<HTMLElement>('.flex-shrink-0');
  const content = input.content ?? container.querySelector<HTMLElement>('.overflow-y-auto');
  const handle = input.handle ?? container.querySelector<HTMLElement>('.touch-none.flex-shrink-0');
  if (!title || !content || !handle) return null;

  return { container, title, content, handle };
}

export function measureTaskDetailIntrinsicContentHeight(contentEl: HTMLElement): number {
  if (typeof window === 'undefined') return 0;
  const children = Array.from(contentEl.children) as HTMLElement[];
  if (children.length === 0) return 0;

  const contentStyle = window.getComputedStyle(contentEl);
  const paddingTop = Number.parseFloat(contentStyle.paddingTop || '0') || 0;
  const paddingBottom = Number.parseFloat(contentStyle.paddingBottom || '0') || 0;

  let totalChildrenHeight = 0;
  for (const child of children) {
    const rect = child.getBoundingClientRect();
    const style = window.getComputedStyle(child);
    const marginTop = Number.parseFloat(style.marginTop || '0') || 0;
    const marginBottom = Number.parseFloat(style.marginBottom || '0') || 0;
    totalChildrenHeight += rect.height + marginTop + marginBottom;
  }

  return Math.max(0, totalChildrenHeight + paddingTop + paddingBottom);
}

export function resolveTaskDetailContentMaxHeightClass(drawerHeight: number): string {
  if (drawerHeight < 15) return 'max-h-8';
  if (drawerHeight < 25) return 'max-h-16';
  if (drawerHeight < 35) return 'max-h-24';
  return 'max-h-28';
}

export function computeTaskDetailAutoDrawerHeightVh(
  input: ComputeTaskDetailAutoDrawerHeightInput,
): number | null {
  if (input.viewportHeight <= 0) return null;

  const targetPx = input.titleHeight + input.intrinsicContentHeight + input.handleHeight + input.guardPx;
  const minContentPx = input.titleHeight + input.handleHeight + 10;
  const maxPx = (input.maxVh / 100) * input.viewportHeight;
  const clampedPx = Math.max(minContentPx, Math.min(targetPx, maxPx));
  return Math.max(
    input.minVh,
    Math.min((clampedPx / input.viewportHeight) * 100, input.maxVh),
  );
}

export function computeTaskDetailDragPosition(
  input: ComputeTaskDetailDragPositionInput,
): { x: number; y: number } {
  const deltaX = input.currentClientX - input.startClientX;
  const deltaY = input.currentClientY - input.startClientY;
  const maxX = Math.max(0, input.viewportWidth - input.panelWidth - input.marginPx);
  const maxY = Math.max(0, input.viewportHeight - input.panelHeight - input.marginPx);

  return {
    x: Math.max(0, Math.min(maxX, input.offsetX + deltaX)),
    y: Math.max(0, Math.min(maxY, input.offsetY + deltaY)),
  };
}

export function computeTaskDetailDragState(
  input: ComputeTaskDetailDragStateInput,
): { startX: number; startY: number; offsetX: number; offsetY: number } {
  return {
    startX: input.clientX,
    startY: input.clientY,
    offsetX: input.panelRect.left - input.parentRect.left,
    offsetY: input.panelRect.top - input.parentRect.top,
  };
}

export function shouldEmitTaskDetailDrawerHeight(
  lastEmittedVh: number,
  nextVh: number,
  epsilonVh: number,
): boolean {
  return Math.abs(lastEmittedVh - nextVh) > epsilonVh;
}

export function computeTaskDetailDrawerResizeHeightVh(
  input: ComputeTaskDetailDrawerResizeHeightInput,
): number | null {
  if (input.viewportHeight <= 0) return null;

  const deltaY = input.currentY - input.startY;
  const deltaVh = (deltaY / input.viewportHeight) * 100;
  return Math.max(
    input.minVh,
    Math.min(input.maxVh, input.startHeight + deltaVh),
  );
}
