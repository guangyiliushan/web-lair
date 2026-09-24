import { createAccessControl } from 'better-auth/plugins/access';
import { adminAc, defaultStatements as adminStatements } from 'better-auth/plugins/admin/access';
import {
	adminAc as orgAdminAc,
	defaultStatements as orgStatements,
	memberAc as orgMemberAc,
	ownerAc as orgOwnerAc
} from 'better-auth/plugins/organization/access';

/**
 * One access-control instance shared by both role-carrying plugins:
 *
 *  - the admin plugin (site governance: owner / admin / user) checks the
 *    `user` / `session` resources;
 *  - the organization plugin (content collaboration, B2) checks the
 *    `organization` / `member` / `invitation` resources plus the site-defined
 *    `comment` resource (ledger §4.15).
 *
 * Sharing one `ac` keeps the two role maps from drifting apart; role inputs are
 * partial, so each side only declares the statements it actually needs.
 */
export const statement = {
	...adminStatements,
	...orgStatements,
	comment: ['review', 'approve', 'reject', 'delete']
} as const;

export const ac = createAccessControl(statement);

/** Site owner: everything an admin can do, plus impersonating admins. */
export const ownerRole = ac.newRole({
	...adminAc.statements,
	user: [...adminAc.statements.user, 'impersonate-admins']
});

/** Site admin: full user/session management. */
export const adminRole = ac.newRole({
	...adminAc.statements
});

/** Regular user: no global control. */
export const userRole = ac.newRole({
	user: [],
	session: []
});

/** Organization owner (site-org creator): org defaults + full comment control. */
export const orgOwnerRole = ac.newRole({
	...orgOwnerAc.statements,
	comment: ['review', 'approve', 'reject', 'delete']
});

/** Organization admin: org-admin defaults + full comment control. */
export const orgAdminRole = ac.newRole({
	...orgAdminAc.statements,
	comment: ['review', 'approve', 'reject', 'delete']
});

/** Organization member: no control beyond reading the organization. */
export const orgMemberRole = ac.newRole({
	...orgMemberAc.statements
});

/** Comment reviewer: the moderation queue, without destructive powers. */
export const reviewerRole = ac.newRole({
	comment: ['review', 'approve', 'reject']
});

/** Comment moderator: reviewer plus comment deletion (ledger §4.15). */
export const moderatorRole = ac.newRole({
	comment: ['review', 'approve', 'reject', 'delete']
});
