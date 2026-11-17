/**
 * Audit event emitted by every Settings → Site save. Two lowercase
 * segments so the `activities_event_check` regex accepts it; deliberately NOT
 * in `WEBHOOK_EVENT_ROSTER` - site settings are local facts and must fan out
 * to zero deliveries.
 */
export const SITE_UPDATE_EVENT = 'site.update';
