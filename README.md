# hysteria-dsh-plugin

在 DeepSeek Harness（DSH）里直接管理本机 **Hysteria 2 代理**：启动 / 停止 / 重启 / 状态 / 连通性检测，
开发时网络不通（`git push`、`npm install`、`curl` 外网）自动走代理，不用再手动 `bash ~/.hysteria/start.sh`。

## 它管理什么

本机 `~/.hysteria/` 下的一套代理（与现有 `start.sh` 同一套进程）：

| 进程 | 端口 | 用途 |
|---|---|---|
| `hysteria client -c config.yaml` | HTTP `127.0.0.1:7890` / SOCKS5 `127.0.0.1:1080` | Hysteria 2 隧道 |
| `python3 auth-proxy.py` | HTTP `127.0.0.1:7891`（Basic Auth，凭据在 `auth-proxy.py` 内配置） | 带鉴权的 HTTP 转发代理 |

日志沿用 `~/.hysteria/client.log` / `auth-proxy.log`。所有操作幂等。

## 安装

```bash
# 本机检出（开发）或 GitHub
dsh plugin --profile web add /home/lumin/src/mdyj/hysteria-dsh-plugin
# 或 dsh plugin --profile web add github:luminsw/hysteria-dsh-plugin
# 配置覆盖（可选，默认即可用）：
#   ~/.dsh/profiles/web/cordis.patch.yml → id: dsh-hysteria-proxy → config: { home, hysteriaBin, httpPort, socksPort, authPort, checkUrl }
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

- `src/proxy.js`：进程管理（`pgrep` 按配置目录定位进程，避免误杀其它 hysteria；`ss` 查端口；`curl -x` 测连通性；detached + unref 后台运行，日志落盘）。
- `src/index.js`：schemastery 配置 schema + 5 个 DSH 工具注册。
- 跨平台：进程管理走 POSIX 命令（pgrep/ss/curl），面向 Linux/macOS/WSL；Windows 需另行适配（可后续加 win32 分支）。

## 环境要求

- DeepSeek Harness（`@deepseek-ai/cordis` / `@deepseek-ai/dsh-tools`）
- 宿主机：`hysteria`（PATH 或配置绝对路径）、`python3`、`pgrep`、`ss`、`curl`
- `~/.hysteria/config.yaml` 与 `auth-proxy.py` 就位

## License

MIT
