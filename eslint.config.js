const tseslint = require('typescript-eslint');
const reactHooks = require('eslint-plugin-react-hooks');

module.exports = tseslint.config({
  ignores: ['dist', 'node_modules', 'coverage', 'source_package', 'client/src/api/gen'],
  files: ['**/*.{ts,tsx}'],
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: {
    // 必须显式注册插件对象：仅写规则名 'xxx' 而不注册插件，
    // ESLint 会在加载配置时报 "could not find plugin"（曾导致 lint 全量不可用）。
    '@typescript-eslint': tseslint.plugin,
    'react-hooks': reactHooks,
  },
  rules: {
    ...reactHooks.configs.recommended.rules,
    // 以下规则以 warn 形式提升信号，避免海量存量报错直接阻断 lint/CI；后续可逐步收紧为 error
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    'no-duplicate-imports': 'warn',
    'no-redeclare': 'warn',
  },
});
