#!/usr/bin/env bash
# 渲染 Gatus 配置目录：核心 gatus.yaml（含常驻 Bark 配置）+ 三个可选片段。
#
# 用法:
#   bash deploy/monitoring/render-config.sh <out-dir>
#
# 输入（全部可选，空 = 不渲染对应片段）：
#   SITE_DOMAIN           站点域名                          → zz-domain.yaml
#   DRAIN_HEARTBEAT_TOKEN drain 心跳 Bearer token            → zz-drain.yaml
#   READY_TOKEN           /api/ready Bearer token            → zz-app-ready.yaml
#   BARK_URL              不参与渲染（常驻 gatus.yaml 的 ${BARK_URL}）；这里只做告警提示
#
# 输出目录就是 GATUS_CONFIG_PATH 指向的目录；脚本只管理 gatus.yaml 与 zz-*.yaml，
# 不碰别的文件。
#
# **内容幂等**：只有内容变化时才写文件，保持 mtime 不变。Gatus 每 30s 轮询配置目录的
# mtime，任何写入都会触发 stop → store.Close → initializeStorage(memory) → start，
# 即清空监控历史与“已触发告警”状态（重复告警、收不到 RESOLVED）。所以这个脚本会被
# 高频调用（每次 up/create，以及可能的并行会话），必须做到无变化不触盘。
#
# 生产入口 deploy/compose-prod.sh 只在 up/create 前调用本脚本；本地校验用
# deploy/monitoring/verify-config.sh（自己渲染到临时目录）。
set -euo pipefail

# Deterministic permissions: under `umask 000` (service managers, some CI) the
# rendered config would otherwise be world-writable, letting any local user
# retarget the alerting or add internal probes (review P2-4). 022 keeps the
# directory readable by the Gatus container without write access.
umask 022

usage() {
	echo "usage: bash $0 <out-dir>" >&2
	exit 2
}

[ $# -eq 1 ] && [ -n "${1:-}" ] || usage

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
OUT=$1

install_if_changed() {
	# $1 = source, $2 = destination, $3 = label
	if [ -f "$2" ] && cmp -s "$1" "$2"; then
		printf '[render-config] = %s (unchanged)\n' "$3"
	else
		# Atomic replace: Gatus watches this directory and reloads within ~30s.
		# `cp` in place truncates the target first, so a reload landing mid-copy
		# would read a half file and (with restart: always) crash-loop
		# (review P2-1).
		local tmp
		tmp=$(mktemp "$2.tmp.XXXXXX")
		cp "$1" "$tmp"
		mv "$tmp" "$2"
		printf '[render-config] + %s\n' "$3"
	fi
}

fail() {
	printf '[render-config] %s\n' "$*" >&2
	exit 1
}

# 值会进入单引号 YAML 标量并被 Gatus 的 os.ExpandEnv 展开，所以字符集必须收窄：
# 空白/引号/反斜杠/换行/`$` 都能改变结构或触发意外展开。
validate_token() {
	case "$1" in
	*[!A-Za-z0-9._~+/=-]*) fail "$2 must be a token of [A-Za-z0-9._~+/=-] (got invalid characters)" ;;
	esac
	# The drain token can forge a heartbeat and suppress the alarm; a short one
	# is guessable (review P2-6).
	if [ "${#1}" -lt 16 ]; then
		fail "$2 must be at least 16 characters (use 'openssl rand -hex 32')"
	fi
}

validate_domain() {
	case "$1" in
	*[!A-Za-z0-9.-]*) fail "SITE_DOMAIN must be a plain hostname (A-Z a-z 0-9 . -)" ;;
	.* | *. | *..*) fail "SITE_DOMAIN is not a valid hostname: $1" ;;
	esac
}

# BARK_URL 会进入单引号 YAML 标量（Gatus 在解析前做 os.ExpandEnv），所以：
# - 只接受 https（device key 在路径里，http 等于明文泄密）；
# - 拒绝空白/引号/反斜杠/$（会跳出标量或触发意外展开）。
# 本地 mock 用 http，必须显式 BARK_ALLOW_INSECURE=1（只允许出现在 mock 脚本里）。
validate_bark_url() {
	local lower
	lower=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
	case "$lower" in
	https://*) ;;
	http://*)
		[ "${BARK_ALLOW_INSECURE:-}" = 1 ] ||
			fail 'BARK_URL must be https:// (BARK_ALLOW_INSECURE=1 is for the local mock only)'
		;;
	*) fail 'BARK_URL must start with https://' ;;
	esac
	if printf '%s' "$1" | grep -qE "[[:space:]'\"\$\\\\]"; then
		fail 'BARK_URL contains whitespace/quote/backslash characters that would corrupt the Gatus YAML scalar'
	fi
	# A malformed percent escape makes http.NewRequest fail; Gatus' custom
	# provider then dereferences a nil request and panics on the next alert
	# (review P2-2). Count valid escapes against all '%' occurrences.
	local all valid
	all=$(printf '%s' "$1" | tr -cd '%' | wc -c | tr -d ' ')
	valid=$(printf '%s' "$1" | { grep -oE '%[0-9A-Fa-f]{2}' || true; } | wc -l | tr -d ' ')
	if [ "$all" != "$valid" ]; then
		fail 'BARK_URL contains a malformed percent escape (only %HH is allowed)'
	fi
}

