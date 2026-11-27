import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
const { evaluateCoverage, findChangedComponents, parseRegistry, changedFiles } = createRequire(import.meta.url)('../../../scripts/contracts/check-demo-preview-coverage.cjs');
const preview = 'src/app/dev-preview/task.ts';
const contract = {
  minimumScenarioCount: 1, requiredWidgets: ['task'], exceptions: { 'app-login': 'authentication flow outside fixture' },
  selectorFixtureHints: { 'app-task': { test: 'src/app/dev-preview/task.spec.ts', entry: preview, scenario: { widget: 'task', state: 'active' } } },
};
const renderer = `@case ('task') { <app-demo-task /> }`;
const base = {
  registrySource: `const x = [{ widget: 'task', state: 'active' }];`, pageSource: renderer, panelSource: renderer, contract,
  fileExists: () => true,
  sourceFor: (file: string) => file.endsWith('.spec.ts') ? `import { Preview } from './task';` : `import { Component } from '@angular/core'; @Component({ selector: 'app-demo-task', template: '<app-task />' }) class Preview {}`,
};
const failures = (extra: Record<string, unknown> = {}) => evaluateCoverage({ ...base, ...extra }).failures.join('\n');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    const target = resolve(root); const inside = relative(resolve(tmpdir()), target);
    if (!inside || inside.startsWith('..') || isAbsolute(inside) || !inside.startsWith('demo-preview-gate-')) throw new Error('Unsafe temporary cleanup path');
    rmSync(target, { recursive: true, force: true });
  }
});
function repository() {
  const root = mkdtempSync(join(tmpdir(), 'demo-preview-gate-')); roots.push(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
  writeFileSync(join(root, 'initial.txt'), 'initial'); git('add', '.'); git('commit', '-m', 'initial');
  return { root, git };
}
describe('demo preview coverage contract', () => {
  it('accepts a registered widget, actual preview entry, mapping and test', () => {
    expect(failures({ changedComponents: [{ file: 'src/task.ts', selector: 'app-task' }] })).toBe('');
  });
  it('blocks new components without mapping and missing selectors', () => {
    expect(failures({ changedComponents: [{ file: 'src/new.ts', selector: 'app-new' }] })).toContain('lacks demo fixture mapping');
    expect(failures({ changedComponents: [{ file: 'src/new.ts', selector: null }] })).toContain('has no selector');
  });
  it('requires updating a mapped preview or fixture regression when existing component TS changes', () => {
    const change = [{ file: 'src/task.ts', selector: 'app-task' }];
    expect(failures({ changedComponents: change, changedFiles: ['src/task.ts'] })).toContain('update a ready development preview or its fixture regression test');
    expect(failures({ changedComponents: change, changedFiles: ['src/task.ts', preview] })).toBe('');
    expect(failures({ changedComponents: change, changedFiles: ['src/task.ts', contract.selectorFixtureHints['app-task'].test] })).toBe('');
    expect(failures({ changedComponents: change, changedFiles: ['src/task.html', 'src/task.css'] })).toBe('');
    expect(failures({ changedComponents: [{ file: 'src/login.ts', selector: 'app-login' }], changedFiles: ['src/login.ts'] })).toBe('');
  });
  it('checks all mappings, even when there are no changed components', () => {
    expect(failures({ fileExists: () => false })).toContain('mapped fixture test missing');
    expect(failures({ registrySource: base.registrySource.replace('active', 'done') })).toContain('mapped scenario is not registered');
    expect(failures({ sourceFor: () => 'not an Angular preview' })).toContain('not mounted in both renderers');
    expect(failures({ sourceFor: (file: string) => file.endsWith('.spec.ts') ? 'unrelated test' : base.sourceFor(file) })).toContain('does not import its dev-preview entry');
    expect(failures({ contract: { ...contract, selectorFixtureHints: { 'app-task': { ...contract.selectorFixtureHints['app-task'], entry: 'src/task.ts' } } } })).toContain('requires an existing dev-preview entry');
  });
  it('allows a real nested preview entry reachable through a rendered wrapper', () => {
    const nested = `import { Component } from '@angular/core'; @Component({selector:'app-demo-nested',template:'<app-task />'}) class Nested {}`;
    const wrapper = `import { Component } from '@angular/core'; import { Nested } from './nested'; @Component({selector:'app-demo-wrapper',template:'<app-demo-nested />'}) class Wrapper {}`;
    const render = `import { Wrapper } from './wrapper'; @case ('task') { <app-demo-wrapper /> }`;
    const nestedContract = { ...contract, selectorFixtureHints: { 'app-task': { ...contract.selectorFixtureHints['app-task'], entry: 'src/app/dev-preview/nested.ts' } } };
    expect(failures({ contract: nestedContract, pageSource: render, panelSource: render, sourceFor: (file: string) => file.endsWith('wrapper.spec.ts') ? `import { Wrapper } from './wrapper';` : file.endsWith('.spec.ts') ? `import { Nested } from './nested';` : file.endsWith('wrapper.ts') ? wrapper : file.endsWith('nested.ts') ? nested : null })).toBe('');
  });
  it('blocks mapping a new production selector to an unrelated existing preview', () => {
    const unrelated = { ...contract, selectorFixtureHints: { 'app-new': contract.selectorFixtureHints['app-task'] } };
    expect(failures({ contract: unrelated })).toContain('app-new: target selector is not rendered');
    expect(failures({ sourceFor: (file: string) => file.endsWith('.spec.ts') ? base.sourceFor(file) : `import { Component } from '@angular/core'; const decoy = '<app-task />'; @Component({ selector:'app-demo-task', template:'<!-- <app-task /> -->' }) class Preview {}` })).toContain('target selector is not rendered');
  });
  it('follows mounted production component imports and custom templateUrl but not unused imports', () => {
    const entrySource = `import { Component } from '@angular/core'; import { Child } from '../features/child'; @Component({selector:'app-demo-task',templateUrl:'./screen.html'}) class Preview {}`;
    const childSource = `import { Component } from '@angular/core'; import { Cycle } from '../dev-preview/task'; @Component({selector:'app-child',template:'<app-task /> <app-demo-task />'}) class Child {}`;
    const sourceFor = (file: string): string | null => file === preview ? entrySource : file.endsWith('task.spec.ts') ? `import { Preview } from './task';` : file.endsWith('/screen.html') ? '<app-child />' : file.endsWith('/features/child.ts') ? childSource : null;
    expect(failures({ sourceFor })).toBe('');
    expect(failures({ sourceFor: (file: string) => file.endsWith('/screen.html') ? '<div>no mounted child</div>' : sourceFor(file) })).toContain('target selector is not rendered');
  });
  it('requires tests for rendered preview entries even without a selector mapping', () => {
    const render = `import { Extra } from './extra'; @case ('task') { <app-demo-extra /> }`;
    const sourceFor = (file: string) => file.endsWith('/extra.ts') ? `import { Component } from '@angular/core'; @Component({selector:'app-demo-extra',template:''}) class Extra {}` : base.sourceFor(file);
    expect(failures({ pageSource: render, panelSource: render, sourceFor, fileExists: (file: string) => !file.endsWith('extra.spec.ts') })).toContain('rendered preview fixture requires its importing same-name spec');
  });
  it('requires explicit renderers in both page and panel; a default or grouped declaration is not a renderer', () => {
    expect(failures({ panelSource: '@default { <app-demo-task /> }' })).toContain('explicit panel renderer');
    expect(failures({ pageSource: '@default { <app-demo-task /> }' })).toContain('explicit page renderer');
    expect(failures({ registrySource: `${base.registrySource} const y=[...['normal'].map(state=>({widget:'ghost',state}))]` })).toContain('widget ghost has no explicit');
    expect(failures({ pageSource: "@case ('task') { nothing }" })).toContain('explicit page renderer');
  });
  it('rejects duplicate URLs and empty exception reasons', () => {
    expect(failures({ registrySource: base.registrySource + base.registrySource })).toContain('duplicate preview scenario task/active');
    expect(failures({ contract: { ...contract, exceptions: { 'app-login': ' ' } } })).toContain('non-empty reason');
    expect(failures({ changedComponents: [{ file: 'src/login.ts', selector: 'app-login' }] })).toBe('');
  });
  it('expands grouped states', () => {
    expect(parseRegistry(`const x=[...['active','done'].map(state=>({widget:'task',state}))]`).entries).toEqual([{ widget: 'task', state: 'active' }, { widget: 'task', state: 'done' }]);
  });
  it('detects aliased decorators and custom template/style resources without component naming conventions', () => {
    const source = `import { Component as C } from '@angular/core'; @C({selector:'[widget]',templateUrl:'./screen.html',styleUrl:'./theme.css',styleUrls:['./extra.scss']}) class Widget {}`;
    for (const changed of ['src\\screen.html', 'src/theme.css', 'src/extra.scss', 'src/widget.ts']) {
      expect(findChangedComponents({ changedFiles: [changed], sourceFiles: ['src/widget.ts'], sourceFor: () => source })).toEqual([{ file: 'src/widget.ts', selector: '[widget]' }]);
    }
  });
  it('handles namespace decorators, root inline components, deleted files, non UI files and dev-preview infrastructure', () => {
    const source = `import * as ng from '@angular/core'; @ng.Component({selector:'app-root',template:'inline'}) class Root {}`;
    expect(findChangedComponents({ changedFiles: ['src/root.ts'], sourceFiles: ['src/root.ts'], sourceFor: () => source })).toHaveLength(1);
    expect(findChangedComponents({ changedFiles: ['src/deleted.ts'], sourceFiles: ['src/deleted.ts'], sourceFor: () => null })).toEqual([]);
    expect(findChangedComponents({ changedFiles: ['src/service.ts'], sourceFiles: ['src/service.ts'], sourceFor: () => 'class Service {}' })).toEqual([]);
    expect(findChangedComponents({ changedFiles: ['src/app/dev-preview/sample.ts'], sourceFiles: ['src/app/dev-preview/sample.ts'], sourceFor: () => source })).toEqual([]);
  });
  it('local mode discovers staged, unstaged and untracked changes', () => {
    const { root, git } = repository();
    writeFileSync(join(root, 'initial.txt'), 'changed'); writeFileSync(join(root, 'staged.ts'), 'staged'); git('add', 'staged.ts'); writeFileSync(join(root, 'new.ts'), 'untracked');
    expect(changedFiles(undefined, root).sort()).toEqual(['initial.txt', 'new.ts', 'staged.ts']);
  });
  it('endpoint mode detects changes when the before commit is not an ancestor', () => {
    const { root, git } = repository(); const ancestor = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'branch.ts'), 'branch'); git('add', '.'); git('commit', '-m', 'branch'); const before = git('rev-parse', 'HEAD');
    git('checkout', '--detach', ancestor); writeFileSync(join(root, 'current.ts'), 'current'); git('add', '.'); git('commit', '-m', 'current');
    expect(changedFiles(before, root, { mode: 'endpoint', includeWorkingTree: false }).sort()).toEqual(['branch.ts', 'current.ts']);
    expect(changedFiles(before, root, { mode: 'merge-base', includeWorkingTree: false })).toEqual(['current.ts']);
  });
  it('accepts the manual-dispatch full-SHA first-parent baseline', () => {
    const { root, git } = repository();
    writeFileSync(join(root, 'second.ts'), 'second'); git('add', '.'); git('commit', '-m', 'second');
    const head = git('rev-parse', 'HEAD');
    expect(changedFiles(`${head}~1`, root, { includeWorkingTree: false })).toEqual(['second.ts']);
  });
  it.each([undefined, 'does-not-exist'])('CLI fails closed for CI baseline %s', baseline => {
    const { root } = repository();
    const result = spawnSync(process.execPath, [resolve('scripts/contracts/check-demo-preview-coverage.cjs')], { cwd: root, encoding: 'utf8', env: { ...process.env, CI: 'true', DEMO_PREVIEW_BASE_SHA: baseline || '', GITHUB_BASE_SHA: '' } });
    expect(result.status).toBe(1); expect(result.stderr).toContain('could not verify');
  });
});
