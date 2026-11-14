/**
 * Favicon href for the root layout (decision register §3A, S3).
 *
 * `site.icon` stores `{ url, version }`. An empty URL (or a value that is
 * neither https nor the same-origin `/i/` proxy) falls back to the bundled
 * static asset - the registry validates writes, but this helper also guards a
 * legacy/corrupt row so a bad option value can never produce a broken head.
 *
 * The `?v=` suffix is a cache bust: browsers keep favicons for a long time and
 * the version is bumped on every save from the Site page.
 */
export interface SiteIconValue {
	url: string;
	version: number;
}

function isHttpsUrl(value: string): boolean {
	try {
		return new URL(value).protocol === 'https:';
	} catch {
		return false;
	}
}

export function siteIconHref(icon: SiteIconValue | null | undefined, fallback: string): string {
	const url = icon?.url?.trim() ?? '';
	if (!url) return fallback;
	if (!url.startsWith('/i/') && !isHttpsUrl(url)) return fallback;
	const version = Number.isInteger(icon?.version) ? icon!.version : 0;
	const separator = url.includes('?') ? '&' : '?';
	return `${url}${separator}v=${version}`;
}
