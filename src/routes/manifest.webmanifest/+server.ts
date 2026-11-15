import { getOption } from '$lib/server/config/options-registry';
import { SITE_BRANDING_DEFAULT } from '$lib/server/site-branding';
import type { RequestHandler } from './$types';

/**
 * Web app manifest (decision S4, W5.3).
 *
 * Minimal by ruling: `name`/`short_name` both come from `site.info.name`
 * (`site.short_name` is a registered deferral), `start_url` is the locale
 * redirect root, and no icons are advertised - 192/512 PWA icons are a
 * separate registered item. A settings/DB failure serves the defaults instead
 * of 500ing a manifest request.
 */
export const GET: RequestHandler = async () => {
	let name = SITE_BRANDING_DEFAULT.name;
	try {
		const info = await getOption('site.info');
		name = info.name || SITE_BRANDING_DEFAULT.name;
	} catch (error) {
		console.warn('[manifest] site.info unavailable; using the default name', error);
	}

	const body = {
		name,
		short_name: name,
		start_url: '/',
		display: 'standalone'
	};

	return new Response(JSON.stringify(body), {
		headers: {
			'content-type': 'application/manifest+json',
			'cache-control': 'public, max-age=300'
		}
	});
};