# 先校验所有输入，再动输出目录：校验失败时磁盘保持上一轮的一致状态
# （否则会出现“新核心 + 旧片段”的半更新目录，被 Gatus 30s 后热重载到）。
SITE_DOMAIN_VALUE=${SITE_DOMAIN:-}
DRAIN_TOKEN_VALUE=${DRAIN_HEARTBEAT_TOKEN:-}
BARK_URL_VALUE=${BARK_URL:-}
READY_TOKEN_VALUE=${READY_TOKEN:-}

if [ -n "$SITE_DOMAIN_VALUE" ]; then
	# 允许 FQDN 尾点（example.com. 是合法主机名，dig 输出常见），校验时去掉一个。
	validate_domain "${SITE_DOMAIN_VALUE%.}"
fi
[ -n "$DRAIN_TOKEN_VALUE" ] && validate_token "$DRAIN_TOKEN_VALUE" DRAIN_HEARTBEAT_TOKEN
[ -n "$READY_TOKEN_VALUE" ] && validate_token "$READY_TOKEN_VALUE" READY_TOKEN
[ -n "$BARK_URL_VALUE" ] && validate_bark_url "$BARK_URL_VALUE"

mkdir -p "$OUT"

# Gatus 的热重载只比较**已存在文件**的 mtime（删除文件不会触发），所以片段被撤下
# 时要主动 touch 一次核心文件，让运行中的实例感知“某个端点消失了”。
CHANGED=0

# 升级清理：旧布局曾把 Bark 放进片段；合并进 gatus.yaml 后，残留的 zz-bark.yaml
# 会与主文件的 alerting.custom 冲突（primitive 重复定义 → 解析失败）。
if [ -e "$OUT/zz-bark.yaml" ]; then
	rm -f "$OUT/zz-bark.yaml"
	CHANGED=1
fi

install_if_changed "$HERE/gatus.yaml" "$OUT/gatus.yaml" 'core: gatus.yaml'

if [ -n "$SITE_DOMAIN_VALUE" ]; then
	install_if_changed "$HERE/fragments/domain.yaml" "$OUT/zz-domain.yaml" 'zz-domain.yaml (SITE_DOMAIN set)'
else
	if [ -e "$OUT/zz-domain.yaml" ]; then
		rm -f "$OUT/zz-domain.yaml"
		CHANGED=1
	fi
	printf '[render-config] - domain: SITE_DOMAIN unset, TLS/domain checks skipped\n'
fi

if [ -n "$DRAIN_TOKEN_VALUE" ]; then
	install_if_changed "$HERE/fragments/drain.yaml" "$OUT/zz-drain.yaml" 'zz-drain.yaml (drain heartbeat enabled)'
else
	if [ -e "$OUT/zz-drain.yaml" ]; then
		rm -f "$OUT/zz-drain.yaml"
		CHANGED=1
	fi
	printf '[render-config] - drain: DRAIN_HEARTBEAT_TOKEN unset, heartbeat endpoint skipped\n'
fi

# /api/ready：P4 的端点只在带 READY_TOKEN 时应答（生产无 token → 对所有来源 404，
# Gatus 在 compose 私网里不是 loopback）。无条件启用会永久红，所以按 token 是否
# 配置决定渲染，与 domain/drain 同一口径。
if [ -n "$READY_TOKEN_VALUE" ]; then
	install_if_changed "$HERE/fragments/app-ready.yaml" "$OUT/zz-app-ready.yaml" 'zz-app-ready.yaml (ready probe enabled)'
else
	if [ -e "$OUT/zz-app-ready.yaml" ]; then
		rm -f "$OUT/zz-app-ready.yaml"
		CHANGED=1
	fi
	printf '[render-config] - ready: READY_TOKEN unset, /api/ready monitor skipped\n'
fi

if [ "$CHANGED" = 1 ] && [ -f "$OUT/gatus.yaml" ]; then
	touch "$OUT/gatus.yaml"
	printf '[render-config] ~ touched gatus.yaml so Gatus notices the removed fragment(s)\n'
fi

if [ -z "$BARK_URL_VALUE" ]; then
	printf '[render-config] - bark: BARK_URL unset, alerts are log-only (provider ignored by Gatus)\n'
fi
