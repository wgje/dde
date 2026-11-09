import { Injectable, inject } from '@angular/core';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';

import { environment } from '../environments/environment';
import { LoggerService } from './logger.service';
import { validateSupabaseConfiguration } from './supabase-client-configuration';
import {
  SupabaseClientOptionsFactoryService,
  type PasswordRecoveryStorage,
} from './supabase-client-options-factory.service';

type RecoveryState =
  | 'preparing'
  | 'issued'
  | 'claimed'
  | 'session-ready'
  | 'updating'
  | 'signing-out'
  | 'terminal';

type RecoveryPayload =
  | { kind: 'implicit'; accessToken: string; refreshToken: string }
  | { kind: 'pkce'; code: string };

interface RecoveryLedger {
  version: 1;
  nonce: string;
  requestStorageKey: string;
  state: RecoveryState;
  issuedAt: number;
  expiresAt: number;
  attemptId?: string;
  tabId?: string;
  capabilityDigest?: string;
  sessionDigest?: string;
  cleanupPending?: boolean;
}

interface RecoveryEnvelope {
  version: 1;
  nonce: string;
  attemptId: string;
  tabId: string;
  capability: string;
  storageKey: string;
  payload: RecoveryPayload;
}

interface ActiveRecoveryAttempt {
  generation: number;
  nonce: string;
  attemptId: string;
  tabId: string;
  capability: string;
  capabilityDigest: string;
  storageKey: string;
  client: SupabaseClient;
  sessionDigest: string;
}

export interface AuthPasswordRecoveryCompletion {
  cleanupPending: boolean;
}

const RECOVERY_PREFIX = 'nanoflow:auth-recovery:v1:';
const ACTIVE_ATTEMPT_KEY = `${RECOVERY_PREFIX}active`;
const REQUEST_TTL_MS = 60 * 60 * 1000;
const TOMBSTONE_TTL_MS = 10 * 60 * 1000;

class PasswordRecoveryError extends Error {}

@Injectable({
  providedIn: 'root',
})
export class AuthPasswordRecoveryService {
  private readonly optionsFactory = inject(SupabaseClientOptionsFactoryService);
  private readonly logger = inject(LoggerService).category('AuthPasswordRecovery');
  private activeAttempt: ActiveRecoveryAttempt | null = null;
  private generation = 0;

  async requestPasswordReset(email: string, origin: string): Promise<void> {
    this.requirePrerequisites();
    this.requireConfiguration();
    const nonce = this.randomId();
    const requestStorageKey = this.requestStorageKey(nonce);
    const now = Date.now();
    const ledger: RecoveryLedger = {
      version: 1,
      nonce,
      requestStorageKey,
      state: 'preparing',
      issuedAt: now,
      expiresAt: now + REQUEST_TTL_MS,
    };

    await this.withNonceLock(nonce, () => {
      if (localStorage.getItem(this.ledgerKey(nonce)) !== null) {
        throw new PasswordRecoveryError('AUTH_RECOVERY_NONCE_COLLISION');
      }
      localStorage.setItem(this.ledgerKey(nonce), JSON.stringify(ledger));
    });

    const client = this.createRecoveryClient(requestStorageKey, localStorage);
    let completed = false;
    try {
      const redirect = new URL('/', origin);
      redirect.hash = `/reset-password?${new URLSearchParams({ recovery_nonce: nonce })}`;
      const { error } = await client.auth.resetPasswordForEmail(email, {
        redirectTo: redirect.toString(),
      });
      if (error) throw error;

      await this.withNonceLock(nonce, () => {
        const current = this.requireLedger(nonce, 'preparing');
        const verifier = localStorage.getItem(`${requestStorageKey}-code-verifier`);
        if (!verifier) {
          throw new PasswordRecoveryError('AUTH_RECOVERY_VERIFIER_MISSING');
        }
        localStorage.setItem(this.ledgerKey(nonce), JSON.stringify({
          ...current,
          state: 'issued',
        } satisfies RecoveryLedger));
      });
      completed = true;
    } finally {
      await client.auth.dispose();
      if (!completed) {
        await this.removeIssuedRequest(nonce, requestStorageKey);
      }
    }
  }

