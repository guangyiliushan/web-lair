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

	return {
		auth,
		// Single public-origin source for absolute URLs in page heads
		// (canonical/hreflang); null in dev → SeoHead falls back to the
		// request origin (review finding).
		siteOrigin: getPublicOrigin(),
		postsData,
		notesData,
		timelineData,
		pagesData
	};
};
