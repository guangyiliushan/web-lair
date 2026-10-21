import { describe, expect, it } from 'vitest';
import { deriveSubscriptionToken, newSubscriptionNonce } from './subscription-token';
import {
	TOKEN_DERIVATION_LABEL,
	decodeSecret,
	deriveTokenFromNonce
} from '../../../../scripts/print-subscribe-token';

/**
 * The runtime image has no `src/`, so `scripts/print-subscribe-token.ts` keeps
 * its own copy of the derivation (used by the RUNBOOK one-click smoke). These
 * pins are the contract that keeps the copy honest: any change to the label or
 * the HMAC scheme on one side turns the other side red.
 */
const SECRET = Buffer.alloc(32, 0x11);

describe('print-subscribe-token parity (F-13)', () => {
	it('derives exactly what the service derives', () => {
		for (const nonce of ['a'.repeat(43), newSubscriptionNonce(), 'Z'.repeat(43)]) {
			expect(deriveTokenFromNonce(nonce, SECRET)).toBe(deriveSubscriptionToken(nonce, SECRET));
		}
	});

	it('shares the derivation label with the service module', async () => {
		// The label is internal to subscription-token.ts; pin the observable
		// consequence instead of importing a non-exported constant: a wrong
		// label would make the two derivations differ for every nonce.
		const nonce = 'x'.repeat(43);
		expect(deriveTokenFromNonce(nonce, SECRET)).toBe(deriveSubscriptionToken(nonce, SECRET));
		expect(TOKEN_DERIVATION_LABEL).toBe('wl:subscribe:token:v1:');
	});

	it('decodes the same secrets the app accepts', () => {
		const standard = Buffer.alloc(32, 7).toString('base64');
		expect(decodeSecret(standard)?.length).toBe(32);
		expect(decodeSecret(` ${standard} `)?.length).toBe(32);
		expect(decodeSecret('')).toBeNull();
		expect(decodeSecret(undefined)).toBeNull();
		expect(decodeSecret('short')).toBeNull();
		expect(decodeSecret(Buffer.alloc(31, 1).toString('base64'))).toBeNull();
		expect(decodeSecret('!!!!')).toBeNull();
	});
});
