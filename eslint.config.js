// NOTE: eslint-plugin-storybook is installed but not yet wired into this flat config —
// add `storybook.configs['flat/recommended']` below when the stories are lint-clean.
import prettier from 'eslint-config-prettier';
import path from 'node:path';
import { includeIgnoreFile } from '@eslint/compat';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';
import svelteConfig from './svelte.config.js';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	js.configs.recommended,
	ts.configs.recommended,
	svelte.configs.recommended,
	prettier,
	svelte.configs.prettier,
	{
		languageOptions: { globals: { ...globals.browser, ...globals.node } },
		rules: {
			// typescript-eslint strongly recommend that you do not use the no-undef lint rule on TypeScript projects.
			// see: https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
			'no-undef': 'off'
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				parser: ts.parser,
				svelteConfig
			}
		}
	},
	{
		// Override or add rule settings here, such as:
		// 'svelte/button-has-type': 'error'
		rules: {
			// SvelteKit's documented standard is plain <a href="/path"> without resolve().
			// resolve() is only needed when config.kit.paths.base is set.
			'svelte/no-navigation-without-resolve': 'off'
		}
	},
	{
		// Jobs builtins must stay fork-runnable (jobs-line plan §5.5): only
		// `node:*` modules and the SDK facade are importable. User job files
		// get the same rule through the save gate.
		files: ['src/lib/server/jobs/builtin/**/*.ts'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							// minimatch never crosses "/" with `*`: a single
							// `node:*` negator misses `node:fs/promises`, so the
							// one-slash form gets its own negation (probed matrix).
							group: ['**', '!node:*', '!node:*/*', '!*#jobs-sdk*'],
							message: 'builtin jobs may only import node:* modules and #jobs-sdk'
						}
					]
				}
			]
		}
	}
);
