module.exports = {
  root: true,
  env: { browser: true, es2020: true, node: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: ['dist', '.eslintrc.cjs', 'src/server/vendor/', 'website/'],
  parser: '@typescript-eslint/parser',
  plugins: ['react-refresh'],
  rules: {
    'react-refresh/only-export-components': [
      'warn',
      { allowConstantExport: true },
    ],
  },
  overrides: [
    {
      // Server tests must redirect SQLite away from the production database
      // before any storage module loads, which means test-utils/test-env has
      // to be the very first import. The runtime guard in data-dir.ts is the
      // authoritative check; this rule catches a missing/misordered import
      // statically. Vendored tests are excluded via ignorePatterns.
      files: ['src/server/**/*.test.ts'],
      rules: {
        'no-restricted-syntax': [
          'error',
          {
            selector:
              'Program > ImportDeclaration:first-child:not([source.value=/test-env/])',
            message:
              'Server test files must import test-utils/test-env as their first statement so the SQLite store is redirected away from the production database before any storage module loads.',
          },
        ],
      },
    },
  ],
}
