/**
 * proxy.js — Hysteria 2 客户端 + auth-proxy 进程管理。
 *
 * 运行在 DSH 宿主机（Node 进程），管理 ~/.hysteria 下的代理：
 *   - hysteria client -c config.yaml   → HTTP :7890 / SOCKS5 :1080
 *   - python3 auth-proxy.py            → HTTP :7891（Basic Auth 转发到 :7890）
 * 所有操作幂等：已运行则跳过启动，未运行则停止报错。
 * 进程以 detached + unref 后台运行，日志追加到 home 下的 *.log（与 start.sh 一致）。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const START_TIMEOUT_MS = 15_000;
const CHECK_TIMEOUT_MS = 12_000;
const KILL_GRACE_MS = 3_000;

const isWin = process.platform === "win32";

/** 进程是否存活：win32 用 tasklist（可核对镜像名防 PID 复用误判），POSIX 用 ps。 */
function isAlive(pid, expectImage) {
  if (!pid) return false;
  if (isWin) {
    const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
    if (r.status !== 0) return false;
    // 只按「PID 存在」判断有误报风险：PID 被系统回收复用后（重启/进程退出）会指向别的进程，
    // 导致 stale pid 误判为「运行中」、端口却没监听。必须核对 CSV 首列镜像名
    // （如 "hysteria-windows-amd64.exe" / "node.exe"）。
    const line = r.stdout
      .split("\n")
      .map((s) => s.trim())
      .find((l) => l.includes(`"${pid}"`));
    if (!line) return false;
    if (!expectImage) return true;
    const image = (line.match(/^"([^"]+)"/) || [])[1] || "";
    return expectImage.test(image);
  }
  const r = spawnSync("ps", ["-p", String(pid), "-o", "pid="], { encoding: "utf8" });
  return r.status === 0 && !!r.stdout.trim();
}

/** Windows 专用：读 pid 文件（hysteria.pid / auth-proxy.pid，与 start.ps1 一致）+ 存活校验（核对镜像名）。 */
function pidsFromPidFile(homeDir, file, expectImage) {
  try {
    const pid = Number(String(readFileSync(join(homeDir, file), "utf8")).trim());
    return Number.isInteger(pid) && pid > 0 && isAlive(pid, expectImage) ? [pid] : [];
  } catch {
    return [];
  }
}

/** Python 解释器：win32 优先 python3，缺失回退 python（旧版 auth-proxy.py 兼容用）。 */
function pythonBin() {
  if (!isWin) return "python3";
  const r = spawnSync("where", ["python3"], { encoding: "utf8" });
  return r.status === 0 ? "python3" : "python";
}

/**
 * 按配置生成 hysteria2 客户端 config.yaml（用户无需手写；只填 server / serverAuth 即可）。
 * 安全默认：http/socks5 均只监听 config.listen（默认 127.0.0.1），本机之外不可访问；
 * docker/k8s 容器如需访问，把 listen 配成宿主 docker 网段地址并配合防火墙放行（见 README 安全章节）。
 */
function generateClientConfig(cfg) {
  const listen = cfg.listen || "127.0.0.1";
  const httpPort = Number(cfg.httpPort) || 7890;
  const socksPort = Number(cfg.socksPort) || 1080;
  return [
    `server: ${cfg.server}`,
    `auth: ${cfg.serverAuth || ""}`,
    `tls:`,
    `  insecure: true`,
    `http:`,
    `  listen: ${listen}:${httpPort}`,
    `socks5:`,
    `  listen: ${listen}:${socksPort}`,
    ``,
    `bandwidth:`,
    `  up: 50 mbps`,
    `  down: 100 mbps`,
  ].join("\n") + "\n";
}

/** 展开 ~ 为 home。 */
function expandHome(p) {
  if (!p) return p;
  const home = homedir();
  return p === "~" ? home : p.startsWith("~/") || p.startsWith("~\\") ? home + p.slice(1) : p;
}

/**
 * 从 auth-proxy.py 源码解析 Basic Auth 凭据（USERNAME/PASSWORD）。
 * 用户改 py 里的密码后，插件自动跟随，无需重复配置。
 * 解析失败返回空串——不内置任何默认凭据（密码必须由用户配置）。
 */
function readAuthCreds(pyPath) {
  const user = { name: "", pass: "" };
  try {
    const src = readFileSync(pyPath, "utf8");
    const um = src.match(/USERNAME\s*=\s*"([^"]+)"/);
    const pm = src.match(/PASSWORD\s*=\s*"([^"]+)"/);
    if (um) user.name = um[1];
    if (pm) user.pass = pm[1];
  } catch {
    /* noop */
  }
  return user;
}

