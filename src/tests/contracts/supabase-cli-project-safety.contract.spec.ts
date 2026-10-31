import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const wrapperPath = path.join(process.cwd(), 'scripts', 'supabase-cli.cjs');

type ProjectTargetResult = {
  ok: boolean;
  reason?: 'missing-configured-project-ref' | 'missing-linked-project-ref' | 'project-ref-mismatch';
};

type ProjectSafetyModule = {
  evaluateRemoteProjectTarget: (
    args: string[],
    configuredProjectRef: string,
    linkedProjectRef: string,
  ) => ProjectTargetResult;
  isRemoteProjectCommand: (args: string[]) => boolean;
};

function loadSafetyModule(): ProjectSafetyModule | null {
  if (!fs.existsSync(wrapperPath)) {
    return null;
  }
  delete require.cache[require.resolve(wrapperPath)];
  return require(wrapperPath) as ProjectSafetyModule;
}

describe('Supabase CLI project safety', () => {
  it('keeps the CLI wrapper import-safe for direct behavior tests', () => {
    const wrapper = fs.readFileSync(wrapperPath, 'utf8');

    expect(wrapper).toContain('if (require.main === module)');
    expect(wrapper).toContain('module.exports = {');
  });

  it('exports remote project validation from the import-safe wrapper', () => {
    expect(fs.existsSync(wrapperPath)).toBe(true);
  });

  it('recognizes commands that can access a linked remote project', () => {
    const safety = loadSafetyModule();
    if (!safety) return;

    for (const args of [
      ['db', 'push', '--dry-run'],
      ['db', 'pull'],
      ['db', 'dump', '--dry-run'],
      ['db', 'reset', '--linked'],
      ['gen', 'types', 'typescript', '--linked'],
      ['functions', 'deploy', 'example'],
      ['secrets', 'set', 'EXAMPLE=value'],
    ]) {
      expect(safety.isRemoteProjectCommand(args), args.join(' ')).toBe(true);
    }

    for (const args of [
      ['link'],
      ['start'],
      ['status'],
      ['db', 'reset'],
      ['functions', 'serve'],
      ['--version'],
    ]) {
      expect(safety.isRemoteProjectCommand(args), args.join(' ')).toBe(false);
    }
  });

  it('blocks remote access unless configured and linked project refs match', () => {
    const safety = loadSafetyModule();
    if (!safety) return;

    expect(safety.evaluateRemoteProjectTarget(['db', 'push'], '', 'production-ref')).toEqual({
      ok: false,
      reason: 'missing-configured-project-ref',
    });
    expect(safety.evaluateRemoteProjectTarget(['db', 'push'], 'preview-ref', '')).toEqual({
      ok: false,
      reason: 'missing-linked-project-ref',
    });
    expect(safety.evaluateRemoteProjectTarget(['db', 'push'], 'preview-ref', 'production-ref')).toEqual({
      ok: false,
      reason: 'project-ref-mismatch',
    });
    expect(safety.evaluateRemoteProjectTarget(['db', 'push'], 'preview-ref', 'preview-ref')).toEqual({
      ok: true,
    });
    expect(safety.evaluateRemoteProjectTarget(['db', 'reset'], 'preview-ref', 'production-ref')).toEqual({
      ok: true,
    });
  });

  it('runs the project target guard before spawning the Supabase CLI', () => {
    const wrapper = fs.readFileSync(wrapperPath, 'utf8');

    expect(wrapper).toContain('function evaluateRemoteProjectTarget(');
    expect(wrapper).toContain("path.resolve(__dirname, '../supabase/.temp/project-ref')");
    expect(wrapper).toContain('evaluateRemoteProjectTarget(args, projectRef, linkedProjectRef)');
    expect(wrapper.indexOf('evaluateRemoteProjectTarget(args, projectRef, linkedProjectRef)')).toBeLessThan(
      wrapper.indexOf('spawnSync(command, commandArgs'),
    );
  });
});
