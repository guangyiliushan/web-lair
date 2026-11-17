import { env } from '$env/dynamic/private';

/**
 * Deployment-header GeoIP. The site deliberately does not call
 * a third-party lookup API: when the edge (Cloudflare today) knows the country
 * it forwards a header, and the deployment names which headers to trust via
 * `GEOIP_COUNTRY_HEADER` / `GEOIP_REGION_HEADER`. Unset = no provider, and
 * the settings form keeps `collectCountry` unavailable.
 *
 * Values are normalised hard: ISO 3166-1 alpha-2 for the country, a short
 * alphanumeric subdivision code for the region. Anything else is dropped -
 * a forged header must not install arbitrary text into the comment row.
 */

const COUNTRY = /^[A-Z]{2}$/;
const REGION = /^[A-Za-z0-9-]{1,12}$/;
/** Placeholder codes edges emit when they cannot resolve a country. */
const UNKNOWN_COUNTRIES = new Set(['XX', 'T1']);

export interface GeoHint {
	country: string | null;
	region: string | null;
}

export function geoipCountryHeader(): string | null {
	return env.GEOIP_COUNTRY_HEADER?.trim().toLowerCase() || null;
}

export function geoipRegionHeader(): string | null {
	return env.GEOIP_REGION_HEADER?.trim().toLowerCase() || null;
}

/** A provider exists once the deployment names a country header. */
export function isGeoipConfigured(): boolean {
	return geoipCountryHeader() !== null;
}

export function normalizeCountry(raw: string | null | undefined): string | null {
	const value = (raw ?? '').trim().toUpperCase();
	if (!COUNTRY.test(value) || UNKNOWN_COUNTRIES.has(value)) return null;
	return value;
}

export function normalizeRegion(raw: string | null | undefined): string | null {
	const value = (raw ?? '').trim().toUpperCase();
	return REGION.test(value) ? value : null;
}

/** Read the configured headers; absent/blank/untrusted values yield null. */
export function geoFromHeaders(headers: Headers): GeoHint {
	const countryHeader = geoipCountryHeader();
	if (!countryHeader) return { country: null, region: null };
	const regionHeader = geoipRegionHeader();
	return {
		country: normalizeCountry(headers.get(countryHeader)),
		region: regionHeader ? normalizeRegion(headers.get(regionHeader)) : null
	};
}
