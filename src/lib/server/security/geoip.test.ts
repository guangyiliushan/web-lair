import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * W6.2 GeoIP policy: the deployment header is the only provider, values are
 * normalised hard, and an unset provider reads nothing (so a site without an
 * edge never collects a country by accident).
 */
const { envState } = vi.hoisted(() => ({ envState: {} as Record<string, string | undefined> }));
vi.mock('$env/dynamic/private', () => ({ env: envState }));

import {
	geoFromHeaders,
	geoipCountryHeader,
	isGeoipConfigured,
	normalizeCountry,
	normalizeRegion
} from './geoip';

beforeEach(() => {
	for (const key of Object.keys(envState)) delete envState[key];
});

describe('geoip header provider', () => {
	it('is unavailable until a country header is configured', () => {
		expect(isGeoipConfigured()).toBe(false);
		expect(geoFromHeaders(new Headers({ 'cf-ipcountry': 'US' }))).toEqual({
			country: null,
			region: null
		});
	});

	it('reads the configured headers case-insensitively', () => {
		envState.GEOIP_COUNTRY_HEADER = 'CF-IPCountry';
		envState.GEOIP_REGION_HEADER = 'cf-region-code';
		expect(geoipCountryHeader()).toBe('cf-ipcountry');
		expect(geoFromHeaders(new Headers({ 'cf-ipcountry': 'de', 'cf-region-code': 'be' }))).toEqual({
			country: 'DE',
			region: 'BE'
		});
	});

	it('drops unknown sentinels and forged text', () => {
		envState.GEOIP_COUNTRY_HEADER = 'cf-ipcountry';
		envState.GEOIP_REGION_HEADER = 'cf-region-code';
		expect(geoFromHeaders(new Headers({ 'cf-ipcountry': 'XX' })).country).toBeNull();
		expect(geoFromHeaders(new Headers({ 'cf-ipcountry': 'USA' })).country).toBeNull();
		expect(
			geoFromHeaders(new Headers({ 'cf-ipcountry': 'US', 'cf-region-code': '<script>' })).region
		).toBeNull();
	});

	it('normalises country/region shapes', () => {
		expect(normalizeCountry(' jp ')).toBe('JP');
		expect(normalizeCountry('T1')).toBeNull();
		expect(normalizeRegion('ca')).toBe('CA');
		expect(normalizeRegion('a'.repeat(13))).toBeNull();
	});
});
