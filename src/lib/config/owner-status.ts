/**
 * Owner identity + activity ticket (static stage).
 *
 * The header badge is the same for every visitor — the site owner's public
 * name/avatar — so these types deliberately carry no session data: only the
 * account control on the right reflects who is looking. The realtime write
 * path (a token-protected publish endpoint) reuses this shape.
 */

export const OWNER_STATUS_KINDS = [
	'listening',
	'editing',
	'coding',
	'reading',
	'viewing',
	'idle'
] as const;

export type OwnerStatusKind = (typeof OWNER_STATUS_KINDS)[number];

export interface SiteOwner {
	name: string;
	avatar: string;
}

export interface OwnerStatus {
	enabled: boolean;
	kind: OwnerStatusKind;
	/** The single visible datum (app / site name); the ticket caps it at 10 chars. */
	detail: string;
	iconUrl: string;
	/** Site-internal target; empty means the ticket is not a link. */
	href: string;
}

export const SITE_OWNER_DEFAULT: SiteOwner = { name: 'Lair', avatar: '' };

export const OWNER_STATUS_DEFAULT: OwnerStatus = {
	enabled: true,
	kind: 'coding',
	detail: 'VS Code',
	iconUrl: '',
	href: ''
};
