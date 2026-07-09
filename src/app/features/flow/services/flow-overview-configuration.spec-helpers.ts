import { beforeEach, expect, it } from 'vitest';
import * as go from 'gojs';

import type { FlowOverviewService } from './flow-overview.service';

export interface FlowOverviewConfigurationSpecContext {
  getService(): FlowOverviewService;
}

export function registerFlowOverviewConfigurationSpecs(context: FlowOverviewConfigurationSpecContext): void {
  let service: FlowOverviewService;

  beforeEach(() => {
    service = context.getService();
  });

  it('Overview 必须显式 autoScale=None 以保证 scale/centerRect 不被 GoJS 默认 Uniform 自动重居中（根因回归）', () => {
    const overview = service.overviewInstance as unknown as { autoScale: number };
    expect(overview.autoScale).toBe(go.AutoScale.None);
  });

  it('Overview 必须禁用内建交互，避免与手动 box 拖拽竞争', () => {
    const overview = service.overviewInstance as unknown as { isEnabled: boolean };
    expect(overview.isEnabled).toBe(false);
  });

  it('Overview 不应设置 contentAlignment，避免按容器居中后让预览框与主视图脱节', () => {
    const overview = service.overviewInstance as unknown as { contentAlignment?: unknown };
    expect(overview.contentAlignment).toBeUndefined();
  });
}
