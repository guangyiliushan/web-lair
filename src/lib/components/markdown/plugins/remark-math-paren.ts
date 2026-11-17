import type { Plugin } from 'unified';
import type { Root } from 'mdast';
import type {
	Code,
	Effects,
	Extension as MicromarkExtension,
	State,
	Token,
	TokenizeContext,
	Tokenizer
} from 'micromark-util-types';
import { codes } from 'micromark-util-symbol';

/**
 * remarkMathParen adds `\(…\)` inline math — the unambiguous equivalent of `$…$`, the
 * escape hatch for the `$` ambiguity.
 * It is a micromark construct because escapes are resolved while parsing: CommonMark's
 * character escape consumes `\(` before any post-parse plugin can see it. The construct
 * claims `\(` only when a matching `\)` exists on the same line; a miss rewinds through
 * micromark's own `nok` path and the core escape handles the backslash, so the author gets
 * the literal parenthesis.
 * It emits the same token names micromark-extension-math uses (`mathText` /
 * `mathTextSequence` / `mathTextData`), so remark-math's registered from-markdown extension
 * builds the mdast node (value, `data.hChildren`, position); hand-rolling that node
 * produced empty formulas, so only the upstream token contract keeps both halves in sync.
 * Performance: a failing `\(` must not rescan the rest of its line — a line full of `\(`
 * went quadratic (16 KB → ~49 s); the remembered no-closer region makes every later attempt
 * inside it O(1) (see the region checks below).
 * `\[…\]` is not implemented: a display-math node is block-level in mdast while the brackets
 * sit inside a paragraph, so the flow-token machinery would have to apply.
 */
declare module 'micromark-util-types' {
	interface TokenTypeMap {
		mathText: Token;
		mathTextData: Token;
		mathTextSequence: Token;
	}
}

interface NoCloserRegion {
	from: number;
	to: number;
}

function createMathParenSyntax(
	memoryFor: (context: TokenizeContext) => { region: NoCloserRegion | null }
): MicromarkExtension {
	const tokenizeMathParen = function (
		this: TokenizeContext,
		effects: Effects,
		ok: State,
		nok: State
	) {
		const nowOffset = () => this.now().offset;
		const memory = memoryFor(this);
		const startOffset = nowOffset();
		// A previous failing scan on this line already proved there is no closer
		// further along it: skip the rescan entirely.
		if (memory.region && startOffset >= memory.region.from && startOffset <= memory.region.to) {
			return nok;
		}

		// declared before the returned state: a declaration after `return` would
		// never initialise (TDZ)
		let dataOpen = false;
		function openData(): void {
			if (dataOpen) return;
			dataOpen = true;
			effects.enter('mathTextData');
		}

		return function start(code: Code): State | undefined {
			if (code !== codes.backslash) return nok(code);
			effects.enter('mathText');
			effects.enter('mathTextSequence');
			effects.consume(code);
			return afterBackslash;
		};

		function afterBackslash(code: Code): State | undefined {
			if (code !== codes.leftParenthesis) return nok(code);
			effects.consume(code);
			effects.exit('mathTextSequence');
			// mathTextData is entered lazily, on the first content character:
			// micromark asserts data tokens are non-empty, and a failed `\(`
			// must not leave an entered-but-empty one behind
			return inside;
		}

		function inside(code: Code): State | undefined {
			if (code === codes.eof || code === codes.carriageReturn || code === codes.lineFeed) {
				// no closer on this line: remember the region so the rest of the
				// line's candidates fail without scanning, then rewind
				memory.region = { from: startOffset, to: nowOffset() };
				return nok(code);
			}
			if (code === codes.backslash) {
				return effects.attempt(
					{ tokenize: tokenizeCloser as unknown as Tokenizer },
					afterCloser,
					contentBackslash
				)(code);
			}
			openData();
			effects.consume(code);
			return inside;
		}

		function tokenizeCloser(effects2: Effects, ok2: State, nok2: State): State | undefined {
			return function closerStart(code: Code): State | undefined {
				if (code !== codes.backslash) return nok2(code);
				// `\(\)` has no content: not math, fall back to literals
				if (!dataOpen) return nok2(code);
				// close the data token first: the closer sequence is a sibling in
				// the upstream token shape (mathText > sequence, data, sequence)
				effects2.exit('mathTextData');
				effects2.enter('mathTextSequence');
				effects2.consume(code);
				return closerAfterBackslash;
			};
			function closerAfterBackslash(code: Code): State | undefined {
				if (code !== codes.rightParenthesis) return nok2(code);
				effects2.consume(code);
				effects2.exit('mathTextSequence');
				return ok2(code);
			}
		}

		function afterCloser(code: Code): State | undefined {
			effects.exit('mathText');
			// the math was found in this region: forget the old proof
			memory.region = null;
			return ok(code);
		}

		function contentBackslash(code: Code): State | undefined {
			openData();
			effects.consume(code);
			return inside;
		}
	};

	return {
		// the construct must be an object: micromark calls construct.tokenize
		text: { [codes.backslash]: [{ tokenize: tokenizeMathParen as unknown as Tokenizer }] }
	};
}

export const remarkMathParen: Plugin<[], Root> = function () {
	const data = this.data();
	const micromarkExtensions = (data.micromarkExtensions ??= []);
	const memories = new WeakMap<object, { region: NoCloserRegion | null }>();
	micromarkExtensions.push(
		createMathParenSyntax((context) => {
			// the parser object lives per document, so the WeakMap is correct and
			// lifetime-safe
			const parser = context.parser as unknown as object;
			let memory = memories.get(parser);
			if (!memory) {
				memory = { region: null };
				memories.set(parser, memory);
			}
			return memory;
		})
	);
};
