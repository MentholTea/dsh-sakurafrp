// gate.mjs — 公网入口网关：密码门 → 反向代理 → DSH WebServer。
//
// 为什么必须反代：DSH WebServer 有 Host/Origin 信任围栏（防 DNS rebinding），
// 外部域名（xxx.nyat.app）直连会让所有 /api 与 WebSocket 返回 403。
// 改写为回环权威后，围栏视请求为本机访问。
//
// DSH 二次认证：首次 HTML 导航必须带 ?token=<launchToken> 才会种下会话
// cookie；token 每次进程启动都变，经 launchToken() 回调实时取。
//
// 非安全上下文 polyfill：http:// 或自签 https 下浏览器缺 crypto.randomUUID
// 与 AbortSignal.any，DSH 前端会初始化抛错白屏，注入补丁。

import { createServer, request as httpRequest } from 'node:http'
import { createGzip } from 'node:zlib'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

// ---------------- polyfill ----------------

export const POLYFILL_HTML = [
  `<script data-natfrp-polyfill="1">!function(){try{if(self.crypto&&!self.crypto.randomUUID){self.crypto.randomUUID=function(){var b=new Uint8Array(16);self.crypto.getRandomValues(b);b[6]=b[6]&15|64;b[8]=b[8]&63|128;var h="";for(var i=0;i<16;i++){var x=b[i].toString(16);h+=(x.length<2?"0":"")+x;if(i===3||i===5||i===7||i===9)h+="-";}return h;}}}catch(e){}}();</script>`,
  `<script data-natfrp-polyfill="2">!function(){try{if(typeof AbortSignal!=='undefined'&&typeof AbortSignal.any!=='function'){AbortSignal.any=function(signals){var c=new AbortController();var arr=Array.prototype.slice.call(signals||[]);function done(){try{c.abort()}catch(e){}}for(var i=0;i<arr.length;i++){var s=arr[i];if(!s)continue;if(s.aborted){done();break;}try{s.addEventListener('abort',done,{once:true});}catch(e){}}return c.signal;};}}catch(e){}}();</script>`,
].join('')

// ---------------- 工具 ----------------

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8')
  const bb = Buffer.from(String(b ?? ''), 'utf8')
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, ba)
    return false
  }
  return timingSafeEqual(ba, bb)
}

function parseCookies(header) {
  const out = {}
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const name = part.slice(0, i).trim()
    const raw = part.slice(i + 1).trim()
    if (!name) continue
    // cookie 值可能被畸形百分号编码污染（中间件/手改/攻击者构造），
    // decodeURIComponent 遇到 "%zz" 会直接抛 URIError —— 不能让一个 cookie 打挂整个请求
    try {
      out[name] = decodeURIComponent(raw)
    } catch {
      out[name] = raw
    }
  }
  return out
}

function clientIp(req) {
  let addr = String(req.socket?.remoteAddress ?? '')
  if (addr.toLowerCase().startsWith('::ffff:')) addr = addr.slice(7)
  return addr || 'unknown'
}

function isHtmlNav(req) {
  const accept = String(req.headers.accept ?? '')
  return accept.includes('text/html') || req.url === '/' || String(req.url ?? '').startsWith('/?')
}

function isCompressed(headers) {
  return /(^|,\s*)(gzip|br|deflate)(\s*,|$)/i.test(String(headers['content-encoding'] ?? ''))
}

// ---------------- 密码门 ----------------

function loginPageHtml({ failed = false, locked = false, retryAfter = 0 } = {}) {
  const msg = locked ? `尝试次数过多，请 ${retryAfter} 秒后再试` : failed ? '密码不正确' : ''
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>访问验证</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  background:#0f1117;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.card{background:#171a23;border:1px solid #262b38;border-radius:14px;padding:30px 26px;
  max-width:340px;width:calc(100% - 48px);text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.4)}
