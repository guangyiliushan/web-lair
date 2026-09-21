import { describe, it, expect } from 'vitest';
import {
	createEditor,
	type TextNode,
	$getRoot as getRoot,
	$createParagraphNode as createParagraphNode,
	$getNodeByKey as getNodeByKey
} from 'lexical';
import { EDITOR_NODES } from './editor-nodes';
import { $createSpoilerNode as createSpoilerNode } from '$lib/components/markdown/spoiler/spoiler-node';
import { $createMentionNode as createMentionNode } from '$lib/components/markdown/mention/mention-node';

/** Mounts a bare editor into a container so DOM sync is observable. */
function mountEditor() {
	const container = document.createElement('div');
	document.body.appendChild(container);
	const editor = createEditor({
		namespace: 'inline-nodes-dom',
		nodes: EDITOR_NODES,
		onError: (error: Error) => {
			throw error;
		}
	});
	editor.setRootElement(container);
	return { editor, container };
}

describe('inline node DOM sync (batch A review F2)', () => {
	it('updates the spoiler DOM text after a programmatic setTextContent', () => {
		const { editor, container } = mountEditor();
		let key = '';
		editor.update(
			() => {
				const paragraph = createParagraphNode();
				const spoiler = createSpoilerNode('abc');
				paragraph.append(spoiler);
				getRoot().append(paragraph);
				key = spoiler.getKey();
			},
			{ discrete: true }
		);
		editor.update(
			() => {
				(getNodeByKey(key) as TextNode | null)?.setTextContent('xyz');
			},
			{ discrete: true }
		);
		expect(container.querySelector('.spoiler')?.textContent).toBe('xyz');
	});

	it('updates the mention DOM text after a programmatic setTextContent', () => {
		const { editor, container } = mountEditor();
		let key = '';
		editor.update(
			() => {
				const paragraph = createParagraphNode();
				const mention = createMentionNode('@gh:someone');
				paragraph.append(mention);
				getRoot().append(paragraph);
				key = mention.getKey();
			},
			{ discrete: true }
		);
		editor.update(
			() => {
				(getNodeByKey(key) as TextNode | null)?.setTextContent('@gh:other');
			},
			{ discrete: true }
		);
		expect(container.querySelector('.mention')?.textContent).toBe('@gh:other');
	});
});
