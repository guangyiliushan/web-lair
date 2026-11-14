import { readFileSync } from 'node:fs';

/**
 * Database status for the Storage page (W7.7, decision Q17).
 *
 * The page is READ-ONLY here on purpose: an external database is an
 * install/deploy decision (`DATABASE_URL` + `pg_dump`/`pg_restore`), not a
 * settings form. What an operator needs from this page is the three facts that
 * make a quiet misconfiguration visible:
 *
 *   mode      - is the app talking to the bundled Postgres or an external one?
 *   host      - WHICH host, masked (the page is admin-only but a host name is
 *               still infrastructure detail; the password never appears);
 *   migrations- how many ledger rows are applied and whether the newest
 *               migration in `drizzle/` is among them.
 *
 * Nothing here writes, and nothing here runs a migration.
 */

export interface ParsedDatabaseUrl {
	host: string;
	port: string | null;
	database: string;
	/** `sslmode` as written; null = driver default. */
	sslMode: string | null;
	mode: 'local' | 'external';
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/**
 * Masks a host for display. Loopback names are not sensitive (they say "same
 * box"); a real hostname keeps its first label only, and an IP keeps its first
 * two octets — enough to tell environments apart, not enough to be a map.
 */
export function maskDatabaseHost(host: string): string {
	const clean = host.replace(/^\[|\]$/g, '');
	if (LOCAL_HOSTS.has(clean.toLowerCase())) return clean;
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(clean)) {
		const parts = clean.split('.');
		return `${parts[0]}.${parts[1]}.…`;
	}
	if (clean.includes(':')) {
		// IPv6: keep the first group only.
		const [first] = clean.split(':');
		return `${first}:…`;
	}
	const label = clean.split('.')[0] ?? clean;
	return `${label.length > 16 ? `${label.slice(0, 16)}…` : label}.…`;
}

/** Parses DATABASE_URL without ever touching the password field. */
export function parseDatabaseUrl(raw: string | null | undefined): ParsedDatabaseUrl | null {
	if (!raw?.trim()) return null;
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		return null;
	}
	if (!url.protocol.startsWith('postgres')) return null;
	const host = url.hostname || 'localhost';
	const database = decodeURIComponent(url.pathname.replace(/^\//, '')) || '';
	return {
		host,
		port: url.port || null,
		database,
		sslMode: url.searchParams.get('sslmode'),
		mode: LOCAL_HOSTS.has(host.toLowerCase()) ? 'local' : 'external'
	};
}

export interface MigrationLedgerRow {
	applied: number;
	latestMs: number | null;
}

export interface DatabaseStatus {
	mode: 'local' | 'external';
	/** Masked host; loopback names stay readable. */
	host: string;
	port: string | null;
	database: string;
	sslMode: string | null;
	migrations: {
		applied: number;
		latestAt: string | null;
		/** null when the journal could not be read (built image without it). */
		upToDate: boolean | null;
		expected: number | null;
	};
}

export interface DatabaseStatusOptions {
	url: string | null | undefined;
	readLedger: () => Promise<MigrationLedgerRow>;
	/** Journal entries (callers pass `readJournal()` or a test fixture). */
	journal: { entries: { when: number }[] } | null;
}

/**
 * Reads the ledger and merges it with the journal. Never throws: a ledger read
 * failure shows `applied: 0` with `upToDate: null` instead of taking the page
 * down (the page's own queries already proved the DB is up).
 */
export async function readDatabaseStatus(
	options: DatabaseStatusOptions
): Promise<DatabaseStatus | null> {
	const parsed = parseDatabaseUrl(options.url);
	if (!parsed) return null;

	const expected = options.journal?.entries.length ?? null;
	const journalNewest =
		options.journal && options.journal.entries.length > 0
			? Math.max(...options.journal.entries.map((entry) => entry.when))
			: null;

	let ledger: MigrationLedgerRow;
	try {
		ledger = await options.readLedger();
	} catch {
		return {
			mode: parsed.mode,
			host: maskDatabaseHost(parsed.host),
			port: parsed.port,
			database: parsed.database,
			sslMode: parsed.sslMode,
			migrations: { applied: 0, latestAt: null, upToDate: null, expected }
		};
	}

	return {
		mode: parsed.mode,
		host: maskDatabaseHost(parsed.host),
		port: parsed.port,
		database: parsed.database,
		sslMode: parsed.sslMode,
		migrations: {
			applied: ledger.applied,
			latestAt: ledger.latestMs === null ? null : new Date(ledger.latestMs).toISOString(),
			// Comparing the newest applied timestamp with the newest journal
			// entry: a regenerated baseline leaves extra ledger rows, so the
			// COUNT is not a reliable comparison (7 rows vs 6 entries today).
			upToDate:
				journalNewest === null || ledger.latestMs === null
					? null
					: ledger.latestMs >= journalNewest,
			expected
		}
	};
}

/**
 * Reads `drizzle/meta/_journal.json` from the working directory. The deploy
 * image ships the folder (`scripts/migrate.ts` needs it); a dev/test run that
 * cannot see it degrades to `null` rather than failing the page.
 */
export function readJournal(
	path = `${process.cwd()}/drizzle/meta/_journal.json`
): { entries: { when: number }[] } | null {
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as { entries?: { when: number }[] };
		return Array.isArray(parsed.entries) ? { entries: parsed.entries } : null;
	} catch {
		return null;
	}
}