/**
 * 按命令行特征找 hysteria client 进程。
 * 用字符类技巧（[h]ysteria）防止 pgrep -f 匹配到 pgrep/bash 自身（命令行含同样模式串）。
 * start.sh 用相对路径（-c config.yaml），插件用绝对路径（-c <home>/config.yaml），两种都覆盖。
 */
function findHysteriaPids(home) {
  if (isWin) return pidsFromPidFile(expandHome(home), "hysteria.pid", /hysteria/i);
  const r = spawnSync("pgrep", ["-f", "[h]ysteria client -c .*config\\.ya?ml"], { encoding: "utf8" });
  if (r.status !== 0) return [];
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean).map(Number);
}

/** 按命令行特征找 auth-proxy 进程（兼容内置 Node authproxy.js 与旧 python3 auth-proxy.py；同样防自匹配）。 */
function findAuthProxyPids(home) {
  if (isWin) return pidsFromPidFile(expandHome(home), "auth-proxy.pid", /^node(\.exe)?$/i);
  const r = spawnSync("pgrep", ["-f", "[a]uthproxy\\.js|[p]ython3 .*[a]uth-proxy\\.py"], { encoding: "utf8" });
  if (r.status !== 0) return [];
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean).map(Number);
}

/** 端口是否在监听（ss -tln）。 */
function portListening(port) {
  if (!port) return false;
  if (isWin) {
    const r = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
    if (r.status !== 0) return false;
    const re = new RegExp(`:${port}\\s`);
    return r.stdout.split("\n").some((l) => re.test(l) && l.includes("LISTENING"));
  }
  // POSIX：优先 ss（iproute2）；缺失（Alpine 等精简系统）回退 /proc/net/tcp（Linux 必有）
  const r = spawnSync("ss", ["-tln"], { encoding: "utf8" });
  if (r.status === 0) return r.stdout.split("\n").some((l) => l.includes(`:${port}`));
  try {
    const hex = port.toString(16).toUpperCase().padStart(4, "0");
    return readFileSync("/proc/net/tcp", "utf8")
      .split("\n")
      .some((l) => l.includes(`:${hex} `) && /\s0A\s/.test(l)); // 0A = LISTEN
  } catch {
    return false;
  }
}

function killPids(pids, label) {
  if (!pids.length) return;
  if (isWin) {
    for (const pid of pids) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8" });
    return;
  }
  spawnSync("kill", pids.map(String), { encoding: "utf8" });
  // 优雅等待；仍存活则强杀
  const deadline = Date.now() + KILL_GRACE_MS;
  while (Date.now() < deadline) {
    const alive = spawnSync("ps", ["-o", "pid=", "-p", pids.join(",")], { encoding: "utf8" });
    if (alive.status !== 0 || !alive.stdout.trim()) break;
    spawnSync("sleep", ["0.2"]);
  }
  const still = spawnSync("ps", ["-o", "pid=", "-p", pids.join(",")], { encoding: "utf8" });
  if (still.status === 0 && still.stdout.trim()) {
    spawnSync("kill", ["-9", ...pids.map(String)], { encoding: "utf8" });
  }
}

/** 读取进程是否存活（pid 存在）。 */
function alive(pid) {
  return isAlive(pid);
}

/** 生成一次性启动日志（与 start.sh 的 nohup 语义一致）。 */
function logTo(home, file, lines) {
  try {
    appendFileSync(join(expandHome(home), file), lines.map((l) => `\n${new Date().toISOString()} ${l}`).join(""));
  } catch {
    /* noop */
  }
}

/** 依据退出码/信号给一个指向性提示（帮助定位代理崩溃根因）。 */
function classifyExit(code, signal) {
  if (signal === "SIGKILL" || Number(code) === 137) return "疑似被 OOM/内核 SIGKILL 杀掉（查 dmesg、内存占用）";
  if (signal === "SIGSEGV") return "疑似崩溃：SIGSEGV 内存越界";
  if (signal === "SIGBUS") return "疑似崩溃：SIGBUS 总线错误";
  if (signal === "SIGABRT") return "疑似崩溃：SIGABRT 中断（Go runtime panic？）";
  if (signal === "SIGTERM") return "被 SIGTERM 正常终止";
  if (signal === "SIGHUP") return "被 SIGHUP 终止（会话/终端挂断？）";
  if (Number(code) === 0) return "正常退出";
  if (signal) return `被信号 ${signal} 终止（非零退出）`;
  return `异常退出（exit code=${code}）`;
}

