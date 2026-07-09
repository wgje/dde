import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('flow-view.component.html', () => {
  it('应在移动端/桌面端条件分支之外共享渲染连接浮层宿主', () => {
    const templatePath = join(process.cwd(), 'src/app/features/flow/components/flow-view.component.html');
    const template = readFileSync(templatePath, 'utf8');
    const sharedMarker = '<!-- 共享连接浮层（移动端与桌面端共用） -->';
    const sharedMarkerIndex = template.indexOf(sharedMarker);

    expect(template).toMatch(/<\/div>\s*\n}\s*\n\s*<!-- 共享连接浮层（移动端与桌面端共用） -->/);
    expect(sharedMarkerIndex).toBeGreaterThan(-1);

    const sharedSection = template.slice(sharedMarkerIndex);
    expect(sharedSection).toContain('<app-flow-link-delete-hint');
    expect(sharedSection).toContain('<app-flow-link-action-menu');
    expect(sharedSection).toContain('<app-flow-connection-editor');
    expect(sharedSection).toContain('<app-flow-link-type-dialog');
  });

  it('应把 hint-only 只读态透传给连接编辑器', () => {
    const templatePath = join(process.cwd(), 'src/app/features/flow/components/flow-view.component.html');
    const template = readFileSync(templatePath, 'utf8');

    expect(template).toContain('[readOnly]="link.isHintOnlyStartupReadOnly()"');
  });

  it('应将 flow 侧任务链接输出绑定到中心定位逻辑', () => {
    const templatePath = join(process.cwd(), 'src/app/features/flow/components/flow-view.component.html');
    const template = readFileSync(templatePath, 'utf8');

    expect(template).toContain('(openLinkedTask)="centerOnNode($event)"');
    expect(template).toContain('(openTask)="centerOnNode($event)"');
  });

  it('应将两个任务详情僚机注意输出绑定到保存链路', () => {
    const templatePath = join(process.cwd(), 'src/app/features/flow/components/flow-view.component.html');
    const template = readFileSync(templatePath, 'utf8');
    const attentionBindings = template.match(/\(attentionChange\)="taskDetailPersistence\.persistAttentionItems\(\$event\)"/g) ?? [];

    expect(attentionBindings).toHaveLength(2);
  });

  it('任务详情可变更输出不应在模板中直接丢弃异步持久化结果', () => {
    const templatePath = join(process.cwd(), 'src/app/features/flow/components/flow-view.component.html');
    const template = readFileSync(templatePath, 'utf8');

    expect(template).not.toMatch(/\)="taskOps\.(updateTaskTitle|updateTaskContent|updateTaskPriority|updateTaskDueDate|addTaskTag|removeTaskTag|toggleTaskStatus|addQuickTodo|addTaskAttachment|removeTaskAttachment|updateTaskAttachments)\(/);
    expect(template.match(/\(titleChange\)="taskDetailPersistence\.persistTitle\(\$event\)"/g) ?? []).toHaveLength(2);
    expect(template.match(/\(contentChange\)="taskDetailPersistence\.persistContent\(\$event\)"/g) ?? []).toHaveLength(2);
    expect(template.match(/\(quickTodoAdd\)="taskDetailPersistence\.persistQuickTodo\(\$event\)"/g) ?? []).toHaveLength(2);
    expect(template.match(/\(attachmentsChange\)="taskDetailPersistence\.persistAttachments\(\$event\)"/g) ?? []).toHaveLength(2);
  });
});

describe('flow-view.component.ts', () => {
  it('应仅在连接操作成功时刷新流程图', () => {
    const sourcePath = join(process.cwd(), 'src/app/features/flow/components/flow-view.component.ts');
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).toContain('private readonly linkActions = new FlowViewLinkActionsController');
    expect(source).toContain('refreshDiagram: () => this.refreshDiagram()');
    expect(source).toContain('this.linkActions.confirmParentChildLink();');
    expect(source).toContain('await this.linkActions.saveConnectionDescription(data);');
  });

  it('任务详情保存应委托给专用持久化 controller', () => {
    const sourcePath = join(process.cwd(), 'src/app/features/flow/components/flow-view.component.ts');
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).toContain('readonly taskDetailPersistence = new FlowViewTaskDetailPersistenceController');
    expect(source).not.toMatch(/this\.taskOps\.(updateTaskAttentionItems|updateTaskTitle|updateTaskContent|updateTaskPriority|updateTaskDueDate|addTaskTag|removeTaskTag|toggleTaskStatus|addQuickTodo|addTaskAttachment|removeTaskAttachment|updateTaskAttachments)\(/);
    expect(source).not.toContain('private async persistTaskDetailMutation');
  });

  it('应把流程图链接跳转委托给导航 controller', () => {
    const sourcePath = join(process.cwd(), 'src/app/features/flow/components/flow-view.component.ts');
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).toContain('private readonly navigation = new FlowViewNavigationController');
    expect(source).toContain('getTask: taskId => this.projectState.getTask(taskId)');
    expect(source).toContain('warn: (message, context) => this.logger.warn(message, context)');
    expect(source).toContain('this.navigation.centerOnNode(taskId, openDetail);');
  });

  it('重建 Flow 视图时应重新激活被清理的 root 单例交互服务', () => {
    const sourcePath = join(process.cwd(), 'src/app/features/flow/components/flow-view.component.ts');
    const source = readFileSync(sourcePath, 'utf8');
    const afterViewInit = source.match(/ngAfterViewInit\(\) \{[\s\S]*?\n  \}/)?.[0] ?? '';

    expect(afterViewInit).toContain('this.touch.activate();');
    expect(afterViewInit).toContain('this.link.activate();');
  });

  it('待分配 touch 未成功启动时不应安装 document 级全局监听', () => {
    const sourcePath = join(process.cwd(), 'src/app/features/flow/components/flow-view.component.ts');
    const source = readFileSync(sourcePath, 'utf8');
    const handler = source.match(/onUnassignedTouchStart\(event: TouchEvent, task: Task\): void \{[\s\S]*?\n  \}/)?.[0] ?? '';

    expect(handler).toContain('if (!this.touch.startTouch(event, task)) {');
    expect(handler).toMatch(/if \(!this\.touch\.startTouch\(event, task\)\) \{[\s\S]*?return;[\s\S]*?\}\s*this\.unassignedTouchDrop\.installGlobalListeners\(\);/);
  });

  it('快捷键触发的流程图刷新应等待异步操作完成', () => {
    const sourcePath = join(process.cwd(), 'src/app/features/flow/components/flow-view.component.ts');
    const source = readFileSync(sourcePath, 'utf8');
    const handler = source.match(/handleDiagramShortcut\(event: KeyboardEvent\): void \{[\s\S]*?\n  \}/)?.[0] ?? '';

    expect(handler).toContain("if (result.status !== 'handled') {");
    expect(handler).toContain('void result.completed.then(');
    expect(handler).not.toContain("result === 'handled'");
  });
});
