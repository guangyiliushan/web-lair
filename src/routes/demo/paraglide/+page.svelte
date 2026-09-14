<script lang="ts">
	import { setLocale } from '$lib/paraglide/runtime';
</script>

<div>
	<button onclick={() => setLocale('en')}>en</button>
	<button onclick={() => setLocale('zh-cn')}>zh-cn</button>
	<button onclick={() => setLocale('ja')}>ja</button>
</div>

<p>
	If you use VSCode, install the

	<a
		href="https://marketplace.visualstudio.com/items?itemName=inlang.vs-code-extension"
		target="_blank">Sherlock i18n extension</a
	>

	for a better i18n experience.
</p>
