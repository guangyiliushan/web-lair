# Gatus 监控（箱内）

M6 P3 的监控层：Gatus 在箱子**里面**跑，负责“部分故障”（应用路由坏、PG/RustFS
端口死、证书/域名将过期、drain 停跑）。整机/线路全灭只能由箱外的 healthchecks
发现——两层不可互相替代（plan §3.3 判据 C1）。

## 1. 文件

| 文件                       | 作用                                                                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gatus.yaml`               | 核心配置，永远加载：HTTP `/`、`/zh-cn/posts`、`/sitemap.xml`、`/admin`（303）、TCP PG/RustFS、Bark 告警块（`/api/ready` 在片段里，见下一行）         |
| `fragments/domain.yaml`    | TLS 证书 + 域名到期，仅当 `SITE_DOMAIN` 非空时渲染                                                                                                   |
| `fragments/drain.yaml`     | drain 心跳 external endpoint（**30m** 无心跳即告警，窗口须覆盖最长 tick），仅当 `DRAIN_HEARTBEAT_TOKEN` 非空时渲染                                   |
| `fragments/app-ready.yaml` | `/api/ready` 就绪探针（Bearer），**仅当 `READY_TOKEN` 非空时渲染**：生产无 token 时该路由对所有来源 404，常驻核心配置会永久红（P4 合入后从核心移出） |
| `render-config.sh`         | 把核心 + 片段装进 `conf.d/`（gitignored）。**内容幂等**（`cmp` 后才写）：Gatus 每 30s 按 mtime 热重载，无变化写入会清空内存状态与已触发告警          |
| `verify-config.sh`         | 启动校验（T3.5）：核心 / 全量 / 两个负例 / 硬化参数，五条断言（含 app-ready 双向）                                                                   |
| `compose.monitoring.yaml`  | 生产 overlay：pin 镜像、`127.0.0.1:8080`、`internal`+`edge`、`read_only`、无 `depends_on: app`                                                       |

为什么只有这三个需要片段：空 `SITE_DOMAIN` 会得到 `https:///` 永久红端点；external
endpoint 的空 token 会被 Gatus 直接拒绝（panic）；`/api/ready` 在无 `READY_TOKEN` 的
生产部署里对所有来源 404（永远红）。而 `alerting.custom.url` 为空只会 Warn 并忽略
provider，所以 Bark 配置常驻 `gatus.yaml`——**渲染门控与容器 env 不会分歧成“片段没
渲染但容器有值”的静默失联**。
**P0 注意**：片段里保留字面量 `${SITE_DOMAIN}`，由 **Gatus 容器自己的 env** 展开。
`deploy/compose-prod.sh` 在 `SITE_DOMAIN` 为空而 `DOMAIN` 有值时会继承后者，并把解析
结果 **export 给 compose**；否则渲染出来的片段会被展开成 `https:///`，Gatus 校验失败
exit 2 → `restart: always` 崩溃循环，而 `up -d` 仍返回 0（监控静默全灭）。

`deploy/compose-prod.sh` 已是三文件入口，且只在 **`up` / `create`** 前调用
`render-config.sh`（这两个命令会重建容器，配置与 env 一起更新；`restart` / `start`
不重建容器，`run` 被 drain 定时器每分钟调用，渲染会触发无意义热重载）。渲染失败
即中止部署（不会用空 `/config` 起一个“绿着但没监控”的容器）。

## 2. 监控清单

