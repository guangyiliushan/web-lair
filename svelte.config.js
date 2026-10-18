import { mdsvex } from 'mdsvex';
import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		// Deployment target: a single self-hosted Node process behind Caddy
		// (ledger §25 / platform plan §C). adapter-node emits `build/` and is
		// what the Dockerfile runs; see deploy/RUNBOOK.md.
		adapter: adapter(),

		// The framework CSRF check runs before hooks, so it cannot exempt the
		// RFC 8058 one-click unsubscribe POST (no Origin, no cookies). The first
		// hook (`handleCsrf`) reproduces the exact framework predicate and owns
		// the single exemption; see src/lib/server/security/csrf.ts.
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
