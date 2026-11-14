import { describe, expect, it } from 'vitest';
import { signWebhookPayload, signingKey, webhookHeaders } from './signature';

describe('signWebhookPayload', () => {
	/**
	 * Known-answer test. The expected value was computed with an independent
	 * implementation (Python hmac/hashlib/base64) over the Standard Webhooks
	 * README example: secret whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw, message id
	 * msg_p5jXN8AQM9LWM0D4loKWxJek, timestamp 1614265330, body {"test": 2432232314}.
	 */
	it('matches the spec example (whsec_ base64-decoded key)', () => {
		const signature = signWebhookPayload(
			'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
			'msg_p5jXN8AQM9LWM0D4loKWxJek',
			1614265330,
			'{"test": 2432232314}'
		);
		expect(signature).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
	});

	it('signs id.timestamp.body delimited by full stops', () => {
		const secret = 'plain-secret';
		const expected = signWebhookPayload(secret, 'id-1', 1700000000, '{"a":1}');
		// Same inputs -> same signature; a different body must diverge.
		expect(signWebhookPayload(secret, 'id-1', 1700000000, '{"a":1}')).toBe(expected);
		expect(signWebhookPayload(secret, 'id-1', 1700000000, '{"a":2}')).not.toBe(expected);
		expect(signWebhookPayload(secret, 'id-2', 1700000000, '{"a":1}')).not.toBe(expected);
	});

	it('uses raw UTF-8 bytes for non-whsec_ secrets', () => {
		expect(signingKey('plain-secret')).toEqual(Buffer.from('plain-secret', 'utf8'));
	});

	it('always emits the v1 prefix', () => {
		expect(signWebhookPayload('s', 'i', 1, 'b').startsWith('v1,')).toBe(true);
	});
});

describe('webhookHeaders', () => {
	it('builds the three Standard Webhooks headers', () => {
		const headers = webhookHeaders('whsec_c2VjcmV0', 'delivery-1', 1700000000, '{"x":1}');
		expect(headers['webhook-id']).toBe('delivery-1');
		expect(headers['webhook-timestamp']).toBe('1700000000');
		expect(headers['webhook-signature']).toBe(
			signWebhookPayload('whsec_c2VjcmV0', 'delivery-1', 1700000000, '{"x":1}')
		);
	});

	it('carries the current and previous signatures during a rotation (W2.6)', () => {
		const headers = webhookHeaders('whsec_bmV3', 'delivery-2', 1700000000, '{"x":1}', [
			'whsec_b2xk'
		]);
		const signatures = headers['webhook-signature'].split(' ');
		expect(signatures).toHaveLength(2);
		expect(signatures[0]).toBe(
			signWebhookPayload('whsec_bmV3', 'delivery-2', 1700000000, '{"x":1}')
		);
		expect(signatures[1]).toBe(
			signWebhookPayload('whsec_b2xk', 'delivery-2', 1700000000, '{"x":1}')
		);
		// A receiver holding the old secret can verify the second entry.
		expect(signatures).toContain(
			signWebhookPayload('whsec_b2xk', 'delivery-2', 1700000000, '{"x":1}')
		);
	});

	it('never repeats an identical secret and ignores empty entries', () => {
		const headers = webhookHeaders('same', 'delivery-3', 1700000000, 'b', ['same', '']);
		expect(headers['webhook-signature'].split(' ')).toHaveLength(1);
	});
});
