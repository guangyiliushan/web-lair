/**
 * Audit event emitted by every Settings → Site save (W5). Two lowercase
 * segments so the `activities_event_check` regex accepts it; deliberately NOT
 * in `WEBHOOK_EVENT_ROSTER` - site settings are local facts and must fan out
 * to zero deliveries (decision register §3A.4 / R-7).
 */
export const SITE_UPDATE_EVENT = 'site.update';