  async prepareFromCurrentUrl(): Promise<boolean> { // eslint-disable-line complexity, max-lines-per-function -- ordered recovery claim and SDK continuation fencing must remain one visible transaction flow
    this.requirePrerequisites();
    this.requireConfiguration();
    const parsed = this.parseCurrentCallback();
    const previous = this.activeAttempt;
    const generation = ++this.generation;
    this.activeAttempt = null;
    if (previous) await previous.client.auth.dispose().catch(() => undefined);

    let resume: Awaited<ReturnType<typeof this.migrateOwnedAttempt>>;
    let envelope: RecoveryEnvelope;
    let capabilityDigest: string;

    try {
      resume = await this.migrateOwnedAttempt(parsed?.nonce);
      if (resume) {
        ({ envelope, capabilityDigest } = resume);
      } else {
        if (!parsed) return false;
        const attemptId = this.randomId();
        const capability = this.randomId();
        envelope = {
          version: 1,
          nonce: parsed.nonce,
          attemptId,
          tabId: this.randomId(),
          capability,
          storageKey: this.attemptStorageKey(parsed.nonce, attemptId),
          payload: parsed.payload,
        };
        capabilityDigest = await this.digest(capability);
        await this.claimAttempt(envelope, capabilityDigest);
      }
    } catch (error) {
      if (error instanceof PasswordRecoveryError) return false;
      throw error;
    }

    const client = this.createRecoveryClient(envelope.storageKey, sessionStorage);
    let active: ActiveRecoveryAttempt | null = null;
    try {
      if (!resume?.skipExchange) {
        const response = envelope.payload.kind === 'pkce'
          ? await client.auth.exchangeCodeForSession(envelope.payload.code)
          : await client.auth.setSession({
            access_token: envelope.payload.accessToken,
            refresh_token: envelope.payload.refreshToken,
          });
        this.requireGeneration(generation);
        await this.requireEnvelopeCurrent(envelope, capabilityDigest, 'claimed');
        if (response.error || !response.data.session) {
          throw response.error ?? new PasswordRecoveryError('AUTH_RECOVERY_SESSION_MISSING');
        }
      }

      const { data, error } = await client.auth.getSession();
      this.requireGeneration(generation);
      if (error || !data.session) {
        throw error ?? new PasswordRecoveryError('AUTH_RECOVERY_SESSION_MISSING');
      }
      const sessionDigest = await this.digestSession(data.session);
      this.requireGeneration(generation);
      if (resume?.sessionDigest && resume.sessionDigest !== sessionDigest) {
        throw new PasswordRecoveryError('AUTH_RECOVERY_SESSION_CHANGED');
      }
      if (!resume || resume.state === 'claimed') {
        await this.markSessionReady(envelope, capabilityDigest, sessionDigest);
      } else {
        await this.requireEnvelopeCurrent(envelope, capabilityDigest, 'session-ready');
      }
      this.requireGeneration(generation);

      active = {
        generation,
        nonce: envelope.nonce,
        attemptId: envelope.attemptId,
        tabId: envelope.tabId,
        capability: envelope.capability,
        capabilityDigest,
        storageKey: envelope.storageKey,
        client,
        sessionDigest,
      };
      this.activeAttempt = active;
      this.scrubRecoveryUrl();
      return true;
    } catch (error) {
      if (this.generation === generation) {
        await this.markTerminal(envelope, capabilityDigest, true);
      }
      await client.auth.dispose();
      if (error instanceof PasswordRecoveryError) return false;
      throw error;
    } finally {
      if (!active && this.activeAttempt?.generation === generation) {
        this.activeAttempt = null;
      }
    }
  }

