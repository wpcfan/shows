const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // CLI tools use console extensively
      'no-console': 'off',
      // Allow unused args prefixed with _ (common pattern in callbacks)
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      // Relaxed: some tools have functions that could be simplified, but not a correctness issue
      'no-useless-escape': 'warn',
      // Catch likely errors
      'no-constant-binary-expression': 'error',
      'no-constructor-return': 'error',
      'no-duplicate-imports': 'off', // CommonJS doesn't have imports
    },
  },
  {
    ignores: [
      'node_modules/',
      'output/',
      'experiments/',
      'episodes/',
      'tools/test/regression.test.js', // 9400+ lines, legacy monolith — exclude from lint
    ],
  },
];