| name               | 类型     | 目标                         | 条件                                                                                    |
| ------------------ | -------- | ---------------------------- | --------------------------------------------------------------------------------------- |
| `site-home`        | HTTP     | `http://$MONITOR_APP_ADDR/`  | 200，`< 3000ms`                                                                         |
| `site-posts-zh`    | HTTP     | `/zh-cn/posts`               | 200                                                                                     |
| `site-sitemap`     | HTTP     | `/sitemap.xml`               | 200                                                                                     |
| `site-admin-guard` | HTTP     | `/admin`                     | **303**（未登录必须跳登录页；`ignore-redirect: true`，否则跟随到登录页会看到 200）      |
| `pg-tcp`           | TCP      | `tcp://$MONITOR_PG_ADDR`     | `[CONNECTED]`                                                                           |
| `rustfs-tcp`       | TCP      | `tcp://$MONITOR_RUSTFS_ADDR` | `[CONNECTED]`                                                                           |
| `app-ready`        | HTTP     | `/api/ready` + Bearer        | 200 且 `status == ready`；**仅在 `READY_TOKEN` 非空时渲染**（片段门控，见 §1）          |
| `site-tls`         | HTTPS    | `https://$SITE_DOMAIN/`      | 200 且证书 > 720h（间隔 5m / 失败 2 次，**硬编码在片段里**）                            |
| `domain-expiry`    | HTTPS    | `https://$SITE_DOMAIN/`      | `[DOMAIN_EXPIRATION] > 336h`（12h 一次，硬编码；Gatus 要求 ≥5m）                        |
| `jobs-drain`       | external | 由 drain 推 `?success=true`  | **30m** 内无推送即告警（心跳窗须覆盖最长 tick：job timeout 15m）；**当前未接线**，见 §8 |

HTTP/TCP（含 `app-ready`）的间隔与阈值来自 `MONITOR_INTERVAL`（默认 `30s`）、
`MONITOR_FAILURE_THRESHOLD`（默认 `3`）、`MONITOR_SUCCESS_THRESHOLD`（默认 `2`）；
默认值下故障确认约 90s。**domain 两项不吃这三个变量**——阈值写在
`fragments/domain.yaml` 里，要改证书窗口就改文件。

直连 `app:3000` 而不是公网域名：Caddy/证书/DNS 由 `site-tls` 覆盖，箱内检查只回答
“应用进程还能不能正确响应路由”。`/api/ready` 必须走 internal：`deploy/Caddyfile`
已有 `respond /api/ready* 404`（P4 落地）并把该路径加入 `log_skip`（URI 里有 Bearer，
不能进访问日志）；Gatus 的 `app-ready` 只在同目录里存在私网调用，不经过公网边缘。

## 3. 部署

```bash
# 生产（compose-prod.sh 在 up/create 前自动渲染 conf.d，并校验 BARK_URL 必须是 https）
deploy/compose-prod.sh up -d gatus

# 手动/排障：同样的三文件组合，但必须先渲染（conf.d 被 gitignore，新机器上不存在）
bash deploy/monitoring/render-config.sh deploy/monitoring/conf.d
docker compose --project-directory . -f compose.yaml -f compose.prod.yaml \
  -f deploy/monitoring/compose.monitoring.yaml up -d gatus
```

UI 只绑宿主 `127.0.0.1:8080`（无鉴权）：用 SSH 隧道访问，不要开公网（`tailscale serve`
不在本批范围——裸 loopback 绑定对 tailnet 对端不可达）。注意这只隔离公网——Gatus
同时挂在 `internal` + `edge`，容器之间仍可直连 `gatus:8080`（app 与它同网），所以也别
把它当成仅本机可达。

手工路径同样要跑 `render-config.sh`：监控 env 的全部校验（`BARK_URL` scheme/字符集、
`SITE_DOMAIN`、drain token、`READY_TOKEN`）都在那个脚本里，它是唯一入口；绕过它直接
`docker compose up` 会用上一轮残留的 `conf.d`。

改了 `.env` 里的监控变量后必须 `up -d`（重建容器才会拿到新 env）；`restart` 不重建
容器，旧 env 会继续生效。

回滚：停掉 `gatus` 容器即可；Kuma 容器与 `kuma_data` 卷在切换前**不动**（见 §9）。

## 4. 告警：Bark

`gatus.yaml` 的 `alerting.custom` 用 Gatus 的 custom provider POST 到 `BARK_URL`。
payload 只有三个字段：

