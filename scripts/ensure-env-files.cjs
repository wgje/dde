const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

function escapeString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function buildEnvironmentContent(options) {
  const {
    production,
    supabaseUrl,
    supabaseAnonKey,
    sentryDsn,
    gojsLicenseKey,
    devAutoLogin,
    sentryEnvironment,
    canonicalOrigin,
    originGateMode,
    readOnlyPreview,
    deploymentTarget,
    supabaseProjectAlias,
    sentryRelease,
  } = options;

  const devAutoLoginConfig = devAutoLogin
    ? `{ email: '${escapeString(devAutoLogin.email)}', password: '${escapeString(devAutoLogin.password)}' }`
    : 'null';

  return `// Auto-generated fallback for test/build bootstrap. Safe to regenerate.\n\nexport const environment = {\n  production: ${production ? 'true' : 'false'},\n  supabaseUrl: '${escapeString(supabaseUrl)}',\n  supabaseAnonKey: '${escapeString(supabaseAnonKey)}',\n  SENTRY_DSN: '${escapeString(sentryDsn)}',\n  gojsLicenseKey: '${escapeString(gojsLicenseKey)}',\n  sentryEnvironment: '${escapeString(sentryEnvironment)}',\n  canonicalOrigin: '${escapeString(canonicalOrigin)}',\n  originGateMode: '${escapeString(originGateMode)}' as 'off' | 'redirect' | 'read-only' | 'export-only',\n  readOnlyPreview: ${readOnlyPreview ? 'true' : 'false'},\n  deploymentTarget: '${escapeString(deploymentTarget)}',\n  supabaseProjectAlias: '${escapeString(supabaseProjectAlias)}',\n  sentryRelease: '${escapeString(sentryRelease)}',\n  devAutoLogin: ${production ? 'null' : `${devAutoLoginConfig} as { email: string; password: string } | null`}\n};\n`;
}

function writeIfMissing(filePath, content, logs) {
  if (fs.existsSync(filePath)) {
    logs.push(`[ensure-env-files] preserved ${path.relative(process.cwd(), filePath)}`);
    return false;
  }

  fs.writeFileSync(filePath, content);
  logs.push(`[ensure-env-files] created ${path.relative(process.cwd(), filePath)}`);
  return true;
}

function ensureEnvFiles() {
  const envDir = path.resolve(__dirname, '../src/environments');
  const devPath = path.join(envDir, 'environment.development.ts');
  const prodPath = path.join(envDir, 'environment.ts');
  const envLocalPath = path.resolve(__dirname, '../.env.local');
  const localEnv = dotenv.config({ path: envLocalPath, quiet: true }).parsed || {};

  if (!fs.existsSync(envDir)) {
    fs.mkdirSync(envDir, { recursive: true });
  }

  const supabaseUrl = process.env.NG_APP_SUPABASE_URL || localEnv.NG_APP_SUPABASE_URL || 'YOUR_SUPABASE_URL';
  const supabaseAnonKey = process.env.NG_APP_SUPABASE_ANON_KEY || localEnv.NG_APP_SUPABASE_ANON_KEY || 'YOUR_SUPABASE_ANON_KEY';
  const sentryDsn = process.env.NG_APP_SENTRY_DSN || process.env.SENTRY_DSN || localEnv.NG_APP_SENTRY_DSN || localEnv.SENTRY_DSN || '';
  const gojsLicenseKey = process.env.NG_APP_GOJS_LICENSE_KEY || localEnv.NG_APP_GOJS_LICENSE_KEY || '';
  const devAutoLoginEmail = process.env.NG_APP_DEV_AUTO_LOGIN_EMAIL || localEnv.NG_APP_DEV_AUTO_LOGIN_EMAIL;
  const devAutoLoginPassword = process.env.NG_APP_DEV_AUTO_LOGIN_PASSWORD || localEnv.NG_APP_DEV_AUTO_LOGIN_PASSWORD;
  const devAutoLogin = devAutoLoginEmail && devAutoLoginPassword
    ? { email: devAutoLoginEmail, password: devAutoLoginPassword }
    : null;
  // Cloudflare 迁移注入（§16.7）— 默认值与生产 production fallback 一致
  const sentryEnvironment = process.env.NG_APP_SENTRY_ENVIRONMENT || localEnv.NG_APP_SENTRY_ENVIRONMENT || '';
  const canonicalOrigin = process.env.NG_APP_CANONICAL_ORIGIN || localEnv.NG_APP_CANONICAL_ORIGIN || '';
  const originGateMode = process.env.NG_APP_ORIGIN_GATE_MODE || localEnv.NG_APP_ORIGIN_GATE_MODE || 'off';
  const readOnlyPreview = ['1', 'true', 'yes', 'on'].includes(String(process.env.NG_APP_READ_ONLY_PREVIEW || localEnv.NG_APP_READ_ONLY_PREVIEW || '').toLowerCase());
  const deploymentTarget = process.env.NG_APP_DEPLOYMENT_TARGET || localEnv.NG_APP_DEPLOYMENT_TARGET || 'local';
  const supabaseProjectAlias = process.env.NG_APP_SUPABASE_PROJECT_ALIAS || localEnv.NG_APP_SUPABASE_PROJECT_ALIAS || 'local';
  const sentryRelease = process.env.NG_APP_SENTRY_RELEASE || localEnv.NG_APP_SENTRY_RELEASE || '';
  const logs = [];

  writeIfMissing(
    devPath,
    buildEnvironmentContent({
      production: false,
      supabaseUrl,
      supabaseAnonKey,
      sentryDsn,
      gojsLicenseKey,
      devAutoLogin,
      sentryEnvironment: sentryEnvironment || 'development',
      canonicalOrigin,
      originGateMode,
      readOnlyPreview,
      deploymentTarget,
      supabaseProjectAlias,
      sentryRelease,
    }),
    logs,
  );

  writeIfMissing(
    prodPath,
    buildEnvironmentContent({
      production: true,
      supabaseUrl,
      supabaseAnonKey,
      sentryDsn,
      gojsLicenseKey,
      devAutoLogin: null,
      sentryEnvironment: sentryEnvironment || 'production',
      canonicalOrigin,
      originGateMode,
      readOnlyPreview,
      deploymentTarget,
      supabaseProjectAlias,
      sentryRelease,
    }),
    logs,
  );

  for (const line of logs) {
    console.log(line);
  }
}

module.exports = { ensureEnvFiles };

if (require.main === module) {
  ensureEnvFiles();
}