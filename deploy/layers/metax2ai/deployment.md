# metax2AI 中国企业版部署

> 本文件的第一节是本 layer 专属的说明，请先读它；其后是 CLI 生成的通用部署手册，作为
> 具体命令的参考。两者冲突时以第一节为准——通用手册面向 Fly / AWS 与 Slack 场景，
> 本部署两者都不使用。

## 本 layer 的现状（2026-08-11）

**目标形态**：国内公有云单机，一台 ECS，`target: "docker"`，全部服务跑在本机容器里。

## 阿里云 ECS 选型记录（2026-08-10，暂停购买）

当前决定是继续本地开发与客户演示，等功能完成并进入 M4 后再购买和部署 ECS。阿里云账号
目前要求先充值 100 元才能创建按量实例；在负责人再次明确授权前，不充值、不下单。已创建
的密钥对与安全组保留，创建 ECS 前重新核对公网 IP、库存和实时报价。

计划购买的验收机配置：

- 付费与地域：按量付费，华东 1（杭州）、可用区 K，默认 VPC
  `vpc-bp1togci132whoencnzto` 与交换机 `vsw-bp1fr7kgaql9ph2wr76p2`。
- 实例：`ecs.u2a-c1m2.2xlarge`，AMD x86_64，8 vCPU、16 GiB，实例名
  `qm-m3-runner`。
- 镜像与登录：Ubuntu 24.04 64 位，保留免费安全加固，不领取三个月主机病毒防护；登录用户
  `ecs-user`，密钥对 `qm-m3-hangzhou`。私钥只保存在开发机的
  `~/.ssh/qm-m3-hangzhou`，不得进入 Git 或发送给客户。
- 存储：系统盘 ESSD PL0 100 GiB；数据盘 ESSD PL0 200 GiB。验收机的两块盘随实例释放，
  不开性能突发、预配置性能、文件备份或自动快照。正式生产部署需要重新决定数据盘保留与
  备份策略。
- 网络：分配公网 IPv4，按使用流量计费，峰值 5 Mbps，不开 CDT 和巨型帧，开启主网卡
  源/目的检查。
- 安全组：`qm-m3-ssh`（`sg-bp1fbir7b2xmezqjsjfe`），当前只允许开发机当时的公网地址
  `219.157.180.44/32` 访问 TCP 22。该地址可能变化，购买前必须重新检测并更新。

截图中的 AutoPL 200 GiB 版本曾显示固定费用 1.6183 元/小时，公网流量 0.8 元/GiB；这不是
最终报价。购买前应先改为上面的 ESSD PL0 数据盘，再以控制台实时价格为准。

**已配置**：

- `services` 为 `core`、`web-ui`、`admin`、`portal`、`auth`——**不含 `slack`**。Web 是
  唯一用户入口。
- `modelProvider: "deepseek"`，密钥为 `DEEPSEEK_API_KEY`，不经 OpenRouter 中转。
- 登录走内置 `auth` broker 的企业邮箱魔法链接：`AUTH_EMAIL_TRANSPORT=smtp`。这一项
  **必须显式声明**——它自己的默认值是 `resend`，会把登录邮件送到境外服务。
  `SMTP_PORT` 与 `SMTP_TLS` 已设为 `587` / `starttls`，接入客户中继时按实际值修改；
  生产环境禁止 `SMTP_TLS=none`（凭据会明文过网）。
- Web UI 与登录邮件的默认语言显式声明为 `zh-Hans`，不依赖运行时默认值。
- Portal 的 `OIDC_ISSUER` 由 CLI 从 `publicUrl` 推导，指向内置 broker。CLI 的
  `validatePortalTrust` 把未设置的 issuer 解析成 Slack 的那条已知遗留问题只影响使用
  外部 OIDC 的部署，本 layer 不受影响。

**单机部署的代码阻塞项已由 M3 解除**（实现与评审均已合入）：

此前 `docker` 目标在契约层面强制要求一个 Fly agent-computer app，可声明的沙箱后端只有
`sprites`（Fly）与 `aws`——core 镜像不含 Docker 客户端，docker 后端也不挂载宿主机
Docker socket，因此容器化的 core 够不到 `local` 沙箱，而生产环境下 core 必须显式声明
`SANDBOX_BACKEND`。配置现在已声明 `sandbox.backend=runner`；首次部署前仍需发布镜像，让
CLI 把 digest 钉死的 `sandbox.image` 写回配置。未完成这一步时，`qm up` 会拒绝启动。

