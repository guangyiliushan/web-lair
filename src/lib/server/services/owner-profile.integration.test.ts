import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '$lib/server/db/schema';
import { auditChanges, listSettingsActivity } from '$lib/server/settings/activity';
import { OwnerProfileError, saveHomeHero, saveOwnerProfile } from './owner-profile';

/**
 * Owner pointer + audit contract on a real scratch database. Skipped
 * unless OWNER_PROFILE_SCRATCH_URL points at a migrated scratch database:
 *
 *   OWNER_PROFILE_SCRATCH_URL=... pnpm exec vitest run --project server \
 *     src/lib/server/services/owner-profile.integration.test.ts
 *
 * Covers the write half the unit tests cannot: the 409 pointer guard, the
 * profile/home writes, the audit rows (no refs, deliver:false -> zero webhook
 * deliveries) and the owner-only boundary.
 */
const url = process.env.OWNER_PROFILE_SCRATCH_URL;
const OWNER = '30000000-0000-4000-8000-000000000001';
const ADMIN = '30000000-0000-4000-8000-000000000002';
const EMAIL = 'owner-profile-integration@example.com';

describe.skipIf(!url)('owner profile service on a scratch database', () => {
	let sql: ReturnType<typeof postgres>;
	let db: ReturnType<typeof drizzle<typeof schema>>;

	async function cleanup() {
		await sql`delete from activities where actor_id in (${OWNER}, ${ADMIN})`;
		await sql`delete from site_identity`;
		await sql`delete from home_hero`;
		await sql`delete from user_profiles where user_id in (${OWNER}, ${ADMIN})`;
		await sql`delete from "user" where id in (${OWNER}, ${ADMIN})`;
	}

	async function seed() {
		await sql`insert into "user" (id, name, email, email_verified, role)
			values (${OWNER}, 'Owner', ${EMAIL}, true, 'owner')`;
		await sql`insert into "user" (id, name, email, email_verified, role)
			values (${ADMIN}, 'Admin', ${'admin-' + EMAIL}, true, 'admin')`;
		await sql`insert into user_profiles (user_id, display_name, slug, header_label)
			values (${OWNER}, 'Owner', 'owner-profile-integration', 'shan')`;
		await sql`insert into site_identity (id, owner_user_id) values (1, ${OWNER})`;
	}

	beforeAll(async () => {
		sql = postgres(url!, { max: 1 });
		db = drizzle(sql, { schema });
		await cleanup();
		await seed();
	});

	afterAll(async () => {
		await cleanup();
		await sql.end();
	});

	it('saves the profile as the pointer owner and writes a ref-less audit row', async () => {
		const saved = await saveOwnerProfile(
			{
				displayName: ' guangyiliushan ',
				headerLabel: 'guang',
				avatarUrl: 'https://example.com/avatar.png',
				links: [{ platform: 'github', href: 'https://github.com/example' }]
			},
			{ actorId: OWNER, executor: db }
		);
		expect(saved).toMatchObject({
			displayName: 'guangyiliushan',
			headerLabel: 'guang',
			avatarUrl: 'https://example.com/avatar.png'
		});
		const [row] =
			await sql`select display_name, header_label, avatar_url, links from user_profiles where user_id = ${OWNER}`;
		expect(row).toMatchObject({
			display_name: 'guangyiliushan',
			header_label: 'guang',
			avatar_url: 'https://example.com/avatar.png'
		});
		const [activity] =
			await sql`select event, actor_id, ref_type, ref_id, payload from activities where event = 'profile.update' and actor_id = ${OWNER}`;
		expect(activity).toMatchObject({ event: 'profile.update', actor_id: OWNER });
		expect(activity.ref_type).toBeNull();
		expect(activity.ref_id).toBeNull();
		expect(activity.payload.fields).toContain('header_label');
		const [{ count }] =
			await sql`select count(*)::int as count from webhook_deliveries where event = 'profile.update'`;
		expect(count).toBe(0);
	});

	it('accepts a 6-grapheme emoji header label (DB bound is codepoints)', async () => {
		const label = '👨‍👩‍👧‍👦'.repeat(6);
		expect([...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(label)]).toHaveLength(
			6
		);
		const saved = await saveOwnerProfile(
			{ displayName: 'guangyiliushan', headerLabel: label },
			{ actorId: OWNER, executor: db }
		);
		expect(saved.headerLabel).toBe(label);
	});

	it('rejects a non-owner actor with a 409 pointer mismatch and leaves the row alone', async () => {
		const failure = await saveOwnerProfile(
			{ displayName: 'Hijacked' },
			{ actorId: ADMIN, executor: db }
		).catch((caught) => caught);
		expect(failure).toBeInstanceOf(OwnerProfileError);
		expect(failure.status).toBe(409);
		expect(failure.code).toBe('owner_pointer_mismatch');
		const [row] = await sql`select display_name from user_profiles where user_id = ${OWNER}`;
		expect(row.display_name).toBe('guangyiliushan');
	});

	it('rejects a missing pointer with 409 owner_pointer_missing', async () => {
		await sql`delete from site_identity`;
		const failure = await saveOwnerProfile(
			{ displayName: 'Nobody' },
			{ actorId: OWNER, executor: db }
		).catch((caught) => caught);
		expect(failure).toBeInstanceOf(OwnerProfileError);
		expect(failure.status).toBe(409);
		expect(failure.code).toBe('owner_pointer_missing');
		await sql`insert into site_identity (id, owner_user_id) values (1, ${OWNER})`;
	});

	it('saves localized home hero copy and audits home.update', async () => {
		const saved = await saveHomeHero(
			{
				title: { en: ' Hi, I am {name} ', 'zh-cn': '你好，我是 {name}', ja: '' },
				description: { en: 'A personal lair.' }
			},
			{ actorId: OWNER, executor: db }
		);
		expect(saved.title).toEqual({ en: 'Hi, I am {name}', 'zh-cn': '你好，我是 {name}' });
		expect(saved.description).toEqual({ en: 'A personal lair.' });
		const [row] = await sql`select title, description, updated_by from home_hero where id = 1`;
		expect(row).toMatchObject({ updated_by: OWNER });
		expect(row.title).toEqual({ en: 'Hi, I am {name}', 'zh-cn': '你好，我是 {name}' });
		const [activity] =
			await sql`select event, ref_type, ref_id, payload from activities where event = 'home.update' and actor_id = ${OWNER}`;
		expect(activity.event).toBe('home.update');
		expect(activity.ref_type).toBeNull();
		expect(activity.ref_id).toBeNull();
		expect(activity.payload.fields).toContain('subtitle_highlight');
		const [{ count: homeDeliveries }] =
			await sql`select count(*)::int as count from webhook_deliveries where event = 'home.update'`;
		expect(homeDeliveries).toBe(0);
		// Empty strings remove the override; an empty map falls back to messages.
		const cleared = await saveHomeHero({ title: { en: '' } }, { actorId: OWNER, executor: db });
		expect(cleared.title).toEqual({});
	});

	it('lists the settings events for the change-history surface', async () => {
		const rows = await listSettingsActivity({ family: 'profile', executor: db });
		const profileRow = rows.find((row) => row.event === 'profile.update');
		expect(profileRow).toBeDefined();
		expect(profileRow?.actorName).toBe('Owner');
		expect(profileRow?.payload).not.toHaveProperty('secret');
		const changes = auditChanges(profileRow?.payload ?? null);
		expect(changes.map((change) => change.field)).toContain('header_label');
		const all = await listSettingsActivity({ family: 'unknown-family', executor: db });
		expect(all.some((row) => row.event === 'home.update')).toBe(true);
	});
});
