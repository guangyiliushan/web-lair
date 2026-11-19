// scripts/seed-owner.ts
// Usage: `pnpm dev` first (the seed signs up through the running server),
// then `pnpm ops site seed-owner`.
// Env: OWNER_EMAIL (required), OWNER_PASSWORD (min 8 chars), OWNER_NAME
// (default "Admin"), ORIGIN (default http://localhost:5173), DATABASE_URL.
//
// The role comes from better-auth's admin plugin; owner uniqueness is
// guaranteed by the application layer (the conditional update in step 5), so
// the script is idempotent: running it again never creates a second owner.

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import { user } from '../src/lib/server/db/auth.schema';
import { noOtherOwner, ownerClaimLock } from '../src/lib/server/auth/owner-claim';

const FETCH_TIMEOUT_MS = 10_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Read a required environment variable, failing loudly when it is missing.
 * The return type is always string (never undefined) because process.exit returns never.
 */
function requireEnv(name: string, value: string | undefined): string {
	if (!value?.trim()) {
		console.error(`✗ ${name} is required.`);
		process.exit(1);
	}
	return value;
}

// ── Parse the environment ──
const ORIGIN = process.env.ORIGIN || 'http://localhost:5173';
const NAME = process.env.OWNER_NAME || 'Admin';
const EMAIL = (process.env.OWNER_EMAIL ?? '').trim().toLowerCase();
const PASSWORD = requireEnv('OWNER_PASSWORD', process.env.OWNER_PASSWORD);
const DB_URL = requireEnv('DATABASE_URL', process.env.DATABASE_URL);

// ── Validation ──
if (!EMAIL) {
	console.error('✗ OWNER_EMAIL is required.');
	process.exit(1);
}
if (!EMAIL_RE.test(EMAIL)) {
	console.error(`✗ Invalid email format: ${EMAIL}`);
	process.exit(1);
}
if (PASSWORD.length < 8) {
	console.error('✗ OWNER_PASSWORD must be at least 8 characters.');
	process.exit(1);
}

// ── Helper: fetch with a timeout ──
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

async function main() {
	const pg = postgres(DB_URL);
	const db = drizzle(pg);

	try {
		// ── Step 1: check whether the user already exists (the core of idempotency) ──
		const [existing] = await db
			.select({ id: user.id, emailVerified: user.emailVerified })
			.from(user)
			.where(eq(user.email, EMAIL))
			.limit(1);

		if (existing) {
			console.log(`→ User already exists: ${EMAIL}`);
		} else {
			// ── Step 2: no such user, call the Better Auth sign-up API ──
			console.log(`→ Creating user via Better Auth API: ${EMAIL} ...`);
			const signUpRes = await fetchWithTimeout(`${ORIGIN}/api/auth/sign-up/email`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Origin: ORIGIN
				},
				body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: NAME })
			});

			if (!signUpRes.ok) {
				const err = await signUpRes.json().catch(() => ({}));
				console.error('✗ Sign-up failed:', signUpRes.status, err);
				console.error('  Make sure dev server is running (pnpm dev).');
				process.exit(1);
			}

			console.log('✓ User created.');

			// Wait for databaseHooks (user.create.after → userProfiles) to finish
			await new Promise((r) => setTimeout(r, 500));
		}

		// ── Step 3: read the user id (it may have just been created, so re-query) ──
		const [u] = await db
			.select({ id: user.id, emailVerified: user.emailVerified })
			.from(user)
			.where(eq(user.email, EMAIL))
			.limit(1);

		if (!u) {
			console.error('✗ User not found in DB after sign-up. Check database connection.');
			process.exit(1);
		}

		// ── Step 4: set emailVerified = true (idempotent) ──
		if (!u.emailVerified) {
			await db.update(user).set({ emailVerified: true }).where(eq(user.email, EMAIL));
			console.log('✓ emailVerified set to true.');
		} else {
			console.log('→ emailVerified already true, skipping.');
		}

		// ── Step 5: claim the owner role (advisory lock + conditional update, idempotent) ──
		// Lock and predicate come from src/lib/server/auth/owner-claim.ts — the same source
		// as the app-side claimOwnerRole.
		const claimed = await db.transaction(async (tx) => {
			await tx.execute(ownerClaimLock());
			const rows = await tx
				.update(user)
				.set({ role: 'owner', emailVerified: true })
				.where(and(eq(user.id, u.id), noOtherOwner(u.id)))
				.returning({ id: user.id });
			return rows.length > 0;
		});

		if (claimed) {
			console.log('✓ role = owner');
		} else {
			console.error(
				'✗ another account is already the site owner — this account was NOT granted owner.'
			);
			process.exitCode = 1;
		}

		console.log('\n✔ Done! Owner account is ready.');
		console.log(`  Email: ${EMAIL}`);
		console.log('  You can now log in at the admin login page.');
	} catch (err) {
		console.error('✗ Unexpected error:', err);
		process.exitCode = 1;
	} finally {
		await pg.end();
	}
}

main();
