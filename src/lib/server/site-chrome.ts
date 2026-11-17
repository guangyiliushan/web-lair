import { getOption } from '$lib/server/config/options-registry';
import { getPublicOrigin } from '$lib/server/origin';
import { effectiveReaderDots } from '$lib/server/services/presence';
import { loadOwnerProfile, ownerProfileToSiteOwner } from '$lib/server/services/owner-profile';
import type { ProfileLink } from '$lib/server/db/account';
import {
	OWNER_STATUS_DEFAULT,
	SITE_OWNER_DEFAULT,
	type OwnerStatus,
	type SiteOwner
} from '$lib/config/owner-status';
import {
	loadNotesMegaData,
	loadPagesMegaData,
	loadPostsMegaData,
	loadTimelineMegaData
} from '$lib/server/nav-data';

/**
 * Shared chrome payload for every site surface (home/posts/notes/... and the
 * gallery). Layout component resets do not have to re-implement auth, nav,
 * owner and presence reads; one loader keeps the header props identical.
 */
type ChromeAuth = {
	user: {
		id: string;
		name: string;
		email: string;
		emailVerified: boolean;
		image: string | null;
	} | null;
	profile: { displayName: string; avatarUrl: string | null } | null;
} | null;

export async function loadSiteChrome({
	parent,
	locals
}: {
	parent: () => Promise<{ auth: ChromeAuth }>;
	locals: App.Locals;
}) {
	const { auth } = await parent();
	const [
		postsData,
		notesData,
		timelineData,
		pagesData,
		presenceOptions,
		ownerIdentity,
		ownerStatus
	] = await Promise.all([
		loadPostsMegaData(),
		loadNotesMegaData(),
		loadTimelineMegaData(),
		loadPagesMegaData(),
		loadPresenceOptions(),
		loadOwnerIdentity(),
		loadOwnerStatus()
	]);

	return {
		auth,
		siteOrigin: getPublicOrigin(),
		postsData,
		notesData,
		timelineData,
		pagesData: {
			...pagesData,
			stats: {
				posts: postsData?.stats?.posts ?? 0,
				notes: notesData?.stats?.notes ?? 0,
				topics: notesData?.stats?.topics ?? 0
			}
		},
		siteOwner: ownerIdentity.owner,
		/** Single social source: Hero, nav panel and mobile menu. */
		ownerLinks: ownerIdentity.links,
		ownerStatus,
		presence: {
			enabled: presenceOptions.enabled,
			readerView: presenceOptions.readerView,
			readerDots: effectiveReaderDots(presenceOptions.readerDots, Boolean(locals.admin))
		}
	};
}

/** The three presence keys; the registry defaults on any failure (fail-open). */
async function loadPresenceOptions(): Promise<{
	enabled: boolean;
	readerView: boolean;
	readerDots: boolean;
}> {
	try {
		const [enabled, readerView, readerDots] = await Promise.all([
			getOption('presence.enabled'),
			getOption('presence.readerView'),
			getOption('presence.readerDots')
		]);
		return { enabled, readerView, readerDots };
	} catch {
		return { enabled: true, readerView: true, readerDots: false };
	}
}

/** Header owner badge + the social rail source; a DB blip fails open. */
async function loadOwnerIdentity(): Promise<{
	owner: SiteOwner;
	links: ProfileLink[];
}> {
	try {
		const profile = await loadOwnerProfile();
		if (!profile) return { owner: SITE_OWNER_DEFAULT, links: [] };
		return { owner: ownerProfileToSiteOwner(profile), links: profile.links ?? [] };
	} catch {
		return { owner: SITE_OWNER_DEFAULT, links: [] };
	}
}

/** Header activity ticket; a settings blip falls back to the registry default (fail-open). */
async function loadOwnerStatus(): Promise<OwnerStatus> {
	try {
		return await getOption('site.ownerStatus');
	} catch {
		return OWNER_STATUS_DEFAULT;
	}
}
