import js from '@eslint/js';
import globals from 'globals';

/*
 * A deliberately small rule set. The goal is to catch the classes of mistake
 * that actually shipped in this codebase — an unused import left by a refactor,
 * a global that was never defined — not to relitigate formatting.
 */
export default [
  { ignores: ['node_modules/**', 'static/icons/**'] },
  js.configs.recommended,

  {
    files: ['static/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      // An unused import is usually a leftover from a refactor that moved code
      // but not its dependency.
      'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
      curly: ['error', 'multi-line'],

      /*
       * OFF, on purpose.
       *
       * The parser and organiser contain ~40 date and amount regexes where
       * separators are written as [\s\-\/]. Those escapes are redundant to the
       * engine but they are load-bearing to the reader: a bare '-' inside a
       * character class is one keystroke from becoming a range, and these
       * patterns are the reason the parser holds 100% precision on the corpus.
       * Mechanically stripping escapes across a money parser to satisfy a
       * style rule is a bad trade.
       */
      'no-useless-escape': 'off',
    },
  },

  {
    // Service worker: neither browser-window nor node globals apply.
    files: ['static/sw.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.serviceworker },
    },
  },

  {
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'off',
      // Warn, not error: a test that computes an intermediate it no longer
      // asserts on is worth flagging, but it must never block a run whose
      // actual job is to tell us whether the parser still works.
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
    },
  },
];
