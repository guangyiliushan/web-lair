import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async () => {
	return {
		headerTitle: '设定',
		settings: {
			user: {
				nickname: 'test',
				username: 'test',
				email: 'test@test.com',
				avatar: 'https://cravatar.cn/avatar/b642b4217b34b1e8d3bd915fc65c4452?d=retro',
				site: '',
				bio: '',
				lastLogin: '2026/07/17 11:11'
			},
			site: {
				frontendUrl: 'http://localhost:2323',
				adminUrl: 'http://localhost:2333/proxy/qaqdmin',
				apiUrl: 'http://localhost:2333',
				gatewayUrl: 'http://localhost:2333',
				title: 'My Little World',
				description: 'Hi, welcome!',
				lightIcon: '',
				darkIcon: '',
				keywords: [] as string[]
			},
			content: {
				antiSpam: false,
				aiReview: false,
				aiReviewMode: 'binary',
				aiReviewThreshold: 5,
				disableComments: false,
				allowAnonymousComments: true,
				blockedKeywords: [] as string[],
				blockedIps: [] as string[],
				rejectNonChinese: false,
				onlyApproved: false,
				showCommentLocation: true,
				allowFriendApps: true,
				allowSubPathFriends: false,
				internalizeAvatars: true
			},
			notification: {
				emailEnabled: false,
				emailProvider: 'smtp',
				senderEmail: '',
				smtpUser: '',
				smtpPass: '',
				smtpHost: '',
				smtpPort: '',
				smtpTls: false,
				rateLimit: 10,
				retryCount: 3,
				barkEnabled: false,
				barkKey: '',
				barkServer: 'https://api.day.app',
				barkCommentNotify: true,
				barkRateLimitNotify: false
			},
			search: {
				baiduEnabled: false,
				baiduToken: '',
				bingEnabled: false,
				bingApiKey: ''
			},
			storage: {
				autoBackup: true,
				s3Endpoint: '',
				s3SecretId: '',
				s3SecretKey: '',
				s3Bucket: '',
				s3Region: '',
				s3ImageEnabled: false,
				s3ImageEndpoint: '',
				s3ImageAccessKey: '',
				s3ImageSecretKey: '',
				s3ImageBucket: '',
				s3ImageRegion: 'auto',
				s3ImageCdn: '',
				s3ImagePrefix: '',
				s3CommentPrefix: '',
				commentUploadEnabled: true,
				pendingTtl: 120,
				detachedTtl: 30,
				cleanupInterval: 15,
				maxImageSize: 5,
				maxImagesPerComment: 4,
				maxUploadsPerHour: 10,
				maxStoragePerReader: 50,
				minAccountAge: 0,
				minCommentsPosted: 0,
				deleteSpamImages: true,
				mimeWhitelist: ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
			},
			integrations: {
				github: { enabled: true, token: '' },
				tmdb: { enabled: false, apiKey: '' },
				bangumi: { enabled: true, token: '' },
				neodb: { enabled: true },
				arxiv: { enabled: true },
				leetcode: { enabled: true },
				neteaseMusic: { enabled: true },
				qqMusic: { enabled: true },
				ogFallback: { enabled: true, fetchMode: 'fetch', timeout: 8000, maxSize: 524288 },
				screenshot: {
					enabled: false,
					maxCached: 500,
					maxStorage: 104857600,
					maxImageSize: 524288,
					webpQuality: 75
				},
				twelveData: { enabled: false, apiKey: '' },
				polygon: { enabled: false, apiKey: '' }
			},
			system: {
				adminProxy: true,
				loginBg: '',
				amapKey: '',
				emailSubscription: false
			},
			account: {
				github: {
					enabled: false,
					clientId: '',
					clientSecret: '',
					callbackUrl: 'http://127.0.0.1:2333/api/v3/auth/callback/github'
				},
				google: {
					enabled: false,
					clientId: '',
					clientSecret: '',
					callbackUrl: 'http://127.0.0.1:2333/api/v3/auth/callback/google'
				}
			},
			metaPreset: [
				{
					key: 'aiGen',
					label: 'AI Involvement Disclosure',
					type: 'checkbox',
					scope: '通用',
					builtin: true,
					enabled: true,
					description: 'Declare how much AI was involved during creation'
				},
				{
					key: 'cover',
					label: 'Cover image',
					type: 'url',
					scope: '通用',
					builtin: true,
					enabled: true
				},
				{
					key: 'banner',
					label: 'Banner',
					type: 'object',
					scope: '通用',
					builtin: true,
					enabled: true,
					description: 'Notice banner displayed at the top of an article'
				},
				{
					key: 'keywords',
					label: 'SEO keywords',
					type: 'tags',
					scope: '通用',
					builtin: true,
					enabled: true
				},
				{
					key: 'style',
					label: 'Article style',
					type: 'text',
					scope: '通用',
					builtin: true,
					enabled: true
				}
			]
		}
	};
};

export const actions = {} satisfies Actions;
