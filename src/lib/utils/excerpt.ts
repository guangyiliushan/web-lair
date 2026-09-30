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
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/^ {0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
		.replace(/[*_~]{1,3}/g, '')
		.replace(/\s+/g, ' ')
		.trim();

	return text.length > maxLength ? `${text.slice(0, maxLength).trimEnd()}…` : text;
}
