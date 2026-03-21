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
});
