import type { Reroute } from '@sveltejs/kit';
import { deLocalizeUrl } from '$lib/paraglide/runtime';

/**
 * Routing-side half of the locale-prefix model (with `locale-surfaces.ts`):
 * locale-prefixed requests resolve to their neutral routes — this is what
 * makes `/{lang}/rss.xml`, `/{lang}/sitemap.xml` and `/{lang}/robots.txt`
 * reachable at all (they answer as 200 aliases of the neutral endpoints).
 * The i18n-middleware half lives in the paraglide routeStrategies; both
 * halves must stay in place (P3-b second review round: behaviour pinned by
 * `src/hooks.test.ts`).
 */
export const reroute: Reroute = (request) => deLocalizeUrl(request.url).pathname;
