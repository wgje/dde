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
});

describe('flow-view.component.ts', () => {
  it('应仅在连接操作成功时刷新流程图', () => {
    const sourcePath = join(process.cwd(), 'src/app/features/flow/components/flow-view.component.ts');
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).toContain('if (this.link.confirmParentChildLink()) {');
    expect(source).toContain('if (this.link.confirmCrossTreeLink()) {');
    expect(source).toContain('if (this.link.saveConnectionContent(data.sourceId, data.targetId, data.title, data.description)) {');
  });

  it('应忽略指向不存在任务的流程图链接跳转', () => {
    const sourcePath = join(process.cwd(), 'src/app/features/flow/components/flow-view.component.ts');
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).toContain('const task = taskId ? this.projectState.getTask(taskId) : undefined;');
    expect(source).toContain('if (!isNavigableFlowTask(task)) {');
    expect(source).toContain("this.logger.warn('目标任务不存在，忽略流程图链接跳转'");
  });
});

describe('project-shell.component.ts flow lazy-load recovery', () => {
  it('应在新版本待刷新时阻止 Flow 懒加载并先清缓存刷新', () => {
    const sourcePath = join(process.cwd(), 'src/app/core/shell/project-shell.component.ts');
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).toContain('this.appLifecycle.hasPendingVersionUpdate()');
    expect(source).toContain('reloadForPendingVersionBeforeFlow(source)');
    expect(source).toContain('reloadViaForceClearCache()');
    expect(source).toContain('Flow lazy-load blocked by pending app version; reloading before chunk request');
  });
});
