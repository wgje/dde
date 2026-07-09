import type { BlackBoxEntry } from '../models/focus';

interface DevGateMockContext {
  projectId: string;
  userId: string;
  date: string;
  now: number;
  updatedAt: string;
}

interface DevGateMockEntrySpec {
  content: string;
  ageHours: number;
  snoozeCount: number;
}

const DEV_GATE_MOCK_ENTRY_SPECS: DevGateMockEntrySpec[] = [
  {
    content: '这是一条测试遗留条目 - 先做A模块，然后连B数据库，不对，那个接口有问题，要先弄C...',
    ageHours: 24,
    snoozeCount: 0,
  },
  {
    content: '第二条测试条目 - 需要修复支付接口的bug，客户反馈订单状态没有正确更新',
    ageHours: 23,
    snoozeCount: 1,
  },
  {
    content: '第三条 - 优化首页加载速度，现在太慢了',
    ageHours: 22,
    snoozeCount: 0,
  },
];

export function createDevGateMockEntries(): BlackBoxEntry[] {
  const context: DevGateMockContext = {
    projectId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    date: getYesterdayDate(),
    now: Date.now(),
    updatedAt: new Date().toISOString(),
  };

  return DEV_GATE_MOCK_ENTRY_SPECS.map(spec => createDevGateMockEntry(context, spec));
}

function createDevGateMockEntry(context: DevGateMockContext, spec: DevGateMockEntrySpec): BlackBoxEntry {
  return {
    id: crypto.randomUUID(),
    projectId: context.projectId,
    userId: context.userId,
    content: spec.content,
    date: context.date,
    createdAt: new Date(context.now - spec.ageHours * 60 * 60 * 1000).toISOString(),
    updatedAt: context.updatedAt,
    isRead: false,
    isCompleted: false,
    isArchived: false,
    deletedAt: null,
    syncStatus: 'synced',
    localCreatedAt: context.updatedAt,
    snoozeCount: spec.snoozeCount,
    snoozeUntil: undefined,
  };
}

function getYesterdayDate(): string {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return yesterday.toISOString().split('T')[0];
}
