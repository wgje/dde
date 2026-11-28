const STATE_NAMES: Record<string, string> = {"sidecar-summary":"僚机摘要","sidecar-expanded":"僚机展开编辑","full":"完整面板","queued":"待启动","active":"进行中","burnout":"休息提醒","queue":"待同步队列","sidecar":"规划与注意项","fragment":"碎片休息","stalled":"暂停中","completed":"已完成","minimal":"简洁面板","daily":"日常任务","archived":"已归档","zen":"禅模式","light":"浅色","waiting-done":"等待结束","dark":"深色","read":"已读","scene":"专注背景","system":"跟随系统","focusing":"专注中","daily-completed":"日常完成结果","waiting":"等待中","status":"同步状态"};

export interface DemoPreviewScenario {
  widget: string;
  state: string;
  title: string;
  steps: string;
}

/** Stable URLs describe fixtures, never persisted entity IDs or user data. */
export const DEMO_PREVIEW_SCENARIOS: readonly DemoPreviewScenario[] = [
  { widget: 'flow', state: 'overview-dense', title: '小地图 · 124 个任务的多树定位', steps: '点击主图任务或选择树 1 的任务 13；小地图持续标出该节点、直接邻居和跨树关系。放大主图观察地图比例尺持续变化。' },
  { widget: 'flow', state: 'overview-selected', title: '小地图 · 多树选中结果', steps: '静态选中样例；切换到树 3 的任务 19，或清除选择，验证地图反馈同步。' },
  { widget: 'flow', state: 'overview-zoomed', title: '小地图 · 多树放大结果', steps: '预置放大状态；点击放大主图继续放大，不应停在全图适配比例。' },
  { widget: 'flow', state: 'overview-dense-mobile', title: '小地图 · 手机多树定位', steps: '100×80 小地图上的持续选中标记与关系；本例只操作内存数据。' },
  ...['palette','palette-unassigned','palette-blackbox','palette-history','right-panel'].map(state=>({widget:'flow-panels',state,title:'Flow 面板 · '+({'palette':'待办侧栏','palette-unassigned':'待分配侧栏','palette-blackbox':'黑匣子侧栏','palette-history':'历史侧栏','right-panel':'手机项目面板'}[state]||state),steps:'真实面板，虚拟数据与项目切换。'})),
  ...['overview','overview-collapsed','overview-mobile'].map(state=>({widget:'flow',state,title:'小地图 · '+({'overview':'展开','overview-collapsed':'收起','overview-mobile':'手机版'}[state]||state),steps:'真实地图面板和虚拟图，可展开收起、平移和缩放。'})),
  ...['trigger','gate-overlay','gate-complete'].map(state=>({widget:'focus-shell',state,title:'专注入口 · '+({'trigger':'进入与退出','gate-overlay':'处理遗留想法','gate-complete':'沉积完成'}[state]||state),steps:'真实 Focus 外壳，操作只改变本例；不接管主工作区。'})),
  ...['sync','sync-compact','toast-success','toast-info','pwa','parking-reminder','parking-eviction'].map(state=>({widget:'feedback',state,title:'页面反馈 · '+({'sync':'同步状态','sync-compact':'简洁同步状态','toast-success':'保存提示','toast-info':'消息提示','pwa':'安装提示','parking-reminder':'停泊提醒','parking-eviction':'停泊撤回'}[state]||state),steps:'真实反馈组件，虚拟结果；不触发安装、权限或网络。'})),
  ...['batch-toolbar','batch-toolbar-mobile','batch-delete','cascade-assign','delete-confirm','link-type','link-action','link-action-parent','link-delete-hint','connection-preview','connection-edit','connection-parent','toolbar','toolbar-mobile','toolbar-link'].map(state=>({widget:'flow-controls',state,title:'Flow 控件 · '+({'batch-toolbar':'批选工具栏','batch-toolbar-mobile':'手机批选工具栏','batch-delete':'批量删除','cascade-assign':'分配子树','delete-confirm':'删除确认','link-type':'连线类型','link-action':'关联菜单','link-action-parent':'父子关系菜单','link-delete-hint':'解除关联','connection-preview':'关联内容','connection-edit':'编辑关联','connection-parent':'父子关联','toolbar':'工具栏','toolbar-mobile':'手机工具栏','toolbar-link':'连线模式'}[state]||state),steps:'操作真实菜单和工具，只修改虚拟状态。'})),
  ...['unassigned','unassigned-mobile','unassigned-edit','unfinished','unfinished-mobile','mobile-todo','delete-single','delete-children'].map(state=>({widget:'text-lists',state,title:'文本视图 · '+({'unassigned':'待分配','unassigned-mobile':'手机待分配','unassigned-edit':'待分配编辑','unfinished':'待办列表','unfinished-mobile':'手机待办','mobile-todo':'手机待办抽屉','delete-single':'删除任务','delete-children':'删除子树'}[state]||state),steps:'真实列表和抽屉，任务数据只留在当前样例。'})),
  ...['project-create','delete-confirm','config-help','gate-actions'].map(state=>({widget:'controls',state,title:'常用控件 · '+({'project-create':'新建项目','delete-confirm':'删除确认','config-help':'配置帮助','gate-actions':'大门操作'}[state]||state),steps:'真实控件只操作虚拟数据，不创建或删除真实项目。'})),
  ...['bound','preview','unbound'].map(state=>({widget:'knowledge',state,title:'思源块 · '+({bound:'已绑定',preview:'正文与子块',unbound:'绑定入口'}[state]||state),steps:'虚拟思源文档，可绑定、查看和解除；不连接真实知识库。'})),
  {widget:'task',state:'siyuan',title:'任务卡 · 思源块与僚机',steps:'真实任务卡与虚拟思源内容，直接查看绑定块。'},
  ...['console','main','backup','waiting','planner','planner-complete','low-load','no-detail','wait-presets','radar-preview','radar-panorama','radar-overflow','radar-groups'].map(state=>({widget:'desktop-dock',state,title:'桌面停泊坞 · '+({console:'主控台',main:'主任务',backup:'备选任务',waiting:'等待任务',planner:'补全属性', 'planner-complete':'完整属性','low-load':'低负荷主卡','no-detail':'简洁主卡','wait-presets':'等待预设','radar-preview':'候选详情','radar-panorama':'全景候选','radar-overflow':'更多候选','radar-groups':'推荐分组'}[state]||state),steps:'真实停泊坞组件；选择、等待和属性修改只留在本例。'})),
  ...['expanded','collapsed','mobile','connections','connections-incoming','connections-both','connections-collapsed'].map(state=>({widget:'task-tree',state,title:'任务树 · '+({expanded:'展开阶段',collapsed:'折叠阶段',mobile:'手机卡片',connections:'任务关联','connections-incoming':'入向关联','connections-both':'双向关联','connections-collapsed':'收起关联'}[state]||state),steps:'展开、编辑任务和查看关联，无真实数据写入。'})),
  ...['data','data-preview','data-done','safety-preview','safety-done','attachment','attachment-done','siyuan-relay','siyuan-direct','siyuan-cache','backup-setup','backup-resume','backup-enabled','backup-list','backup-preview','backup-done'].map(state=>({widget:'settings',state,title:'设置 · '+({'data':'数据管理','data-preview':'导入预览','data-done':'导入结果','safety-preview':'安全包预览','safety-done':'安全包恢复结果','attachment':'附件备份','attachment-done':'附件结果','siyuan-relay':'思源扩展连接','siyuan-direct':'思源直连','siyuan-cache':'思源缓存','backup-setup':'备份目录设置','backup-resume':'备份权限恢复','backup-enabled':'自动备份','backup-list':'备份列表','backup-preview':'备份恢复预览','backup-done':'备份恢复结果'}[state]||state),steps:'虚拟状态展示，不访问文件、目录、扩展或网络。'})),
  {widget:'flow',state:'detail-completed',title:'Flow · 完成结果',steps:'直接显示虚拟完成任务，不执行完成动作。'},
  {widget:'flow',state:'detail',title:'Flow · 任务详情与僚机',steps:'直接展示真实详情，可编辑虚拟任务。'},
  ...['panel', 'mobile', 'recorder', 'recording', 'transcription', 'strata'].map(state => ({ widget: 'inbox', state, title: '黑匣子 · ' + ({panel:'完整条目仓',recorder:'录音按钮',recording:'录音中',transcription:'待保存文字',strata:'历史地质层'}[state] || state), steps:'真实组件的虚拟录音和历史数据，不调用麦克风或外部服务。' })),
  ...['active', 'completed', 'archived', 'sidecar', 'sidecar-summary', 'sidecar-expanded'].map(state => ({ widget: 'task', state, title: `任务卡 · ${STATE_NAMES[state] || state}`, steps: '点击任务卡查看、编辑内容；刷新恢复样例。' })),
  { widget: 'dock', state: 'create', title: '停泊坞 · 添加前', steps: '输入标题，点击添加到停泊坞。' },
  { widget: 'dock', state: 'created', title: '停泊坞 · 添加结果', steps: '这是已经添加的结果；没有替你执行创建操作。' },
  { widget: 'dock', state: 'mobile-entry', title: '手机停泊坞 · 透明入口', steps: '底部透明入口不覆盖工作区；点击停泊坞展开任务抽屉。' },
  { widget: 'dock', state: 'mobile-open', title: '手机停泊坞 · 展开结果', steps: '直接展示展开状态；未替你切换任务。关闭后回到透明入口。' },
  ...['normal', 'sidecar', 'parked', 'focused', 'search'].map(state => ({ widget: 'flow', state, title: '流程图 · ' + ({normal: '任务关系', sidecar: '节点规划', parked: '停泊节点', focused: '专注节点', search: '搜索高亮'}[state] || state), steps: '拖动节点、缩放与编辑虚拟图；刷新恢复样例。' })),
  { widget: 'flow', state: 'legend', title: '流程图 · 小地图图例', steps: '点击图例切换标记显示。' },
  ...['light', 'dark', 'system'].map(state => ({ widget: 'settings', state, title: `设置 · ${STATE_NAMES[state] || state}`, steps: '切换颜色模式，只影响本例。' })),
  ...['full', 'minimal'].map(state => ({ widget: 'focus', state, title: `Focus · ${STATE_NAMES[state] || state}`, steps: '查看真实 Focus 状态组件。' })),
  ...['focusing', 'waiting', 'queued', 'waiting-done', 'stalled', 'minimal'].map(state => ({ widget: 'status', state, title: `任务状态 · ${STATE_NAMES[state] || state}`, steps: '直接查看此状态，不执行真实业务动作。' })),
  ...['read', 'completed'].map(state => ({ widget: 'black-box', state, title: `黑匣子 · ${STATE_NAMES[state] || state}`, steps: '直接查看结果；虚拟数据刷新即恢复。' })),
  ...['status', 'queue'].map(state => ({ widget: 'dashboard', state, title: `仪表盘 · ${STATE_NAMES[state] || state}`, steps: '只操作虚拟同步队列，不发送网络请求。' })),
  ...['daily', 'daily-completed', 'fragment', 'scene', 'zen', 'burnout'].map(state => ({ widget: 'focus', state, title: `Focus · ${STATE_NAMES[state] || state}`, steps: '直接展示真实 Focus 组件；操作只影响当前样例。' })),
  { widget: 'focus-decision', state: 'decision', title: 'Focus · 选择下一项', steps: '点击真实候选任务，只更改此样例。' },
  { widget: 'focus-decision', state: 'countdown', title: 'Focus · 碎片选择', steps: '选择进入或跳过碎片推荐。' },
  ...['focus', 'focus-off', 'routines', 'routines-completed', 'all'].map(state => ({ widget: 'settings', state, title: '设置 · ' + ({focus: '专注偏好', 'focus-off': '关闭偏好', routines: '日常任务', 'routines-completed': '日常完成结果', all: '全部预览设置'}[state] || state), steps: '真实设置组件，只修改虚拟偏好。' })),
  { widget: 'settings', state: 'appearance', title: '设置 · 外观', steps: '切换主题与颜色；只影响本例。' },
  { widget: 'focus', state: 'gate', title: 'Focus · 大门卡片', steps: '上推已读，下拉完成。' },
  { widget: 'status', state: 'normal', title: '状态 · 任务状态', steps: '查看和切换任务状态。' },
  { widget: 'recovery', state: 'before', title: '恢复 · 操作前', steps: '点击恢复虚拟记录。' },
  { widget: 'recovery', state: 'restored', title: '恢复 · 操作结果', steps: '直接查看已恢复的结果。' },
  { widget: 'black-box', state: 'unread', title: '黑匣子 · 未读', steps: '标记已读或完成此虚拟记录。' },
];

export function resolveDemoPreviewScenario(widget: string, state: string): DemoPreviewScenario | undefined {
  return DEMO_PREVIEW_SCENARIOS.find(scenario => scenario.widget === widget && scenario.state === state);
}

export function demoPreviewHref(widget: string, state: string): string {
  return `/#/dev-preview/${encodeURIComponent(widget)}/${encodeURIComponent(state)}`;
}
