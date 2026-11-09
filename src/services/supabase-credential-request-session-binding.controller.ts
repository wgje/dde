import type { AuthResponse, Session, SupabaseClient } from '@supabase/supabase-js';
import type { AuthCredentialStateCommitPredicate } from './auth-credential-flow.controller';
import {
  getCanonicalAuthStorageAuthority,
  type CanonicalAuthBundle,
  type CanonicalAuthStorageAuthority,
} from './supabase-auth-client-lifecycle.controller';
import { getSupabaseRequestMethod } from './supabase-fetch-request.helpers';
import type { PasswordRecoveryStorage } from './supabase-client-options-factory.service';
import type { CredentialRequestSessionBinding, CredentialSignInFetchContext } from './supabase-client.service';
export type { CredentialRequestSessionBinding, CredentialSignInFetchContext } from './supabase-client.service';

interface SupabaseCredentialRequestSessionBindingControllerOptions {
  getStorageKey: () => string | null;
  getSupabaseUrl: () => string;
  getSupabaseAnonKey: () => string;
  buildSignupClientOptions: (
    storageKey: string,
    storage: PasswordRecoveryStorage,
    fetchHandler: (url: RequestInfo | URL, options?: RequestInit) => Promise<Response>,
  ) => unknown;
}

export type SignupSessionPublicationFence = (session: {
  access_token: string;
  user: { id: string; email?: string | null };
}, isAttemptActive?: () => boolean) => Promise<boolean>;

interface SignupDisclosure {
  accessToken: string | null;
  identity: { userId: string; email: string | null } | null;
}

interface SignupAttempt {
  readonly sequence: number;
  readonly storageKey: string;
  readonly canonicalStorageKey: string;
  readonly expected: CanonicalAuthBundle;
  readonly authority: CanonicalAuthStorageAuthority;
  readonly deadline: number;
  readonly canCommit: AuthCredentialStateCommitPredicate;
  readonly afterSessionCommit: SignupSessionPublicationFence;
  readonly turn: Deferred<void>;
  cohort: SignupCohort | null;
  disclosure: SignupDisclosure | null;
  committed: CanonicalAuthBundle | null;
  decisionError: Error | null;
  finished: boolean;
  terminal: boolean;
  phase: number;
  signedInLatch: boolean;
}

interface SignupCohort {
  readonly members: SignupAttempt[];
  cursor: number;
  settled: boolean;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

type SignupClient = Pick<SupabaseClient, 'auth' | 'removeAllChannels'>;

const SIGNUP_REQUEST_TIMEOUT_MS = 15_000;

export class SupabaseCredentialRequestSessionBindingController {
  private activeFetchContext: CredentialSignInFetchContext | null = null;
  private readonly inFlightRequestIds = new Set<string>();
  private readonly bindingByAccessToken = new Map<string, CredentialRequestSessionBinding>();
  private readonly accessTokensByRequestId = new Map<string, Set<string>>();
  private readonly unassignedSignupAttempts = new Set<SignupAttempt>();
  private signupSequence = 0;
  private committedSignupAttempt: SignupAttempt | null = null;

  constructor(
    private readonly options: SupabaseCredentialRequestSessionBindingControllerOptions,
  ) {}

  consume(accessToken: string): CredentialRequestSessionBinding | null {
    const binding = this.bindingByAccessToken.get(accessToken) ?? null;
    if (!binding) return null;

    this.bindingByAccessToken.delete(accessToken);
    const requestTokens = this.accessTokensByRequestId.get(binding.requestId);
    requestTokens?.delete(accessToken);
    if (requestTokens?.size === 0) this.accessTokensByRequestId.delete(binding.requestId);
    return binding;
  }

