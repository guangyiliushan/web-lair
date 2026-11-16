import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { cookieSurfaceMatches, excludedSurfaceMatches } from './src/lib/config/locale-surfaces.ts';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { sveltekit } from '@sveltejs/kit/vite';
import path from 'node:path';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';

const dirname = import.meta.dirname;

/** Locale chain for the locale-free surfaces, in precedence order (no `url` source). */
const COOKIE_CHAIN = ['cookie', 'preferredLanguage', 'baseLocale'] as const;

const DEFAULT_BROWSER_API_PORT = 43017;

/**
 * Keep the port outside Windows' reserved bands: Vitest's 63315 default can land in a
 * Hyper-V/WSL reservation (bind fails with EACCES), and `port: 0` resolves back to that
 * default instead of picking a free port. 43017 is below the ephemeral range (49152+).
 */
function browserApiPort(): number {
	const raw = process.env.VITEST_BROWSER_API_PORT;
	const port = Number(raw ?? DEFAULT_BROWSER_API_PORT);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		// dev/build/check load this file too; only a test run should fail hard.
		const message = `VITEST_BROWSER_API_PORT must be a TCP port (1-65535), got "${raw}"`;
		if (process.env.VITEST) throw new Error(message);
		console.warn(`[vite.config] ${message}; using ${DEFAULT_BROWSER_API_PORT}`);
		return DEFAULT_BROWSER_API_PORT;
	}
	return port;
}

/**
 * Packages the startup scan cannot reach (dynamic imports, lazy admin widgets, map/chart
 * islands). Discovering one mid-session re-bundles every dependency and reloads the page,
 * which costs minutes on Windows; listing them pays that once at startup.
 */
const lazyClientDeps = [
	// Markdown editor + preview
	'lexical',
	'@lexical/code',
	'@lexical/extension',
	'@lexical/history',
	'@lexical/link',
	'@lexical/list',
	'@lexical/markdown',
	'@lexical/rich-text',
	'@lexical/selection',
	'@lexical/table',
	'@lexical/utils',
	'katex',
	'mermaid',
	// Source editor on /admin/jobs
	'@codemirror/state',
	'@codemirror/view',
	'@codemirror/commands',
	'@codemirror/language',
	'@codemirror/lang-javascript',
	// Photo wall + map islands
	'svelte-maplibre-gl',
	'pmtiles',
	'@protomaps/basemaps',
	'@masonry-grid/svelte',
	// Shared UI primitives
	'bits-ui',
	'vaul-svelte',
	'layerchart',
	'@humanspeak/svelte-motion',
	'svelte-gestures',
	'tailwind-merge',
	'tailwind-variants',
	'thumbhash'
];

/** Icon modules only browser specs mount: same mid-test reload hazard as `lazyClientDeps`. */
const specIconDeps = [
	// Owner presence badges (StatusTicket / OwnerStatusCard)
	'@tabler/icons-svelte-runes/icons/app-window',
	'@tabler/icons-svelte-runes/icons/brand-vscode',
	// media-upload-dialog's tree (upload / photo / file / x)
	'@tabler/icons-svelte-runes/icons/file',
	'@tabler/icons-svelte-runes/icons/photo',
	'@tabler/icons-svelte-runes/icons/upload',
	'@tabler/icons-svelte-runes/icons/x',
	// Admin dashboard / analytics specs
	'@tabler/icons-svelte-runes/icons/activity',
	'@tabler/icons-svelte-runes/icons/arrow-right',
	'@tabler/icons-svelte-runes/icons/article',
	'@tabler/icons-svelte-runes/icons/bulb',
	'@tabler/icons-svelte-runes/icons/notebook',
	'@tabler/icons-svelte-runes/icons/quote',
	'@tabler/icons-svelte-runes/icons/refresh',
	'@tabler/icons-svelte-runes/icons/tool',
	'@tabler/icons-svelte-runes/icons/trending-up',
	'@tabler/icons-svelte-runes/icons/users',
	'@tabler/icons-svelte-runes/icons/writing'
];

export default defineConfig({
	optimizeDeps: {
		include: lazyClientDeps,
		// Ships raw `.svelte` sources in dist; the dependency pre-bundler cannot parse them.
		exclude: ['@shadcn-svelte/primitives']
	},
	ssr: {
		// Same package, SSR graph: Node cannot load its `.svelte` sources.
		noExternal: ['@shadcn-svelte/primitives']
	},
	server: {
		// Generated output (`build/`, `storybook-static/`): watching it stalls Windows' watcher.
		watch: {
			ignored: ['**/build/**', '**/storybook-static/**']
		},
		// Pre-transform the admin shell and editor routes to avoid a transform waterfall.
		warmup: {
			clientFiles: [
				'./src/routes/+layout.svelte',
				'./src/routes/(admin)/+layout.svelte',
				'./src/routes/(admin)/admin/posts/edit/+page.svelte',
				'./src/routes/(admin)/admin/notes/edit/+page.svelte',
				'./src/lib/components/layout/Header.svelte',
				'./src/lib/config/navigation.config.ts'
			]
		}
	},
	plugins: [
		tailwindcss(),
		sveltekit(),
		paraglideVitePlugin({
			project: './project.inlang',
			outdir: './src/lib/paraglide',
			// Order is precedence: URL prefix, then the user's cookie, then first-visit
			// detection, then the base locale. `globalVariable` (the compiler default) is
			// module-level state shared across SSR requests, so it is unsafe here.
			strategy: ['url', 'cookie', 'preferredLanguage', 'baseLocale'],
			// Patterns match in declaration order, so the bare-locale entries stay first:
			// otherwise `/en` hits the catch-all and de-localizes to `/`. With them `/en`
			// reaches Kit unchanged and 404s (`/en/` is a trailing-slash 308 to `/en`).
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
			// Exempt surfaces resolve the locale from the cookie chain, or skip the i18n
			// middleware entirely (`exclude`: API, demos, `/i`). Both lists live in
			// `src/lib/config/locale-surfaces.ts`, which `href.ts` shares, so links cannot drift.
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
				extends: true,
				test: {
					name: 'client',
					browser: {
						enabled: true,
						provider: playwright(),
						testerHtmlPath: './vitest-tester.html',
						api: { host: '127.0.0.1', port: browserApiPort() },
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
					// Shared browser setup: raises Chromium's 250-entry resource-timing buffer.
					setupFiles: ['./src/lib/testing/client-setup.ts'],
					// Slow-but-correct browser runs need headroom over the 15 s default.
					testTimeout: 30000
				},
				// Same hazard as dev, plus the icons only specs mount.
				optimizeDeps: {
					include: [...lazyClientDeps, ...specIconDeps]
				}
			},
			{
				extends: true,
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
						// Pin to this file's dir: the default resolves `.storybook` from the CWD.
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
