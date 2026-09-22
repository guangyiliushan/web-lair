import { EMBED_PROVIDERS, type EmbedProviderId } from './registry';
import { parseImageTail } from '$lib/components/markdown/image/tail-attrs';

/**
 * The spec 3.4 embed decision — a pure function that never touches the
 * network, short-circuiting in the spec's order:
 *
 * 1) tail attributes say `type=image`            → image
 * 2) an enclosing grid in image mode             → image
 * 3) the extension (query/hash stripped) is a
 *    known image extension                       → image
 * 4) a provider registry match                   → provider card
 * 5) otherwise                                   → generic card
 *
 * Non-web protocols (data:, javascript:, …) are never cards: the node stays
 * an image and the sanitizer strips the src, so the URL cannot leak into
 * card text or attributes either (a spec registration item).
 *
 * Callers must also keep the spec's other half: bare URLs and normal links
 * are never upgraded to cards, and an image inside a link label stays an
 * image — only bare `!` nodes reach this function.
 */

export interface ImageDecisionContext {
	url: string;
	/** Raw tail-attribute text (spec 2 #7) as stored by remark-image-attr. */
	tailAttrs?: string;
	/** True when the image sits inside grid{type=images|layout=masonry|carousel}. */
	inImageContainer?: boolean;
}

export type ImageDecision =
	| { kind: 'image' }
	| { kind: 'embed'; provider: EmbedProviderId | 'generic' };

const IMAGE_EXTENSIONS = new Set([
	'png',
	'jpg',
	'jpeg',
	'gif',
	'webp',
	'avif',
	'svg',
	'bmp',
	'ico'
]);

/** Site-internal card paths (spec 3.4: lair posts / notes / thinking). */
const SITE_EMBED_PATH_REGEX = /^\/(posts|notes|thinking)\//;

export function imageExtension(url: string): string | null {
	const clean = url.split(/[?#]/, 1)[0];
	const match = /\.([A-Za-z0-9]+)$/.exec(clean);
	return match ? match[1].toLowerCase() : null;
}

function matchWebProvider(parsed: URL): EmbedProviderId | null {
	for (const provider of EMBED_PROVIDERS) {
		if (provider.match(parsed)) return provider.id;
	}
	return null;
}

export function decideImage(context: ImageDecisionContext): ImageDecision {
	if (context.tailAttrs && parseImageTail(context.tailAttrs).type === 'image') {
		return { kind: 'image' };
	}
	if (context.inImageContainer) {
		return { kind: 'image' };
	}
	const extension = imageExtension(context.url);
	if (extension !== null && IMAGE_EXTENSIONS.has(extension)) {
		return { kind: 'image' };
	}

	// One URL parse drives both the non-web guard and the registry match.
	let parsed: URL | null;
	try {
		parsed = new URL(context.url);
	} catch {
		parsed = null; // site-relative path
	}
	if (parsed && parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return { kind: 'image' };
	}
	if (parsed) {
		const provider = matchWebProvider(parsed);
		if (provider) return { kind: 'embed', provider };
	} else if (SITE_EMBED_PATH_REGEX.test(context.url)) {
		return { kind: 'embed', provider: 'lair' };
	}
	return { kind: 'embed', provider: 'generic' };
}
