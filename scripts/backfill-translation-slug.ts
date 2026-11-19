import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../src/lib/server/db/schema';
import { notes, posts } from '../src/lib/server/db/content';
import { slugTrackers } from '../src/lib/server/db/system';

/**
 * Translation-slug convergence: a translation family shares ONE address —
 * the source decides it, translations inherit it. This walks every
 * `translation_group` and converges rows written before that rule to the
 * source slug.
 * Dry-run by default (prints the plan, writes nothing); `--apply` commits
 * each row in its own transaction and writes a `slug_trackers` row per
 * retired slug so old URLs still 301. Idempotent. Run:
 * `pnpm ops db backfill-translation-slugs [--apply]`.
 * Safety rails: CONFLICT when another group already owns the target
 * `(lang, slug)`, ORPHAN when a group has no source row, NEEDS-SLUG when
 * the source still carries a `draft-` placeholder — all three are
 * reported, never written.
 */
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
	console.error('DATABASE_URL is required (use --env-file=.env).');
	process.exit(1);
}
const apply = process.argv.includes('--apply');
// Target banner without credentials: the last human-readable gate before an
// --apply run can write. An unparseable DSN fails here (before any connection)
// with a masked message - never the raw string (02 review).
let target: URL;
try {
	target = new URL(DATABASE_URL);
} catch {
	console.error('DATABASE_URL is not a parseable DSN (masked on purpose).');
	process.exit(1);
}
console.log(
	`backfill-translation-slug @ ${new Date().toISOString()} (${apply ? 'APPLY' : 'dry-run'}) target: ${target.host}${target.pathname}`
);

const sqlClient = postgres(DATABASE_URL, { max: 2 });
const db = drizzle(sqlClient, { schema });

/** Same rule as the services' placeholder marker (inlined to avoid importing the app db). */
const PLACEHOLDER_PREFIX = 'draft-';
function isPlaceholderSlug(slug: string): boolean {
	return slug.startsWith(PLACEHOLDER_PREFIX);
}

type Kind = 'post' | 'note';

interface Row {
	id: string;
	lang: string;
	slug: string;
	group: string;
	isSource: boolean;
}

interface Plan {
	kind: Kind;
	id: string;
	lang: string;
	from: string;
	to: string;
}

interface Conflict {
	kind: Kind;
	id: string;
	lang: string;
	target: string;
	blockerId: string;
}

interface Summary {
	kind: Kind;
	groups: number;
	converged: number;
	unchanged: number;
	conflicts: Conflict[];
	orphans: { kind: Kind; group: string; ids: string[] }[];
	needsSlug: { kind: Kind; group: string; slug: string }[];
}

async function loadRows(kind: Kind): Promise<Row[]> {
	if (kind === 'post') {
		const rows = await db
			.select({
				id: posts.id,
				lang: posts.lang,
				slug: posts.slug,
				group: posts.translationGroup,
				isSource: sql<boolean>`${posts.translatedFromPostId} is null`.mapWith(Boolean)
			})
			.from(posts);
		return rows;
	}
	const rows = await db
		.select({
			id: notes.id,
			lang: notes.lang,
			slug: notes.slug,
			group: notes.translationGroup,
			isSource: sql<boolean>`${notes.translatedFromNoteId} is null`.mapWith(Boolean)
		})
		.from(notes);
	return rows;
}

