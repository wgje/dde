import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import {
  AuthCallbackSessionService,
  type AuthCallbackOutcome,
} from '../../../services/auth-callback-session.service';

@Component({
  selector: 'app-auth-callback',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="min-h-screen grid place-items-center bg-gray-50 px-4 dark:bg-gray-950">
      <section class="w-full max-w-md text-center" aria-live="polite">
        <h1 class="text-2xl font-semibold text-gray-900 dark:text-white">NanoFlow</h1>
        @switch (outcome()) {
          @case ('loading') { <p class="mt-4 text-gray-600 dark:text-gray-300">正在确认登录...</p> }
          @case ('authenticated') { <p class="mt-4 text-green-700 dark:text-green-300">登录已确认</p> }
          @case ('conflict') { <p class="mt-4 text-gray-700 dark:text-gray-300">当前登录会话已保留</p> }
          @case ('cancelled') { <p class="mt-4 text-gray-700 dark:text-gray-300">登录确认已取消</p> }
          @default { <p class="mt-4 text-red-700 dark:text-red-300">登录链接无效或已过期</p> }
        }
      </section>
    </main>
  `,
})
export class AuthCallbackComponent implements OnInit, OnDestroy {
  private readonly callback = inject(AuthCallbackSessionService);
  private destroyed = false;
  readonly outcome = signal<AuthCallbackOutcome | 'loading'>('loading');

  async ngOnInit(): Promise<void> {
    const outcome = await this.callback.completeCapturedCallback();
    if (!this.destroyed) this.outcome.set(outcome);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.callback.cancel();
  }
}
