// ============================================
// 停泊坞 / 专注模式 — 用户可见文案集中管理
//
// 目的：将散落在多个服务和组件中的中文字符串集中到一处，
// 便于后续接入 i18n 框架时统一替换。
// 当前阶段为"字符串外部化"第一步，非完整 i18n 方案。
// ============================================

/**
 * 状态机展示标签 — DockUiStatus → 中文
 */
export const DOCK_STATUS_LABELS = {
  focusing: '专注中',
  waiting_done: '等待结束',
  suspended_waiting: '挂起等待',
  stalled: '停滞中',
  queued: '待启动',
} as const;

/**
 * 组合选择区域三维分组标签
 */
export const DOCK_GROUP_LABELS = {
  'homologous-advancement': '同源推进',
  'cognitive-downgrade': '认知降级',
  'asynchronous-boot': '异步并发',
  fallback: '异步并发',
} as const;

/**
 * Toast / 通知消息 — 按服务分组
 */
export const DOCK_TOAST = {
  // dock-engine.service / dock-inline-creation.service
  WAIT_CORRECTION_TITLE: '已校正等待/预计时长',
  waitCorrectionBody: (minutes: number) =>
    `等待时长不能超过预计时长，已同步调整为 ${minutes} 分钟`,

  // dock-inline-creation.service
  DOCK_FULL_TITLE: '停泊坞已满',
  dockFullBody: (hardLimit: number, entryTitle: string) =>
    `最多可保留 ${hardLimit} 个任务，请先移除部分任务后再添加「${entryTitle}」。`,
  DOCK_NEAR_LIMIT_TITLE: '停泊坞接近上限',
  dockNearLimitBody: (softLimit: number) =>
    `建议将入坞任务控制在 ${softLimit} 个以内，以保持专注控制台清晰。`,

  // parking-dock.component
  PIP_OPEN_FAIL_TITLE: '打开悬浮窗失败',
  PIP_OPEN_FAIL_BODY: '当前环境未能创建悬浮窗，请先留在主窗口继续处理。',
  SETTINGS_LOAD_FAIL_TITLE: '设置面板加载失败',
  SETTINGS_LOAD_FAIL_BODY: '请稍后重试。',

  // parking-dock.component — scrim toggle feedback
  SCRIM_ON: '背景虚化已开启，底部停泊坞进入背景操作轨。',
  SCRIM_OFF: '背景虚化已关闭，底部停泊坞保持可操作。',

  // parking-dock.component — inline create
  BACKUP_CREATED_TITLE: '新备选任务',
  BACKUP_CREATED_BODY: '已添加备选任务，可在背景操作轨里随时切到前台。',
} as const;

/**
 * 系统通知（Notification API）— dock-engine-lifecycle.service
 */
export const DOCK_NOTIFICATION = {
  TITLE: 'NanoFlow 专注提示',
  TIGHT_BLANK_BODY: '当前进入留白期，建议先保持空档，不再插入新任务。',
  fragmentCountdownBody: (countdown: number) =>
    `检测到短暂空闲，碎片时间倒计时已开始（${countdown} 秒）。`,
} as const;

/**
 * 帮助面板 — 焦点操作指引
 */
export const DOCK_HELP_SECTIONS = [
  {
    title: '点击',
    subtitle: '把主要动作显式摆到眼前',
    items: [
      '点击背景卡片可切到前台，系统会给出"已切换到前台"的即时反馈。',
      '补全属性按钮会打开属性面板，关闭后仍留在当前专注上下文。',
      '右上角关闭按钮会先进入退出确认，而不是直接把你踢出专注。',
    ],
  },
  {
    title: '键盘',
    subtitle: '保留快捷方式，但不让它们承担主路径',
    items: [
      'Alt + H 打开这份帮助。',
      'Alt + Shift + F 切换背景虚化；Alt + Shift + D 展开或收起停泊坞。',
      'Esc 只关闭当前层级：先关属性面板/帮助层，再处理虚化或退出确认。',
    ],
  },
  {
    title: '触控',
    subtitle: '移动端不需要记忆隐藏手势也能完成主要操作',
    items: [
      '完成、等待、负荷切换都有明确按钮，优先用按钮而不是手势。',
      '上滑完成仍可用，但现在属于专家快捷方式。',
      'Planner 在手机上会以底部面板展开，便于单手补全属性。',
    ],
  },
] as const;

/**
 * 默认新建任务标题
 */
export const DOCK_DEFAULT_TASK_TITLE = '新备选任务';
