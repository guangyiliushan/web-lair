/**
 * Fixed HMAC keys for the Playwright run (32 bytes each, base64).
 *
 * The preview server runs a production build, so the suppression boot guard
 * requires a real key and the mail-events endpoint is fail-closed without one.
 * Tests compute the same hashes/signatures from these constants; they are test
 * material and never used by a deployment.
 */
export const TEST_SUBSCRIBE_HMAC_KEY = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=';
export const TEST_SUPPRESSION_HMAC_KEY = 'CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk=';
export const TEST_MAIL_EVENTS_HMAC_KEY = 'CwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws=';
