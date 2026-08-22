# hysteria-dsh-plugin

在 DeepSeek Harness（DSH）里直接管理本机 **Hysteria 2 代理**：启动 / 停止 / 重启 / 状态 / 连通性检测，
开发时网络不通（`git push`、`npm install`、`curl` 外网）自动走代理，不用再手动 `bash ~/.hysteria/start.sh`。

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

## 任务内失败兜底（推荐）：遇到访问不了/下载慢时自动用代理

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
