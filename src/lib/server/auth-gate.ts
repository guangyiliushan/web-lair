/**
 * Public sign-up is only meaningful when a verification mail can be sent.
 *
 * better-auth creates the user first and calls `sendVerificationEmail`
 * afterwards (node_modules/better-auth/dist/api/routes/sign-up.mjs:224,252);
 * when the transport is unconfigured that call throws inside the background
 * runner, so an API sign-up answers 200 and leaves an account that can never
 * be verified. The register form already returns 503 in that state — this
 * predicate gives the API the same contract without touching auth internals.
 */
export const SIGN_UP_PATH = '/api/auth/sign-up/email';

export function isSignUpBlocked(input: {
	method: string;
	pathname: string;
	mailAvailable: boolean;
}): boolean {
	return input.method === 'POST' && input.pathname === SIGN_UP_PATH && !input.mailAvailable;
}
