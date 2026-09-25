// scripts/reset-2fa.ts
//
// Emergency recovery (ledger §4.24 / §4.35): when both the authenticator and
// the backup codes are lost, disable two-step verification for one account and
// clear every trace of the factor:
//   - flip `user.two_factor_enabled` to false and delete the `two_factor` row
//   - revoke ALL sessions of the account (a stolen cookie must not survive a reset)
//   - drop the pending `2fa-*` / `trust-device-*` verification rows
// All writes run in one transaction; the state is read back before reporting.
//
// Usage:
//   pnpm db:reset-2fa owner@example.com
//   (omitting the argument falls back to .env OWNER_EMAIL)
//
// Env: DATABASE_URL (required), OWNER_EMAIL (optional fallback)

import postgres from 'postgres';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { session, twoFactor, user } from '../src/lib/server/db/auth.schema';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
	console.error('✗ DATABASE_URL is required.');
	process.exit(1);
}

const email = (process.argv[2] ?? process.env.OWNER_EMAIL ?? '').trim().toLowerCase();
if (!email) {
	console.error('✗ Usage: pnpm db:reset-2fa <email>  (or set OWNER_EMAIL)');
	process.exit(1);
}

async function main() {
	const pg = postgres(DB_URL);
	const db = drizzle(pg);

	try {
		const rows = await db
			.select({ id: user.id, twoFactorEnabled: user.twoFactorEnabled })
			.from(user)
			.where(eq(user.email, email))
			.limit(1);

		if (rows.length === 0) {
			console.error(`✗ No account found for ${email}`);
			process.exitCode = 1;
			return;
		}

		const target = rows[0];
		const secretCount = await db.$count(twoFactor, eq(twoFactor.userId, target.id));
		const sessionCount = await db.$count(session, eq(session.userId, target.id));

		console.log(
			`→ ${email} (user ${target.id}): twoFactorEnabled=${target.twoFactorEnabled}, secrets=${secretCount}, sessions=${sessionCount}`
		);
		if (!target.twoFactorEnabled && secretCount === 0) {
			console.log('→ nothing to reset.');
			return;
		}

		await db.transaction(async (tx) => {
			await tx.update(user).set({ twoFactorEnabled: false }).where(eq(user.id, target.id));
			await tx.delete(twoFactor).where(eq(twoFactor.userId, target.id));
			// A stolen session must not outlive the reset.
			await tx.delete(session).where(eq(session.userId, target.id));
			// Challenge and trust-device rows are keyed by random identifiers, not
			// by user, so they cannot be narrowed to this account; the two patterns
			// only touch this plugin's rows, and every matched row expires on its
			// own anyway.
			await tx.execute(
				sql`delete from "verification" where "identifier" like '2fa-%' or "identifier" like 'trust-device-%'`
			);
		});

		const after = await db
			.select({ twoFactorEnabled: user.twoFactorEnabled })
			.from(user)
			.where(eq(user.id, target.id))
			.limit(1);
		const secretsAfter = await db.$count(twoFactor, eq(twoFactor.userId, target.id));
		const sessionsAfter = await db.$count(session, eq(session.userId, target.id));

		console.log(
			`✓ Reset at ${new Date().toISOString()}: user=${target.id} twoFactorEnabled=${after[0]?.twoFactorEnabled}, secrets=${secretsAfter}, sessions=${sessionsAfter}`
		);
		console.log(
			'  All sessions were revoked. Sign in with the password, then re-enable 2FA from /admin/settings/account.'
		);
	} catch (error) {
		console.error('✗ Unexpected error:', error);
		process.exitCode = 1;
	} finally {
		await pg.end();
	}
}

main();
