// gate-redirect-test.mjs —— 针对「DSH 升级后手机端报『重定向次数过多』」的回归用例。
//
// 两个真实踩坑：
//   A) 浏览器没存住 dsh-auth-* 会话 cookie 时，网关每次请求都补 ?token=，
//      DSH 每次回 303 ./ → 浏览器「重定向次数过多」。清 Cookie 也无效，
//      因为下一轮又是同样路径。
//   B) DSH 的会话 cookie 名绑定 host:port（dsh-auth-<base64url(sha256(authority))>）。
//      端口一变旧 cookie 就对不上，而旧逻辑「看到 dsh-auth-* 就不补 token」
//      会让用户永久卡在 401 —— 只能手动删 Cookie。
//
// 全部离线：内置两个假上游（正常 / 一律 401），只监听随机端口。

import { createServer, request as httpRequest } from 'node:http'
import { createPasswordGate, createGateServer } from './../gate.mjs'

const results = []
function record(name, pass, detail = '') {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

const PASSWORD = 'redirect-test-pass'
const LAUNCH = 'LAUNCH-TOKEN-XYZ'

/** 假上游：mode=ok 正常 200；mode=401 一律 401（模拟旧 cookie 全部失效）。 */
function fakeUpstream(mode) {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const host = String(req.headers.host ?? '')
      if (!host.startsWith('127.0.0.1')) {
        res.writeHead(403, { 'content-type': 'text/plain' })
        res.end('fence')
        return
      }
      const url = new URL(req.url ?? '/', 'http://x')
      const hasToken = url.searchParams.has('token')
      const cookieOk = /dsh-auth-[A-Za-z0-9_-]{43}=GOOD/.test(String(req.headers.cookie ?? ''))

      // 真 DSH 的语义：token 命中 → 303 ./ 并种 cookie；cookie 命中 → 200。
      if (mode === 'ok') {
        if (hasToken) {
          res.writeHead(303, {
            location: './',
            'set-cookie': [`dsh-auth-${'Q'.repeat(43)}=GOOD; Path=/; HttpOnly; SameSite=Strict`],
            'x-seen-url': req.url ?? '',
          })
          res.end()
          return
        }
        if (cookieOk) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-seen-url': req.url ?? '' })
          res.end('<!doctype html><html><head><title>FAKE-DSH</title></head><body>ok</body></html>')
          return
        }
        res.writeHead(401, { 'content-type': 'text/plain' })
        res.end('dsh web authentication required')
        return
      }

      // mode=401：永远 401，模拟端口漂移后旧 cookie 全部作废。
      res.writeHead(401, { 'content-type': 'text/plain', 'x-seen-url': req.url ?? '' })
      res.end('dsh web authentication required')
    })
    srv.listen(0, '127.0.0.1', () => resolve({ server: srv, port: srv.address().port }))
  })
}

function http(port, opts, body) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ port, ...opts }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

/** 取一条 set-cookie 的 name=value。 */
const pick = (r, name) => {
  const all = r.headers['set-cookie'] ?? []
  const hit = all.find((c) => c.startsWith(name + '='))
  return hit ? hit.split(';')[0] : ''
}

const FAKE_HOST = 'www.tunnel.nyat.app:12345'

// ================= A) 重定向死循环 =================
//
// 场景：浏览器接受 cookie 后**不存**（隐私模式 / 清理 / 跨站导航），
// 每次请求都只带密码门 cookie。旧实现每轮都补 token → 303 无限循环。

