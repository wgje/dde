const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// 优先读取 .env.local，其次读取进程环境（方便 Vercel/Supabase 等 CI 环境）
const localEnv = dotenv.config({ path: path.resolve(__dirname, '../.env.local') }).parsed || {};
const supabaseUrl = process.env.NG_APP_SUPABASE_URL || localEnv.NG_APP_SUPABASE_URL;
const supabaseAnonKey = process.env.NG_APP_SUPABASE_ANON_KEY || localEnv.NG_APP_SUPABASE_ANON_KEY;
const geminiApiKey = process.env.GEMINI_API_KEY || localEnv.GEMINI_API_KEY;

// 如果没有配置 Supabase 环境变量，使用占位符（应用将以离线模式运行）
const useOfflineMode = !supabaseUrl || !supabaseAnonKey;
if (useOfflineMode) {
  console.warn('⚠️ 未找到 Supabase 环境变量，将生成离线模式配置文件。');
  console.warn('   如需云端同步功能，请在 .env.local 中设置 NG_APP_SUPABASE_URL 和 NG_APP_SUPABASE_ANON_KEY');
}

const targetPath = path.resolve(__dirname, '../src/environments/environment.development.ts');
const targetPathProd = path.resolve(__dirname, '../src/environments/environment.ts');

// 离线模式使用占位符
const finalUrl = supabaseUrl || 'YOUR_SUPABASE_URL';
const finalKey = supabaseAnonKey || 'YOUR_SUPABASE_ANON_KEY';
const finalGeminiKey = geminiApiKey || 'YOUR_GEMINI_API_KEY';

const devEnvContent = `// 此文件由 scripts/set-env.cjs 自动生成，请勿手动编辑
// 已添加到 .gitignore，不会被提交到代码仓库

export const environment = {
  production: false,
  supabaseUrl: '${finalUrl}',
  supabaseAnonKey: '${finalKey}',
  geminiApiKey: '${finalGeminiKey}'
};
`;

const prodEnvContent = `// 此文件由 scripts/set-env.cjs 自动生成，请勿手动编辑
// 已添加到 .gitignore，不会被提交到代码仓库

export const environment = {
  production: true,
  supabaseUrl: '${finalUrl}',
  supabaseAnonKey: '${finalKey}',
  geminiApiKey: '${finalGeminiKey}'
};
`;

fs.writeFileSync(targetPath, devEnvContent);
fs.writeFileSync(targetPathProd, prodEnvContent);

console.log(`✅ 环境变量已写入:`);
console.log(`   - ${targetPath} (development)`);
console.log(`   - ${targetPathProd} (production)`);

