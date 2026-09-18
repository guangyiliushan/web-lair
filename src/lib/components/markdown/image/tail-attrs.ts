/**
 * Tail-attribute parser shared by the render plugin (remark-image-attr) and
 * the editor node (ImageNode.applyTailSize). Keeping one parser keeps the two
 * sides from drifting: an invalid value must not apply on either side.
 *
 * Spec 2 #7: the closed key set is width/height (pixel counts, capped at four
 * digits so a hostile size cannot blow up the layout) and type (the
 * `type=image` flag, consumed by the embed decision).
 */

export interface ImageTail {
	width?: string;
	height?: string;
	type?: string;
	/** Tokens that failed validation or are unknown (callers warn once). */
	rejected: string[];
}

export function parseImageTail(raw: string): ImageTail {
	const tail: ImageTail = { rejected: [] };
	for (const token of raw.split(/\s+/).filter(Boolean)) {
		const eq = token.indexOf('=');
		const key = eq === -1 ? token : token.slice(0, eq);
		const value = eq === -1 ? '' : token.slice(eq + 1);
		if ((key === 'width' || key === 'height') && /^\d{1,4}$/.test(value)) {
			tail[key] = value;
		} else if (key === 'type' && value === 'image') {
			tail.type = 'image';
		} else {
			tail.rejected.push(token);
		}
	}
	return tail;
}
