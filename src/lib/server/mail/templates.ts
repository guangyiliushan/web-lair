/**
 * Plain-text mail templates (deploy batch D-2, Q9: no HTML template engine).
 * Three site languages; unknown languages fall back to English.
 */

export type MailLang = 'en' | 'zh-cn' | 'ja';

export interface RenderedMail {
	subject: string;
	text: string;
}

export function isMailLang(value: string): value is MailLang {
	return value === 'en' || value === 'zh-cn' || value === 'ja';
}

export function verifyEmailMail(lang: MailLang, url: string): RenderedMail {
	switch (lang) {
		case 'zh-cn':
			return {
				subject: '验证你的邮箱地址',
				text: `请打开下面的链接验证你的邮箱地址：\n\n${url}\n\n链接 1 小时内有效。如果这不是你本人的操作，忽略本邮件即可。\n`
			};
		case 'ja':
			return {
				subject: 'メールアドレスの確認',
				text: `以下のリンクを開いてメールアドレスを確認してください。\n\n${url}\n\nリンクの有効期限は 1 時間です。心当たりがない場合はこのメールを破棄してください。\n`
			};
		default:
			return {
				subject: 'Confirm your email address',
				text: `Open the link below to confirm your email address:\n\n${url}\n\nThe link expires in 1 hour. If you did not request this, ignore this email.\n`
			};
	}
}

export function resetPasswordMail(lang: MailLang, url: string): RenderedMail {
	switch (lang) {
		case 'zh-cn':
			return {
				subject: '重置密码',
				text: `请打开下面的链接重置密码：\n\n${url}\n\n如果这不是你本人的操作，忽略本邮件即可。\n`
			};
		case 'ja':
			return {
				subject: 'パスワードのリセット',
				text: `以下のリンクを開いてパスワードを再設定してください。\n\n${url}\n\n心当たりがない場合はこのメールを破棄してください。\n`
			};
		default:
			return {
				subject: 'Reset your password',
				text: `Open the link below to reset your password:\n\n${url}\n\nIf you did not request this, ignore this email.\n`
			};
	}
}

export function subscriptionConfirmMail(
	lang: MailLang,
	url: string,
	unsubscribeUrl: string
): RenderedMail {
	switch (lang) {
		case 'zh-cn':
			return {
				subject: '确认订阅',
				text: `请打开下面的链接确认订阅：\n\n${url}\n\n如果这不是你本人的操作，忽略本邮件即可，地址不会被加入名单。\n如要彻底阻止该地址接收邮件：\n${unsubscribeUrl}\n`
			};
		case 'ja':
			return {
				subject: '購読の確認',
				text: `以下のリンクを開いて購読を確定してください。\n\n${url}\n\n心当たりがない場合はこのメールを破棄してください。アドレスは登録されません。\n今後このアドレスへの配信を完全に止める場合：\n${unsubscribeUrl}\n`
			};
		default:
			return {
				subject: 'Confirm your subscription',
				text: `Open the link below to confirm your subscription:\n\n${url}\n\nIf you did not request this, ignore this email — the address stays off the list.\nTo block this address permanently:\n${unsubscribeUrl}\n`
			};
	}
}
