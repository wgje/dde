import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractErrorStack,
  isGojsOverviewOriginRectNoise,
} from './gojs-overview-noise';

const mainSource = readFileSync(join(process.cwd(), 'main.ts'), 'utf8');
const errorHandlerSource = readFileSync(join(process.cwd(), 'src/services/global-error-handler.service.ts'), 'utf8');

describe('isGojsOverviewOriginRectNoise', () => {
  it('matches ASCII width messages only with _getOriginRect stack', () => {
    expect(
      isGojsOverviewOriginRectNoise(
        "Cannot read properties of null (reading 'width')",
        'at pe._getOriginRect (chunk-abc.js:1:2)',
      ),
    ).toBe(true);
  });

  it('matches double-quoted width messages only with _getOriginRect stack', () => {
    expect(
      isGojsOverviewOriginRectNoise(
        'Cannot read properties of null (reading "width")',
        'at pe._getOriginRect (chunk-abc.js:1:2)',
      ),
    ).toBe(true);
  });

  it('matches Unicode curly double-quoted width messages', () => {
    const leftQuote = String.fromCharCode(0x201c);
    const rightQuote = String.fromCharCode(0x201d);
    const message = 'Cannot read properties of null (reading ' + leftQuote + 'width' + rightQuote + ')';

    expect(
      isGojsOverviewOriginRectNoise(
        message,
        'at pe._getOriginRect (chunk-abc.js:1:2)',
      ),
    ).toBe(true);
  });

  it('matches Unicode curly quote width messages', () => {
    expect(
      isGojsOverviewOriginRectNoise(
        'Cannot read properties of null (reading \u2018width\u2019)',
        'at pe._getOriginRect (chunk-abc.js:1:2)',
      ),
    ).toBe(true);
  });

  it('requires _getOriginRect and does not match ordinary null width errors', () => {
    expect(
      isGojsOverviewOriginRectNoise(
        "Cannot read properties of null (reading 'width')",
        'at Component.ngOnInit (main.js:1:2)',
      ),
    ).toBe(false);
    expect(
      isGojsOverviewOriginRectNoise(
        'Unexpected error',
        'at pe._getOriginRect (chunk-abc.js:1:2)',
      ),
    ).toBe(false);
  });

  it('returns false for null or undefined predicate inputs', () => {
    const stack = 'at pe._getOriginRect (chunk-abc.js:1:2)';
    const message = "Cannot read properties of null (reading 'width')";

    expect(isGojsOverviewOriginRectNoise(null, stack)).toBe(false);
    expect(isGojsOverviewOriginRectNoise(undefined, stack)).toBe(false);
    expect(isGojsOverviewOriginRectNoise(message, null)).toBe(false);
    expect(isGojsOverviewOriginRectNoise(message, undefined)).toBe(false);
  });

  it('does not suppress non-GoJS null-width errors with an ordinary stack', () => {
    expect(
      isGojsOverviewOriginRectNoise(
        "Cannot read properties of null (reading 'width')",
        'at Component.render (main.js:1:2)',
      ),
    ).toBe(false);
  });

  it('does not suppress other GoJS methods with the same null-width message', () => {
    expect(
      isGojsOverviewOriginRectNoise(
        "Cannot read properties of null (reading 'width')",
        'at pe.getDocumentBounds (gojs.js:1:2)',
      ),
    ).toBe(false);
  });

  it('requires both message and stack and never matches stack-only or message-only input', () => {
    const message = "Cannot read properties of null (reading 'width')";
    const stack = 'at pe._getOriginRect (chunk-abc.js:1:2)';

    expect(isGojsOverviewOriginRectNoise(message, '')).toBe(false);
    expect(isGojsOverviewOriginRectNoise('', stack)).toBe(false);
    expect(isGojsOverviewOriginRectNoise(message, 0 as unknown as string)).toBe(false);
    expect(isGojsOverviewOriginRectNoise(0 as unknown as string, stack)).toBe(false);
  });
});

describe('extractErrorStack', () => {
  it('returns a string error unchanged', () => {
    expect(extractErrorStack('raw stack')).toBe('raw stack');
  });

  it('returns a direct stack', () => {
    expect(extractErrorStack({ stack: 'direct' })).toBe('direct');
  });

  it('returns a nested ErrorEvent.error stack', () => {
    expect(
      extractErrorStack({ error: { stack: 'nested' } }),
    ).toBe('nested');
  });

  it('returns a PromiseRejectionEvent.reason stack', () => {
    expect(
      extractErrorStack({ reason: { stack: 'reason' } }),
    ).toBe('reason');
  });

  it('returns undefined for non-object input without a usable stack', () => {
    expect(extractErrorStack(42)).toBeUndefined();
    expect(extractErrorStack({})).toBeUndefined();
  });

  it('returns a real Error instance stack', () => {
    const error = new Error('real error');

    expect(extractErrorStack(error)).toBe(error.stack);
  });

  it('returns ErrorEvent.error stack when ErrorEvent is available', () => {
    if (typeof ErrorEvent === 'undefined') return;

    const error = new Error('event error');
    const event = new ErrorEvent('error', { error });

    expect(extractErrorStack(event)).toBe(error.stack);
  });
});

describe('single shared authority', () => {
  it('main.ts imports the shared functions instead of duplicating them', () => {
    expect(mainSource).toContain(
      "import { isGojsOverviewOriginRectNoise, extractErrorStack as extractAnyErrorStack } from './src/utils/gojs-overview-noise';",
    );
    expect(mainSource).not.toMatch(/const NULL_WIDTH_PATTERN/);
    expect(mainSource).not.toMatch(/const ORIGIN_RECT_PATTERN/);
    expect(mainSource).not.toMatch(/function isGojsOverviewOriginRectNoise/);
    expect(mainSource).not.toMatch(/function extractAnyErrorStack/);
  });

  it('GlobalErrorHandler imports from the same shared utility', () => {
    expect(errorHandlerSource).toContain(
      "from '../utils/gojs-overview-noise';",
    );
  });
});
