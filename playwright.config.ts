import { defineConfig } from '@playwright/test';
import {
	TEST_MAIL_EVENTS_HMAC_KEY,
	TEST_SECRETS_KEY,
	TEST_SUBSCRIBE_HMAC_KEY,
	TEST_SUBSCRIBE_TOKEN_SECRET,
	TEST_SUPPRESSION_HMAC_KEY
} from './e2e/test-keys';

export default defineConfig({
	use: {
		baseURL: 'http://localhost:4173',
		// MapLibre needs a WebGL context: headless chromium falls back to
		// SwiftShader, which recent versions gate behind this flag.
		launchOptions: { args: ['--enable-unsafe-swiftshader'] }
	},
	webServer: {
		command: 'npm run build && npm run preview',
		port: 4173,
		// A cold production build takes ~50s on an idle machine and 130-260s
		// on a loaded one; on 2026-10-02 the 300s budget was blown three
		// times in a row (build 256s + preview boot). Keep a generous margin.
		// A scratch-database run keeps one preview server alive across chunks;
		// reusing it avoids rebuilding and keeps DATABASE_URL pinned.
		reuseExistingServer: true,
		timeout: 600_000,
		// `preview` is a production build, so the loopback sign-in source has to
		// be switched on explicitly (see security/tailscale-auth.ts).
		// ORIGIN pins better-auth's baseURL: with it empty AND NODE_ENV=production,
		// better-auth marks every cookie Secure (`__Secure-` prefix), and those
		// set by form actions never reached the browser on this plain-http origin
		// (B3.1 bootstrapping finding - the challenge/page flows lost their
		// session cookie). Pinning the http origin makes the preview behave like
		// a real deployment on its own scheme.
		env: {
			TAILSCALE_ALLOW_LOOPBACK: 'true',
			ORIGIN: 'http://localhost:4173',
			// Isolation seam: when the caller points DATABASE_URL at a scratch
			// database (local_e2e), the preview and the psql helper must use it
			// too. Unset keeps the historical dev database.
			...(process.env.DATABASE_URL ? { DATABASE_URL: process.env.DATABASE_URL } : {}),
			// Mail is unconfigured in tests: the transport logs the message
			// instead of failing (production keeps the fail-loud contract).
			MAIL_DEV_LOG: 'true',
			// Second explicit switch: production builds only dev-log with it.
			MAIL_DEV_LOG_OK: 'true',
			// E1/E2 HMAC keys: the preview is a production build, so the
			// suppression boot guard and the mail-events endpoint need real keys.
			SUBSCRIBE_HMAC_KEY: TEST_SUBSCRIBE_HMAC_KEY,
			SUBSCRIBE_TOKEN_SECRET: TEST_SUBSCRIBE_TOKEN_SECRET,
			SUPPRESSION_HMAC_KEY: TEST_SUPPRESSION_HMAC_KEY,
			MAIL_EVENTS_HMAC_KEY: TEST_MAIL_EVENTS_HMAC_KEY,
			// W2: webhook signing secrets are encrypted before insert, so the
			// preview needs a usable keyring for the create/rotate actions.
			SECRETS_KEYS: `1:${TEST_SECRETS_KEY}`,
			SECRETS_KEY_ACTIVE: '1'
		}
	},
	testDir: 'e2e',
	testMatch: '**/*.e2e.{ts,js}'
});
