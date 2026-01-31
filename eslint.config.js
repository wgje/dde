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
      'no-duplicate-imports': 'error'
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
