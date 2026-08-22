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
      const connected = data?.connected;

      // 风格与 DSH 内置插件卡片（终端/Agent循环/网页搜索）一致：名称 + 副标题描述 + 内容
      return React.createElement(
        "div",
        { style: base },
        React.createElement(
          "div",
          { style: { marginBottom: 6 } },
          React.createElement(
            "div",
            { style: { fontSize: 15, fontWeight: 600, lineHeight: 1.4, color: "var(--dsw-alias-label-primary)" } },
            "Hysteria 代理" +
              (data ? (connected ? " · 连通 ✅" : " · 不通 ❌") : "")
          ),
          React.createElement(
            "div",
            { style: { fontSize: 13, lineHeight: 1.5, color: "var(--dsw-alias-label-tertiary)", marginTop: 2 } },
            "本机 hysteria 隧道与 auth 转发代理状态。"
          )
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

    // 注入全局样式：让 DSH 设置页插件列表卡片分界更清晰
    const CSS_ID = "hysteria-dsh-plugin/card-enhance.css";
    if (typeof document !== "undefined" && !document.querySelector("style[data-plugin-css=\"" + CSS_ID + "\"]")) {
      const style = document.createElement("style");
      style.dataset.plugin = "hysteria-dsh-plugin";
      style.dataset.pluginCss = CSS_ID;
      style.textContent = [
        // 插件卡片间距加大 + 立体阴影，分界更清晰
        ".pbvGtq_cards{gap:16px}",
        ".YyYd_a_card{margin:0;border-radius:14px;box-shadow:0 2px 8px rgba(0,0,0,.14);border:1px solid var(--dsw-alias-border-l2)}",
        ".YyYd_a_header{padding:16px 18px}",
        ".YyYd_a_body{margin:0 18px;padding:12px 0 18px}",
        // 卡片名称略大，突出
        ".YyYd_a_name{font-size:15px;font-weight:600}",
        // 我们的状态卡片主题色强调（Hysteria / 百花 卡片标题）
        ".YyYd_a_name em { color: var(--dsw-alias-brand-primary); font-style: normal; }",
      ].join("\n");
      document.head.appendChild(style);
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
