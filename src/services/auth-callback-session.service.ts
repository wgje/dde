import { Injectable, inject } from '@angular/core';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { environment } from '../environments/environment';
import { AuthPkceExchangeClient } from './auth-pkce-exchange-client';
import { AuthService } from './auth.service';
import { resolveSupabaseStorageKey } from './supabase-client-configuration';
import { SupabaseClientOptionsFactoryService } from './supabase-client-options-factory.service';
import {
  getCanonicalAuthCallbackStorageAuthority,
  type AuthCallbackCaptureCapability,
  type CanonicalAuthBundle,
  type CanonicalAuthCallbackStorageAuthority,
} from './supabase-auth-client-lifecycle.controller';

export type AuthCallbackOutcome = 'authenticated' | 'cancelled' | 'conflict' | 'invalid';

interface CallbackClaimEnvelope {
  version: 1;
  attemptId: string;
  tabId: string;
  capabilityDigest: string;
  storageKey: string;
  code: string;
  verifier: string;
  expiresAt: number;
  exchangeState: 'ready' | 'dispatched' | 'succeeded';
  session?: string;
  sessionDigest?: string;
}

interface CallbackClaimMarker {
  kind: 'nanoflow-auth-callback';
  version: 1;
  attemptId: string;
  tabId: string;
  capabilityDigest: string;
  expiresAt: number;
}

interface ActiveCallbackAttempt {
  generation: number;
  claimantKey: string;
  marker: string;
  storageKey: string;
  client: SupabaseClient | null;
  disposed: boolean;
}

interface PreparedCallbackAttempt {
  attempt: ActiveCallbackAttempt;
  authority: CanonicalAuthCallbackStorageAuthority;
  canonicalStorageKey: string;
  envelopeDigest: string;
  expected: CanonicalAuthBundle;
  generation: number;
  claimEnvelope: Omit<CallbackClaimEnvelope, 'verifier'> | null;
  envelope: CallbackClaimEnvelope | null;
}

interface ResolvedCallbackSession {
  envelope: CallbackClaimEnvelope;
  session: Session;
}

const CAPTURE_KEY = '__NANOFLOW_AUTH_CALLBACK_CAPTURE__';
const CLAIM_PREFIX = 'nanoflow:auth-callback:v1:claim:';
const ATTEMPT_TTL_MS = 10 * 60 * 1000;

@Injectable({ providedIn: 'root' })
export class AuthCallbackSessionService {
  private readonly optionsFactory = inject(SupabaseClientOptionsFactoryService);
  private readonly auth = inject(AuthService);
  private readonly pkceExchange = new AuthPkceExchangeClient();
  private generation = 0;
  private activeAttempt: ActiveCallbackAttempt | null = null;
  private activePromise: Promise<AuthCallbackOutcome> | null = null;

  completeCapturedCallback(): Promise<AuthCallbackOutcome> {
    if (this.activePromise) return this.activePromise;
    const generation = ++this.generation;
    const promise = this.run(generation).finally(() => {
      if (this.activePromise === promise) this.activePromise = null;
    });
    this.activePromise = promise;
    return promise;
  }

  cancel(): void {
    this.generation += 1;
    if (this.activeAttempt) void this.disposeAttempt(this.activeAttempt);
  }

  private async run(generation: number): Promise<AuthCallbackOutcome> {
    const prepared = await this.prepareAttempt(generation);
    if (typeof prepared === 'string') return prepared;
    const { attempt, authority, canonicalStorageKey } = prepared;
    this.activeAttempt = attempt;

    try {
      return await this.exchangeAndPublish(prepared);
    } catch {
      return this.isCurrent(generation) ? 'invalid' : 'cancelled';
    } finally {
      await this.cleanupMarker(authority, canonicalStorageKey, attempt.marker);
      await this.disposeAttempt(attempt);
      if (this.activeAttempt === attempt) this.activeAttempt = null;
    }
  }