  async completePasswordReset(password: string): Promise<AuthPasswordRecoveryCompletion> {
    const attempt = this.requireActiveAttempt();
    await this.revalidateSession(attempt);
    await this.advanceAttempt(attempt, 'session-ready', 'updating');

    let update: Awaited<ReturnType<typeof attempt.client.auth.updateUser>>;
    try {
      update = await attempt.client.auth.updateUser({ password });
    } catch {
      this.requireCurrent(attempt);
      await this.settleAttempt(attempt, true);
      throw new PasswordRecoveryError('AUTH_RECOVERY_UPDATE_OUTCOME_UNKNOWN');
    }
    this.requireCurrent(attempt);
    if (update.error) throw update.error;

    await this.advanceAttempt(attempt, 'updating', 'signing-out');
    let cleanupPending = false;
    try {
      await this.revalidateSession(attempt);
      const { error } = await attempt.client.auth.signOut({ scope: 'local' });
      this.requireCurrent(attempt);
      cleanupPending = Boolean(error);
    } catch {
      this.requireCurrent(attempt);
      cleanupPending = true;
    }

    await this.settleAttempt(attempt, cleanupPending);
    return { cleanupPending };
  }

  async dispose(): Promise<void> {
    const attempt = this.activeAttempt;
    ++this.generation;
    this.activeAttempt = null;
    if (!attempt) return;

    await this.markTerminalForActive(attempt, true).catch(() => undefined);
    this.removeAttemptStorage(attempt.storageKey, attempt);
    await attempt.client.auth.dispose().catch(() => undefined);
  }

  private async claimAttempt(
    envelope: RecoveryEnvelope,
    capabilityDigest: string,
  ): Promise<void> {
    await this.withNonceLock(envelope.nonce, () => {
      const ledger = this.requireLedger(envelope.nonce, 'issued');
      if (ledger.expiresAt <= Date.now()) {
        throw new PasswordRecoveryError('AUTH_RECOVERY_EXPIRED');
      }
      const verifierKey = `${ledger.requestStorageKey}-code-verifier`;
      const verifier = localStorage.getItem(verifierKey);
      if (envelope.payload.kind === 'pkce' && !verifier) {
        throw new PasswordRecoveryError('AUTH_RECOVERY_VERIFIER_MISSING');
      }

      sessionStorage.setItem(this.envelopeKey(envelope.storageKey), JSON.stringify(envelope));
      if (verifier) sessionStorage.setItem(`${envelope.storageKey}-code-verifier`, verifier);
      sessionStorage.setItem(ACTIVE_ATTEMPT_KEY, JSON.stringify(envelope));
      localStorage.setItem(this.ledgerKey(envelope.nonce), JSON.stringify({
        ...ledger,
        state: 'claimed',
        attemptId: envelope.attemptId,
        tabId: envelope.tabId,
        capabilityDigest,
      } satisfies RecoveryLedger));
      localStorage.removeItem(verifierKey);
    });
  }

