// ESLint Flat Config (ESLint >= 9)
import js from '@eslint/js';
import globals from 'globals';
import html from 'eslint-plugin-html';
import prettier from 'eslint-config-prettier';

export default [
  { ignores: ['node_modules/', 'public/images/'] },

  js.configs.recommended,

  // Backend und Konfigurationsdateien (Node, ES-Module)
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
  },

  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  // Gemeinsames Frontend-Script (Browser, klassisches Script, Funktionen global)
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: globals.browser,
    },
    rules: {
      'no-unused-vars': ['error', { vars: 'local', argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },

  // Inline-Script im Frontend (Browser, klassisches Script)
  {
    files: ['**/*.html'],
    plugins: { html },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      // esc, api, postJson kommen aus public/common.js
      globals: { ...globals.browser, esc: 'readonly', api: 'readonly', postJson: 'readonly' },
    },
    rules: {
      // Top-Level-Funktionen werden über onclick="..." im HTML aufgerufen
      'no-unused-vars': ['error', { vars: 'local', argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },

  // Muss zuletzt stehen: schaltet Stilregeln ab, die mit Prettier kollidieren
  prettier,
];
