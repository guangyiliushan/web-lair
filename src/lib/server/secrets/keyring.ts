import { SECRET_KEY_BYTES } from './crypto.ts';

/**
 * Master-key keyring (W2.2, decision T2-A).
 *
 *     SECRETS_KEYS="2:<base64 32B>,1:<base64 32B>"   # any order; ACTIVE decides
 *     SECRETS_KEY_ACTIVE="2"                          # must name a listed version
 *     SECRETS_KEY="<base64 32B>"                      # legacy single key -> version 1
 *
 * A `current + previous` pair is not enough: during a rolling deploy a new
 * replica writes the new version while an old replica cannot read it, and a
 * dump from two rotations ago references a version a two-slot scheme already
 * dropped. The keyring keeps every version that a retained backup or an
 * un-migrated row may still need, and `ACTIVE` decides which one new writes
 * use.
 *
 * Parsing is deliberately strict and never echoes key material in an error:
 * a typo must fail at configuration time, not silently create an unreadable
 * row or fall back to a different key.
 *
 * No `$lib`/`$env` imports - the job drain loads this under plain Node.
 */

export class KeyringConfigError extends Error {
	readonly reason: 'not_configured' | 'invalid';

	constructor(reason: 'not_configured' | 'invalid', message: string) {
		super(message);
		this.name = 'KeyringConfigError';
		this.reason = reason;
	}
}

export interface SecretKeyring {
	/** Version new writes use. */
	readonly activeVersion: number;
	/** Every version this deployment can read. */
	readonly versions: ReadonlyMap<number, Buffer>;
	/** Key bytes for a version, or null when the keyring does not hold it. */
	resolve(keyVersion: number): Buffer | null;
}

interface KeyringInput {
	keys?: string;
	active?: string;
	legacy?: string;
}

const VERSION_PATTERN = /^[1-9][0-9]{0,8}$/;

function parseVersion(raw: string, label: string): number {
	const value = raw.trim();
	if (!VERSION_PATTERN.test(value)) {
		throw new KeyringConfigError('invalid', `${label} must be a positive integer`);
	}
	return Number(value);
}

/** 32 raw bytes from base64 or hex; any other shape is a hard error. */
function decodeKey(raw: string, label: string): Buffer {
	const value = raw.trim();
	if (value.length === 0) {
		throw new KeyringConfigError('invalid', `${label} is empty`);
	}
	let key: Buffer;
	if (/^[0-9a-fA-F]{64}$/.test(value)) {
		key = Buffer.from(value, 'hex');
	} else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
		const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
		key = Buffer.from(normalized, 'base64');
		// Node's decoder ignores non-canonical trailing bits; require the exact
		// re-encoding so a typo cannot silently produce a different 32-byte key.
		if (key.toString('base64').replace(/=+$/, '') !== normalized.replace(/=+$/, '')) {
			throw new KeyringConfigError('invalid', `${label} is not canonical base64`);
		}
	} else {
		throw new KeyringConfigError('invalid', `${label} is neither base64 nor hex`);
	}
	if (key.length !== SECRET_KEY_BYTES) {
		throw new KeyringConfigError(
			'invalid',
			`${label} must decode to ${SECRET_KEY_BYTES} bytes (got ${key.length})`
		);
	}
	return key;
}

/** Build a keyring from raw env values. Throws `KeyringConfigError` on any defect. */
export function parseKeyring(input: KeyringInput): SecretKeyring {
	const keysRaw = input.keys?.trim() ?? '';
	const legacyRaw = input.legacy?.trim() ?? '';
	if (keysRaw === '' && legacyRaw === '') {
		throw new KeyringConfigError(
			'not_configured',
			'SECRETS_KEYS (or the legacy SECRETS_KEY) is not set'
		);
	}
	const versions = new Map<number, Buffer>();
	if (keysRaw !== '') {
		for (const [index, entry] of keysRaw.split(',').entries()) {
			const separator = entry.indexOf(':');
			if (separator <= 0) {
				throw new KeyringConfigError(
					'invalid',
					`SECRETS_KEYS entry ${index + 1} must look like "<version>:<key>"`
				);
			}
			const version = parseVersion(entry.slice(0, separator), `SECRETS_KEYS version #${index + 1}`);
			if (versions.has(version)) {
				throw new KeyringConfigError('invalid', `SECRETS_KEYS lists version ${version} twice`);
			}
			versions.set(version, decodeKey(entry.slice(separator + 1), `SECRETS_KEYS key ${version}`));
		}
		// `ACTIVE` is mandatory with a map: guessing "first entry" turns a
		// reordered list into a silent key change.
		const activeRaw = input.active?.trim() ?? '';
		if (activeRaw === '') {
			throw new KeyringConfigError(
				'invalid',
				'SECRETS_KEY_ACTIVE must be set when SECRETS_KEYS is used'
			);
		}
		const activeVersion = parseVersion(activeRaw, 'SECRETS_KEY_ACTIVE');
		if (!versions.has(activeVersion)) {
			throw new KeyringConfigError(
				'invalid',
				`SECRETS_KEY_ACTIVE=${activeVersion} is not present in SECRETS_KEYS`
			);
		}
		return makeKeyring(versions, activeVersion);
	}
	// Legacy single key: version 1, so rows written before the keyring existed
	// stay readable with their original ciphertext (`v1:1:...`).
	if ((input.active?.trim() ?? '') !== '' && input.active?.trim() !== '1') {
		throw new KeyringConfigError(
			'invalid',
			'SECRETS_KEY_ACTIVE cannot be used without SECRETS_KEYS; the legacy key is version 1'
		);
	}
	versions.set(1, decodeKey(legacyRaw, 'SECRETS_KEY'));
	return makeKeyring(versions, 1);
}

function makeKeyring(versions: Map<number, Buffer>, activeVersion: number): SecretKeyring {
	return {
		activeVersion,
		versions,
		resolve(keyVersion: number): Buffer | null {
			return versions.get(keyVersion) ?? null;
		}
	};
}

/** Read the keyring from an env lookup (`$env` in the app, `process.env` in jobs). */
export function keyringFromEnv(getEnv: (name: string) => string | undefined): SecretKeyring {
	return parseKeyring({
		keys: getEnv('SECRETS_KEYS'),
		active: getEnv('SECRETS_KEY_ACTIVE'),
		legacy: getEnv('SECRETS_KEY')
	});
}