  private async migrateOwnedAttempt(expectedNonce?: string) { // eslint-disable-line max-lines-per-function -- crash-safe envelope-to-ledger migration ordering is intentionally contiguous
    const previous = this.readEnvelope(ACTIVE_ATTEMPT_KEY);
    if (!previous || (expectedNonce && previous.nonce !== expectedNonce)) return null;
    const previousDigest = await this.digest(previous.capability);
    const capability = this.randomId();
    const attemptId = this.randomId();
    const next: RecoveryEnvelope = {
      ...previous,
      attemptId,
      tabId: this.randomId(),
      capability,
      storageKey: this.attemptStorageKey(previous.nonce, attemptId),
    };
    const capabilityDigest = await this.digest(capability);
    const snapshot = this.readStorageTriplet(sessionStorage, previous.storageKey);

    return await this.withNonceLock(previous.nonce, () => {
      const ledger = this.readLedger(previous.nonce);
      if (ledger?.state === 'issued') {
        this.removeStorageTriplet(sessionStorage, previous.storageKey);
        sessionStorage.removeItem(this.envelopeKey(previous.storageKey));
        const active = this.readEnvelope(ACTIVE_ATTEMPT_KEY);
        if (active?.attemptId === previous.attemptId && active.capability === previous.capability) {
          sessionStorage.removeItem(ACTIVE_ATTEMPT_KEY);
        }
        return null;
      }
      const state = ledger?.state;
      if (
        !ledger
        || (state !== 'claimed' && state !== 'session-ready')
        || ledger.expiresAt <= Date.now()
        || !this.isEnvelopeOwner(ledger, previous, previousDigest)
        || JSON.stringify(snapshot) !== JSON.stringify(
          this.readStorageTriplet(sessionStorage, previous.storageKey),
        )
      ) {
        throw new PasswordRecoveryError('AUTH_RECOVERY_OWNER_MISMATCH');
      }
      const hasSession = snapshot[0] !== null;
      if ((state === 'session-ready' && (!hasSession || !ledger.sessionDigest))
        || (!hasSession && previous.payload.kind === 'pkce' && snapshot[1] === null)) {
        throw new PasswordRecoveryError('AUTH_RECOVERY_PERSISTED_SESSION_MISSING');
      }
      sessionStorage.setItem(this.envelopeKey(next.storageKey), JSON.stringify(next));
      this.writeStorageTriplet(sessionStorage, next.storageKey, snapshot);
      sessionStorage.setItem(ACTIVE_ATTEMPT_KEY, JSON.stringify(next));
      localStorage.setItem(this.ledgerKey(previous.nonce), JSON.stringify({
        ...ledger,
        attemptId: next.attemptId,
        tabId: next.tabId,
        capabilityDigest,
      } satisfies RecoveryLedger));
      localStorage.removeItem(`${ledger.requestStorageKey}-code-verifier`);
      this.removeStorageTriplet(sessionStorage, previous.storageKey);
      sessionStorage.removeItem(this.envelopeKey(previous.storageKey));
      return { envelope: next, capabilityDigest, state, sessionDigest: ledger.sessionDigest, skipExchange: hasSession };
    });
  }

  private async markSessionReady(
    envelope: RecoveryEnvelope,
    capabilityDigest: string,
    sessionDigest: string,
  ): Promise<void> {
    await this.withNonceLock(envelope.nonce, () => {
      const ledger = this.requireOwnedLedger(envelope, capabilityDigest, 'claimed');
      if (!sessionStorage.getItem(envelope.storageKey)) {
        throw new PasswordRecoveryError('AUTH_RECOVERY_PERSISTED_SESSION_MISSING');
      }
      localStorage.setItem(this.ledgerKey(envelope.nonce), JSON.stringify({
        ...ledger,
        state: 'session-ready',
        sessionDigest,
      } satisfies RecoveryLedger));
    });
  }

  private async requireEnvelopeCurrent(
    envelope: RecoveryEnvelope,
    capabilityDigest: string,
    state: RecoveryState,
  ): Promise<void> {
    await this.withNonceLock(envelope.nonce, () => {
      this.requireOwnedLedger(envelope, capabilityDigest, state);
    });
  }

  private async revalidateSession(attempt: ActiveRecoveryAttempt): Promise<void> {
    this.requireCurrent(attempt);
    const { data, error } = await attempt.client.auth.getSession();
    this.requireCurrent(attempt);
    if (error || !data.session) {
      throw error ?? new PasswordRecoveryError('AUTH_RECOVERY_SESSION_MISSING');
    }
    const digest = await this.digestSession(data.session);
    this.requireCurrent(attempt);
    if (digest !== attempt.sessionDigest) {
      throw new PasswordRecoveryError('AUTH_RECOVERY_SESSION_CHANGED');
    }
  }

  private async advanceAttempt(
    attempt: ActiveRecoveryAttempt,
    expected: RecoveryState,
    next: RecoveryState,
  ): Promise<void> {
    this.requireCurrent(attempt);
    await this.withNonceLock(attempt.nonce, () => {
      const ledger = this.requireActiveLedger(attempt, expected);
      localStorage.setItem(this.ledgerKey(attempt.nonce), JSON.stringify({
        ...ledger,
        state: next,
      } satisfies RecoveryLedger));
    });
    this.requireCurrent(attempt);
  }

