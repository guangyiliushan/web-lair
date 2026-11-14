import { getOption } from '$lib/server/config/options-registry';

/**
 * Site-wide branding for the root layout and the web manifest (W5.3).
 *
 * The root layout renders on every page, including login and the admin shell,
 * so a settings/DB blip must never turn a page into a 500: both reads are
 * wrapped and fall back to the registry defaults. The values themselves are
 * validated by the registry on write.
 */
export interface SiteBranding {
	name: string;
	icon: { url: string; version: number };
}

export const SITE_BRANDING_DEFAULT: SiteBranding = {
	name: 'Web Lair',
	icon: { url: '', version: 0 }
};

export async function loadSiteBranding(): Promise<SiteBranding> {
	try {
		const [info, icon] = await Promise.all([getOption('site.info'), getOption('site.icon')]);
		return {
			name: info.name || SITE_BRANDING_DEFAULT.name,
			icon
		};
	} catch (error) {
		console.warn('[site-branding] settings unavailable; using defaults', error);
		return structuredClone(SITE_BRANDING_DEFAULT);
	}
}
