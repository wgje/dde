import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readText(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('android host contract', () => {
  it('declares the TWA launcher, bootstrap callback, and widget provider in the manifest', () => {
    const manifest = readText('android/app/src/main/AndroidManifest.xml');
    const build = readText('android/app/build.gradle.kts');

    expect(manifest).toContain('NanoflowTwaLauncherActivity');
    expect(manifest).toContain('NanoflowWidgetBootstrapActivity');
    expect(manifest).toContain('NanoflowWidgetReceiver');
    expect(manifest).toContain('android.support.customtabs.trusted.DEFAULT_URL');
    expect(manifest).toContain('android:scheme="nanoflow-widget"');
    expect(build).toContain('ANDROID_TWA_PACKAGE_NAME');
    expect(build).toContain('NANOFLOW_WEB_ORIGIN');
    expect(build).toContain('NG_APP_SUPABASE_URL');
    expect(build).toContain('androidbrowserhelper');
  });

  it('keeps widget launches on the TWA path without launcher watchdog fallback code', () => {
    const launcher = readText('android/app/src/main/java/app/nanoflow/host/NanoflowTwaLauncherActivity.kt');

    expect(launcher).toContain('class NanoflowTwaLauncherActivity : LauncherActivity()');
    expect(launcher).toContain('override fun shouldLaunchImmediately(): Boolean = false');
    expect(launcher).toContain('logLaunchStarted()');
    expect(launcher).toContain('launchTwa()');
    expect(launcher).toContain('widget_twa_launch_started');
    expect(launcher).not.toContain('widget_twa_launch_timeout');
    expect(launcher).not.toContain('widget_twa_cct_fallback_launching');
    expect(launcher).not.toContain('widget_twa_cct_fallback_failed');
    expect(launcher).not.toContain('CustomTabsIntent');
    expect(launcher).not.toContain('TWA_LAUNCH_TIMEOUT_MS');
    expect(launcher).not.toContain('scheduleLaunchWatchdog');
    expect(launcher).not.toContain('handleLaunchTimeout');
  });

  it('uses authenticated web bootstrap instead of native widget-register calls', () => {
    const contract = readText('android/app/src/main/java/app/nanoflow/host/NanoflowBootstrapContract.kt');
    const repository = readText('android/app/src/main/java/app/nanoflow/host/NanoflowWidgetRepository.kt');
    const bootstrapActivity = readText('android/app/src/main/java/app/nanoflow/host/NanoflowWidgetBootstrapActivity.kt');
    const bindingService = readText('src/services/widget-binding.service.ts');
    const workspaceShell = readText('src/workspace-shell.component.ts');

    expect(contract).toContain('PARAM_WIDGET_BOOTSTRAP');
    expect(contract).toContain('PARAM_CALLBACK_URI');
    expect(contract).toContain('PARAM_DEVICE_SECRET');
    expect(contract).toContain('PARAM_CLIENT_VERSION');
    expect(contract).toContain('PARAM_BOOTSTRAP_NONCE');
    expect(contract).toContain('PARAM_SUPABASE_URL');
    expect(contract).toContain('nanoflow-widget');
    expect(repository).toContain('buildLaunchUri');
    expect(repository).toContain('consumeBootstrapUri');
    expect(repository).toContain('widget_bootstrap_callback_accepted');
    expect(repository).toContain('widget_bootstrap_callback_rejected');
    expect(repository).not.toContain('widget-register');
    expect(bootstrapActivity).toContain('consumeBootstrapUri');
    expect(bindingService).toContain("platform: 'android-widget'");
    expect(bindingService).toContain('persistRuntimeBinding: false');
    expect(bindingService).toContain('callbackIntentUrl');
    expect(workspaceShell).toContain('resolveAndroidWidgetBootstrapRequest');
    expect(workspaceShell).toContain('completeAndroidWidgetBootstrap');
  });

  it('keeps Android dirty push handling compatible with both payload variants', () => {
    const messagingService = readText('android/app/src/main/java/app/nanoflow/host/NanoflowFirebaseMessagingService.kt');

    expect(messagingService).toContain('message.data["type"]');
    expect(messagingService).toContain('message.data["action"]');
    expect(messagingService).toContain('widget_dirty');
    expect(messagingService).toContain('widget-refresh');
  });
});
