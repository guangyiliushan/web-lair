<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import IconMailForward from '@tabler/icons-svelte-runes/icons/mail-forward';
	import { m } from '$lib/paraglide/messages';
</script>

<div class="flex w-full flex-col items-center justify-center">
	<Card.Root class="w-full max-w-md text-center">
		<Card.Header>
			<Card.Title class="text-2xl">{m.auth_verify_title()}</Card.Title>
			<Card.Description>
				{m.auth_verify_description()}
			</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col items-center gap-4">
			<IconMailForward class="size-12 text-muted-foreground" />
			<p class="text-sm text-muted-foreground">
				{m.auth_verify_spam_hint()}
			</p>
		</Card.Content>
		<Card.Footer class="justify-center">
			<a href="/login">
				<Button variant="outline">{m.auth_back_to_login()}</Button>
			</a>
		</Card.Footer>
	</Card.Root>
</div>
