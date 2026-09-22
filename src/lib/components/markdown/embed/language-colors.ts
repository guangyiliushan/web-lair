/**
 * Static linguist language colours (batch 2b).
 *
 * GitHub's language dots/borders come from the github-linguist colour map —
 * a static dataset, not per-repo API data. Vendoring the common subset here
 * keeps the repo-card tint a *zero-request* enhancement (spec 6): the colour
 * arrives with the metadata projection or not at all, and unknown languages
 * simply fall back to the neutral card. Source: linguist languages.yml
 * (github-linguist/linguist, `languages.yml` `color:` field).
 */
const LINGUIST_COLORS: Record<string, string> = {
	TypeScript: '#3178c6',
	JavaScript: '#f1e05a',
	'JavaScript+ERB': '#f1e05a',
	Python: '#3572A5',
	Java: '#b07219',
	Go: '#00ADD8',
	Rust: '#dea584',
	C: '#555555',
	'C++': '#f34b7d',
	'C#': '#178600',
	Ruby: '#701516',
	PHP: '#4F5D95',
	Swift: '#F05138',
	Kotlin: '#A97BFF',
	Dart: '#00B4AB',
	Scala: '#c22d40',
	Elixir: '#6e4a7e',
	Erlang: '#B83998',
	Haskell: '#5e5086',
	Lua: '#000080',
	Perl: '#0298c3',
	R: '#198CE7',
	MATLAB: '#e16737',
	'Objective-C': '#438eff',
	OCaml: '#3be133',
	Zig: '#ec915c',
	Nim: '#ffc200',
	Julia: '#a270ba',
	Clojure: '#db5855',
	'F#': '#b845fc',
	Groovy: '#4298b8',
	Svelte: '#ff3e00',
	Vue: '#41b883',
	HTML: '#e34c26',
	CSS: '#563d7c',
	SCSS: '#c6538c',
	Less: '#1d365d',
	Shell: '#89e051',
	PowerShell: '#012456',
	Batchfile: '#C1F12E',
	Dockerfile: '#384d54',
	Makefile: '#427819',
	CMake: '#DA3434',
	Nix: '#7e7eff',
	SQL: '#e38c00',
	PLSQL: '#dad8d8',
	TSQL: '#e38c00',
	'Vim Script': '#199f4b',
	'Emacs Lisp': '#c065db',
	'Common Lisp': '#3fb68b',
	Assembly: '#6E4C13',
	Wasm: '#04133b',
	Solidity: '#AA6746',
	MDX: '#fcb32c',
	Markdown: '#083fa1',
	TeX: '#3D6117',
	Jupyter: '#DA5B0B',
	'Jupyter Notebook': '#DA5B0B',
	CoffeeScript: '#244776',
	ActionScript: '#882B0F',
	'Objective-C++': '#6866fb',
	'Visual Basic': '#945db7',
	HCL: '#844FBA',
	Terraform: '#844FBA',
	Haxe: '#df7900',
	Crystal: '#000100',
	D: '#ba595e',
	Fortran: '#4d41b1',
	CUDA: '#3f4d87',
	'Protocol Buffer': '#e09f6c',
	Roff: '#ecdebe'
};

/** Case-insensitive lookup with an exact-pass first (linguist casing wins). */
export function languageColor(name: string | undefined): string | null {
	if (!name) return null;
	if (LINGUIST_COLORS[name]) return LINGUIST_COLORS[name];
	const hit = Object.entries(LINGUIST_COLORS).find(
		([key]) => key.toLowerCase() === name.toLowerCase()
	);
	return hit ? hit[1] : null;
}
