/**
 * ToastService 单元测试
 * 
 * 测试覆盖：
 * - 基本 Toast 显示功能
 * - 去重机制（防止 Toast 轰炸）
 * - 消息合并和限制
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ToastService, ToastMessage } from './toast.service';

// Mock TOAST_CONFIG
vi.mock('../config', () => ({
  TOAST_CONFIG: {
    DEFAULT_DURATION: 5000,
    ERROR_DEDUP_INTERVAL: 5000,
  }
}));

describe('ToastService', () => {
  let service: ToastService;

  beforeEach(() => {
    vi.useFakeTimers();
    service = new ToastService();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('基本功能', () => {
    it('success 应该显示成功消息', () => {
      service.success('成功', '操作已完成');
      
      const messages = service.messages();
      expect(messages.length).toBe(1);
      expect(messages[0].type).toBe('success');
      expect(messages[0].title).toBe('成功');
      expect(messages[0].message).toBe('操作已完成');
    });

    it('error 应该显示错误消息', () => {
      service.error('错误', '操作失败');
      
      const messages = service.messages();
      expect(messages.length).toBe(1);
      expect(messages[0].type).toBe('error');
      expect(messages[0].title).toBe('错误');
    });

    it('warning 应该显示警告消息', () => {
      service.warning('警告', '请注意');
      
      const messages = service.messages();
      expect(messages.length).toBe(1);
      expect(messages[0].type).toBe('warning');
    });

    it('info 应该显示信息消息', () => {
      service.info('提示', '一些信息');
      
      const messages = service.messages();
      expect(messages.length).toBe(1);
      expect(messages[0].type).toBe('info');
    });

    it('dismiss 应该关闭指定消息', () => {
      service.success('消息1');
      service.info('消息2');
      
      const messages = service.messages();
      expect(messages.length).toBe(2);
      
      const firstId = messages[0].id;
      service.dismiss(firstId);
      
      expect(service.messages().length).toBe(1);
      expect(service.messages()[0].title).toBe('消息2');
    });

    it('dismissAll 应该关闭所有消息', () => {
      service.success('消息1');
      service.info('消息2');
      service.warning('消息3');
      
      expect(service.messages().length).toBe(3);
      
      service.dismissAll();
      
      expect(service.messages().length).toBe(0);
    });

    it('hasMessages 应该正确反映消息状态', () => {
      expect(service.hasMessages()).toBe(false);
      
      service.info('测试');
      expect(service.hasMessages()).toBe(true);
      
      service.dismissAll();
      expect(service.hasMessages()).toBe(false);
    });
  });

  describe('自动关闭', () => {
    it('消息应该在 duration 后自动关闭', () => {
      service.success('测试消息', undefined, 3000);
      
      expect(service.messages().length).toBe(1);
      
      // 快进 3 秒
      vi.advanceTimersByTime(3000);
      
      expect(service.messages().length).toBe(0);
    });

    it('duration 为 0 时不应该自动关闭', () => {
      service.error('持久消息', undefined, { duration: 0 });
      
      expect(service.messages().length).toBe(1);
      
      // 快进 1 分钟
      vi.advanceTimersByTime(60000);
      
      // 消息应该仍然存在
      expect(service.messages().length).toBe(1);
    });
  });

  describe('error 去重', () => {
    it('相同的错误消息在去重间隔内不应该重复显示', () => {
      service.error('连接失败', '网络错误');
      service.error('连接失败', '网络错误');
      service.error('连接失败', '网络错误');
      
      // 只应该显示一次
      expect(service.messages().length).toBe(1);
    });

    it('不同的错误消息应该都显示', () => {
      service.error('错误1', '描述1');
      service.error('错误2', '描述2');
      service.error('错误3', '描述3');
      
      expect(service.messages().length).toBe(3);
    });

    it('去重间隔过后应该可以再次显示相同消息', () => {
      service.error('连接失败', '网络错误');
      expect(service.messages().length).toBe(1);
      
      // 快进超过去重间隔（5秒）
      vi.advanceTimersByTime(6000);
      
      // 清除已自动关闭的消息
      service.dismissAll();
      
      // 现在可以再次显示
      service.error('连接失败', '网络错误');
      expect(service.messages().length).toBe(1);
    });
  });

  describe('warning 去重', () => {
    it('相同的警告消息在去重间隔内不应该重复显示', () => {
      service.warning('同步警告', '队列即将满载');
      service.warning('同步警告', '队列即将满载');
      service.warning('同步警告', '队列即将满载');
      
      // 只应该显示一次
      expect(service.messages().length).toBe(1);
    });

    it('不同的警告消息应该都显示', () => {
      service.warning('警告1', '描述1');
      service.warning('警告2', '描述2');
      
      expect(service.messages().length).toBe(2);
    });

    it('去重间隔过后应该可以再次显示相同警告', () => {
      service.warning('同步警告', '队列即将满载');
      expect(service.messages().length).toBe(1);
      
      // 快进超过去重间隔
      vi.advanceTimersByTime(6000);
      service.dismissAll();
      
      service.warning('同步警告', '队列即将满载');
      expect(service.messages().length).toBe(1);
    });
  });

  describe('消息数量限制', () => {
    it('最多显示 5 条消息', () => {
      for (let i = 0; i < 10; i++) {
        service.info(`消息${i}`);
      }
      
      expect(service.messages().length).toBe(5);
    });

    it('新消息应该保留，旧消息被移除', () => {
      for (let i = 0; i < 6; i++) {
        service.info(`消息${i}`);
      }
      
      const messages = service.messages();
      expect(messages.length).toBe(5);
      
      // 最后添加的消息应该存在
      expect(messages.some(m => m.title === '消息5')).toBe(true);
    });

    it('错误消息应该优先保留', () => {
      // 先添加普通消息
      service.info('普通消息1');
      service.info('普通消息2');
      service.info('普通消息3');
      service.info('普通消息4');
      
      // 添加错误消息
      service.error('重要错误');
      
      // 再添加一条普通消息，触发淘汰
      service.info('普通消息5');
      
      const messages = service.messages();
      // 错误消息应该被保留
      expect(messages.some(m => m.type === 'error')).toBe(true);
    });
  });

  describe('消息合并', () => {
    it('相同的消息显示中时应该刷新而非重复添加', () => {
      service.info('测试消息', '详情');
      service.info('测试消息', '详情');
      
      // 应该只有一条消息
      expect(service.messages().length).toBe(1);
    });

    it('相同消息重复触发时应该复用同一条并重置自动关闭计时', () => {
      service.info('测试消息', '详情', 1000);

      const firstToast = service.messages()[0];
      expect(firstToast).toBeDefined();

      // 接近过期时重复触发同一消息，应该只刷新计时而不是新增/替换
      vi.advanceTimersByTime(900);
      service.info('测试消息', '详情', 1000);

      const secondToast = service.messages()[0];
      expect(service.messages().length).toBe(1);
      expect(secondToast.id).toBe(firstToast.id);

      // 如果未重置计时，这里会被旧定时器移除
      vi.advanceTimersByTime(200);
      expect(service.messages().length).toBe(1);

      // 再过剩余时间后应自动关闭
      vi.advanceTimersByTime(800);
      expect(service.messages().length).toBe(0);
    });
  });

  describe('选项处理', () => {
    it('应该支持数字作为 duration 选项', () => {
      service.success('快速消息', undefined, 1000);
      
      expect(service.messages().length).toBe(1);
      
      vi.advanceTimersByTime(1000);
      expect(service.messages().length).toBe(0);
    });

    it('应该支持对象作为选项', () => {
      service.success('持久消息', undefined, { duration: 10000 });
      
      vi.advanceTimersByTime(5000);
      expect(service.messages().length).toBe(1);
      
      vi.advanceTimersByTime(5000);
      expect(service.messages().length).toBe(0);
    });

    it('应该支持 action 按钮', () => {
      const onClick = vi.fn();
      service.warning('确认操作', '点击执行', {
        action: { label: '执行', onClick }
      });
      
      const messages = service.messages();
      expect(messages[0].action).toBeDefined();
      expect(messages[0].action?.label).toBe('执行');
      
      // 模拟点击
      messages[0].action?.onClick();
      expect(onClick).toHaveBeenCalledTimes(1);
    });
  });
});
