/**
 * hysteria-dsh-plugin — 在 DeepSeek Harness 里直接管理本机 Hysteria 2 代理。
 *
 * 提供 DSH 工具（agent 直接调用）：
 *   proxy_status    只读状态：进程 / 端口 / 连通性
 *   proxy_start     启动 hysteria + auth-proxy（幂等）
 *   proxy_stop      停止（幂等）
 *   proxy_restart   重启（换出口 IP / 异常恢复）
 *   proxy_check     连通性检测（经代理请求一个 204 URL）
 *
 * 开发场景：git push / npm install / curl 外网失败时，先 proxy_start 再走代理重试。
 * 用法约定（AGENTS.md 已记载）：git push 失败 → 启动代理 → 设置
 * HTTPS_PROXY=socks5://127.0.0.1:1080（或 http://127.0.0.1:7890）→ 重试。
 */
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { settingsNamespace, installSettingsSection } from "@deepseek-ai/dsh-settings";
import { createProxyOps } from "./proxy.js";
import { startAutoProxy } from "./autoproxy.js";
import { spawnSync } from "node:child_process";

export const name = "dsh-hysteria-proxy";

/** DSH 设置页插件卡片命名空间（客户端卡片以同名 key 注册）。 */
const SETTINGS_NS = settingsNamespace("hysteria");

export const inject = ["tools", "webServer"];

export const Config = z.object({
  /** hysteria 配置目录（含 config.yaml / start.sh / auth-proxy.py）。 */
  home: z.string().default("~/.hysteria"),
  /** hysteria 可执行文件（PATH 中或绝对路径）。 */
  hysteriaBin: z.string().default("hysteria"),
  /**
   * 代理服务器地址（"host:port"，如 "8.216.46.73:443"）。
   * config.yaml 缺失时据此自动生成 hysteria2 客户端配置——用户只填参数即可架起代理，无需手写配置。
   * 也可只填 serverEnv（环境变量名），运行时从环境变量读取。
   */
  server: z.string().default(""),
  /** 服务器地址的环境变量名（如 HYSTERIA_SERVER），优先于 server。 */
  serverEnv: z.string().role("credential-ref").default(""),
  /**
   * hysteria 服务器 auth 密码（生成 config.yaml 用；已存在 config.yaml 时以文件为准）。
   * 机密字段：设置页渲染为 write-only 密码框，值存 DSH 设置（服务端），绝不回传浏览器。
   */
  serverAuth: z.string().role("secret"),
  /**
   * 服务器密码的凭据/环境变量引用名（如 HYSTERIA_SERVER_AUTH），优先于 serverAuth。
   * 推荐：密码只放凭据库/环境变量，不写进 patch 配置；也可在设置页密码框里直接填。
   */
  serverAuthEnv: z.string().role("credential-ref").default("HYSTERIA_SERVER_AUTH"),
  /**
   * hysteria 客户端监听地址（安全默认仅本机 127.0.0.1，本机之外不可访问）。
   * docker/k8s 容器需要访问时：配成宿主 docker 网段地址（如 Linux 172.17.0.1），
   * 并配合防火墙只放行容器网段——不要把 0.0.0.0 直接对外。
   */
  listen: z.string().default("127.0.0.1"),
  /** hysteria HTTP 代理端口。 */
  httpPort: z.number().default(7890),
  /** hysteria SOCKS5 端口。 */
  socksPort: z.number().default(1080),
  /** auth-proxy（Basic Auth HTTP 转发）监听端口。 */
  authPort: z.number().default(7891),
  /** auth-proxy Basic Auth 用户名（默认空=从 ~/.hysteria/auth-proxy.py 源码读取）。 */
  authUser: z.string().default(""),
  /** auth-proxy Basic Auth 密码（默认空=从 ~/.hysteria/auth-proxy.py 源码读取；机密字段）。 */
  authPass: z.string().role("secret").default(""),
  /** 连通性检测目标 URL（应返回 2xx/204）。 */
  checkUrl: z.string().default("https://www.gstatic.com/generate_204"),
  /**
   * DSH 启动时自动拉起代理（幂等，已在运行则跳过）。
   * 推荐常驻模式：DSH 一启动代理就绪，用的时候直接用。
   */
  autoStart: z.boolean().default(true),
  /**
   * 代理守护（keep-alive）：只要 DSH 运行且本插件加载，就周期性检测代理是否在线，
   * 若 hysteria/auth-proxy 任一线程不在，自动调用 proxy.start() 拉起，保证"DSH 在跑代理就在"。
   * 生命周期与 DSH 一致：DSH 停止 → 守护随之停。false=关闭（仅启动一次，不持续守护）。
   */
  keepAlive: z.boolean().default(true),
  /** 代理守护检测间隔（ms）。 */
  keepAliveIntervalMs: z.number().default(30000),
  /**
   * 按需代理守护（on-demand）：平时直连，检测到访问失败/变慢时自动启用代理并让 git/npm 走代理，
   * 直连恢复稳定后自动停代理回直连。false=关闭（默认，手动 proxy_start/stop）。
   */
  autoProxy: z.boolean().default(false),
  /** 直连探测间隔（ms）。 */
  probeIntervalMs: z.number().default(30000),
  /** 直连探测目标（不达标即触发代理）。 */
  probeTargets: z.array(z.string()).default(["https://github.com", "https://registry.npmjs.org"]),
  /** 直连响应超过该值（ms）视为"慢"，触发代理。 */
  slowThresholdMs: z.number().default(2000),
  /** 直连请求超时（ms）视为"失败"，触发代理。 */
  failThresholdMs: z.number().default(10000),
  /** 触发后至少保持代理时长（ms），防抖动。 */
  minActiveMs: z.number().default(300000),
  /** 直连连续健康多久（ms）后停代理回直连。 */
  idleStopMs: z.number().default(120000),
  /** 触发时自动 git config --global 注入/清除 http.proxy/https.proxy。 */
  applyToGit: z.boolean().default(true),
  /** 触发时自动 npm config 注入/清除 proxy/https-proxy。 */
  applyToNpm: z.boolean().default(true),
  /**
   * 阿里云安全组配置（出口 IP 变化自动修复用；默认不启用）。
   * 例：{ regionId: "ap-northeast-1", securityGroupId: "sg-xxx", cli: "aliyun",
   *       ports: [{ protocol: "udp", port: "443/443" }, { protocol: "tcp", port: "22/22" }, { protocol: "icmp", port: "-1/-1" }] }
   */
  aliyun: z.any().default(undefined),
});

