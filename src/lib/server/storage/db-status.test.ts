import { describe, expect, it } from 'vitest';
import { maskDatabaseHost, parseDatabaseUrl, readDatabaseStatus, readJournal } from './db-status';

/**
 * Read-only database status (W7.7/Q17): the page must never print a password,
 * never print a full external host, and never claim "up to date" without
 * comparing the ledger with the journal.
 */
describe('database url parsing', () => {
	it('classifies loopback as local and keeps the password out of the shape', () => {
		const parsed = parseDatabaseUrl('postgres://root:sup3r-secret@localhost:5432/local');
		expect(parsed).toEqual({
			host: 'localhost',
			port: '5432',
			database: 'local',
			sslMode: null,
			mode: 'local'
		});
		expect(JSON.stringify(parsed)).not.toContain('sup3r-secret');
	});

	it('classifies a remote host as external and reads sslmode', () => {
		expect(
			parseDatabaseUrl('postgres://app:pw@db-prod.internal.example.com:6432/lair?sslmode=require')
		).toMatchObject({
			host: 'db-prod.internal.example.com',
			port: '6432',
			database: 'lair',
			sslMode: 'require',
			mode: 'external'
		});
	});

	it('rejects a non-postgres or unparsable URL', () => {
		expect(parseDatabaseUrl('mysql://x/y')).toBeNull();
		expect(parseDatabaseUrl('not a url')).toBeNull();
		expect(parseDatabaseUrl('')).toBeNull();
		expect(parseDatabaseUrl(null)).toBeNull();
	});
});

describe('host masking', () => {
	it('keeps loopback readable', () => {
		expect(maskDatabaseHost('localhost')).toBe('localhost');
		expect(maskDatabaseHost('127.0.0.1')).toBe('127.0.0.1');
		expect(maskDatabaseHost('[::1]')).toBe('::1');
	});

	it('masks a hostname to its first label', () => {
		expect(maskDatabaseHost('db-prod.internal.example.com')).toBe('db-prod.…');
	});

	it('masks an IPv4 to two octets and an IPv6 to one group', () => {
		expect(maskDatabaseHost('10.20.30.40')).toBe('10.20.…');
		expect(maskDatabaseHost('2001:db8::1')).toBe('2001:…');
	});
});

describe('readDatabaseStatus', () => {
	const journal = { entries: [{ when: 1000 }, { when: 3000 }] };

	it('reports applied migrations and up-to-date from the newest timestamp', async () => {
		const status = await readDatabaseStatus({
			url: 'postgres://app:pw@db.example.com:5432/lair',
			journal,
			readLedger: async () => ({ applied: 7, latestMs: 3000 })
		});

		expect(status).toMatchObject({
			mode: 'external',
			host: 'db.…',
			port: '5432',
			database: 'lair',
			migrations: { applied: 7, upToDate: true, expected: 2 }
		});
		expect(status?.migrations.latestAt).toBe(new Date(3000).toISOString());
	});

	it('flags a pending migration when the ledger is behind the journal', async () => {
		const status = await readDatabaseStatus({
			url: 'postgres://app:pw@localhost:5432/lair',
			journal,
			readLedger: async () => ({ applied: 1, latestMs: 1000 })
		});
		expect(status?.migrations).toMatchObject({ upToDate: false });
	});

	it('degrades instead of throwing when the ledger cannot be read', async () => {
		const status = await readDatabaseStatus({
			url: 'postgres://app:pw@localhost:5432/lair',
			journal,
			readLedger: async () => {
				throw new Error('relation drizzle.__drizzle_migrations does not exist');
			}
		});
		expect(status?.migrations).toEqual({
			applied: 0,
			latestAt: null,
			upToDate: null,
			expected: 2
		});
	});

	it('returns null without a database url', async () => {
		await expect(
			readDatabaseStatus({
				url: null,
				journal,
				readLedger: async () => ({ applied: 0, latestMs: null })
			})
		).resolves.toBeNull();
	});

	it('copes with a missing journal (built image without drizzle/)', async () => {
		const status = await readDatabaseStatus({
			url: 'postgres://app:pw@localhost:5432/lair',
			journal: null,
			readLedger: async () => ({ applied: 3, latestMs: 5 })
		});
		expect(status?.migrations).toMatchObject({ applied: 3, upToDate: null, expected: null });
	});

	it('reads the real journal from the checkout', () => {
		const journal = readJournal();
		expect(journal).not.toBeNull();
		expect(journal!.entries.length).toBeGreaterThanOrEqual(6);
	});

	it('returns null for a missing journal file', () => {
		expect(readJournal('/nonexistent/_journal.json')).toBeNull();
	});
});
