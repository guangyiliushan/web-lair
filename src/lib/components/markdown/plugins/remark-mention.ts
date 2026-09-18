import type { Plugin } from 'unified';
import type { Root } from 'mdast';
import { classifyCharacter } from 'micromark-util-classify-character';
import type {
	Code,
	Effects,
	Event,
	Extension,
	State,
	Token,
	TokenizeContext
} from 'micromark-util-types';

/**
 * remark-mention: mention autolinks (spec 2 #4 / 3.5).
 *
 * Syntax: `@gh:user` / `@tw:user` / `@tg:user` from a closed platform
 * whitelist. The result is a standard mdast link node whose url is the
 * `@platform:user` token form, so any standard renderer yields
 * `<a href="@gh:x">@gh:x</a>` with the text intact; export tools are the
 * ones responsible for rewriting that token URL to a real address (3.5).
 *
 * Boundary rule (2 #4): the preceding character must be line start,
 * whitespace or punctuation. Unknown platforms and malformed mentions fall
 * back to literal text (5). Usernames are bounded at 40 characters — regex
 * semantics for the plan's `{1,40}`: the first 40 characters form the mention
 * and anything beyond stays literal text.
 *
 * Tokenizer discipline: micromark's `effects.consume` asserts that the last
 * event is an `enter` (a token is open) for any non-EOF code, so a sub token
 * is exited only *after* consuming the character that closes it. Every
 * `nok` return is rewound by micromark (events are restored), which is why
 * failed attempts leave no trace.
 */

const PLATFORMS = new Set(['gh', 'tw', 'tg']);
/** Username alphabet and length per the migration plan: `[A-Za-z0-9_]{1,40}`. */
const USERNAME_MAX = 40;
const AT = '@'.charCodeAt(0);
const COLON = ':'.charCodeAt(0);
const UNDERSCORE = '_'.charCodeAt(0);
const LOWER_A = 'a'.charCodeAt(0);
const LOWER_Z = 'z'.charCodeAt(0);
const UPPER_A = 'A'.charCodeAt(0);
const UPPER_Z = 'Z'.charCodeAt(0);
const DIGIT_0 = '0'.charCodeAt(0);
const DIGIT_9 = '9'.charCodeAt(0);

/** `[a-z]` at the platform position. */
function isLowerLetter(code: Code): code is number {
	return code !== null && code >= LOWER_A && code <= LOWER_Z;
}

/** `[A-Za-z0-9_]` — the username alphabet. */
function isUsernameChar(code: Code): code is number {
	return (
		code !== null &&
		((code >= DIGIT_0 && code <= DIGIT_9) ||
			(code >= UPPER_A && code <= UPPER_Z) ||
			(code >= LOWER_A && code <= LOWER_Z) ||
			code === UNDERSCORE)
	);
}

/**
 * Port of micromark-extension-gfm-autolink-literal's `previousUnbalanced`:
 * while a link/image label is still open (a `labelLink`/`labelImage` token
 * without `_balanced`), autolink-like constructs must not trigger — an anchor
 * nested inside a label would truncate the outer link.
 */
function previousUnbalanced(events: Array<Event>): boolean {
	let index = events.length;

	while (index--) {
		const token = events[index][1];

		if ((token.type === 'labelLink' || token.type === 'labelImage') && !token._balanced) {
			return true;
		}
	}

	return false;
}

declare module 'micromark-util-types' {
	interface TokenTypeMap {
		mention: Token;
		mentionMarker: Token;
		mentionPlatform: Token;
		mentionUsername: Token;
	}
}

/** micromark syntax extension: `@gh:user` at a word boundary. */
function mentionSyntax(): Extension {
	const tokenizer = {
		name: 'mention',
		tokenize: tokenizeMention
	};

	// The tokenizer's inner states use local structural state types, so the
	// construct is narrowed with one assertion (same pattern as the attention
	// extensions).
	return { text: { [AT]: tokenizer } } as unknown as Extension;

	function tokenizeMention(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
		const previous = this.previous;
		const events = this.events;
		let platform = '';
		let usernameLength = 0;

		return start;

		function start(code: Code): State | undefined {
			// 2 #4: only line start, whitespace or punctuation may precede the `@`
			// (classifyCharacter: 1 = whitespace/boundary, 2 = punctuation,
			// undefined = other text, which must not trigger)
			if (classifyCharacter(previous) === undefined) return nok(code);
			// Inside an unfinished link/image label the mention stays literal
			if (previousUnbalanced(events)) return nok(code);
			effects.enter('mention');
			effects.enter('mentionMarker');
			effects.consume(code);
			effects.exit('mentionMarker');
			return platformFirst;
		}

		function platformFirst(code: Code): State | undefined {
			if (!isLowerLetter(code)) return nok(code);
			platform = String.fromCharCode(code);
			effects.enter('mentionPlatform');
			effects.consume(code);
			return platformSecond;
		}

		function platformSecond(code: Code): State | undefined {
			if (!isLowerLetter(code)) return nok(code);
			platform += String.fromCharCode(code);
			effects.consume(code);
			return platformColon;
		}

		function platformColon(code: Code): State | undefined {
			// The colon closes the platform token: consume it while the token is
			// still open, then exit — consuming after an exit would violate the
			// "last event must be an enter" invariant.
			if (code !== COLON || !PLATFORMS.has(platform)) return nok(code);
			effects.consume(code);
			effects.exit('mentionPlatform');
			return usernameFirst;
		}

		function usernameFirst(code: Code): State | undefined {
			if (!isUsernameChar(code)) return nok(code);
			usernameLength = 1;
			effects.enter('mentionUsername');
			effects.consume(code);
			return usernameRest;
		}

		function usernameRest(code: Code): State | undefined {
			if (isUsernameChar(code) && usernameLength < USERNAME_MAX) {
				usernameLength++;
				effects.consume(code);
				return usernameRest;
			}
			effects.exit('mentionUsername');
			effects.exit('mention');
			return ok(code);
		}
	}
}

interface MentionCompileContext {
	enter(node: object, token: Token): unknown;
	exit(token: Token): unknown;
	sliceSerialize(token: Token): string;
}

/** mdast-util-from-markdown extension: the mention token becomes a link. */
function mentionFromMarkdown() {
	return {
		enter: {
			mention(this: MentionCompileContext, token: Token) {
				// The token spans the whole `@platform:user`, so the literal source
				// slice is exactly the token URL.
				const url = this.sliceSerialize(token);
				this.enter(
					{
						type: 'link',
						url,
						children: [{ type: 'text', value: url }],
						// to-hast follows data.hProperties: renders <a class="mention">
						data: { hName: 'a', hProperties: { className: ['mention'] } }
					},
					token
				);
			}
		},
		exit: {
			mention(this: MentionCompileContext, token: Token) {
				this.exit(token);
			}
		}
	};
}

/**
 * remark plugin: registers the micromark syntax and the mdast compile
 * extension. unified's data(key, value) assigns, so existing extensions are
 * merged in manually.
 */
export const remarkMention: Plugin<[], Root> = function () {
	const data = this.data();
	data.micromarkExtensions = [...(data.micromarkExtensions ?? []), mentionSyntax()];
	data.fromMarkdownExtensions = [...(data.fromMarkdownExtensions ?? []), mentionFromMarkdown()];
};
