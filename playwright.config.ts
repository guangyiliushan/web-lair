import { defineConfig } from '@playwright/test';

export default defineConfig({
	use: { baseURL: 'http://localhost:4173' },
	webServer: {
		command: 'npm run build && npm run preview',
		port: 4173,
		// a cold production build alone takes ~50s on this machine; the
		// default 60s readiness timeout kills the webServer mid-build
		timeout: 300_000
	},
	testDir: 'e2e',
	testMatch: '**/*.e2e.{ts,js}'
});
