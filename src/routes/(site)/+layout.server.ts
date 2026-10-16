import { getOption } from '$lib/server/config/options-registry';
import { getPublicOrigin } from '$lib/server/origin';
import { effectiveReaderDots } from '$lib/server/services/presence';
import {
	loadNotesMegaData,
	loadPagesMegaData,
	loadPostsMegaData,
	loadTimelineMegaData
} from '$lib/server/nav-data';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ parent, locals }) => {
	const { auth } = await parent();
	// Presence config lands in one place (register R-7): every (site) surface
	// consumes it from the layout data and never re-reads it per component.
	// `readerDots` is the EFFECTIVE dots permission: the public option or an
	// admin viewer (the stream hands admins the dots regardless of the
	// option — register E2; the widget gates badge/histogram on `readerView`
	// and the dots layer on this flag). The reads join the page's single
	// batch (no extra serial phase) and a settings blip fails OPEN to the
	// registry defaults — a config read must never 500 every public page.
	const [postsData, notesData, timelineData, pagesData, presenceOptions] = await Promise.all([
		loadPostsMegaData(),
		loadNotesMegaData(),
		loadTimelineMegaData(),
		loadPagesMegaData(),
		loadPresenceOptions()
	]);

	return {
		auth,
		// Single public-origin source for absolute URLs in page heads
		// (canonical/hreflang); null in dev → SeoHead falls back to the
		// request origin (review finding).
		siteOrigin: getPublicOrigin(),
		postsData,
		notesData,
		timelineData,
		pagesData,
		presence: {
			enabled: presenceOptions.enabled,
			readerView: presenceOptions.readerView,
			readerDots: effectiveReaderDots(presenceOptions.readerDots, Boolean(locals.admin))
		}
	};
};

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
