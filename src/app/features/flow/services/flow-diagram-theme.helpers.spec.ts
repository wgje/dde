import { describe, expect, it, vi } from 'vitest';
import {
  applyFlowDiagramCanvasBackground,
  refreshFlowDiagramTheme,
} from './flow-diagram-theme.helpers';

describe('flow-diagram-theme.helpers', () => {
  it('按主题和明暗模式更新画布背景', () => {
    const diagram = {
      div: { style: { backgroundColor: '' } },
      updateAllTargetBindings: vi.fn(),
    };

    expect(applyFlowDiagramCanvasBackground(diagram, 'default', false)).toBe(true);
    expect(diagram.div.style.backgroundColor).toBe('#F5F2E9');
  });

  it('diagram 或 div 缺失时不写入背景', () => {
    expect(applyFlowDiagramCanvasBackground(null, 'default', false)).toBe(false);
    expect(applyFlowDiagramCanvasBackground({ div: null, updateAllTargetBindings: vi.fn() }, 'default', false)).toBe(false);
  });

  it('刷新主题时重建模板、刷新绑定、更新背景和小地图', () => {
    const diagram = {
      div: { style: { backgroundColor: '' } },
      updateAllTargetBindings: vi.fn(),
    };
    const setupNodeTemplate = vi.fn();
    const setupLinkTemplate = vi.fn();
    const updateOverviewTheme = vi.fn();
    const debug = vi.fn();

    refreshFlowDiagramTheme({
      diagram,
      theme: 'default',
      isDark: true,
      setupNodeTemplate,
      setupLinkTemplate,
      updateOverviewTheme,
      debug,
    });

    expect(setupNodeTemplate).toHaveBeenCalledWith(diagram);
    expect(setupLinkTemplate).toHaveBeenCalledWith(diagram);
    expect(diagram.updateAllTargetBindings).toHaveBeenCalledOnce();
    expect(diagram.div.style.backgroundColor).toBe('#1a1a1a');
    expect(updateOverviewTheme).toHaveBeenCalledOnce();
    expect(debug).toHaveBeenCalledWith('主题变化触发 GoJS 重绘', { isDark: true, theme: 'default' });
  });
});