export function createProxyOps(getConfigOrObj, deps = {}) {
  // settings 表单可改 server / serverAuth；其余派生值构造时读一次（极少改）。
  const cfg = () => (typeof getConfigOrObj === "function" ? getConfigOrObj() : getConfigOrObj);
  const home = cfg().home || "~/.hysteria";
  const hysteriaBin = cfg().hysteriaBin ? expandHome(cfg().hysteriaBin) : "hysteria";
  const httpPort = Number(cfg().httpPort) || 7890;
  const socksPort = Number(cfg().socksPort) || 1080;
  const authPort = Number(cfg().authPort) || 7891;
  const checkUrl = cfg().checkUrl || "https://www.gstatic.com/generate_204";
  const homeDir = expandHome(home);
  // 诊断：进程生命周期（SPAWN/EXIT + 退出码/信号/存活时长/末尾输出）写入 home/diag.log，供 proxy_diag 只读查看。
  const diagLog = join(homeDir, "diag.log");
  const spawned = new Map(); // pid -> { type, child, startedAt, tail }
  const diagAppend = (s) => { try { appendFileSync(diagLog, s); } catch { /* noop */ } };
  /** 包装子进程：转发 stdout/stderr 到对应 log，并捕获退出码/信号写诊断日志。
   * onFail(detail)：spawn 失败或非零退出时回调（供 start() 收集真实失败原因，避免外部只能看到“未知”）。 */
  function watchChild(type, child, logFile, onFail) {
    const t = Date.now();
    const pid = child.pid;
    let tail = "";
    diagAppend(`\n${new Date().toISOString()} [${type}] SPAWN pid=${pid ?? "-"} cmd=${(Array.isArray(child.spawnargs) ? child.spawnargs.join(" ") : "")}\n`);
    child.stdout.on("data", (d) => { const s = d.toString(); tail = (tail + s).slice(-2048); try { appendFileSync(logFile, s); } catch { /* noop */ } });
    child.stderr.on("data", (d) => { const s = d.toString(); tail = (tail + s).slice(-2048); try { appendFileSync(logFile, s); } catch { /* noop */ } });
    child.on("error", (e) => {
      tail = (tail + `\n[spawn-error] ${e.message}`).slice(-2048);
      diagAppend(`\n${new Date().toISOString()} [${type}] SPAWN-ERROR pid=${pid ?? "-"} ${e.message}\n`);
      try { appendFileSync(logFile, `\n${new Date().toISOString()} [plugin] ${type} 启动失败：${e.message}\n`); } catch { /* noop */ }
      onFail?.(`spawn 失败：${e.message}`);
    });
    child.on("exit", (code, signal) => {
      const secs = Math.round((Date.now() - t) / 1000);
      const why = classifyExit(code, signal);
      const ttail = tail.trim() ? ` | 末尾输出: ${tail.trim().replace(/\s+/g, " ").slice(-180)}` : "";
      diagAppend(`\n${new Date().toISOString()} [${type}] EXIT pid=${pid} code=${code} signal=${signal} uptime=${secs}s ${why}${ttail}\n`);
      spawned.delete(pid);
      if (code !== 0 || signal) onFail?.(`进程退出 code=${code} signal=${signal ?? "-"}（${why}）`);
    });
    spawned.set(pid, { type, child, startedAt: t });
    child.unref();
    return child;
  }
  const listenAddr = () => cfg().listen || "127.0.0.1";
  // server / serverAuth 动态读（settings 表单可改）：每次按需解析，支持 env 引用与配置字面量。
  const server = () => (cfg().serverEnv ? process.env[cfg().serverEnv] || cfg().server || "" : cfg().server || "");
  const serverAuth = () => (cfg().serverAuthEnv ? process.env[cfg().serverAuthEnv] || cfg().serverAuth || "" : cfg().serverAuth || "");

  /** auth-proxy 凭据：配置显式指定优先，否则从 auth-proxy.py 读取。 */
  function creds() {
    const fromPy = readAuthCreds(join(homeDir, "auth-proxy.py"));
    return {
      name: cfg().authUser || fromPy.name,
      pass: cfg().authPass || fromPy.pass,
      source: cfg().authUser || cfg().authPass ? "config" : "auth-proxy.py",
    };
  }

  /** 本机出口 IP（直连 ifconfig.me）。 */
  function egressIp() {
    const r = spawnSync("curl", ["-s", "--max-time", "10", "https://ifconfig.me"], { encoding: "utf8", timeout: 12_000 });
    if (r.status !== 0) return null;
    const ip = r.stdout.trim();
    return /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null;
  }

  /** IPv4 字符串 → 32 位整数（非法返回 null）。 */
  function ipv4ToInt(s) {
    const m = String(s).match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return null;
    const parts = m.slice(1).map(Number);
    if (parts.some((p) => p < 0 || p > 255)) return null;
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  }

  /** 经代理的出口 IP（验证代理出口；走 auth 端口带凭据）。 */
  function proxiedEgressIp() {
    const c = creds();
    const proxyUrl = `http://${c.name}:${c.pass}@127.0.0.1:${authPort}`;
    const r = spawnSync("curl", ["-s", "--max-time", "15", "-x", proxyUrl, "https://ifconfig.me"], { encoding: "utf8", timeout: 18_000 });
    if (r.status !== 0) return null;
    const ip = r.stdout.trim();
    return /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null;
  }

  /** 当前状态总览：进程 / 端口 / 连通性 / 出口 IP。 */
  async function status() {
    const hPids = findHysteriaPids(home);
    const aPids = findAuthProxyPids(home);
    const httpUp = portListening(httpPort);
    const socksUp = portListening(socksPort);
    const authUp = portListening(authPort);
    const connected = await check();
    return {
      ok: hPids.length > 0,
      hysteria: { running: hPids.length > 0, pids: hPids },
      authProxy: { running: aPids.length > 0, pids: aPids },
      ports: { http: httpUp, socks: socksUp, auth: authUp },
      connected,
      egressIp: egressIp(),
      proxyEgressIp: connected ? proxiedEgressIp() : null,
      creds: { ...creds(), pass: "****" },
      home: homeDir,
      listen: listenAddr(),
      server: server() || null,
      serverAuthSource: cfg().serverAuthEnv ? "env:" + cfg().serverAuthEnv : cfg().serverAuth ? "config" : null,
    };
  }

  /** 连通性检测：优先经 auth 端口（带 Basic Auth），未监听时回退直连 hysteria HTTP 端口。 */
  async function check() {
    const c = creds();
    const attempts = [];
    if (portListening(authPort)) {
      attempts.push(`http://${c.name}:${c.pass}@127.0.0.1:${authPort}`);
    }
    attempts.push(`http://127.0.0.1:${httpPort}`);
    for (const proxyUrl of attempts) {
      const args = ["-sS", "-o", isWin ? "NUL" : "/dev/null", "-w", "%{http_code}", "-x", proxyUrl, "--max-time", "10", checkUrl];
      const r = spawnSync("curl", args, { encoding: "utf8", timeout: CHECK_TIMEOUT_MS });
      if (r.status !== 0) continue;
      const code = Number(r.stdout.trim());
      if (code === 204 || (code >= 200 && code < 400)) return true;
    }
    return false;
  }

  /** 启动 hysteria + auth-proxy（幂等）。返回启动详情。 */
  async function start() {
    const existed = findHysteriaPids(home).length > 0;
    const out = { started: [], alreadyRunning: existed };
    const errors = []; // 本次启动收集的子进程失败原因（spawn 错误/非零退出）


    const cfgPath = join(homeDir, "config.yaml");
    if (!existsSync(cfgPath)) {
      if (!server()) {
        return { ok: false, error: `未找到 ${cfgPath} 且未配置 server（如 8.216.46.73:443）。请提供代理服务器参数，或手动放置 config.yaml。` };
      }
      // 用户只填了服务器参数 → 自动生成客户端配置（默认仅监听 127.0.0.1）
      mkdirSync(homeDir, { recursive: true });
      writeFileSync(cfgPath, generateClientConfig({ ...cfg(), server: server(), serverAuth: serverAuth() }));
      out.started.push("config.yaml(自动生成)");
      logTo(home, "client.log", [`[plugin] 已按配置生成 config.yaml（server=${server()}，listen=${listenAddr()}）`]);
    }

    // 1) hysteria client
    if (!existed) {
      mkdirSync(homeDir, { recursive: true });
      const child = spawn(
        hysteriaBin,
        ["client", "-c", join(homeDir, "config.yaml")],
        { cwd: homeDir, detached: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
      // 捕获退出码/信号写诊断日志（定位崩溃根因）；stdout/stderr 转发到 client.log。
      watchChild("hysteria", child, join(homeDir, "client.log"), (d) => errors.push(`hysteria: ${d}`));
      if (isWin && child.pid) {
        try { writeFileSync(join(homeDir, "hysteria.pid"), String(child.pid)); } catch { /* noop */ }
      }
      out.started.push("hysteria");
      logTo(home, "client.log", ["[plugin] hysteria 已启动"]);
    }

    // 2) 内置 Node auth-proxy（Basic Auth 转发代理，替代 python3 auth-proxy.py，零 python 依赖）
    if (!findAuthProxyPids(home).length) {
      const c = creds();
      const authProxyScript = fileURLToPath(new URL("./authproxy.js", import.meta.url));
      const child = spawn(
        process.execPath,
        [authProxyScript, "--listen", `127.0.0.1:${authPort}`, "--upstream", `127.0.0.1:${httpPort}`],
        {
          cwd: homeDir,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          env: { ...process.env, AUTH_PROXY_USER: c.name, AUTH_PROXY_PASS: c.pass },
        },
      );
      watchChild("auth-proxy", child, join(homeDir, "auth-proxy.log"), (d) => errors.push(`auth-proxy: ${d}`));
      if (isWin && child.pid) {
        try { writeFileSync(join(homeDir, "auth-proxy.pid"), String(child.pid)); } catch { /* noop */ }
      }
      out.started.push("auth-proxy(内置 Node)");
      logTo(home, "auth-proxy.log", ["[plugin] auth-proxy(内置 Node) 已启动"]);
    }

    // 等待端口就绪（最多 START_TIMEOUT_MS）
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (portListening(httpPort) && portListening(socksPort)) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    const st = await status();
    out.ok = st.hysteria.running;
    out.status = st;
    if (!out.ok) {
      // 失败必须带真实原因（此前只返回 ok:false → 外部日志永远显示“未知”）
      const hErr = errors.find((e) => e.startsWith("hysteria:"));
      out.error = hErr
        ? `hysteria 客户端未能启动：${hErr.slice("hysteria: ".length)}（hysteriaBin=${hysteriaBin}；详见 ${diagLog}）`
        : `hysteria 客户端未在运行（端口 ${httpPort}/${socksPort} 未监听；config=${join(homeDir, "config.yaml")}）`;
    } else if (!st.authProxy.running) {
      const aErr = errors.find((e) => e.startsWith("auth-proxy:"));
      out.error = aErr
        ? `auth-proxy 未在运行：${aErr.slice("auth-proxy: ".length)}`
        : `auth-proxy 未在运行（pid 文件缺失或进程已退出；详见 ${diagLog}）`;
    }
    return out;
  }

  /** 停止 hysteria + auth-proxy（幂等）。 */
  async function stop() {
    const hPids = findHysteriaPids(home);
    const aPids = findAuthProxyPids(home);
    killPids(aPids, "auth-proxy");
    killPids(hPids, "hysteria");
    const st = await status();
    return { ok: !st.hysteria.running, stopped: { hysteria: hPids.length, authProxy: aPids.length }, status: st };
  }

  /** 重启：stop → start。 */
  async function restart() {
    await stop();
    return start();
  }

  /**
   * 阿里云安全组出口 IP 检测与修复。
   *
   * 场景：hysteria 代理服务器（东京 ECS）安全组只放行固定出口 IP；本机出口 IP
   * 变化（宽带重拨）后代理被拦。本函数对比「当前出口 IP」与「安全组已放行 IP」：
   *   - 默认只读：返回差异与将要执行的 aliyun 命令，不实际修改；
   *   - apply=true 时执行新增（只增不删，宽容期并存；绝不删旧规则防锁死 SSH）。
   *
   * 安全组信息走配置（config.aliyun），不硬编码在代码里；默认不碰杭州花阁安全组。
   */
  async function aliyun(opts = {}) {
    const sg = cfg().aliyun;
    if (!sg || !sg.securityGroupId) {
      return { ok: false, error: "未配置阿里云安全组（config.aliyun.securityGroupId），请在 DSH 配置中填写" };
    }
    const region = sg.regionId || "ap-northeast-1";
    const sgId = sg.securityGroupId;
    const ports = sg.ports || [
      { protocol: "udp", port: "443/443" },
      { protocol: "tcp", port: "22/22" },
      { protocol: "icmp", port: "-1/-1" },
    ];
    const cli = sg.cli || "aliyun";

    // 1) 当前出口 IP
    const ip = egressIp();
    if (!ip) return { ok: false, error: "无法获取本机出口 IP（ifconfig.me 不可达）" };

    // 2) 查询安全组现有规则（只读）
    const q = spawnSync(
      cli,
      ["ecs", "DescribeSecurityGroupAttribute", "--RegionId", region, "--SecurityGroupId", sgId],
      { encoding: "utf8", timeout: 30_000 },
    );
    if (q.status !== 0) {
      return { ok: false, error: `aliyun 查询失败：${(q.stderr || q.stdout || "").trim().slice(0, 300)}` };
    }
    let allowed = [];
    try {
      const d = JSON.parse(q.stdout);
      // 阿里云对单 IP 返回裸地址（39.163.177.21，无 /32），网段返回 CIDR（100.104.0.0/16）
      allowed = (d?.Permissions?.Permission ?? [])
        .map((p) => p.SourceCidrIp)
        .filter((v) => typeof v === "string" && /^\d+\.\d+\.\d+\.\d+(\/\d+)?$/.test(v));
    } catch {
      return { ok: false, error: "aliyun 查询输出无法解析" };
    }
    // 匹配：裸 IP 视为 /32；带掩码的按前缀匹配（/24 等网段覆盖 /32 单 IP）
    const ipAllowed = allowed.some((cidr) => {
      const [base, mask] = cidr.split("/");
      if (mask === undefined) return base === ip;
      const bits = Number(mask);
      if (!Number.isInteger(bits) || bits <= 0 || bits > 32) return false;
      const ipInt = ipv4ToInt(ip);
      const baseInt = ipv4ToInt(base);
      if (ipInt == null || baseInt == null) return false;
      const shift = 32 - bits;
      return (ipInt >>> shift) === (baseInt >>> shift);
    });
    const commands = [];
    if (!ipAllowed) {
      for (const p of ports) {
        commands.push(
          `${cli} ecs AuthorizeSecurityGroup --RegionId ${region} --SecurityGroupId ${sgId} --IpProtocol ${p.protocol} --PortRange ${p.port} --SourceCidrIp ${ip}/32 --NicType intranet --Policy accept --Priority 100`,
        );
      }
    }

    const result = {
      ok: true,
      currentIp: ip,
      allowedIps: allowed,
      ipAllowed,
      needsFix: !ipAllowed,
      commands,
      region,
      securityGroupId: sgId,
    };

    // 3) apply=true 且需要修复 → 执行新增规则（只增不删）
    if (opts.apply && !ipAllowed) {
      const executed = [];
      for (const cmd of commands) {
        // Windows 用 cmd /c（aliyun.exe 可直接执行），POSIX 用 bash -lc（aliyun 多为 shell 包装）
        const argv = isWin ? [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", cmd]] : ["bash", ["-lc", cmd]];
        const r = spawnSync(argv[0], argv[1], { encoding: "utf8", timeout: 30_000 });
        const out = (r.stdout || r.stderr || "").trim().slice(0, 200);
        // 容错：ICMP 规则的 -1/-1 端口在部分 aliyun CLI/API 版本被校验拒绝（InvalidParam.PortRange），
        // 仅影响 ping（非隧道/SSH 关键规则）→ 记为跳过，不判修复失败。
        let ok = r.status === 0;
        let skipped = false;
        if (!ok && /icmp/i.test(cmd) && /InvalidParam\.PortRange/i.test(out)) {
          ok = true;
          skipped = true;
        }
        executed.push({ cmd, ok, ...(skipped ? { skipped: true, out: "ICMP 规则被 aliyun CLI/API 拒绝（InvalidParam.PortRange），已跳过（仅影响 ping）" } : { out }) });
      }
      result.executed = executed;
      result.fixed = executed.every((e) => e.ok);
      // 4) 修复后重启本机代理（新出口 IP 需重新建立连接）
      if (result.fixed) {
        await restart();
      }
    }
    return result;
  }

  /** 轻量存活检测：仅查 hysteria/auth-proxy 进程 pids，不做网络/连通性探测（供代理守护 keep-alive 用）。 */
  function alive() {
    return {
      hysteria: findHysteriaPids(home).length > 0,
      authProxy: findAuthProxyPids(home).length > 0,
    };
  }

  /** 读取最近诊断记录（进程 SPAWN/EXIT + 退出码/信号/存活时长/末尾输出），用于定位代理崩溃根因。 */
  function diag() {
    try {
      const lines = readFileSync(diagLog, "utf8").split("\n").filter(Boolean);
      return lines.slice(-80).join("\n");
    } catch {
      return "";
    }
  }

  return { status, check, start, stop, restart, aliyun, alive, diag };
}
