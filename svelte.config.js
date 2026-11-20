import { mdsvex } from 'mdsvex';
import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Every first-party component is runes; node_modules keep their own mode
		// (`undefined` = infer). Removable once Svelte 6 defaults `runes: true`.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		// Single self-hosted Node process behind Caddy: adapter-node emits `build/`,
		// which the Dockerfile runs (`node build`).
		adapter: adapter(),

		// `'*'` trusts every origin, switching SvelteKit's CSRF check off. That check runs
		// before any hook, so only `handleCsrf` (`src/hooks.server.ts`) can exempt the RFC 8058
		// one-click unsubscribe POST (no Origin, no cookies) — it re-implements the predicate.
		csrf: {
			trustedOrigins: ['*']
		},

		typescript: {
			config: (config) => ({
				...config,
				include: [...config.include, '../drizzle.config.ts']
			})
		},
		alias: {
			'@/*': './path/to/lib/*'
		}
	},
	preprocess: [mdsvex({ extensions: ['.svx', '.md'] })],
	extensions: ['.svelte', '.svx', '.md']
};

export default config;
