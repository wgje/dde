import { Task } from '../../../../models';

export type LinkGestureResult =
  | 'show-dialog'
  | 'create-cross-tree'
  | 'create-parent-child'
  | 'replace-subtree'
  | 'none';

type AssignedTask = Task & { stage: number };

interface LinkGestureInput {
  sourceId: string;
  targetId: string;
  x: number;
  y: number;
  sourceTask: Task | undefined;
  childTask: Task | undefined;
  logGesture: (sourceTask: Task | undefined, childTask: Task | undefined) => void;
  warnCannotSelfConnect: () => void;
  warnInvalidUnassignedParent: () => void;
  guardMutation: (action: string) => boolean;
  handleTaskToUnassignedLink: (childTask: Task) => Promise<LinkGestureResult>;
  moveTaskToStage: (
    taskId: string,
    stage: number | null,
    parentId: string | null
  ) => Promise<{ ok: boolean; error?: { message?: string } }>;
  toastError: (title: string, message: string) => void;
  toastSuccess: (title: string, message: string) => void;
  addCrossTreeConnection: () => Promise<boolean>;
  showLinkTypeDialog: () => void;
}

export async function handleLinkGesture(input: LinkGestureInput): Promise<LinkGestureResult> {
  if (input.sourceId === input.targetId) {
    input.warnCannotSelfConnect();
    return 'none';
  }

  input.logGesture(input.sourceTask, input.childTask);

  if (isInvalidUnassignedParentLink(input.sourceTask, input.childTask)) {
    input.warnInvalidUnassignedParent();
    return 'none';
  }

  if (input.guardMutation('创建连接')) {
    return 'none';
  }

  if (input.childTask && isTaskToUnassignedLink(input.sourceTask, input.childTask)) {
    return input.handleTaskToUnassignedLink(input.childTask);
  }

  if (input.childTask?.parentId) {
    return handleTargetWithExistingParent(input);
  }

  input.showLinkTypeDialog();
  return 'show-dialog';
}

async function handleTargetWithExistingParent(input: LinkGestureInput): Promise<LinkGestureResult> {
  const childTask = input.childTask;
  if (!childTask) {
    return 'none';
  }

  if (input.sourceTask && childTask.stage === null && input.sourceTask.stage === null) {
    return reparentUnassignedTask(input, input.sourceTask, childTask);
  }

  if (canClaimUnassignedChild(input.sourceTask, childTask)) {
    return claimUnassignedChild(input, input.sourceTask, childTask);
  }

  return createCrossTreeConnection(input);
}

async function reparentUnassignedTask(
  input: LinkGestureInput,
  sourceTask: Task,
  childTask: Task
): Promise<LinkGestureResult> {
  const result = await input.moveTaskToStage(childTask.id, null, sourceTask.id);
  if (!result.ok) {
    input.toastError('连接失败', result.error?.message || '未知错误');
    return 'none';
  }

  input.toastSuccess('已建立待分配层级', '待分配块已挂载到新的父节点');
  return 'create-parent-child';
}

async function claimUnassignedChild(
  input: LinkGestureInput,
  sourceTask: AssignedTask,
  childTask: Task
): Promise<LinkGestureResult> {
  const result = await input.moveTaskToStage(childTask.id, sourceTask.stage + 1, sourceTask.id);
  if (!result.ok) {
    input.toastError('分配失败', result.error?.message || '未知错误');
    return 'none';
  }

  input.toastSuccess('已分配任务', `"${childTask.title}" 已成为新任务的子任务`);
  return 'create-parent-child';
}

async function createCrossTreeConnection(input: LinkGestureInput): Promise<LinkGestureResult> {
  if (input.guardMutation('创建关联')) {
    return 'none';
  }

  const saved = await input.addCrossTreeConnection();
  if (!saved) {
    input.toastError('创建关联失败', '关联变更未能写入本地队列');
    return 'none';
  }

  input.toastSuccess('已创建关联', '目标任务已有父级，已创建关联连接');
  return 'create-cross-tree';
}

function isInvalidUnassignedParentLink(
  sourceTask: Task | undefined,
  childTask: Task | undefined
): boolean {
  return !!sourceTask && sourceTask.stage === null && !!childTask && childTask.stage !== null;
}

function isTaskToUnassignedLink(
  sourceTask: Task | undefined,
  childTask: Task
): boolean {
  return !!sourceTask && sourceTask.stage !== null && childTask.stage === null;
}

function canClaimUnassignedChild(
  sourceTask: Task | undefined,
  childTask: Task
): sourceTask is AssignedTask {
  return !!sourceTask &&
    childTask.stage === null &&
    sourceTask.stage !== null &&
    sourceTask.stage !== undefined;
}
