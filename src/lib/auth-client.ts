import { createAuthClient } from 'better-auth/svelte';
import { passkeyClient } from '@better-auth/passkey/client';

/**
 * Browser-side better-auth client. Only passkey registration needs it: the
 * WebAuthn ceremony runs in the browser, so the server action cannot create a
 * passkey on the account's behalf. Everything else on the admin surface stays
 * on SvelteKit form actions (no session/token handling in client code).
 */
export const authClient = createAuthClient({
	plugins: [passkeyClient()]
});