h1{font-size:16px;margin:0 0 6px;font-weight:600;color:#e7eaf2}
p.sub{font-size:13px;color:#8b93a7;margin:0 0 18px}
input{width:100%;padding:11px 13px;font-size:16px;border:1px solid #2c3345;border-radius:9px;
  text-align:center;letter-spacing:2px;outline:none;background:#10131b;color:#e7eaf2}
input:focus{border-color:#5b7cfa;box-shadow:0 0 0 3px rgba(91,124,250,.15)}
button{width:100%;margin-top:12px;padding:11px;font-size:15px;background:#5b7cfa;color:#fff;
  border:none;border-radius:9px;cursor:pointer}
button:active{opacity:.85}
.err{color:#f66;font-size:13px;margin:0 0 12px;min-height:18px}
</style></head><body>
<form class="card" method="POST" action="/__gate/login">
  <h1>远程访问验证</h1>
  <p class="sub">请输入访问密码</p>
  <p class="err">${msg}</p>
  <input type="password" name="password" autocomplete="current-password" autofocus placeholder="访问密码">
  <button type="submit">进入</button>
</form></body></html>`
}

/**
 * 「还没设置访问密码」的提示页。
 *
 * 为什么不直接放行：公网流量是 frpc 转进来的，remoteAddress 永远是 127.0.0.1，
 * 服务端根本无法区分「本机浏览器」和「公网访客」。只要对无密码请求放行，
 * 就等于把整个 DSH 无认证暴露到公网。所以宁可明确拒绝，也不能默认直通。
 */
function noPasswordPageHtml() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>需要先设置访问密码</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  background:#0f1117;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.card{background:#171a23;border:1px solid #262b38;border-radius:14px;padding:30px 26px;
  max-width:380px;width:calc(100% - 48px);text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.4)}
h1{font-size:16px;margin:0 0 10px;font-weight:600;color:#e7eaf2}
p{font-size:13px;color:#9aa2b6;line-height:1.75;margin:0}
code{background:#10131b;border:1px solid #2c3345;border-radius:5px;padding:1px 6px;
  font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#c9d1e6}
</style></head><body>
<div class="card">
  <h1>尚未设置访问密码</h1>
  <p>为防止 DSH 被无认证暴露到公网，密码未设置时网关会拒绝所有外部请求。<br>
  请在<b>本机</b> DSH 的「设置 → 插件 → 内网穿透」里设置一个访问密码后重试。</p>
</div></body></html>`
}

/**
 * 密码门。返回 {handle(req,res)}：true = 已接管。
 * cookie 为 HMAC(密码, 进程随机钥)——改密码或进程重启即失效。
 */
export function createPasswordGate({ getPassword, maxFailures = 5, lockMs = 60_000, log = () => {} } = {}) {
  const COOKIE = 'natfrp_gate'
  const MAX_AGE = 60 * 60 * 24 * 30
  const sessionKey = randomBytes(16).toString('hex')
  const failures = new Map()
  /** 失败计数表上限：公网流量都来自 127.0.0.1 时只有一条，但被其它入口复用时可能膨胀。 */
  const MAX_TRACKED_IPS = 512

  const cookieFor = (pw) => createHmac('sha256', sessionKey).update(String(pw)).digest('hex')

  function lockState(ip) {
    const rec = failures.get(ip)
    if (rec?.until > Date.now()) return { locked: true, retryAfter: Math.ceil((rec.until - Date.now()) / 1000) }
    return { locked: false, retryAfter: 0 }
  }

  /**
   * 清理失败计数表，防止长期运行后无限增长（每个新 IP 一条，永不过期）。
   * 先删「已解锁且无累计」的过期记录；仍超额就按插入顺序丢最旧的。
   */
  function pruneFailures() {
    if (failures.size <= MAX_TRACKED_IPS) return
    const now = Date.now()
    for (const [ip, rec] of failures) {
      if (failures.size <= MAX_TRACKED_IPS) break
      if (rec.until <= now && rec.count === 0) failures.delete(ip)
    }
    for (const ip of failures.keys()) {
      if (failures.size <= MAX_TRACKED_IPS) break
      failures.delete(ip)
    }
  }

  function recordFailure(ip) {
    pruneFailures()
    const rec = failures.get(ip) ?? { count: 0, until: 0 }
    rec.count += 1
    if (rec.count >= maxFailures) {
      rec.until = Date.now() + lockMs
      rec.count = 0
      log(`gate: 锁定 ${ip} ${Math.round(lockMs / 1000)}s`)
    }
    failures.set(ip, rec)
  }

  function readBody(req, limit = 4096) {
    return new Promise((resolve) => {
      let body = ''
      req.on('data', (c) => { body += c; if (body.length > limit) req.destroy() })
      req.on('end', () => resolve(body))
      req.on('error', () => resolve(body))
    })
  }

  function grant(res, expected, location) {
    res.writeHead(302, {
      location,
      'set-cookie': `${COOKIE}=${expected}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}`,
      'cache-control': 'no-store',
    })
    res.end()
  }

  async function handle(req, res) {
    const password = String(getPassword?.() ?? '')
    if (!password) {
      // ⚠️ 未配置密码时必须「拒绝」而不是「放行」：
      //    公网流量经 frpc 进来，remoteAddress 恒为 127.0.0.1，
      //    一旦放行就等于把 DSH 无认证摊到公网（旧版就是这个行为）。
      if (String(req.headers.accept ?? '').includes('text/html')) {
        res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(noPasswordPageHtml())
      } else {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end('{"error":"gate-password-not-set"}')
      }
      return true
    }

    const ip = clientIp(req)
    const lock = lockState(ip)
    const expected = cookieFor(password)
    const cookies = parseCookies(req.headers.cookie)

    // 1) 登录提交
    if (req.method === 'POST' && (req.url === '/__gate/login' || req.url === '/__gate/login/')) {
      if (lock.locked) {
        res.writeHead(429, { 'content-type': 'text/html; charset=utf-8', 'retry-after': String(lock.retryAfter) })
        res.end(loginPageHtml({ locked: true, retryAfter: lock.retryAfter }))
        return true
      }
      const body = await readBody(req)
      const submitted = new URLSearchParams(body).get('password') ?? ''
      if (safeEqual(submitted, password)) {
        failures.delete(ip)
        grant(res, expected, '/')
      } else {
        recordFailure(ip)
        const after = lockState(ip)
        res.writeHead(after.locked ? 429 : 200, {
          'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          ...(after.locked ? { 'retry-after': String(after.retryAfter) } : {}),
        })
        res.end(loginPageHtml({ failed: !after.locked, locked: after.locked, retryAfter: after.retryAfter }))
        log(`gate: 密码错误 ${ip}`)
      }
      return true
    }

    // 2) 有效 cookie
    if (cookies[COOKIE] && safeEqual(cookies[COOKIE], expected)) return false

    // 3) ?gate=<password> 直达（同样计失败）
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const qp = url.searchParams.get('gate')
    if (qp) {
      if (lock.locked) {
        res.writeHead(429, { 'content-type': 'text/html; charset=utf-8' })
        res.end(loginPageHtml({ locked: true, retryAfter: lock.retryAfter }))
        return true
      }
      if (safeEqual(qp, password)) {
        failures.delete(ip)
        url.searchParams.delete('gate')
        grant(res, expected, `${url.pathname}${url.search}` || '/')
      } else {
        recordFailure(ip)
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(loginPageHtml({ failed: true }))
        log(`gate: ?gate= 密码错误 ${ip}`)
      }
      return true
    }

    // 4) 未登录
    if (String(req.headers.accept ?? '').includes('text/html')) {
      res.writeHead(lock.locked ? 429 : 200, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        ...(lock.locked ? { 'retry-after': String(lock.retryAfter) } : {}),
      })
      res.end(loginPageHtml({ locked: lock.locked, retryAfter: lock.retryAfter }))
    } else {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end('{"error":"unauthorized"}')
    }
    return true
  }

  /** WS 升级请求的验权（只看 cookie；未配置密码时一律拒绝，理由同上）。 */
  function checkWs(req) {
    const password = String(getPassword?.() ?? '')
    if (!password) return false
    const cookies = parseCookies(req.headers.cookie)
    return Boolean(cookies[COOKIE]) && safeEqual(cookies[COOKIE], cookieFor(password))
  }

  return { handle, checkWs }
}

// ---------------- 反向代理 ----------------

/**
 * 反向代理：改写权威头 → 转发 → HTML 注入 polyfill。
 * onRequest 前置钩子返回 true 表示请求已被接管（密码门/管理路由）。
 */
export function createGateServer({
  port,
  host = '127.0.0.1',
  upstream,
  launchToken = () => '',
  onRequest = null,
  injectHtml = POLYFILL_HTML,
  log = () => {},
}) {
  /**
   * 上游端口可以传函数：DSH 的 webServer.port 在 listen 之前是 undefined，
   * 启动时求值会被固化成 0，之后所有转发都打到 0 端口（表现为整站 502）。
   * 每次请求现取，才能在 DSH 后启动的情况下自动恢复。
   */
  const upstreamPort = () => {
    const p = typeof upstream.port === 'function' ? upstream.port() : upstream.port
    return Number(p) || 0
  }
  const authority = () => `${upstream.host}:${upstreamPort()}`

  function withLaunchToken(reqUrl, cookieHeader) {
    const token = String(launchToken?.() ?? '')
    if (!token) return reqUrl
    if (String(cookieHeader ?? '').includes('dsh-auth')) return reqUrl
    try {
      const u = new URL(reqUrl, 'http://127.0.0.1')
      if (u.searchParams.has('token')) return reqUrl
      u.searchParams.set('token', token)
      return `${u.pathname}${u.search}`
    } catch {
      return reqUrl
    }
  }

  function rewriteHeaders(raw, method, wantPlain) {
    const out = {}
    for (const [k, v] of Object.entries(raw)) {
      if (HOP_BY_HOP.has(k.toLowerCase())) continue
      out[k] = v
    }
    const auth = authority()
    out.host = auth
    if (raw.origin) out.origin = `http://${auth}`
    if (raw.referer) {
      try {
        const u = new URL(raw.referer)
        out.referer = `http://${auth}${u.pathname}${u.search}`
      } catch {
        out.referer = `http://${auth}/`
      }
    }
    if (raw['sec-fetch-site']) out['sec-fetch-site'] = 'same-origin'
    if (wantPlain) out['accept-encoding'] = 'identity'
    return out
  }

  const server = createServer((req, res) => {
    const proceed = () => forward(req, res)
    if (onRequest) {
      Promise.resolve()
        .then(() => onRequest(req, res))
        .then((handled) => { if (handled !== true && !res.writableEnded) proceed() })
        .catch((e) => {
          log(`gate: onRequest error: ${e?.message ?? e}`)
          if (!res.writableEnded) {
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('internal error')
          }
        })
      return
    }
    proceed()
  })

  function forward(req, res) {
    const targetPort = upstreamPort()
    if (!targetPort) {
      // 端口还没解析出来：明确 503，别去连 0 端口换一个含糊的 ECONNREFUSED
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('DSH WebServer 尚未就绪，请稍后重试')
      return
    }
    const wantInject = Boolean(injectHtml) && req.method === 'GET' && isHtmlNav(req)
    const headers = rewriteHeaders(req.headers, req.method, wantInject)
    const path = wantInject
      ? withLaunchToken(req.url, req.headers.cookie)
      : req.url

    const proxyReq = httpRequest(
      { host: upstream.host, port: targetPort, method: req.method, path, headers },
      (proxyRes) => {
        const status = proxyRes.statusCode ?? 502
        const resHeaders = { ...proxyRes.headers }
        const ct = String(resHeaders['content-type'] ?? '')
        const shouldInject = wantInject && ct.includes('text/html') && !isCompressed(resHeaders)

        if (!shouldInject) {
          res.writeHead(status, resHeaders)
          proxyRes.pipe(res)
          proxyRes.on('error', () => { try { res.destroy() } catch { /* noop */ } })
          return
        }

        const chunks = []
        proxyRes.on('data', (c) => chunks.push(c))
        proxyRes.on('end', () => {
          let html = Buffer.concat(chunks).toString('utf8')
          if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => `${m}${injectHtml}`)
          else html = injectHtml + html
          const buf = Buffer.from(html, 'utf8')
          delete resHeaders['content-length']
          delete resHeaders['content-encoding']
          resHeaders['content-type'] = 'text/html; charset=utf-8'

          const accept = String(req.headers['accept-encoding'] ?? '')
          if (buf.length > 4096 && /\bgzip\b/.test(accept)) {
            resHeaders['content-encoding'] = 'gzip'
            res.writeHead(status, resHeaders)
            const gz = createGzip({ level: 6 })
            gz.pipe(res)
            gz.end(buf)
            return
          }
          res.writeHead(status, resHeaders)
          res.end(buf)
        })
        proxyRes.on('error', () => { try { res.destroy() } catch { /* noop */ } })
      },
    )

    proxyReq.on('error', (e) => {
      log(`gate: upstream error: ${e?.message ?? e}`)
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('bad gateway: DSH WebServer unreachable')
      } else {
        try { res.destroy() } catch { /* noop */ }
      }
    })
    // 中断吸收：客户端断开 / 请求流错误不得变成未处理 'error' 事件（会击穿宿主）
    res.on('error', () => { try { proxyReq.destroy() } catch { /* noop */ } })
    req.on('error', () => { try { proxyReq.destroy() } catch { /* noop */ } })
    req.pipe(proxyReq)
  }

  // WebSocket upgrade：DSH 流式输出依赖它，必须透传。
  // ⚠ 事件签名是 (req, socket, head) 三参。曾按 (req, res, socket, head) 四参解构，
  // 导致 socket 实际拿到 head Buffer，pipe(Buffer) 抛 TypeError 直接击穿宿主（已实测复现）。
  server.on('upgrade', (req, socket, head) => {
    const proceed = () => forwardUpgrade(req, socket, head ?? null)
    if (onRequest) {
      Promise.resolve()
        .then(() => onRequest(req, socket, { upgrade: true }))
        .then((handled) => { if (handled !== true) proceed() })
        .catch((e) => {
          log(`gate: upgrade onRequest error: ${e?.message ?? e}`)
          try { socket.destroy() } catch { /* noop */ }
        })
      return
    }
    proceed()
  })

  function forwardUpgrade(req, socket, head) {
    // 防御：目标必须是真 socket（防参数错位回归）
    if (!socket || typeof socket.pipe !== 'function' || typeof socket.write !== 'function') {
      log(`gate: upgrade 拒绝非 socket 目标 (typeof=${typeof socket})`)
      try { socket?.destroy?.() } catch { /* noop */ }
      return
    }
    const headers = rewriteHeaders(req.headers, 'GET', false)
    headers.connection = 'Upgrade'
    headers.upgrade = req.headers.upgrade ?? 'websocket'

    const targetPort = upstreamPort()
    if (!targetPort) {
      try {
        socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n')
        socket.destroy()
      } catch { /* noop */ }
      return
    }

    const proxyReq = httpRequest({
      host: upstream.host, port: targetPort, method: 'GET', path: req.url, headers,
    })
    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        Object.entries(proxyRes.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
        '\r\n\r\n',
      )
      if (proxyHead?.length) socket.write(proxyHead)
      if (head?.length) proxySocket.write(head)
      proxySocket.pipe(socket)
      socket.pipe(proxySocket)
      // 双向关停：error 或 close（干净断开）任一侧都要拆掉另一侧，防连接泄漏
      const killBoth = () => {
        try { proxySocket.destroy() } catch { /* noop */ }
        try { socket.destroy() } catch { /* noop */ }
      }
      proxySocket.on('error', killBoth)
      socket.on('error', killBoth)
      proxySocket.on('close', () => { try { socket.destroy() } catch { /* noop */ } })
      socket.on('close', () => { try { proxySocket.destroy() } catch { /* noop */ } })
    })
    proxyReq.on('error', () => {
      try {
        socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
        socket.destroy()
      } catch { /* noop */ }
    })
    proxyReq.end()
  }

  return {
    server,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.removeListener('error', reject)
        const addr = server.address()
        resolve({ port: typeof addr === 'object' && addr ? addr.port : port })
      })
    }),
    close: () => new Promise((resolve) => {
      try { server.close(() => resolve()) } catch { resolve() }
      try { server.closeAllConnections?.() } catch { /* noop */ }
    }),
    get listening() { return server.listening },
  }
}
