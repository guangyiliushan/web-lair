// Shared post form validation used by the create and update actions.

export interface PostFormInput {
	title: string;
	slug: string;
	categoryId: string;
	summary: string;
	content: string;
	/** Raw comma separated tags; carried through but not validated here. */
	tags?: string;
	isPublished: boolean;
}

export type PostFormErrors = Partial<Record<keyof PostFormInput, string>>;

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Validate a post form; returns field-keyed errors, empty means valid. */
export function validatePostForm(input: PostFormInput): PostFormErrors {
	const errors: PostFormErrors = {};

	if (!input.title.trim()) errors.title = '标题不能为空';
	if (!input.slug.trim()) {
		errors.slug = 'Slug 不能为空';
	} else if (!SLUG_RE.test(input.slug.trim())) {
		errors.slug = 'Slug 仅允许小写英文、数字和连字符';
	}
	if (!input.categoryId) errors.categoryId = '请选择分类';
	if (!input.content.trim()) errors.content = '正文不能为空';

	return errors;
}

/** Parse a comma separated tag string, trimming and dropping empties. */
export function parseTags(raw: string | undefined | null): string[] {
	if (!raw) return [];
	return raw
		.split(',')
		.map((t) => t.trim())
		.filter(Boolean);
}
