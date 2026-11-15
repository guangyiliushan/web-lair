import type { LayoutServerLoad } from './$types';
import { loadSiteBranding } from '$lib/server/site-branding';

export const load: LayoutServerLoad = async ({ locals }) => {
	const { user, profile } = locals;
	// Site-wide branding (W5.3): the root layout needs the site name for
	// og:site_name and the favicon for the icon link/manifest. The helper
	// falls back to the registry defaults on any settings/DB failure, so a
	// blip cannot 500 login or the admin shell.
	const branding = await loadSiteBranding();

	if (!user) {
		return { auth: null, siteName: branding.name, siteIcon: branding.icon };
	}

	return {
		siteName: branding.name,
		siteIcon: branding.icon,
		auth: {
			user: {
				id: user.id,
				name: user.name,
				email: user.email,
				emailVerified: user.emailVerified,
				image: user.image ?? null
			},
			profile: profile
				? {
						displayName: profile.displayName,
						avatarUrl: profile.avatarUrl ?? null
					}
				: null
		}
	};
};
