import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const foregroundEntries = [
  'src/app/core/external-sources',
  'src/app/features',
  'src/app/shared',
  'src/app/core/shell',
  'src/workspace-shell.component.ts',
];

const bannedWritePatterns: Array<{ label: string; pattern: RegExp }> = [
  {
    label: 'direct table write',
    pattern: /(?<!Array)\.from\s*\([^)]*\)[\s\S]{0,400}?\.(?:insert|update|upsert|delete)\s*\(/g,
  },
  {
    label: 'direct RPC call',
    pattern: /\.rpc\s*\(/g,
  },
  {
    label: 'direct storage mutation',
    pattern: /\.storage\s*\.from\s*\([^)]*\)[\s\S]{0,400}?\.(?:upload|remove)\s*\(/g,
  },
  {
    label: 'direct edge function invocation',
    pattern: /\.functions\s*\.invoke\s*\(/g,
  },
];

function isSourceFile(filePath: string): boolean {
  return /\.tsx?$/.test(filePath)
    && !/(\.spec|\.test|spec-helpers)\.tsx?$/.test(filePath);
}

function collectSourceFiles(entry: string): string[] {
  const absolutePath = path.join(process.cwd(), entry);
  const stat = fs.statSync(absolutePath);
  if (stat.isFile()) {
    return isSourceFile(absolutePath) ? [absolutePath] : [];
  }

  return fs.readdirSync(absolutePath, { withFileTypes: true })
    .flatMap(child => {
      const childEntry = path.join(entry, child.name);
      if (child.isDirectory()) {
        return collectSourceFiles(childEntry);
      }
      return collectSourceFiles(childEntry);
    });
}

function stripCommentsAndStrings(source: string): string {
  let result = '';
  let index = 0;
  let state: 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'template' = 'code';

  while (index < source.length) {
    const char = source[index] ?? '';
    const next = source[index + 1] ?? '';

    if (state === 'line-comment') {
      result += char === '\n' ? '\n' : ' ';
      state = char === '\n' ? 'code' : state;
      index += 1;
      continue;
    }

    if (state === 'block-comment') {
      result += char === '\n' ? '\n' : ' ';
      if (char === '*' && next === '/') {
        result += ' ';
        index += 2;
        state = 'code';
      } else {
        index += 1;
      }
      continue;
    }

    if (state === 'single' || state === 'double' || state === 'template') {
      const quote = state === 'single' ? '\'' : state === 'double' ? '"' : '`';
      result += char === '\n' ? '\n' : ' ';
      if (char === '\\') {
        result += next === '\n' ? '\n' : ' ';
        index += 2;
      } else if (char === quote) {
        state = 'code';
        index += 1;
      } else {
        index += 1;
      }
      continue;
    }

    if (char === '/' && next === '/') {
      result += '  ';
      index += 2;
      state = 'line-comment';
      continue;
    }
    if (char === '/' && next === '*') {
      result += '  ';
      index += 2;
      state = 'block-comment';
      continue;
    }
    if (char === '\'') {
      result += ' ';
      index += 1;
      state = 'single';
      continue;
    }
    if (char === '"') {
      result += ' ';
      index += 1;
      state = 'double';
      continue;
    }
    if (char === '`') {
      result += ' ';
      index += 1;
      state = 'template';
      continue;
    }

    result += char;
    index += 1;
  }

  return result;
}

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

describe('foreground Supabase write boundary contract', () => {
  it('keeps foreground UI and shell code off direct Supabase data mutations', () => {
    const violations = foregroundEntries
      .flatMap(collectSourceFiles)
      .flatMap(filePath => {
        const source = fs.readFileSync(filePath, 'utf8');
        const searchableSource = stripCommentsAndStrings(source);
        const relativePath = path.relative(process.cwd(), filePath).replace(/\\/g, '/');

        return bannedWritePatterns.flatMap(({ label, pattern }) => {
          pattern.lastIndex = 0;
          return Array.from(searchableSource.matchAll(pattern), match => ({
            file: relativePath,
            line: lineAt(searchableSource, match.index ?? 0),
            label,
            snippet: match[0].replace(/\s+/g, ' ').slice(0, 120),
          }));
        });
      });

    expect(violations).toEqual([]);
  });
});
