// verify.mjs — 独立验证，不依赖 DSH 宿主。
//   node verify.mjs            # 模块级测试（API 客户端 + frpc 解析 + 网关全链路）
// 环境变量：
//   NATFRP_TOKEN   有值则追加真实 API 冒烟测试（只读端点）
//   VERIFY_DSH_PORT 上游假 DSH 端口（默认起一个内置假服务器）

import { createServer, request as httpRequest } from 'node:http'
import { createClient, ApiError, fmtBytes } from './../natfrp.mjs'
import { createFrpcManager } from './../frpc.mjs'
import { createPasswordGate, createGateServer } from './../gate.mjs'

const results = []
function record(name, pass, detail = '') {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

// ---------- 1. natfrp.mjs 单元 ----------

{
  const c = createClient('fake-token-for-shape-test', { timeoutMs: 3000 })
  const checks = [
    ['tunnels 是函数', typeof c.tunnels === 'function'],
    ['userInfo 是函数', typeof c.userInfo === 'function'],
    ['tunnelEdit 是函数', typeof c.tunnelEdit === 'function'],
    ['tunnelConfig 是函数', typeof c.tunnelConfig === 'function'],
    ['tunnelDelete 是函数', typeof c.tunnelDelete === 'function'],
    ['tunnelCreate 是函数', typeof c.tunnelCreate === 'function'],
    ['fmtBytes', fmtBytes(1536) === '1.5 KiB' && fmtBytes(1024 * 1024 * 1024) === '1.0 GiB'],
    ['ApiError 可抛', (() => { try { throw new ApiError(403, 'x') } catch (e) { return e instanceof ApiError && e.code === 403 } })()],
  ]
  for (const [n, p] of checks) record(n, p)
}

// ---------- 2. frpc.mjs 日志解析 ----------

{
  const mgr = createFrpcManager({ frpcPath: 'x', getToken: () => 't' })
  mgr._feed('2026/10/28 [I] 隧道启动成功')
  mgr._feed('使用 >>www.example.com:12345<< 连接你的隧道')
  const s1 = mgr.snapshot()
  record('frpc: tunnelOk 解析', s1.tunnelOk === true)
  record('frpc: tunnelUrl 解析', s1.tunnelUrl === 'www.example.com:12345')

  // 互踢风暴：6 次断线
  for (let i = 0; i < 6; i++) mgr._feed('[E] 网络波动导致数据连接断开, 正在重试: EOF')
  record('frpc: 互踢检测', mgr.snapshot().kickSuspect === true)

  // http 隧道无端口的 URL
  const m2 = createFrpcManager({ frpcPath: 'x', getToken: () => 't' })
  m2._feed('使用 >>web.example.nyat.app<< 连接你的隧道')
  record('frpc: 无端口 URL 补 https', m2.snapshot().tunnelUrl === 'https://web.example.nyat.app')

  // start 参数校验
  const m3 = createFrpcManager({ frpcPath: 'Z:/不存在的路径/frpc.exe', getToken: () => 't' })
  const r1 = m3.start({ tunnelIds: ['123'] })
  record('frpc: 不可达路径拒绝启动', r1.ok === false && r1.reason === 'frpc-not-found')
  const r2 = m3.start({ tunnelIds: [] })
  record('frpc: 空隧道拒绝启动', r2.ok === false && r2.reason === 'no-tunnel')
}

// ---------- 3. gate.mjs 全链路（假上游 + 密码门 + Host 改写 + WS 占位） ----------

const UPSTREAM = await new Promise((resolve) => {
  // 假 DSH：验证 Host 围栏语义——非回环 Host 返回 403，回环 Host 返回 200 + HTML
  const srv = createServer((req, res) => {
    const host = String(req.headers.host ?? '')
    const isLoopback = host.startsWith('127.0.0.1')
    if (req.url === '/ws-upgrade-check') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ws-checked')
      return
    }
    if (!isLoopback) {
      res.writeHead(403, { 'content-type': 'text/plain' })
      res.end('fence: forbidden host ' + host)
      return
    }
    // x-seen-url 回显上游实际收到的 req.url，供断言「launch token 是否被注入」
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'x-seen-url': req.url ?? '',
    })
    res.end('<!doctype html><html><head><title>FAKE-DSH</title></head><body>ok</body></html>')
  })
  // 假上游的 WS：回 101 并回显
  srv.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: dummy\r\n\r\n')
    socket.on('data', (d) => socket.write(d))
  })
  srv.listen(0, '127.0.0.1', () => resolve({ server: srv, port: srv.address().port }))
})

const GATE_PORT = 13999
const PASSWORD = 'verify-gate-pass'

const gate = createPasswordGate({ getPassword: () => PASSWORD })
const proxy = createGateServer({
  port: GATE_PORT,
  upstream: { host: '127.0.0.1', port: UPSTREAM.port },
  launchToken: () => 'LAUNCHTOKEN123',
  onRequest: async (req, res, opts = {}) => {
    if (opts.upgrade) {
      if (!gate.checkWs(req)) {
        try {
          res.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
          res.destroy()
        } catch { /* noop */ }
        return true
      }
      return false
    }
    return gate.handle(req, res)
  },
})
await proxy.listen()

