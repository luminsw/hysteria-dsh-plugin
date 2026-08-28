# hysteria-dsh-plugin

在 DeepSeek Harness（DSH）里直接管理本机 **Hysteria 2 代理**：启动 / 停止 / 重启 / 状态 / 连通性检测，
开发时网络不通（`git push`、`npm install`、`curl` 外网）自动走代理，不用再手动 `bash ~/.hysteria/start.sh`。

> 本插件属于百花（[Baihua](https://github.com/luminsw/baihua)）× DSH 的宿主机构件：
> 百花是提供本机/局域网能力的家庭服务端（知识库、家庭数据、本地 AI），DSH 是编排与交互面，
> 本插件负责给这同一台机器上的开发任务提供网络兜底。
> 同族插件见 [`baihua-dsh-plugin`](https://github.com/luminsw/baihua-dsh-plugin)（百花 Web → DSH 桥）、
> [`baihua-local-ai-dsh-plugin`](https://github.com/luminsw/baihua-local-ai-dsh-plugin)（DSH → 百花本地 AI）、
> [`baihua-mcp-server`](https://github.com/luminsw/baihua-mcp-server)（百花 → MCP 客户端）。

## 它管理什么

本机 `~/.hysteria/` 下的一套代理（与现有 `start.sh` 同一套进程）：

| 进程 | 端口 | 用途 |
|---|---|---|
| `hysteria client -c config.yaml` | HTTP `127.0.0.1:7890` / SOCKS5 `127.0.0.1:1080` | Hysteria 2 隧道 |
| 内置 Node `authproxy.js`（替代 python） | HTTP `127.0.0.1:7891`（Basic Auth） | 带鉴权的 HTTP 转发代理，**零 python 依赖** |

日志沿用 `~/.hysteria/client.log` / `auth-proxy.log`。所有操作幂等。

## 安装

```bash
# 本机检出（开发）或 GitHub
dsh plugin --profile web add /home/lumin/src/mdyj/hysteria-dsh-plugin
# 或 dsh plugin --profile web add github:luminsw/hysteria-dsh-plugin
# 配置覆盖（可选，默认即可用）：
#   ~/.dsh/profiles/web/cordis.patch.yml → id: dsh-hysteria-proxy → config: { home, hysteriaBin, server | serverEnv, serverAuth | serverAuthEnv, listen, httpPort, socksPort, authPort, authUser, authPass, checkUrl }
#   server/serverAuth 支持环境变量传值：填 serverEnv: 'HYSTERIA_SERVER' / serverAuthEnv: 'HYSTERIA_SERVER_AUTH'（变量名），
#   启动 DSH 前 export 即可，密码不落配置文件。
```

改代码后重启 DSH 生效：`pkill -f "dsh web"; npx @deepseek-ai/dsh web`（或 `bh_dsh_restart`）。

## 提供的工具（agent 直接调用）

| 工具 | 用途 | 只读 |
|---|---|---|
| `proxy_status` | 进程 / 端口 / 连通性总览 | ✅ |
| `proxy_check` | 经代理请求 204 URL 验证外网可达 | ✅ |
| `proxy_start` | 启动 hysteria + auth-proxy（幂等） | ❌ |
| `proxy_stop` | 停止（幂等） | ❌ |
| `proxy_restart` | stop → start（换出口 IP / 异常恢复） | ❌ |
| `proxy_diag` | 进程生命周期诊断（退出码/信号/末尾输出） | ✅ |
| `proxy_retry` | 直连失败自动带代理重试命令 | ❌ |
| `proxy_fix_aliyun` | 阿里云安全组出口 IP 对比与修复（apply=true 放行新 IP 并重启代理） | 默认只读 |

## 怎么用（agent / 开发场景）

### 场景一：`git push` / `npm install` / `curl` 外网失败

1. `proxy_status` 看代理是否在跑、连通性如何；
2. 未运行 → `proxy_start`；
3. 重试原命令，走代理：

```bash
# git（对当前命令生效）
git -c http.proxy=http://127.0.0.1:7890 push
git -c https.proxy=http://127.0.0.1:7890 push

# 或导出环境变量（对本会话及子进程生效）
export HTTPS_PROXY=http://127.0.0.1:7890
export HTTP_PROXY=http://127.0.0.1:7890
export ALL_PROXY=socks5://127.0.0.1:1080
```

> 需要鉴权的场景（某些工具不接受匿名代理）用 auth 端口：
> `http://<user>:<pass>@127.0.0.1:7891`（凭据见本机 `~/.hysteria/auth-proxy.py`，由用户自行配置，勿写入公开文档）。

### 场景二：代理异常（连接超时、出口 IP 被墙）

1. `proxy_check` 确认不可达；
2. `proxy_restart` 换新连接；
3. 仍不通 → 大概率是出口 IP 变化被阿里云安全组拦截（见 AGENTS.md 的完整处理流程）。
   修复：DSH 设置 → 插件 → Hysteria 代理卡片点「检测出口 IP」→ 需修复时点「确认执行修复」，
   或让 agent 调用 `proxy_fix_aliyun`（默认只读对比，`apply=true` 放行新 IP 并重启代理）。

### 场景三：不用代理了

`proxy_stop` 关掉，端口释放。

## 实现说明

- `src/proxy.js`：进程管理（Linux `pgrep/ss`，Windows pid 文件 + `tasklist/netstat/taskkill`；`curl -x` 测连通性；detached + unref 后台运行，日志落盘）。config.yaml 缺失时按 `server` 参数自动生成。
- `src/authproxy.js`：内置 Basic Auth HTTP 转发代理（Node 实现，替代 `auth-proxy.py`，零 python 依赖）。
- `src/index.js`：schemastery 配置 schema + 5 个 DSH 工具注册。
- 跨平台：Linux/macOS/WSL 走 POSIX 命令（pgrep/ss/ps/kill）；Windows 走内置适配（pid 文件 + tasklist + netstat + taskkill，hysteria.exe 与 python 自动探测），配置 `home`/`hysteriaBin` 指向本机目录即可。

## 环境要求

- DeepSeek Harness（`@deepseek-ai/cordis` / `@deepseek-ai/dsh-tools`）
- 宿主机：`hysteria`（PATH 或配置绝对路径）、`curl`（连通性检测）
- 代理目录：`config.yaml`（hysteria2 客户端配置）——**缺失时插件按 `server`/`serverAuth` 参数自动生成，无需手写**
- 带鉴权转发层为**内置 Node 实现**，不需要 python

## 出口 IP 变化自动修复（阿里云安全组，可选）

hysteria 服务器（如阿里云 ECS）安全组只放行固定出口 IP 时，本机宽带重拨换 IP 会被拦截。
插件提供「修复」能力（设置页卡片按钮，或 agent 工具 `proxy_fix_aliyun`）：
对比本机当前出口 IP 与安全组已放行 IP → 有差异时新增放行规则（**只增不删**，宽容期并存，
绝不删旧规则防锁死 SSH）→ 成功后自动重启代理。

需在 DSH 配置补上 `config.aliyun`（默认不启用；设置页卡片会显示“未配置”提示）：

```yaml
config:
  aliyun:
    regionId: ap-northeast-1     # 可选，默认 ap-northeast-1
    securityGroupId: sg-xxx      # 必填，安全组 ID
    cli: aliyun                  # 可选，aliyun CLI 命令名（需已配置凭证）
    ports:                       # 可选，默认 udp 443/443 + tcp 22/22 + icmp -1/-1
      - { protocol: udp, port: 443/443 }
      - { protocol: tcp, port: 22/22 }
      - { protocol: icmp, port: -1/-1 }
```

设置页卡片「阿里云安全组修复」区：点「检测出口 IP」只读对比（显示当前 IP、已放行 IP、将执行的
aliyun 命令）→ 需修复时点「确认执行修复」放行新 IP 并重启代理。

## 常驻模式（推荐）：随 DSH 启动自动拉起，用的时候直接用

代理**随 DSH 启动自动拉起**（autoStart 默认开，幂等：已在运行则跳过），不探测、不自动启停；需要走代理的命令直接带上代理即可：

- DSH 启动 → 插件自动 proxy_start；DSH 退出**不停**代理（保留给其它程序用），要停就手动 proxy_stop
- 想关闭随启：config.autoStart: false（之后手动 proxy_start / proxy_stop）
- 用的时候：
  - 单命令：git -c http.proxy=http://127.0.0.1:7890 push / HTTPS_PROXY=http://127.0.0.1:7890 npm install
  - 长期：git config --global http.proxy http://127.0.0.1:7890
  - agent 任务：proxy_retry { command: 'git push origin main' }（直连失败自动带代理重试）
- 独立于 DSH 的场景（不开 DSH 也要代理）：Windows 用计划任务或 Startup 快捷方式调 start.ps1，Linux 用 systemd / rc.local

## 任务内失败兜底（备选）：遇到访问不了/下载慢时自动用代理

## 任务内失败兜底（备选）：遇到访问不了/下载慢时自动用代理

**不探测、不轮询**：平时直连零介入；执行任务遇到直连失败或变慢时，自动启用代理并重试。agent 在跑 git push / npm install / curl 等外网任务失败时直接调用：

```
proxy_retry { command: 'git push origin main' }
proxy_retry { command: 'npm install' }
```

行为：先直连执行一次 → 非 0 退出/超时 → 自动 proxy_start → 带 HTTPS_PROXY/HTTP_PROXY 环境重试一次 → 返回两次结果。网络正常时只走直连，代理完全不参与。

> 也可以只调 proxy_start（幂等）后手动带 HTTPS_PROXY 重试，效果相同。

## 可选：autoProxy 轮询守护（默认关，一般不需要）

如果不采用任务内兜底、想让代理**提前**感知网络变化，可开轮询模式：

需求：**平时不用代理**；检测到直连访问失败或明显变慢时，**自动启动代理并让 git/npm 走代理**；直连恢复稳定后自动停代理回直连。全程无需人工介入。

```yaml
config:
  autoProxy: true                  # 开启按需守护（默认 false=手动启停）
  probeIntervalMs: 30000           # 直连探测间隔
  probeTargets:                    # 探测目标（默认 github + npm registry）
    - 'https://github.com'
    - 'https://registry.npmjs.org'
  slowThresholdMs: 2000            # 直连 >2s 视为"慢"→ 触发
  failThresholdMs: 10000           # 直连 >10s 视为"失败"→ 触发
  minActiveMs: 300000              # 触发后至少保持 5 分钟（防抖动）
  idleStopMs: 120000               # 直连连续健康 2 分钟 → 停代理
  applyToGit: true                 # 触发时自动注入/清除 git 全局 http.proxy/https.proxy
  applyToNpm: true                 # 触发时自动注入/清除 npm config proxy/https-proxy
```

行为：
- 每 probeIntervalMs 直连探测 probeTargets（Node fetch，不走代理）
- 任一目标失败或超阈值 → proxy_start + 注入 git/npm 代理
- 直连恢复且稳定 idleStopMs（并已过 minActiveMs）→ proxy_stop + 清除注入
- 状态见 proxy_status（"按需模式: 🟢 已启用代理 / ⚪ 直连 + 探测明细"）与设置页卡片

> 注意：applyToGit/applyToNpm 会改全局配置（git config --global / npm config），触发时写入、恢复时清除；介意侵入性可设 false，触发后由 agent 手动带 HTTPS_PROXY 重试。

## 安全（默认仅本机，本机之外不可访问）

- **监听地址**：插件生成的 config.yaml 默认 `http/socks5` 都只监听 `127.0.0.1`——只有本机能用代理，局域网/公网无法访问。需要改监听地址时用配置项 `listen`。
- **docker/k8s 容器访问**：容器需要走宿主代理时，把 `listen` 配成宿主 docker 网段地址（Linux 如 `172.17.0.1`，Windows Docker Desktop 用宿主 IP 或 `host.docker.internal` 可达地址），**并配防火墙只放行容器网段**（Windows：`New-NetFirewallRule -LocalPort 7890,1080 -RemoteAddress 172.17.0.0/16 ...`）。**不要把 `0.0.0.0` 直接对外**——7890/1080 无鉴权，监听地址是唯一防线。
- **7891 带 Basic Auth**：内置 Node auth-proxy 要求凭据（`authUser`/`authPass`，未配置时回退读旧 `auth-proxy.py` 源码）；无凭据请求一律 407 拒绝。凭据为空则 7891 仅限回环放行。
- **凭据不进日志**：auth 密码通过环境变量传入 auth-proxy 子进程，不落命令行/日志。

## License

MIT
