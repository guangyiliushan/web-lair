import { fail } from '@sveltejs/kit';
import { inArray } from 'drizzle-orm';
import { m } from '$lib/paraglide/messages';
import { db } from '$lib/server/db';
import { jobSchedules } from '$lib/server/db/system/job-schedule.schema';
import { getOption } from '$lib/server/config/options-registry';
import { applyForLink, type ApplyErrorCode, type ApplyRejectCode } from '$lib/server/links/apply';
import { EMAIL_RETENTION_DAYS } from '$lib/server/links/prune';
import { listPublicFriends, safeHttpsUrl } from '$lib/server/links/public';
import { requestAddress } from '$lib/server/security/request-address';
import type { PolicyFacts } from './policy-facts';
import type { Actions, PageServerLoad } from './$types';

const POLICY_JOBS = ['links.check', 'links.prune'] as const;

/**
 * Public friends page (M3 / links plan §5.1-5.2): the three zones read from
 * the real registry, the application form posts to this route, and the
 * "our link info" block reads `site.info`. `/admin/friends` is owned by M1
 * and is not touched here.
 *
 * The policy has to load before the query because `publicBannedList` decides
 * whether the ban wall is published at all; everything else runs in parallel.
 * The policy text may only promise scheduled checks/pruning that actually
 * exist, so the live `job_schedules` rows are part of the payload.
 */
export const load: PageServerLoad = async () => {
	const [apply, policy, siteInfo, checks] = await Promise.all([
		getOption('friends.apply'),
		getOption('friends.policy'),
		getOption('site.info'),
		getOption('friends.checks')
	]);
	const [friends, scheduleRows] = await Promise.all([
		listPublicFriends({ publicBannedList: policy.publicBannedList }),
		db
			.select({ job: jobSchedules.job, enabled: jobSchedules.isEnabled })
			.from(jobSchedules)
			.where(inArray(jobSchedules.job, [...POLICY_JOBS]))
	]);
	const isLive = (job: string) => scheduleRows.some((row) => row.job === job && row.enabled);

	const policyFacts: PolicyFacts = {
		graceDays: checks.graceDays,
		failStreak: checks.failStreak,
		backlinkStreak: checks.backlinkStreak,
		checksEnabled: checks.enabled,
		checksScheduled: isLive('links.check'),
		pruneScheduled: isLive('links.prune'),
		allowSubPath: apply.allowSubPath,
		blockedHostSuffixes: policy.blockedHostSuffixes,
		blockedTlds: policy.blockedTlds,
		publicBannedList: policy.publicBannedList,
		emailRetentionDays: EMAIL_RETENTION_DAYS
	};

	return {
		friends,
		applyEnabled: apply.enabled,
		policyFacts,
		siteInfo: {
			name: siteInfo.name,
			description: siteInfo.description,
			avatar: safeHttpsUrl(siteInfo.avatar)
		}
	};
};

/** Service error codes → Paraglide keys (a raw code never reaches the page). */
const ERROR_TEXT: Record<ApplyErrorCode, () => string> = {
	disabled: m.friends_apply_closed,
	'rate-limited': m.friends_apply_err_rate,
	'name-required': m.friends_apply_err_name,
	'name-too-long': m.friends_apply_err_name,
	'name-taken': m.friends_apply_err_name_taken,
	'email-required': m.friends_apply_err_email,
	'email-invalid': m.friends_apply_err_email,
	'url-required': m.friends_apply_err_url,
	'url-invalid': m.friends_apply_err_url,
	'url-insecure': m.friends_apply_err_url,
	'url-subpath': m.friends_apply_err_subpath,
	'avatar-invalid': m.friends_apply_err_avatar,
	'description-too-long': m.friends_apply_err_description,
	'backlink-required': m.friends_apply_err_backlink,
	'backlink-invalid': m.friends_apply_err_backlink,
	'consent-required': m.friends_apply_err_consent,
	duplicate: m.friends_apply_err_duplicate
};

/** Auditable hard-gate refusals (the row is already written as rejected). */
const REJECT_TEXT: Record<ApplyRejectCode, () => string> = {
	'blocked-host': m.friends_apply_err_blocked_host,
	'blocked-tld': m.friends_apply_err_blocked_tld,
	'banned-domain': m.friends_apply_err_banned
};

type ApplyField = 'name' | 'url' | 'backlinkUrl' | 'email' | 'avatar' | 'description' | 'consent';

/** Server codes → the field that carries the inline error (undefined = summary only). */
const ERROR_FIELD: Partial<Record<ApplyErrorCode, ApplyField>> = {
	'name-required': 'name',
	'name-too-long': 'name',
	'name-taken': 'name',
	'email-required': 'email',
	'email-invalid': 'email',
	'url-required': 'url',
	'url-invalid': 'url',
	'url-insecure': 'url',
	'url-subpath': 'url',
	duplicate: 'url',
	'avatar-invalid': 'avatar',
	'description-too-long': 'description',
	'backlink-required': 'backlinkUrl',
	'backlink-invalid': 'backlinkUrl',
	'consent-required': 'consent'
};

const REJECT_FIELD: Record<ApplyRejectCode, ApplyField> = {
	'blocked-host': 'url',
	'blocked-tld': 'url',
	'banned-domain': 'url'
};

function text(form: FormData, name: string): string {
	return String(form.get(name) ?? '');
}

export const actions: Actions = {
	default: async ({ request, getClientAddress }) => {
		const form = await request.formData();
		// Bots fill every input; humans never see this one.
		if (text(form, 'website').trim() !== '') return { success: true };

		const values = {
			name: text(form, 'name'),
			url: text(form, 'url'),
			avatar: text(form, 'avatar'),
			description: text(form, 'description'),
			email: text(form, 'email'),
			backlinkUrl: text(form, 'backlinkUrl')
		};
		const consent = form.get('consent') === 'on';

		const result = await applyForLink(
			{ ...values, consent },
			{ address: requestAddress(getClientAddress) }
		);

		if (result.kind === 'pending') return { success: true };
		if (result.kind === 'rejected') {
			return fail(400, {
				message: REJECT_TEXT[result.code](),
				field: REJECT_FIELD[result.code],
				values
			});
		}
		const status = result.code === 'rate-limited' ? 429 : 400;
		return fail(status, {
			message: ERROR_TEXT[result.code](),
			field: ERROR_FIELD[result.code],
			values
		});
	}
};
