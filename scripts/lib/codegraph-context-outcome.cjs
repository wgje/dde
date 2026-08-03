'use strict';

const NANO_FLOW_CONTEXT_OUTCOME_SCHEMA_VERSION = 1;
const OVERLAY_STALE_SKIP_REFRESH_FAILURE_CLASS = 'overlay-stale-skip-refresh';
const OUTCOME_STATUSES = new Set(['complete', 'partial', 'failed']);
const BASE_STATUSES = new Set(['available', 'unavailable']);
const OVERLAY_STATUSES = new Set(['available', 'stale', 'unavailable']);
const OUTCOME_KEYS = new Set([
  'schemaVersion', 'status', 'usableContext', 'primaryFailureClass', 'base', 'overlay',
]);
const BASE_KEYS = new Set(['status', 'isError', 'textBytes']);
const OVERLAY_KEYS = new Set(['status', 'isError', 'failureClass', 'generationId']);

function buildNanoFlowContextOutcomeV1({
  base = {},
  overlay = {},
  primaryFailureClass = null,
} = {}) {
  const baseTextBytes = normalizeTextBytes(base.textBytes, base.text);
  const baseIsError = Boolean(base.isError);
  const baseExplicitlyUnavailable = base.status === 'unavailable' || base.available === false;
  const baseStatus = !baseExplicitlyUnavailable && !baseIsError && baseTextBytes > 0
    ? 'available'
    : 'unavailable';
  const overlayFailureClass = normalizeNullableString(overlay.failureClass);
  const overlayIsError = Boolean(overlay.isError);
  const overlayExplicitlyAvailable = overlay.status === 'available' || overlay.available === true;
  const overlayExplicitlyUnavailable = overlay.status === 'unavailable' || overlay.available === false;
  const overlayStatus = overlayFailureClass === OVERLAY_STALE_SKIP_REFRESH_FAILURE_CLASS
    ? 'stale'
    : (!overlayExplicitlyUnavailable && overlayExplicitlyAvailable && !overlayIsError && !overlayFailureClass
        ? 'available'
        : 'unavailable');
  const availableCount = Number(baseStatus === 'available') + Number(overlayStatus === 'available');
  const status = availableCount === 2 ? 'complete' : (availableCount === 1 ? 'partial' : 'failed');
  const usableContext = availableCount > 0;
  const fallbackFailureClass = baseStatus === 'available'
    ? 'overlay-unavailable'
    : (overlayStatus === 'available' ? 'base-codegraph-unavailable' : 'context-unavailable');
  const normalizedPrimaryFailureClass = normalizeNullableString(primaryFailureClass)
    ?? normalizeNullableString(base.failureClass)
    ?? overlayFailureClass
    ?? fallbackFailureClass;

  return {
    schemaVersion: NANO_FLOW_CONTEXT_OUTCOME_SCHEMA_VERSION,
    status,
    usableContext,
    primaryFailureClass: status === 'complete'
      ? null
      : normalizedPrimaryFailureClass,
    base: {
      status: baseStatus,
      isError: baseIsError,
      textBytes: baseTextBytes,
    },
    overlay: {
      status: overlayStatus,
      isError: overlayStatus !== 'available',
      failureClass: overlayStatus === 'available' ? null : overlayFailureClass,
      generationId: normalizeNullableString(overlay.generationId),
    },
  };
}

function parseNanoFlowContextOutcomeV1(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!hasExactKeys(value, OUTCOME_KEYS)) return null;
  if (value.schemaVersion !== NANO_FLOW_CONTEXT_OUTCOME_SCHEMA_VERSION) return null;
  if (!OUTCOME_STATUSES.has(value.status) || typeof value.usableContext !== 'boolean') return null;
  if (!value.base || typeof value.base !== 'object' || Array.isArray(value.base)) return null;
  if (!hasExactKeys(value.base, BASE_KEYS) || !BASE_STATUSES.has(value.base.status)) return null;
  if (typeof value.base.isError !== 'boolean' || !isNonNegativeInteger(value.base.textBytes)) return null;
  if (!value.overlay || typeof value.overlay !== 'object' || Array.isArray(value.overlay)) return null;
  if (!hasExactKeys(value.overlay, OVERLAY_KEYS) || !OVERLAY_STATUSES.has(value.overlay.status)) return null;
  if (typeof value.overlay.isError !== 'boolean') return null;
  if (!isNullableString(value.primaryFailureClass) || !isNullableString(value.overlay.failureClass)) return null;
  if (!isNullableString(value.overlay.generationId)) return null;
  if (value.status !== 'complete' && value.primaryFailureClass === null) return null;
  if (value.base.status === 'available' && (value.base.isError || value.base.textBytes === 0)) return null;
  if (value.overlay.status === 'available' && (value.overlay.isError || value.overlay.failureClass !== null)) return null;

  const canonical = buildNanoFlowContextOutcomeV1({
    primaryFailureClass: value.primaryFailureClass,
    base: {
      status: value.base.status,
      isError: value.base.isError,
      textBytes: value.base.textBytes,
    },
    overlay: {
      status: value.overlay.status,
      isError: value.overlay.isError,
      failureClass: value.overlay.failureClass,
      generationId: value.overlay.generationId,
    },
  });
  return canonical.status === value.status
    && canonical.usableContext === value.usableContext
    && canonical.primaryFailureClass === value.primaryFailureClass
    && canonical.base.status === value.base.status
    && canonical.base.isError === value.base.isError
    && canonical.base.textBytes === value.base.textBytes
    && canonical.overlay.status === value.overlay.status
    && canonical.overlay.isError === value.overlay.isError
    && canonical.overlay.failureClass === value.overlay.failureClass
    && canonical.overlay.generationId === value.overlay.generationId
    ? canonical
    : null;
}

function isNanoFlowContextOutcomeError(outcome) {
  return parseNanoFlowContextOutcomeV1(outcome)?.status !== 'complete';
}

function normalizeTextBytes(value, text) {
  if (typeof text === 'string') return Buffer.byteLength(text, 'utf8');
  if (isNonNegativeInteger(value)) return value;
  return 0;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function hasExactKeys(value, expectedKeys) {
  const keys = Object.keys(value);
  return keys.length === expectedKeys.size && keys.every(key => expectedKeys.has(key));
}

function normalizeNullableString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isNullableString(value) {
  return value === null || (typeof value === 'string' && value.trim().length > 0);
}

module.exports = {
  NANO_FLOW_CONTEXT_OUTCOME_SCHEMA_VERSION,
  OVERLAY_STALE_SKIP_REFRESH_FAILURE_CLASS,
  buildNanoFlowContextOutcomeV1,
  classifyNanoFlowContextOutcomeV1: buildNanoFlowContextOutcomeV1,
  parseNanoFlowContextOutcomeV1,
  isNanoFlowContextOutcomeError,
};
