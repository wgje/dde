import { getFlowStyles, type FlowTheme } from '../../../../config/flow-styles';

export interface ThemeableFlowDiagram {
  div: { style: { backgroundColor: string } } | null;
  updateAllTargetBindings(): void;
}

export interface FlowDiagramThemeRefreshInput {
  diagram: ThemeableFlowDiagram;
  theme: FlowTheme;
  isDark: boolean;
  setupNodeTemplate: (diagram: ThemeableFlowDiagram) => void;
  setupLinkTemplate: (diagram: ThemeableFlowDiagram) => void;
  updateOverviewTheme: () => void;
  debug: (message: string, context?: unknown) => void;
}

export function applyFlowDiagramCanvasBackground(
  diagram: ThemeableFlowDiagram | null,
  theme: FlowTheme,
  isDark: boolean,
): boolean {
  if (!diagram?.div) return false;

  const flowStyles = getFlowStyles(theme, isDark ? 'dark' : 'light');
  diagram.div.style.backgroundColor = flowStyles.canvas.background;
  return true;
}

export function refreshFlowDiagramTheme(input: FlowDiagramThemeRefreshInput): void {
  input.setupNodeTemplate(input.diagram);
  input.setupLinkTemplate(input.diagram);
  input.diagram.updateAllTargetBindings();
  applyFlowDiagramCanvasBackground(input.diagram, input.theme, input.isDark);
  input.updateOverviewTheme();
  input.debug('主题变化触发 GoJS 重绘', { isDark: input.isDark, theme: input.theme });
}
