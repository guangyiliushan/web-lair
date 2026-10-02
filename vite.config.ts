import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { cookieSurfaceMatches, excludedSurfaceMatches } from './src/lib/config/locale-surfaces.ts';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { sveltekit } from '@sveltejs/kit/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
const dirname =
	typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));

/** Cookie-first chain for the exempt surfaces (ledger §9.18.1/§9.18.3). */
const COOKIE_CHAIN = ['cookie', 'preferredLanguage', 'baseLocale'] as const;

// More info at: https://storybook.js.org/docs/next/writing-tests/integrations/vitest-addon
export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit(),
		paraglideVitePlugin({
			project: './project.inlang',
			outdir: './src/lib/paraglide',
			// Strategy chain (P3-a, ledger §9.18.3): the URL prefix is the first
			// source of truth for content pages; cookie = the user's own choice
			// (server-visible), preferredLanguage = first-visit detection
			// (navigator.languages / Accept-Language), baseLocale = fallback.
			// Exempt surfaces override the chain via routeStrategies below —
			// without `url` they keep the cookie-first behaviour. The compiler
			// default also includes `globalVariable`, which the docs call
			// testing/quick-start only and warn about for server-side
			// cross-request issues.
			strategy: ['url', 'cookie', 'preferredLanguage', 'baseLocale'],
			// Every locale is prefixed on content routes (/en/…, /zh-cn/…,
			// /ja/…). The bare-locale entries come FIRST (specific patterns
			// before the wildcard — urlpattern.com ordering): they keep `/en`,
			// `/zh-cn` and `/ja` from de-localizing to the homepage. No route
			// matches them, so SvelteKit answers with its standard 404 instead
			// of rendering `/` (ledger §9.18.1/§11-C1; `/en/` normalises to
			// `/en` first via Kit's trailing-slash 308).
			urlPatterns: [
				{ pattern: '/en', localized: [['en', '/en']] },
				{ pattern: '/zh-cn', localized: [['zh-cn', '/zh-cn']] },
				{ pattern: '/ja', localized: [['ja', '/ja']] },
				{
					pattern: ':protocol://:domain(.*)::port?/:path(.*)?',
					localized: [
						['en', ':protocol://:domain(.*)::port?/en/:path(.*)?'],
						['zh-cn', ':protocol://:domain(.*)::port?/zh-cn/:path(.*)?'],
						['ja', ':protocol://:domain(.*)::port?/ja/:path(.*)?']
					]
				}
			],
			// Exempt surfaces (ledger §9.18.2, plus §21 for /i): routes that
			// must not carry a locale prefix resolve the locale from
			// cookie/detection instead of the URL; `exclude: true` skips the
			// i18n middleware entirely (API, demos and the /i asset proxy —
			// the docs' prescribed treatment for routes with no i18n surface).
			// Both lists live in `src/lib/config/locale-surfaces.ts`, the same
			// module the runtime link helper (`src/lib/utils/href.ts`) uses —
			// middleware overrides and chrome links cannot drift apart (P3-b).
			routeStrategies: [
				...cookieSurfaceMatches().map((match) => ({ match, strategy: [...COOKIE_CHAIN] })),
				...excludedSurfaceMatches().map((match) => ({ match, exclude: true as const }))
			]
		})
	],
	test: {
		expect: {
			requireAssertions: true
		},
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'client',
					browser: {
						enabled: true,
						provider: playwright(),
						testerHtmlPath: './vitest-tester.html',
						viewport: { width: 1280, height: 720 },
						instances: [
							{
								browser: 'chromium',
								headless: true
							}
						]
					},
					include: ['src/**/*.svelte.{test,spec}.{js,ts}'],
					exclude: ['src/lib/server/**'],
					// Browser interactions need headroom when the machine is
					// loaded (concurrent suites, review probes): the 15 s
					// default turns slow-but-correct runs into false negatives.
					testTimeout: 30000
				},
				// Lazy imports (KaTeX, mermaid) otherwise trigger a dep-optimizer pass
				// mid-test under full-suite load, blowing the 30 s test timeout.
				optimizeDeps: {
					include: ['katex', 'mermaid']
				}
			},
			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			},
			{
				extends: true,
				plugins: [
					// The plugin will run tests for the stories defined in your Storybook config
					// See options at: https://storybook.js.org/docs/next/writing-tests/integrations/vitest-addon#storybooktest
					storybookTest({
						configDir: path.join(dirname, '.storybook')
					})
				],
				test: {
					name: 'storybook',
					browser: {
						enabled: true,
						headless: true,
						provider: playwright({}),
						instances: [
							{
								browser: 'chromium'
							}
						]
					}
				}
			}
		]
	}
});
