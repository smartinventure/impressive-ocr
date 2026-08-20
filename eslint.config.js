import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';
import prettier from 'eslint-config-prettier';

/**
 * Flat ESLint config for the whole workspace.
 * Rules mirror the conventions documented in CLAUDE.md.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/out/**',
      '**/coverage/**',
      '**/.venv/**',
      'sidecar/**',
      // Reference material and design output, not our source: third-party React/Tailwind
      // snippets and a generated design canvas. Linting them would report hundreds of
      // violations of rules they were never written against.
      '_resources/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,mts,vue}'],
    rules: {
      // CLAUDE.md: no `any`; cross boundaries with `unknown` + zod.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // CLAUDE.md: named exports only, so the symbol name is greppable.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportDefaultDeclaration',
          message: 'Use named exports (Vue SFCs and config files are exempt).',
        },
      ],
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
      // TypeScript already reports undefined identifiers, and it understands ambient globals
      // (`process`, `NodeJS`, `Electron`) that this rule does not — it only produced false
      // positives here. typescript-eslint recommends disabling it on TS files for exactly
      // this reason.
      'no-undef': 'off',
    },
  },

  {
    files: ['**/*.vue'],
    extends: [...vue.configs['flat/recommended']],
    languageOptions: {
      parser: vueParser,
      parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.vue'] },
    },
    rules: {
      // SFCs export a component object by default; that is the Vue convention.
      'no-restricted-syntax': 'off',
      'vue/multi-word-component-names': 'off',
      'vue/component-api-style': ['error', ['script-setup']],
      'vue/define-macros-order': ['error', { order: ['defineProps', 'defineEmits'] }],
    },
  },

  {
    files: ['**/*.config.{js,ts}', '**/vite.config.ts', '**/vitest.config.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },

  {
    // Build and release scripts: plain Node ESM, run directly by `node` and by CI. They are
    // not part of a TypeScript project, so the Node globals have to be declared here.
    files: ['deploy/**/*.mjs', 'apps/*/build.mjs', '**/*.config.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      // Console output is the entire user interface of a release script.
      'no-console': 'off',
      'no-restricted-syntax': 'off',
    },
  },

  prettier,
);
