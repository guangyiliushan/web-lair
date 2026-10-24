import { loadSiteChrome } from '$lib/server/site-chrome';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = (event) => loadSiteChrome(event);
