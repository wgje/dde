(function installNanoflowAuthCanonicalStorage(global) {
  'use strict';

  var AUTHORITY_KEY = '__NANOFLOW_AUTH_CANONICAL_STORAGE__';
  var CALLBACK_CAPTURE_KEY = '__NANOFLOW_AUTH_CALLBACK_CAPTURE__';
  var LOCK_NAME = 'nanoflow-auth-canonical-storage-v1';
  var windowObject = global.window || global;
  var generationSequence = 0;

  if (Object.prototype.hasOwnProperty.call(global, AUTHORITY_KEY)) return;

  function canonicalKeys(storageKey) {
    return {
      session: storageKey,
      codeVerifier: storageKey + '-code-verifier',
      user: storageKey + '-user'
    };
  }

  function readBundleUnlocked(storageKey) {
    var keys = canonicalKeys(storageKey);
    return {
      session: localStorage.getItem(keys.session),
      codeVerifier: localStorage.getItem(keys.codeVerifier),
      user: localStorage.getItem(keys.user)
    };
  }

  function bundlesEqual(left, right) {
    return Boolean(left && right)
      && left.session === right.session
      && left.codeVerifier === right.codeVerifier
      && left.user === right.user;
  }

  function writeValue(key, value) {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  }

  function writeBundleUnlocked(storageKey, next, rollback) {
    var keys = canonicalKeys(storageKey);
    try {
      writeValue(keys.session, next.session);
      writeValue(keys.codeVerifier, next.codeVerifier);
      writeValue(keys.user, next.user);
    } catch (error) {
      try {
        writeValue(keys.session, rollback.session);
        writeValue(keys.codeVerifier, rollback.codeVerifier);
        writeValue(keys.user, rollback.user);
      } catch (_rollbackError) {
        throw new Error('AUTH_CANONICAL_STORAGE_ROLLBACK_FAILED');
      }
      throw error;
    }
  }

  function withCanonicalLock(callback) {
    var locks = global.navigator && global.navigator.locks;
    if (!locks || typeof locks.request !== 'function') {
      return Promise.reject(new Error('AUTH_CANONICAL_LOCK_UNAVAILABLE'));
    }
    return locks.request(LOCK_NAME, { mode: 'exclusive' }, callback);
  }

  function readBundle(storageKey) {
    return withCanonicalLock(function() {
      return readBundleUnlocked(storageKey);
    });
  }

  function peekBundle(storageKey) {
    return cloneBundle(readBundleUnlocked(storageKey));
  }

  function compareAndSwap(input, authorize) {
    return withCanonicalLock(function() {
      if (authorize) authorize();
      var current = readBundleUnlocked(input.storageKey);
      if (!bundlesEqual(current, input.expected)) {
        throw new Error('AUTH_CANONICAL_STORAGE_MISMATCH');
      }
      if (bundlesEqual(current, input.next)) return 'noop';
      writeBundleUnlocked(input.storageKey, input.next, current);
      return 'committed';
    });
  }

  function isCallbackClaimMarker(value) {
    if (!value || value.charAt(0) !== '{') return false;
    try {
      var parsed = JSON.parse(value);
      return parsed.kind === 'nanoflow-auth-callback' && parsed.version === 1;
    } catch (_error) {
      return false;
    }
  }

  function claimCallbackVerifier(input) {
    return withCanonicalLock(function() {
      var claimantStorage = global.sessionStorage;
      if (!claimantStorage || typeof claimantStorage.setItem !== 'function') {
        throw new Error('AUTH_CALLBACK_CLAIMANT_STORAGE_UNAVAILABLE');
      }
      var current = readBundleUnlocked(input.storageKey);
      if (!bundlesEqual(current, input.expected)) {
        throw new Error('AUTH_CANONICAL_STORAGE_MISMATCH');
      }
      if (!current.codeVerifier) throw new Error('AUTH_CALLBACK_VERIFIER_MISSING');
      if (isCallbackClaimMarker(current.codeVerifier)) {
        throw new Error('AUTH_CALLBACK_VERIFIER_ALREADY_CLAIMED');
      }
      writeBundleUnlocked(input.storageKey, {
        session: current.session,
        codeVerifier: input.marker,
        user: current.user
      }, current);
      try {
        claimantStorage.setItem(input.claimantKey, JSON.stringify(Object.assign(
          {},
          input.envelope,
          { verifier: current.codeVerifier }
        )));
      } catch (_error) {
        throw new Error('AUTH_CALLBACK_CLAIMANT_STORAGE_FAILED');
      }
      return 'claimed';
    });
  }

  function captureAndScrubAuthCallback() {
    var existing = Object.getOwnPropertyDescriptor(global, CALLBACK_CAPTURE_KEY);
    if (existing) return existing.value;
    var location = global.location;
    var history = global.history;
    function makeCapture(blocked, code, hasAuthError) {
      var claimed = false;
      return Object.freeze({
        version: 1,
        blocked: blocked,
        capturedAt: Date.now(),
        hasAuthError: hasAuthError,
        claimCode: function() {
          if (blocked || claimed) return null;
          claimed = true;
          var claimedCode = code;
          code = null;
          return claimedCode;
        }
      });
    }
    var empty = makeCapture(false, null, false);
    if (!location || !history) return empty;
    var current = new URL(location.href);
    var direct = current.pathname.replace(/\/+$/, '') === '/auth/callback';
    var hashRoute = current.hash.indexOf('#/auth/callback') === 0 ? current.hash.slice(1) : '';
    if (!direct && !hashRoute) return empty;
    var hashQuery = hashRoute.indexOf('?') >= 0 ? hashRoute.slice(hashRoute.indexOf('?') + 1) : '';
    var hashParams = new URLSearchParams(hashQuery);
    var opaqueHash = direct && current.hash && current.hash.indexOf('#/') !== 0;
    var opaqueParams = new URLSearchParams(opaqueHash ? current.hash.slice(1) : '');
    var errorKeys = ['error', 'error_code', 'error_description'];
    var hasAuthError = errorKeys.some(function(key) {
      return current.searchParams.has(key) || hashParams.has(key) || opaqueParams.has(key);
    }) || opaqueParams.has('access_token') || opaqueParams.has('refresh_token');
    var code = current.searchParams.get('code') || hashParams.get('code');
    var capture = makeCapture(false, code, hasAuthError);
    try {
      history.replaceState(null, '', '/#/auth/callback');
    } catch (_error) {
      capture = makeCapture(true, null, hasAuthError);
    }
    Object.defineProperty(global, CALLBACK_CAPTURE_KEY, {
      configurable: false,
      enumerable: false,
      value: capture,
      writable: false
    });
    return capture;
  }

  function cloneBundle(bundle) {
    return {
      session: bundle.session,
      codeVerifier: bundle.codeVerifier,
      user: bundle.user
    };
  }

  function generationField(generationKey, key) {
    if (key === generationKey) return 'session';
    if (key === generationKey + '-code-verifier') return 'codeVerifier';
    if (key === generationKey + '-user') return 'user';
    return null;
  }

  function nextGenerationKey(storageKey) {
    generationSequence += 1;
    var randomPart = Math.random().toString(36).slice(2);
    return storageKey + '-nanoflow-g-' + Date.now().toString(36)
      + '-' + generationSequence.toString(36) + '-' + randomPart;
  }

  async function createGeneration(storageKey) {
    var expected = await readBundle(storageKey);
    var staged = cloneBundle(expected);
    var generationKey = nextGenerationKey(storageKey);
    var state = 'candidate';
    var wasCurrent = false;

    async function commitField(field, value) {
      var next = cloneBundle(expected);
      next[field] = value;
      await compareAndSwap({ storageKey: storageKey, expected: expected, next: next }, function() {
        if (state === 'retired') throw new Error('AUTH_CANONICAL_GENERATION_RETIRED');
      });
      expected = next;
      staged = cloneBundle(next);
    }

    async function removeCommittedField(field) {
      await withCanonicalLock(function() {
        var current = readBundleUnlocked(storageKey);
        if (state === 'retired') {
          if (!wasCurrent || !bundlesEqual(current, expected)) return;
        } else if (!bundlesEqual(current, expected)) {
          throw new Error('AUTH_CANONICAL_STORAGE_MISMATCH');
        }
        var next = cloneBundle(expected);
        next[field] = null;
        if (!bundlesEqual(current, next)) writeBundleUnlocked(storageKey, next, current);
        expected = next;
        staged = cloneBundle(next);
      });
    }

    var storage = Object.freeze({
      getItem: async function(key) {
        var field = generationField(generationKey, key);
        return field ? staged[field] : null;
      },
      setItem: async function(key, value) {
        var field = generationField(generationKey, key);
        if (!field) return;
        if (state === 'retired') throw new Error('AUTH_CANONICAL_GENERATION_RETIRED');
        if (state === 'candidate') {
          staged[field] = String(value);
          return;
        }
        await commitField(field, String(value));
      },
      removeItem: async function(key) {
        var field = generationField(generationKey, key);
        if (!field) return;
        if (state === 'candidate') {
          staged[field] = null;
          return;
        }
        await removeCommittedField(field);
      }
    });

    return Object.freeze({
      storageKey: generationKey,
      storage: storage,
      promote: async function() {
        if (state === 'retired') throw new Error('AUTH_CANONICAL_GENERATION_RETIRED');
        if (state === 'current') return 'noop';
        var result = await compareAndSwap({
          storageKey: storageKey,
          expected: expected,
          next: staged
        }, function() {
          if (state === 'retired') throw new Error('AUTH_CANONICAL_GENERATION_RETIRED');
        });
        expected = cloneBundle(staged);
        state = 'current';
        wasCurrent = true;
        return result;
      },
      retire: function() {
        state = 'retired';
      }
    });
  }

  function pushTrace(event, detail) {
    if (typeof windowObject.__NANOFLOW_PUSH_STARTUP_TRACE__ === 'function') {
      windowObject.__NANOFLOW_PUSH_STARTUP_TRACE__(event, detail);
    }
  }

  function setPrewarmStatus(status, session) {
    var state = { status: status };
    if (session !== undefined) state.session = session;
    windowObject.__NANOFLOW_SESSION_PREWARM__ = state;
  }

  function resolveStorageKey(supabaseUrl) {
    try {
      var hostname = new URL(supabaseUrl).hostname;
      var ref = hostname.split('.')[0];
      return ref ? 'sb-' + ref + '-auth-token' : '';
    } catch (_error) {
      return '';
    }
  }

  function resolveSessionRecord(raw) {
    if (!raw) return null;
    var parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.currentSession && typeof parsed.currentSession === 'object') {
      return parsed.currentSession;
    }
    if (parsed.session && typeof parsed.session === 'object') return parsed.session;
    return parsed;
  }

  function isCanonicalMismatch(error) {
    return error instanceof Error && error.message === 'AUTH_CANONICAL_STORAGE_MISMATCH';
  }

  async function invalidatePrewarmSession(storageKey, expected, response, errorData) {
    try {
      await compareAndSwap({
        storageKey: storageKey,
        expected: expected,
        next: {
          session: null,
          codeVerifier: expected.codeVerifier,
          user: null
        }
      });
      try { localStorage.removeItem('nanoflow.auth-cache'); } catch (_error) { /* ignore hint cleanup */ }
      setPrewarmStatus('failed');
      pushTrace('auth.prewarm_invalidated', {
        status: response.status,
        error: errorData && (errorData.message || errorData.error || errorData.error_description)
      });
    } catch (error) {
      if (!isCanonicalMismatch(error)) throw error;
      setPrewarmStatus('superseded');
      pushTrace('auth.prewarm_superseded', { status: response.status });
    }
  }

  async function startSessionPrewarm(input) {
    setPrewarmStatus('idle');
    pushTrace('auth.prewarm_initialized', { status: 'idle' });
    if (!input || !input.bootFlags || input.bootFlags.AUTH_RUNTIME_GATE_V1 !== false) {
      pushTrace('auth.prewarm_skipped', { reason: 'auth_runtime_gate' });
      return;
    }
    if (!input.supabaseUrl || !input.supabaseAnonKey) return;

    var storageKey = resolveStorageKey(input.supabaseUrl);
    if (!storageKey) return;

    try {
      var expected = await readBundle(storageKey);
      var authData = resolveSessionRecord(expected.session);
      var refreshToken = authData && typeof authData.refresh_token === 'string'
        ? authData.refresh_token
        : null;
      if (!refreshToken) return;

      var expiresAt = typeof authData.expires_at === 'number' ? authData.expires_at : null;
      if (expiresAt !== null) {
        if (expiresAt < 1e12) expiresAt *= 1000;
        if (expiresAt > Date.now() + 600000) return;
      }

      setPrewarmStatus('pending');
      pushTrace('auth.prewarm_pending');
      var response = await fetch(input.supabaseUrl + '/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        headers: { apikey: input.supabaseAnonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken })
      });
      if (!response.ok) {
        var errorData = await response.json().catch(function() { return null; });
        if (response.status === 400 || response.status === 401) {
          await invalidatePrewarmSession(storageKey, expected, response, errorData);
          return;
        }
        setPrewarmStatus('failed');
        pushTrace('auth.prewarm_failed', { status: response.status });
        return;
      }

      var data = await response.json();
      if (!data || !data.access_token) return;
      var newSession = {
        access_token: data.access_token,
        refresh_token: data.refresh_token || refreshToken,
        expires_in: data.expires_in,
        expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
        token_type: data.token_type || 'bearer',
        user: data.user || (authData && authData.user) || null
      };
      await compareAndSwap({
        storageKey: storageKey,
        expected: expected,
        next: {
          session: JSON.stringify(newSession),
          codeVerifier: expected.codeVerifier,
          user: expected.user
        }
      });
      setPrewarmStatus('refreshed', newSession);
      pushTrace('auth.prewarm_refreshed');
    } catch (error) {
      if (isCanonicalMismatch(error)) {
        setPrewarmStatus('superseded');
        pushTrace('auth.prewarm_superseded');
        return;
      }
      setPrewarmStatus('failed');
      pushTrace('auth.prewarm_failed', {
        reason: error instanceof Error && error.message === 'AUTH_CANONICAL_LOCK_UNAVAILABLE'
          ? 'canonical_lock_unavailable'
          : 'network'
      });
    }
  }

  var authority = Object.freeze({
    captureAndScrubAuthCallback: captureAndScrubAuthCallback,
    claimCallbackVerifier: claimCallbackVerifier,
    compareAndSwap: compareAndSwap,
    createGeneration: createGeneration,
    peekBundle: peekBundle,
    readBundle: readBundle,
    startSessionPrewarm: startSessionPrewarm
  });
  Object.defineProperty(global, AUTHORITY_KEY, {
    configurable: false,
    enumerable: false,
    value: authority,
    writable: false
  });
  if (windowObject !== global) {
    Object.defineProperty(windowObject, AUTHORITY_KEY, {
      configurable: false,
      enumerable: false,
      value: authority,
      writable: false
    });
  }
})(globalThis);
