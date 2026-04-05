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
  } = options;

  const devAutoLoginConfig = devAutoLogin
    ? `{ email: '${escapeString(devAutoLogin.email)}', password: '${escapeString(devAutoLogin.password)}' }`
    : 'null';

  return `// Auto-generated fallback for test/build bootstrap. Safe to regenerate.\n\nexport const environment = {\n  production: ${production ? 'true' : 'false'},\n  supabaseUrl: '${escapeString(supabaseUrl)}',\n  supabaseAnonKey: '${escapeString(supabaseAnonKey)}',\n  SENTRY_DSN: '${escapeString(sentryDsn)}',\n  gojsLicenseKey: '${escapeString(gojsLicenseKey)}',\n  devAutoLogin: ${production ? 'null' : `${devAutoLoginConfig} as { email: string; password: string } | null`}\n};\n`;
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