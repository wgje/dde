import globals from 'globals';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

/** @type {import('eslint').Linter.Config[]} */
export default [
  // 全局忽略规则
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'src/environments/**'
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
      
      // 禁止错误吞噬模式：catch 块中直接 return null/undefined
      // 应使用 Result 模式替代
      // 【P0 代码质量】升级为 error 级别，防止新代码引入错误吞噬模式
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CatchClause > BlockStatement > ReturnStatement[argument.type="Literal"][argument.value=null]',
          message: '禁止在 catch 块中直接 return null，请使用 Result 模式（failure/wrapWithResult）或添加 eslint-disable 注释说明原因'
        }
      ]
    }
  },
  // 层级依赖规则：services/ 不可反向引用 app/core/
  {
    files: ['src/services/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-imports': ['warn', {
        patterns: [{
          group: ['../app/core/*', '../app/core/**'],
          message: 'services/ 层不可引用 app/core/ 层，请将共享依赖移至 src/services/ 或 src/models/'
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
