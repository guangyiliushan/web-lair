import { getOption } from '$lib/server/config/options-registry';

/**
 * Site-wide branding for the root layout and the web manifest.
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

const ICON_PROBE_TTL_MS = 10 * 60_000;
const ICON_PROBE_TIMEOUT_MS = 1500;
const ICON_PROBE_MAX_ENTRIES = 100;
const iconProbeCache = new Map<string, { ok: boolean; at: number }>();

/**
 * External favicons are probed (cached, HEAD, short timeout): a broken CDN URL
 * would otherwise leave every page shipping a dead icon, and the sticky
 * favicon cache makes that look like a browser bug. Definitive answers (404 /
 * 410, or a 2xx with a non-image content type) fall back to the bundled asset;
 * timeouts, network errors and unsupported HEAD fail OPEN (keep the stored
 * icon) so a transient blip cannot rewrite branding.
 */
async function iconResolves(icon: SiteBranding['icon']): Promise<boolean> {
	if (!icon.url || icon.url.startsWith('/i/')) return true;
	const key = `${icon.url}#${icon.version}`;
	const cached = iconProbeCache.get(key);
	if (cached && Date.now() - cached.at < ICON_PROBE_TTL_MS) return cached.ok;

	let ok = true;
	try {
		const response = await fetch(icon.url, {
			method: 'HEAD',
			redirect: 'follow',
			signal: AbortSignal.timeout(ICON_PROBE_TIMEOUT_MS)
		});
		if (response.status === 404 || response.status === 410) {
			ok = false;
		} else if (response.ok) {
			const type = (response.headers.get('content-type') ?? '').toLowerCase();
			// Some CDNs serve favicons as octet-stream; only a clearly
			// non-image type (text/html, application/json) is a fallback.
			if (type && !type.startsWith('image/') && !type.startsWith('application/octet-stream')) {
				ok = false;
			}
		}
	} catch {
		// Timeout / DNS / TLS / HEAD unsupported: keep the stored icon.
		ok = true;
	}

	if (iconProbeCache.size >= ICON_PROBE_MAX_ENTRIES) iconProbeCache.clear();
	iconProbeCache.set(key, { ok, at: Date.now() });
	return ok;
}

export async function loadSiteBranding(): Promise<SiteBranding> {
	try {
		const [info, storedIcon] = await Promise.all([getOption('site.info'), getOption('site.icon')]);
		const icon = (await iconResolves(storedIcon))
			? storedIcon
			: { url: '', version: storedIcon.version };
		return {
			name: info.name || SITE_BRANDING_DEFAULT.name,
			icon
		};
	} catch (error) {
		console.warn('[site-branding] settings unavailable; using defaults', error);
		return structuredClone(SITE_BRANDING_DEFAULT);
	}
}
