// scripts/seed-owner.ts
// 用法:
//   1. pnpm dev （启动 dev server）
//   2. pnpm db:seed-owner
//
// 环境变量:
//   OWNER_EMAIL     — 站长（site owner）邮箱，必填
//   OWNER_PASSWORD  — 密码（最少 8 位）
//   OWNER_NAME      — 显示名称（默认 "Admin"）
//   ORIGIN          — SvelteKit server 地址（默认 http://localhost:5173）
//   DATABASE_URL    — PostgreSQL 连接串
//
// 角色来自 better-auth 的 admin 插件；owner 唯一性由应用层保证（Step 5 的条件更新），
// 因此脚本幂等：重复执行不会产生第二个 owner。

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import { user } from '../src/lib/server/db/auth.schema';
import { noOtherOwner, ownerClaimLock } from '../src/lib/server/auth/owner-claim';

const FETCH_TIMEOUT_MS = 10_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 读取必填环境变量，缺失时报错并退出。
 * 返回值始终为 string（非 undefined），因为 process.exit 返回 never。
 */
function requireEnv(name: string, value: string | undefined): string {
	if (!value?.trim()) {
		console.error(`✗ ${name} is required.`);
		process.exit(1);
	}
	return value;
}

// ── 解析环境变量 ──
const ORIGIN = process.env.ORIGIN || 'http://localhost:5173';
const NAME = process.env.OWNER_NAME || 'Admin';
const EMAIL = (process.env.OWNER_EMAIL ?? '').trim().toLowerCase();
const PASSWORD = requireEnv('OWNER_PASSWORD', process.env.OWNER_PASSWORD);
const DB_URL = requireEnv('DATABASE_URL', process.env.DATABASE_URL);

// ── 校验 ──
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

// ── 辅助：带超时的 fetch ──
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
		// ── Step 1: 检查用户是否已存在（幂等性核心）──
		const [existing] = await db
			.select({ id: user.id, emailVerified: user.emailVerified })
			.from(user)
			.where(eq(user.email, EMAIL))
			.limit(1);

		if (existing) {
			console.log(`→ User already exists: ${EMAIL}`);
		} else {
			// ── Step 2: 用户不存在，调用 Better Auth 注册 API ──
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

			// 等待 databaseHooks (user.create.after → userProfiles) 完成
			await new Promise((r) => setTimeout(r, 500));
		}

		// ── Step 3: 获取用户 ID（可能刚注册，重新查询）──
		const [u] = await db
			.select({ id: user.id, emailVerified: user.emailVerified })
			.from(user)
			.where(eq(user.email, EMAIL))
			.limit(1);

		if (!u) {
			console.error('✗ User not found in DB after sign-up. Check database connection.');
			process.exit(1);
		}

		// ── Step 4: 设置 emailVerified = true（幂等）──
		if (!u.emailVerified) {
			await db.update(user).set({ emailVerified: true }).where(eq(user.email, EMAIL));
			console.log('✓ emailVerified set to true.');
		} else {
			console.log('→ emailVerified already true, skipping.');
		}

		// ── Step 5: 认领 owner 角色（咨询锁 + 条件更新，幂等）──
		// 锁与谓词来自 src/lib/server/auth/owner-claim.ts，与 app 侧 claimOwnerRole 同源。
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