  // eslint-disable-next-line max-lines-per-function -- request disclosure, cohort release, and terminal cleanup are ordered
  async runSignUp(
    email: string,
    password: string,
    emailRedirectTo: string,
    canCommit: AuthCredentialStateCommitPredicate,
    afterSessionCommit: SignupSessionPublicationFence,
  ): Promise<AuthResponse> {
    const attempt = this.beginSignupAttempt(canCommit, afterSessionCommit);
    let client: SignupClient | null = null;
    let unsubscribe: (() => void) | null = null;
    let primaryError = false;
    try {
      const { createClient } = await import('@supabase/supabase-js');
      this.requireActive(attempt);
      const storage = this.createSignupStorage(attempt);
      const requestFetch = this.createSignupFetch(attempt);
      client = createClient(
        this.options.getSupabaseUrl(),
        this.options.getSupabaseAnonKey(),
        this.options.buildSignupClientOptions(attempt.storageKey, storage, requestFetch) as never,
      );
      const { data } = client.auth.onAuthStateChange(async (event, session) => {
        if (event !== 'SIGNED_IN') return;
        this.requireActive(attempt);
        if (attempt.signedInLatch) throw new Error('AUTH_SIGNUP_SIGNED_IN_DUPLICATE');
        attempt.signedInLatch = true;
        await this.commitSignedInSession(attempt, session);
      });
      unsubscribe = () => data.subscription.unsubscribe();
      const result = await this.withDeadline(attempt, client.auth.signUp({
        email,
        password,
        options: { emailRedirectTo },
      }));
      this.requireActive(attempt);
      if (!attempt.disclosure) {
        this.disclose(attempt, this.disclosureFromResult(result));
      }
      await this.withDeadline(attempt, attempt.turn.promise);
      if (!result.error && result.data.user && !result.data.session) {
        await this.withDeadline(
          attempt,
          this.commitConfirmationVerifier(attempt, result.data.user.id, result.data.user.email ?? null),
        );
      }
      return result;
    } catch (error) {
      primaryError = true;
      if (!attempt.disclosure && !attempt.terminal) this.disclose(attempt, { accessToken: null, identity: null });
      throw error;
    } finally {
      attempt.terminal = true;
      this.finishSignupAttempt(attempt);
      const cleanupErrors: unknown[] = [];
      try { unsubscribe?.(); } catch (error) { cleanupErrors.push(error); }
      cleanupErrors.push(...this.clearSignupStorage(attempt.storageKey));
      const committed = attempt.committed;
      if (committed) await this.runCleanup(attempt, () => this.rollbackCanonicalCommit(attempt, committed), cleanupErrors);
      if (client) await this.runCleanup(attempt, async () => {
        const outcomes = await Promise.allSettled([
          Promise.resolve().then(() => client!.auth.dispose()),
          Promise.resolve().then(() => client!.removeAllChannels()),
        ]);
        for (const outcome of outcomes) if (outcome.status === 'rejected') cleanupErrors.push(outcome.reason);
      }, cleanupErrors);
      if (cleanupErrors.length && !primaryError) {
        throw new AggregateError(cleanupErrors, 'AUTH_SIGNUP_CLEANUP_FAILED');
      }
    }
  }
  async runSignIn<T>(requestId: string, startRequest: () => Promise<T>): Promise<T> {
    if (this.inFlightRequestIds.has(requestId)) {
      throw new Error('Duplicate credential request id');
    }
    const context = { requestId };
    const previousContext = this.activeFetchContext;
    this.inFlightRequestIds.add(requestId);
    try {
      let request: Promise<T>;
      this.activeFetchContext = context;
      try {
        request = startRequest();
      } finally {
        if (this.activeFetchContext === context) this.activeFetchContext = previousContext;
      }
      return await request;
    } finally {
      if (this.activeFetchContext === context) this.activeFetchContext = previousContext;
      this.inFlightRequestIds.delete(requestId);
      this.clearRequestBindings(requestId);
    }
  }
  currentFetchContext(): CredentialSignInFetchContext | null {
    return this.activeFetchContext;
  }
  async bindResponse(
    context: CredentialSignInFetchContext | null,
    url: RequestInfo | URL,
    options: RequestInit,
    response: Response,
  ): Promise<void> {
    if (!context || !response.ok || !this.isPasswordGrantRequest(url, options)) return;
    let payload: unknown;
    try {
      payload = await response.clone().json();
    } catch {
      return;
    }
    if (!payload || typeof payload !== 'object') return;

    const accessToken = (payload as Record<string, unknown>)['access_token'];
    if (typeof accessToken !== 'string' || !accessToken) return;

    if (this.bindingByAccessToken.has(accessToken)) {
      throw new Error('AUTH_CREDENTIAL_TOKEN_BINDING_COLLISION');
    }

    this.bindingByAccessToken.set(accessToken, {
      requestId: context.requestId,
      previousPersistedSession: this.readPersistedSessionSnapshot(),
    });
    const requestTokens = this.accessTokensByRequestId.get(context.requestId) ?? new Set<string>();
    requestTokens.add(accessToken);
    this.accessTokensByRequestId.set(context.requestId, requestTokens);
  }

