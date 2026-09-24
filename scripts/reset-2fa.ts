// scripts/reset-2fa.ts
//
// 恢复兜底（台账 §4.24）：备份码与认证器都丢失时，关闭某账号的两步验证。
// 只动官方表的官方列 + 插件自有表，不做任何结构变更。
//
// 用法：
//   pnpm db:reset-2fa owner@example.com
//   （省略参数时回退到 .env 的 OWNER_EMAIL）
//
// 环境变量：DATABASE_URL（必填）、OWNER_EMAIL（可选回退）

import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { user } from '../src/lib/server/db/auth.schema';

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
		const secrets =
			await pg`select count(*)::int as count from "two_factor" where "user_id" = ${target.id}`;

		console.log(
			`→ ${email}: twoFactorEnabled=${target.twoFactorEnabled}, secrets=${secrets[0]?.count ?? 0}`
		);
		if (!target.twoFactorEnabled && (secrets[0]?.count ?? 0) === 0) {
			console.log('→ nothing to reset.');
			return;
		}

		await db.update(user).set({ twoFactorEnabled: false }).where(eq(user.id, target.id));
		await pg`delete from "two_factor" where "user_id" = ${target.id}`;

		const after =
			await pg`select count(*)::int as count from "two_factor" where "user_id" = ${target.id}`;
		console.log(
			`✓ two-step verification disabled for ${email} (twoFactorEnabled=false, secrets=${after[0]?.count ?? 0})`
		);
		console.log('  Log in with the password, then re-enable 2FA from /admin/settings/account.');
	} catch (error) {
		console.error('✗ Unexpected error:', error);
		process.exitCode = 1;
	} finally {
		await pg.end();
	}
}

main();
