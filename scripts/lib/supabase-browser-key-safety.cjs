'use strict';
const { TextDecoder, types } = require('node:util');
const { URL: TrustedURL } = require('node:url');
const PUBLISHABLE_KEY_PATTERN = /^sb_publishable_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{8}$/;
const BASE64URL_PATTERN = /^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-][AQgw]|[A-Za-z0-9_-]{2}[AEIMQUYcgkosw048])?$/;
const PROJECT_REF_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const URL_TEXT_PATTERN = /^https?:\/\/[^\\/?#@\s]+\/?$/iu;
const JSON_TOKEN_PATTERN = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u;
const WHITESPACE_PATTERN = /\s/u;
const CRLF_PATTERN = /\r\n?/mg;
const DOTENV_LINE_PATTERN = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/mg;
const DUPLICATE_ENV_ERRORS = new Map([
  ['NG_APP_SUPABASE_URL', 'supabase-browser-url-source-duplicate'],
  ['NG_APP_SUPABASE_ANON_KEY', 'supabase-browser-key-source-duplicate'],
]);
const call = Function.bind.bind(Function.call);
const arrayIsArray = Array.isArray;
const bufferFrom = Buffer.from.bind(Buffer);
const bufferPrototype = Buffer.prototype;
const isProxy = types.isProxy;
const isUint8Array = types.isUint8Array;
const jsonParse = JSON.parse;
const defineProperty = Object.defineProperty;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const getPrototypeOf = Object.getPrototypeOf;
const hasOwn = Object.hasOwn;
const objectPrototype = Object.prototype;
const regexExec = call(RegExp.prototype.exec);
const regexReplace = call(RegExp.prototype[Symbol.replace]);
const mapGet = call(Map.prototype.get);
const setAdd = call(Set.prototype.add);
const setHas = call(Set.prototype.has);
const stringCharCodeAt = call(String.prototype.charCodeAt);
const stringEndsWith = call(String.prototype.endsWith);
const stringIncludes = call(String.prototype.includes);
const stringIndexOf = call(String.prototype.indexOf);
const stringSlice = call(String.prototype.slice);
const stringToLowerCase = call(String.prototype.toLowerCase);
const typedArrayLength = call(getOwnPropertyDescriptor(getPrototypeOf(Uint8Array.prototype), 'length').get);
const TrustedError = Error;
const TrustedSet = Set;
const urlGet = Object.fromEntries(
  ['protocol', 'username', 'password', 'hostname', 'origin', 'search', 'hash', 'pathname']
    .map(name => [name, call(getOwnPropertyDescriptor(TrustedURL.prototype, name).get)]),
);
const fatalUtf8 = new TextDecoder('utf-8', { fatal: true });
const decodeUtf8 = fatalUtf8.decode.bind(fatalUtf8);
defineProperty(CRLF_PATTERN, 'exec', { value: source => regexExec(CRLF_PATTERN, source) });
defineProperty(CRLF_PATTERN, 'global', { value: true });
defineProperty(CRLF_PATTERN, 'unicode', { value: false });
function fail(code) {
  const error = new TrustedError(code);
  defineProperty(error, 'code', { value: code, configurable: true, enumerable: true, writable: true });
  throw error;
}
function attempt(code, operation) {
  try {
    return operation();
  } catch {
    fail(code);
  }
}
const isPresent = value => value !== undefined && value !== null;
function assertSupabaseBrowserCredentialEnvSource(source) {
  let text = source;
  if (typeof source !== 'string') {
    if (isProxy(source) || !isUint8Array(source)
      || getPrototypeOf(source) !== bufferPrototype) fail('supabase-browser-source-invalid');
    text = attempt('supabase-browser-source-invalid', () => decodeUtf8(source));
  }
  text = regexReplace(CRLF_PATTERN, text, '\n');
  DOTENV_LINE_PATTERN.lastIndex = 0;
  const seen = new TrustedSet();
  let match;
  while ((match = regexExec(DOTENV_LINE_PATTERN, text))) {
    const code = mapGet(DUPLICATE_ENV_ERRORS, match[1]);
    if (code && setHas(seen, match[1])) fail(code);
    if (code) setAdd(seen, match[1]);
  }
}
function decodeCanonicalBase64Url(segment) {
  if (typeof segment !== 'string' || segment.length === 0
    || !regexExec(BASE64URL_PATTERN, segment)) fail('supabase-browser-key-invalid');
  const bytes = attempt('supabase-browser-key-invalid', () => bufferFrom(segment, 'base64url'));
  if (typedArrayLength(bytes) === 0) fail('supabase-browser-key-invalid');
  return bytes;
}
function assertNoDuplicateJsonKeys(source) {
  let index = 0;
  function skipWhitespace() {
    while (regexExec(WHITESPACE_PATTERN, source[index] ?? '')) index += 1;
  }
  function readString() {
    if (source[index] !== '"') fail('supabase-browser-key-invalid');
    const start = index++;
    while (index < source.length) {
      const char = source[index++];
      if (char === '"') {
        return attempt('supabase-browser-key-invalid', () => jsonParse(stringSlice(source, start, index)));
      }
      if (stringCharCodeAt(char, 0) < 0x20) fail('supabase-browser-key-invalid');
      if (char === '\\') {
        if (index >= source.length) fail('supabase-browser-key-invalid');
        index += 1;
      }
    }
    fail('supabase-browser-key-invalid');
  }
  function readArray() {
    index += 1;
    skipWhitespace();
    if (source[index] === ']') return void (index += 1);
    for (;;) {
      readValue();
      skipWhitespace();
      if (source[index] === ']') return void (index += 1);
      if (source[index++] !== ',') fail('supabase-browser-key-invalid');
      skipWhitespace();
    }
  }
  function readObject() {
    index += 1;
    skipWhitespace();
    const keys = new TrustedSet();
    if (source[index] === '}') return void (index += 1);
    for (;;) {
      const key = readString();
      if (setHas(keys, key)) fail('supabase-browser-key-invalid');
      setAdd(keys, key);
      skipWhitespace();
      if (source[index++] !== ':') fail('supabase-browser-key-invalid');
      readValue();
      skipWhitespace();
      if (source[index] === '}') return void (index += 1);
      if (source[index++] !== ',') fail('supabase-browser-key-invalid');
      skipWhitespace();
    }
  }
  function readValue() {
    skipWhitespace();
    const char = source[index];
    if (char === '{') return readObject();
    if (char === '[') return readArray();
    if (char === '"') return readString();
    const token = regexExec(JSON_TOKEN_PATTERN, stringSlice(source, index))?.[0];
    if (!token) fail('supabase-browser-key-invalid');
    index += token.length;
  }
  readValue();
  skipWhitespace();
  if (index !== source.length) fail('supabase-browser-key-invalid');
}
function parseJsonObject(bytes) {
  const source = attempt('supabase-browser-key-invalid', () => decodeUtf8(bytes));
  attempt('supabase-browser-key-invalid', () => assertNoDuplicateJsonKeys(source));
  const value = attempt('supabase-browser-key-invalid', () => jsonParse(source));
  if (value === null || arrayIsArray(value) || getPrototypeOf(value) !== objectPrototype) {
    fail('supabase-browser-key-invalid');
  }
  return value;
}
function ownString(record, name) {
  const descriptor = getOwnPropertyDescriptor(record, name);
  return descriptor && hasOwn(descriptor, 'value') && typeof descriptor.value === 'string'
    ? descriptor.value
    : null;
}
function inspectKey(key) {
  if (!isPresent(key)) return { kind: null, projectRef: null };
  if (typeof key !== 'string') fail('supabase-browser-key-invalid');
  if (regexExec(PUBLISHABLE_KEY_PATTERN, key)) {
    return { kind: 'publishable', projectRef: null };
  }
  const firstDot = stringIndexOf(key, '.'), secondDot = stringIndexOf(key, '.', firstDot + 1);
  if (firstDot <= 0 || secondDot <= firstDot + 1 || secondDot >= key.length - 1
    || stringIndexOf(key, '.', secondDot + 1) !== -1) fail('supabase-browser-key-invalid');
  const header = parseJsonObject(decodeCanonicalBase64Url(stringSlice(key, 0, firstDot)));
  const payload = parseJsonObject(decodeCanonicalBase64Url(stringSlice(key, firstDot + 1, secondDot)));
  const signature = decodeCanonicalBase64Url(stringSlice(key, secondDot + 1));
  if (typedArrayLength(signature) !== 32) fail('supabase-browser-key-invalid');
  if (ownString(header, 'alg') !== 'HS256' || ownString(header, 'typ') !== 'JWT'
    || ownString(payload, 'iss') !== 'supabase' || ownString(payload, 'role') !== 'anon') {
    fail('supabase-browser-key-invalid');
  }
  const projectRef = ownString(payload, 'ref');
  if (!projectRef || !regexExec(PROJECT_REF_PATTERN, projectRef)) fail('supabase-browser-key-invalid');
  return { kind: 'legacy-anon-jwt', projectRef };
}
function inspectUrl(rawUrl, requireHttps = false) {
  if (!isPresent(rawUrl)) return { hostedProjectRef: null };
  if (typeof rawUrl !== 'string' || !regexExec(URL_TEXT_PATTERN, rawUrl)) {
    fail('supabase-browser-url-invalid');
  }
  const parsed = attempt('supabase-browser-url-invalid', () => new TrustedURL(rawUrl));
  const protocol = urlGet.protocol(parsed);
  const rawHostname = urlGet.hostname(parsed);
  if ((protocol !== 'http:' && protocol !== 'https:')
    || (requireHttps && protocol !== 'https:')
    || urlGet.username(parsed) || urlGet.password(parsed) || !rawHostname
    || urlGet.origin(parsed) === 'null' || urlGet.search(parsed) || urlGet.hash(parsed)
    || urlGet.pathname(parsed) !== '/') {
    fail('supabase-browser-url-invalid');
  }
  let trailingDots = 0;
  for (let index = rawHostname.length - 1; rawHostname[index] === '.'; index -= 1) trailingDots += 1;
  if (trailingDots > 1) fail('supabase-browser-url-invalid');
  const hostname = stringToLowerCase(trailingDots === 1 ? stringSlice(rawHostname, 0, -1) : rawHostname);
  if (!hostname || stringIncludes(hostname, '..') || hostname === 'supabase.co') {
    fail('supabase-browser-url-invalid');
  }
  if (!stringEndsWith(hostname, '.supabase.co')) return { hostedProjectRef: null };
  const projectRef = stringSlice(hostname, 0, -'.supabase.co'.length);
  if (protocol !== 'https:' || !regexExec(PROJECT_REF_PATTERN, projectRef)) fail('supabase-browser-url-invalid');
  return { hostedProjectRef: projectRef };
}
function readSource(sources, name) {
  const descriptor = getOwnPropertyDescriptor(sources, name);
  if (!descriptor) return undefined;
  if (!hasOwn(descriptor, 'value')) fail('supabase-browser-source-invalid');
  return descriptor.value;
}
function resolveSupabaseBrowserCredentials(sources = {}) {
  if (sources === null || typeof sources !== 'object' || isProxy(sources)
    || arrayIsArray(sources)) {
    fail('supabase-browser-source-invalid');
  }
  const sourcePrototype = getPrototypeOf(sources);
  if (sourcePrototype !== objectPrototype && sourcePrototype !== null) {
    fail('supabase-browser-source-invalid');
  }
  const processUrl = readSource(sources, 'processUrl');
  const localUrl = readSource(sources, 'localUrl');
  const processKey = readSource(sources, 'processKey');
  const localKey = readSource(sources, 'localKey');
  const localEnvSource = readSource(sources, 'localEnvSource');
  const requireHttps = readSource(sources, 'requireHttps');
  if (isPresent(requireHttps) && typeof requireHttps !== 'boolean') {
    fail('supabase-browser-source-invalid');
  }
  const enforceHttps = requireHttps === true;
  if (isPresent(localEnvSource)) assertSupabaseBrowserCredentialEnvSource(localEnvSource);
  const processUrlInfo = inspectUrl(processUrl, enforceHttps);
  const localUrlInfo = inspectUrl(localUrl, enforceHttps);
  const processKeyInfo = inspectKey(processKey);
  const localKeyInfo = inspectKey(localKey);
  if (isPresent(processUrl) && isPresent(localUrl) && processUrl !== localUrl) {
    fail('supabase-browser-url-source-conflict');
  }
  if (isPresent(processKey) && isPresent(localKey) && processKey !== localKey) {
    fail('supabase-browser-key-source-conflict');
  }
  const keySource = isPresent(processKey) ? 'process' : isPresent(localKey) ? 'local' : null;
  const urlSource = isPresent(processUrl) ? 'process' : isPresent(localUrl) ? 'local' : null;
  const keyInfo = keySource === 'process' ? processKeyInfo : localKeyInfo;
  const urlInfo = urlSource === 'process' ? processUrlInfo : localUrlInfo;
  if (keyInfo.projectRef && urlInfo.hostedProjectRef
    && keyInfo.projectRef !== urlInfo.hostedProjectRef) {
    fail('supabase-browser-project-ref-mismatch');
  }
  return {
    keySource,
    urlSource,
    keyKind: keyInfo.kind,
    hostedProjectRef: urlInfo.hostedProjectRef,
  };
}
module.exports = { resolveSupabaseBrowserCredentials };