  private markTerminalForActive(attempt: ActiveRecoveryAttempt, cleanupPending: boolean) {
    return this.markTerminalLedger(attempt.nonce, ledger => this.isLedgerOwnedBy(ledger, attempt), cleanupPending);
  }

  private markTerminal(envelope: RecoveryEnvelope, capabilityDigest: string, cleanupPending: boolean) {
    return this.markTerminalLedger(
      envelope.nonce, ledger => this.isEnvelopeOwner(ledger, envelope, capabilityDigest), cleanupPending,
    );
  }

  private async markTerminalLedger(
    nonce: string,
    owns: (ledger: RecoveryLedger) => boolean,
    cleanupPending: boolean,
  ): Promise<void> {
    await this.withNonceLock(nonce, () => {
      const ledger = this.readLedger(nonce);
      if (!ledger || !owns(ledger)) return;
      localStorage.setItem(this.ledgerKey(nonce), JSON.stringify({
        ...ledger,
        state: 'terminal',
        cleanupPending,
        expiresAt: Date.now() + TOMBSTONE_TTL_MS,
      } satisfies RecoveryLedger));
    });
  }

  private async settleAttempt(attempt: ActiveRecoveryAttempt, cleanupPending: boolean): Promise<void> {
    await this.markTerminalForActive(attempt, cleanupPending);
    this.requireCurrent(attempt);
    this.removeAttemptStorage(attempt.storageKey, attempt);
    await attempt.client.auth.dispose();
    this.requireCurrent(attempt);
    this.activeAttempt = null;
    this.scrubRecoveryUrl();
  }

  private async removeIssuedRequest(nonce: string, requestStorageKey: string): Promise<void> {
    await this.withNonceLock(nonce, () => {
      const ledger = this.readLedger(nonce);
      if (ledger?.requestStorageKey !== requestStorageKey) return;
      localStorage.removeItem(this.ledgerKey(nonce));
      this.removeStorageTriplet(localStorage, requestStorageKey);
    });
  }

  private createRecoveryClient(storageKey: string, storage: PasswordRecoveryStorage): SupabaseClient {
    const scopedStorage = this.optionsFactory.buildPasswordRecoveryStorage(storageKey, storage);
    return createClient(
      environment.supabaseUrl,
      environment.supabaseAnonKey,
      this.optionsFactory.buildPasswordRecoveryClientOptions(storageKey, scopedStorage),
    );
  }

  private requireConfiguration(): void {
    const result = validateSupabaseConfiguration(
      environment.supabaseUrl,
      environment.supabaseAnonKey,
      environment.production,
      this.logger,
    );
    if (result.blocked) {
      throw new PasswordRecoveryError('AUTH_RECOVERY_CONFIGURATION_UNAVAILABLE');
    }
  }

  private requirePrerequisites(): void {
    if (typeof window === 'undefined') {
      throw new PasswordRecoveryError('AUTH_RECOVERY_BROWSER_UNAVAILABLE');
    }
    if (!navigator.locks) {
      throw new PasswordRecoveryError('AUTH_RECOVERY_LOCK_UNAVAILABLE');
    }
    if (!globalThis.crypto?.getRandomValues || !globalThis.crypto.subtle) {
      throw new PasswordRecoveryError('AUTH_RECOVERY_CRYPTO_UNAVAILABLE');
    }
    try {
      void localStorage.length;
      void sessionStorage.length;
    } catch {
      throw new PasswordRecoveryError('AUTH_RECOVERY_STORAGE_UNAVAILABLE');
    }
  }

