import { betterAuth } from 'better-auth/minimal';
import { createAuthMiddleware } from 'better-auth/api';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { passkey } from '@better-auth/passkey';
import {
	admin as adminPlugin,
	lastLoginMethod,
	organization,
	twoFactor
} from 'better-auth/plugins';
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
import { validateUserProvisioning } from '$lib/server/auth/admin-login-policy';
import { hashAccountPassword, verifyAccountPassword } from '$lib/server/auth/password';
import { enforceSessionLimit } from '$lib/server/auth/sessions';
import { getSiteOrganizationId } from '$lib/server/auth/site-organization';
import { env } from '$env/dynamic/private';
import { getRequestEvent } from '$app/server';
import { db } from '$lib/server/db';
import { verification } from '$lib/server/db/auth.schema';
import { userProfiles } from '$lib/server/db/account/user-profile.schema';
import { and, eq, like } from 'drizzle-orm';
import { sendMailOrDevLog } from '$lib/server/mail/transport';
import {
	isMailLang,
	resetPasswordMail,
	type MailLang,
	verifyEmailMail
} from '$lib/server/mail/templates';

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

/**
 * Auth mail language: the site default (options `site.default_lang`), read
 * lazily so a missing options table cannot break sign-in. Falls back to English.
 */
async function siteMailLang(): Promise<MailLang> {
	try {
		const { getOption } = await import('$lib/server/config/options-registry');
		const lang = await getOption('site.default_lang');
		return typeof lang === 'string' && isMailLang(lang) ? lang : 'en';
	} catch {
		return 'en';
	}
}

let warnedAboutMissingSiteOrganization = false;

/** One-off note: before /admin/setup has run there simply is no organization. */
function warnMissingSiteOrganizationOnce() {
	if (warnedAboutMissingSiteOrganization) return;
	warnedAboutMissingSiteOrganization = true;
	console.warn(
		'[site-organization] no site organization yet; sessions created before setup stay unpinned.'
	);
}

