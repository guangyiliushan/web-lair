import { describe, expect, it, vi } from 'vitest';
import {
	WebhookUrlError,
	assertDeliveryTarget,
	isBlockedWebhookAddress,
	isBlockedWebhookHostname,
	validateWebhookUrl,
	webhookAllowPrivateTargets,
	webhookGuardOptionsFromEnv
} from './url-guard';

const PUBLIC_V4 = ['93.184.216.34'];
const publicLookup = vi.fn(async () => PUBLIC_V4);

function reasonOf(error: unknown): string | undefined {
	return error instanceof WebhookUrlError ? error.reason : undefined;
}

describe('webhook url guard: stored URLs (W9.3)', () => {
	it('accepts an https URL with a public address and returns the normalized href', async () => {
		await expect(
			validateWebhookUrl('HTTPS://Example.com/hook', { lookup: publicLookup })
		).resolves.toBe('https://example.com/hook');
		await expect(validateWebhookUrl('https:example.com', { lookup: publicLookup })).resolves.toBe(
			'https://example.com/'
		);
	});

	it('refuses plain http, non-http schemes and credentialed URLs', async () => {
		await expect(
			validateWebhookUrl('http://example.com/hook', { lookup: publicLookup })
		).rejects.toSatisfy((error) => reasonOf(error) === 'insecure_scheme');
		await expect(
			validateWebhookUrl('ftp://example.com/hook', { lookup: publicLookup })
		).rejects.toSatisfy((error) => reasonOf(error) === 'insecure_scheme');
		await expect(
			validateWebhookUrl('https://user:pass@example.com/hook', { lookup: publicLookup })
		).rejects.toSatisfy((error) => reasonOf(error) === 'credentials');
		await expect(validateWebhookUrl('not a url', { lookup: publicLookup })).rejects.toSatisfy(
			(error) => reasonOf(error) === 'invalid_url'
		);
	});

	it('blocks loopback, RFC1918, CGNAT, link-local/metadata and reserved IPv4 literals', async () => {
		const blocked = [
			'https://127.0.0.1/hook',
			'https://10.1.2.3/hook',
			'https://172.16.0.9/hook',
			'https://192.168.1.10/hook',
			'https://169.254.169.254/latest/meta-data',
			'https://100.64.0.1/hook',
			'https://0.0.0.0/hook',
			'https://224.0.0.1/hook',
			'https://198.18.0.1/hook'
		];
		for (const url of blocked) {
			await expect(validateWebhookUrl(url)).rejects.toSatisfy(
				(error) => reasonOf(error) === 'blocked_host',
				url
			);
		}
		await expect(validateWebhookUrl('https://93.184.216.34/hook')).resolves.toBe(
			'https://93.184.216.34/hook'
		);
	});

	it('blocks IPv6 loopback, ULA, link-local, mapped IPv4 and documentation ranges', async () => {
		const blocked = [
			'https://[::1]/hook',
			'https://[fc00::1]/hook',
			'https://[fe80::1]/hook',
			'https://[fec0::1]/hook',
			'https://[::ffff:127.0.0.1]/hook',
			'https://[::ffff:10.0.0.1]/hook',
			'https://[::127.0.0.1]/hook',
			'https://[::10.0.0.1]/hook',
			'https://[2001::1]/hook',
			'https://[2001:db8::1]/hook',
			'https://[::]/hook'
		];
		for (const url of blocked) {
			await expect(validateWebhookUrl(url)).rejects.toSatisfy(
				(error) => reasonOf(error) === 'blocked_host',
				url
			);
		}
		await expect(validateWebhookUrl('https://[2606:4700:4700::1111]/hook')).resolves.toBe(
			'https://[2606:4700:4700::1111]/hook'
		);
	});

	it('blocks localhost and internal hostnames without a dns lookup', async () => {
		const lookup = vi.fn(async () => PUBLIC_V4);
		for (const host of [
			'localhost',
			'localhost.',
			'app.localhost',
			'printer.local',
			'meta.internal'
		]) {
			await expect(validateWebhookUrl(`https://${host}/hook`, { lookup })).rejects.toSatisfy(
				(error) => reasonOf(error) === 'blocked_host',
				host
			);
		}
		expect(lookup).not.toHaveBeenCalled();
	});

	it('fails closed when the hostname does not resolve', async () => {
		const lookup = vi.fn(async () => {
			throw new Error('ENOTFOUND');
		});
		await expect(validateWebhookUrl('https://nowhere.example/hook', { lookup })).rejects.toSatisfy(
			(error) => reasonOf(error) === 'unresolvable'
		);
		const empty = vi.fn(async () => []);
		await expect(
			validateWebhookUrl('https://empty.example/hook', { lookup: empty })
		).rejects.toSatisfy((error) => reasonOf(error) === 'unresolvable');
	});

	it('blocks a hostname when ANY resolved address is private (DNS rebinding shape)', async () => {
		const lookup = vi.fn(async () => ['93.184.216.34', '10.0.0.7']);
		await expect(validateWebhookUrl('https://rebind.example/hook', { lookup })).rejects.toSatisfy(
			(error) => reasonOf(error) === 'blocked_host'
		);
	});

	it('allows LAN targets only behind the explicit switch, never loopback/metadata', async () => {
		const lan = { allowPrivate: true, lookup: async () => ['192.168.1.20'] };
		await expect(validateWebhookUrl('https://nas.lan.example/hook', lan)).resolves.toBe(
			'https://nas.lan.example/hook'
		);
		await expect(validateWebhookUrl('https://10.0.0.5/hook', { allowPrivate: true })).resolves.toBe(
			'https://10.0.0.5/hook'
		);
		await expect(
			validateWebhookUrl('https://[fc00::5]/hook', { allowPrivate: true })
		).resolves.toBe('https://[fc00::5]/hook');
		await expect(
			validateWebhookUrl('https://nas/hook', {
				allowPrivate: true,
				lookup: async () => ['10.0.0.5']
			})
		).resolves.toBe('https://nas/hook');
		await expect(
			validateWebhookUrl('https://nas.local/hook', {
				allowPrivate: true,
				lookup: async () => ['192.168.1.20']
			})
		).resolves.toBe('https://nas.local/hook');
		for (const url of [
			'https://127.0.0.1/hook',
			'https://169.254.169.254/latest/meta-data',
			'https://[::1]/hook',
			'https://[fe80::1]/hook'
		]) {
			await expect(validateWebhookUrl(url, { allowPrivate: true })).rejects.toSatisfy(
				(error) => reasonOf(error) === 'blocked_host',
				url
			);
		}
	});

	it('reads the LAN switch as literal true only', () => {
		expect(
			webhookAllowPrivateTargets((name) =>
				name === 'WEBHOOK_ALLOW_PRIVATE_TARGETS' ? 'true' : undefined
			)
		).toBe(true);
		expect(
			webhookAllowPrivateTargets((name) =>
				name === 'WEBHOOK_ALLOW_PRIVATE_TARGETS' ? 'TRUE' : undefined
			)
		).toBe(false);
		expect(webhookAllowPrivateTargets(() => undefined)).toBe(false);
	});

	it('classifies bare addresses directly', () => {
		expect(isBlockedWebhookAddress('192.168.0.1')).toBe(true);
		expect(isBlockedWebhookAddress('192.168.0.1', { allowPrivate: true })).toBe(false);
		expect(isBlockedWebhookAddress('2606:4700:4700::1111')).toBe(false);
		expect(isBlockedWebhookHostname('example.com')).toBe(false);
		expect(isBlockedWebhookHostname('nas')).toBe(true);
	});

	it('keeps the insecure-loopback escape hatch test-only and narrow', async () => {
		await expect(
			validateWebhookUrl('http://127.0.0.1:4173/hook', { allowInsecureLoopback: true })
		).resolves.toBe('http://127.0.0.1:4173/hook');
		// Plain HTTP is still refused for anything that is not loopback.
		await expect(
			validateWebhookUrl('http://example.com/hook', { allowInsecureLoopback: true })
		).rejects.toSatisfy((error) => reasonOf(error) === 'insecure_scheme');
		await expect(
			validateWebhookUrl('http://169.254.169.254/latest', { allowInsecureLoopback: true })
		).rejects.toSatisfy((error) => reasonOf(error) === 'insecure_scheme');
		const envOf = (values: Record<string, string | undefined>) => (name: string) => values[name];
		expect(
			webhookGuardOptionsFromEnv(
				envOf({ WEBHOOK_ALLOW_INSECURE_LOOPBACK: 'true', NODE_ENV: 'production' })
			).allowInsecureLoopback
		).toBe(false);
		// Undefined NODE_ENV is NOT a test environment: fail closed.
		expect(
			webhookGuardOptionsFromEnv(envOf({ WEBHOOK_ALLOW_INSECURE_LOOPBACK: 'true' }))
				.allowInsecureLoopback
		).toBe(false);
		expect(
			webhookGuardOptionsFromEnv(
				envOf({ WEBHOOK_ALLOW_INSECURE_LOOPBACK: 'true', NODE_ENV: 'test' })
			).allowInsecureLoopback
		).toBe(true);
	});
});

describe('webhook url guard: delivery pre-flight', () => {
	it('refuses a stored private literal before any request', async () => {
		await expect(assertDeliveryTarget('https://127.0.0.1/hook')).rejects.toSatisfy(
			(error) => reasonOf(error) === 'blocked_host'
		);
		await expect(assertDeliveryTarget('http://example.com/hook')).rejects.toSatisfy(
			(error) => reasonOf(error) === 'insecure_scheme'
		);
	});

	it('lets a resolver outage fall through to fetch (retryable network error)', async () => {
		await expect(
			assertDeliveryTarget('https://example.com/hook', {
				lookup: async () => {
					throw new Error('EAI_AGAIN');
				}
			})
		).resolves.toBeUndefined();
	});

	it('refuses a hostname that now resolves private', async () => {
		await expect(
			assertDeliveryTarget('https://rebind.example/hook', {
				lookup: async () => ['10.0.0.7']
			})
		).rejects.toSatisfy((error) => reasonOf(error) === 'blocked_host');
	});
});
