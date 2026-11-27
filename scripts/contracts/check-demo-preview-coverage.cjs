#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const normalize = value => value.replaceAll('\\', '/');
const read = (cwd, file) => fs.existsSync(path.join(cwd, file)) ? fs.readFileSync(path.join(cwd, file), 'utf8') : null;
const registryPath = 'src/app/dev-preview/demo-preview-registry.ts';
const pagePath = 'src/app/dev-preview/demo-preview-page.component.ts';
const panelPath = 'src/app/dev-preview/demo-preview-panel.component.ts';

function parseRegistry(source) {
  const entries = [];
  for (const match of source.matchAll(/widget\s*:\s*['"]([^'"]+)['"]\s*,\s*state\s*:\s*['"]([^'"]+)['"]/g)) {
    entries.push({ widget: match[1], state: match[2] });
  }
  for (const match of source.matchAll(/\.\.\.\[([^\]]+)\]\.map\(state\s*=>\s*\(\{\s*widget\s*:\s*['"]([^'"]+)['"]/g)) {
    for (const state of match[1].matchAll(/['"]([^'"]+)['"]/g)) entries.push({ widget: match[2], state: state[1] });
  }
  const seen = new Set();
  const duplicates = [];
  for (const entry of entries) {
    const key = `${entry.widget}/${entry.state}`;
    if (seen.has(key)) duplicates.push(key);
    seen.add(key);
  }
  return { entries, duplicates };
}

function evaluateCoverage({ registrySource, pageSource, panelSource, contract, changedComponents = [], changedFiles: changedPaths, fileExists = () => false, sourceFor = () => null }) {
  const failures = [];
  const { entries, duplicates } = parseRegistry(registrySource);
  const keys = new Set(entries.map(entry => `${entry.widget}/${entry.state}`));
  if (keys.size < contract.minimumScenarioCount) failures.push(`scenario count ${keys.size} < ${contract.minimumScenarioCount}`);
  for (const key of duplicates) failures.push(`duplicate preview scenario ${key}`);
  const widgets = new Set(entries.map(entry => entry.widget));
  for (const widget of contract.requiredWidgets) if (!widgets.has(widget)) failures.push(`required widget ${widget} has no registry scenario`);
  for (const [name, source] of [['page', pageSource], ['panel', panelSource]]) {
    const renderers = new Map([...source.matchAll(/@case\s*\(['"]([^'"]+)['"]\)\s*\{([^]*?)(?=@case|@default|$)/g)].map(match => [match[1], match[2]]));
    for (const widget of widgets) {
      if (!renderers.has(widget) || !/<app-demo-[\w-]+\b/.test(renderers.get(widget))) failures.push(`widget ${widget} has no explicit ${name} renderer`);
    }
  }
  const fixtureEntries = new Set();
  for (const [source, file] of [[pageSource, pagePath], [panelSource, panelPath]]) {
    for (const entry of mountedComponents(source, file, sourceFor).keys()) if (entry !== file && entry.startsWith('src/app/dev-preview/')) fixtureEntries.add(entry);
  }
  for (const entry of fixtureEntries) {
    const test = entry.replace(/\.ts$/, '.spec.ts');
    if (!fileExists(test) || !importsEntry(sourceFor(test) || '', test, entry)) failures.push(`${entry}: rendered preview fixture requires its importing same-name spec`);
  }
  for (const [selector, reason] of Object.entries(contract.exceptions || {})) {
    if (typeof reason !== 'string' || !reason.trim()) failures.push(`exception ${selector} requires a non-empty reason`);
  }
  for (const [selector, fixture] of Object.entries(contract.selectorFixtureHints || {})) {
    const scenario = fixture.scenario;
    if (!scenario || !keys.has(`${scenario.widget}/${scenario.state}`)) failures.push(`${selector}: mapped scenario is not registered`);
    if (!fixture.test || !fileExists(fixture.test)) failures.push(`${selector}: mapped fixture test missing ${fixture.test}`);
    // A feature unit test alone does not establish a reachable development example.
    const entry = fixture.entry || fixture.test?.replace(/\.spec\.ts$/, '.ts');
    if (!entry || !/^src\/app\/dev-preview\/[^]+\.ts$/.test(entry) || !fileExists(entry)) failures.push(`${selector}: mapping requires an existing dev-preview entry`);
    else {
      const testSource = sourceFor(fixture.test);
      if (!testSource || !importsEntry(testSource, fixture.test, entry)) failures.push(`${selector}: fixture test does not import its dev-preview entry`);
      const entrySource = sourceFor(entry);
      const entrySelector = angularComponents(entry, entrySource || '')[0]?.selector;
      if (!productionSelectorReachable(entry, selector, sourceFor)) failures.push(`${selector}: target selector is not rendered by its mapped preview fixture`);
      if (!entrySelector || ![[pageSource, pagePath], [panelSource, panelPath]].every(([source, file]) => previewEntryReachable(source, file, entrySelector, sourceFor))) failures.push(`${selector}: dev-preview entry is not mounted in both renderers`);
    }
  }
  const changedSet = changedPaths === undefined ? null : new Set(changedPaths.map(normalize));
  const coupled = new Set();
  for (const change of changedComponents) {
    if (!change.selector) { failures.push(`${change.file}: changed Angular component has no selector`); continue; }
    const selectors = change.selector.split(',').map(value => value.trim()).filter(Boolean);
    const mappings = selectors.filter(selector => !Object.hasOwn(contract.exceptions || {}, selector)).map(selector => contract.selectorFixtureHints?.[selector]).filter(Boolean);
    for (const selector of selectors) {
      if (Object.hasOwn(contract.exceptions || {}, selector)) continue;
      if (!contract.selectorFixtureHints?.[selector]) failures.push(`${change.file}: selector ${selector} lacks demo fixture mapping or explicit exception`);
    }
    // HTML/style-only edits already flow through the mounted real component. A TS change
    // may add a visible state, so require a deliberate fixture or regression-test update.
    if (changedSet?.has(normalize(change.file)) && mappings.length && !coupled.has(change.file)) {
      coupled.add(change.file);
      const fixtureFiles = new Set(mappings.flatMap(fixture => [fixture.entry || fixture.test?.replace(/\.spec\.ts$/, '.ts'), fixture.test]).filter(Boolean).map(normalize));
      if (![...fixtureFiles].some(file => changedSet.has(file))) failures.push(`${change.file}: component TS changed; update a ready development preview or its fixture regression test for the new visible state`);
    }
  }
  return { failures, scenarioCount: keys.size };
}

function importedComponentFiles(file, source, sourceFor) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const imports = [];
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.moduleSpecifier.text.startsWith('.')) continue;
    const relative = path.posix.normalize(path.posix.join(path.posix.dirname(file), statement.moduleSpecifier.text));
    const candidate = [relative, `${relative}.ts`, `${relative}/index.ts`].find(value => value.startsWith('src/') && value.endsWith('.ts') && sourceFor(value) !== null);
    if (candidate) imports.push(candidate);
  }
  return imports;
}
function selectorInTemplate(template, selector) {
  const clean = template.replace(/<!--[^]*?-->/g, '');
  return selector.split(',').some(raw => {
    const value = raw.trim();
    if (/^[\w-]+$/.test(value)) return new RegExp(`<${value}(?=[\\s/>])`, 'i').test(clean);
    const attribute = value.match(/^\[([\w-]+)\]$/)?.[1];
    return attribute ? new RegExp(`<[^>]+\\s(?:\\[)?${attribute}(?:\\])?(?=[\\s=>])`, 'i').test(clean) : false;
  });
}
function componentTemplates(file, source, sourceFor) {
  return angularComponents(file, source).map(component => component.template !== null ? component.template : component.templateUrl ? sourceFor(component.templateUrl) || '' : '').join('\n');
}
function mountedComponents(source, file, sourceFor, seen = new Map()) {
  if (seen.has(file)) return seen;
  // Root page/panel callers pass source directly; children use actual Component templates only.
  const template = componentTemplates(file, source, sourceFor) || (file === pagePath || file === panelPath ? source : '');
  seen.set(file, template);
  for (const imported of importedComponentFiles(file, source, sourceFor)) {
    const child = sourceFor(imported);
    for (const component of angularComponents(imported, child || '')) {
      if (component.selector && selectorInTemplate(template, component.selector)) mountedComponents(child, imported, sourceFor, seen);
    }
  }
  return seen;
}
function productionSelectorReachable(entry, selector, sourceFor) {
  const source = sourceFor(entry);
  if (!source) return false;
  return [...mountedComponents(source, entry, sourceFor).values()].some(template => selectorInTemplate(template, selector));
}