  private async prepareAttempt(
    generation: number,
  ): Promise<PreparedCallbackAttempt | AuthCallbackOutcome> {
    const authority = getCanonicalAuthCallbackStorageAuthority();
    const capture = this.readCapture();
    const canonicalStorageKey = resolveSupabaseStorageKey(environment.supabaseUrl);
    if (!authority || !capture || capture.blocked || capture.hasAuthError || !canonicalStorageKey) {
      return 'invalid';
    }
    if (!this.hasPrerequisites()) return 'invalid';

    const expected = authority.peekBundle(canonicalStorageKey);
    const resumed = await this.prepareResumedAttempt(
      generation,
      authority,
      canonicalStorageKey,
      expected,
    );
    if (resumed) return resumed;
    if (this.parseMarker(expected.codeVerifier)) return 'invalid';
    const code = capture.claimCode();
    if (!code) return 'invalid';
    if (!expected.codeVerifier) return 'invalid';
    const attemptId = this.randomId();
    const tabId = this.randomId();
    const storageKey = `nanoflow-auth-callback-${attemptId}`;
    const claimantKey = `${CLAIM_PREFIX}${attemptId}`;
    const capabilityDigest = await this.digest(`${attemptId}:${tabId}:${code}:${expected.codeVerifier}`);
    if (!this.isCurrent(generation)) return 'cancelled';
    const expiresAt = Date.now() + ATTEMPT_TTL_MS;
    const marker = JSON.stringify({
      kind: 'nanoflow-auth-callback', version: 1, attemptId, tabId, capabilityDigest, expiresAt,
    });
    const attempt: ActiveCallbackAttempt = {
      generation, claimantKey, marker, storageKey, client: null, disposed: false,
    };
    return {
      attempt,
      authority,
      canonicalStorageKey,
      envelopeDigest: capabilityDigest,
      expected,
      generation,
      envelope: null,
      claimEnvelope: {
        version: 1, attemptId, tabId, capabilityDigest, storageKey, code, expiresAt,
        exchangeState: 'ready',
      },
    };
  }

  private async prepareResumedAttempt(
    generation: number,
    authority: CanonicalAuthCallbackStorageAuthority,
    canonicalStorageKey: string,
    expected: CanonicalAuthBundle,
  ): Promise<PreparedCallbackAttempt | null> {
    const marker = this.parseMarker(expected.codeVerifier);
    if (!marker) return null;
    if (marker.expiresAt < Date.now()) {
      await this.cleanupMarker(authority, canonicalStorageKey, expected.codeVerifier!);
      this.cleanupAttemptStorage(
        `${CLAIM_PREFIX}${marker.attemptId}`,
        `nanoflow-auth-callback-${marker.attemptId}`,
      );
      return null;
    }
    const claimantKey = `${CLAIM_PREFIX}${marker.attemptId}`;
    const envelope = await this.readEnvelope(claimantKey, marker.capabilityDigest);
    const storageKey = `nanoflow-auth-callback-${marker.attemptId}`;
    if (!envelope
      || envelope.attemptId !== marker.attemptId
      || envelope.tabId !== marker.tabId
      || envelope.expiresAt !== marker.expiresAt
      || envelope.storageKey !== storageKey) {
      return null;
    }
    const attempt: ActiveCallbackAttempt = {
      generation,
      claimantKey,
      marker: expected.codeVerifier!,
      storageKey,
      client: null,
      disposed: false,
    };
    return {
      attempt,
      authority,
      canonicalStorageKey,
      envelopeDigest: marker.capabilityDigest,
      expected,
      generation,
      claimEnvelope: null,
      envelope,
    };
  }