```json
{ "title": "TRIGGERED web-lair", "body": "site-home — 首页不可用", "group": "web-lair" }
```

- `[ALERT_TRIGGERED_OR_RESOLVED]` → `TRIGGERED` / `RESOLVED`（恢复通知，`send-on-resolved: true`）
- 不含端点 URL、错误堆栈、任何 token、访问者 IP 或页面内容。
- **URL 形式只有一种**：`https://<bark-server>/<DEVICE_KEY>`（key 在路径里）。
  Bark 的 `POST /push` 需要在 body 里带 `device_key`，本配置的 body 没有这个字段，
  所以不要写成 `.../push`。`BARK_URL` 必须是 `https://` 且不含空白/引号/反斜杠/`$`：
  这些校验在 `render-config.sh`（唯一入口，`up`/`create` 与文档里的手工路径都会跑）；
  本地 mock 用 http 时脚本必须显式设 `BARK_ALLOW_INSECURE=1`，生产不要设。
- **日志会带 key**：Gatus 发送失败时把 Go `url.Error` 打进容器日志，形如
  `Post "https://api.day.app/<KEY>": ...`。所以 `docker logs gatus` 按凭据处理——
  不要原样粘贴到 issue/notes；必要时先
  `sed -E 's#(https?://[^/]+/)[A-Za-z0-9]+#\1<redacted>#g'`。
- **未设置 `BARK_URL`** = provider 被忽略（启动日志一行 `Ignoring provider=custom`）；
  检查照跑、状态照记，**不发送**。
- 一次故障按**失败端点各发一条**：全部端点同时挂（如整机网络）默认 6 条，设
  `SITE_DOMAIN` 后 8 条，配 `READY_TOKEN` 后 9 条，再接 drain 后 10 条；典型的应用故障
  只命中 4–5 条（HTTP 路由 + 可能的 TLS），TCP 两项仍是绿的。Gatus 不做跨端点去重；默认没有提醒重发
  （`minimum-reminder-interval` 未设）。如果实际太吵，先删掉冗余端点的 `alerts`
  （sitemap / posts 这类可从 UI 看），不要为此再加一层网关。

邮件兜底未在 P3 实现（Gatus email provider 需要 SMTP 凭据，属 P5/P7）；
当前单通道，`BARK_URL` 未配置时等于“只有 UI”。

## 5. 需要设置/替换的环境变量

写在 `.env`（`chmod 600`），`.env.example` 有同名占位：

| 变量                        | 必填         | 未设置时          | 说明                                                                                                                                       |
| --------------------------- | ------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `BARK_URL`                  | 上线后       | 只记日志          | `https://<bark>/<DEVICE_KEY>`；**secret**，且会出现在 docker inspect / compose config / gatus 日志里                                       |
| `SITE_DOMAIN`               | 有域名后     | 跳过 TLS/域名检查 | 纯主机名，无 scheme；为空而 `DOMAIN` 已设时 compose-prod **继承 DOMAIN 并导出给容器**（不是仅提示）                                        |
| `DRAIN_HEARTBEAT_TOKEN`     | 接线后       | 跳过心跳端点      | 随机串（`[A-Za-z0-9._~+/=-]`）；drain 推送用它做 Bearer                                                                                    |
| `READY_TOKEN`               | 上线前       | 不渲染 ready 端点 | `/api/ready` 的 Bearer；非空才渲染 `zz-app-ready.yaml`（生产不配 token 时该路由 404，配了却给错值会 401）                                  |
| `MONITOR_APP_ADDR`          | 否           | `app:3000`        | 本地 mock 时覆盖                                                                                                                           |
| `MONITOR_PG_ADDR`           | 否           | `db:5432`         | 同上                                                                                                                                       |
| `MONITOR_RUSTFS_ADDR`       | 否           | `rustfs:9000`     | 同上                                                                                                                                       |
| `MONITOR_INTERVAL`          | 否           | `30s`             | HTTP/TCP 检查间隔                                                                                                                          |
| `MONITOR_FAILURE_THRESHOLD` | 否           | `3`               | 连续失败几次告警                                                                                                                           |
| `MONITOR_SUCCESS_THRESHOLD` | 否           | `2`               | 连续成功几次算恢复                                                                                                                         |
| `GATUS_LOG_LEVEL`           | 否           | `INFO`            | 排障时 `DEBUG`（会放大 §4 的日志暴露面）                                                                                                   |
| `HC_DEADMAN_URL`            | healthchecks | 跳过 ping         | **已接线**：`deploy/systemd/web-lair-deadman.service` 优先读它，回退 `DEADMAN_PING_URL`                                                    |
| `HC_BACKUP_URL`             | 无           | 跳过 ping         | **无消费者（保留位）**：备份成功 ping 由 `deploy/backup.env` 的 `BACKUP_PING_URL` 发（Backrest `SNAPSHOT_END` hook），不要把 UUID 填在这里 |

