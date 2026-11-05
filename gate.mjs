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
//
// 手机端可操作性补丁（2026-11-05 实测）：窄视口下点按类控件必须 ≥24px，
// 否则 iOS/Android 会判定点不中。第三方插件里 13px 的单选框正是这种情况，
// 用户点不动就无法确认，只能卡在弹窗上。这里只把可点尺寸补到 24px，
// 不改任何插件行为与判定义务。

import { createServer, request as httpRequest } from 'node:http'
import { createGzip } from 'node:zlib'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

// ---------------- polyfill ----------------

export const POLYFILL_HTML = [
  `<script data-natfrp-polyfill="1">!function(){try{if(self.crypto&&!self.crypto.randomUUID){self.crypto.randomUUID=function(){var b=new Uint8Array(16);self.crypto.getRandomValues(b);b[6]=b[6]&15|64;b[8]=b[8]&63|128;var h="";for(var i=0;i<16;i++){var x=b[i].toString(16);h+=(x.length<2?"0":"")+x;if(i===3||i===5||i===7||i===9)h+="-";}return h;}}}catch(e){}}();</script>`,
  `<script data-natfrp-polyfill="2">!function(){try{if(typeof AbortSignal!=='undefined'&&typeof AbortSignal.any!=='function'){AbortSignal.any=function(signals){var c=new AbortController();var arr=Array.prototype.slice.call(signals||[]);function done(){try{c.abort()}catch(e){}}for(var i=0;i<arr.length;i++){var s=arr[i];if(!s)continue;if(s.aborted){done();break;}try{s.addEventListener('abort',done,{once:true});}catch(e){}}return c.signal;};}}catch(e){}}();</script>`,
  /* 窄视口点按命中率：勾选框/单选框放大到 24px 的可点区域。 */
  `<style data-natfrp-touch="1">@media (max-width:768px){input[type=checkbox],input[type=radio]{min-width:24px;min-height:24px;width:24px;height:24px;flex:none}}</style>`,
  /*
   * 修复「手机（或桌面版网站）白屏、只显示桌宠」—— 2026-11-05 真机 Edge 157 实测根因：
   *
   *   dsh-web-mobile 的移动端样式里有
   *     @media (max-width:1023px) and (pointer:coarse){
   *       html [data-mobile-nav="frame"]{ grid-template-columns: minmax(0,1fr) 0 0 !important }
   *     }
   *   它假设「主内容在第 1 列」。DSH 新版的列定义是
   *     sidebarCol grid-area:1/1 | centerCol grid-area:1/2 | rightbarCol grid-area:1/3
   *   于是那个 1fr 全被分给侧栏列，第 2 列（主内容）被压成 0px。实测：
   *     computed gridCols = "980px 0px 0px"，centerCol / mainPanel 宽度 = 0 → 就是白屏。
   *   桌宠是 position:fixed + z-index 214748，不受网格影响照常绘制 —— 与「只有桌宠」吻合。
   *   触发条件是 pointer:coarse，手机必现；桌面鼠标(pointer:fine)不受影响。
   *
   * 为什么不靠再写一条 CSS 覆盖：两边都用 !important 时只剩特异性内战，
   * 插件一旦改选择器就会静默失效。这里改成**精确摘除**那条声明（实测有效：
   * 移除后 gridCols 从 "980px 0px 0px" 恢复为 "56px 924px 0px"），
   * 并监听样式重插以保持幂等。只动这一条选择器命中的规则，插件其余样式原样保留。
   */
  `<script data-natfrp-gridfix="1">!function(){
  function fix(){
    var removed=0;
    var sheets=Array.from(document.styleSheets||[]);
    for(var i=0;i<sheets.length;i++){
      var rules; try{ rules=sheets[i].cssRules }catch(e){ continue }
      if(!rules) continue;
      /* 递归扫描：规则组可能嵌在 @media / @supports / @layer 任意层级，
         只按「选择器命中 + grid-template-columns 的值形态」判定，不依赖外层结构。 */
      (function scan(list){
        for(var j=list.length-1;j>=0;j--){
          var r=list[j];
          if(!r) continue;
          if(r.cssRules && r.selectorText===undefined){ scan(r.cssRules); continue }
          if(!r.selectorText||!r.style) continue;
          var gtc=r.style.getPropertyValue('grid-template-columns');
          if(!gtc) continue;
          if(r.selectorText.indexOf('[data-mobile-nav="frame"]')<0) continue;
          var v=gtc.replace(/\\s+/g,' ');
          /* 只有这一种形态是错的：把 1fr 全给第 1 列、第 2 列压成 0。 */
          if(!/^minmax\\(0(px)?, 1fr\\) 0(px)? 0(px)?$/.test(v)) continue;
          try{
            var parent=r.parentRule;
            if(parent&&parent.deleteRule) parent.deleteRule(j);
            else if(list.deleteRule) list.deleteRule(j);
            removed++;
          }catch(e){}
        }
      })(rules);
    }
    return removed;
  }
  function boot(){
    fix();
    /* 插件或 DSH 可能在稍后重新插入该样式表：低频合并触发，不做高频抖动。 */
    var t=null;
    var obs=new MutationObserver(function(){ if(t) return; t=setTimeout(function(){ t=null; fix() },120) });
    try{ obs.observe(document.documentElement,{childList:true,subtree:true}) }catch(e){}
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot,{once:true});
  else boot();
}();</script>`,
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

/**
 * 追加一条 set-cookie，且不覆盖上游已有的 set-cookie。
 *
 * ⚠️ 代理层最容易丢 cookie 的写法就是 `resHeaders['set-cookie'] = x`：
 *    upstream 的 dsh-auth-* 与我们的标记 cookie 是两条独立指令，必须并存。
 *    node 的 res.writeHead 接受数组，上游给的也可能已经是数组。
 */
function appendSetCookie(headers, value) {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'set-cookie') ?? 'set-cookie'
  const prev = headers[key]
  if (prev === undefined) headers[key] = [value]
  else if (Array.isArray(prev)) headers[key] = [...prev, value]
  else headers[key] = [String(prev), value]
}

