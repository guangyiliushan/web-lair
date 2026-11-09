import { describe, expect, it } from 'vitest';
import { editorPayload, type EditorPayloadFields } from './editor-payload';

const fields: EditorPayloadFields = {
	title: 'Title',
	slug: 'title',
	categoryId: '11111111-1111-1111-1111-111111111111',
	summary: '',
	tags: '',
	writingOrigin: '',
	aiHelp: '',
	contentMarkdown: 'Body',
	lang: 'en'
};

describe('editor payload', () => {
	it('treats a language change as dirty', () => {
		expect(editorPayload({ ...fields, lang: 'zh-cn' })).not.toBe(editorPayload(fields));
		expect(JSON.parse(editorPayload(fields)).lang).toBe('en');
	});

	it('leaves the snapshot unchanged for an identical working copy', () => {
		expect(editorPayload({ ...fields })).toBe(editorPayload(fields));
	});
});