function planFor(kind: Kind, rows: Row[]): { plans: Plan[]; summary: Summary } {
	const byGroup = new Map<string, Row[]>();
	for (const row of rows) {
		const bucket = byGroup.get(row.group);
		if (bucket) bucket.push(row);
		else byGroup.set(row.group, [row]);
	}

	const summary: Summary = {
		kind,
		groups: byGroup.size,
		converged: 0,
		unchanged: 0,
		conflicts: [],
		orphans: [],
		needsSlug: []
	};
	const plans: Plan[] = [];

	for (const [group, members] of byGroup) {
		const sources = members.filter((m) => m.isSource);
		if (sources.length !== 1) {
			summary.orphans.push({ kind, group, ids: members.map((m) => m.id) });
			continue;
		}
		const source = sources[0];
		if (isPlaceholderSlug(source.slug)) {
			summary.needsSlug.push({ kind, group, slug: source.slug });
			continue;
		}

		for (const member of members) {
			if (member.id === source.id) continue;
			if (member.slug === source.slug) {
				summary.unchanged += 1;
				continue;
			}
			// unique(lang, slug): a row from ANOTHER group owning the target
			// makes this write impossible - report it instead of failing mid-run.
			const blocker = rows.find(
				(r) => r.lang === member.lang && r.slug === source.slug && r.group !== member.group
			);
			if (blocker) {
				summary.conflicts.push({
					kind,
					id: member.id,
					lang: member.lang,
					target: source.slug,
					blockerId: blocker.id
				});
				continue;
			}
			plans.push({ kind, id: member.id, lang: member.lang, from: member.slug, to: source.slug });
			summary.converged += 1;
		}
	}
	return { plans, summary };
}

async function applyPlan(plan: Plan): Promise<void> {
	const table = plan.kind === 'post' ? posts : notes;
	await db.transaction(async (tx) => {
		const [current] = await tx
			.select({ id: table.id, slug: table.slug, lang: table.lang })
			.from(table)
			.where(eq(table.id, plan.id))
			.limit(1)
			.for('update');
		if (!current) return;
		if (current.slug === plan.to) return;
		// Old address stays resolvable (one 301 hop).
		if (!isPlaceholderSlug(current.slug)) {
			await tx.insert(slugTrackers).values({
				slug: current.slug,
				type: plan.kind,
				lang: current.lang,
				targetId: current.id
			});
		}
		await tx
			.update(table)
			.set({ slug: plan.to, updatedAt: new Date() })
			.where(eq(table.id, plan.id));
	});
}

function report(label: string, s: Summary, plans: Plan[]) {
	const mine = plans.filter((p) => p.kind === s.kind);
	console.log(
		`\n[${label}] groups=${s.groups} to-converge=${mine.length} unchanged=${s.unchanged}`
	);
	for (const plan of mine) {
		console.log(`  ~ ${plan.lang}  ${plan.from}  ->  ${plan.to}   (${plan.id})`);
	}
	for (const c of s.conflicts) {
		console.log(
			`  ! CONFLICT ${c.lang}  ${c.target}   row=${c.id} blocked-by=${c.blockerId}  (fix by hand)`
		);
	}
	for (const o of s.orphans) {
		console.log(`  ! ORPHAN group=${o.group} ids=${o.ids.join(',')}  (no source row)`);
	}
	for (const n of s.needsSlug) {
		console.log(
			`  ! NEEDS-SLUG group=${n.group} source-slug=${n.slug}  (publish a real slug first)`
		);
	}
	if (
		mine.length === 0 &&
		s.conflicts.length === 0 &&
		s.orphans.length === 0 &&
		s.needsSlug.length === 0
	) {
		console.log('  (nothing to do)');
	}
}

async function main() {
	const postRows = await loadRows('post');
	const noteRows = await loadRows('note');
	const post = planFor('post', postRows);
	const note = planFor('note', noteRows);

	report('posts', post.summary, post.plans);
	report('notes', note.summary, note.plans);

	const all = [...post.plans, ...note.plans];
	const blocked = post.summary.conflicts.length + note.summary.conflicts.length;
	console.log(
		`\nplan: ${all.length} row(s) to converge, ${blocked} conflict(s) left for manual review`
	);

	if (!apply) {
		console.log('dry-run only - re-run with --apply to write.');
		await sqlClient.end();
		return;
	}

	let written = 0;
	for (const plan of all) {
		await applyPlan(plan);
		written += 1;
		process.stdout.write(`\r  applied ${written}/${all.length}`);
	}
	console.log(`\napplied ${written} row(s).`);
	await sqlClient.end();
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
