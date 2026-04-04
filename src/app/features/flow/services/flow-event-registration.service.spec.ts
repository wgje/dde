import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('flow-event-registration.service.ts', () => {
  const sourcePath = join(process.cwd(), 'src/app/features/flow/services/flow-event-registration.service.ts');
  const source = readFileSync(sourcePath, 'utf8');

  it('移动端单击关联块时应显式以预览态打开编辑器', () => {
    expect(source).toContain("mode: 'preview'");
  });

  it('背景点击处理在移动端编辑态下应切换到预览模式而非关闭', () => {
    expect(source).toContain('this.link.shouldIgnoreConnectionEditorBackgroundClose()');
    expect(source).toContain("this.link.setConnectionEditorMode('preview')");
    expect(source).toContain('this.link.closeConnectionEditor();');
  });

  it('hint-only 时节点拖拽完成后应立即按 store 回滚图上位置', () => {
    expect(source).toContain('this.taskOpsAdapter.isHintOnlyStartupReadOnly()');
    expect(source).toContain('diagramInstance.updateAllTargetBindings()');
    expect(source).toContain('diagramInstance.requestUpdate()');
  });
});