// ---------------- 密码门 ----------------

/** HTML 属性转义：next 会嵌进 value="..."，来源是请求 URL，攻击者可构造。 */
function escAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

/**
 * 登录成功后的回跳地址。只接受站内绝对路径（以 / 开头、非 //、无反斜杠），
 * 其余一律回首页 —— next 来自请求 URL / 表单，可被攻击者构造，不能放它变成开放重定向。
 */
function safeNext(raw) {
  const s = String(raw ?? '')
  if (!s.startsWith('/') || s.startsWith('//') || s.includes('\\')) return '/'
  if (s.startsWith('/__gate/')) return '/' // 登录页自身不能作为回跳目标（死循环）
  return s.length <= 512 ? s : '/'
}

function loginPageHtml({ failed = false, locked = false, retryAfter = 0, next = '/' } = {}) {
  const msg = locked ? `尝试次数过多，请 ${retryAfter} 秒后再试` : failed ? '密码不正确' : ''
  // next 与默认值相同就不输出隐藏域，登录后照旧回首页
  const nextField = next && next !== '/' ? `<input type="hidden" name="next" value="${escAttr(next)}">` : ''
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
  ${nextField}
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
      // 超限直接剁掉连接；'close' 兜底保证 promise 一定会落地，
      // 否则 destroy() 之后只等 'end' 会让这条登录请求永远挂着。
      req.on('data', (c) => { body += c; if (body.length > limit) req.destroy() })
      req.on('end', () => resolve(body))
      req.on('error', () => resolve(body))
      req.on('close', () => resolve(body))
    })
  }

  function grant(res, expected, location) {
    res.writeHead(302, {
      location,
      'set-cookie': `${COOKIE}=${expected}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}`,
      'cache-control': 'no-store',
      // 跳转目标虽已剥掉 ?gate=，但浏览器仍可能把带密码的原始 URL 作为 Referer
      // 带给后续请求 / 外链 —— 一律不发 Referer
      'referrer-policy': 'no-referrer',
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
        res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
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
      // 先读 body：锁定时的重渲染页也要带上 next，解锁后提交才能回到原页面
      const body = await readBody(req)
      const params = new URLSearchParams(body)
      const submitted = params.get('password') ?? ''
      const next = safeNext(params.get('next'))
      if (lock.locked) {
        res.writeHead(429, { 'content-type': 'text/html; charset=utf-8', 'retry-after': String(lock.retryAfter), 'referrer-policy': 'no-referrer' })
        res.end(loginPageHtml({ locked: true, retryAfter: lock.retryAfter, next }))
        return true
      }
      if (safeEqual(submitted, password)) {
        failures.delete(ip)
        grant(res, expected, next)
      } else {
        recordFailure(ip)
        const after = lockState(ip)
        res.writeHead(after.locked ? 429 : 200, {
          'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
          ...(after.locked ? { 'retry-after': String(after.retryAfter) } : {}),
        })
        res.end(loginPageHtml({ failed: !after.locked, locked: after.locked, retryAfter: after.retryAfter, next }))
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
        res.writeHead(429, { 'content-type': 'text/html; charset=utf-8', 'referrer-policy': 'no-referrer' })
        res.end(loginPageHtml({ locked: true, retryAfter: lock.retryAfter }))
        return true
      }
      if (safeEqual(qp, password)) {
        failures.delete(ip)
        url.searchParams.delete('gate')
        grant(res, expected, `${url.pathname}${url.search}` || '/')
      } else {
        recordFailure(ip)
        // 重渲染的登录页带上「去掉 gate 参数」的目标地址，登录成功后仍回到原页
        url.searchParams.delete('gate')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
        res.end(loginPageHtml({ failed: true, next: safeNext(`${url.pathname}${url.search}`) }))
        log(`gate: ?gate= 密码错误 ${ip}`)
      }
      return true
    }

    // 4) 未登录
    if (String(req.headers.accept ?? '').includes('text/html')) {
      res.writeHead(lock.locked ? 429 : 200, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        ...(lock.locked ? { 'retry-after': String(lock.retryAfter) } : {}),
      })
      // 带上原地址：登录成功后回到访客想去的页面，而不是一律回首页
      res.end(loginPageHtml({ locked: lock.locked, retryAfter: lock.retryAfter, next: safeNext(req.url) }))
    } else {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end('{"error":"unauthorized"}')
    }
    return true
  }

  /**
   * 请求是否已持有有效的密码门 cookie。
   *
   * ⚠️ 这是网关侧唯一的可信身份来源。不要试图用 remoteAddress 区分
   *    「本机 / 公网」—— 公网流量经 frpc 从 127.0.0.1 转发进来，
   *    两者来源地址完全相同，永远判不出来。
   */
  function checkCookie(req) {
    const password = String(getPassword?.() ?? '')
    if (!password) return false
    const cookies = parseCookies(req.headers.cookie)
    return Boolean(cookies[COOKIE]) && safeEqual(cookies[COOKIE], cookieFor(password))
  }

  /** WS 升级请求的验权（语义与 checkCookie 相同，保留旧名以免调用点分散）。 */
  function checkWs(req) {
    return checkCookie(req)
  }

  return { handle, checkCookie, checkWs }
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

  /**
   * 请求是否已持有 DSH 自己的浏览器会话 cookie。
   *
   * DSH 的 cookie 名 = `dsh-auth-<base64url(sha256(authority))>`
   * （dsh-client-connection: COOKIE_PREFIX = 'dsh-auth-'，后缀是定长 43 字符的 base64url）。
   * 这里只认两种形态：
   *   · dsh-auth-<43 字符 base64url>=     ← 实际形态
   *   · dsh-auth=                          ← 兼容裸名
   * 必须用完整形态匹配，否则 `dsh-auth-old=1`、`mydsh-auth=2` 这类同前缀的
   * 无关 cookie 会被误判成「已认证」，导致本该补 token 的首次访问拿不到 token。
   */
  const DSH_AUTH_COOKIE_RE = /(?:^|;\s*)dsh-auth(?:-[A-Za-z0-9_-]{43})?=/

  /** 任意 dsh-auth-* cookie 的完整匹配（用于失效清理，含任意长度的后缀）。 */
  const DSH_AUTH_ANY_RE = /(?:^|;\s*)(dsh-auth(?:-[A-Za-z0-9_-]*)?)=/g

  function hasDshAuthCookie(cookieHeader) {
    return DSH_AUTH_COOKIE_RE.test(String(cookieHeader ?? ''))
  }

  /**
   * 「本进程已经补发过一次 launchToken」的浏览器侧标记。
   *
   * ⚠️ 为什么不能只靠 dsh-auth-* 判断：DSH 的会话 cookie 名是
   *    `dsh-auth-<base64url(sha256(authority))>`，authority 是 **host:port**。
   *    DSH 的 webServer.port 默认由端口分配决定，桌面端重启后端口会变
   *    （实测 45871 一类随机值），名字随之改变；上游是否认账根本无法由
   *    网关侧的正则判断。旧实现「看到 dsh-auth-* 就不补 token」一旦遇到
   *    端口漂移，就永远不会补 token，用户只能删 Cookie 重来。
   *
   *    反过来只看「没 cookie 就补 token」也不行：浏览器只要有一次没存住
   *    cookie（隐私模式、被清理、跨站导航），每一次 303 都会再补一次 token，
   *    DSH 每次回 303 ./，浏览器就报「重定向次数过多」。
   *
   *    所以补与不补由网关自己的短命 cookie 记录，进可自愈、退不循环。
   */
  const TOKEN_MARK = 'natfrp_tok'
  const TOKEN_MARK_MAX_AGE = 600

  /** 该请求是否已经由本网关补发过 launchToken。 */
  function hasTokenMark(cookieHeader) {
    const cookies = parseCookies(cookieHeader)
    return Boolean(cookies[TOKEN_MARK])
  }

  /** 生成 set-cookie 的值：种标记 / 清标记 / 清所有 dsh-auth-*。 */
  function markCookie() {
    return `${TOKEN_MARK}=1; Path=/; Max-Age=${TOKEN_MARK_MAX_AGE}; HttpOnly; SameSite=Lax`
  }
  function clearMarkCookie() {
    return `${TOKEN_MARK}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`
  }

  /**
   * 与 cookie 存储无关的兜底：同一路径连续补发 N 次 token 仍未拿到页面，
   * 说明浏览器**根本存不住 cookie**（隐私模式 / 禁用第三方 / 无痕导航等）。
   *
   * 此时任何「继续补 token」都只会得到 303 → 303 → …，也就是用户看到的
   * 「重定向次数过多」。正确的行为是停下来明确告诉他原因，而不是无限重定向。
   */
  const MAX_INJECT_STREAK = 2
  const injectStreak = new Map()

  function noteInject(pathname) {
    const rec = injectStreak.get(pathname) ?? { count: 0, at: 0 }
    rec.count += 1
    rec.at = Date.now()
    injectStreak.set(pathname, rec)
    return rec.count
  }

  function clearInjectStreak(pathname) {
    injectStreak.delete(pathname)
  }

  function cookieBlockedPageHtml() {
    return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>浏览器没有保存登录 Cookie</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  background:#0f1117;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.card{background:#171a23;border:1px solid #262b38;border-radius:14px;padding:28px 24px;
  max-width:400px;width:calc(100% - 44px);box-shadow:0 8px 32px rgba(0,0,0,.4)}
