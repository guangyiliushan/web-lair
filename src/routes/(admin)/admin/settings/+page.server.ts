import type { PageServerLoad } from './$types';
import { requireAdminRole } from '$lib/server/authz';
import { getOption } from '$lib/server/config/options-registry';
import {
	auditChanges,
	listSettingsActivity,
	SETTINGS_EVENT_FAMILIES
} from '$lib/server/settings/activity';
import { formatDateTime } from '$lib/utils/i18n';

/**
 * Settings index: the 8-page list lives in the layout; this page adds the
 * cross-cutting change history. Event families are a closed set, so
 * the query parameter cannot widen the read.
 */
export const load: PageServerLoad = async ({ url }) => {
	await requireAdminRole();
	const family = url.searchParams.get('event') ?? '';
	const [siteTz, events] = await Promise.all([
		getOption('site.timezone'),
		listSettingsActivity({ family })
	]);
	return {
		family: (SETTINGS_EVENT_FAMILIES as readonly string[]).includes(family) ? family : '',
		families: [...SETTINGS_EVENT_FAMILIES],
		events: events.map((event) => ({
			id: event.id,
			event: event.event,
			actorName: event.actorName,
			createdLabel: formatDateTime(event.createdAt, { timeZone: siteTz }),
			changes: auditChanges(event.payload)
		}))
	};
};
