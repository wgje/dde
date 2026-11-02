import type { MigrationService } from '../../../services/migration.service';
import type { ProjectDataService } from './sync/project-data.service';
import { isMigrationCheckCurrent } from './app-auth-coordinator.helpers';

const MIGRATION_RETRY_DELAY_MS = 250;
const MAX_MIGRATION_RETRY_COUNT = 20;

export interface SuccessfulLoginOptions {
  closeSettings?: boolean;
  skipPostAuthNavigation?: boolean;
}

export interface AppAuthPostLoginControllerOptions {
  storeCurrentUserId: (userId: string) => void;
  loadPostAuthUserData: (userId: string, previousUserIdHint: string | null) => Promise<void>;
  isAuthSubmissionCurrent: (
    generation: number,
    allowedCurrentUserIds: readonly (string | null)[],
  ) => boolean;
  showLoginSuccess: () => void;
  nextMigrationGeneration: () => number;
  setReloginMode: (enabled: boolean) => void;
  finishSuccessfulLogin: (userId: string, options?: SuccessfulLoginOptions) => void;
  currentMigrationGeneration: () => number;
  currentUserId: () => string | null;
  localModeUserId: string;
  getMigrationService: () => Promise<MigrationService | null>;
  getProjectDataService: () => Promise<ProjectDataService | null>;
  warn: (message: string, error?: unknown) => void;
  showMigrationModal: () => void;
}

export class AppAuthPostLoginController {
  private pendingMigrationCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private migrationCheckRunToken = 0;

  constructor(private readonly options: AppAuthPostLoginControllerOptions) {}

  cancelPendingMigrationCheck(): void {
    this.migrationCheckRunToken += 1;
    this.clearPendingMigrationCheckTimer();
  }

  async initializeSuccessfulLoginSession(
    userId: string,
    previousUserIdHint: string | null,
    submissionGeneration: number,
    loginOptions?: SuccessfulLoginOptions,
  ): Promise<void> {
    if (!this.options.isAuthSubmissionCurrent(
      submissionGeneration,
      [previousUserIdHint, userId],
    )) {
      return;
    }

    this.options.storeCurrentUserId(userId);
    await this.options.loadPostAuthUserData(userId, previousUserIdHint);
    if (!this.options.isAuthSubmissionCurrent(
      submissionGeneration,
      [previousUserIdHint, userId],
    )) {
      return;
    }

    this.options.showLoginSuccess();
    const migrationGeneration = this.options.nextMigrationGeneration();
    const migrationRunToken = ++this.migrationCheckRunToken;
    this.options.setReloginMode(false);
    this.options.finishSuccessfulLogin(userId, loginOptions);
    this.scheduleMigrationCheck(userId, previousUserIdHint, migrationGeneration, migrationRunToken);
  }

  private isMigrationCurrent(userId: string | null, generation: number): boolean {
    return isMigrationCheckCurrent(
      generation,
      this.options.currentMigrationGeneration(),
      userId,
      this.options.currentUserId(),
      this.options.localModeUserId,
    );
  }

  private isMigrationRunCurrent(
    userId: string | null,
    generation: number,
    runToken: number,
  ): boolean {
    return runToken === this.migrationCheckRunToken
      && this.isMigrationCurrent(userId, generation);
  }

  private scheduleMigrationCheck(
    userId: string,
    previousUserIdHint: string | null,
    generation: number,
    runToken: number,
    retryCount = 0,
  ): void {
    this.clearPendingMigrationCheckTimer();
    const delayMs = retryCount === 0 ? 0 : MIGRATION_RETRY_DELAY_MS;
    this.pendingMigrationCheckTimer = setTimeout(() => {
      this.pendingMigrationCheckTimer = null;
      if (runToken !== this.migrationCheckRunToken) {
        return;
      }
      void this.checkMigrationAfterLogin(
        userId,
        previousUserIdHint,
        generation,
        runToken,
        retryCount,
      ).catch(error => {
        this.options.warn('登录后迁移检查失败，已跳过本次迁移提示', error);
      });
    }, delayMs);
  }

  private clearPendingMigrationCheckTimer(): void {
    if (this.pendingMigrationCheckTimer === null) {
      return;
    }
    clearTimeout(this.pendingMigrationCheckTimer);
    this.pendingMigrationCheckTimer = null;
  }

  private shouldRetryMigrationCheck(
    userId: string,
    previousUserIdHint: string | null,
    generation: number,
    runToken: number,
    retryCount: number,
  ): boolean {
    if (retryCount >= MAX_MIGRATION_RETRY_COUNT
      || runToken !== this.migrationCheckRunToken
      || generation !== this.options.currentMigrationGeneration()
      || userId === this.options.localModeUserId) {
      return false;
    }
    const currentUserId = this.options.currentUserId();
    return currentUserId === previousUserIdHint
      || (currentUserId === null && previousUserIdHint === null);
  }

  private async checkMigrationAfterLogin(
    userId: string,
    previousUserIdHint: string | null,
    generation: number,
    runToken: number,
    retryCount: number,
  ): Promise<void> {
    if (!this.isMigrationRunCurrent(userId, generation, runToken)) {
      if (this.shouldRetryMigrationCheck(userId, previousUserIdHint, generation, runToken, retryCount)) {
        this.scheduleMigrationCheck(
          userId,
          previousUserIdHint,
          generation,
          runToken,
          retryCount + 1,
        );
      }
      return;
    }

    const migrationService = await this.options.getMigrationService();
    if (!migrationService || !this.isMigrationRunCurrent(userId, generation, runToken)) return;

    const projectDataService = await this.options.getProjectDataService();
    if (!projectDataService || !this.isMigrationRunCurrent(userId, generation, runToken)) return;

    const remoteProjects = await projectDataService.loadProjectListMetadataFromCloud(userId);
    if (!this.isMigrationRunCurrent(userId, generation, runToken)) return;
    if (remoteProjects === null) {
      this.options.warn('登录后迁移检查无法确认云端项目，已跳过本次迁移提示');
      return;
    }

    if (migrationService.checkMigrationNeeded(remoteProjects)
      && this.isMigrationRunCurrent(userId, generation, runToken)) {
      this.options.showMigrationModal();
    }
  }
}
