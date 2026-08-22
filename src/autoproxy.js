/**
 * autoproxy.js — 按需代理守护（on-demand proxy）。
 *
 * 目标：平时不用代理（直连），当直连访问失败或明显变慢时，自动启动代理并让 git/npm 走代理；
 * 直连恢复并稳定后自动停代理、清除注入，回到直连。全程无需人工介入。
 *
 * 状态机：
 *   idle    — 直连健康，不启用代理
 *   proxied — 直连异常/变慢触发代理（proxy_start + git/npm 注入）；保持至少 minActiveMs，
 *             之后若直连连续 idleStopMs 健康则停代理回 idle
 *
 * 配置（config.autoProxy 开启后生效）：
 *   probeIntervalMs  探测间隔（默认 30000ms）
 *   probeTargets     直连探测目标（默认 github.com + registry.npmjs.org）
 *   slowThresholdMs  直连响应超过该值视为"慢"（默认 2000ms）
 *   failThresholdMs  直连请求超时视为"失败"（默认 10000ms）
 *   minActiveMs      触发后至少保持代理时长，防抖动（默认 5 分钟）
 *   idleStopMs       直连连续健康多久后停代理（默认 2 分钟）
 *   applyToGit       触发时自动 git config --global 注入/清除 http.proxy/https.proxy（默认 true）
 *   applyToNpm       触发时自动 npm config 注入/清除 proxy/https-proxy（默认 true）
 */
import { spawnSync } from "node:child_process";

const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
const PROXY_URL = "http://127.0.0.1:7890"; // http 端口与 createProxyOps 的 httpPort 一致（默认 7890）

export function startAutoProxy({ proxy, config, log = () => {} }) {
  const intervalMs = Number(config.probeIntervalMs) || 30_000;
  const targets = Array.isArray(config.probeTargets) && config.probeTargets.length ? config.probeTargets : ["https://github.com", "https://registry.npmjs.org"];
  const slowMs = Number(config.slowThresholdMs) || 2000;
  const failMs = Number(config.failThresholdMs) || 10_000;
  const minActiveMs = Number(config.minActiveMs) || 5 * 60_000;
  const idleStopMs = Number(config.idleStopMs) || 2 * 60_000;
  const applyToGit = config.applyToGit !== false;
  const applyToNpm = config.applyToNpm !== false;

  let state = "idle"; // idle | proxied
  let proxySince = 0;
  let healthySince = 0; // 直连恢复的起始时刻（proxied 态）
  let lastProbe = null;
  let timer = null;
  let stopped = false;

  /** 直连探测单个目标：返回 { ok, ms, status? }（失败/超时 ok=false）。 */
  async function probeDirect(url) {
    const t0 = Date.now();
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), failMs);
      const res = await fetch(url, { method: "GET", redirect: "follow", signal: ctrl.signal });
      clearTimeout(to);
      const ms = Date.now() - t0;
      return { ok: res.status >= 200 && res.status < 500, ms, status: res.status };
    } catch (e) {
      return { ok: false, ms: Date.now() - t0, error: e.name || String(e.message || e) };
    }
  }

  /** git/npm 全局代理注入（on=true 设置，false 清除）。 */
  function applyProxyConfig(on) {
    try {
      if (applyToGit) {
        if (on) {
          spawnSync("git", ["config", "--global", "http.proxy", PROXY_URL], { encoding: "utf8" });
          spawnSync("git", ["config", "--global", "https.proxy", PROXY_URL], { encoding: "utf8" });
        } else {
          spawnSync("git", ["config", "--global", "--unset-all", "http.proxy"], { encoding: "utf8" });
          spawnSync("git", ["config", "--global", "--unset-all", "https.proxy"], { encoding: "utf8" });
        }
      }
      if (applyToNpm) {
        if (on) {
          spawnSync(npmBin, ["config", "set", "proxy", PROXY_URL], { encoding: "utf8" });
          spawnSync(npmBin, ["config", "set", "https-proxy", PROXY_URL], { encoding: "utf8" });
        } else {
          spawnSync(npmBin, ["config", "delete", "proxy"], { encoding: "utf8" });
          spawnSync(npmBin, ["config", "delete", "https-proxy"], { encoding: "utf8" });
        }
      }
    } catch {
      /* noop */
    }
  }

  async function tick() {
    if (stopped) return;
    const results = [];
    for (const t of targets) results.push({ target: t, ...(await probeDirect(t)) });
    const bad = results.filter((r) => !r.ok || r.ms >= slowMs);
    lastProbe = {
      at: new Date().toISOString(),
      results: results.map((r) => ({ target: r.target, ok: r.ok, ms: r.ms })),
      bad: bad.map((r) => ({ target: r.target, ms: r.ms, error: r.error || (r.ms >= slowMs ? "slow" : "fail") })),
    };

    if (state === "idle") {
      if (bad.length > 0) {
        const st = await proxy.status();
        if (!st.hysteria?.running) {
          const r = await proxy.start();
          if (r.ok) {
            applyProxyConfig(true);
            log(`[autoproxy] 直连异常，自动启用代理：${bad.map((b) => `${b.target}(${b.error || b.ms + "ms"})`).join(", ")}`);
          } else {
            log(`[autoproxy] 触发代理失败：${r.error}`);
          }
        }
        state = "proxied";
        proxySince = Date.now();
        healthySince = 0;
      }
    } else {
      // proxied：直连恢复计时；已过 minActive 且连续 idleStop 健康 → 停代理回 idle
      const now = Date.now();
      if (bad.length === 0) {
        if (!healthySince) healthySince = now;
        if (now - proxySince >= minActiveMs && now - healthySince >= idleStopMs) {
          await proxy.stop();
          applyProxyConfig(false);
          state = "idle";
          proxySince = 0;
          healthySince = 0;
          log("[autoproxy] 直连已恢复，停止代理回到直连");
        }
      } else {
        healthySince = 0;
      }
    }
  }

  timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  setTimeout(() => void tick(), 800).unref?.(); // 启动后尽快探测一次

  return {
    state: () => ({ state, proxySince, healthySince, lastProbe }),
    dispose() {
      stopped = true;
      clearInterval(timer);
      applyProxyConfig(false); // 退出时清除注入，避免残留
    },
  };
}
