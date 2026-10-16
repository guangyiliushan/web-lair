/**
 * Presence components (realtime R3/R4, ledger §23): `PresenceHeartbeat`
 * mounts once in the (site) layout and renders nothing; `ContentPresence` is
 * the reader widget on posts/notes detail pages (badge + density strip);
 * `openPresenceStream` backs the admin dashboard's live cards.
 */
export { default as ContentPresence } from './content-presence.svelte';
export { default as PresenceHeartbeat } from './presence-heartbeat.svelte';
export { openPresenceStream } from './presence-client';
