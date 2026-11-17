import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Static proof of the backup split.
 *
 * The runbook and the shell script drift apart silently: a `-v $APP_DIR/.env`
 * added to the data run would put the master keyring in the same repository as
 * the ciphertext, and every test would still pass. This pins the two runs to
 * their repositories and forbids `.env` from the data source set.
 */
const SCRIPT = readFileSync(
	fileURLToPath(new URL('../../../../deploy/backup/backup.sh', import.meta.url)),
	'utf8'
);

/** The docker invocation that backs up the data repository. */
function dataRun(): string {
	const start = SCRIPT.indexOf('docker run --rm --env-file');
	const end = SCRIPT.indexOf('# 4) Config');
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	return SCRIPT.slice(start, end);
}

describe('backup repository split', () => {
	it('the data run mounts the dump dir, DATA_DIR and RustFS - never .env', () => {
		const run = dataRun();
		expect(run).toContain('-v "$BACKUP_DIR":/backup:ro');
		expect(run).toContain('-v "$DATA_DIR":/data:ro');
		expect(run).toContain('-v "$RUSTFS_VOLUME":/rustfs:ro');
		// Only the mount lines: a prose comment may mention `.env` while
		// explaining why it is absent.
		const mounts = run
			.split('\n')
			.filter((line) => /^\s*-v\s/.test(line))
			.join('\n');
		expect(mounts).not.toContain('.env');
		expect(run).toContain('--repo "$RESTIC_REPOSITORY"');
		expect(run).toContain('backup --host web-lair /backup /data /rustfs');
	});

	it('the config run uses its own repository and its own password', () => {
		const config = SCRIPT.slice(SCRIPT.indexOf('# 4) Config'));
		expect(config).toContain('-v "$APP_DIR/.env":/config/.env:ro');
		expect(config).toContain('--repo "$RESTIC_CONFIG_REPOSITORY"');
		expect(config).toContain('export RESTIC_PASSWORD="$RESTIC_CONFIG_PASSWORD"');
		// The repository is a flag (cannot be shadowed by backup.env), not an
		// environment variable.
		expect(config).not.toContain('RESTIC_REPOSITORY="$RESTIC_CONFIG_REPOSITORY"');
	});

	it('requires both repository passwords before doing any work', () => {
		expect(SCRIPT).toContain(': "${RESTIC_REPOSITORY:?');
		expect(SCRIPT).toContain(': "${RESTIC_PASSWORD:?');
		expect(SCRIPT).toContain(': "${RESTIC_CONFIG_REPOSITORY:?');
		expect(SCRIPT).toContain(': "${RESTIC_CONFIG_PASSWORD:?');
	});
});
