/**
 * 备份告警 Edge Function
 * 
 * 功能：
 * 1. 备份失败告警
 * 2. 恢复操作通知
 * 3. 存储容量预警
 * 4. 定期健康报告
 * 
 * 支持的通道：
 * - Slack Webhook
 * - Email (通过 Resend API)
 * 
 * 位置: supabase/functions/backup-alert/index.ts
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

// ===========================================
// 类型定义
// ===========================================

interface AlertPayload {
  /** 告警类型 */
  type: 'backup_failed' | 'restore_completed' | 'storage_warning' | 'health_report';
  /** 告警级别 */
  severity: 'info' | 'warning' | 'error' | 'critical';
  /** 告警标题 */
  title: string;
  /** 告警详情 */
  message: string;
  /** 附加数据 */
  data?: Record<string, unknown>;
  /** 指定通道（可选，默认使用配置的所有通道） */
  channels?: ('slack' | 'email')[];
}

interface AlertConfig {
  slack?: {
    webhookUrl: string;
    channel?: string;
    username?: string;
  };
  email?: {
    apiKey: string;
    from: string;
    to: string[];
  };
}

interface AlertResult {
  success: boolean;
  channelResults: {
    channel: string;
    success: boolean;
    error?: string;
  }[];
}

// ===========================================
// 配置
// ===========================================

const ALERT_CONFIG = {
  /** 告警颜色映射（Slack） */
  SEVERITY_COLORS: {
    info: '#36a64f',      // 绿色
    warning: '#ff9800',   // 橙色
    error: '#f44336',     // 红色
    critical: '#9c27b0',  // 紫色
  } as const,
  
  /** 告警 emoji 映射 */
  SEVERITY_EMOJI: {
    info: 'ℹ️',
    warning: '⚠️',
    error: '❌',
    critical: '🚨',
  } as const,
  
  /** 请求超时 */
  REQUEST_TIMEOUT: 10000,
} as const;

// ===========================================
// 告警发送器
// ===========================================

/**
 * 发送 Slack 告警
 */
async function sendSlackAlert(
  config: NonNullable<AlertConfig['slack']>,
  payload: AlertPayload
): Promise<{ success: boolean; error?: string }> {
  try {
    const emoji = ALERT_CONFIG.SEVERITY_EMOJI[payload.severity];
    const color = ALERT_CONFIG.SEVERITY_COLORS[payload.severity];
    
    const slackPayload = {
      channel: config.channel,
      username: config.username || 'NanoFlow Backup',
      icon_emoji: ':floppy_disk:',
      attachments: [
        {
          color,
          title: `${emoji} ${payload.title}`,
          text: payload.message,
          fields: payload.data ? Object.entries(payload.data).map(([key, value]) => ({
            title: key,
            value: String(value),
            short: true,
          })) : [],
          footer: 'NanoFlow Backup System',
          ts: Math.floor(Date.now() / 1000),
        },
      ],
    };
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ALERT_CONFIG.REQUEST_TIMEOUT);
    
    try {
      const response = await fetch(config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(slackPayload),
        signal: controller.signal,
      });
      
      if (!response.ok) {
        return { success: false, error: `Slack notification delivery failed (HTTP ${response.status})` };
      }
      
      return { success: true };
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown Slack error' 
    };
  }
}

/**
 * 发送 Email 告警（使用 Resend API）
 */
