'use strict';

const SECRET_FIELD = /^CONTEXT7_API_KEY(?:_.*)?$/i;

function createRedactor(secretValues) {
  const secrets = [...new Set(secretValues.filter(value => typeof value === 'string' && value))]
    .sort((a, b) => b.length - a.length);
  const cleanString = value => secrets.reduce(
    (current, secret) => current.split(secret).join('[REDACTED_SECRET]'),
    value,
  );
  return input => {
    const seen = new WeakMap();
    const visit = (value, key = '') => {
      if (SECRET_FIELD.test(key)) return '[REDACTED_SECRET]';
      if (typeof value === 'function') return '[Function]';
      if (typeof value === 'string') return cleanString(value);
      if (!value || typeof value !== 'object') return value;
      if (seen.has(value)) return '[Circular]';
      if (Array.isArray(value)) {
        const copy = [];
        seen.set(value, copy);
        for (const child of value) copy.push(visit(child));
        return copy;
      }
      const copy = {};
      seen.set(value, copy);
      if (value instanceof Error) {
        copy.name = visit(value.name, 'name');
        copy.message = visit(value.message, 'message');
        if (value.stack) copy.stack = visit(value.stack, 'stack');
        if ('cause' in value) copy.cause = visit(value.cause, 'cause');
      }
      for (const [childKey, child] of Object.entries(value)) {
        const redactedChildKey = cleanString(childKey);
        let destinationKey = redactedChildKey;
        let collisionIndex = 2;
        while (Object.hasOwn(copy, destinationKey)) {
          destinationKey = `${redactedChildKey}#${collisionIndex}`;
          collisionIndex += 1;
        }
        copy[destinationKey] = visit(child, childKey);
      }
      return copy;
    };
    return visit(input);
  };
}

module.exports = { createRedactor };