  private async exchangeAndPublish(prepared: PreparedCallbackAttempt): Promise<AuthCallbackOutcome> {
    const {
      attempt, authority, canonicalStorageKey, generation,
    } = prepared;
    const envelope = await this.claimOrReadEnvelope(prepared);
    if (typeof envelope === 'string') return envelope;
    const resolved = await this.resolveSessionEnvelope(prepared, envelope);
    if (typeof resolved === 'string') return resolved;

    const client = createClient(
      environment.supabaseUrl,
      environment.supabaseAnonKey,
      this.optionsFactory.buildAuthCallbackClientOptions(attempt.storageKey),
    );
    attempt.client = client;
    const { data, error } = await client.auth.setSession({
      access_token: resolved.session.access_token,
      refresh_token: resolved.session.refresh_token,
    });
    if (!this.isCurrent(generation)) return 'cancelled';
    if (resolved.envelope.expiresAt < Date.now()) return 'invalid';
    if (error || !this.sessionsMatch(resolved.session, data.session)) return 'invalid';

    const current = await authority.readBundle(canonicalStorageKey);
    if (!this.isCurrent(generation)) return 'cancelled';
    if (current.session !== null || current.user !== null || current.codeVerifier !== attempt.marker) {
      return 'conflict';
    }
    const next: CanonicalAuthBundle = {
      session: resolved.envelope.session ?? JSON.stringify(resolved.session),
      codeVerifier: null,
      user: JSON.stringify(resolved.session.user),
    };
    await authority.compareAndSwap({ storageKey: canonicalStorageKey, expected: current, next }, () => {
      if (!this.isCurrent(generation)) throw new Error('AUTH_CALLBACK_GENERATION_STALE');
    });
    const readback = await authority.readBundle(canonicalStorageKey);
    if (!this.isCurrent(generation)) return 'cancelled';
    if (!this.bundlesEqual(readback, next)) return 'conflict';
    await this.auth.restartRuntimeAfterAuthCallback();
    return this.isCurrent(generation) ? 'authenticated' : 'cancelled';
  }

  private async claimOrReadEnvelope(
    prepared: PreparedCallbackAttempt,
  ): Promise<CallbackClaimEnvelope | AuthCallbackOutcome> {
    const {
      attempt, authority, canonicalStorageKey, envelopeDigest, expected, generation, claimEnvelope,
    } = prepared;
    if (claimEnvelope) {
      await authority.claimCallbackVerifier({
        storageKey: canonicalStorageKey,
        expected,
        marker: attempt.marker,
        claimantKey: attempt.claimantKey,
        envelope: claimEnvelope,
      });
    }
    if (!this.isCurrent(generation)) return 'cancelled';
    const envelope = prepared.envelope
      ?? await this.readEnvelope(attempt.claimantKey, envelopeDigest);
    if (!envelope) return 'invalid';
    if (expected.session !== null || expected.user !== null) return 'conflict';
    const claimed = await authority.readBundle(canonicalStorageKey);
    if (!this.isCurrent(generation)) return 'cancelled';
    if (claimed.session !== null
      || claimed.user !== null
      || claimed.codeVerifier !== attempt.marker) return 'conflict';
    return envelope;
  }

  private async resolveSessionEnvelope(
    prepared: PreparedCallbackAttempt,
    envelope: CallbackClaimEnvelope,
  ): Promise<ResolvedCallbackSession | AuthCallbackOutcome> {
    const resumed = this.parseSessionRaw(envelope.session);
    if (resumed && envelope.exchangeState === 'succeeded') return { envelope, session: resumed };
    if (envelope.exchangeState !== 'ready' || envelope.session || envelope.sessionDigest) {
      return 'invalid';
    }
    const dispatched = await this.markExchangeDispatched(prepared, envelope);
    if (!dispatched) return this.isCurrent(prepared.generation) ? 'conflict' : 'cancelled';
    const exchanged = await this.exchangeClaimedCode(dispatched);
    if (!this.isCurrent(prepared.generation)) return 'cancelled';
    if (!exchanged) return 'invalid';
    const persisted = await this.persistClaimantSession(prepared, dispatched, exchanged);
    if (!persisted) return this.isCurrent(prepared.generation) ? 'conflict' : 'cancelled';
    return { envelope: persisted, session: exchanged };
  }

  private async exchangeClaimedCode(envelope: CallbackClaimEnvelope): Promise<Session | null> {
    const result = await this.pkceExchange.exchange({
      supabaseUrl: environment.supabaseUrl,
      anonKey: environment.supabaseAnonKey,
      code: envelope.code,
      verifier: envelope.verifier,
    });
    return result.error ? null : result.data.session;
  }

