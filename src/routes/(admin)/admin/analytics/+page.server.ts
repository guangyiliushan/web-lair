import { requireAdminRole } from '$lib/server/authz';
import {
	readTrafficSnapshot,
	seriesPoints,
	summarizePageTraffic,
	type TrafficRange
} from '$lib/server/analytics/sentinel';
import { m } from '$lib/paraglide/messages';
import type { PageServerLoad } from './$types';

const RANGES: TrafficRange[] = ['24h', '7d', '30d'];

function parseRange(value: string | null): TrafficRange {
	return RANGES.includes(value as TrafficRange) ? (value as TrafficRange) : '24h';
}

/**
 * Admin analytics: one cached Sentinel dashboard read per range carries the
 * overview, top paths, status breakdown and series. The client is fail-open:
 * `traffic` stays null when Sentinel is down or unconfigured, and the page renders
 * "—" instead of failing the request.
 *
 * PV semantics: `summary.pageRequests` is a filtered page-path count, never
 * Sentinel's raw `overview.requests` (which includes `/_app/`, `/i/`, `/api/` and
 * static files). The status breakdown still supplies the exact 404 total; per-path
 * rows only expose the 4xx class, which the UI labels as such.
 */
export const load: PageServerLoad = async ({ url }) => {
	await requireAdminRole();

	const range = parseRange(url.searchParams.get('range'));
	const snapshot = await readTrafficSnapshot({ range });

	if (!snapshot) {
		return {
			headerTitle: m.admin_analytics_title(),
			range,
			generatedAt: null,
			traffic: null
		};
	}

	const summary = summarizePageTraffic(snapshot);
	const slimPath = (row: (typeof summary.topPages)[number]) => ({
		path: row.path,
		requests: row.requests,
		s4xx: row.s4xx,
		p95: row.p95
	});
	return {
		headerTitle: m.admin_analytics_title(),
		range,
		generatedAt: new Date(snapshot.fetchedAt).toISOString(),
		traffic: {
			summary: {
				...summary,
				topPages: summary.topPages.map(slimPath),
				topErrorPaths: summary.topErrorPaths.map(slimPath)
			},
			overview: {
				requests: snapshot.overview.requests,
				uniqueVisitors: snapshot.overview.unique_visitors,
				p95: snapshot.overview.latency.p95
			},
			series: seriesPoints(snapshot).map((bucket) => ({
				bucket: bucket.bucket,
				requests: bucket.requests
			})),
			referers: snapshot.breakdowns.referer.slice(0, 5),
			browsers: snapshot.breakdowns.browser.slice(0, 5),
			devices: snapshot.breakdowns.device.slice(0, 5),
			attribution: snapshot.attribution
		}
	};
};
