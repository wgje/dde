export interface DemoPreviewScenario { widget: string; state: string; title: string; steps: string; }
export const DEMO_PREVIEW_SCENARIOS: readonly DemoPreviewScenario[] = [
  { widget: 'task-archive', state: 'assigned', title: '流程图归档 · 阶段任务', steps: '点击“在流程图归档任务”；阶段卡片、根任务选项和未完成事项同时消失。取消归档后恢复。' },
  { widget: 'task-archive', state: 'assigned-archived', title: '流程图归档 · 阶段隐藏结果', steps: '静态归档结果；打开链接不会执行归档。点击取消归档可恢复同一任务。' },
  { widget: 'task-archive', state: 'unassigned', title: '流程图归档 · 待分配任务', steps: '点击“在流程图归档任务”；待分配列表与未完成事项同时隐藏该任务。' },
  { widget: 'task-archive', state: 'unassigned-archived', title: '流程图归档 · 待分配隐藏结果', steps: '静态归档结果；任务数据仍在本次预览中，点击取消归档可恢复。' },
  ...['panel', 'mobile', 'strata'].map(state => ({ widget: 'inbox', state, title: '黑匣子 · ' + ({panel: '条目操作', mobile: '手机条目', strata: '历史恢复'}[state] ?? state), steps: '真实组件与 SVG 图标；虚拟数据仅存于本页内存，刷新即恢复。' })),
  { widget: 'flow', state: 'legend', title: '小地图 · 图例', steps: '六类标记的真实图例。' },
  { widget: 'flow', state: 'overview-dense', title: '小地图 · 多树定位', steps: '点击任务或选择树 1 的任务 13，观察小地图定位柔光及直接关系。' },
  { widget: 'flow', state: 'overview-selected', title: '小地图 · 选中发光结果', steps: '静态结果示例；切换树 3 的任务或清除选择。' },
  { widget: 'flow', state: 'overview-zoomed', title: '小地图 · 放大结果', steps: '继续点击放大主图，检查任务块与连线同步放大。' },
  { widget: 'flow', state: 'overview-dense-mobile', title: '小地图 · 手机多树定位', steps: '100×80 小地图；选中任务后显示持续柔光。' },
  { widget: 'dock', state: 'mobile-entry', title: '手机停泊坞 · 透明入口', steps: '底部入口保持透明；需要时点按打开停泊任务。' },
  { widget: 'dock', state: 'mobile-open', title: '手机停泊坞 · 展开结果', steps: '直接查看当前、候选与待命分组；预览后可选择是否确认。' },
];
export function resolveDemoPreviewScenario(widget: string, state: string): DemoPreviewScenario | undefined {
  return DEMO_PREVIEW_SCENARIOS.find(scenario => scenario.widget === widget && scenario.state === state);
}
export function demoPreviewHref(widget: string, state: string): string {
  return `/#/dev-preview/${encodeURIComponent(widget)}/${encodeURIComponent(state)}`;
}
