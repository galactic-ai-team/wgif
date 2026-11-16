import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        console: 'readonly', process: 'readonly', window: 'readonly', document: 'readonly',
        crypto: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly', Blob: 'readonly',
        URL: 'readonly', performance: 'readonly', requestAnimationFrame: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
    },
  },
);
