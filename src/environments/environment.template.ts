// 这是环境变量模板文件
// 复制此文件为 environment.ts 和 environment.development.ts
// 或运行 npm run config 自动从 .env.local 生成

export const environment = {
  production: false,
  supabaseUrl: 'YOUR_SUPABASE_URL',
  supabaseAnonKey: 'YOUR_SUPABASE_ANON_KEY',
  geminiApiKey: 'YOUR_GEMINI_API_KEY'  // 可选：AI 功能
};
