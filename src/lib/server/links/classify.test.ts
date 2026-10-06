import { describe, expect, it } from 'vitest';
import { classifyFetchFailure, classifyHttpStatus } from './classify';

const coded = (code: string) => Object.assign(new Error(`synthetic ${code}`), { code });

describe('links classify (§4.3)', () => {
	it('classifies timeout via name or undici timeout codes (retryable)', () => {
		const byName = Object.assign(new Error('t'), { name: 'TimeoutError' });
		expect(classifyFetchFailure(byName)).toMatchObject({
			kind: 'timeout',
			countsFailure: true,
			retryable: true
		});
		const wrapped = new TypeError('fetch failed', {
			cause: coded('UND_ERR_HEADERS_TIMEOUT')
		});
		expect(classifyFetchFailure(wrapped).kind).toBe('timeout');
		expect(classifyFetchFailure(wrapped).retryable).toBe(true);
	});

	it('classifies TLS certificate failures from the cause chain', () => {
		const err = new TypeError('fetch failed', { cause: coded('CERT_HAS_EXPIRED') });
		expect(classifyFetchFailure(err)).toMatchObject({
			kind: 'tls',
			countsFailure: true,
			retryable: false
		});
	});

	it('walks AggregateError members (multi-address hosts)', () => {
		const aggregate = new AggregateError([coded('ECONNREFUSED'), coded('EHOSTUNREACH')]);
		const err = new TypeError('fetch failed', { cause: aggregate });
		expect(classifyFetchFailure(err).kind).toBe('connect');
	});

	it('classifies dns failures', () => {
		const err = new TypeError('fetch failed', { cause: coded('ENOTFOUND') });
		expect(classifyFetchFailure(err).kind).toBe('dns');
	});

	it('classifies fetch-layer refusals (bad port) as unsupported, not counted', () => {
		const err = new TypeError('fetch failed', { cause: new TypeError('bad port') });
		expect(classifyFetchFailure(err)).toMatchObject({
			kind: 'unsupported',
			countsFailure: false
		});
	});

	it('falls back to connect for unknown network errors, counted', () => {
		expect(classifyFetchFailure(new Error('mystery'))).toMatchObject({
			kind: 'connect',
			countsFailure: true
		});
	});

	it('maps HTTP statuses to the vocabulary', () => {
		expect(classifyHttpStatus(200).ok).toBe(true);
		expect(classifyHttpStatus(204).ok).toBe(true);
		expect(classifyHttpStatus(404)).toMatchObject({
			ok: false,
			failure: { kind: 'http_gone', countsFailure: true }
		});
		expect(classifyHttpStatus(410).failure?.kind).toBe('http_gone');
		for (const status of [401, 403, 429, 451, 503]) {
			expect(classifyHttpStatus(status).failure, `status ${status}`).toMatchObject({
				kind: 'waf',
				countsFailure: false
			});
		}
		expect(classifyHttpStatus(500).failure).toMatchObject({
			kind: 'http_error',
			countsFailure: true,
			retryable: true
		});
		expect(classifyHttpStatus(400).failure).toMatchObject({
			kind: 'http_error',
			countsFailure: true,
			retryable: false
		});
		expect(classifyHttpStatus(302).failure?.kind).toBe('http_error');
	});
});
