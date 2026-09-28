import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LINK_STATUSES } from './link.schema';
import { PROJECT_PROVIDERS, PROJECT_STATUSES } from './project.schema';

// Guards the reviewed "enum dual-source" risk: the TS constants consumed by
// services and the literals baked into the single baseline must not drift.
const BASELINE = readFileSync('drizzle/0000_baseline.sql', 'utf8');

function checkLiterals(constraint: string): string[] {
	const line = BASELINE.split('\n').find((l) => l.includes(`CONSTRAINT "${constraint}" CHECK`));
	if (!line) throw new Error(`constraint not found in baseline: ${constraint}`);
	return [...new Set([...line.matchAll(/'([^']+)'/g)].map((match) => match[1]))];
}

describe('enum drift guard', () => {
	it('links_status_check literals match LINK_STATUSES', () => {
		expect(new Set(checkLiterals('links_status_check'))).toEqual(new Set(LINK_STATUSES));
	});

	it('projects_provider_check literals match PROJECT_PROVIDERS', () => {
		expect(new Set(checkLiterals('projects_provider_check'))).toEqual(new Set(PROJECT_PROVIDERS));
	});

	it('projects_status_check literals match PROJECT_STATUSES', () => {
		expect(new Set(checkLiterals('projects_status_check'))).toEqual(new Set(PROJECT_STATUSES));
	});
});
