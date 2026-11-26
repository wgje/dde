const STARTUP_BYPASS_PARAM = 'ngsw-bypass';
const STARTUP_RECOVERY_PARAM = 'nanoflow-startup-recovery';
const STARTUP_RECOVERY_VALUE = 'bypass-worker-v1';

export type StartupRecoveryDecision = 'navigate-bypass' | 'report-only';

type StartupUrlParseResult = { ok: true; url: URL } | { ok: false };

function safeParseStartupUrl(href: string): StartupUrlParseResult {
  let url: URL | null = null;
  try {
    url = new URL(href);
  } catch {
    url = null;
  }
  return url ? { ok: true, url } : { ok: false };
}

export function resolveStartupRecoveryDecision(href: string): StartupRecoveryDecision {
  const parsed = safeParseStartupUrl(href);
  if (!parsed.ok) return 'report-only';
  return parsed.url.searchParams.get(STARTUP_RECOVERY_PARAM) === STARTUP_RECOVERY_VALUE
    ? 'report-only'
    : 'navigate-bypass';
}

export function buildStartupWorkerBypassUrl(href: string): string | null {
  if (resolveStartupRecoveryDecision(href) !== 'navigate-bypass') return null;
  const parsed = safeParseStartupUrl(href);
  if (!parsed.ok) return null;
  parsed.url.searchParams.set(STARTUP_BYPASS_PARAM, '');
  parsed.url.searchParams.set(STARTUP_RECOVERY_PARAM, STARTUP_RECOVERY_VALUE);
  return parsed.url.href;
}