  private parseCurrentCallback(): { nonce: string; payload: RecoveryPayload } | null {
    const url = new URL(window.location.href);
    const hashRoute = url.hash.startsWith('#/') ? url.hash.slice(1) : null;
    const hashRouteQueryIndex = hashRoute?.indexOf('?') ?? -1;
    const hashRouteParams = hashRouteQueryIndex >= 0
      ? new URLSearchParams(hashRoute?.slice(hashRouteQueryIndex + 1))
      : null;
    const nonce = url.searchParams.get('recovery_nonce')
      ?? hashRouteParams?.get('recovery_nonce');
    if (!nonce) return null;
    const code = url.searchParams.get('code') ?? hashRouteParams?.get('code');
    if (code) return { nonce, payload: { kind: 'pkce', code } };

    const hash = hashRouteParams ?? new URLSearchParams(url.hash.replace(/^#/, ''));
    const accessToken = hash.get('access_token');
    const refreshToken = hash.get('refresh_token');
    if (hash.get('type') !== 'recovery' || !accessToken || !refreshToken) return null;
    return { nonce, payload: { kind: 'implicit', accessToken, refreshToken } };
  }

  private requireLedger(nonce: string, state: RecoveryState): RecoveryLedger {
    const ledger = this.readLedger(nonce);
    if (!ledger || ledger.state !== state) {
      throw new PasswordRecoveryError('AUTH_RECOVERY_STATE_MISMATCH');
    }
    return ledger;
  }

  private requireOwnedLedger(
    envelope: RecoveryEnvelope,
    capabilityDigest: string,
    state: RecoveryState,
  ): RecoveryLedger {
    const ledger = this.requireLedger(envelope.nonce, state);
    if (!this.isEnvelopeOwner(ledger, envelope, capabilityDigest)) {
      throw new PasswordRecoveryError('AUTH_RECOVERY_OWNER_MISMATCH');
    }
    return ledger;
  }

  private requireActiveLedger(
    attempt: ActiveRecoveryAttempt,
    state: RecoveryState,
  ): RecoveryLedger {
    const ledger = this.requireLedger(attempt.nonce, state);
    if (!this.isLedgerOwnedBy(ledger, attempt) || ledger.sessionDigest !== attempt.sessionDigest) {
      throw new PasswordRecoveryError('AUTH_RECOVERY_OWNER_MISMATCH');
    }
    return ledger;
  }

  private isEnvelopeOwner(
    ledger: RecoveryLedger,
    envelope: RecoveryEnvelope,
    capabilityDigest: string,
  ): boolean {
    return ledger.attemptId === envelope.attemptId
      && ledger.tabId === envelope.tabId
      && ledger.capabilityDigest === capabilityDigest;
  }

  private isLedgerOwnedBy(ledger: RecoveryLedger, attempt: ActiveRecoveryAttempt): boolean {
    return ledger.attemptId === attempt.attemptId
      && ledger.tabId === attempt.tabId
      && ledger.capabilityDigest === attempt.capabilityDigest;
  }

  private readLedger(nonce: string): RecoveryLedger | null {
    const raw = localStorage.getItem(this.ledgerKey(nonce));
    if (!raw) return null;
    try {
      const ledger = JSON.parse(raw) as RecoveryLedger;
      return ledger.version === 1 && ledger.nonce === nonce ? ledger : null;
    } catch {
      return null; // eslint-disable-line no-restricted-syntax -- malformed isolated recovery metadata fails closed
    }
  }

  private requireActiveAttempt(): ActiveRecoveryAttempt {
    const attempt = this.activeAttempt;
    if (!attempt) throw new PasswordRecoveryError('AUTH_RECOVERY_SESSION_MISSING');
    this.requireCurrent(attempt);
    return attempt;
  }

  private requireGeneration(generation: number): void {
    if (generation !== this.generation) {
      throw new PasswordRecoveryError('AUTH_RECOVERY_ATTEMPT_STALE');
    }
  }

  private requireCurrent(attempt: ActiveRecoveryAttempt): void {
    if (this.activeAttempt !== attempt || this.generation !== attempt.generation) {
      throw new PasswordRecoveryError('AUTH_RECOVERY_ATTEMPT_STALE');
    }
  }

  private removeAttemptStorage(storageKey: string, attempt: ActiveRecoveryAttempt): void {
    this.removeStorageTriplet(sessionStorage, storageKey);
    sessionStorage.removeItem(this.envelopeKey(storageKey));
    const current = this.readEnvelope(ACTIVE_ATTEMPT_KEY);
    if (current?.attemptId === attempt.attemptId && current.capability === attempt.capability) {
      sessionStorage.removeItem(ACTIVE_ATTEMPT_KEY);
    }
  }

  private removeStorageTriplet(storage: Storage, storageKey: string): void {
    storage.removeItem(storageKey);
    storage.removeItem(`${storageKey}-code-verifier`);
    storage.removeItem(`${storageKey}-user`);
  }

  private readStorageTriplet(storage: Storage, storageKey: string): [string | null, string | null, string | null] {
    return [
      storage.getItem(storageKey),
      storage.getItem(`${storageKey}-code-verifier`),
      storage.getItem(`${storageKey}-user`),
    ];
  }

  private writeStorageTriplet(
    storage: Storage,
    storageKey: string,
    values: [string | null, string | null, string | null],
  ): void {
    [storageKey, `${storageKey}-code-verifier`, `${storageKey}-user`].forEach((key, index) => {
      if (values[index] === null) storage.removeItem(key);
      else storage.setItem(key, values[index]);
    });
  }

  private readEnvelope(key: string): RecoveryEnvelope | null {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as RecoveryEnvelope;
      return value.version === 1 ? value : null;
    } catch {
      return null; // eslint-disable-line no-restricted-syntax -- malformed claimant envelope fails closed
    }
  }

  private async withNonceLock<T>(nonce: string, callback: () => T): Promise<T> {
    if (!navigator.locks) {
      throw new PasswordRecoveryError('AUTH_RECOVERY_LOCK_UNAVAILABLE');
    }
    return await navigator.locks.request(
      `${RECOVERY_PREFIX}lock:${nonce}`,
      { mode: 'exclusive' },
      callback,
    );
  }

  private async digestSession(session: Session): Promise<string> {
    return await this.digest([
      session.user.id,
      session.access_token,
      session.refresh_token,
      String(session.expires_at ?? ''),
    ].join('\u0000'));
  }

  private async digest(value: string): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  private randomId(): string {
    const bytes = new Uint8Array(24);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  private scrubRecoveryUrl(): void {
    const url = new URL(window.location.href);
    const sensitiveParams = [
      'recovery_nonce', 'code', 'error', 'error_code', 'error_description',
      'access_token', 'refresh_token', 'type',
    ];
    for (const key of sensitiveParams) {
      url.searchParams.delete(key);
    }

    if (url.hash.startsWith('#/')) {
      const route = url.hash.slice(1);
      const queryIndex = route.indexOf('?');
      const routePath = queryIndex >= 0 ? route.slice(0, queryIndex) : route;
      const routeParams = new URLSearchParams(queryIndex >= 0 ? route.slice(queryIndex + 1) : '');
      for (const key of sensitiveParams) routeParams.delete(key);
      url.hash = `${routePath}${routeParams.size > 0 ? `?${routeParams.toString()}` : ''}`;
    } else {
      const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''));
      for (const key of sensitiveParams) hashParams.delete(key);
      url.hash = hashParams.size > 0 ? hashParams.toString() : '';
    }

    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }

  private ledgerKey(nonce: string): string {
    return `${RECOVERY_PREFIX}ledger:${nonce}`;
  }

  private requestStorageKey(nonce: string): string {
    return `${RECOVERY_PREFIX}request:${nonce}`;
  }

  private attemptStorageKey(nonce: string, attemptId: string): string {
    return `${RECOVERY_PREFIX}attempt:${nonce}:${attemptId}`;
  }

  private envelopeKey(storageKey: string): string {
    return `${storageKey}:envelope`;
  }
}
