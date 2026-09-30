import { createHash, createHmac } from 'node:crypto';

/**
 * Hand-rolled AWS Signature Version 4 signer, scoped to the S3 subset this
 * project uses (ledger §21): PUT/GET/DELETE/HEAD via the app proxy against
 * RustFS over loopback. No SDK dependency by design — the surface is small,
 * fixed, and locked by the official aws-sig-v4 test-suite vectors in
 * `signature.test.ts`.
 *
 * S3 dialect: the canonical URI is signed exactly as sent — single-encoded,
 * no dot-segment normalization (the generic SigV4 rules differ; the suite's
 * normalize-path cases intentionally do not apply here).
 */

export interface SigV4Credentials {
	accessKeyId: string;
	secretAccessKey: string;
}

export interface SigV4Request {
	method: string;
	/** Request path, already percent-encoded exactly as it will be sent. */
	canonicalUri: string;
	/** Raw query string without a leading `?` (empty when absent). */
	query?: string;
	/** Header pairs in wire order; duplicate names are combined per the spec. */
	headers: Array<[string, string]>;
	/** Lowercase-hex sha256 of the payload (see EMPTY_PAYLOAD_SHA256). */
	payloadHash: string;
	region: string;
	service: string;
	/** Clock injection point; the signer derives x-amz-date from it. */
	date: Date;
}

export interface SigV4SignedRequest {
	/** Headers to send, including x-amz-date and authorization. */
	headers: Array<[string, string]>;
	canonicalRequest: string;
	stringToSign: string;
	authorization: string;
}

/** sha256 of an empty payload, the SigV4 constant for bodyless requests. */
export const EMPTY_PAYLOAD_SHA256 =
	'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const AMZ_DATE_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

/** `YYYYMMDD'T'HHMMSS'Z'` (UTC) — the SigV4 timestamp format. */
export function formatAmzDate(date: Date): string {
	const iso = date.toISOString();
	return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

/** Inverse of {@link formatAmzDate}; used by the test vectors. */
export function parseAmzDate(amzDate: string): Date {
	const match = AMZ_DATE_PATTERN.exec(amzDate);
	if (!match) throw new Error(`Invalid x-amz-date: ${amzDate}`);
	return new Date(
		Date.UTC(
			Number(match[1]),
			Number(match[2]) - 1,
			Number(match[3]),
			Number(match[4]),
			Number(match[5]),
			Number(match[6])
		)
	);
}

export function sha256Hex(data: string | Uint8Array): string {
	return createHash('sha256').update(data).digest('hex');
}

/**
 * RFC 3986 encoding with the SigV4 unreserved set. Unlike
 * `encodeURIComponent`, `!*'()` stay encoded. `encodeSlash` keeps `/`
 * (path segments joined by / are encoded individually, then joined).
 */
export function uriEncode(input: string, encodeSlash: boolean): string {
	let out = '';
	for (const ch of input) {
		if (/[A-Za-z0-9\-._~]/.test(ch) || (ch === '/' && !encodeSlash)) {
			out += ch;
		} else {
			for (const byte of Buffer.from(ch, 'utf8')) {
				out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
			}
		}
	}
	return out;
}

function canonicalQueryOf(raw: string): string {
	if (!raw) return '';
	const pairs = raw
		.split('&')
		.filter((pair) => pair.length > 0)
		.map((pair) => {
			const eq = pair.indexOf('=');
			const key = eq === -1 ? pair : pair.slice(0, eq);
			const value = eq === -1 ? '' : pair.slice(eq + 1);
			return [uriEncode(key, true), uriEncode(value, true)] as const;
		});
	pairs.sort((a, b) =>
		a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0
	);
	return pairs.map(([key, value]) => `${key}=${value}`).join('&');
}

function canonicalHeadersOf(headers: Array<[string, string]>): {
	canonicalHeaders: string;
	signedHeaders: string;
} {
	const grouped = new Map<string, string[]>();
	for (const [rawName, rawValue] of headers) {
		const name = rawName.toLowerCase();
		const values = grouped.get(name) ?? [];
		values.push(rawValue.trim().replace(/\s+/g, ' '));
		grouped.set(name, values);
	}
	const names = [...grouped.keys()].sort();
	const canonicalHeaders = names
		.map((name) => `${name}:${grouped.get(name)!.join(',')}\n`)
		.join('');
	return { canonicalHeaders, signedHeaders: names.join(';') };
}

function hmac(key: Buffer | string, data: string): Buffer {
	return createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * Signs a request and returns the headers to send. `x-amz-date` is always
 * (re)derived from `request.date`; any input x-amz-date pair is replaced.
 */
export function signRequest(
	request: SigV4Request,
	credentials: SigV4Credentials
): SigV4SignedRequest {
	const amzDate = formatAmzDate(request.date);
	const dateStamp = amzDate.slice(0, 8);
	const headers: Array<[string, string]> = [
		...request.headers.filter(([name]) => name.toLowerCase() !== 'x-amz-date'),
		['x-amz-date', amzDate]
	];
	const { canonicalHeaders, signedHeaders } = canonicalHeadersOf(headers);
	const canonicalRequest = [
		request.method,
		request.canonicalUri,
		canonicalQueryOf(request.query ?? ''),
		canonicalHeaders,
		signedHeaders,
		request.payloadHash
	].join('\n');

	const scope = `${dateStamp}/${request.region}/${request.service}/aws4_request`;
	const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
	const signingKey = hmac(
		hmac(
			hmac(hmac(`AWS4${credentials.secretAccessKey}`, dateStamp), request.region),
			request.service
		),
		'aws4_request'
	);
	const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
	const authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

	return {
		headers: [...headers, ['authorization', authorization]],
		canonicalRequest,
		stringToSign,
		authorization
	};
}
