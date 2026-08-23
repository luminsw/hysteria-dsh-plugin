/**
 * hysteria-dsh-plugin 客户端模块（DSH Web UI 侧）。
 *
 * 由 DSH 客户端模块系统按 lazy-CJS factory 格式加载（window.__ModuleLoader__.load）。
 *
 * 作用：在 DSH 设置 → 插件页注册一张「Hysteria 代理」卡片——
 *   - 顶部：代理状态（hysteria/auth-proxy 进程、端口、连通性、出口 IP），每 10s 自动刷新；
 *   - 下部：可配置参数表单（代理服务器地址、服务器密码[write-only]、监听地址、端口、
 *     autoStart、检测 URL），绑定 hysteria settings namespace（settingsScope），
 *     保存即写入 DSH 设置（host 侧持久化），宿主 hysteria 运行时读同一设置生效。
 * 数据源：/dsh-bridge/proxy/status-ui（只读）；配置读 settingsScope.bind("hysteria")。
 */
window.__ModuleLoader__.load({
  id: "hysteria-dsh-plugin",
  factory(require) {
    const React = require("react");
    const { useState, useEffect, useCallback } = React;

    const STATUS_URL = "/dsh-bridge/proxy/status-ui";
    const NS = "hysteria";

    // 可配置字段（与 host Config 对齐）
    const FIELDS = [
      { key: "server", label: "代理服务器地址", hint: "如 8.216.46.73:443；未生成 config.yaml 时据此自动生成", type: "text" },
      { key: "serverAuth", label: "服务器密码", hint: "write-only，留空则保持现状；也可经 HYSTERIA_SERVER_AUTH 环境变量提供", type: "password" },
      { key: "listen", label: "监听地址", hint: "安全默认 127.0.0.1（仅本机）", type: "text" },
      { key: "httpPort", label: "HTTP 代理端口", hint: "默认 7890", type: "number" },
      { key: "socksPort", label: "SOCKS5 端口", hint: "默认 1080", type: "number" },
      { key: "authPort", label: "Auth 端口", hint: "默认 7891", type: "number" },
      { key: "checkUrl", label: "连通性检测目标", hint: "应返回 2xx/204", type: "text" },
      { key: "autoStart", label: "DSH 启动时自动拉起代理", hint: "推荐开启", type: "boolean" },
    ];

    const fieldLabel = (key) => (FIELDS.find((f) => f.key === key) || {}).label || key;

    function HysteriaProxyCard(props) {
      // props.scope = settingsScope.bind({ namespace: "hysteria" })（host 注入；可能为 null）
      const scope = props.scope;
      const [data, setData] = useState(null);
      const [err, setErr] = useState(null);
      const [snap, setSnap] = useState(null);
      const [draft, setDraft] = useState({});
      const [saving, setSaving] = useState(false);
      const [saveMsg, setSaveMsg] = useState(null);

      const loadStatus = useCallback(async () => {
        try {
          const res = await fetch(STATUS_URL, { cache: "no-store" });
          if (!res.ok) throw new Error("HTTP " + res.status);
          setData(await res.json());
          setErr(null);
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e));
        }
      }, []);

      useEffect(() => {
        loadStatus();
        const timer = setInterval(loadStatus, 10000);
        return () => clearInterval(timer);
      }, [loadStatus]);

      // 绑定 settings scope：订阅快照，外来变更时回填草稿
      useEffect(() => {
        if (!scope) return;
        const read = () => {
          const s = scope.getSnapshot();
          setSnap(s);
          const v = s.value || {};
          const d = {};
          for (const f of FIELDS) {
            // secret 字段被主机脱敏（wire 上为 undefined），不预填，保持 write-only
            if (f.type === "password") continue;
            d[f.key] = v[f.key] === undefined ? "" : String(v[f.key]);
          }
          setDraft(d);
        };
        read();
        const off = scope.subscribe(read);
        return () => off();
      }, [scope]);

      const setField = (key, raw) => setDraft((d) => ({ ...d, [key]: raw }));

      const save = useCallback(async () => {
        if (!scope || saving) return;
        setSaving(true);
        setSaveMsg(null);
        try {
          const v = (scope.getSnapshot().value) || {};
          const ops = [];
          for (const f of FIELDS) {
            const raw = draft[f.key];
            if (f.type === "password") {
              // write-only：只有用户填了才写入；留空不修改
              const text = String(raw || "").trim();
              if (text) ops.push(() => scope.set(f.key, text));
              continue;
            }
            if (f.type === "boolean") {
              const cur = !!v[f.key];
              const next = raw === true || raw === "true" || raw === "1" || raw === "on";
              if (next !== cur) ops.push(next ? () => scope.set(f.key, true) : () => scope.unset(f.key));
              continue;
            }
            const text = String(raw === undefined ? "" : raw).trim();
            const cur = v[f.key] === undefined ? "" : String(v[f.key]);
            if (text === cur) continue;
            if (f.type === "number") {
              const n = Number(text);
              if (text !== "" && Number.isFinite(n)) ops.push(() => scope.set(f.key, n));
              continue;
            }
            ops.push(text ? () => scope.set(f.key, text) : () => scope.unset(f.key));
          }
          for (const op of ops) await op();
          setSaveMsg({ ok: true, text: "已保存（重启代理后生效）" });
        } catch (e) {
          setSaveMsg({ ok: false, text: "保存失败：" + (e instanceof Error ? e.message : String(e)) });
        } finally {
          setSaving(false);
        }
      }, [scope, draft, saving]);

      const discard = useCallback(() => {
        setSaveMsg(null);
        const v = (scope && scope.getSnapshot().value) || {};
        const d = {};
        for (const f of FIELDS) {
          if (f.type === "password") continue;
          d[f.key] = v[f.key] === undefined ? "" : String(v[f.key]);
        }
        setDraft(d);
      }, [scope]);

      const base = {
        fontFamily: "inherit",
        fontSize: 13,
        lineHeight: 1.6,
        // 与 DSH 内置插件卡片一致：边框 + 背景 + 圆角
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-layer-3)",
        borderRadius: 14,
        boxShadow: "0 2px 8px rgba(0,0,0,.14)",
        padding: "14px 16px",
      };
      const row = { padding: "2px 0", whiteSpace: "nowrap" };
      const badge = (ok) => (ok ? "✅" : "❌");
      const connected = data?.connected;
      const writable = snap && snap.writable !== false;
      const fieldWrap = { display: "flex", flexDirection: "column", gap: 4, padding: "8px 0" };
      const lab = { fontSize: 12, fontWeight: 500, color: "var(--dsw-alias-label-primary)" };
      const inp = {
        font: "inherit", fontSize: 13, color: "var(--dsw-alias-label-primary)",
        background: "var(--dsw-alias-bg-layer-3)", border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: 8, padding: "6px 10px", lineHeight: 1.5,
      };
      const hint = { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", lineHeight: 1.5 };

      // 卡片外层（含样式注入；保留只读状态展示）
      return React.createElement(
        "div",
        { style: base },
        React.createElement(
          "div",
          { style: { marginBottom: 6 } },
          React.createElement(
            "div",
            { style: { fontSize: 15, fontWeight: 600, lineHeight: 1.4, color: "var(--dsw-alias-label-primary)" } },
            "Hysteria 代理" + (data ? (connected ? " · 连通 ✅" : " · 不通 ❌") : "")
          ),
          React.createElement(
            "div",
            { style: { fontSize: 13, lineHeight: 1.5, color: "var(--dsw-alias-label-tertiary)", marginTop: 2 } },
            "本机 hysteria 隧道与 auth 转发代理：状态 + 可配置参数（保存后重启代理生效）。"
          )
        ),
        err
          ? React.createElement("div", { style: { color: "#c0392b" } }, "状态加载失败：" + err)
          : !data
            ? React.createElement("div", { style: { color: "#888" } }, "加载中…")
            : React.createElement(
                "div",
                null,
                React.createElement("div", { style: row }, "hysteria: " + (data.hysteria?.running ? "运行中" : "未运行") + (data.hysteria?.pids?.length ? "（pid " + data.hysteria.pids.join(",") + "）" : "")),
                React.createElement("div", { style: row }, "auth-proxy: " + (data.authProxy?.running ? "运行中" : "未运行") + (data.authProxy?.pids?.length ? "（pid " + data.authProxy.pids.join(",") + "）" : "")),
                React.createElement("div", { style: row }, "端口: HTTP " + badge(data.ports?.http) + " :7890 · SOCKS5 " + badge(data.ports?.socks) + " :1080 · Auth " + badge(data.ports?.auth) + " :7891"),
                React.createElement("div", { style: row }, "连通性: " + (data.connected ? "✅ 可访问外网" : "❌ 不可达")),
                data.egressIp
                  ? React.createElement("div", { style: row }, "出口 IP: " + data.egressIp + (data.proxyEgressIp ? "（经代理 " + data.proxyEgressIp + "）" : ""))
                  : null,
                React.createElement("div", { style: row, color: "#888", fontSize: 12 }, "配置目录: " + data.home + (data.aliyunConfigured ? " · 阿里云自动修复已配置" : ""))
              ),
        scope && snap
          ? React.createElement(
              "div",
              { style: { marginTop: 10, borderTop: "1px solid var(--dsw-alias-border-l2)", paddingTop: 8 } },
              React.createElement(
                "div",
                { style: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)", marginBottom: 4 } },
                "参数配置" + (snap.status === "unavailable" ? "（当前不可编辑）" : "")
              ),
              FIELDS.map((f) => {
                const val = draft[f.key];
                const isNum = f.type === "number";
                const isBool = f.type === "boolean";
                return React.createElement(
                  "div",
                  { key: f.key, style: fieldWrap },
                  React.createElement("label", { style: lab }, f.label),
                  isBool
                    ? React.createElement("label", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 13 } },
                        React.createElement("input", {
                          type: "checkbox",
                          checked: val === true || val === "true" || val === "1" || val === "on",
                          disabled: !writable || saving,
                          onChange: (e) => setField(f.key, e.target.checked),
                        }),
                        React.createElement("span", { style: hint }, "开启"))
                    : React.createElement("input", {
                        style: inp,
                        type: f.type === "password" ? "password" : "text",
                        inputMode: isNum ? "numeric" : undefined,
                        value: val === undefined ? "" : String(val),
                        placeholder: f.type === "password" ? "留空保持现状" : undefined,
                        disabled: !writable || saving,
                        onChange: (e) => setField(f.key, e.target.value),
                      }),
                  React.createElement("div", { style: hint }, f.hint)
                );
              }),
              React.createElement(
                "div",
                { style: { display: "flex", gap: 8, marginTop: 8, alignItems: "center" } },
                React.createElement("button", {
                  style: { font: "inherit", fontSize: 13, padding: "5px 14px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "var(--dsw-alias-label-secondary)", cursor: saving ? "not-allowed" : "pointer" },
                  disabled: saving || !writable,
                  onClick: discard,
                }, "放弃修改"),
                React.createElement("button", {
                  style: { font: "inherit", fontSize: 13, padding: "5px 14px", borderRadius: 8, border: "1px solid transparent", background: "var(--dsw-alias-label-primary)", color: "var(--dsw-alias-bg-layer-3)", cursor: saving ? "not-allowed" : "pointer" },
                  disabled: saving || !writable,
                  onClick: save,
                }, saving ? "保存中…" : "保存"),
                saveMsg
                  ? React.createElement("span", { style: { fontSize: 12, color: saveMsg.ok ? "#2e7d32" : "#c0392b" } }, saveMsg.text)
                  : null,
                React.createElement(
                  "span",
                  { style: { color: "#888", fontSize: 11 } },
                  "启停/重启请让 agent 调用 proxy_start / proxy_stop / proxy_restart"
                )
              )
            )
          : null
      );
    }

    // 注入全局样式：让 DSH 设置页插件列表卡片分界更清晰
    const CSS_ID = "hysteria-dsh-plugin/card-enhance.css";
    if (typeof document !== "undefined" && !document.querySelector("style[data-plugin-css=\"" + CSS_ID + "\"]")) {
      const style = document.createElement("style");
      style.dataset.plugin = "hysteria-dsh-plugin";
      style.dataset.pluginCss = CSS_ID;
      style.textContent = [
        ".pbvGtq_cards{gap:16px}",
        ".YyYd_a_card{margin:0;border-radius:14px;box-shadow:0 2px 8px rgba(0,0,0,.14);border:1px solid var(--dsw-alias-border-l2)}",
        ".YyYd_a_header{padding:16px 18px}",
        ".YyYd_a_body{margin:0 18px;padding:12px 0 18px}",
        ".YyYd_a_name{font-size:15px;font-weight:600}",
        ".YyYd_a_name em { color: var(--dsw-alias-brand-primary); font-style: normal; }",
      ].join("\n");
      document.head.appendChild(style);
    }

    return {
      name: "dsh-hysteria-proxy-client",
      inject: ["slots"],
      apply(ctx) {
        // 绑定 hysteria settings namespace（host 提供 settingsScope 服务；缺失时退化为只读状态卡）
        const settingsScope = ctx.get("settingsScope");
        let scope = null;
        if (settingsScope) {
          try {
            scope = settingsScope.bind({ namespace: NS });
            ctx.onDispose(() => {
              try { scope?.dispose?.(); } catch { /* noop */ }
            });
          } catch (e) {
            console.log("[hysteria] settingsScope.bind 失败，退化为只读状态卡：", e.message);
          }
        }
        ctx.slots.inject("settings.plugin.item", function* () {
          yield ctx.slots.register(
            {
              name: "settings.plugin.item",
              key: NS,
              locale: "settings.hysteria",
              inject: () => ({ scope }),
            },
            HysteriaProxyCard
          );
        });
      },
    };
  },
});