M3 的 **On-prem Sandbox Runner** 补上了缺的那一半：一个独占容器运行时的独立服务，core
通过带鉴权的内网 API 调用它，因此 core 依然不持有宿主机 Docker Socket。`docker` 目标
不再要求 Fly app，沙箱声明改为：

```jsonc
"sandbox": { "backend": "runner", "image": "<registry>/qm-sandbox@sha256:..." }
```

镜像必须按 digest 钉死——Runner 拒绝启动未钉死的镜像。

这里的镜像不是随便一个沙箱镜像：Runner 靠容器内的 guest agent 提供 exec 与文件读写，
镜像必须自带它并以它为 `CMD`。`qm sandbox publish` 会在 `sandbox.backend` 为 `runner`
时把 agent 层烤进去，所以**先把 `backend` 写成 `runner`，再 publish**；顺序反了会推出
一个没有 agent 的镜像，Runner 起得来，但每个 scope 的沙箱都会卡在「agent 30 秒内没有
就绪」。

首次部署前先执行 `qm sandbox publish --app <registry>/qm-sandbox`，再运行 `qm up`；但**先读
下面的「宿主机准备」**：地址池与 XFS 两项都要在第一次部署前配好，出网白名单要在交付前配好。

## 宿主机准备（部署前必做，顺序不能颠倒）

前两项都需要重启 Docker 守护进程，会重启机器上所有容器。**必须在第一次 `qm up`
之前完成**——事后补做等于一次全栈停机，而其中地址池那项在撞墙之前没有任何征兆。第三项
（出网白名单）不重启任何东西，但要在把系统交给用户之前配好。

### 1. 一块启用 pquota 的 XFS 数据盘

Runner 用 XFS 项目配额限制每个 scope 的家目录，用 `--storage-opt size=` 限制容器
可写层。两者都要求所在文件系统是 XFS 且挂载时启用了项目配额。

不满足的后果分两种，都不好：

- **家目录配额**：`RUNNER_SANDBOX_HOME_ROOT` 不在启用 pquota 的 XFS 上时，Runner 的
  preflight 直接失败，服务起不来。这是硬要求。
- **容器可写层配额**：存储驱动不支持时，Runner 会告警并**放弃这一层限制**继续启动，
  于是单个沙箱可以写满宿主机磁盘。告警长这样：

  ```
  [runner] this Docker storage driver will not enforce --storage-opt size (...)
  ```

挂一块云盘，格式化为 XFS，挂载时带 `pquota`（设备名按实际调整）：

```sh
mkfs.xfs /dev/vdb
mkdir -p /data
echo '/dev/vdb /data xfs defaults,pquota 0 0' >> /etc/fstab
mount -a
xfs_quota -x -c 'state -p' /data     # Accounting 与 Enforcement 都应为 ON
```

然后把 Docker 的数据根目录和沙箱家目录都放到这块盘上：

- `/etc/docker/daemon.json` 里 `"data-root": "/data/docker"`
- `qm.config.jsonc` 的 `env.core.RUNNER_SANDBOX_HOME_ROOT` 必须为
  `/data/qm/sandbox-homes`（默认值 `/var/lib/qm/sandbox-homes` 在系统盘上，系统盘通常是 ext4，
  必须改；Runner 会在该根目录下自动追加 `orgId`，不同部署不共用 scope 目录）

`xfs_quota` 通过设备节点与文件系统对话，而 docker 不会为 bind mount 创建设备节点。`qm up`
因此会从宿主机的 `/proc/self/mountinfo` 解析出承载家目录的 XFS 设备，并用 `--device` 传给
Runner 容器。这一步是自动的，但它解释了两件事：这块盘必须是**独立挂载的 XFS**（家目录必须
落在某个 XFS 挂载点之下），以及换盘或改挂载点后必须 `qm up` 重建 Runner 容器，而不是
`docker restart`。

### 2. 扩大 Docker 的网络地址池

每个 scope 拿一个独立 Docker 网络，这是 scope 之间不能互相访问的实现方式。而 Docker
默认地址池只够约 **30 个**用户自定义网络（`172.17–172.31/16` 共 15 段，`192.168.0.0/16`
切 `/20` 共 16 段，`docker0` 自己占一个）。