  private async markExchangeDispatched(
    prepared: PreparedCallbackAttempt,
    envelope: CallbackClaimEnvelope,
  ): Promise<CallbackClaimEnvelope | null> {
    if (!this.isCurrent(prepared.generation)) return null;
    const current = await prepared.authority.readBundle(prepared.canonicalStorageKey);
    if (!this.isCurrent(prepared.generation)
      || current.session !== null
      || current.user !== null
      || current.codeVerifier !== prepared.attempt.marker) return null;
    const stored = await this.readEnvelope(prepared.attempt.claimantKey, envelope.capabilityDigest);
    if (!this.isCurrent(prepared.generation)
      || !stored
      || stored.exchangeState !== 'ready'
      || stored.session
      || stored.sessionDigest) return null;
    const next: CallbackClaimEnvelope = { ...stored, exchangeState: 'dispatched' };
    sessionStorage.setItem(prepared.attempt.claimantKey, JSON.stringify(next));
    return await this.readEnvelope(prepared.attempt.claimantKey, envelope.capabilityDigest);
  }

  private async persistClaimantSession(
    prepared: PreparedCallbackAttempt,
    envelope: CallbackClaimEnvelope,
    session: Session,
  ): Promise<CallbackClaimEnvelope | null> {
    const sessionRaw = JSON.stringify(session);
    const sessionDigest = await this.digest(`${envelope.capabilityDigest}:${sessionRaw}`);
    if (!this.isCurrent(prepared.generation)) return null;
    const current = await prepared.authority.readBundle(prepared.canonicalStorageKey);
    if (!this.isCurrent(prepared.generation)
      || current.session !== null
      || current.user !== null
      || current.codeVerifier !== prepared.attempt.marker) {
      return null;
    }
    const currentEnvelope = await this.readEnvelope(
      prepared.attempt.claimantKey,
      envelope.capabilityDigest,
    );
    if (!this.isCurrent(prepared.generation)
      || !currentEnvelope
      || currentEnvelope.exchangeState !== 'dispatched'
      || currentEnvelope.session
      || currentEnvelope.sessionDigest) return null;
    const next: CallbackClaimEnvelope = {
      ...currentEnvelope,
      exchangeState: 'succeeded',
      session: sessionRaw,
      sessionDigest,
    };
    sessionStorage.setItem(prepared.attempt.claimantKey, JSON.stringify(next));
    return await this.readEnvelope(prepared.attempt.claimantKey, envelope.capabilityDigest);
  }

