import type { WorkspaceShellSignalEffectRegistrarController } from './workspace-shell-signal-effect-registrar.controller';

export interface WorkspaceShellStartupTierSignalEffectsControllerOptions {
  effectRegistrar: WorkspaceShellSignalEffectRegistrarController;
  currentUserId: () => string | null;
  coreDataLoaded: () => boolean;
  isStartupTierReady: (tier: 'p1' | 'p2') => boolean;
  startupTierHydration: {
    markAuthReadyIfReady(): void;
    warmupInteractionIfReady(): void;
    startSyncHydrationIfReady(): void;
  };
}

export class WorkspaceShellStartupTierSignalEffectsController {
  constructor(
    private readonly options: WorkspaceShellStartupTierSignalEffectsControllerOptions,
  ) {}

  setup(): void {
    this.options.effectRegistrar.register('startup-tier-auth-ready', () => {
      this.options.currentUserId();
      this.options.coreDataLoaded();
      this.options.startupTierHydration.markAuthReadyIfReady();
    });

    this.options.effectRegistrar.register('startup-tier-p1', () => {
      this.options.isStartupTierReady('p1');
      this.options.startupTierHydration.warmupInteractionIfReady();
    });

    this.options.effectRegistrar.register('startup-tier-p2', () => {
      this.options.isStartupTierReady('p2');
      this.options.startupTierHydration.startSyncHydrationIfReady();
    });
  }
}