用满之后，第 31 个员工的沙箱直接建不出来，报错是 Docker 原文：

```
Error response from daemon: all predefined address pools have been fully subnetted
```

在 `/etc/docker/daemon.json` 中声明更大的池：

```json
{ "default-address-pools": [{ "base": "10.201.0.0/16", "size": 28 }] }
```

`/16` 切 `/28` 得到 4096 个网络，每个 13 个可用地址（每个沙箱网络实际只需要 6 个：
网络地址、网关、广播，加沙箱容器、Runner、出口代理各一）。

**这个网段必须与客户内网确认，不能照抄。** 宿主机路由按最长前缀匹配，如果容器网络
和企业内网真实网段重叠，发往那些地址的流量会被送进容器网络，表现为「某几台内网服务器
突然不通，其他都正常」——不报错、不超时，极难排查。

选段的方法：

1. 向客户网络管理员要 IP 规划表，问清现用与规划中的网段。
2. 要不到就在目标机器上勘察：`ip route`、`ip -4 addr`、`/etc/resolv.conf`、VPN 网段。
3. 选 `10.x` 的高位、不整齐的数字。企业内网习惯从低位排（`10.0.x`、`10.1.x`、
   `10.10.x`），高位撞车概率低。避开 `172.16–172.31`（Docker 自己），以及
   `10.244.0.0/16`（Flannel）、`10.96.0.0/12`（K8s Service）、`10.42/10.43`（K3s）
   ——踩中会和客户日后上 K8s 冲突。
4. 落盘前在目标机器上验一次：

   ```sh
   ip route | grep -E '(^| )10\.201\.' || echo '10.201.0.0/16 is clear'
   ```

Runner 启动时会检查这一项，用的还是默认池就告警：

```
[runner] docker is on its default address pools, which hold about 30 networks
and N are already taken — ...
```

### 3. 沙箱出网白名单（第一次 `qm up` 之后、交付给用户之前）

这一项不需要重启 Docker，但**不做的话 Agent 在沙箱里碰不到任何外部服务**，而现象很像 Bug：
模型正常回话，一执行 `pip install`、`curl` 企业接口就失败，且失败在网络层，日志里看不到
「被策略拒绝」这种自解释的字样。

语义是**默认拒绝**：

- 没有配置 `allowedHosts` 的 scope，实际白名单只有控制面主机一项，其余一律拒。
- **控制面主机不需要手写**，`egressClaimAllowingControlPlane` 会从 `apiBaseUrl` 推导出来
  并无条件追加。若 `apiBaseUrl` 未配置且白名单为空，白名单退化为哨兵 `deny.invalid`，
  它匹配不到任何主机，等于全拒。
- 白名单按主机名匹配且覆盖子域（`example.com` 放行 `api.example.com`），不接受协议、端口、
  路径与通配符。

管的是**沙箱内部发起的出网**——Agent 执行的命令、装包、调企业 CRM/ERP/内部 API。Core 自己
调模型不走这条路径，所以「Agent 能回话」不能证明出网配置是对的。

配置在 Admin 的 scope 配置里，org 一层配默认、单个 scope 可覆盖。Admin 同时会报告这套机制
**是否真的生效**，读 `egressEnforcement.reason`：

| reason                       | 含义                                       |
| ---------------------------- | ------------------------------------------ |
| `ready`                      | 域名级强制生效                             |
| `backend_unsupported`        | 当前沙箱后端不做域名强制                   |
| `control_plane_unconfigured` | 后端支持，但控制面没配好，实际退化为不强制 |

最后一条容易踩：`local` 与 `aws` 后端的 `egressEnforcement` 在代码里写死 `none`，**这两个
后端下白名单根本不生效**。出网策略的验收必须在 `runner`（或 `sprites`）后端上做，在本地
`local` 后端上试出来的「能出网」不构成任何证据。

## M2 演示怎么跑

M2 演示不使用本目录的 docker 形态，而使用 `/dev-instance`：core 跑在宿主机上，
`SANDBOX_BACKEND=local` 可用，Agent 能真正执行任务。

