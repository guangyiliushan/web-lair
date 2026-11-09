import { and, desc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { notes, posts } from '$lib/server/db/content';
import { getOption } from '$lib/server/config/options-registry';
import { feedableNoteCondition } from '$lib/server/services/note-visibility';
import { visiblePostCondition } from '$lib/server/services/post-visibility';
import { plainTextExcerpt } from '$lib/utils/excerpt';
import { localizeHref } from '$lib/paraglide/runtime';

const MAX_BYTES = 50 * 1024;
const MAX_ITEMS = 500;
const POST_LIMIT = 200;
const NOTE_LIMIT = 100;

function itemLine(title: string, url: string, note: string): string {
	const cleanNote = note.replace(/\s+/g, ' ').trim().slice(0, 160);
	return `- [${title.replace(/[[\]]/g, '')}](${url})${cleanNote ? `: ${cleanNote}` : ''}`;
}

/**
 * llms.txt v2 proposal (llmstxt.org, 2026-08-10; a proposal, not an RFC):
 * H1, blockquote summary, H2 file lists. Links point at the `.md` mirrors
 * when available. The 50 KiB / 500 item caps are product guardrails (Ghost
 * precedent), not spec requirements.
 */
export async function buildLlmsTxt(origin: string, lang: string): Promise<string> {
	const site = await getOption('site.info');
	const now = new Date();
	const [postRows, noteRows] = await Promise.all([
		db
			.select({
				title: posts.title,
				slug: posts.slug,
				summary: posts.summary,
				content: posts.content
			})
			.from(posts)
			.where(and(eq(posts.lang, lang), visiblePostCondition(now)))
			// Tiebreaker: equal published_at must not shuffle row order between
			// rebuilds - the ETag (and downstream caches) would flap.
			.orderBy(desc(posts.publishedAt), desc(posts.id))
			.limit(POST_LIMIT),
		db
			.select({
				title: notes.title,
				slug: notes.slug,
				content: notes.content
			})
			.from(notes)
			.where(and(eq(notes.lang, lang), feedableNoteCondition(now)))
			.orderBy(desc(notes.publishedAt), desc(notes.id))
			.limit(NOTE_LIMIT)
	]);
	const lines: string[] = [`# ${site.name || 'Web Lair'}`, ''];
	if (site.description) lines.push(`> ${site.description}`, '');
	lines.push(
		`This file covers the ${lang} content under ${origin}/${lang}/. The linked pages are clean Markdown mirrors.`,
		'',
		'## Posts',
		''
	);
	let count = 0;
	for (const row of postRows) {
		if (count >= MAX_ITEMS) break;
		const url = `${origin}${localizeHref(`/posts/${row.slug}.md`, { locale: lang as never })}`;
		lines.push(
			itemLine(row.title, url, row.summary?.trim() || plainTextExcerpt(row.content ?? ''))
		);
		count += 1;
	}
	if (noteRows.length > 0) {
		lines.push('', '## Notes', '');
		for (const row of noteRows) {
			if (count >= MAX_ITEMS) break;
			const url = `${origin}${localizeHref(`/notes/${row.slug}.md`, { locale: lang as never })}`;
			lines.push(itemLine(row.title, url, plainTextExcerpt(row.content ?? '')));
			count += 1;
		}
	}
	lines.push(
		'',
		'## Optional',
		'',
		`- [Sitemap](${origin}/sitemap.xml)`,
		`- [RSS](${origin}${localizeHref('/rss.xml', { locale: lang as never })})`
	);
	let text = `${lines.join('\n')}\n`;
	if (new TextEncoder().encode(text).length > MAX_BYTES) {
		// Keep the file valid Markdown and byte-honest: drop whole lines until
		// the encoded size fits. A UTF-16 slice() counts CJK as one unit while
		// the budget is bytes - zh/ja bodies ran ~3x over budget and could
		// split a surrogate pair.
		const encoder = new TextEncoder();
		const kept: string[] = [];
		let size = 0;
		for (const line of lines) {
			const bytes = encoder.encode(`${line}\n`).length;
			if (size + bytes > MAX_BYTES - 200) break;
			kept.push(line);
			size += bytes;
		}
		text = `${kept.join('\n')}\n\n_Truncated at the 50 KiB budget._\n`;
	}
	return text;
}
