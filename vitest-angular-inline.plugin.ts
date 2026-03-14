/**
 * Vitest 插件：将 Angular 组件的 templateUrl / styleUrl 内联为 template / styles。
 * 仅在 Vitest 测试环境生效，不影响 Angular CLI 构建管道。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Plugin } from 'vite';

export function angularComponentInlinePlugin(): Plugin {
  return {
    name: 'vitest-angular-component-inline',
    enforce: 'pre',
    transform(code: string, id: string) {
      if (!id.endsWith('.component.ts') && !id.endsWith('.component.js')) return;
      if (!code.includes('templateUrl') && !code.includes('styleUrl')) return;

      const dir = dirname(id);
      let result = code;

      // templateUrl: './xxx.html' → template: `<content>`
      result = result.replace(
        /templateUrl\s*:\s*['"]([^'"]+)['"]/g,
        (_match, filePath: string) => {
          const fullPath = resolve(dir, filePath);
          try {
            const content = readFileSync(fullPath, 'utf-8');
            const escaped = content.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
            return `template: \`${escaped}\``;
          } catch {
            return _match;
          }
        },
      );

      // styleUrl: './xxx.scss' → styles: [`<content>`]
      result = result.replace(
        /styleUrl\s*:\s*['"]([^'"]+)['"]/g,
        (_match, filePath: string) => {
          const fullPath = resolve(dir, filePath);
          try {
            const content = readFileSync(fullPath, 'utf-8');
            const escaped = content.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
            return `styles: [\`${escaped}\`]`;
          } catch {
            return _match;
          }
        },
      );

      // styleUrls: ['./xxx.scss'] → styles: [`<content>`]
      result = result.replace(
        /styleUrls\s*:\s*\[([^\]]+)\]/g,
        (_match, urlList: string) => {
          const urls = urlList.match(/['"]([^'"]+)['"]/g);
          if (!urls) return _match;
          const contents = urls.map(url => {
            const filePath = url.replace(/['"]/g, '');
            const fullPath = resolve(dir, filePath);
            try {
              const content = readFileSync(fullPath, 'utf-8');
              return content.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
            } catch {
              return '';
            }
          });
          return `styles: [${contents.map(c => `\`${c}\``).join(', ')}]`;
        },
      );

      if (result !== code) {
        return { code: result, map: null };
      }
      return undefined;
    },
  };
}
