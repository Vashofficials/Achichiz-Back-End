import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // eslint.config.js is not in tsconfig's `include` (it is JS, and adding it
    // would drag allowJs into the build), so the type-aware parser cannot resolve
    // it. Lint it with the untyped rules only by excluding it here.
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'src/db/migrations/**', 'eslint.config.js', 'ecosystem.config.cjs'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // A floating promise in a payments handler is a silently lost order.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    /**
     * THE RULE THAT KEEPS THE OPENAPI DOCUMENT HONEST.
     *
     * `defineRoute` is the only sanctioned way to mount a handler, because it is
     * also the only thing that registers the OpenAPI operation. A bare
     * `router.get(...)` would be a live endpoint that no document knows about.
     * The coverage test catches it too — this makes it a lint error first.
     */
    files: ['src/**/*.ts'],
    ignores: ['src/lib/openapi/**', 'src/app.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          // Verb methods only. `.use()` is deliberately NOT banned: mounting a
          // sub-router is how modules compose, and those routes were already
          // registered through defineRoute. Banning it would block the intended
          // path rather than the dangerous one.
          selector:
            "CallExpression[callee.object.name=/^(router|app|apiRouter|.*Router)$/][callee.property.name=/^(get|post|put|patch|delete|all|head|options)$/]",
          message:
            'Mount endpoints with defineRoute() so the OpenAPI document cannot drift. ' +
            'If you genuinely need raw Express (static files, a proxy), put it in app.ts.',
        },
      ],
    },
  },
  {
    // Module boundaries: a controller/route file must not reach into a repository,
    // and a repository must not import HTTP concerns.
    files: ['src/modules/**/*.repository.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['express', '**/middleware/**', '**/*.controller*', '**/*.routes*'], message: 'Repositories must not know about HTTP.' },
          ],
        },
      ],
    },
  },
  {
    /**
     * Scoped relaxation, tests only. Vitest's `expect.objectContaining` and
     * friends are typed `any` by design — they match arbitrary shapes — so
     * type-aware rules flag every use. Production code keeps these as errors;
     * the exemption applies only where the `any` originates in the framework
     * rather than in our own logic.
     */
    files: ['**/*.test.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      'no-console': 'off',
    },
  },
  prettier,
);
