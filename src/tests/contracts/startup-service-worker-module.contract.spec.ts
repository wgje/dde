import fs from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
const source = fs.readFileSync('main.ts', 'utf8');
const file = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const nodes: ts.Node[] = [];
function visit(node: ts.Node): void { nodes.push(node); ts.forEachChild(node, visit); }
visit(file);
describe('startup service worker module boundary', () => {
  it('loads the service-worker module in the same parallel startup batch, not the static entry closure', () => {
    expect(file.statements.filter(ts.isImportDeclaration).some(n => ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text === '@angular/service-worker')).toBe(false);
    const declaration = nodes.filter(ts.isVariableDeclaration).find(n => ts.isArrayBindingPattern(n.name) && n.name.elements.some(e => ts.isBindingElement(e) && e.name.getText(file) === 'serviceWorkerModule'));
    expect(declaration).toBeDefined();
    const init = declaration!.initializer;
    expect(init && ts.isAwaitExpression(init)).toBe(true);
    const call = (init as ts.AwaitExpression).expression as ts.CallExpression;
    expect(call.expression.getText(file)).toBe('Promise.all');
    const imports = call.arguments[0] as ts.ArrayLiteralExpression;
    const binding = declaration!.name as ts.ArrayBindingPattern;
    const index = binding.elements.findIndex(e => e.name?.getText(file) === 'serviceWorkerModule');
    expect(imports.elements[index].getText(file)).toBe("import('@angular/service-worker')");
    expect(imports.elements.some(e => e.getText(file) === "import('./src/app.component')")).toBe(true);
  });
  it('keeps the composed worker provider and post-handoff registration before bootstrap finishes', () => {
    expect(source).toContain('const { provideServiceWorker } = serviceWorkerModule;');
    expect(source.indexOf('const { provideServiceWorker } = serviceWorkerModule;')).toBeLessThan(source.indexOf('await bootstrapApplication('));
    expect(source).toMatch(/provideServiceWorker\('sw-composed\.js',\s*\{\s*enabled: !isDevMode\(\),\s*registrationStrategy: createPostHandoffSwRegistrationStrategy\(\{\s*delayMs: 250,\s*fallbackMs: 4_000,/);
  });
});