export const auth = betterAuth({
	baseURL: env.ORIGIN,
	secret: env.BETTER_AUTH_SECRET,
	database: drizzleAdapter(db, { provider: 'pg' }),

	// Official option, data format only.
	// New OAuth access/refresh tokens are written as `$ba$<key-version>$<hex>`
	// (XChaCha20-Poly1305) and decrypted on read; the account table is not
	// touched structurally. Legacy plaintext rows keep working - better-auth
	// only decrypts values that look encrypted - and are rewritten on the next
	// sign-in/refresh. Key versions come from `BETTER_AUTH_SECRETS`; rollback
	// Rotate forward: prepend a version, wait, then retire the old one.
	account: {
		encryptOAuthTokens: true
	},

	// GitHub is a reader-only method. The
	// official `validateUserInfo` gate runs before the OAuth account/session
	// write (and before linking a provider to an existing row), so GitHub can
	// never mint an admin/owner session. Email + TOTP, passkey and the
	// registered tailnet owner hand-off are separate paths.
	user: {
		validateUserInfo: validateUserProvisioning,
		// `default_lang` is an application field on the user model,
		// not a hand edit. Declaring it here is what lets `pnpm auth:schema`
		// reproduce the column the writer-language feature reads; the value is
		// managed by the app, so clients cannot set it through better-auth.
		additionalFields: {
			defaultLang: { type: 'string', required: false, input: false }
		}
	},

	// OAuth failures (including the gate above) return to the sign-in page with
	// `?error=<code>` instead of better-auth's built-in error page.
	onAPIError: {
		errorURL: '/login'
	},

	emailAndPassword: {
		enabled: true,
		requireEmailVerification: true,
		// Official hash/verify hooks only; the account table keeps
		// storing one opaque hash string, so `pnpm auth:schema` stays the sole
		// schema source. Verify accepts legacy scrypt rows for a safe rollout.
		password: {
			hash: hashAccountPassword,
			verify: verifyAccountPassword
		},
		// A completed reset invalidates every existing session of the
		// account (better-auth's official option), so a stolen cookie cannot
		// outlive the password it was minted under. The reset flow has no
		// session of its own to keep.
		revokeSessionsOnPasswordReset: true,
		// better-auth consumes only the presented reset token; an older mailed
		// link would stay valid for its full hour. Sweep every outstanding token
		// for the account. Best-effort: the password is already changed, so a
		// cleanup failure must not turn the reset into an error.
		onPasswordReset: async ({ user }) => {
			try {
				await db
					.delete(verification)
					.where(
						and(eq(verification.value, user.id), like(verification.identifier, 'reset-password:%'))
					);
			} catch (error) {
				console.warn('[auth] reset-token sweep failed', (error as Error).name);
			}
		},
		sendResetPassword: async ({ user, url }) => {
			await sendMailOrDevLog({ to: user.email, ...resetPasswordMail(await siteMailLang(), url) });
		}
	},

	emailVerification: {
		sendVerificationEmail: async ({ user, url }) => {
			await sendMailOrDevLog({ to: user.email, ...verifyEmailMail(await siteMailLang(), url) });
		}
	},

	socialProviders: {
		// Both values come from `$env/dynamic/private` (string | undefined).
		// GitHub sign-in only exists when both are configured; a half-configured
		// provider would fail at callback time with no useful signal.
		...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
			? {
					github: {
						clientId: env.GITHUB_CLIENT_ID,
						clientSecret: env.GITHUB_CLIENT_SECRET
					}
				}
			: {})
	},

	session: {
		// Keep the sliding 30-day lifetime with a 24-hour refresh
		// and do NOT claim AAL2. AAL1 allows 30 days; AAL2 would require an
		// absolute 24-hour cutoff (or the registered admin-only 7-day check),
		// which is a future compliance-triggered change, not today's policy.
		expiresIn: 30 * 24 * 60 * 60, // 30 days
		updateAge: 24 * 60 * 60 // refresh every 24 hours when active
	},

	hooks: {
		after: createAuthMiddleware(async (ctx) => {
			// Passkey registration is the one credential change that
			// happens on the client (WebAuthn), so its audit row is written here
			// instead of a form action. The returned row is already persisted;
			// an audit failure must not turn a successful registration into an
			// error, so it is logged best-effort.
			if (ctx.path !== '/passkey/verify-registration') return;
			// The plugin returns the persisted passkey row directly (not a
			// `{ passkey }` wrapper). Accept both shapes so an upstream change
			// cannot silently kill the audit row.
			const returned = ctx.context.returned as
				| {
						passkey?: { id?: string; userId?: string };
						id?: string;
						userId?: string;
				  }
				| undefined;
			const passkey = returned?.passkey ?? returned;
			if (!passkey?.id || !passkey.userId) return;
			try {
				const { recordActivity } = await import('$lib/server/audit');
				await recordActivity(db, {
					event: 'account.passkey_add',
					actorId: passkey.userId,
					payload: { passkey_id: passkey.id },
					deliver: false
				});
			} catch (error) {
				console.warn(
					'[account] passkey add audit failed:',
					error instanceof Error ? error.message : error
				);
			}
		})
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
				// Pin every session to the site organization so
				// org-scoped checks (comment review) need no separate activate step.
				// Auth is the critical path: a lookup failure must degrade to an
				// unpinned session (permission checks stay fail-closed) instead of
				// taking every sign-in down with it.
				before: async (session) => {
					try {
						const siteOrganizationId = await getSiteOrganizationId();
						if (!siteOrganizationId) {
							warnMissingSiteOrganizationOnce();
							return;
						}
						return { data: { ...session, activeOrganizationId: siteOrganizationId } };
					} catch (error) {
						console.warn(
							'[site-organization] lookup failed; session left unpinned',
							error instanceof Error ? error.message : error
						);
						return;
					}
				},
				// Cap concurrent sessions per account. A cleanup failure
				// must never break sign-in; the oldest row simply survives until
				// the next attempt (logged).
				after: async (session) => {
					try {
						await enforceSessionLimit(session.userId, session.id);
					} catch (error) {
						console.warn(
							'[auth] session limit cleanup failed:',
							error instanceof Error ? error.message : error
						);
					}
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
			// The site owns exactly one organization and nothing can recreate it:
			// keep the destructive endpoint closed (the matching statements are
			// also stripped from the org roles in permissions.ts).
			disableOrganizationDeletion: true,
			// No mailer yet: invitations are bypassed with
			// auth.api.addMember; if the plugin's invite endpoint is ever hit the
			// invitation row still lands in the DB, so log enough to trace it.
			sendInvitationEmail: async ({ email, id, organization }) => {
				console.warn(
					`[org-invite] invitation ${id} for ${email} (org ${organization.id}) was not sent: no mailer configured`
				);
			}
		}),
		passkey({
			rpID: deriveRpId(env.ORIGIN),
			rpName: 'Web Lair',
			origin: env.ORIGIN
		}),
		// TOTP second factor for owner/admin accounts.
		// The plugin's challenge hook only covers /sign-in/email|username|phone-number,
		// so GitHub OAuth, passkey and the Tailnet endpoint stay outside the gate;
		// that is the registered bypass set, not an accident (verified in 1.7.5 dist).
		twoFactor({ issuer: 'Web Lair' }),
		// Tailnet sign-in that issues a real better-auth session (B1).
		tailscaleSignIn(),
		sveltekitCookies(getRequestEvent) // make sure this is the last plugin in the array
	]
});
