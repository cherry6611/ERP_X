const tseslint = require('typescript-eslint');
const reactHooks = require('eslint-plugin-react-hooks');

module.exports = tseslint.config({
  ignores: ['dist', 'node_modules', 'coverage', 'source_package', 'client/src/api/gen'],
  files: ['**/*.{ts,tsx}'],
  languageOptions: {
    parser: tseslint.parser,
  },
  plugins: {
    'react-hooks': reactHooks,
  },
  rules: {
    ...reactHooks.configs.recommended.rules,
  },
});
