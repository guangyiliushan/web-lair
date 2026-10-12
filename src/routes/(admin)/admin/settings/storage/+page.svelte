<script lang="ts">
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Badge } from '$lib/components/ui/badge';
	import IconX from '@tabler/icons-svelte-runes/icons/x';
	import IconDeviceFloppy from '@tabler/icons-svelte-runes/icons/device-floppy';

	let { data }: PageProps = $props();
	let s = $derived(data.settings);
</script>

<svelte:head>
	<title>{m.admin_settings_storage_title()} - Lair Admin</title>
</svelte:head>

<div class="flex h-full min-h-0 flex-col">
	<header class="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
		<div class="flex min-w-0 items-center gap-2">
			<IconDeviceFloppy class="size-4 shrink-0 text-muted-foreground" />
			<h2 class="truncate text-sm font-semibold">{m.admin_settings_storage()}</h2>
		</div>
		<div class="flex shrink-0 items-center gap-2">
			<Button size="sm">
				<IconDeviceFloppy data-icon="inline-start" />
				{m.admin_common_save()}
			</Button>
		</div>
	</header>

	<div class="min-h-0 flex-1 overflow-auto">
		<div class="space-y-8 p-6">
			<!-- 备份 -->
			<section>
				<h3 class="mb-4 text-sm font-semibold">{m.admin_settings_storage_backup()}</h3>
				<div class="space-y-4 rounded-lg border p-4">
					<!-- autoBackup -->
					<div class="flex items-center justify-between gap-4">
						<label class="text-sm" for="storage-autoBackup"
							>{m.admin_settings_storage_auto_backup()}</label
						>
						<button
							type="button"
							role="switch"
							id="storage-autoBackup"
							aria-checked={Boolean(s.storage.autoBackup)}
							aria-label={m.admin_settings_storage_auto_backup()}
							class="relative inline-flex h-5 min-w-9 items-center rounded-full px-0.5 outline-hidden transition-colors focus-visible:ring-[3px] focus-visible:ring-accent/15"
							class:bg-accent={s.storage.autoBackup}
							class:bg-surface-inset={!s.storage.autoBackup}
						>
							<span
								class="block size-4 rounded-full bg-white shadow-xs transition-transform"
								class:translate-x-4={s.storage.autoBackup}
							></span>
						</button>
					</div>

					<!-- s3Endpoint -->
					<div class="space-y-1.5">
						<label for="storage-s3Endpoint" class="text-sm"
							>{m.admin_settings_storage_backup_s3_endpoint()}</label
						>
						<Input
							id="storage-s3Endpoint"
							bind:value={s.storage.s3Endpoint}
							placeholder="https://s3.amazonaws.com"
						/>
					</div>

					<!-- s3SecretId -->
					<div class="space-y-1.5">
						<label for="storage-s3SecretId" class="text-sm"
							>{m.admin_settings_storage_backup_s3_secret_id()}</label
						>
						<Input
							id="storage-s3SecretId"
							bind:value={s.storage.s3SecretId}
							placeholder="Access Key ID"
						/>
					</div>

					<!-- s3SecretKey -->
					<div class="space-y-1.5">
						<label for="storage-s3SecretKey" class="text-sm"
							>{m.admin_settings_storage_backup_s3_secret_key()}</label
						>
						<Input
							id="storage-s3SecretKey"
							type="password"
							bind:value={s.storage.s3SecretKey}
							placeholder="Secret Access Key"
						/>
					</div>

					<!-- s3Bucket -->
					<div class="space-y-1.5">
						<label for="storage-s3Bucket" class="text-sm"
							>{m.admin_settings_storage_backup_s3_bucket()}</label
						>
						<Input
							id="storage-s3Bucket"
							bind:value={s.storage.s3Bucket}
							placeholder="my-backup-bucket"
						/>
					</div>

					<!-- s3Region -->
					<div class="space-y-1.5">
						<label for="storage-s3Region" class="text-sm"
							>{m.admin_settings_storage_backup_s3_region()}</label
						>
						<Input id="storage-s3Region" bind:value={s.storage.s3Region} placeholder="us-east-1" />
					</div>
				</div>
			</section>

			<!-- 图片存储 -->
			<section>
				<h3 class="mb-4 text-sm font-semibold">{m.admin_settings_storage_images()}</h3>
				<div class="space-y-4 rounded-lg border p-4">
					<!-- s3ImageEnabled -->
					<div class="flex items-center justify-between gap-4">
						<label class="text-sm" for="storage-s3ImageEnabled"
							>{m.admin_settings_storage_s3_enabled()}</label
						>
						<button
							type="button"
							role="switch"
							id="storage-s3ImageEnabled"
							aria-checked={Boolean(s.storage.s3ImageEnabled)}
							aria-label={m.admin_settings_storage_s3_enabled()}
							class="relative inline-flex h-5 min-w-9 items-center rounded-full px-0.5 outline-hidden transition-colors focus-visible:ring-[3px] focus-visible:ring-accent/15"
							class:bg-accent={s.storage.s3ImageEnabled}
							class:bg-surface-inset={!s.storage.s3ImageEnabled}
						>
							<span
								class="block size-4 rounded-full bg-white shadow-xs transition-transform"
								class:translate-x-4={s.storage.s3ImageEnabled}
							></span>
						</button>
					</div>

					<!-- s3ImageEndpoint -->
					<div class="space-y-1.5">
						<label for="storage-s3ImageEndpoint" class="text-sm"
							>{m.admin_settings_storage_s3_endpoint()}</label
						>
						<Input
							id="storage-s3ImageEndpoint"
							bind:value={s.storage.s3ImageEndpoint}
							placeholder="https://s3.amazonaws.com"
						/>
					</div>

					<!-- s3ImageAccessKey -->
					<div class="space-y-1.5">
						<label for="storage-s3ImageAccessKey" class="text-sm"
							>{m.admin_settings_storage_s3_access()}</label
						>
						<Input
							id="storage-s3ImageAccessKey"
							bind:value={s.storage.s3ImageAccessKey}
							placeholder="Access Key"
						/>
					</div>

					<!-- s3ImageSecretKey -->
					<div class="space-y-1.5">
						<label for="storage-s3ImageSecretKey" class="text-sm"
							>{m.admin_settings_storage_s3_secret()}</label
						>
						<Input
							id="storage-s3ImageSecretKey"
							type="password"
							bind:value={s.storage.s3ImageSecretKey}
							placeholder="Secret Key"
						/>
					</div>

					<!-- s3ImageBucket -->
					<div class="space-y-1.5">
						<label for="storage-s3ImageBucket" class="text-sm"
							>{m.admin_settings_storage_s3_bucket()}</label
						>
						<Input
							id="storage-s3ImageBucket"
							bind:value={s.storage.s3ImageBucket}
							placeholder="my-image-bucket"
						/>
					</div>

					<!-- s3ImageRegion -->
					<div class="space-y-1.5">
						<label for="storage-s3ImageRegion" class="text-sm"
							>{m.admin_settings_storage_s3_region()}</label
						>
						<Input
							id="storage-s3ImageRegion"
							bind:value={s.storage.s3ImageRegion}
							placeholder="auto"
						/>
					</div>

					<!-- s3ImageCdn -->
					<div class="space-y-1.5">
						<label for="storage-s3ImageCdn" class="text-sm">{m.admin_settings_storage_cdn()}</label>
						<Input
							id="storage-s3ImageCdn"
							bind:value={s.storage.s3ImageCdn}
							placeholder="https://cdn.example.com"
						/>
					</div>

					<!-- s3ImagePrefix -->
					<div class="space-y-1.5">
						<label for="storage-s3ImagePrefix" class="text-sm"
							>{m.admin_settings_storage_image_prefix()}</label
						>
						<Input
							id="storage-s3ImagePrefix"
							bind:value={s.storage.s3ImagePrefix}
							placeholder="images/"
						/>
					</div>

					<!-- s3CommentPrefix -->
					<div class="space-y-1.5">
						<label for="storage-s3CommentPrefix" class="text-sm"
							>{m.admin_settings_storage_comment_prefix()}</label
						>
						<Input
							id="storage-s3CommentPrefix"
							bind:value={s.storage.s3CommentPrefix}
							placeholder="comments/"
						/>
					</div>
				</div>
			</section>

			<!-- 评论图片上传 -->
			<section>
				<h3 class="mb-4 text-sm font-semibold">{m.admin_settings_storage_comment_upload()}</h3>
				<div class="space-y-4 rounded-lg border p-4">
					<!-- commentUploadEnabled -->
					<div class="flex items-center justify-between gap-4">
						<label class="text-sm" for="storage-commentUploadEnabled"
							>{m.admin_settings_storage_comment_upload_enabled()}</label
						>
						<button
							type="button"
							role="switch"
							id="storage-commentUploadEnabled"
							aria-checked={Boolean(s.storage.commentUploadEnabled)}
							aria-label={m.admin_settings_storage_comment_upload_enabled()}
							class="relative inline-flex h-5 min-w-9 items-center rounded-full px-0.5 outline-hidden transition-colors focus-visible:ring-[3px] focus-visible:ring-accent/15"
							class:bg-accent={s.storage.commentUploadEnabled}
							class:bg-surface-inset={!s.storage.commentUploadEnabled}
						>
							<span
								class="block size-4 rounded-full bg-white shadow-xs transition-transform"
								class:translate-x-4={s.storage.commentUploadEnabled}
							></span>
						</button>
					</div>

					<div class="grid gap-4 sm:grid-cols-2">
						<!-- pendingTtl -->
						<div class="space-y-1.5">
							<label for="storage-pendingTtl" class="text-sm"
								>{m.admin_settings_storage_pending_ttl()}</label
							>
							<Input
								id="storage-pendingTtl"
								type="number"
								bind:value={s.storage.pendingTtl}
								placeholder="120"
							/>
						</div>

						<!-- detachedTtl -->
						<div class="space-y-1.5">
							<label for="storage-detachedTtl" class="text-sm"
								>{m.admin_settings_storage_detached_ttl()}</label
							>
							<Input
								id="storage-detachedTtl"
								type="number"
								bind:value={s.storage.detachedTtl}
								placeholder="30"
							/>
						</div>

						<!-- cleanupInterval -->
						<div class="space-y-1.5">
							<label for="storage-cleanupInterval" class="text-sm"
								>{m.admin_settings_storage_cleanup_interval()}</label
							>
							<Input
								id="storage-cleanupInterval"
								type="number"
								bind:value={s.storage.cleanupInterval}
								placeholder="15"
							/>
						</div>

						<!-- maxImageSize -->
						<div class="space-y-1.5">
							<label for="storage-maxImageSize" class="text-sm"
								>{m.admin_settings_storage_max_image()}</label
							>
							<Input
								id="storage-maxImageSize"
								type="number"
								bind:value={s.storage.maxImageSize}
								placeholder="5"
							/>
						</div>

						<!-- maxImagesPerComment -->
						<div class="space-y-1.5">
							<label for="storage-maxImagesPerComment" class="text-sm"
								>{m.admin_settings_storage_max_per_comment()}</label
							>
							<Input
								id="storage-maxImagesPerComment"
								type="number"
								bind:value={s.storage.maxImagesPerComment}
								placeholder="4"
							/>
						</div>

						<!-- maxUploadsPerHour -->
						<div class="space-y-1.5">
							<label for="storage-maxUploadsPerHour" class="text-sm"
								>{m.admin_settings_storage_max_per_hour()}</label
							>
							<Input
								id="storage-maxUploadsPerHour"
								type="number"
								bind:value={s.storage.maxUploadsPerHour}
								placeholder="10"
							/>
						</div>

						<!-- maxStoragePerReader -->
						<div class="space-y-1.5">
							<label for="storage-maxStoragePerReader" class="text-sm"
								>{m.admin_settings_storage_max_per_reader()}</label
							>
							<Input
								id="storage-maxStoragePerReader"
								type="number"
								bind:value={s.storage.maxStoragePerReader}
								placeholder="50"
							/>
						</div>

						<!-- minAccountAge -->
						<div class="space-y-1.5">
							<label for="storage-minAccountAge" class="text-sm"
								>{m.admin_settings_storage_min_age()}</label
							>
							<Input
								id="storage-minAccountAge"
								type="number"
								bind:value={s.storage.minAccountAge}
								placeholder="0"
							/>
						</div>

						<!-- minCommentsPosted -->
						<div class="space-y-1.5">
							<label for="storage-minCommentsPosted" class="text-sm"
								>{m.admin_settings_storage_min_comments()}</label
							>
							<Input
								id="storage-minCommentsPosted"
								type="number"
								bind:value={s.storage.minCommentsPosted}
								placeholder="0"
							/>
						</div>
					</div>

					<!-- deleteSpamImages -->
					<div class="flex items-center justify-between gap-4">
						<label class="text-sm" for="storage-deleteSpamImages"
							>{m.admin_settings_storage_delete_spam()}</label
						>
						<button
							type="button"
							role="switch"
							id="storage-deleteSpamImages"
							aria-checked={Boolean(s.storage.deleteSpamImages)}
							aria-label={m.admin_settings_storage_delete_spam()}
							class="relative inline-flex h-5 min-w-9 items-center rounded-full px-0.5 outline-hidden transition-colors focus-visible:ring-[3px] focus-visible:ring-accent/15"
							class:bg-accent={s.storage.deleteSpamImages}
							class:bg-surface-inset={!s.storage.deleteSpamImages}
						>
							<span
								class="block size-4 rounded-full bg-white shadow-xs transition-transform"
								class:translate-x-4={s.storage.deleteSpamImages}
							></span>
						</button>
					</div>

					<!-- mimeWhitelist -->
					<div class="space-y-2">
						<span class="text-sm">{m.admin_settings_storage_mime()}</span>
						<div class="flex flex-wrap gap-1.5">
							{#each s.storage.mimeWhitelist as mime (mime)}
								<Badge variant="secondary">
									{mime}
									<button
										type="button"
										class="ml-0.5 rounded-full p-0.5 hover:bg-muted-foreground/20"
										aria-label={m.admin_settings_storage_remove_mime({ mime: mime })}
									>
										<IconX class="size-3" />
									</button>
								</Badge>
							{/each}
						</div>
					</div>
				</div>
			</section>
		</div>
	</div>
</div>
