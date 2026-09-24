import { describe, expect, it } from 'vitest';
import { adminRole, ownerRole, userRole } from './permissions';

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
