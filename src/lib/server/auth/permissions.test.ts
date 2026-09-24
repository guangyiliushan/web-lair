import { describe, expect, it } from 'vitest';
import {
	adminRole,
	moderatorRole,
	orgAdminRole,
	orgMemberRole,
	orgOwnerRole,
	ownerRole,
	reviewerRole,
	statement,
	userRole
} from './permissions';

describe('admin plugin roles (B1)', () => {
	it('owner keeps the admin statements and adds impersonate-admins', () => {
		expect(ownerRole.statements.user).toContain('impersonate-admins');
		expect(ownerRole.statements.user).toContain('impersonate');
		expect(ownerRole.statements.session).toContain('revoke');
	});

	it('admin manages users and sessions but cannot impersonate admins', () => {
		expect(adminRole.statements.user).toContain('ban');
		expect(adminRole.statements.user).toContain('set-role');
		expect(adminRole.statements.user).not.toContain('impersonate-admins');
	});

	it('user has no global control', () => {
		expect(userRole.statements.user).toEqual([]);
		expect(userRole.statements.session).toEqual([]);
	});
});

describe('organization plugin roles (B2, B2.1 review fix)', () => {
	const commentActions = (role: { statements: Record<string, unknown> }) =>
		(role.statements.comment as readonly string[] | undefined) ?? [];

	it('exposes the comment resource on the shared statement', () => {
		expect(statement.comment).toEqual(['review', 'approve', 'reject', 'delete']);
	});

	it('org owner/admin keep full comment control but no destructive org statements', () => {
		for (const role of [orgOwnerRole, orgAdminRole]) {
			expect(commentActions(role)).toEqual(['review', 'approve', 'reject', 'delete']);
			// The site owns a single organization and cannot recreate it: the
			// update/delete statements stay stripped (B2.1 review fix).
			expect(role.statements.organization).toEqual([]);
		}
	});

	it('reviewer reviews/approves/rejects but cannot delete; moderator adds delete', () => {
		expect(commentActions(reviewerRole)).toEqual(['review', 'approve', 'reject']);
		expect(commentActions(moderatorRole)).toEqual(['review', 'approve', 'reject', 'delete']);
	});

	it('plain org members have no comment capability', () => {
		expect(commentActions(orgMemberRole)).toEqual([]);
	});
});