生成 token：`openssl rand -hex 32`。`BARK_URL` / `*_TOKEN` 以 env 注入，会出现在
`docker inspect` 与 `docker compose config` 的输出里（已接受的取舍）；
粘贴这两类输出前先只取需要的字段。任何值都不要进 git 或镜像。

监控变量的校验只在 `render-config.sh`（即 `up`/`create`）执行；`run`（drain 每分钟）
与 `restart` 不再被监控配置错误拖住。反过来说，**改了监控 env 后只有 `up -d` 才会
生效并校验**——`restart` 既不重渲染也不重建容器。

## 6. 校验（T3.5，供 P1 的 CI 接入）

```bash
# 本地（直接跑；仓库内没有 heavy.sh，它是作者协调目录里的全局锁包装）
bash deploy/monitoring/verify-config.sh

# 若与 build/check/vitest 并行，先经你所在环境的全局锁再跑。

# CI（GitHub Actions, ubuntu-latest 自带 docker/curl）
- name: Gatus config
  run: bash deploy/monitoring/verify-config.sh
- name: .env.example must stay empty
  # 模板入库，真值只进 .env（600）。匹配“非空引号值”，空串占位不算。
  run: |
    ! grep -nE '^(BARK_URL|DRAIN_HEARTBEAT_TOKEN|READY_TOKEN|HC_DEADMAN_URL|HC_BACKUP_URL)="[^"]+"' .env.example
```

脚本断言五条（每条都真的能失败）：

1. **核心**（三个片段全关）：`/health` 200、`Validated 6 endpoints / 0 external endpoints`、
   `Ignoring provider=custom due to error=url not set`（空 `BARK_URL` = 只记日志）、
   且日志里没有 `endpoint=app-ready`（无 `READY_TOKEN` 时该端点不渲染）；
2. **全量**（domain + drain + app-ready + 非空 `BARK_URL`）：`/health` 200、
   `Validated 9 endpoints / 1 external endpoints`、`configuredProviders=[custom]`，且
   `endpoint=app-ready;` 出现（P4 的 `/api/ready` 在配了 token 后必须真的被监控）；
3. **负例 A**：端点缺 `url` → **exit 2** 且日志含 `you must specify an url`；
4. **负例 B**：drain 片段在但 token 为空 → **exit 2** 且含 `must specify a token`；
5. 两次正向启动都带 `--read-only --cap-drop ALL --tmpfs /tmp` 与 `GATUS_LOG_LEVEL=INFO`，
   与生产 compose 的硬化/日志级别一致。

镜像 tag 的单一真源是 `compose.monitoring.yaml`（脚本从中 `sed` 出 `image:`；
`GATUS_IMAGE` 可显式覆盖）。全量用例的 `SITE_DOMAIN=example.com` 会让 Gatus 发起
一次真实 TLS/RDAP 请求，因此该用例需要出站网络；断网环境用 `SKIP_FULL=1`。

## 7. healthchecks（箱外）