  clearCompletedBindings(): void {
    for (const requestId of this.accessTokensByRequestId.keys()) {
      if (!this.inFlightRequestIds.has(requestId)) this.clearRequestBindings(requestId);
    }
  }
  private beginSignupAttempt(
    canCommit: AuthCredentialStateCommitPredicate,
    afterSessionCommit: SignupSessionPublicationFence,
  ): SignupAttempt {
    const canonicalStorageKey = this.options.getStorageKey();
    const authority = getCanonicalAuthStorageAuthority();
    if (!canonicalStorageKey || !authority) throw new Error('AUTH_SIGNUP_AUTHORITY_UNAVAILABLE');
    if (typeof sessionStorage === 'undefined') throw new Error('AUTH_SIGNUP_STORAGE_UNAVAILABLE');
    const cryptoApi = globalThis.crypto;
    if (!cryptoApi?.getRandomValues) throw new Error('AUTH_SIGNUP_CRYPTO_UNAVAILABLE');
    if (typeof navigator === 'undefined' || !navigator.locks) {
      throw new Error('AUTH_SIGNUP_LOCK_UNAVAILABLE');
    }

    this.signupSequence += 1;
    const attempt: SignupAttempt = {
      sequence: this.signupSequence,
      storageKey: `nanoflow-auth-signup-${this.randomId()}`,
      canonicalStorageKey,
      expected: authority.peekBundle(canonicalStorageKey),
      authority,
      deadline: Date.now() + SIGNUP_REQUEST_TIMEOUT_MS,
      canCommit,
      afterSessionCommit,
      turn: createDeferred<void>(),
      cohort: null,
      disclosure: null,
      committed: null,
      decisionError: null,
      finished: false,
      terminal: false,
      phase: 0,
      signedInLatch: false,
    };
    this.unassignedSignupAttempts.add(attempt);
    return attempt;
  }
  private createSignupStorage(attempt: SignupAttempt): PasswordRecoveryStorage {
    const allowedKeys = new Set([
      attempt.storageKey,
      `${attempt.storageKey}-code-verifier`,
      `${attempt.storageKey}-user`,
    ]);
    const requireKey = (key: string): void => {
      if (!allowedKeys.has(key)) throw new Error('AUTH_SIGNUP_STORAGE_KEY_REJECTED');
      this.requireActive(attempt);
    };
    return {
      getItem: key => {
        requireKey(key);
        return sessionStorage.getItem(key);
      },
      setItem: async (key, value) => {
        requireKey(key);
        if (key !== `${attempt.storageKey}-code-verifier`) {
          await this.withDeadline(attempt, attempt.turn.promise);
          this.requireSessionStorageToken(attempt, key, value);
        }
        this.requireActive(attempt);
        sessionStorage.setItem(key, value);
      },
      removeItem: async key => {
        requireKey(key);
        if (key !== `${attempt.storageKey}-code-verifier` && attempt.disclosure) {
          await this.withDeadline(attempt, attempt.turn.promise);
        }
        this.requireActive(attempt);
        sessionStorage.removeItem(key);
      },
    };
  }
  private createSignupFetch(attempt: SignupAttempt) {
    return async (url: RequestInfo | URL, options: RequestInit = {}): Promise<Response> => {
      this.requireActive(attempt);
      if (!this.isSignupRequest(url, options)) throw new Error('AUTH_SIGNUP_REQUEST_REJECTED');
      const response = await this.withDeadline(attempt, globalThis.fetch(url, options));
      const body = await this.withDeadline(attempt, response.arrayBuffer());
      this.requireActive(attempt);
      this.disclose(attempt, this.disclosureFromBody(body));
      await this.withDeadline(attempt, attempt.turn.promise);
      this.requireActive(attempt);
      return new Response(body.slice(0), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };
  }
  private disclose(attempt: SignupAttempt, disclosure: SignupDisclosure): void {
    this.requireActive(attempt);
    if (attempt.disclosure) throw new Error('AUTH_SIGNUP_RESPONSE_REPLAYED');
    if (!attempt.cohort) {
      const members = [...this.unassignedSignupAttempts]
        .filter(member => !member.terminal)
        .sort((left, right) => left.sequence - right.sequence);
      const cohort: SignupCohort = { members, cursor: 0, settled: false };
      for (const member of members) {
        member.cohort = cohort;
        this.unassignedSignupAttempts.delete(member);
      }
    }
    attempt.disclosure = disclosure;
    this.settleSignupCohort(attempt.cohort!);
  }
  private settleSignupCohort(cohort: SignupCohort): void {
    if (cohort.settled || cohort.members.some(member => !member.disclosure)) return;
    const tokenCounts = new Map<string, number>();
    for (const member of cohort.members) {
      const token = member.disclosure?.accessToken;
      if (token) tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
    }
    for (const member of cohort.members) {
      const disclosure = member.disclosure!;
      if (disclosure.accessToken && tokenCounts.get(disclosure.accessToken)! > 1) {
        member.decisionError = new Error('AUTH_SIGNUP_TOKEN_COLLISION');
      } else if (disclosure.identity && !this.canCommit(member, disclosure.identity)) {
        member.decisionError = new Error('AUTH_SIGNUP_SUBMISSION_STALE');
      } else if (disclosure.accessToken && !disclosure.identity) {
        member.decisionError = new Error('AUTH_SIGNUP_IDENTITY_MISSING');
      }
    }
    cohort.settled = true;
    this.releaseNextSignupAttempt(cohort);
  }
  private releaseNextSignupAttempt(cohort: SignupCohort): void {
    while (cohort.cursor < cohort.members.length && cohort.members[cohort.cursor]!.finished) {
      cohort.members[cohort.cursor]!.turn.resolve();
      cohort.cursor += 1;
    }
    const attempt = cohort.members[cohort.cursor];
    if (!attempt) return;
    if (attempt.decisionError) attempt.turn.reject(attempt.decisionError);
    else attempt.turn.resolve();
  }
  private finishSignupAttempt(attempt: SignupAttempt): void {
    attempt.finished = true;
    this.unassignedSignupAttempts.delete(attempt);
    const cohort = attempt.cohort;
    if (!cohort?.settled || cohort.members[cohort.cursor] !== attempt) return;
    cohort.cursor += 1;
    this.releaseNextSignupAttempt(cohort);
  }
  private async commitSignedInSession(attempt: SignupAttempt, session: Session | null): Promise<void> {
    this.requireActive(attempt);
    const disclosure = attempt.disclosure;
    if (!session?.access_token || !session.user || disclosure?.accessToken !== session.access_token) {
      throw new Error('AUTH_SIGNUP_LISTENER_TOKEN_MISMATCH');
    }
    const identity = { userId: session.user.id, email: session.user.email ?? null };
    if (!disclosure.identity || disclosure.identity.userId !== identity.userId) {
      throw new Error('AUTH_SIGNUP_LISTENER_IDENTITY_MISMATCH');
    }
    const raw = sessionStorage.getItem(attempt.storageKey);
    if (!raw || this.readAccessToken(raw) !== session.access_token) {
      throw new Error('AUTH_SIGNUP_SESSION_STORAGE_MISMATCH');
    }
    if (Object.values(attempt.expected).some(value => value !== null)) {
      throw new Error('AUTH_SIGNUP_CANONICAL_CONFLICT');
    }
    const next: CanonicalAuthBundle = {
      session: raw,
      codeVerifier: null,
      user: JSON.stringify(session.user),
    };
    await this.commitCanonicalBundle(attempt, identity, next);
    await this.withDeadline(attempt, this.requireCanonicalReadback(attempt, next));
    const publicationPhase = this.nextPhase(attempt);
    this.requirePhaseActive(attempt, publicationPhase);
    const published = await this.withDeadline(attempt, attempt.afterSessionCommit({
        access_token: session.access_token,
        user: session.user,
      }, () => this.isPhaseActive(attempt, publicationPhase)));
    this.requirePhaseActive(attempt, publicationPhase);
    if (!published) throw new Error('AUTH_SIGNUP_PUBLICATION_STALE');
    attempt.committed = null;
    if (this.committedSignupAttempt === attempt) this.committedSignupAttempt = null;
  }

  private async commitConfirmationVerifier(
    attempt: SignupAttempt,
    userId: string,
    email: string | null,
  ): Promise<void> {
    const identity = { userId, email };
    this.authorizeCanonicalCommit(attempt, identity);
    const verifier = sessionStorage.getItem(`${attempt.storageKey}-code-verifier`);
    if (!verifier) throw new Error('AUTH_SIGNUP_VERIFIER_MISSING');
    if (attempt.expected.codeVerifier !== null) throw new Error('AUTH_SIGNUP_CANONICAL_CONFLICT');
    const next = { ...attempt.expected, codeVerifier: verifier };
    await this.commitCanonicalBundle(attempt, identity, next);
    await this.withDeadline(attempt, this.requireCanonicalReadback(attempt, next));
    attempt.committed = null;
    if (this.committedSignupAttempt === attempt) this.committedSignupAttempt = null;
  }

  private async commitCanonicalBundle(attempt: SignupAttempt, identity: { userId: string; email: string | null }, next: CanonicalAuthBundle): Promise<void> {
    const phase = this.nextPhase(attempt);
    this.requirePhaseActive(attempt, phase);
    attempt.committed = next;
    try {
      const result = await this.withDeadline(attempt, attempt.authority.compareAndSwap(
        { storageKey: attempt.canonicalStorageKey, expected: attempt.expected, next },
        () => { this.requirePhaseActive(attempt, phase); this.authorizeCanonicalCommit(attempt, identity); },
      ));
      this.requirePhaseActive(attempt, phase);
      if (result !== 'committed') throw new Error('AUTH_SIGNUP_CANONICAL_CAS_NOT_COMMITTED');
      this.committedSignupAttempt = attempt;
    } catch (error) {
      if (this.committedSignupAttempt !== attempt) attempt.committed = null;
      throw error;
    }
  }

  private authorizeCanonicalCommit(
    attempt: SignupAttempt,
    identity: { userId: string; email: string | null },
  ): void {
    this.requireActive(attempt);
    if (!this.canCommit(attempt, identity)) throw new Error('AUTH_SIGNUP_SUBMISSION_STALE');
    const disclosure = attempt.disclosure?.identity;
    if (!disclosure || disclosure.userId !== identity.userId || disclosure.email !== identity.email) {
      throw new Error('AUTH_SIGNUP_IDENTITY_MISMATCH');
    }
  }

  private canCommit(
    attempt: SignupAttempt,
    identity: { userId: string; email: string | null },
  ): boolean {
    try {
      return attempt.canCommit(identity) === true;
    } catch {
      return false;
    }
  }

  private async requireCanonicalReadback(
    attempt: SignupAttempt,
    expected: CanonicalAuthBundle,
  ): Promise<void> {
    const phase = this.nextPhase(attempt);
    this.requirePhaseActive(attempt, phase);
    const readback = await attempt.authority.readBundle(attempt.canonicalStorageKey);
    this.requirePhaseActive(attempt, phase);
    if (!bundlesEqual(readback, expected)) throw new Error('AUTH_SIGNUP_CANONICAL_READBACK_MISMATCH');
  }

  private async rollbackCanonicalCommit(
    attempt: SignupAttempt,
    committed: CanonicalAuthBundle,
  ): Promise<void> {
    if (this.committedSignupAttempt !== attempt || attempt.committed !== committed) return;
    const result = await attempt.authority.compareAndSwap({
      storageKey: attempt.canonicalStorageKey,
      expected: committed,
      next: attempt.expected,
    }, () => { if (this.committedSignupAttempt !== attempt || attempt.committed !== committed) throw new Error('AUTH_SIGNUP_ROLLBACK_STALE'); });
    if (result !== 'committed') throw new Error('AUTH_SIGNUP_ROLLBACK_NOT_COMMITTED');
    if (this.committedSignupAttempt === attempt) this.committedSignupAttempt = null;
    attempt.committed = null;
  }

  private requireSessionStorageToken(attempt: SignupAttempt, key: string, value: string): void {
    if (key === `${attempt.storageKey}-user`) return;
    const token = this.readAccessToken(value);
    if (!token || token !== attempt.disclosure?.accessToken) {
      throw new Error('AUTH_SIGNUP_STORAGE_TOKEN_MISMATCH');
    }
  }

  private disclosureFromBody(body: ArrayBuffer): SignupDisclosure {
    try {
      return this.disclosureFromPayload(JSON.parse(new TextDecoder().decode(body)) as unknown);
    } catch {
      return { accessToken: null, identity: null };
    }
  }

  private disclosureFromResult(result: AuthResponse): SignupDisclosure {
    return this.disclosureFromPayload(result.data.session ?? { user: result.data.user });
  }

  private disclosureFromPayload(payload: unknown): SignupDisclosure {
    if (!payload || typeof payload !== 'object') return { accessToken: null, identity: null };
    const record = payload as Record<string, unknown>;
    const user = record['user'];
    const userRecord = user && typeof user === 'object' ? user as Record<string, unknown> : null;
    const userId = userRecord?.['id'];
    const email = userRecord?.['email'];
    return {
      accessToken: typeof record['access_token'] === 'string' && record['access_token']
        ? record['access_token'] : null,
      identity: typeof userId === 'string' && userId
        ? { userId, email: typeof email === 'string' ? email : null }
        : null,
    };
  }

  private readAccessToken(raw: string): string | null {
    try {
      const value = JSON.parse(raw) as Record<string, unknown>;
      return typeof value['access_token'] === 'string' && value['access_token']
        ? value['access_token'] : null;
    } catch {
      return null; // eslint-disable-line no-restricted-syntax -- malformed attempt payload has no usable token
    }
  }

  private isSignupRequest(url: RequestInfo | URL, options: RequestInit): boolean {
    if (getSupabaseRequestMethod(url, options) !== 'POST') return false;
    const rawUrl = typeof Request !== 'undefined' && url instanceof Request ? url.url : String(url);
    try {
      return new URL(rawUrl).pathname.endsWith('/auth/v1/signup');
    } catch {
      return false;
    }
  }

  private async withDeadline<T>(attempt: SignupAttempt, promise: PromiseLike<T>): Promise<T> {
    const remaining = attempt.deadline - Date.now();
    if (remaining <= 0) {
      this.expireAttempt(attempt);
      throw new Error('AUTH_SIGNUP_DEADLINE_EXCEEDED');
    }
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      const result = await Promise.race([
        Promise.resolve(promise),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => { this.expireAttempt(attempt); reject(new Error('AUTH_SIGNUP_DEADLINE_EXCEEDED')); },
            remaining,
          );
        }),
      ]);
      this.requireActive(attempt);
      return result;
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId);
    }
  }

  private requireActive(attempt: SignupAttempt): void {
    if (attempt.terminal) throw new Error('AUTH_SIGNUP_ATTEMPT_TERMINAL');
  }

  private expireAttempt(attempt: SignupAttempt): void {
    attempt.terminal = true;
  }

  private clearSignupStorage(storageKey: string): unknown[] {
    const errors: unknown[] = [];
    for (const key of [storageKey, `${storageKey}-code-verifier`, `${storageKey}-user`]) { try { sessionStorage.removeItem(key); } catch (error) { errors.push(error); } }
    return errors;
  }

  private nextPhase(attempt: SignupAttempt): number { attempt.phase += 1; return attempt.phase; }
  private isPhaseActive(attempt: SignupAttempt, phase: number): boolean {
    return !attempt.terminal && attempt.phase === phase && attempt.deadline > Date.now();
  }
  private requirePhaseActive(attempt: SignupAttempt, phase: number): void {
    if (attempt.deadline <= Date.now()) { this.expireAttempt(attempt); throw new Error('AUTH_SIGNUP_DEADLINE_EXCEEDED'); }
    if (attempt.terminal || attempt.phase !== phase) throw new Error('AUTH_SIGNUP_PHASE_STALE');
  }
  private async runCleanup(attempt: SignupAttempt, operation: () => PromiseLike<void>, errors: unknown[]): Promise<void> {
    let work: PromiseLike<void>;
    try { work = operation(); } catch (error) { errors.push(error); return; }
    const remaining = Math.max(0, attempt.deadline - Date.now());
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    try { await Promise.race([Promise.resolve(work), new Promise<void>(resolve => {
      timeoutId = setTimeout(() => { timedOut = true; resolve(); }, remaining);
    })]); } catch (error) { errors.push(error); }
    finally { if (timeoutId !== null) clearTimeout(timeoutId); }
    if (timedOut) errors.push(new Error('AUTH_SIGNUP_CLEANUP_DEADLINE_EXCEEDED'));
  }

  private randomId(): string {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte =>
      byte.toString(16).padStart(2, '0')).join('');
  }

  private isPasswordGrantRequest(url: RequestInfo | URL, options: RequestInit): boolean {
    if (getSupabaseRequestMethod(url, options) !== 'POST') return false;

    const rawUrl = typeof Request !== 'undefined' && url instanceof Request ? url.url : String(url);
    try {
      const parsed = new URL(rawUrl);
      return parsed.pathname.endsWith('/auth/v1/token')
        && parsed.searchParams.get('grant_type') === 'password';
    } catch {
      return false;
    }
  }

  private readPersistedSessionSnapshot(): string | null {
    let snapshot: string | null = null;
    try {
      const storageKey = this.options.getStorageKey();
      if (storageKey) snapshot = globalThis.localStorage.getItem(storageKey);
    } catch {
      // Storage 不可读时不存在可安全恢复的 pre-request session。
    }
    return snapshot;
  }

  private clearRequestBindings(requestId: string): void {
    const requestTokens = this.accessTokensByRequestId.get(requestId);
    if (!requestTokens) return;

    for (const accessToken of requestTokens) {
      if (this.bindingByAccessToken.get(accessToken)?.requestId === requestId) {
        this.bindingByAccessToken.delete(accessToken);
      }
    }
    this.accessTokensByRequestId.delete(requestId);
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function bundlesEqual(left: CanonicalAuthBundle, right: CanonicalAuthBundle): boolean {
  return left.session === right.session
    && left.codeVerifier === right.codeVerifier
    && left.user === right.user;
}
