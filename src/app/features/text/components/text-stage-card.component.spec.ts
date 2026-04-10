import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('TextStageCardComponent', () => {
  it('折叠列表模板应保留 inert 与 aria-hidden 防线', () => {
    const source = readFileSync(resolve(__dirname, 'text-stage-card.component.ts'), 'utf8');

    expect(source).toContain('[attr.inert]="!isExpanded() ? \'\' : null"');
    expect(source).toContain('[attr.aria-hidden]="!isExpanded()"');
  });
});