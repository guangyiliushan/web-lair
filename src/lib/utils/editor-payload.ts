/**
 * The post editor's dirty-check snapshot. Every field the autosave would send
 * belongs in it, including the source language: switching it rewrites the row,
 * so a language change is a change like any other.
 */
export type EditorPayloadFields = {
	title: string;
	slug: string;
	categoryId: string;
	summary: string;
	tags: string;
	writingOrigin: string;
	aiHelp: string;
	contentMarkdown: string;
	lang: string;
};

export function editorPayload(fields: EditorPayloadFields): string {
	return JSON.stringify({
		title: fields.title,
		slug: fields.slug,
		categoryId: fields.categoryId,
		summary: fields.summary,
		tags: fields.tags,
		writingOrigin: fields.writingOrigin,
		aiHelp: fields.aiHelp,
		contentMarkdown: fields.contentMarkdown,
		lang: fields.lang
	});
}
