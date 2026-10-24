import { error, fail } from '@sveltejs/kit';
import { eq, max } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { requireAdminRole } from '$lib/server/authz';
import { session, user } from '$lib/server/db/auth.schema';
import type { PageServerLoad, Actions } from './$types';
import { m } from '$lib/paraglide/messages';

/**
 * Readers are better-auth users. Their public id is a text key, not a uuid, so
 * the taxonomy routes' `isUuid` guard does not apply here — a miss simply
 * matches no row and answers 404.
 */
export const load: PageServerLoad = async ({ params }) => {
	await requireAdminRole();

	const [record] = await db
		.select({
			id: user.id,
			name: user.name,
			email: user.email,
			image: user.image,
			role: user.role,
			banned: user.banned,
			banReason: user.banReason,
			banExpires: user.banExpires,
			emailVerified: user.emailVerified,
			twoFactorEnabled: user.twoFactorEnabled,
			createdAt: user.createdAt,
			updatedAt: user.updatedAt
		})
		.from(user)
		.where(eq(user.id, params.id));
	if (!record) error(404, m.admin_readers_select());

	const [login] = await db
		.select({ lastLogin: max(session.updatedAt) })
		.from(session)
		.where(eq(session.userId, params.id));

	return {
		headerActions: [
			{
				label: m.admin_common_back_to_list(),
				iconName: 'arrow-left',
				variant: 'ghost',
				href: '/admin/readers'
			},
			// Destructive work is never primary (Apple HIG, Buttons).
			record.banned
				? {
						label: m.admin_readers_unban(),
						iconName: 'user-plus',
						variant: 'outline',
						actionId: 'readers:unban'
					}
				: {
						label: m.admin_readers_ban(),
						iconName: 'ban',
						variant: 'outline',
						actionId: 'readers:ban'
					}
		],
		reader: {
			...record,
			lastLogin: login?.lastLogin ?? null
		}
	};
};

export const actions: Actions = {
	ban: async ({ params, request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const reason = (form.get('reason') ?? '').toString().trim();

		// The owner keeps the keys; banning one would lock the site.
		const [target] = await db.select({ role: user.role }).from(user).where(eq(user.id, params.id));
		if (!target) return fail(404, { error: m.admin_readers_select() });
		if (target.role === 'owner') return fail(409, { error: m.admin_readers_cannot_ban() });

		await db
			.update(user)
			.set({ banned: true, banReason: reason === '' ? null : reason })
			.where(eq(user.id, params.id));
		return { success: true };
	},

	unban: async ({ params }) => {
		await requireAdminRole();
		const updated = await db
			.update(user)
			.set({ banned: false, banReason: null, banExpires: null })
			.where(eq(user.id, params.id))
			.returning({ id: user.id });
		if (updated.length === 0) return fail(404, { error: m.admin_readers_select() });
		return { success: true };
	},

	/**
	 * Ownership transfer is deliberately not implemented. Moving `owner` is the
	 * one action that can lock the site out of its own admin, and the schema has
	 * no two-party confirmation to make it safe — it belongs with an audit trail,
	 * not a one-click button in a list detail pane.
	 */
	transfer: async () => {
		await requireAdminRole();
		return fail(501, { error: m.admin_readers_transfer_unavailable() });
	}
};
