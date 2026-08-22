/**
 * hysteria-dsh-plugin 客户端模块（DSH Web UI 侧）。
 *
 * 由 DSH 客户端模块系统按 lazy-CJS factory 格式加载（window.__ModuleLoader__.load）。
 *
 * 作用：在 DSH 设置 → 插件页注册一张「Hysteria 代理」卡片——展示代理状态
 * （hysteria/auth-proxy 进程、端口监听、连通性、出口 IP），每 10s 自动刷新，
 * 并提供启动/停止/重启按钮。
 * 数据源：host 侧 /dsh-bridge/proxy/status-ui（仅 127.0.0.1 webServer、免鉴权、只读）。
 * 操作：通过 DSH 工具无法从卡片直接调——卡片按钮跳转提示使用 agent 或终端命令；
 * 保持卡片只读展示（安全，不引入新的写接口）。
 */
window.__ModuleLoader__.load({
  id: "hysteria-dsh-plugin",
  factory(require) {
    const React = require("react");
    const { useState, useEffect, useCallback } = React;

    const STATUS_URL = "/dsh-bridge/proxy/status-ui";

    function HysteriaProxyCard(_props) {
      const [data, setData] = useState(null);
      const [err, setErr] = useState(null);

      const load = useCallback(async () => {
        try {
          const res = await fetch(STATUS_URL, { cache: "no-store" });
          if (!res.ok) throw new Error("HTTP " + res.status);
          const json = await res.json();
          setData(json);
          setErr(null);
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e));
        }
      }, []);

      useEffect(() => {
        load();
        const timer = setInterval(load, 10000);
        return () => clearInterval(timer);
      }, [load]);

      const base = { fontFamily: "inherit", fontSize: 13, lineHeight: 1.6 };
      const row = { padding: "2px 0", whiteSpace: "nowrap" };
      const badge = (ok) => (ok ? "✅" : "❌");

      return React.createElement(
        "div",
        { style: base },
        React.createElement(
          "div",
          { style: { fontWeight: 600, marginBottom: 6 } },
          "Hysteria 代理" + (data ? (data.connected ? " · 连通 ✅" : " · 不通 ❌") : "")
        ),
        err
          ? React.createElement("div", { style: { color: "#c0392b" } }, "加载失败：" + err)
          : !data
            ? React.createElement("div", { style: { color: "#888" } }, "加载中…")
            : React.createElement(
                "div",
                null,
                React.createElement(
                  "div",
                  { style: row },
                  "hysteria: " + (data.hysteria?.running ? "运行中" : "未运行") +
                    (data.hysteria?.pids?.length ? "（pid " + data.hysteria.pids.join(",") + "）" : "")
                ),
                React.createElement(
                  "div",
                  { style: row },
                  "auth-proxy: " + (data.authProxy?.running ? "运行中" : "未运行") +
                    (data.authProxy?.pids?.length ? "（pid " + data.authProxy.pids.join(",") + "）" : "")
                ),
                React.createElement(
                  "div",
                  { style: row },
                  "端口: HTTP " + badge(data.ports?.http) + " :7890 · SOCKS5 " + badge(data.ports?.socks) +
                    " :1080 · Auth " + badge(data.ports?.auth) + " :7891"
                ),
                React.createElement(
                  "div",
                  { style: row },
                  "连通性: " + (data.connected ? "✅ 可访问外网" : "❌ 不可达")
                ),
                data.egressIp
                  ? React.createElement(
                      "div",
                      { style: row },
                      "出口 IP: " + data.egressIp + (data.proxyEgressIp ? "（经代理 " + data.proxyEgressIp + "）" : "")
                    )
                  : null,
                React.createElement(
                  "div",
                  { style: row, color: "#888", fontSize: 12 },
                  "配置目录: " + data.home + (data.aliyunConfigured ? " · 阿里云自动修复已配置" : "")
                ),
                React.createElement(
                  "div",
                  { style: { marginTop: 6, color: "#888", fontSize: 12 } },
                  "启停/重启/修复请让 agent 调用 proxy_start / proxy_stop / proxy_restart / proxy_fix_aliyun"
                )
              )
      );
    }

    return {
      name: "dsh-hysteria-proxy-client",
      inject: ["slots"],
      apply(ctx) {
        ctx.slots.inject("settings.plugin.item", function* () {
          yield ctx.slots.register(
            {
              name: "settings.plugin.item",
              key: "hysteria",
              locale: "settings.hysteria",
              inject: () => ({}),
            },
            HysteriaProxyCard
          );
        });
      },
    };
  },
});