const FAKE_HOST = 'www.example-tunnel.nyat.app:12345'

function http(opts, body) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(opts, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

// 3.1 未登录 → 登录页（不是 DSH 页面）
{
  const r = await http({ host: '127.0.0.1', port: GATE_PORT, path: '/', method: 'GET',
    headers: { host: FAKE_HOST, accept: 'text/html' } })
  record('网关: 未登录返回登录页', r.status === 200 && /访问密码/.test(r.body) && !/FAKE-DSH/.test(r.body))
}

// 3.2 未登录 /api → 401
{
  const r = await http({ host: '127.0.0.1', port: GATE_PORT, path: '/api/x', method: 'GET',
    headers: { host: FAKE_HOST, accept: 'application/json' } })
  record('网关: 未登录 API 401', r.status === 401)
}

// 3.3 错密码 → 拒绝
{
  const body = 'password=wrong'
  const r = await http({ host: '127.0.0.1', port: GATE_PORT, path: '/__gate/login', method: 'POST',
    headers: { host: FAKE_HOST, 'content-type': 'application/x-www-form-urlencoded',
      'content-length': Buffer.byteLength(body), accept: 'text/html' } }, body)
  record('网关: 错密码被拒', r.status === 200 && /密码不正确/.test(r.body))
}

// 3.4 正密码 → 302 + cookie
let cookie = ''
{
  const body = `password=${encodeURIComponent(PASSWORD)}`
  const r = await http({ host: '127.0.0.1', port: GATE_PORT, path: '/__gate/login', method: 'POST',
    headers: { host: FAKE_HOST, 'content-type': 'application/x-www-form-urlencoded',
      'content-length': Buffer.byteLength(body), accept: 'text/html' } }, body)
  const sc = r.headers['set-cookie']?.[0] ?? ''
  cookie = sc.split(';')[0]
  record('网关: 正密码 302 + cookie', r.status === 302 && cookie.startsWith('natfrp_gate='))
}

// 3.5 ?gate= 直达
{
  const r = await http({ host: '127.0.0.1', port: GATE_PORT, path: '/?gate=' + encodeURIComponent(PASSWORD), method: 'GET',
    headers: { host: FAKE_HOST, accept: 'text/html' } })
  const sc = r.headers['set-cookie']?.[0] ?? ''
  record('网关: ?gate= 直达种 cookie', r.status === 302 && sc.startsWith('natfrp_gate='))
}

// 3.6 带 cookie → Host 已改写为回环 → 假 DSH 放行 + polyfill 注入
{
  const r = await http({ host: '127.0.0.1', port: GATE_PORT, path: '/', method: 'GET',
    headers: { host: FAKE_HOST, accept: 'text/html', cookie } })
  record('网关: Host 改写绕过围栏', r.status === 200 && /FAKE-DSH/.test(r.body), `status=${r.status}`)
  record('网关: polyfill 注入', /data-natfrp-polyfill/.test(r.body))
}

// 3.7 带 cookie + launchToken 补齐（验证转发路径带 ?token=）
{
  const r = await http({ host: '127.0.0.1', port: GATE_PORT, path: '/', method: 'GET',
    headers: { host: FAKE_HOST, accept: 'text/html', cookie } })
  // 假上游不校验 token，但改写正确性已由 3.6 证明；这里只验证不会因为 token 注入破坏请求
  record('网关: token 注入不破坏请求', r.status === 200)
  // 没有 dsh-auth-* 会话时，应当补上 ?token=
  record('网关: 无会话时补 ?token=', /[?&]token=/.test(String(r.headers['x-seen-url'] ?? '')),
    `seen=${r.headers['x-seen-url']}`)
}

// 3.7b ⚠️ 回归 #重定向循环：已持有 DSH 会话 cookie 时不得再补 ?token=
//
// DSH 的会话 cookie 名是 `dsh-auth-<sha256(authority) 的 base64url>`（COOKIE_PREFIX='dsh-auth-'）。
// 旧代码判断 `/(?:^|;\s*)dsh-auth=/`，带等号的前缀永远匹配不到 `dsh-auth-xxx=`，
// 于是每轮都往 URL 补一次 ?token= → DSH 每次回 303 Location: ./ → 浏览器报
// 「重定向你太多次」。清 Cookie 无效，因为 cookie 本身是好的，只是判断看不见它。
{
  // DSH 实际 cookie 名形如 dsh-auth-VOnL-15rFsUiCnRoyGFksKvWKcwNBRz5iarRem0Ilvo
  // （base64url(sha256(authority))，定长 43 字符）
  const hash43 = 'VOnL-15rFsUiCnRoyGFksKvWKcwNBRz5iarRem0Ilvo'
  const authCookie = `${cookie}; dsh-auth-${hash43}=deadbeef`
  const r = await http({ host: '127.0.0.1', port: GATE_PORT, path: '/', method: 'GET',
    headers: { host: FAKE_HOST, accept: 'text/html', cookie: authCookie } })
  const seen = String(r.headers['x-seen-url'] ?? '')
  record('网关: 已有 dsh-auth-<hash> 时不再补 token', !/[?&]token=/.test(seen), `seen=${seen}`)
  record('网关: 已有会话时仍正常转发', r.status === 200, `status=${r.status}`)
}

// 3.7c 裸 dsh-auth=（无 hash 后缀）同样视为已认证，避免另一种写法复发
{
  const r = await http({ host: '127.0.0.1', port: GATE_PORT, path: '/', method: 'GET',
    headers: { host: FAKE_HOST, accept: 'text/html', cookie: `${cookie}; dsh-auth=plain` } })
  const seen = String(r.headers['x-seen-url'] ?? '')
  record('网关: 裸 dsh-auth= 也不补 token', !/[?&]token=/.test(seen), `seen=${seen}`)
}

// 3.7d 形似但不相干的 cookie 不能被误判成已认证
{
  const r = await http({ host: '127.0.0.1', port: GATE_PORT, path: '/', method: 'GET',
    headers: { host: FAKE_HOST, accept: 'text/html', cookie: `${cookie}; dsh-auth-old=1; mydsh-auth=2` } })
  const seen = String(r.headers['x-seen-url'] ?? '')
  record('网关: 相似 cookie 不误判 → 仍补 token', /[?&]token=/.test(seen), `seen=${seen}`)
}

// 3.8 对照：直连假 DSH + 外部 Host → 403
{
  const r = await http({ host: '127.0.0.1', port: UPSTREAM.port, path: '/', method: 'GET',
    headers: { host: FAKE_HOST, accept: 'text/html' } })
  record('对照: 直连假 DSH + 外部 Host → 403', r.status === 403, `status=${r.status}`)
}

// 3.9 Sec-Fetch-Site 改写
{
  const r = await http({ host: '127.0.0.1', port: GATE_PORT, path: '/x', method: 'GET',
    headers: { host: FAKE_HOST, cookie, 'sec-fetch-site': 'cross-site' } })
  record('网关: 非页面请求透传', r.status === 200 || r.status === 404)
}

// 3.10 WS 升级透传（回归：Node 的 upgrade 事件签名是 (req, socket, head) 三参；
//      曾按四参解构导致 socket 拿到 head Buffer，pipe(Buffer) 抛 TypeError 击穿宿主）
import { connect as tcpConnect } from 'node:net'

function wsHandshake(cookieHeader) {
  return new Promise((resolve) => {
    const sock = tcpConnect(GATE_PORT, '127.0.0.1', () => {
      sock.write(
        `GET /ws HTTP/1.1\r\nHost: ${FAKE_HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n` +
        (cookieHeader ? `Cookie: ${cookieHeader}\r\n` : '') + `\r\n`,
      )
    })
    let got = ''
    const t = setTimeout(() => { sock.destroy(); resolve('(timeout)') }, 3000)
    t.unref?.()
    sock.on('data', (d) => {
      got += d.toString('latin1')
      if (got.includes('101') || got.includes('401')) {
        clearTimeout(t)
        sock.destroy()
        resolve(got.split('\r\n')[0])
      }
    })
    sock.on('error', () => { clearTimeout(t); resolve('(error)') })
  })
}
{
  const line = await wsHandshake('')
  record('网关: 未授权 WS → 401（不崩溃）', line.includes('401'), line)
}
{
  const line = await wsHandshake(cookie)
  record('网关: 授权 WS → 101 透传（不崩溃）', line.includes('101'), line)
}

// ---------- 4. 真实 API 冒烟（可选） ----------

if (process.env.NATFRP_TOKEN) {
  const api = createClient(process.env.NATFRP_TOKEN, { timeoutMs: 10000 })
  try {
    const tunnels = await api.tunnels()
    record('API: tunnels 真实调用', Array.isArray(tunnels), `count=${tunnels?.length ?? 0}`)
  } catch (e) {
    record('API: tunnels 真实调用', false, e.message)
  }
  try {
    const info = await api.userInfo()
    record('API: userInfo 真实调用', Boolean(info?.id), `user=${info?.name}`)
  } catch (e) {
    record('API: userInfo 真实调用', false, e.message)
  }
  try {
    const nodes = await api.nodes()
    record('API: nodes 真实调用', Boolean(nodes && typeof nodes === 'object'), `count=${Object.keys(nodes ?? {}).length}`)
  } catch (e) {
    record('API: nodes 真实调用', false, e.message)
  }
} else {
  console.log('—    跳过真实 API 冒烟（未设置 NATFRP_TOKEN）')
}

// ---------- 收尾（非阻塞：keep-alive 连接不应阻塞退出） ----------

void proxy.close().catch(() => {})
try { UPSTREAM.server.closeAllConnections?.() } catch { /* noop */ }
try { UPSTREAM.server.close() } catch { /* noop */ }

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
setTimeout(() => process.exit(failed.length === 0 ? 0 : 1), 200)
