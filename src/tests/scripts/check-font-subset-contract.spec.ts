import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, type TestContext } from 'vitest';

const sourceRunner = path.join(process.cwd(), 'scripts', 'check-font-subset-contract.cjs');
const tempRoots: string[] = [];
const artifacts = [
  'public/fonts/lxgwwenkaiscreen-subset-117.woff2',
  'public/fonts/lxgwwenkaiscreen-subset-118.woff2',
] as const;
const successMarker = '通过：subset-117/118';

function validWoff2(): Buffer {
  const buffer = Buffer.alloc(48);
  buffer.write('wOF2', 0, 'ascii');
  return buffer;
}

function artifactPath(root: string, index: number): string {
  return path.join(root, ...artifacts[index].split('/'));
}

function createFixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'nanoflow-font-contract-'));
  tempRoots.push(root);
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  mkdirSync(path.join(root, 'public', 'fonts'), { recursive: true });
  copyFileSync(sourceRunner, path.join(root, 'scripts', 'check-font-subset-contract.cjs'));
  writeFileSync(path.join(root, 'main.ts'), "const font = 'LXGW WenKai Screen';\n");
  writeFileSync(
    path.join(root, 'public', 'fonts', 'lxgw-wenkai-screen.css'),
    artifacts.map(file => `src: url('/${file.slice('public/'.length)}');`).join('\n'),
  );
  for (let index = 0; index < artifacts.length; index += 1) {
    writeFileSync(artifactPath(root, index), validWoff2());
  }
  return root;
}

function runGuard(root: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'check-font-subset-contract.cjs')], {
    cwd: path.dirname(root),
    encoding: 'utf8',
    timeout: 5_000,
  });
}

function expectFailure(
  root: string,
  result: SpawnSyncReturns<string>,
  reason: string,
  relativePath: string,
): void {
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout).not.toContain(successMarker);
  expect(result.stderr.trim()).toBe(`[check-font-subset-contract] ❌ ${reason}:${relativePath}`);
  expect(result.stderr).not.toContain(root);
}

function symlinkOrSkip(context: TestContext, target: string, link: string): boolean {
  try {
    symlinkSync(target, link, 'file');
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      context.skip();
      return false;
    }
    throw error;
  }
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    for (let index = 0; index < artifacts.length; index += 1) {
      try {
        chmodSync(artifactPath(root, index), 0o600);
      } catch {
        // The artifact may intentionally be absent or non-regular.
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe('font subset artifact evidence', () => {
  it.each([
    ['both artifacts', [0, 1], 0],
    ['subset 117', [0], 0],
    ['subset 118', [1], 1],
  ] as const)('fails when %s are absent', (_name, missing, expectedIndex) => {
    const root = createFixture();
    for (const index of missing) rmSync(artifactPath(root, index));
    expectFailure(root, runGuard(root), 'font-subset-evidence-unavailable', artifacts[expectedIndex]);
  });

  it('rejects a directory artifact', () => {
    const root = createFixture();
    rmSync(artifactPath(root, 0));
    mkdirSync(artifactPath(root, 0));
    expectFailure(root, runGuard(root), 'font-subset-evidence-not-regular', artifacts[0]);
  });

  it.each([
    ['empty', Buffer.alloc(0), 'font-subset-evidence-header-short'],
    ['short', Buffer.alloc(47), 'font-subset-evidence-header-short'],
    ['wrong-magic', Buffer.alloc(48), 'font-subset-evidence-magic-invalid'],
    ['high-bit-magic', Buffer.concat([Buffer.from([0xf7, 0xcf, 0xc6, 0xb2]), Buffer.alloc(44)]), 'font-subset-evidence-magic-invalid'],
  ])('rejects a %s artifact', (_name, content, reason) => {
    const root = createFixture();
    writeFileSync(artifactPath(root, 0), content);
    expectFailure(root, runGuard(root), reason, artifacts[0]);
  });

  it('rejects a valid file symlink', (context) => {
    const root = createFixture();
    const target = path.join(root, 'valid-font.woff2');
    writeFileSync(target, validWoff2());
    rmSync(artifactPath(root, 0));
    if (!symlinkOrSkip(context, target, artifactPath(root, 0))) return;
    expectFailure(root, runGuard(root), 'font-subset-evidence-not-regular', artifacts[0]);
  });

  it('rejects a dangling symlink', (context) => {
    const root = createFixture();
    rmSync(artifactPath(root, 0));
    if (!symlinkOrSkip(context, path.join(root, 'missing.woff2'), artifactPath(root, 0))) return;
    expectFailure(root, runGuard(root), 'font-subset-evidence-not-regular', artifacts[0]);
  });

  it('sanitizes an unreadable artifact where permissions enforce denial', (context) => {
    const root = createFixture();
    const file = artifactPath(root, 0);
    chmodSync(file, 0o000);
    try {
      readFileSync(file);
      context.skip();
      return;
    } catch {
      expectFailure(root, runGuard(root), 'font-subset-evidence-unreadable', artifacts[0]);
    } finally {
      chmodSync(file, 0o600);
    }
  });

  it('accepts regular WOFF2-shaped artifacts from an alternate cwd', () => {
    const root = createFixture();
    const result = runGuard(root);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(successMarker);
    expect(result.stderr).toBe('');
  });

  it('preserves the CSS declaration failure', () => {
    const root = createFixture();
    writeFileSync(path.join(root, 'public', 'fonts', 'lxgw-wenkai-screen.css'), 'subset-118.woff2\n');
    const result = runGuard(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('字体契约缺失：未声明 subset-117.woff2');
    expect(result.stdout).not.toContain(successMarker);
    expect(result.stderr).not.toContain(root);
  });

  it('preserves the main font-name failure', () => {
    const root = createFixture();
    writeFileSync(path.join(root, 'main.ts'), "const font = 'LXGW WenKai';\n");
    const result = runGuard(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('main.ts 检测到非统一字体名');
    expect(result.stdout).not.toContain(successMarker);
    expect(result.stderr).not.toContain(root);
  });
});
