/**
 * Public link-policy facts and the claims they authorise.
 *
 * The page may only promise what the running system actually does, so every
 * promise is a derived claim: scheduled checks need both the option switch and
 * a live `job_schedules` row, and the auto-delete sentence additionally needs
 * a live prune schedule. `policyClaims` is pure so the matrix is unit-tested
 * without a browser, and the component is safe to bundle on the client.
 */
export interface PolicyFacts {
	graceDays: number;
	failStreak: number;
	backlinkStreak: number;
	/** `friends.checks.enabled`. */
	checksEnabled: boolean;
	/** A `links.check` row exists and is enabled. */
	checksScheduled: boolean;
	/** A `links.prune` row exists and is enabled. */
	pruneScheduled: boolean;
	/** `friends.apply.allowSubPath`. */
	allowSubPath: boolean;
	blockedHostSuffixes: string[];
	blockedTlds: string[];
	/** `friends.policy.publicBannedList`. */
	publicBannedList: boolean;
	emailRetentionDays: number;
}

export interface PolicyClaims {
	homepageOnly: boolean;
	domainDetail: boolean;
	autoCheck: boolean;
	autoPrune: boolean;
	failStreak: number;
	backlinkStreak: number;
	graceDays: number;
	publicBannedList: boolean;
	emailRetentionDays: number;
}

export function policyClaims(facts: PolicyFacts): PolicyClaims {
	const autoCheck = facts.checksEnabled && facts.checksScheduled;
	return {
		homepageOnly: !facts.allowSubPath,
		domainDetail: facts.blockedHostSuffixes.length > 0 || facts.blockedTlds.length > 0,
		autoCheck,
		autoPrune: autoCheck && facts.pruneScheduled,
		failStreak: facts.failStreak,
		backlinkStreak: facts.backlinkStreak,
		graceDays: facts.graceDays,
		publicBannedList: facts.publicBannedList,
		emailRetentionDays: facts.emailRetentionDays
	};
}
