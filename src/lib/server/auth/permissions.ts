import { createAccessControl } from 'better-auth/plugins/access';
import { adminAc, defaultStatements } from 'better-auth/plugins/admin/access';

/**
 * Site-wide roles for better-auth's admin plugin.
 *
 * B1 ships owner / admin / user; the organization plugin (B2) contributes its
 * own resource + roles, it does not replace these. `owner` is the single site
 * owner — the invariant lives in `owner.ts`, not in the table (ledger §4.14).
 */
export const statement = { ...defaultStatements } as const;

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
