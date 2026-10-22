<script lang="ts">
	import * as FileDropzone from './index';

	/**
	 * Spec fixture: the same composition the media upload dialog uses, with the
	 * callback wired to a DOM sink so the spec can read what the dropzone emitted.
	 */
	let {
		accept = '',
		disabled = false,
		multiple = true
	}: { accept?: string; disabled?: boolean; multiple?: boolean } = $props();

	let emitted = $state<string>('');

	function onFiles(files: File[]): void {
		emitted = files.map((file) => file.name).join(',');
	}
</script>

<FileDropzone.Root {accept} {multiple} {disabled} ariaLabel="Spec dropzone" {onFiles}>
	<FileDropzone.Icon>icon</FileDropzone.Icon>
	<FileDropzone.Prompt>Drop files here</FileDropzone.Prompt>
	<FileDropzone.Hint>or click to browse</FileDropzone.Hint>
</FileDropzone.Root>

<p data-testid="emitted">{emitted}</p>