1. 用 `/dev-instance` 起本 worktree，配置真实 `DEEPSEEK_API_KEY`。
2. 确认沙箱镜像已构建：`npm run sandbox:local:build`（文档解析库随镜像预装）。
3. 按 `demo-data/README.md` 的「演示前准备」把跟进日期调到演示当天。跟进表存在多种
   格式时必须**全部同步修改**，否则跨格式一致性检查会误报——以该 README 的文件清单
   为准，不要凭记忆假设有哪几份。
4. Web UI 登录后上传 `demo-data/` 全部文件（个人 scope 即可）。
5. `customer-followup-digest` Skill 由 `skills-seed/` 自动播种，无需手工安装。
6. 按 `demo-data/README.md` 列出的问题依次提问，并建一个 cron 生成每日经营摘要。

## 通用部署手册（CLI 生成）

以下内容由 `qm init` 生成，面向 Fly / AWS 与 Slack 场景，作为命令参考保留。其中关于
「docker 目标只适合本地试驾、不要作为真实部署推荐」的说法，正是上面记录的阻塞项在
上游的表述。

This repository defines one QM deployment. The `@yc-software/qm` dependency supplies
the deployment engine; this repository owns the organization-specific config,
sandbox layer, provider coordinates, and generated Slack manifests.

The task is complete only after the administrator can sign in, receive a real
web response, and, when Slack is requested, mention the bot in a test channel
and receive a response.

## 1. Collect choices and authorization

Before cloud mutation, read `qm.config.jsonc` when it exists. Its `target` is
the selected provider; confirm it with the operator and do not offer to change
it in place. If the repository has not been initialized, collect:

- hosting target: a cloud provider, Fly.io or AWS. Recommend Fly.io when the
  operator has no preference. The docker target runs everything on the local
  machine, is for a quick local test drive only, and is outside this
  workflow; never present it as the recommended path for a real deployment;
- the first administrator's verified work email;
- how people sign in: the built-in `auth` broker, which emails a one-time link,
  or an external OIDC provider. Ask whether the company runs on Slack before
  assuming the broker — Slack sign-in needs no email transport, no sending
  domain, and no DNS, and domain verification is the step most likely to stall
  a deploy. Recommend Slack sign-in to a Slack workspace and the broker
  otherwise;
- model provider: Anthropic, DeepSeek, OpenAI, or OpenRouter (one key that routes to
  many models). This is a deployment choice, not a post-deploy one: it becomes
  `modelProvider` in `qm.config.jsonc`, which makes that provider's API key a
  required secret. Collect the key in the same pass as the other credentials —
  a deployment that cannot answer one message is not finished. An operator who
  genuinely wants to defer omits `modelProvider` and adds the key from the
  Admin page later, but do not offer that as the default;
- model;
- region and provider account or organization;
- whether the provider hostname is acceptable;
- connectors to enable, including whether to add Slack now.

The deployment slug is a local name for this deployment — it appears in the
package name, resource names, and Slack branding. Derive it from the
organization's name (a lowercase DNS label) and confirm it in passing; do not
make the operator decide it as a standalone question. On Fly.io the slug is
the default `appPrefix`, and app names like `<prefix>-core` must be free on
fly.dev; on a collision set a distinctive `appPrefix` rather than renaming
the organization.

Explain the selected provider's billable resources and confirm the provider
identity, region, resource list, and expected billing.

Changing providers means initializing a new empty deployment directory. Never
rewrite only `target`; provider config, files, secret rules, and teardown
contracts are scaffolded as one unit.

## 2. Prepare the deployment repository

Require Node 24+, npm, Git, Docker with Buildx, and `openssl`.

For a repository without `qm.config.jsonc`, first confirm the hosting target
and the derived slug, then initialize its root with the current CLI:

```bash
npm exec --yes --package=@yc-software/qm@latest -- \
  qm init . --org <slug> --target <fly-or-aws> --model-provider <provider>
npm install
```

`qm init` writes the version it resolved to as an exact dependency, so the pin
lands in the deployment repository and its lockfile rather than in the command
that bootstraps it.

`--model-provider` takes `anthropic`, `deepseek`, `openai`, or `openrouter` and defaults
to `anthropic`. It writes `modelProvider` into the scaffolded config, which is what
promotes that provider's key from an optional fallback to a required secret.

For an already-initialized clone, install reproducibly. Use `npm ci` when
`package-lock.json` exists; otherwise use `npm install` to create it:

```bash
test -f package-lock.json && npm ci || npm install
npm exec qm -- version
```

Confirm `.env` is private and ignored before adding credentials:

```bash
test "$(stat -f '%Lp' .env 2>/dev/null || stat -c '%a' .env)" = 600
git check-ignore --quiet .env
```

Never print, paste into chat, or commit `.env`. Never initialize over an
existing deployment config.

## 3. Configure the administrator, sign-in, and the base model

Set the exact lowercased administrator email in `.env` as
`ADMIN_GRANTS=<email>:org_admin`.

Follow the sign-in route chosen in step 1. Only the `auth` broker needs an email
transport; skip to "Slack sign-in" below when the operator picked Slack, and
skip `references/email.md` entirely with it.

### The built-in broker

The `auth` broker emails a one-time link. There is no identity provider to
register: the CLI generates the broker's signing key and the portal's client
credentials and derives every `OIDC_*` value from `publicUrl`. Setting any of
them by hand is refused.

What the operator supplies is a way to send those emails. Do not ask them to
pick a transport by name; ask what they already use for email. An existing
mail account or relay (Google Workspace, Postmark, SES, Fastmail) means SMTP —
recommend it, since it needs no DNS work — and only an operator who prefers
Resend and controls DNS for a sending domain should pick `resend`. Set
`env.auth.AUTH_EMAIL_TRANSPORT` accordingly, optionally set
`env.auth.AUTH_ALLOWED_EMAIL_DOMAIN` to admit a whole domain, then read
`.codex/skills/deploy-qm/references/email.md` before collecting secrets — the
Resend path needs DNS control you will not have, so raise it with the operator
early. Configure services, model, and the final public origin in the same pass.

### Slack sign-in

A workspace that already runs on Slack can sign in with it and skip email
altogether. Drop `"auth"` from `services` and follow
`.codex/skills/deploy-qm/references/slack.md`, which covers the SSO app, the
`env.portal` endpoints, the workspace trust boundary, and the client
credentials. The bot app in that same reference is a separate decision — Slack
sign-in does not require the agent in the workspace, and the agent does not
require Slack sign-in.

### Another OIDC provider

To use a different work-email OIDC provider, drop `"auth"` from
`services`, register `<publicUrl>/auth/callback` with the provider, and put its
endpoints and the email gate in `env.portal`. For Google Workspace:

```json
{
  "OIDC_AUTH_ENDPOINT": "https://accounts.google.com/o/oauth2/v2/auth",
  "OIDC_TOKEN_ENDPOINT": "https://oauth2.googleapis.com/token",
  "OIDC_USERINFO_ENDPOINT": "https://openidconnect.googleapis.com/v1/userinfo",
  "OIDC_ISSUER": "https://accounts.google.com",
  "OIDC_JWKS_URI": "https://www.googleapis.com/oauth2/v3/certs",
  "OIDC_SCOPES": "openid email profile",
  "OIDC_PRINCIPAL_CLAIM": "email",
  "OIDC_ALLOWED_EMAILS": "<verified-work-email>"
}
```

### Playground mode

A playground is a public try-it deployment: unauthenticated visitors get
anonymous browser-pinned identities instead of a sign-in page, while the one
administrator still signs in through whichever route above the deployment
configured. Enable it in `qm.config.jsonc`:

```json
"env": { "portal": { "PORTAL_PLAYGROUND": "1" } }
```

A playground must be its **own deployment**, never a flag on a working org's
instance: every visitor is an ordinary internal principal of the deployment's
org, so anything granted or published at org scope — including org-granted
credentials — is theirs. Grant nothing sensitive at org scope, connect no real
connector credentials, and load no company data. A cleared cookie is a fresh
identity, so set `env.core.ORG_BUDGET_USD_PER_WINDOW` — the one hard spend
ceiling — in the same pass, and from the Admin page after first boot restrict
the model picker to the subset you want to offer (one model or several).
Nothing garbage-collects an abandoned visitor's scope yet.
`plugins/portal/README.md` § "Playground mode" covers the rest: per-address
mint limits, the boot refusals, and what anonymous visitors are denied.

### The base model

