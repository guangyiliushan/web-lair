import type { Reroute } from '@sveltejs/kit';
import { deLocalizeUrl } from '$lib/paraglide/runtime';

/**
 * De-localizes prefixed paths so `/{lang}/rss.xml`, `/{lang}/sitemap.xml` and
 * `/{lang}/robots.txt` reach the neutral endpoints as 200 aliases. The i18n
 * middleware half lives in the paraglide `routeStrategies` (`vite.config.ts`);
 * `hooks.test.ts` pins this half — dropping it silently 404s every prefixed feed.
 */
export const reroute: Reroute = (request) => deLocalizeUrl(request.url).pathname;
