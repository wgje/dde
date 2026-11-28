export interface DemoPreviewScenario { widget: string; state: string; title: string; steps: string; }
export const DEMO_PREVIEW_SCENARIOS: readonly DemoPreviewScenario[] = [
  ...['panel', 'mobile', 'strata'].map(state => ({ widget: 'inbox', state, title: '黑匣子 · ' + ({panel: '条目操作', mobile: '手机条目', strata: '历史恢复'}[state] ?? state), steps: '真实组件与 SVG 图标；虚拟数据仅存于本页内存，刷新即恢复。' })),
  { widget: 'flow', state: 'legend', title: '小地图 · 图例', steps: '六类标记的真实图例。' },
  { widget: 'flow', state: 'overview-dense', title: '小地图 · 多树定位', steps: '点击任务或选择树 1 的任务 13，观察小地图定位柔光及直接关系。' },
  { widget: 'flow', state: 'overview-selected', title: '小地图 · 选中发光结果', steps: '静态结果示例；切换树 3 的任务或清除选择。' },
  { widget: 'flow', state: 'overview-zoomed', title: '小地图 · 放大结果', steps: '继续点击放大主图，检查任务块与连线同步放大。' },
  { widget: 'flow', state: 'overview-dense-mobile', title: '小地图 · 手机多树定位', steps: '100×80 小地图；选中任务后显示持续柔光。' },
];
export function resolveDemoPreviewScenario(widget: string, state: string): DemoPreviewScenario | undefined {
  return DEMO_PREVIEW_SCENARIOS.find(scenario => scenario.widget === widget && scenario.state === state);
}
export function demoPreviewHref(widget: string, state: string): string {
  return `/#/dev-preview/${encodeURIComponent(widget)}/${encodeURIComponent(state)}`;
}
