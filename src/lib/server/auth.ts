import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { passkey } from '@better-auth/passkey';
import { admin as adminPlugin, lastLoginMethod, organization } from 'better-auth/plugins';
import {
	ac,
	adminRole,
	moderatorRole,
	orgAdminRole,
	orgMemberRole,
	orgOwnerRole,
	ownerRole,
	reviewerRole,
	userRole
} from '$lib/server/auth/permissions';
import { tailscaleSignIn } from '$lib/server/auth/tailscale-plugin';
import { getSiteOrganizationId } from '$lib/server/auth/site-organization';
import { env } from '$env/dynamic/private';
import { getRequestEvent } from '$app/server';
import { db } from '$lib/server/db';
import { userProfiles } from '$lib/server/db/account/user-profile.schema';

function deriveRpId(origin: string): string {
	try {
		return new URL(origin).hostname;
	} catch {
		return 'localhost';
	}
}

function generateSlug(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/(^-|-$)/g, '') +
		'-' +
		crypto.randomUUID().slice(0, 6)
	);
}

function devLogMail(label: string, url: string) {
	if (import.meta.env.DEV) {
		console.log(`[better-auth] ${label}: ${url}`);
	}
}

export const auth = betterAuth({
	baseURL: env.ORIGIN,
	secret: env.BETTER_AUTH_SECRET,
	database: drizzleAdapter(db, { provider: 'pg' }),

	emailAndPassword: {
		enabled: true,
		requireEmailVerification: true,
		sendResetPassword: async ({ url }) => {
			devLogMail('Password reset link', url);
		}
	},

	emailVerification: {
		sendVerificationEmail: async ({ url }) => {
			devLogMail('Verify email link', url);
		}
	},

	socialProviders: {
		github: {
			clientId: env.GITHUB_CLIENT_ID,
			clientSecret: env.GITHUB_CLIENT_SECRET
		}
	},

	session: {
		expiresIn: 30 * 24 * 60 * 60, // 30 days
		updateAge: 24 * 60 * 60 // refresh every 24 hours when active
	},

	databaseHooks: {
		user: {
			create: {
				after: async (newUser) => {
					await db.insert(userProfiles).values({
						userId: newUser.id,
						displayName: newUser.name,
						slug: generateSlug(newUser.name)
					});
				}
			}
		},
		session: {
			create: {
				// B2 (ledger §4.22): pin every session to the site organization so
				// org-scoped checks (comment review) need no separate activate step.
				before: async (session) => {
					const siteOrganizationId = await getSiteOrganizationId();
					if (!siteOrganizationId) return;
					return { data: { ...session, activeOrganizationId: siteOrganizationId } };
				}
			}
		}
	},

	plugins: [
		// Site-wide roles (owner / admin / user). The role column is plugin-owned;
		// "exactly one owner" is an application-layer invariant (auth/owner.ts).
		adminPlugin({
			ac,
			roles: { owner: ownerRole, admin: adminRole, user: userRole },
			defaultRole: 'user',
			adminRoles: ['owner', 'admin']
		}),
		// Official "last method used" tracking; cookie mode, no schema change.
		lastLoginMethod(),
		// Content collaboration (B2): owner / reviewer / moderator roles plus the
		// `comment` resource. The site organization is created by /admin/setup
		// and pinned onto every session by the database hook above.
		organization({
			ac,
			roles: {
				owner: orgOwnerRole,
				admin: orgAdminRole,
				member: orgMemberRole,
				reviewer: reviewerRole,
				moderator: moderatorRole
			},
			creatorRole: 'owner',
			allowUserToCreateOrganization: false,
			requireEmailVerificationOnInvitation: true,
			// No mailer yet (ledger §4.27): invitations are bypassed with
			// auth.api.addMember; this placeholder keeps sends explicit instead
			// of silently dropping them.
			sendInvitationEmail: async ({ email }) => {
				console.warn(`[organization] invitation for ${email} was not sent (no mailer configured)`);
			}
		}),
		passkey({
			rpID: deriveRpId(env.ORIGIN),
			rpName: 'Web Lair',
			origin: env.ORIGIN
		}),
		// Tailnet sign-in that issues a real better-auth session (B1).
		tailscaleSignIn(),
		sveltekitCookies(getRequestEvent) // make sure this is the last plugin in the array
	]
});
