import { getOption } from '$lib/server/config/options-registry';
import { getPublicOrigin } from '$lib/server/origin';
import {
	loadNotesMegaData,
	loadPagesMegaData,
	loadPostsMegaData,
	loadTimelineMegaData
} from '$lib/server/nav-data';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ parent }) => {
	const { auth } = await parent();
	const [postsData, notesData, timelineData, pagesData] = await Promise.all([
		loadPostsMegaData(),
		loadNotesMegaData(),
		loadTimelineMegaData(),
		loadPagesMegaData()
	]);
	// Presence config lands in one place (register R-7): every (site) surface
	// consumes it from the layout data and never re-reads it per component.
	const [presenceEnabled, presenceReaderView, presenceReaderDots] = await Promise.all([
		getOption('presence.enabled'),
		getOption('presence.readerView'),
		getOption('presence.readerDots')
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
			enabled: presenceEnabled,
			readerView: presenceReaderView,
			readerDots: presenceReaderDots
		}
	};
};
