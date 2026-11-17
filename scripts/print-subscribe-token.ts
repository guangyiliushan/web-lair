/**
 * Print the confirmation token currently mailed for a pending subscription.
 *
 * Only `token_nonce` and `token_hash` remain (the plaintext `token` column
 * is gone), so the link is re-derived from the nonce with
 * `SUBSCRIBE_TOKEN_SECRET`. Usage:
 *   node scripts/print-subscribe-token.ts <email>
 *   node scripts/print-subscribe-token.ts --nonce <43-char nonce>
 *
 * The runtime image ships `scripts/` without `src/`, so the derivation is
 * duplicated here; `subscription-token.test.ts` pins this copy byte-for-byte
 * against `deriveSubscriptionToken` so the two cannot drift. The token is a
 * bearer credential: it goes to stdout only.
 */
import { createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';

/** Must match `TOKEN_DERIVATION_LABEL` in subscription-token.ts. */
export const TOKEN_DERIVATION_LABEL = 'wl:subscribe:token:v1:';

/** 32-byte base64 secret or null (same alphabet/length rule as decodeHmacKey). */
export function decodeSecret(raw: string | undefined): Buffer | null {
	const value = (raw ?? '').trim();
	if (!value) return null;
	if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return null;
	if (value.length !== 43 && value.length !== 44) return null;
	const key = Buffer.from(value, 'base64');
	return key.length === 32 ? key : null;
}

export function deriveTokenFromNonce(nonce: string, secret: Buffer): string {
	return createHmac('sha256', secret)
		.update(TOKEN_DERIVATION_LABEL + nonce)
		.digest('base64url');
}

async function main(): Promise<void> {
	const DB_URL = process.env.DATABASE_URL;
	if (!DB_URL) {
		console.error('[print-subscribe-token] DATABASE_URL is required');
		process.exit(1);
	}
	const secret = decodeSecret(process.env.SUBSCRIBE_TOKEN_SECRET);
	if (!secret) {
		console.error(
			'[print-subscribe-token] SUBSCRIBE_TOKEN_SECRET is missing or not 32 base64-encoded bytes'
		);
		process.exit(1);
	}

	const args = process.argv.slice(2);
	const nonceFlag = args.indexOf('--nonce');
	const sql = postgres(DB_URL, { max: 1 });
	try {
		let nonce: string;
		let label: string;
		if (nonceFlag !== -1) {
			nonce = (args[nonceFlag + 1] ?? '').trim();
			label = 'nonce (supplied)';
		} else {
			const email = (args[0] ?? '').trim();
			if (!email) {
				console.error('[print-subscribe-token] pass an email or --nonce <nonce>');
				process.exit(2);
			}
			const [row] = await sql`
				select token_nonce, status from subscriptions where email = ${email} limit 1
			`;
			if (!row) {
				console.error(`[print-subscribe-token] no subscription row for ${email}`);
				process.exit(1);
			}
			nonce = row.token_nonce as string;
			label = `email (status=${row.status})`;
		}
		console.log(deriveTokenFromNonce(nonce, secret));
		console.error(`[print-subscribe-token] derived from ${label}`);
	} finally {
		await sql.end({ timeout: 5 });
	}
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	void main();
}