**未创建账号**。约定如下，真实 UUID 走 env，未设置一律跳过：

| check   | 语义                    | period / grace | env                             | 消费者                                                                     |
| ------- | ----------------------- | -------------- | ------------------------------- | -------------------------------------------------------------------------- |
| deadman | 箱子还活着（定时 ping） | 5m / 5m        | `HC_DEADMAN_URL`                | `deploy/systemd/web-lair-deadman.service`（优先；回退 `DEADMAN_PING_URL`） |
| backup  | 昨晚备份成功            | 1d / 6h        | `BACKUP_PING_URL`（backup.env） | `deploy/backup/hook-snapshot-end.sh`（Backrest `SNAPSHOT_END`）            |

- 两个 check 都要在 healthchecks 侧配 **邮件 + Bark** 通知；这是整机死时唯一能出声的
  通道，不能只依赖箱内 Gatus。Gatus 自己在 scratch 镜像里没有 shell，无法加
  Docker healthcheck——它挂了只能靠这里的 deadman 发现。
- 接线状态与切换窗口见 `notes/coordination/m6/P3-WAITING.md`（W2）。

## 8. drain 心跳（接线未完成）

契约：

```bash
curl -fsS -X POST -H "Authorization: Bearer $DRAIN_HEARTBEAT_TOKEN" \
  "http://127.0.0.1:8080/api/v1/endpoints/web-lair_jobs-drain/external?success=true&duration=1s"
```

现状：`jobs/drain.ts` 仍对 `JOBS_HEARTBEAT_URL` 发 **GET**（Kuma push 形态），不会带
Bearer，也不走这个 POST。所以：

- 在 drain 改为 POST（或在 systemd `web-lair-drain.service` 成功退出后追加上面这条
  curl）**之前，不要设置 `DRAIN_HEARTBEAT_TOKEN`**；
- 一旦设置，**30 分钟**内没有推送就会告警（窗口覆盖最长 tick；5m 会在健康的慢 tick 上误报）——这是 deadman 的正确行为，不是 bug。

接线登记在 `P3-WAITING.md` W5（切换窗口与 Kuma 下线一起做）。

## 9. Kuma 退出（未执行）

Kuma 仍在 `compose.prod.yaml`（`127.0.0.1:3001` + `kuma_data` 卷）。删除属**上线切换**
动作，不在 P3 做。顺序不能反——**先证明新通道会响，再静音旧通道**：

1. 配好 `BARK_URL`，在 Kuma 通知仍开启时制造一次真实故障，确认设备收到
   `TRIGGERED` 与 `RESOLVED`（此阶段重复通知是预期的）；
2. 关闭 Kuma 的全部 Notification（它继续观察，但不再发通知）；
3. 停 Kuma；观察 24h；
4. 最后才删 `kuma` 服务与 `kuma_data` 卷（历史监控数据会丢，可接受）。

登记在 `P3-WAITING.md` W4。

## 10. 已知边界

- Gatus 在箱内：整机死、网络断、Docker 挂都不会告警——这是 healthchecks 的职责。
- Gatus 自己的 crash loop（坏配置、坏 token）只能靠箱外 deadman 发现；容器内没有
  healthcheck（scratch 镜像无 shell）。
- `pg-tcp`/`rustfs-tcp` 只证明端口 accept，不证明可用；可用性由应用侧
  `/api/health`、`/api/ready` 与备份闸门覆盖。
- `domain-expiry` 依赖 RDAP/WHOIS 出站与真实域名；无域名阶段不渲染。
- 恢复通知（`RESOLVED`）只在 Gatus 自己观察到连续成功时发出；Gatus 重启（含热重载）
  会清空已触发告警，因此重启期间的恢复不会补发。
- `/admin` 的 **303** 由应用代码保证（`authz.ts` 的 `redirect(303, …)`），但 P3 只在
  mock 上验证过（mock 固定返回 303）；真实栈的首个 `curl -i /admin` 应作为 P4/上线
  检查项复核。
