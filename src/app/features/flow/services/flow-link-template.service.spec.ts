import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('flow-link-template.service.ts', () => {
  it('应让移动端关联块保持无直接 click 处理并扩大触控热区', () => {
    const sourcePath = join(process.cwd(), 'src/app/features/flow/services/flow-link-template.service.ts');
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).toContain('// 桌面端保留标签点击直达编辑；移动端交由 ObjectSingleClicked 统一处理');
    expect(source).toContain('...(isMobile ? {} : {');
    expect(source).toContain('minSize: new go.Size(44, 24)');
  });
});
