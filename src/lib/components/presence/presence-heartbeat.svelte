<script lang="ts">
	import { page } from '$app/state';
	import {
		getOrCreatePresenceToken,
		shouldTrackPath,
		startPresenceHeartbeat
	} from './presence-client';

	/**
	 * Site heartbeat (realtime R3): one POST per tab per 15s on every public
	 * reading surface. Mounted once in the (site) layout; renders nothing.
	 * The effect keys on the TRACKED BOOLEAN, so client-side navigation
	 * between tracked pages keeps the loop (and its cadence) alive instead of
	 * restarting it; /account and the five auth pages never beat (R-6) and
	 * the admin shell has its own surface.
	 */

	interface Props {
		enabled?: boolean;
	}

	let { enabled = true }: Props = $props();

	const tracked = $derived(enabled && shouldTrackPath(page.url.pathname));

	$effect(() => {
		if (!tracked) return;
		const token = getOrCreatePresenceToken();
		return startPresenceHeartbeat({ token });
	});
</script>

<!-- No UI: this component only drives the site heartbeat. -->
