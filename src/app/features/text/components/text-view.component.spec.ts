import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('text-view.component.ts', () => {
  it('应将文本视图中的任务链接输出绑定到共享跳转逻辑', () => {
    const sourcePath = join(process.cwd(), 'src/app/features/text/components/text-view.component.ts');
    const source = readFileSync(sourcePath, 'utf8');

    const binding = '(openLinkedTask)="ops.onOpenLinkedTask($event)"';

    expect(source).toContain(binding);
    expect(source.match(/\(openLinkedTask\)=\"ops\.onOpenLinkedTask\(\$event\)\"/g)?.length).toBe(2);
  });
});