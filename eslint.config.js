import globals from 'globals';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

/** @type {import('eslint').Linter.Config[]} */
export default [
  // 全局忽略规则
  {
    ignores: [
      '.angular/**',
      '.tmp/**',
      'dist/**',
      'node_modules/**',
      'playwright-report/**',
      'src/environments/**',
      'test-results/**',
      'tmp/**'
    ]
  },
  {
    files: ['src/**/*.ts'],
    ignores: [
      '**/*.spec.ts',
      'src/test-setup.ts'
    ],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module'
      },
      globals: {
        ...globals.browser,
        ...globals.es2021
      }
    },
    plugins: {
      '@typescript-eslint': tseslint
    },
    rules: {
      // TypeScript 规则 - 技术债务清理：升级为 error 级别
      '@typescript-eslint/no-unused-vars': ['error', { 
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        caughtErrors: 'none' // 忽略 catch 中未使用的错误变量
      }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'error', // 技术债务清理：禁止 any 类型
      '@typescript-eslint/no-non-null-assertion': 'off',
      
      // 通用规则 - 技术债务清理：禁止生产代码使用 console
      'no-console': ['error', { 
        allow: ['warn', 'error'] // 允许 console.warn/error 用于紧急情况
      }],
      'prefer-const': 'error',
      'no-duplicate-imports': 'error',

      // 【2026-04-16 尺寸红线】AGENTS.md §12：单文件 ≤ 800 行（警告）
      // 目前已有 18+ 生产文件越界；设为 warn 避免一次性阻断 CI，
      // 但让 IDE 与 lint 报告持续曝光这些大文件，督促"只下切不上涨"
      'max-lines': ['warn', { max: 800, skipBlankLines: true, skipComments: true }],
      // 【2026-04-16】AGENTS.md §12：函数 ≤ 50 行（警告）
      // IIFEs 不算；跳过空行与注释
      'max-lines-per-function': ['warn', {
        max: 50,
        skipBlankLines: true,
        skipComments: true,
        IIFEs: false
      }],
      // 【2026-04-16】AGENTS.md §12：嵌套 ≤ 4 层（警告）
      'max-depth': ['warn', 4],
      // 【2026-04-16】圈复杂度上限（警告）；20 是经验阈值，超过通常意味着该拆分
      complexity: ['warn', { max: 20 }],
      
      // 禁止错误吞噬模式：catch 块中直接 return null/undefined
      // 应使用 Result 模式替代
      // 【P0 代码质量】升级为 error 级别，防止新代码引入错误吞噬模式
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CatchClause > BlockStatement > ReturnStatement[argument.type="Literal"][argument.value=null]',
          message: '禁止在 catch 块中直接 return null，请使用 Result 模式（failure/wrapWithResult）或添加 eslint-disable 注释说明原因'
        },
        {
          // 【2026-04-16 T1-1 PR-A】禁止对 Store signal 的返回快照直接 mutate
          // 即 `this.taskStore.tasksMap().set(...)` / `.delete(...)` / `.add(...)` / `.clear()`
          // 这类调用会在 `equal:()=>false` 模型下产生 stale-snapshot 风险；
          // 应通过 TaskStore.setTask() / removeTask() 等高层 API 操作
          selector: 'CallExpression[callee.type="MemberExpression"][callee.property.name=/^(set|delete|add|clear)$/][callee.object.type="CallExpression"][callee.object.callee.property.name=/^(tasksMap|projectsMap|connectionsMap|parkedTaskIds|tasksByProject|taskProjectMap|connectionsByProject|badgedTaskIds)$/]',
          message: '禁止直接修改 Store signal 的快照；请通过 TaskStore/ProjectStore/ConnectionStore 的高层方法（setX/removeX/bulkX）操作。'
        }
      ]
    }
  },
  // 【2026-04-16 T1-1 PR-A 豁免】Store 定义文件自身是唯一合法 mutate signal 快照的位置
  // （setX/removeX/bulkX 的内部实现）；只在此文件关闭 Store signal 保护规则。
  {
    files: ['src/app/core/state/stores.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CatchClause > BlockStatement > ReturnStatement[argument.type="Literal"][argument.value=null]',
          message: '禁止在 catch 块中直接 return null，请使用 Result 模式（failure/wrapWithResult）或添加 eslint-disable 注释说明原因'
        }
      ]
    }
  },
  // 层级依赖规则：services/ 不可反向引用 app/core/（架构性状态 Store 除外）
  // 【2026-04-16 T2-1】删除 `src/services/stores.ts` 桥接文件后，services/ 直接从
  // `app/core/state/stores` 导入 TaskStore/ProjectStore/ConnectionStore 是合法架构依赖，
  // 单独从 pattern 中排除该路径；其余 app/core/* 引用升级为 error。
  {
    files: ['src/services/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          // 只禁止 services/shell 子目录，保留 state/（Signal Store 架构性跨层符号）
          // 这样 `../app/core/state/stores` 通过；`../app/core/services/*` / `../app/core/shell/*` 阻断
          group: ['../app/core/services/**', '../app/core/shell/**'],
          message: 'services/ 层不可引用 app/core/services|shell 层（`app/core/state/*` 除外），请将共享依赖移至 src/services/ 或 src/models/'
        }]
      }]
    }
  },
  {
    // 测试文件的宽松规则
    files: ['**/*.spec.ts', '**/test-*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module'
      },
      globals: {
        ...globals.browser,
        ...globals.es2021,
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        vi: 'readonly'
      }
    },
    plugins: {
      '@typescript-eslint': tseslint
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-console': 'off'
    }
  }
];
