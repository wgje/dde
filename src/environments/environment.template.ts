// 环境变量类型定义模板文件
// 实际环境文件由 npm run config (scripts/set-env.cjs) 从 .env.local 自动生成
// 请勿手动编辑 environment.ts 和 environment.development.ts
//
// 使用方法：
// 1. 复制项目根目录的 .env.template 为 .env.local
// 2. 在 .env.local 中填入你的实际配置值
// 3. 运行 npm run config 生成环境文件
//
// 环境变量说明：
// - NG_APP_SUPABASE_URL: Supabase 项目 URL（必需）
// - NG_APP_SUPABASE_ANON_KEY: Supabase 匿名密钥（必需）
// - NG_APP_SENTRY_DSN: Sentry 错误监控 DSN（可选）
// - NG_APP_GOJS_LICENSE_KEY: GoJS 许可证（可选，移除水印）
// - NG_APP_DEV_AUTO_LOGIN_EMAIL: 开发环境自动登录邮箱（可选）
// - NG_APP_DEV_AUTO_LOGIN_PASSWORD: 开发环境自动登录密码（可选）

export const environment = {
  production: false,
  supabaseUrl: 'YOUR_SUPABASE_URL',
  supabaseAnonKey: 'YOUR_SUPABASE_ANON_KEY',
  sentryDsn: '',
  gojsLicenseKey: '',
  devAutoLogin: null as { email: string; password: string } | null
};
