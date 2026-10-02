/**
 * Fallback excerpt for cards and lists when a post has no `summary` set
 * (ledger §8 open item: truncate the body). Strips the common Markdown
 * markers — fenced/inline code, images, links, block prefixes, emphasis —
 * so the card shows readable prose, then truncates on a word-ish boundary.
 */
export function plainTextExcerpt(markdown: string, maxLength = 160): string {
	const text = markdown
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/`([^`]*)`/g, '$1')
		.replace(/!\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
		.replace(/\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
		.replace(/^ {0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
		.replace(/[*_~]{1,3}/g, '')
		.replace(/\s+/g, ' ')
		.trim();

	return text.length > maxLength ? `${text.slice(0, maxLength).trimEnd()}…` : text;
}

/**
 * First image URL in Markdown content - notes list cards derive their cover
 * from the body (notes plan §3.1; diary entries have no cover column, by
 * design). Fenced code blocks are stripped first so a code sample cannot
 * steal the cover; Markdown images and raw `<img>` tags are both recognised
 * and the earliest match wins. Returns null when there is no image.
 */
export function firstImageFromMarkdown(markdown: string): string | null {
	const source = markdown.replace(/```[\s\S]*?```/g, ' ');
	const markdownImage = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?/.exec(source);
	const htmlImage = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i.exec(source);
	const url = !markdownImage
		? (htmlImage?.[1] ?? null)
		: !htmlImage
			? markdownImage[1]
			: markdownImage.index < htmlImage.index
				? markdownImage[1]
				: htmlImage[1];
	return url !== null && isSafeCoverUrl(url) ? url : null;
}

/**
 * Cover URL policy (review finding): site-internal paths ('/...', never
 * protocol-relative '//...') or https links. Keeps list page loads from
 * becoming third-party requests (tracking pixels), `data:` payloads out of
 * the response, and script-ish schemes away from an `img` src that later
 * batches may reuse (og:image).
 */
export function isSafeCoverUrl(url: string): boolean {
	if (url.startsWith('//')) return false;
	if (url.startsWith('/')) return true;
	return /^https:\/\//i.test(url);
}
