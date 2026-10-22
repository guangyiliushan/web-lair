import Hint from './file-dropzone-hint.svelte';
import Icon from './file-dropzone-icon.svelte';
import Prompt from './file-dropzone-prompt.svelte';
import Root, { fileDropzoneVariants, type FileDropzoneState } from './file-dropzone.svelte';

export {
	Root,
	Icon,
	Prompt,
	Hint,
	fileDropzoneVariants,
	type FileDropzoneState,
	//
	Root as FileDropzone,
	Icon as FileDropzoneIcon,
	Prompt as FileDropzonePrompt,
	Hint as FileDropzoneHint
};