export function apply(ctx, config) {
  // settings 命名空间：用户表单覆盖会重绑 current，运行时（proxy）始终读最新值（修 setSource no-op bug）。
  let current = () => config;
  installSettingsSection(ctx, SETTINGS_NS, Config, config, {
    setSource: (source) => {
      current = source;
    },
    onChange: () => {},
  });
  const cfg = () => current();
  const proxy = createProxyOps(() => current());

  // ---------- 随 DSH 启动自动拉起代理（autoStart，幂等；已运行则跳过）----------
  if (cfg().autoStart !== false) {
    setTimeout(() => {
      proxy
        .start()
        .then((r) => {
          if (r.ok) console.log(`[hysteria] 随 DSH 启动自动拉起代理${r.alreadyRunning ? "（已在运行）" : ""}`);
          else console.log(`[hysteria] 自动启动代理失败：${r.error || "未知"}`);
        })
        .catch((e) => console.log(`[hysteria] 自动启动代理异常：${e.message}`));
    }, 1500).unref?.();
  }

  // ---------- 代理守护（keep-alive）：生命周期与 DSH 一致，代理挂了自动拉起 ----------
  let keepAliveTimer = null;
  const keepAliveMs = Number(cfg().keepAliveIntervalMs) || 30_000;
  let keepWasDown = false;
  const keepTick = async () => {
    try {
      const a = proxy.alive();
      const up = a.hysteria && a.authProxy;
      if (up) {
        if (keepWasDown) {
          console.log("[hysteria] 代理守护：代理已恢复在线");
          keepWasDown = false;
        }
        return;
      }
      const r = await proxy.start();
      if (r.ok) {
        console.log("[hysteria] 代理守护：检测到代理离线，已自动拉起");
        keepWasDown = false;
      } else if (!keepWasDown) {
        console.log(`[hysteria] 代理守护：检测到代理离线，自动拉起失败：${r.error || "未知"}（将自动重试）`);
        keepWasDown = true;
      }
    } catch (e) {
      console.log(`[hysteria] 代理守护异常：${e.message}`);
    }
  };
  if (cfg().keepAlive !== false) {
    keepAliveTimer = setInterval(() => void keepTick(), keepAliveMs);
    keepAliveTimer.unref?.();
    // cordis 4：onDispose 已移除，改用 effect（execute 立即执行，返回的 disposer 在 fiber 销毁时运行）
    ctx.effect(() => () => clearInterval(keepAliveTimer));
  }

  // ---------- 按需代理守护（autoProxy）：平时直连，失败/变慢自动启用代理，恢复自动停 ----------
  let autoProxy = null;
  if (cfg().autoProxy) {
    autoProxy = startAutoProxy({ proxy, config: cfg(), log: (m) => console.log(m) });
    ctx.effect(() => () => autoProxy?.dispose());
  }

  const j = (v) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

  const formatStatus = (st) => {
    const lines = [];
    lines.push(`hysteria: ${st.hysteria.running ? "✅ 运行中" : "❌ 未运行"}${st.hysteria.pids.length ? `（pid ${st.hysteria.pids.join(",")}）` : ""}`);
    lines.push(`auth-proxy: ${st.authProxy.running ? "✅ 运行中" : "❌ 未运行"}${st.authProxy.pids.length ? `（pid ${st.authProxy.pids.join(",")}）` : ""}`);
    lines.push(`端口: HTTP ${st.ports.http ? "✅" : "❌"} :${cfg().httpPort}  SOCKS5 ${st.ports.socks ? "✅" : "❌"} :${cfg().socksPort}  Auth ${st.ports.auth ? "✅" : "❌"} :${cfg().authPort}`);
    lines.push(`连通性: ${st.connected ? "✅ 可访问外网" : "❌ 代理不可达外网"}`);
    if (st.egressIp) lines.push(`本机出口 IP: ${st.egressIp}${st.proxyEgressIp ? `（经代理出口 ${st.proxyEgressIp}）` : ""}`);
    if (st.creds) lines.push(`auth 凭据: ${st.creds.name}（来源 ${st.creds.source}）`);
    if (st.autoproxy) {
      const ap = st.autoproxy;
      const probe = ap.lastProbe
        ? ap.lastProbe.bad.length
          ? `直连异常：${ap.lastProbe.bad.map((b) => `${b.target}(${b.error || b.ms + "ms"})`).join(", ")}`
          : `直连健康（${ap.lastProbe.results.map((r) => `${r.target} ${r.ms}ms`).join(" / ")}）`
        : "探测中…";
      lines.push(`按需模式: ${ap.state === "proxied" ? "🟢 已启用代理" : "⚪ 直连"}（${probe}）`);
    }
    lines.push(`监听: ${st.listen || "127.0.0.1"}（仅本机${st.server ? `；服务器 ${st.server}` : ""}）`);
    lines.push(`配置目录: ${st.home}`);
    return lines.join("\n");
  };

  ctx.tools.register(
    defineTool({
      name: "proxy_status",
      description:
        "查询本机 hysteria 代理状态（hysteria/auth-proxy 进程、HTTP/SOCKS5/Auth 端口监听、经代理访问外网的连通性）。开发时网络不通先看这个。宿主机只读工具。",
      parameters: {},
      output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
      async execute() {
        const st = await proxy.status();
        st.autoproxy = autoProxy?.state() ?? null;
        return formatStatus(st);
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "proxy_start",
      description:
        "启动本机 hysteria 代理（hysteria client + 内置 Node auth-proxy，后台运行，日志写入代理目录/*.log）。config.yaml 缺失时按配置的 server 参数自动生成（默认仅监听 127.0.0.1，本机外不可访问）。幂等：已在运行则跳过。启动后可用 HTTPS_PROXY=http://127.0.0.1:7890 或 socks5://127.0.0.1:1080 走代理。宿主机操作。",
      parameters: {},
      output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
      async execute() {
        const r = await proxy.start();
        if (!r.ok) return `❌ 启动失败：${r.error ?? "未知错误"}`;
        const parts = [`✅ 代理就绪${r.alreadyRunning ? "（已在运行）" : ""}`];
        if (r.started.length) parts.push(`本次启动: ${r.started.join("、")}`);
        parts.push(formatStatus(r.status));
        parts.push("用法: HTTPS_PROXY=http://127.0.0.1:7890（或 socks5://127.0.0.1:1080）");
        return parts.join("\n");
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "proxy_stop",
      description:
        "停止本机 hysteria 代理（hysteria + auth-proxy）。幂等：未运行则返回现状。宿主机操作。",
      parameters: {},
      output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
      async execute() {
        const r = await proxy.stop();
        const stopped = r.stopped.hysteria + r.stopped.authProxy;
        return `${stopped > 0 ? `已停止 ${r.stopped.hysteria} 个 hysteria、${r.stopped.authProxy} 个 auth-proxy 进程` : "代理未在运行"}\n${formatStatus(r.status)}`;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "proxy_restart",
      description:
        "重启本机 hysteria 代理（stop → start）。用于换出口 IP、代理异常、网络恢复等场景。宿主机操作。",
      parameters: {},
      output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
      async execute() {
        const r = await proxy.restart();
        if (!r.ok) return `❌ 重启失败：${r.error ?? "未知错误"}`;
        return `✅ 代理已重启\n${formatStatus(r.status)}`;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "proxy_check",
      description:
        "检测本机代理连通性：经代理（http://127.0.0.1:<authPort>）请求一个 204 URL，返回能否访问外网。只读。",
      parameters: {},
      output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
      async execute() {
        const ok = await proxy.check();
        return ok ? "✅ 代理连通，可访问外网" : "❌ 代理不可达外网（检查 hysteria 是否运行、服务器是否可连）";
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "proxy_diag",
      description:
        "查看 hysteria/auth-proxy 进程生命周期诊断日志（SPAWN/EXIT 及退出码/信号/存活时长/末尾输出 + 分类提示），用于定位代理崩溃/被杀的根因。只读。",
      parameters: {},
      output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
      async execute() {
        const d = await proxy.diag();
        return d ? d : "暂无诊断记录（~/.hysteria/diag.log 为空或不存在）";
      },
    }),
  );

  // 跨平台 shell 执行（Windows cmd /c，POSIX /bin/sh -c），可附加代理环境变量
  const runShell = (cmd, extraEnv = {}, timeoutMs) => {
    const env = { ...process.env, ...extraEnv };
    const argv =
      process.platform === "win32"
        ? [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", cmd]]
        : ["/bin/sh", ["-c", cmd]];
    try {
      const r = spawnSync(argv[0], argv[1], { encoding: "utf8", timeout: timeoutMs, env, maxBuffer: 8 * 1024 * 1024 });
      const out = (r.stdout || "").trim();
      const err = (r.stderr || "").trim();
      return { code: r.status ?? -1, output: out + (err ? "\n[stderr] " + err : "") };
    } catch (e) {
      return { code: -1, output: "spawn error: " + e.message };
    }
  };

  ctx.tools.register(
    defineTool({
      name: "proxy_retry",
      description:
        "执行命令，直连失败（非 0 退出或超时）时自动启用代理并以 HTTPS_PROXY/HTTP_PROXY 环境变量重试一次。用于 git push / npm install / curl 等外网任务：遇到不能访问或下载慢时自动走代理，网络正常时直连不受影响。宿主机操作。",
      parameters: {
        command: { type: "string", description: "要执行的命令，如 'git push origin main' 或 'npm install'" },
        timeoutMs: { type: "number", description: "单次执行超时（ms），默认 120000" },
      },
      output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
      async execute(args) {
        const cmd = String(args.command || "").trim();
        if (!cmd) return "请提供 command（如 git push origin main / npm install）";
        const timeout = Number(args.timeoutMs) || 120000;
        const httpUrl = "http://127.0.0.1:" + (Number(cfg().httpPort) || 7890);
        const socksUrl = "socks5://127.0.0.1:" + (Number(cfg().socksPort) || 1080);
        const direct = runShell(cmd, {}, timeout);
        if (direct.code === 0) return "✅ 直连成功\n" + (direct.output || "(无输出)");
        const st = await proxy.status();
        if (!st.hysteria.running) {
          const r = await proxy.start();
          if (!r.ok) return "❌ 直连失败，且代理启动失败：" + r.error + "\n\n直连输出：\n" + (direct.output || "(无输出)");
        }
        const proxied = runShell(cmd, { HTTPS_PROXY: httpUrl, HTTP_PROXY: httpUrl, ALL_PROXY: socksUrl }, timeout);
        if (proxied.code === 0)
          return "✅ 直连失败，自动启用代理并重试成功\n\n直连输出：\n" + (direct.output || "(无输出)") + "\n\n代理重试输出：\n" + (proxied.output || "(无输出)");
        return "❌ 直连与代理均失败\n\n直连输出：\n" + (direct.output || "(无输出)") + "\n\n代理输出：\n" + (proxied.output || "(无输出)");
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "proxy_fix_aliyun",
      description:
        "阿里云安全组出口 IP 检测与修复（需 config.aliyun 已配置）。对比本机当前出口 IP 与安全组已放行 IP：默认只读返回差异与将执行的 aliyun 命令；传 apply=true 时执行新增（只增不删，宽容期并存，绝不删旧规则防锁死 SSH），成功后自动重启本机代理。宿主机操作，执行前请先向用户确认。",
      parameters: {
        apply: { type: "boolean", description: "是否实际执行修复（默认 false 只读对比）" },
      },
      output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
      async execute(args) {
        const r = await proxy.aliyun({ apply: args.apply === true });
        if (!r.ok) return `❌ ${r.error}`;
        const lines = [];
        lines.push(`当前出口 IP: ${r.currentIp}`);
        lines.push(`安全组已放行: ${r.allowedIps.length ? r.allowedIps.join(", ") : "（空）"}`);
        lines.push(`IP 是否已放行: ${r.ipAllowed ? "✅ 是，无需修复" : "❌ 否，需要修复"}`);
        if (r.commands.length) {
          lines.push(`将执行（${r.region} / ${r.securityGroupId}）:`);
          lines.push(r.commands.join("\n"));
          if (r.executed) {
            lines.push("执行结果:");
            for (const e of r.executed) lines.push(`  [${e.ok ? "✅" : "❌"}] ${e.cmd}${e.out ? ` → ${e.out}` : ""}`);
          }
          if (r.fixed) lines.push("✅ 修复完成，代理已重启");
        } else if (r.ipAllowed) {
          lines.push("无需任何操作。");
        }
        return lines.join("\n");
      },
    }),
  );

  // ---------- DSH 设置页卡片数据源：只读 status-ui（仅回环 webServer、免鉴权）----------
  const webServer = ctx.get("webServer");
  const statusUiHandler = async (req, res) => {
    const st = await proxy.status();
    st.autoproxy = autoProxy?.state() ?? null;
    const body = JSON.stringify({
      ok: st.ok,
      connected: st.connected,
      hysteria: st.hysteria,
      authProxy: st.authProxy,
      ports: st.ports,
      egressIp: st.egressIp,
      proxyEgressIp: st.proxyEgressIp,
      autoproxy: st.autoproxy,
      home: st.home,
      credsUser: st.creds?.name ?? null,
      aliyunConfigured: !!cfg().aliyun?.securityGroupId,
    });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(body);
  };
  const disposeStatusUi = webServer?.register({ kind: "exact", path: "/dsh-bridge/proxy/status-ui", handler: statusUiHandler });
  // cordis 4 不派发 "dispose" 事件，同样改用 effect 注册销毁回调
  ctx.effect(() => () => disposeStatusUi?.());
}
