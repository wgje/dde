import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BootStageService } from './boot-stage.service';

describe('BootStageService', () => {
  let service: BootStageService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-25T10:00:00.000Z'));
    delete (window as Window & {
      __NANOFLOW_READY__?: boolean;
      __NANOFLOW_LAUNCH_SHELL_VISIBLE__?: boolean;
      __NANOFLOW_BOOT_STAGE__?: string;
    }).__NANOFLOW_READY__;
    delete (window as Window & {
      __NANOFLOW_READY__?: boolean;
      __NANOFLOW_LAUNCH_SHELL_VISIBLE__?: boolean;
      __NANOFLOW_BOOT_STAGE__?: string;
    }).__NANOFLOW_LAUNCH_SHELL_VISIBLE__;
    delete (window as Window & {
      __NANOFLOW_READY__?: boolean;
      __NANOFLOW_LAUNCH_SHELL_VISIBLE__?: boolean;
      __NANOFLOW_BOOT_STAGE__?: string;
    }).__NANOFLOW_BOOT_STAGE__;
    service = new BootStageService();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should advance monotonically and publish boot globals', () => {
    expect(service.currentStage()).toBe('booting');

    service.markLaunchShellVisible();
    expect(service.currentStage()).toBe('launch-shell');
    expect(window.__NANOFLOW_LAUNCH_SHELL_VISIBLE__).toBe(true);
    expect(window.__NANOFLOW_BOOT_STAGE__).toBe('launch-shell');

    service.markWorkspaceHandoffReady();
    expect(service.currentStage()).toBe('handoff');
    expect(window.__NANOFLOW_BOOT_STAGE__).toBe('handoff');

    service.markApplicationReady();
    expect(service.currentStage()).toBe('ready');
    expect(window.__NANOFLOW_READY__).toBe(true);
    expect(window.__NANOFLOW_BOOT_STAGE__).toBe('ready');

    service.markLaunchShellVisible();
    expect(service.currentStage()).toBe('ready');
  });

  it('should keep blankGapMs at zero when loader hides after launch shell is visible', () => {
    vi.advanceTimersByTime(120);
    service.markLaunchShellVisible();

    vi.advanceTimersByTime(80);
    service.noteLoaderHidden();

    expect(service.metrics().launchShellVisibleMs).toBe(120);
    expect(service.metrics().loaderHiddenMs).toBe(200);
    expect(service.metrics().blankGapMs).toBe(0);
  });

  it('should measure blankGapMs when loader hides before launch shell visibility', () => {
    vi.advanceTimersByTime(60);
    service.noteLoaderHidden();

    vi.advanceTimersByTime(140);
    service.markLaunchShellVisible();

    expect(service.metrics().loaderHiddenMs).toBe(60);
    expect(service.metrics().launchShellVisibleMs).toBe(200);
    expect(service.metrics().blankGapMs).toBe(140);
  });
});
