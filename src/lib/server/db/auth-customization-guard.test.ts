import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanForbiddenAuthCustomizations } from './auth-customization-guard.ts';

describe('H3 forbidden customizations', () => {
	it('flags custom session-token and backup-code hashing, custom challenges and adapters', () => {
		const cases = [
			'const hashed = createHash("sha256").update(sessionToken).digest("hex");',
			'const x = sha256(backupCode);',
			'twoFactor({ issuer: "x", challenge: async () => true })',
			'const adapter = customAdapter(db);'
		];
		for (const text of cases) {
			expect(scanForbiddenAuthCustomizations([{ path: 'src/a.ts', text }])).toHaveLength(1);
		}
	});

	it('does not flag the plugin response fields the account page reads', () => {
		const text = `
			const result = await auth.api.enableTwoFactor({ body: { password } });
			return { backupCodes: result.backupCodes, count: result.backupCodes.length };
			const secret = await auth.api.getSession({ headers });
		`;
		expect(scanForbiddenAuthCustomizations([{ path: 'src/b.ts', text }])).toEqual([]);
	});

	it('skips the generated schema and the guard modules themselves', () => {
		for (const path of [
			'src/lib/server/db/auth.schema.ts',
			'src/lib/server/db/auth-customization-guard.ts'
		]) {
			expect(
				scanForbiddenAuthCustomizations([{ path, text: 'const x = sha256(sessionToken);' }])
			).toEqual([]);
		}
	});

	it('no production source file customizes better-auth storage (repository scan)', () => {
		const root = process.cwd();
		const files: Array<{ path: string; text: string }> = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(path);
					continue;
				}
				if (!/\.(ts|svelte)$/.test(path)) continue;
				if (/\.(test|spec)\.ts$/.test(path)) continue;
				files.push({ path, text: readFileSync(path, 'utf8') });
			}
		};
		walk(join(root, 'src'));
		expect(scanForbiddenAuthCustomizations(files)).toEqual([]);
	}, 30_000);
});
