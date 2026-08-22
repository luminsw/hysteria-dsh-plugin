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

export const name = "dsh-hysteria-proxy";

/** DSH 设置页插件卡片命名空间（客户端卡片以同名 key 注册）。 */
const SETTINGS_NS = settingsNamespace("hysteria");

export const inject = ["tools", "webServer"];

export const Config = z.object({
  /** hysteria 配置目录（含 config.yaml / start.sh / auth-proxy.py）。 */
  home: z.string().default("~/.hysteria"),
  /** hysteria 可执行文件（PATH 中或绝对路径）。 */
  hysteriaBin: z.string().default("hysteria"),
  /** hysteria HTTP 代理端口。 */
  httpPort: z.number().default(7890),
  /** hysteria SOCKS5 端口。 */
  socksPort: z.number().default(1080),
  /** auth-proxy（Basic Auth HTTP 转发）监听端口。 */
  authPort: z.number().default(7891),
  /** auth-proxy Basic Auth 用户名（默认空=从 ~/.hysteria/auth-proxy.py 源码读取）。 */
  authUser: z.string().default(""),
  /** auth-proxy Basic Auth 密码（默认空=从 ~/.hysteria/auth-proxy.py 源码读取）。 */
  authPass: z.string().default(""),
  /** 连通性检测目标 URL（应返回 2xx/204）。 */
  checkUrl: z.string().default("https://www.gstatic.com/generate_204"),
  /**
   * 阿里云安全组配置（出口 IP 变化自动修复用；默认不启用）。
   * 例：{ regionId: "ap-northeast-1", securityGroupId: "sg-xxx", cli: "aliyun",
   *       ports: [{ protocol: "udp", port: "443/443" }, { protocol: "tcp", port: "22/22" }, { protocol: "icmp", port: "-1/-1" }] }
   */
  aliyun: z.any().default(undefined),
});

export function apply(ctx, config) {
  const proxy = createProxyOps(config);

  // ---------- DSH 设置页命名空间（让「Hysteria 代理」卡片在 DSH UI 设置页渲染）----------
  installSettingsSection(ctx, SETTINGS_NS, Config, config, {
    setSource: () => {},
    onChange: () => {},
  });

  const j = (v) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

  const formatStatus = (st) => {
    const lines = [];
    lines.push(`hysteria: ${st.hysteria.running ? "✅ 运行中" : "❌ 未运行"}${st.hysteria.pids.length ? `（pid ${st.hysteria.pids.join(",")}）` : ""}`);
    lines.push(`auth-proxy: ${st.authProxy.running ? "✅ 运行中" : "❌ 未运行"}${st.authProxy.pids.length ? `（pid ${st.authProxy.pids.join(",")}）` : ""}`);
    lines.push(`端口: HTTP ${st.ports.http ? "✅" : "❌"} :${config.httpPort}  SOCKS5 ${st.ports.socks ? "✅" : "❌"} :${config.socksPort}  Auth ${st.ports.auth ? "✅" : "❌"} :${config.authPort}`);
    lines.push(`连通性: ${st.connected ? "✅ 可访问外网" : "❌ 代理不可达外网"}`);
    if (st.egressIp) lines.push(`本机出口 IP: ${st.egressIp}${st.proxyEgressIp ? `（经代理出口 ${st.proxyEgressIp}）` : ""}`);
    if (st.creds) lines.push(`auth 凭据: ${st.creds.name}（来源 ${st.creds.source}）`);
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
        return formatStatus(st);
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "proxy_start",
      description:
        "启动本机 hysteria 代理（hysteria client + auth-proxy，后台运行，日志写入 ~/.hysteria/*.log）。幂等：已在运行则跳过。启动后可用 HTTPS_PROXY=http://127.0.0.1:7890 或 socks5://127.0.0.1:1080 走代理。宿主机操作。",
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
    const body = JSON.stringify({
      ok: st.ok,
      connected: st.connected,
      hysteria: st.hysteria,
      authProxy: st.authProxy,
      ports: st.ports,
      egressIp: st.egressIp,
      proxyEgressIp: st.proxyEgressIp,
      home: st.home,
      credsUser: st.creds?.name ?? null,
      aliyunConfigured: !!config.aliyun?.securityGroupId,
    });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(body);
  };
  const disposeStatusUi = webServer?.register({ kind: "exact", path: "/dsh-bridge/proxy/status-ui", handler: statusUiHandler });
  ctx.on("dispose", () => disposeStatusUi?.());
}