Whichever sign-in route the deployment takes, the base model needs a key in the
same pass. `modelProvider` decides which one `qm setup` asks for —
`ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, or `OPENROUTER_API_KEY` — and the wizard
prints where to mint it. The operator owns the billing relationship, so they
create the key; you only place it. It is a required secret, so `qm doctor` calls
the provider to prove the key is accepted and `qm up` refuses a deployment that
has none. Treat a rejected key exactly like a rejected sign-in credential: stop
and get a working one rather than deploying a stack that greets the
administrator and then fails their first message.

`modelProvider` also picks the model itself, so no model id has to be chosen at
deploy time: Anthropic serves `claude-opus-5`, DeepSeek `deepseek-v4-flash`, OpenAI
`gpt-5.6-sol`, and OpenRouter `openrouter/auto`. Set `model` in `qm.config.jsonc` only to override that, and
only with a model the chosen provider can bill — a mismatch is refused at
startup rather than at the first message. The same rule covers the harness:
`HARNESS` `codex` runs OpenAI models alone, `claude` runs Anthropic models
alone, and DeepSeek or OpenRouter needs the default `pi` harness.

An operator may still prefer to hold the key centrally and rotate it from the
Admin page. That is a deliberate choice, not the default: drop `modelProvider`
from `qm.config.jsonc`, note in the handoff that the deployment has no base model
yet, and finish by walking them through Model provider on the Admin page. Never
leave a deployment modelless without saying so.

Read exactly one provider reference now and follow its provider-specific
preflight and setup order:

- Fly.io: `.codex/skills/deploy-qm/references/fly.md`
- AWS: `.codex/skills/deploy-qm/references/aws.md`

## 4. Deploy and prove the web surface

Follow the selected provider reference, then run:

```bash
npm exec qm -- check --live
npm exec qm -- conformance
npm exec qm -- outputs --json
```

Open `adminOnboardingUrl` from the JSON output and confirm Model provider
reports the chosen vendor as configured, sourced from the environment. It does
when `modelProvider` is set: the key travelled with the rest of the deployment
secrets, so there is nothing to paste here. Enter and validate a key on that
page only when the operator chose to defer, or when they are replacing the
deployment key with one they would rather rotate from Admin — the write-only
surface stores it in durable encrypted storage and takes precedence over the
deployment key. On the deferred route, set Base model on that same page after
the key: a key alone leaves the deployment on a model it cannot bill.

Never paste any provider key into chat or terminal output. `.env` is the one
place a deployment key belongs, and `qm secrets push` moves it without printing
it.

Open `webUiUrl`, sign in as the seeded administrator, send a message, and
receive a real model response. Ask the agent to create a fresh UUID in
`/root/workspace/qm-computer-proof.txt`, then use the provider reference's
independent proof to verify that UUID outside the model transcript.

## 5. Configure connectors

Open `adminConnectorsUrl` from `outputs --json`. For each chosen connector:

1. Open the provider-console link shown by Admin.
2. Register the exact callback shown there.
3. Enter the client id and secret in the write-only fields and save.
4. Open `userConnectionsUrl` and complete one real user connection.

Verify configured connectors appear and unconfigured connectors remain hidden.

## 6. Add the Slack bot

This is the agent in the workspace, not sign-in; a deployment using Slack
sign-in already created its SSO app in step 3. Skip this when the bot was
deferred. Otherwise read `.codex/skills/deploy-qm/references/slack.md`, then run:

```bash
npm exec qm -- slack render
npm exec qm -- outputs
```

Create the app from the exact bot manifest URL. Enter its bot and app tokens in
the Admin Slack card, invite it to a test channel, mention it, and receive a
reply.

## 7. Return the handoff

Return:

- the web, Admin onboarding, Admin connectors, and user connections URLs;
- how people sign in, and the Slack SSO app link when that is the route;
- Slack bot app and test-channel links when enabled;
- provider, account or organization, and region;
- the base model provider and where its key lives — the deployment `.env` or the
  Admin page — so the operator knows what to rotate and where;
- pass/fail for health, sign-in, web chat, agent-computer proof, connector
  visibility, user OAuth, Slack reply, live check, conformance, and an
  idempotent deployment rerun;
- `npm exec qm -- status`, logs, rollback, and teardown commands;
- recurring cost or manual work still owned by the operator, including model
  usage billed directly by the provider.

Do not claim completion with a missing test or placeholder. If blocked, leave
the repository resumable and name the exact next human action without exposing
a secret.
