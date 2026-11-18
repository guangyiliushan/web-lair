// WebSocket store — manages connection state and recent events.
// Must only be initialized in the browser (onMount or client-only component).
import { writable } from 'svelte/store';

export const wsConnected = writable(false);
export const wsLastEvent = writable<{ event: string; payload: unknown } | null>(null);
