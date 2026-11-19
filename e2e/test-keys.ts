/**
 * Fixed HMAC keys for the Playwright run (32 bytes each, base64).
 *
 * The preview server runs a production build, so the suppression boot guard
 * requires a real key and the mail-events endpoint is fail-closed without one.
 * Tests compute the same hashes/signatures from these constants; they are test
 * material and never used by a deployment.
 */
export const TEST_SUBSCRIBE_HMAC_KEY = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=';
/**
 * Token derivation secret. The preview is a production build, so the boot
 * guard requires it; specs re-derive the mailed token from `token_nonce`
 * instead of reading a plaintext column (which no longer exists).
 */
export const TEST_SUBSCRIBE_TOKEN_SECRET = 'DQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0=';
export const TEST_SUPPRESSION_HMAC_KEY = 'CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk=';
export const TEST_MAIL_EVENTS_HMAC_KEY = 'CwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws=';
/**
 * Runtime keyring. The webhook create/rotate actions encrypt the signing
 * secret before storing it, so the preview needs a keyring; without it the
 * dialog answers 503 and never closes. One fixed version for the whole run.
 */
export const TEST_SECRETS_KEY = 'REREREREREREREREREREREREREREREREREREREREREQ=';