{
  const up = await fakeUpstream('ok')
  const gate = createPasswordGate({ getPassword: () => PASSWORD })
  const proxy = createGateServer({
    port: 0,
    upstream: { host: '127.0.0.1', port: up.port },
    launchToken: () => LAUNCH,
    onRequest: async (req, res) => gate.handle(req, res),
  })
  await proxy.listen()
  const port = proxy.server.address().port

  // 登录拿密码门 cookie
  const loginBody = `password=${encodeURIComponent(PASSWORD)}`
  const login = await http(port, { path: '/__gate/login', method: 'POST',
    headers: { host: FAKE_HOST, accept: 'text/html',
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': Buffer.byteLength(loginBody) } }, loginBody)
  const gateCookie = pick(login, 'natfrp_gate')

  record('重定向: 登录拿到密码门 cookie', login.status === 302 && Boolean(gateCookie))

  // 模拟「不存 cookie 的浏览器」：只回传密码门 cookie，忽略所有 set-cookie
  let cur = '/'
  let hops = 0
  let sawMark = false
  let lastStatus = 0
  const seen = []
  while (hops < 12) {
    const r = await http(port, { path: cur, method: 'GET',
      headers: { host: FAKE_HOST, accept: 'text/html', cookie: gateCookie } })
    lastStatus = r.status
    seen.push(`${cur}→${r.status}`)
    if (pick(r, 'natfrp_tok') !== '') sawMark = true
    if (r.status >= 300 && r.status < 400) {
      cur = r.headers.location === './' ? '/' : String(r.headers.location ?? '/')
      hops += 1
      continue
    }
    break
  }

  record('重定向: 不存 cookie 的浏览器也必须有限次收敛（不会无限循环）', hops <= 3,
    `hops=${hops} ${seen.join(' | ')}`)
  record('重定向: 补发 token 时下发防重复标记 natfrp_tok', sawMark)
  record('重定向: 最终收敛为 200 而不是 303/401', lastStatus === 200, `last=${lastStatus}`)

  await proxy.close()
  up.server.close()
}

// ================= B) 端口漂移后的 401 自愈 =================
//
// 场景：浏览器保存着「旧端口」算出的 dsh-auth-* cookie。DSH 重启换了端口，
// 上游对这份旧 cookie 一律 401。旧实现看到 dsh-auth-* 就不再补 token，
// 于是用户永久 401，只能手动删 Cookie。

{
  const up = await fakeUpstream('401')
  const gate = createPasswordGate({ getPassword: () => PASSWORD })
  const proxy = createGateServer({
    port: 0,
    upstream: { host: '127.0.0.1', port: up.port },
    launchToken: () => LAUNCH,
    onRequest: async (req, res) => gate.handle(req, res),
  })
  await proxy.listen()
  const port = proxy.server.address().port

  const loginBody = `password=${encodeURIComponent(PASSWORD)}`
  const login = await http(port, { path: '/__gate/login', method: 'POST',
    headers: { host: FAKE_HOST, accept: 'text/html',
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': Buffer.byteLength(loginBody) } }, loginBody)
  const gateCookie = pick(login, 'natfrp_gate')

  // 旧端口留下的 cookie（签名对不上当前上游）
  const staleCookie = `${gateCookie}; dsh-auth-${'V'.repeat(43)}=v1.old.sig`

  const r1 = await http(port, { path: '/', method: 'GET',
    headers: { host: FAKE_HOST, accept: 'text/html', cookie: staleCookie } })

  const clearsStale = (r1.headers['set-cookie'] ?? [])
    .some((c) => c.startsWith(`dsh-auth-${'V'.repeat(43)}=;`) && c.includes('Max-Age=0'))
  record('自愈: 上游 401 时主动清掉失效的 dsh-auth-*', clearsStale, `status=${r1.status}`)
  record('自愈: 用 303 重试而不是把 401 甩给浏览器', r1.status === 303, `status=${r1.status}`)
  record('自愈: 记下 self-heal 计数 natfrp_heal', pick(r1, 'natfrp_heal') !== '')

  // 第二次请求：已经自愈过一次，不得再清 → 直接透传 401（避免变成新循环）
  const healedCookie = staleCookie + '; ' + pick(r1, 'natfrp_heal')
  const r2 = await http(port, { path: '/', method: 'GET',
    headers: { host: FAKE_HOST, accept: 'text/html', cookie: healedCookie } })
  record('自愈: 只自愈一次，第二次透传 401（防新循环）', r2.status === 401,
    `status=${r2.status}`)

  await proxy.close()
  up.server.close()
}

// ================= C) 正常路径不被破坏 =================

{
  const up = await fakeUpstream('ok')
  const gate = createPasswordGate({ getPassword: () => PASSWORD })
  const proxy = createGateServer({
    port: 0,
    upstream: { host: '127.0.0.1', port: up.port },
    launchToken: () => LAUNCH,
    onRequest: async (req, res) => gate.handle(req, res),
  })
  await proxy.listen()
  const port = proxy.server.address().port

  const loginBody = `password=${encodeURIComponent(PASSWORD)}`
  const login = await http(port, { path: '/__gate/login', method: 'POST',
    headers: { host: FAKE_HOST, accept: 'text/html',
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': Buffer.byteLength(loginBody) } }, loginBody)
  const gateCookie = pick(login, 'natfrp_gate')

  // 第一跳：补 token → 上游 303 并种下 dsh-auth-*
  const h1 = await http(port, { path: '/', method: 'GET',
    headers: { host: FAKE_HOST, accept: 'text/html', cookie: gateCookie } })
  const dshCookie = pick(h1, 'dsh-auth-' + 'Q'.repeat(43))
  record('正常: 首跳补 token 后上游返回 303', h1.status === 303, `status=${h1.status}`)
  record('正常: 上游的 dsh-auth-* 与会话标记 cookie 并存', Boolean(dshCookie) && pick(h1, 'natfrp_tok') !== '',
    `dsh=${Boolean(dshCookie)} mark=${pick(h1, 'natfrp_tok')}`)

  // 第二跳：带着新 cookie 且带标记 → 不再补 token → 200
  const h2 = await http(port, { path: '/', method: 'GET',
    headers: { host: FAKE_HOST, accept: 'text/html',
      cookie: `${gateCookie}; ${dshCookie}; ${pick(h1, 'natfrp_tok')}` } })
  const seenUrl = String(h2.headers['x-seen-url'] ?? '')
  record('正常: 已有会话且已补过 → 不再补 token', !/[?&]token=/.test(seenUrl), `seen=${seenUrl}`)
  record('正常: 最终 200 且注入 polyfill', h2.status === 200 && /data-natfrp-polyfill/.test(h2.body),
    `status=${h2.status}`)

  await proxy.close()
  up.server.close()
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  for (const f of failed) console.log(`  FAIL ${f.name}`)
  process.exitCode = 1
}
