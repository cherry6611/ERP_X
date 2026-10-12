const tseslint = require('typescript-eslint');

module.exports = tseslint.config({
  ignores: ['dist', 'node_modules', 'coverage', 'source_package', 'client/src/api/gen'],
  files: ['**/*.{ts,tsx}'],
  languageOptions: {
    parser: tseslint.parser,
  },
  rules: {},
});