h1{font-size:16px;margin:0 0 12px;font-weight:600;color:#e7eaf2}
p{font-size:13px;color:#9aa2b6;line-height:1.8;margin:0 0 10px}
ul{font-size:13px;color:#9aa2b6;line-height:1.8;margin:0 0 14px;padding-left:18px}
code{background:#10131b;border:1px solid #2c3345;border-radius:5px;padding:1px 6px;
  font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#c9d1e6}
a.btn{display:inline-block;margin-top:6px;padding:10px 16px;background:#5b7cfa;color:#fff;
  border-radius:9px;text-decoration:none;font-size:14px}
</style></head><body>
<div class="card">
  <h1>浏览器没有保存登录 Cookie</h1>
  <p>网关已经连续两次为你的浏览器换取 DSH 会话，但浏览器没有保存收到的 Cookie，
  因此每次回到首页都要重新验证 —— 浏览器会因此提示「重定向次数过多」。</p>
  <ul>
    <li>退出浏览器的<b>无痕 / 隐私模式</b>后重试</li>
    <li>检查是否<b>禁用了 Cookie</b>（尤其 iOS 的「阻止所有 Cookie」）</li>
    <li>确认本站不是被「跨站跟踪防护」拦截的第三方上下文</li>
    <li>换用系统浏览器或桌面端打开同一地址</li>
  </ul>
  <p>处理完上面的设置后点下方重新进入即可，不需要清空任何数据。</p>
  <a class="btn" href="/">重新进入</a>
</div></body></html>`
  }
  function clearDshAuthCookies(cookieHeader) {
    const names = []
    for (const m of String(cookieHeader ?? '').matchAll(DSH_AUTH_ANY_RE)) {
      if (m[1]) names.push(m[1])
    }
    return names.map((n) => `${n}=; Path=/; Max-Age=0`)
  }

  /** 返回 { path, needsMark } —— needsMark 表示这次补了 token，需要种标记。 */
  function withLaunchToken(reqUrl, cookieHeader) {
    const token = String(launchToken?.() ?? '')
    if (!token) return { path: reqUrl, needsMark: false }
    // 已经补过一次：绝不再补。这是杀掉 303 死循环的唯一可靠依据。
    if (hasTokenMark(cookieHeader)) return { path: reqUrl, needsMark: false }
    // 已持有 DSH 会话 cookie：先不补，交给上游判定；上游若 401 会自愈。
    if (hasDshAuthCookie(cookieHeader)) return { path: reqUrl, needsMark: false }
    try {
      const u = new URL(reqUrl, 'http://127.0.0.1')
      if (u.searchParams.has('token')) return { path: reqUrl, needsMark: false }
      u.searchParams.set('token', token)
      return { path: `${u.pathname}${u.search}`, needsMark: true }
    } catch {
      return { path: reqUrl, needsMark: false }
    }
  }

  /**
   * 上游 401 的自愈判定。
   *
   * 触发条件：上游拒绝了本次 HTML 导航，且这次请求**没有带我们补的 token**
   * （带 token 仍 401 说明 token 本身失效，再补也没用，直接透传）。
   * 处理：清掉所有 dsh-auth-* 与补发标记，303 回原地址 → 下一轮重新补 token。
   * 自愈只允许一次，否则端口/凭据真坏时会变成另一种重定向循环。
   */
  const HEAL_COOKIE = 'natfrp_heal'

  function healCount(cookieHeader) {
    const v = parseCookies(cookieHeader)[HEAL_COOKIE]
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : 0
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
    const { path, needsMark } = wantInject
      ? withLaunchToken(req.url, req.headers.cookie)
      : { path: req.url, needsMark: false }

    const proxyReq = httpRequest(
      { host: upstream.host, port: targetPort, method: req.method, path, headers },
      (proxyRes) => {
        const status = proxyRes.statusCode ?? 502
        const resHeaders = { ...proxyRes.headers }
        const ct = String(resHeaders['content-type'] ?? '')
        const shouldInject = wantInject && ct.includes('text/html') && !isCompressed(resHeaders)

        // 补发过 token 就记一笔，之后本进程内不再重复补 → 根治 303 死循环。
        if (needsMark) {
          appendSetCookie(resHeaders, markCookie())
          const pathname = (() => {
            try { return new URL(req.url ?? '/', 'http://127.0.0.1').pathname } catch { return '/' }
          })()
          const streak = noteInject(pathname)
          /**
           * 兜底：连续补发仍未收敛，说明浏览器存不住 cookie。
           * 此时继续重定向只会变成「重定向次数过多」——停下来给明确说明。
           */
          if (streak > MAX_INJECT_STREAK) {
            res.writeHead(200, {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store',
              'referrer-policy': 'no-referrer',
              'set-cookie': [clearMarkCookie()],
            })
            res.end(cookieBlockedPageHtml())
            clearInjectStreak(pathname)
            log(`gate: ${pathname} 连续 ${streak} 次补发 token 未收敛 → 提示 Cookie 未保存`)
            return
          }
        }
        // 拿到页面就重置计数，正常用户永远不会触发上面的兜底
        if (shouldInject || status === 200) {
          try { clearInjectStreak(new URL(req.url ?? '/', 'http://127.0.0.1').pathname) } catch { /* noop */ }
        }

        /**
         * 上游 401 自愈：DSH 的会话 cookie 名绑定 host:port，端口一变旧 cookie
         * 就永远对不上，而网关此前看到 `dsh-auth-*` 就不再补 token —— 用户
         * 只能「删 Cookie」重来。这里主动清掉旧 cookie 并重新走一次 token，
         * 只允许自愈一次，避免变成新的循环。
         */
        if (wantInject && status === 401 && !hasTokenMark(req.headers.cookie)) {
          const healed = healCount(req.headers.cookie)
          if (healed < 1) {
            const clears = ['natfrp_heal=' + (healed + 1) + '; Path=/; Max-Age=60; HttpOnly; SameSite=Lax']
              .concat(clearDshAuthCookies(req.headers.cookie))
            res.writeHead(303, {
              location: req.url === '/' ? './' : req.url,
              'cache-control': 'no-store',
              'set-cookie': clears,
              'referrer-policy': 'no-referrer',
            })
            res.end()
            log(`gate: 上游 401 → 清理失效的 dsh-auth 并重试一次 (${req.url})`)
            return
          }
          log(`gate: 上游 401 且已自愈过一次 → 透传（可能是 token 失效）`)
        }

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

          // ⚠️ 上游可能同时下发 dsh-auth-* 会话 cookie，必须在改完头之后重新写入，
          //    否则这份 HTML 重写会把会话 cookie 一起吞掉（表现为登录后立刻 401）。
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
      /**
       * ⚠️ 这个监听器必须常驻：启动期的 EADDRINUSE 要 reject，
       *    跑起来之后的 error（EMFILE / 底层 socket 异常）如果没有 handler，
       *    Node 会把它抛到进程顶层，直接击穿宿主。
       */
      server.on('error', (e) => {
        if (!server.listening) reject(e)
        else log(`gate: server error: ${e?.message ?? e}`)
      })
      server.listen(port, host, () => {
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
