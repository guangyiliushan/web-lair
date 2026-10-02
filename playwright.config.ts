import { defineConfig } from '@playwright/test';

export default defineConfig({
	use: { baseURL: 'http://localhost:4173' },
	webServer: {
		command: 'npm run build && npm run preview',
		port: 4173,
		// A cold production build takes ~50s on an idle machine and 130-260s
		// on a loaded one; on 2026-10-02 the 300s budget was blown three
		// times in a row (build 256s + preview boot). Keep a generous margin.
		timeout: 600_000,
		// `preview` is a production build, so the loopback sign-in source has to
		// be switched on explicitly (see security/tailscale-auth.ts).
		// ORIGIN pins better-auth's baseURL: with it empty AND NODE_ENV=production,
		// better-auth marks every cookie Secure (`__Secure-` prefix), and those
		// set by form actions never reached the browser on this plain-http origin
		// (B3.1 bootstrapping finding - the challenge/page flows lost their
		// session cookie). Pinning the http origin makes the preview behave like
		// a real deployment on its own scheme.
		env: { TAILSCALE_ALLOW_LOOPBACK: 'true', ORIGIN: 'http://localhost:4173' }
	},
	testDir: 'e2e',
	testMatch: '**/*.e2e.{ts,js}'
});
