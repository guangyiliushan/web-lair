import type { PhotoTile } from './photo-tile';

/**
 * Progressive full-image loading policy (plan §4.5, T16/T10) and the pure
 * helpers the viewer shares with its tests. Client-safe (no `$lib/server`).
 *
 * Decision inputs: the source byte size from the registry row (already in
 * the public detail payload) and the Network Information API surface
 * (`navigator.connection`). The latter is a progressive enhancement — MDN
 * marks it "limited availability" (Safari/Firefox never shipped it; caniuse
 * ~77%), so "no signal" always takes the threshold path.
 */

/** The shape the viewer stage needs: a tile plus the registry byte size. */
export interface ViewerImageSource extends PhotoTile {
	byteSize: number | null;
}

/** Sources up to this size auto-load the full variant (plan §4.5, 8 MB). */
export const FULL_AUTO_LIMIT_BYTES = 8 * 1024 * 1024;

/** The floater only appears when a load outlives this (plan §4.5: >300ms). */
export const FLOATER_DELAY_MS = 300;

export interface ConnectionLike {
	saveData?: boolean;
	effectiveType?: string;
}

/** Data-saver on, or a 2G-class link → metered (plan §4.5 saveData/弱网). */
export function isMeteredConnection(connection: ConnectionLike | null | undefined): boolean {
	if (!connection) return false;
	if (connection.saveData === true) return true;
	const type = connection.effectiveType;
	return type === 'slow-2g' || type === '2g';
}

/** true → offer a button instead of auto-loading the full variant. */
export function shouldLoadFullOnDemand(
	byteSize: number | null,
	connection: ConnectionLike | null | undefined
): boolean {
	if (isMeteredConnection(connection)) return true;
	// Unknown size takes the auto path: the detail payload always carries
	// byte_size, and blocking the image on a missing field would be worse.
	return typeof byteSize === 'number' && Number.isFinite(byteSize)
		? byteSize > FULL_AUTO_LIMIT_BYTES
		: false;
}
