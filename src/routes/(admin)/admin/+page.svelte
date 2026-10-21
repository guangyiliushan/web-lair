<script lang="ts">
	import { m } from '$lib/paraglide/messages';
</script>

<!-- The server load always redirects; this is the no-redirect fallback. -->
<div class="flex min-h-[40vh] items-center justify-center">
	<a class="text-sm text-muted-foreground underline" href="/admin/dashboard">
		{m.admin_nav_dashboard()}
	</a>
</div>
