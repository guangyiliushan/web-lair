import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import { isPrivateAddress, type ResolvedAddress } from '../security/ssrf-guard.ts';

/**
 * Endpoint policy for the external storage driver: https only, no URL-borne
 * credentials; a hostname resolves and EVERY answer must be globally routable;
 * metadata addresses stay rejected even with the private-endpoint opt-in (a
 * LAN MinIO exemption must not become an IMDS read).
 * `ALLOW_PRIVATE_STORAGE_ENDPOINT=true` is the only way to accept RFC1918 /
 * loopback / link-local answers (owner-scoped at the action layer). The local
 * driver never comes through here (RustFS is loopback by design).
 *
 * Known gap: the DNS answer is validated, then the adapter dials the hostname
 * again - no connection pinning, so a rebind between the two lookups is out of
 * scope for v1 (bucket credentials must still be valid for any read; the links
 * checker closes the same window with `pinnedLookup`).
 */

export type StorageEndpointErrorCode =
	'non-https' | 'credentials' | 'metadata' | 'private' | 'resolve' | 'bad-url';

export class StorageEndpointError extends Error {
	readonly code: StorageEndpointErrorCode;

	constructor(code: StorageEndpointErrorCode, message: string) {
		super(message);
		this.name = 'StorageEndpointError';
		this.code = code;
	}
}

/**
 * Metadata services reachable from a cloud workload. Checked before and after
 * the private-range policy: `169.254.0.0/16` is private, but the opt-in flag
 * must never unlock these.
 */
const METADATA_ADDRESSES = new Set([
	'169.254.169.254', // AWS / GCP / Azure IMDS
	'169.254.170.2', // ECS task metadata (v2 credentials path)
	'100.100.100.200', // Alibaba Cloud
	'fd00:ec2::254', // AWS IMDS IPv6
	'fe80::a9fe:a9fe' // AWS IMDS over link-local
]);

export function isMetadataAddress(address: string): boolean {
	const clean = address.includes('%') ? address.slice(0, address.indexOf('%')) : address;
	const lower = clean.toLowerCase();
	if (METADATA_ADDRESSES.has(lower)) return true;
	// v4-mapped IPv6 (`::ffff:169.254.169.254`, normalised by WHATWG URL to
	// `::ffff:a9fe:a9fe`) must not slip past the denylist — with the LAN
	// opt-in on, the private-range check would otherwise be the only gate.
	if (lower.startsWith('::ffff:')) {
		const rest = lower.slice('::ffff:'.length);
		if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) return METADATA_ADDRESSES.has(rest);
		const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
		if (hex) {
			const hi = parseInt(hex[1], 16);
			const lo = parseInt(hex[2], 16);
			return METADATA_ADDRESSES.has(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
		}
	}
	return false;
}

function bareHost(hostname: string): string {
	return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

export type Resolver = (host: string) => Promise<ResolvedAddress[]>;

const defaultResolver: Resolver = async (host) => {
	const answers = await dns.lookup(host, { all: true });
	return answers.map((entry) => ({ address: entry.address, family: entry.family }));
};

/**
 * Throws `StorageEndpointError` when the endpoint must not be dialled.
 * Resolves (void) when the endpoint is acceptable under `options.allowPrivate`.
 */
export async function assertStorageEndpointAllowed(
	endpoint: string,
	options: { allowPrivate: boolean; resolve?: Resolver }
): Promise<void> {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		throw new StorageEndpointError('bad-url', 'Storage endpoint is not a URL');
	}
	if (url.protocol !== 'https:') {
		throw new StorageEndpointError('non-https', 'A storage endpoint must use https');
	}
	if (url.username || url.password) {
		throw new StorageEndpointError(
			'credentials',
			'Storage endpoint must not embed credentials in the URL'
		);
	}

	const host = bareHost(url.hostname);
	const resolve = options.resolve ?? defaultResolver;

	// An IP literal needs no lookup; classify it directly.
	let addresses: ResolvedAddress[];
	if (isIP(host) !== 0) {
		if (isMetadataAddress(host)) {
			throw new StorageEndpointError('metadata', 'Storage endpoint points at a metadata service');
		}
		addresses = [{ address: host, family: isIP(host) }];
	} else {
		try {
			addresses = await resolve(host);
		} catch {
			throw new StorageEndpointError('resolve', 'Storage endpoint host did not resolve');
		}
	}
	if (addresses.length === 0) {
		throw new StorageEndpointError('resolve', 'Storage endpoint host did not resolve');
	}
	if (addresses.some((entry) => isMetadataAddress(entry.address))) {
		throw new StorageEndpointError('metadata', 'Storage endpoint points at a metadata service');
	}
	if (!options.allowPrivate && addresses.some((entry) => isPrivateAddress(entry.address))) {
		throw new StorageEndpointError(
			'private',
			'Storage endpoint resolves to a private address (set ALLOW_PRIVATE_STORAGE_ENDPOINT=true for a LAN endpoint)'
		);
	}
}

/** Reads the opt-in flag; anything but an explicit "true" is off (fail closed). */
export function allowPrivateEndpoint(source: Record<string, string | undefined>): boolean {
	return source.ALLOW_PRIVATE_STORAGE_ENDPOINT?.trim().toLowerCase() === 'true';
}
