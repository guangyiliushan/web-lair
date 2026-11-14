import { describe, expect, it } from 'vitest';
import {
	StorageEndpointError,
	allowPrivateEndpoint,
	assertStorageEndpointAllowed,
	isMetadataAddress
} from './endpoint-guard';

/**
 * Endpoint SSRF policy (W7.3, decision Q19): https only, no URL credentials,
 * every resolved answer publicly routable, and metadata addresses rejected
 * even when the LAN opt-in is on.
 */
const resolveTo =
	(...addresses: string[]) =>
	async () =>
		addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

async function expectCode(promise: Promise<void>, code: string) {
	await expect(promise).rejects.toBeInstanceOf(StorageEndpointError);
	await expect(promise).rejects.toMatchObject({ code });
}

describe('storage endpoint guard', () => {
	it('requires https and no embedded credentials', async () => {
		await expectCode(
			assertStorageEndpointAllowed('http://s3.example.com', {
				allowPrivate: false,
				resolve: resolveTo('93.184.216.34')
			}),
			'non-https'
		);
		await expectCode(
			assertStorageEndpointAllowed('https://key:secret@s3.example.com', {
				allowPrivate: false,
				resolve: resolveTo('93.184.216.34')
			}),
			'credentials'
		);
		await expectCode(assertStorageEndpointAllowed('not a url', { allowPrivate: false }), 'bad-url');
	});

	it('accepts a public endpoint', async () => {
		await expect(
			assertStorageEndpointAllowed('https://s3.example.com', {
				allowPrivate: false,
				resolve: resolveTo('93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946')
			})
		).resolves.toBeUndefined();
	});

	it('rejects private, loopback and link-local answers by default', async () => {
		for (const address of [
			'10.0.0.5',
			'192.168.1.10',
			'172.16.5.4',
			'127.0.0.1',
			'169.254.1.1',
			'::1',
			'fe80::1',
			'fd00::1'
		]) {
			await expectCode(
				assertStorageEndpointAllowed('https://s3.example.com', {
					allowPrivate: false,
					resolve: resolveTo(address)
				}),
				'private'
			);
		}
	});

	it('rejects a mixed answer set (one private address is enough)', async () => {
		await expectCode(
			assertStorageEndpointAllowed('https://s3.example.com', {
				allowPrivate: false,
				resolve: resolveTo('93.184.216.34', '10.0.0.5')
			}),
			'private'
		);
	});

	it('allows a LAN endpoint only with the explicit opt-in', async () => {
		await expect(
			assertStorageEndpointAllowed('https://minio.lan', {
				allowPrivate: true,
				resolve: resolveTo('192.168.1.10')
			})
		).resolves.toBeUndefined();
	});

	it('never allows a metadata address, even with the LAN opt-in', async () => {
		for (const address of [
			'169.254.169.254',
			'169.254.170.2',
			'100.100.100.200',
			'fd00:ec2::254',
			// v4-mapped forms: URL normalises [::ffff:169.254.169.254] to
			// ::ffff:a9fe:a9fe, which must still hit the metadata denylist.
			'::ffff:169.254.169.254',
			'::ffff:a9fe:a9fe'
		]) {
			await expectCode(
				assertStorageEndpointAllowed('https://s3.example.com', {
					allowPrivate: true,
					resolve: resolveTo(address)
				}),
				'metadata'
			);
		}
	});

	it('classifies an IP literal without a DNS lookup', async () => {
		await expectCode(
			assertStorageEndpointAllowed('https://169.254.169.254', {
				allowPrivate: true,
				resolve: resolveTo('93.184.216.34')
			}),
			'metadata'
		);
		await expect(
			assertStorageEndpointAllowed('https://93.184.216.34', {
				allowPrivate: false,
				resolve: resolveTo('10.0.0.1')
			})
		).resolves.toBeUndefined();
		await expectCode(
			assertStorageEndpointAllowed('https://10.0.0.5', { allowPrivate: false }),
			'private'
		);
	});

	it('classifies a v4-mapped private address as private', async () => {
		await expectCode(
			assertStorageEndpointAllowed('https://s3.example.com', {
				allowPrivate: false,
				resolve: resolveTo('::ffff:127.0.0.1')
			}),
			'private'
		);
	});

	it('fails closed when the host does not resolve', async () => {
		await expectCode(
			assertStorageEndpointAllowed('https://s3.example.com', {
				allowPrivate: true,
				resolve: async () => []
			}),
			'resolve'
		);
		await expectCode(
			assertStorageEndpointAllowed('https://s3.example.com', {
				allowPrivate: true,
				resolve: async () => {
					throw new Error('ENOTFOUND');
				}
			}),
			'resolve'
		);
	});

	it('reads the LAN opt-in conservatively', () => {
		expect(allowPrivateEndpoint({})).toBe(false);
		expect(allowPrivateEndpoint({ ALLOW_PRIVATE_STORAGE_ENDPOINT: 'false' })).toBe(false);
		expect(allowPrivateEndpoint({ ALLOW_PRIVATE_STORAGE_ENDPOINT: '1' })).toBe(false);
		expect(allowPrivateEndpoint({ ALLOW_PRIVATE_STORAGE_ENDPOINT: ' TRUE ' })).toBe(true);
	});

	it('recognises the metadata denylist entries, including v4-mapped forms', () => {
		expect(isMetadataAddress('169.254.169.254')).toBe(true);
		expect(isMetadataAddress('fd00:ec2::254')).toBe(true);
		expect(isMetadataAddress('::ffff:169.254.169.254')).toBe(true);
		expect(isMetadataAddress('::ffff:a9fe:a9fe')).toBe(true);
		expect(isMetadataAddress('93.184.216.34')).toBe(false);
		expect(isMetadataAddress('::ffff:93.184.216.34')).toBe(false);
	});
});
