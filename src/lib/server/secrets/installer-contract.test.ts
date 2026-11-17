import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Installer contract.
 *
 * The JSON inventory is the documented contract and the bash script is the
 * shipped implementation. They must agree on names and generators, or an
 * operator following the contract gets a half-configured `.env`.
 */
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const inventory = JSON.parse(readFileSync(`${root}deploy/secret-inventory.json`, 'utf8')) as {
	version: number;
	targets: Record<string, { path: string; mode: string }>;
	secrets: Array<{
		name: string;
		generate: string;
		required: boolean;
		write: string;
		backupWith: string;
	}>;
};
const script = readFileSync(`${root}deploy/bootstrap-secrets.sh`, 'utf8');

describe('secret-inventory.json', () => {
	it('targets only env files with mode 600', () => {
		expect(inventory.targets.env).toMatchObject({ path: '.env', mode: '600' });
		expect(inventory.targets.backup).toMatchObject({ path: 'deploy/backup.env', mode: '600' });
	});

	it('covers the bootstrap secrets the runbook requires', () => {
		const names = inventory.secrets.map((secret) => secret.name);
		for (const required of [
			'POSTGRES_PASSWORD',
			'BETTER_AUTH_SECRET',
			'SECRETS_KEYS',
			'SECRETS_KEY_ACTIVE',
			'ADMIN_SETUP_TOKEN',
			'SUBSCRIBE_HMAC_KEY',
			'SUBSCRIBE_TOKEN_SECRET',
			'SUPPRESSION_HMAC_KEY',
			'MAIL_EVENTS_HMAC_KEY',
			'RESTIC_PASSWORD',
			'RESTIC_CONFIG_PASSWORD'
		]) {
			expect(names).toContain(required);
		}
		expect(new Set(names).size).toBe(names.length);
	});

	it('marks the master keyring and repository passwords as offline copies', () => {
		for (const name of ['SECRETS_KEYS', 'RESTIC_PASSWORD', 'RESTIC_CONFIG_PASSWORD']) {
			expect(inventory.secrets.find((secret) => secret.name === name)?.backupWith).toBe('offline');
		}
		// Two repository passwords must be distinct values, never one shared.
		expect(inventory.secrets.find((s) => s.name === 'RESTIC_PASSWORD')?.generate).toBe('base64-32');
		expect(inventory.secrets.find((s) => s.name === 'RESTIC_CONFIG_PASSWORD')?.generate).toBe(
			'base64-32'
		);
	});
});

describe('bootstrap-secrets.sh contract', () => {
	it('binds every inventory secret to its declared generator and target', () => {
		const rows = [...script.matchAll(/"([A-Z0-9_]+)\|([a-z0-9-]+)\|(env|backup)"/g)].map(
			(match) => ({ name: match[1], generate: match[2], target: match[3] })
		);
		for (const secret of inventory.secrets) {
			const expectedTarget = secret.write === 'deploy/backup.env' ? 'backup' : 'env';
			expect(rows).toContainEqual({
				name: secret.name,
				generate: secret.generate,
				target: expectedTarget
			});
		}
		expect(rows).toHaveLength(inventory.secrets.length);
	});

	it('writes env only and never runs a database command', () => {
		expect(script).not.toContain('psql');
		expect(script).not.toContain('DATABASE_URL');
		expect(script).not.toContain('insert into');
	});

	it('keeps the safety properties: no trace, atomic write, one-time token note', () => {
		// A comment may mention `set -x`; an executed statement must not exist.
		expect(script).not.toMatch(/^\s*set\s+-x/m);
		expect(script).toContain('mktemp');
		expect(script).toContain('mv ');
		expect(script).toContain('ADMIN_SETUP_TOKEN');
		expect(script).toContain('--dry-run');
		expect(script).toContain('--rotate');
		// The master keyring has no casual rotate path.
		expect(script).toContain('refusing to rotate');
	});

	it('never prints a value: the receipt records names and fingerprints only', () => {
		expect(script).toContain('sha256Prefix');
		expect(script).not.toMatch(/echo\s+"?\$(value|secret)/);
		expect(script).not.toContain('echo "$value"');
	});
});
