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
	if (!markdownImage) return htmlImage?.[1] ?? null;
	if (!htmlImage) return markdownImage[1];
	return markdownImage.index < htmlImage.index ? markdownImage[1] : htmlImage[1];
}
