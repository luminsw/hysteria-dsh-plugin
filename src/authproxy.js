#!/usr/bin/env node
/**
 * authproxy.js — 内置 Basic Auth HTTP 转发代理（替代 auth-proxy.py，零 python 依赖）。
 *
 * 由 hysteria-dsh-plugin 的 proxy.js 以独立子进程启动（detached）：
 *   node authproxy.js --listen 127.0.0.1:7891 --upstream 127.0.0.1:7890
 * 环境变量 AUTH_PROXY_USER / AUTH_PROXY_PASS 提供 Basic Auth 凭据（均空则放行，仅限回环场景）。
 *
 * 行为：
 *   - 非 CONNECT 请求：以 absolute-form 转发给 upstream（hysteria HTTP 代理），回传结果
 *   - CONNECT 请求（HTTPS 隧道）：经 server 'connect' 事件处理——先透传 CONNECT 给 upstream，
 *     解析其响应头（200/非 200）后再回客户端 200 并双向中继；非 200 则透传状态
 *   - 未通过 Basic Auth → 407 Proxy Authentication Required
 *   - 仅监听 127.0.0.1（安全默认；容器访问由宿主侧端口映射/转发负责，不对外暴露）
 */
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const LISTEN = arg("listen", "127.0.0.1:7891");
const UPSTREAM = arg("upstream", "127.0.0.1:7890");
const USER = process.env.AUTH_PROXY_USER || "";
const PASS = process.env.AUTH_PROXY_PASS || "";

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function authorized(req) {
  if (!USER && !PASS) return true;
  const h = req.headers["proxy-authorization"] || req.headers["authorization"] || "";
  const m = /^Basic\s+(.+)$/i.exec(h);
  if (!m) return false;
  let decoded = "";
  try {
    decoded = Buffer.from(m[1], "base64").toString("utf8");
  } catch {
    return false;
  }
  const i = decoded.indexOf(":");
  const u = i >= 0 ? decoded.slice(0, i) : decoded;
  const p = i >= 0 ? decoded.slice(i + 1) : "";
  return safeEqual(u, USER) && safeEqual(p, PASS);
}

function upstreamParts() {
  const i = UPSTREAM.lastIndexOf(":");
  return { host: UPSTREAM.slice(0, i), port: Number(UPSTREAM.slice(i + 1)) };
}

/** 普通 HTTP 请求（absolute-form 转发给 upstream）。 */
const server = http.createServer((req, res) => {
  if (!authorized(req)) {
    res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="hysteria-authproxy"', "Content-Type": "text/plain; charset=utf-8" });
    res.end("407 Proxy Authentication Required\n");
    return;
  }
  const up = upstreamParts();
  const headers = { ...req.headers };
  delete headers["proxy-authorization"];
  delete headers["proxy-connection"];
  delete headers["connection"];
  const preq = http.request(
    { host: up.host, port: up.port, method: req.method, path: req.url, headers },
    (pres) => {
      res.writeHead(pres.statusCode, pres.headers);
      pres.pipe(res);
    },
  );
  preq.on("error", (e) => {
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("upstream error: " + e.message);
  });
  req.pipe(preq);
});

/** CONNECT（HTTPS 隧道）：必须用 server 'connect' 事件（无监听器时 Node 会直接关闭连接）。 */
server.on("connect", (req, clientSocket, head) => {
  if (!authorized(req)) {
    clientSocket.write("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"hysteria-authproxy\"\r\n\r\n");
    clientSocket.end();
    return;
  }
  const up = upstreamParts();
  const upSock = net.connect({ host: up.host, port: up.port }, () => {
    // 透传 CONNECT 给 upstream，解析其响应头后再回客户端，避免双重响应
    upSock.write("CONNECT " + req.url + " HTTP/1.1\r\nHost: " + req.url + "\r\n\r\n");
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf("\r\n\r\n");
      if (idx === -1) return;
      upSock.removeListener("data", onData);
      const headText = buf.slice(0, idx + 4).toString("latin1");
      const m = /^HTTP\/\d\.\d\s+(\d+)/.exec(headText.split("\r\n")[0] || "");
      const code = m ? Number(m[1]) : 200;
      if (code < 200 || code >= 300) {
        try { clientSocket.write(headText); clientSocket.end(); } catch { /* noop */ }
        upSock.destroy();
        return;
      }
      try { clientSocket.write("HTTP/1.1 200 Connection established\r\n\r\n"); } catch { upSock.destroy(); return; }
      const rest = buf.slice(idx + 4);
      if (head && head.length) clientSocket.write(head);
      if (rest.length) clientSocket.write(rest);
      clientSocket.pipe(upSock);
      upSock.pipe(clientSocket);
    };
    upSock.on("data", onData);
  });
  upSock.on("error", () => {
    try { clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n"); clientSocket.end(); } catch { /* noop */ }
  });
  clientSocket.on("error", () => upSock.destroy());
  clientSocket.on("close", () => upSock.destroy());
});

server.on("clientError", (_e, sock) => {
  try {
    sock.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  } catch {
    sock.destroy();
  }
});

server.listen(Number(LISTEN.slice(LISTEN.lastIndexOf(":") + 1)), LISTEN.slice(0, LISTEN.lastIndexOf(":")), () => {
  console.log(`[authproxy] listening on ${LISTEN}, upstream ${UPSTREAM}, auth=${USER ? "on" : "off"}`);
});