function importsEntry(source, file, entry) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  return parsed.statements.some(statement => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return false;
    const reference = statement.moduleSpecifier.text;
    if (!reference.startsWith('.')) return false;
    const candidate = path.posix.normalize(path.posix.join(path.posix.dirname(file), reference));
    return candidate.replace(/\.ts$/, '') === entry.replace(/\.ts$/, '');
  });
}

function previewEntryReachable(source, file, selector, sourceFor, seen = new Set()) {
  if (source.includes(`<${selector}`)) return true;
  if (seen.has(file)) return false;
  seen.add(file);
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const reference = statement.moduleSpecifier.text;
    if (!reference.startsWith('.')) continue;
    const candidate = path.posix.normalize(path.posix.join(path.posix.dirname(file), reference)) + '.ts';
    if (!candidate.startsWith('src/app/dev-preview/')) continue;
    const child = sourceFor(candidate);
    if (!child) continue;
    const childSelector = angularComponents(candidate, child)[0]?.selector;
    if (childSelector && source.includes(`<${childSelector}`) && previewEntryReachable(child, candidate, selector, sourceFor, seen)) return true;
  }
  return false;
}

function angularComponents(file, content) {
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
  const componentNames = new Set();
  const namespaces = new Set();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== '@angular/core') continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) for (const imported of bindings.elements) {
      if ((imported.propertyName || imported.name).text === 'Component') componentNames.add(imported.name.text);
    }
  }
  const components = [];
  const visit = node => {
    if (ts.isClassDeclaration(node)) for (const decorator of ts.getDecorators(node) || []) {
      const call = decorator.expression;
      if (!ts.isCallExpression(call)) continue;
      const name = call.expression;
      const isComponent = ts.isIdentifier(name) && componentNames.has(name.text)
        || ts.isPropertyAccessExpression(name) && namespaces.has(name.expression.getText(source)) && name.name.text === 'Component';
      if (!isComponent) continue;
      const metadata = call.arguments[0];
      const properties = new Map(ts.isObjectLiteralExpression(metadata) ? metadata.properties.filter(ts.isPropertyAssignment).map(property => [property.name.getText(source).replace(/^['"]|['"]$/g, ''), property.initializer]) : []);
      const string = node => node && ts.isStringLiteralLike(node) ? node.text : null;
      const selector = string(properties.get('selector'));
      const references = [];
      let dynamicResources = false;
      for (const key of ['templateUrl', 'styleUrl', 'styleUrls']) {
        const value = properties.get(key);
        if (!value) continue;
        const values = key === 'styleUrls' && ts.isArrayLiteralExpression(value) ? [...value.elements] : [value];
        for (const item of values) {
          const resource = string(item);
          if (resource === null) dynamicResources = true;
          else references.push(normalize(path.posix.normalize(path.posix.join(path.posix.dirname(file), normalize(resource)))));
        }
      }
      const template = string(properties.get('template'));
      const templateFile = string(properties.get('templateUrl'));
      const templateUrl = templateFile === null ? null : path.posix.normalize(path.posix.join(path.posix.dirname(file), normalize(templateFile)));
      components.push({ file, selector, references, dynamicResources, template, templateUrl });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return components;
}

function findChangedComponents({ changedFiles, sourceFiles = changedFiles, sourceFor }) {
  const changed = new Set(changedFiles.map(normalize));
  const components = [];
  for (const raw of sourceFiles) {
    const file = normalize(raw);
    if (!/^src\/.*\.ts$/.test(file) || /\.spec\.ts$/.test(file) || file.startsWith('src/app/dev-preview/')) continue;
    const content = sourceFor(file);
    if (content === null) continue; // Deleted component: no current visible surface to cover.
    for (const component of angularComponents(file, content)) {
      if (changed.has(file) || component.references.some(resource => changed.has(resource)) || component.dynamicResources && changed.size) {
        components.push({ file, selector: component.selector });
      }
    }
  }
  return components;
}

function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function changedFiles(base, cwd = process.cwd(), { mode = 'merge-base', includeWorkingTree = true } = {}) {
  if (!['merge-base', 'endpoint'].includes(mode)) throw new Error(`Unknown comparison mode ${mode}`);
  const names = [];
  if (base) {
    if (!/^[a-zA-Z0-9_./~-]+$/.test(base) || base.startsWith('-')) throw new Error('Invalid baseline revision');
    git(cwd, ['rev-parse', '--verify', `${base}^{commit}`]);
    const from = mode === 'endpoint' ? base : git(cwd, ['merge-base', base, 'HEAD']);
    names.push(git(cwd, ['diff', '--name-only', '--no-renames', '-z', from, 'HEAD', '--']));
  }
  if (includeWorkingTree) {
    names.push(git(cwd, ['diff', '--name-only', '--no-renames', '-z', 'HEAD', '--']));
    names.push(git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']));
  }
  return [...new Set(names.join('\0').split('\0').filter(Boolean).map(normalize))];
}

function main() {
  const cwd = process.cwd();
  const base = process.env.DEMO_PREVIEW_BASE_SHA || process.env.GITHUB_BASE_SHA;
  const ci = !!process.env.CI && process.env.CI !== 'false';
  if (ci && !base) throw new Error('CI requires DEMO_PREVIEW_BASE_SHA or GITHUB_BASE_SHA');
  const mode = process.env.DEMO_PREVIEW_DIFF_MODE || (process.env.GITHUB_EVENT_NAME === 'push' ? 'endpoint' : 'merge-base');
  const changed = changedFiles(base, cwd, { mode, includeWorkingTree: !ci });
  if (process.env.DEMO_PREVIEW_CHECK_FILES) changed.push(...process.env.DEMO_PREVIEW_CHECK_FILES.split(',').filter(Boolean));
  const contract = JSON.parse(read(cwd, 'scripts/contracts/demo-preview-contract.json'));
  const sourceFiles = git(cwd, ['ls-files', '--cached', '--others', '--exclude-standard', '-z', 'src']).split('\0').filter(Boolean);
  const components = findChangedComponents({ changedFiles: changed, sourceFiles, sourceFor: file => read(cwd, file) });
  const result = evaluateCoverage({ registrySource: read(cwd, registryPath), pageSource: read(cwd, pagePath), panelSource: read(cwd, panelPath), contract, changedComponents: components, changedFiles: changed, fileExists: file => !!read(cwd, file), sourceFor: file => read(cwd, file) });
  if (result.failures.length) { console.error(['Demo preview coverage gate failed:', ...result.failures.map(value => `- ${value}`)].join('\n')); process.exitCode = 1; return; }
  console.log(JSON.stringify({ ok: true, scenarioCount: result.scenarioCount, changedComponentCount: components.length, baseline: base ? `${mode}:verified` : 'working-tree' }));
}
module.exports = { parseRegistry, evaluateCoverage, findChangedComponents, angularComponents, changedFiles };
if (require.main === module) try { main(); } catch (error) { console.error(`Demo preview coverage gate could not verify: ${error.message}`); process.exitCode = 1; }