  private parseMarker(raw: string | null): CallbackClaimMarker | null {
    if (!raw || raw.charAt(0) !== '{') return null;
    try {
      const value = JSON.parse(raw) as Partial<CallbackClaimMarker>;
      if (value.kind !== 'nanoflow-auth-callback'
        || value.version !== 1
        || typeof value.attemptId !== 'string' || !value.attemptId
        || typeof value.tabId !== 'string' || !value.tabId
        || typeof value.capabilityDigest !== 'string' || !value.capabilityDigest
        || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)) {
        return null;
      }
      return value as CallbackClaimMarker;
    } catch {
      // Callback markers are untrusted persisted data and fail closed.
      // eslint-disable-next-line no-restricted-syntax
      return null;
    }
  }

  private parseSessionRaw(raw: string | undefined): Session | null {
    if (!raw) return null;
    try {
      return this.parseSession(JSON.parse(raw));
    } catch {
      // Claimant sessions are untrusted persisted data and fail closed.
      // eslint-disable-next-line no-restricted-syntax
      return null;
    }
  }

  private parseSession(value: unknown): Session | null {
    if (!value || typeof value !== 'object') return null;
    const session = value as Partial<Session>;
    if (typeof session.access_token !== 'string' || !session.access_token
      || typeof session.refresh_token !== 'string' || !session.refresh_token
      || typeof session.expires_in !== 'number'
      || !Number.isFinite(session.expires_in) || session.expires_in <= 0
      || !session.user
      || typeof session.user.id !== 'string' || !session.user.id) {
      return null;
    }
    return session as Session;
  }

  private sessionsMatch(expected: Session, actual: Session | null): boolean {
    return actual?.access_token === expected.access_token
      && actual.refresh_token === expected.refresh_token
      && actual.user.id === expected.user.id;
  }

  private readCapture(): AuthCallbackCaptureCapability | null {
    const value: unknown = Object.getOwnPropertyDescriptor(globalThis, CAPTURE_KEY)?.value;
    if (!value || typeof value !== 'object' || !Object.isFrozen(value)) return null;
    if (!('claimCode' in value) || typeof value.claimCode !== 'function') return null;
    return value as AuthCallbackCaptureCapability;
  }

  private async readEnvelope(key: string, expectedDigest: string): Promise<CallbackClaimEnvelope | null> {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as CallbackClaimEnvelope;
      if (value.version !== 1 || value.capabilityDigest !== expectedDigest) return null;
      if (value.expiresAt < Date.now() || !this.hasRequiredEnvelopeFields(value)) return null;
      const digest = await this.digest(`${value.attemptId}:${value.tabId}:${value.code}:${value.verifier}`);
      if (digest !== expectedDigest) return null;
      if ((value.session === undefined) !== (value.sessionDigest === undefined)) return null;
      if (value.exchangeState === 'succeeded' && value.session === undefined) return null;
      if (value.exchangeState !== 'succeeded' && value.session !== undefined) return null;
      if (value.session !== undefined) {
        if (!this.parseSessionRaw(value.session)) return null;
        const sessionDigest = await this.digest(`${expectedDigest}:${value.session}`);
        if (sessionDigest !== value.sessionDigest) return null;
      }
      return sessionStorage.getItem(key) === raw ? value : null;
    } catch {
      // Claimant storage is untrusted; malformed envelopes fail closed.
      // eslint-disable-next-line no-restricted-syntax
      return null;
    }
  }

  private hasRequiredEnvelopeFields(value: CallbackClaimEnvelope): boolean {
    return Boolean(value.attemptId
      && value.tabId
      && value.storageKey
      && value.code
      && value.verifier)
      && ['ready', 'dispatched', 'succeeded'].includes(value.exchangeState);
  }

  private async cleanupMarker(
    authority: CanonicalAuthCallbackStorageAuthority,
    storageKey: string,
    marker: string,
  ): Promise<void> {
    try {
      const current = await authority.readBundle(storageKey);
      if (current.codeVerifier !== marker) return;
      await authority.compareAndSwap({
        storageKey,
        expected: current,
        next: { ...current, codeVerifier: null },
      });
    } catch {
      // An exact mismatch means another generation owns cleanup.
    }
  }

  private async disposeAttempt(attempt: ActiveCallbackAttempt): Promise<void> {
    this.cleanupAttemptStorage(attempt.claimantKey, attempt.storageKey);
    if (!attempt.disposed && attempt.client) {
      attempt.disposed = true;
      await Promise.allSettled([attempt.client.auth.dispose(), attempt.client.removeAllChannels()]);
    }
  }

  private cleanupAttemptStorage(claimantKey: string, storageKey: string): void {
    sessionStorage.removeItem(claimantKey);
    for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = sessionStorage.key(index);
      if (key === storageKey || key?.startsWith(`${storageKey}-`)) {
        sessionStorage.removeItem(key);
      }
    }
  }

  private hasPrerequisites(): boolean {
    try {
      const cryptoApi = globalThis.crypto as Partial<Crypto> | undefined;
      return Boolean(
        navigator.locks
        && typeof cryptoApi?.getRandomValues === 'function'
        && cryptoApi.subtle
        && sessionStorage,
      );
    } catch {
      return false;
    }
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  private randomId(): string {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte =>
      byte.toString(16).padStart(2, '0')).join('');
  }

  private async digest(value: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  private bundlesEqual(left: CanonicalAuthBundle, right: CanonicalAuthBundle): boolean {
    return left.session === right.session
      && left.codeVerifier === right.codeVerifier
      && left.user === right.user;
  }
}
