type SignOutPhase = 'preparing' | 'pending';

export type ExplicitSignOutRevocation = (() => Promise<void>) & {
  isCurrent(): boolean;
};

interface ExplicitSignOutFlight {
  readonly token: number;
  readonly promise: Promise<boolean>;
  phase: SignOutPhase;
  readonly identityFence: string;
  readonly signedOutUserId: string | null;
  readonly commitRevocation: ExplicitSignOutRevocation;
}

export interface AuthExplicitSignOutContext {
  isConfigured(): boolean;
  ensureRuntimeAuthReady(): Promise<void>;
  hasActiveAuthListener(): boolean;
  hasCurrentAuthClient(): boolean;
  captureOwnerFence(): string;
  currentUserId(): string | null;
  captureRevocation(): ExplicitSignOutRevocation;
  signOutRemote(): Promise<void>;
  finalize(
    signedOutUserId: string | null,
    commitRevocation: ExplicitSignOutRevocation,
    isCurrent: () => boolean,
  ): Promise<boolean>;
  warn(message: string, error: unknown): void;
}

export class AuthExplicitSignOutController {
  private token = 0;
  private flight: ExplicitSignOutFlight | null = null;

  constructor(private readonly context: AuthExplicitSignOutContext) {}

  signOut(): Promise<boolean> {
    if (this.flight) return this.flight.promise;
    const token = ++this.token;
    const flight: ExplicitSignOutFlight = {
      token,
      promise: Promise.resolve()
        .then(() => this.run(flight))
        .finally(() => {
          if (this.flight === flight) this.flight = null;
        }),
      phase: 'preparing',
      identityFence: this.context.captureOwnerFence(),
      signedOutUserId: this.context.currentUserId(),
      commitRevocation: this.context.captureRevocation(),
    };
    this.flight = flight;
    return flight.promise;
  }

  observeSignedOut(): boolean {
    const flight = this.flight;
    if (!flight || !this.isCurrent(flight) || flight.phase !== 'pending') return false;
    return true;
  }

  reset(): void {
    this.token += 1;
    this.flight = null;
  }

  private async run(flight: ExplicitSignOutFlight): Promise<boolean> {
    await this.context.ensureRuntimeAuthReady();
    if (!this.isCurrentBoundary(flight)) return false;
    if (
      this.context.isConfigured()
      && (!this.context.hasActiveAuthListener() || !this.context.hasCurrentAuthClient())
    ) {
      throw new Error('AUTH_SIGN_OUT_LISTENER_UNAVAILABLE');
    }

    flight.phase = 'pending';

    let remoteError: unknown;
    try {
      if (this.context.isConfigured()) await this.context.signOutRemote();
    } catch (error) {
      remoteError = error;
    }

    if (!this.isCurrentBoundary(flight)) {
      return false;
    }
    if (remoteError) {
      this.context.warn('Supabase signOut failed', remoteError);
      throw remoteError;
    }
    const settlementRevocation = this.context.captureRevocation();
    if (!flight.commitRevocation.isCurrent() || !settlementRevocation.isCurrent()) return false;
    return await this.context.finalize(
      flight.signedOutUserId,
      settlementRevocation,
      () => this.isCurrentIdentity(flight),
    );
  }

  private isCurrent(flight: ExplicitSignOutFlight): boolean {
    return this.flight === flight && flight.token === this.token;
  }

  private isCurrentBoundary(flight: ExplicitSignOutFlight): boolean {
    return this.isCurrentIdentity(flight)
      && flight.commitRevocation.isCurrent();
  }

  private isCurrentIdentity(flight: ExplicitSignOutFlight): boolean {
    return this.isCurrent(flight)
      && this.context.captureOwnerFence() === flight.identityFence;
  }

}
