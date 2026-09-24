import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { passkey } from '@better-auth/passkey';
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
		}
	},

	plugins: [
		passkey({
			rpID: deriveRpId(env.ORIGIN),
			rpName: 'Web Lair',
			origin: env.ORIGIN
		}),
		sveltekitCookies(getRequestEvent) // make sure this is the last plugin in the array
	]
});