async function sendEmailAlert(
  config: NonNullable<AlertConfig['email']>,
  payload: AlertPayload
): Promise<{ success: boolean; error?: string }> {
  try {
    const emoji = ALERT_CONFIG.SEVERITY_EMOJI[payload.severity];
    
    // 构建 HTML 邮件内容
    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: ${ALERT_CONFIG.SEVERITY_COLORS[payload.severity]}; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
          .content { background: #f9fafb; padding: 20px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px; }
          .data-table { width: 100%; border-collapse: collapse; margin-top: 16px; }
          .data-table td { padding: 8px; border-bottom: 1px solid #e5e7eb; }
          .data-table td:first-child { font-weight: 600; width: 40%; }
          .footer { margin-top: 20px; font-size: 12px; color: #6b7280; text-align: center; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2 style="margin: 0;">${emoji} ${payload.title}</h2>
          </div>
          <div class="content">
            <p>${payload.message}</p>
            ${payload.data ? `
              <table class="data-table">
                ${Object.entries(payload.data).map(([key, value]) => `
                  <tr>
                    <td>${key}</td>
                    <td>${String(value)}</td>
                  </tr>
                `).join('')}
              </table>
            ` : ''}
          </div>
          <div class="footer">
            <p>NanoFlow Backup System • ${new Date().toISOString()}</p>
          </div>
        </div>
      </body>
      </html>
    `;
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ALERT_CONFIG.REQUEST_TIMEOUT);
    
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: config.from,
          to: config.to,
          subject: `[NanoFlow] ${emoji} ${payload.title}`,
          html: htmlContent,
        }),
        signal: controller.signal,
      });
      
      if (!response.ok) {
        return { success: false, error: `Email delivery failed (HTTP ${response.status})` };
      }
      
      return { success: true };
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown email error' 
    };
  }
}

// ===========================================
// 告警模板
// ===========================================

/**
 * 创建备份失败告警
 */
function createBackupFailedAlert(
  backupType: 'full' | 'incremental',
  error: string,
  details?: Record<string, unknown>
): AlertPayload {
  return {
    type: 'backup_failed',
    severity: 'error',
    title: `${backupType === 'full' ? '全量' : '增量'}备份失败`,
    message: `备份操作执行失败，请检查系统日志。\n\n错误信息：${error}`,
    data: {
      '备份类型': backupType === 'full' ? '全量备份' : '增量备份',
      '失败时间': new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
      ...details,
    },
  };
}

/**
 * 创建恢复完成通知
 */
function createRestoreCompletedAlert(
  restoreId: string,
  stats: { projectsRestored: number; tasksRestored: number; connectionsRestored: number },
  durationMs: number
): AlertPayload {
  return {
    type: 'restore_completed',
    severity: 'info',
    title: '数据恢复完成',
    message: '用户已成功恢复备份数据。',
    data: {
      '恢复 ID': restoreId,
      '恢复项目数': stats.projectsRestored,
      '恢复任务数': stats.tasksRestored,
      '恢复连接数': stats.connectionsRestored,
      '耗时': `${(durationMs / 1000).toFixed(2)} 秒`,
      '完成时间': new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    },
  };
}

/**
 * 创建存储容量预警
 */
function createStorageWarningAlert(
  usedBytes: number,
  totalBytes: number,
  thresholdPercent: number
): AlertPayload {
  const usedPercent = (usedBytes / totalBytes * 100).toFixed(1);
  const usedMB = (usedBytes / 1024 / 1024).toFixed(2);
  const totalMB = (totalBytes / 1024 / 1024).toFixed(2);
  
  return {
    type: 'storage_warning',
    severity: parseFloat(usedPercent) >= 90 ? 'critical' : 'warning',
    title: '备份存储空间不足',
    message: `备份存储使用率已达 ${usedPercent}%，请及时清理或扩容。`,
    data: {
      '当前使用': `${usedMB} MB`,
      '总容量': `${totalMB} MB`,
      '使用率': `${usedPercent}%`,
      '预警阈值': `${thresholdPercent}%`,
    },
  };
}

/**
 * 创建健康报告
 */
function createHealthReportAlert(stats: {
  totalBackups: number;
  completedBackups: number;
  failedBackups: number;
  totalSizeBytes: number;
  latestFullBackup: string | null;
  latestIncrementalBackup: string | null;
}): AlertPayload {
  const successRate = stats.totalBackups > 0 
    ? ((stats.completedBackups / stats.totalBackups) * 100).toFixed(1)
    : '100';
  const sizeMB = (stats.totalSizeBytes / 1024 / 1024).toFixed(2);
  
  return {
    type: 'health_report',
    severity: parseFloat(successRate) < 90 ? 'warning' : 'info',
    title: '备份系统健康报告',
    message: '以下是过去 24 小时的备份系统状态摘要。',
    data: {
      '总备份数': stats.totalBackups,
      '成功数': stats.completedBackups,
      '失败数': stats.failedBackups,
      '成功率': `${successRate}%`,
      '总存储': `${sizeMB} MB`,
      '最近全量备份': stats.latestFullBackup 
        ? new Date(stats.latestFullBackup).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
        : '无',
      '最近增量备份': stats.latestIncrementalBackup
        ? new Date(stats.latestIncrementalBackup).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
        : '无',
    },
  };
}

// ===========================================
// 主处理函数
// ===========================================

Deno.serve(async (req: Request) => {
  // CORS 预检（内部服务函数，仅允许白名单来源）
  const ALLOWED_ORIGINS = [
    'https://dde-eight.vercel.app',
    'https://nanoflow.app',
  ];
  const requestOrigin = req.headers.get('origin') || '';
  const corsOrigin = ALLOWED_ORIGINS.includes(requestOrigin)
    ? requestOrigin
    : ALLOWED_ORIGINS[0];

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Vary': 'Origin',
      },
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    // 验证授权（仅允许服务端调用）
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 解析请求
    const body = await req.json();
    const { action, ...params } = body;

    // 获取告警配置
    const alertConfig: AlertConfig = {
      slack: Deno.env.get('SLACK_WEBHOOK_URL') ? {
        webhookUrl: Deno.env.get('SLACK_WEBHOOK_URL')!,
        channel: Deno.env.get('SLACK_CHANNEL'),
        username: Deno.env.get('SLACK_USERNAME') || 'NanoFlow Backup',
      } : undefined,
      email: Deno.env.get('RESEND_API_KEY') ? {
        apiKey: Deno.env.get('RESEND_API_KEY')!,
        from: Deno.env.get('ALERT_EMAIL_FROM') || 'backup@nanoflow.app',
        to: (Deno.env.get('ALERT_EMAIL_TO') || '').split(',').filter(Boolean),
      } : undefined,
    };

    // 检查是否配置了任何告警通道
    if (!alertConfig.slack && !alertConfig.email) {
      console.warn('No alert channels configured');
      return new Response(JSON.stringify({ 
        success: true, 
        warning: 'No alert channels configured',
        channelResults: [],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let payload: AlertPayload;

    // 根据 action 构建告警
    switch (action) {
      case 'backup_failed':
        payload = createBackupFailedAlert(
          params.backupType || 'full',
          params.error || 'Unknown error',
          params.details
        );
        break;

      case 'restore_completed':
        payload = createRestoreCompletedAlert(
          params.restoreId || 'unknown',
          params.stats || { projectsRestored: 0, tasksRestored: 0, connectionsRestored: 0 },
          params.durationMs || 0
        );
        break;

      case 'storage_warning':
        payload = createStorageWarningAlert(
          params.usedBytes || 0,
          params.totalBytes || 500 * 1024 * 1024,
          params.thresholdPercent || 80
        );
        break;

      case 'health_report': {
        // 获取备份统计
        const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
        const supabase = createClient(supabaseUrl, supabaseKey);

        const { data: statsData } = await supabase.rpc('get_backup_stats');
        const stats = statsData?.[0] || {
          totalBackups: 0,
          completedBackups: 0,
          failedBackups: 0,
          totalSizeBytes: 0,
          latestFullBackup: null,
          latestIncrementalBackup: null,
        };

        payload = createHealthReportAlert(stats);
        break;
      }

      case 'custom':
        // 自定义告警
        if (!params.payload) {
          return new Response(JSON.stringify({ error: 'Missing payload for custom alert' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        payload = params.payload as AlertPayload;
        break;

      default:
        return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
    }

    // 确定要使用的通道
    const channels = payload.channels || ['slack', 'email'];
    const channelResults: AlertResult['channelResults'] = [];

    // 发送告警
    const sendPromises: Promise<void>[] = [];

    if (channels.includes('slack') && alertConfig.slack) {
      sendPromises.push(
        sendSlackAlert(alertConfig.slack, payload).then(result => {
          channelResults.push({ channel: 'slack', ...result });
        })
      );
    }

    if (channels.includes('email') && alertConfig.email && alertConfig.email.to.length > 0) {
      sendPromises.push(
        sendEmailAlert(alertConfig.email, payload).then(result => {
          channelResults.push({ channel: 'email', ...result });
        })
      );
    }

    await Promise.all(sendPromises);

    // 检查是否所有通道都成功
    const allSuccess = channelResults.every(r => r.success);
    const anySuccess = channelResults.some(r => r.success);

    // 记录告警日志
    console.log('Alert sent:', {
      type: payload.type,
      severity: payload.severity,
      title: payload.title,
      channelResults,
    });

    return new Response(JSON.stringify({
      success: anySuccess,
      allChannelsSuccess: allSuccess,
      channelResults,
    }), {
      status: anySuccess ? 200 : 500,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Alert function error:', error);
    return new Response(JSON.stringify({ 
      error: 'Internal alert processing error' 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
