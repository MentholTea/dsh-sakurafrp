// admin-auth-test.mjs —— 网关管理接口的鉴权回归。
//
// 背景（这是个真实踩过的坑）：
//   管理路由曾经用 req.socket.remoteAddress 判断「是不是本机」，
//   但公网流量是 frpc 从 127.0.0.1 转发进来的 —— 来源地址恒为回环，
//   于是任何能访问隧道的人都能未授权 POST /natfrp/api/config 改掉访问密码，
//   再登录拿到完整 DSH。本套件锁死「网关侧只认密码门 cookie」这条边界。
//
// 全部离线：不连 SakuraFrp、不需要访问密钥、只写临时 DSH_HOME。

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request as httpRequest } from 'node:http'
import { connect as tcpConnect } from 'node:net'

// 必须在 import 插件之前设：paths.mjs 在模块加载时读 DSH_HOME
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-admin-auth-test-'))

const results = []
const rec = (name, cond, extra = '') => {
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`)
  return cond
}

const mod = await import('../index.js')

let handler = null
const logger = () => ({ info: () => {}, warn: () => {}, error: () => {}, log: () => {} })

// 假 DSH：HTTP 回固定文本，WS 回 101 并回显
const upstream = createServer((req, res) => { res.writeHead(200); res.end('dsh-ok') })
upstream.on('upgrade', (req, socket) => {
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
  socket.on('data', (d) => socket.write(d))
})
await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
const dshPort = upstream.address().port

const freePort = async () => {
  const probe = createServer()
  await new Promise((r) => probe.listen(0, '127.0.0.1', r))
  const p = probe.address().port
  await new Promise((r) => probe.close(r))
  return p
}
const GATE_PORT = await freePort()

const ctx = {
  logger,
  webServer: { port: dshPort, register: ({ handler: h }) => { handler = h; return () => {} } },
  credentials: { resolve: async () => '', set: async () => {} },
  connection: { authenticatedUrl: (u) => `${u}/?token=abc` },
  timer: {},
  effect: (fn) => { const d = fn?.(); if (typeof d === 'function') d(); return () => {} },
  inject: () => {},
  get: () => undefined,
}

mod.apply(ctx, { enabled: false, gatePort: GATE_PORT })

// 等网关真的监听起来（apply 里是 void startGate，异步）
const waitPort = async (port, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const s = tcpConnect(port, '127.0.0.1')
      s.once('connect', () => { s.destroy(); resolve(true) })
      s.once('error', () => resolve(false))
      setTimeout(() => { s.destroy(); resolve(false) }, 300).unref?.()
    })
    if (ok) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}
rec('网关已监听', await waitPort(GATE_PORT))

// 本机设置页走的是 DSH webServer 上的 /natfrp 路由，不经过网关
const local = createServer((req, res) => handler(req, res))
await new Promise((r) => local.listen(0, '127.0.0.1', r))
const LOCAL = `http://127.0.0.1:${local.address().port}`
const GATE = `http://127.0.0.1:${GATE_PORT}`

const json = async (r) => {
  const t = await r.text()
  try { return JSON.parse(t) } catch { return { raw: t.slice(0, 120) } }
}
const setPw = (pw) => fetch(`${LOCAL}/natfrp/api/config`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gatePassword: pw }),
})
const login = (pw) => fetch(`${GATE}/__gate/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
  body: `password=${encodeURIComponent(pw)}`,
  redirect: 'manual',
})
const cookieOf = (r) => {
  const raw = r.headers.get('set-cookie') ?? ''
  const m = raw.match(/natfrp_gate=[^;]+/)
  return m ? m[0] : ''
}

const PASSWORD = 'GatePass-123456'
let r = await setPw(PASSWORD)
rec('本机通道可设密码（不经过网关）', r.status === 200)
rec('本机通道无需 cookie 即可读 state', (await fetch(`${LOCAL}/natfrp/api/state`)).status === 200)

// ── 1) 未登录：管理接口必须拒绝 ──
r = await fetch(`${GATE}/natfrp/api/state`, { headers: { accept: 'application/json' } })
rec('未登录读 state → 401（不是 200 快照）', r.status === 401, `status=${r.status}`)

r = await fetch(`${GATE}/natfrp/api/logs`)
rec('未登录读 logs → 401', r.status === 401, `status=${r.status}`)

r = await fetch(`${GATE}/natfrp/api/config`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gatePassword: 'attacker-chosen' }),
})
const hacked = await json(r)
rec('未登录改密码 → 401 且不返回快照', r.status === 401 && !hacked.enabled, `status=${r.status}`)

// 攻击者那一下没生效：原密码仍然能登录
r = await login(PASSWORD)
let cookie = cookieOf(r)
rec('原密码仍可登录（未被篡改）', r.status === 302 && Boolean(cookie), `status=${r.status}`)

// ── 1b) 路径花招：换写法不能绕过鉴权 ──
// 用原始 http.request 发，避免 fetch/URL 在客户端就把路径规范化掉
const rawGet = (path, cookieHeader = '') => new Promise((resolve) => {
  const req = httpRequest(
    { host: '127.0.0.1', port: GATE_PORT, path, method: 'GET', headers: { accept: 'application/json', ...(cookieHeader ? { cookie: cookieHeader } : {}) } },
    (res) => {
      let body = ''
      res.on('data', (d) => { body += d })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    },
  )
  req.on('error', () => resolve({ status: 0, body: '' }))
  req.end()
})
const TRICKS = [
  ['//natfrp/api/state', '双斜杠'],
  ['/natfrp%2Fapi%2Fstate', '编码斜杠'],
  ['/NATFRP/api/state', '大写'],
  ['/natfrp/./api/state', '点段'],
  ['/natfrp/../natfrp/api/state', '上跳'],
  ['/natfrp/api/state/', '尾斜杠'],
  ['/natfrp/api/state?x=1', '带查询串'],
]
for (const [p, label] of TRICKS) {
  const res = await rawGet(p)
  const leaked = res.status === 200 && res.body.includes('"gatePort"')
  rec(`路径花招「${label}」不泄露快照`, !leaked, `${p} → ${res.status}`)
}
{
  const res = await rawGet('/natfrp/api/state', 'natfrp_gate=deadbeef')
  rec('伪造 cookie 被拒', res.status === 401, `status=${res.status}`)
}

// ── 2) 已登录：管理接口放行 ──
r = await fetch(`${GATE}/natfrp/api/state`, { headers: { accept: 'application/json', cookie } })
const snap = await json(r)
rec('带 cookie 读 state → 200', r.status === 200 && snap.gatePasswordConfigured === true, `status=${r.status}`)

// ── 3) WS：同样只认 cookie ──
const wsHandshake = (cookieHeader) => new Promise((resolve) => {
  const sock = tcpConnect(GATE_PORT, '127.0.0.1', () => {
    sock.write(
      'GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n' +
      (cookieHeader ? `Cookie: ${cookieHeader}\r\n` : '') + '\r\n',
    )
  })
  let got = ''
  const t = setTimeout(() => { sock.destroy(); resolve('(timeout)') }, 3000)
  t.unref?.()
  sock.on('data', (d) => {
    got += d.toString('latin1')
    if (got.includes('101') || got.includes('401')) {
      clearTimeout(t); sock.destroy(); resolve(got.split('\r\n')[0])
    }
  })
  sock.on('error', () => { clearTimeout(t); resolve('(error)') })
})
{
  const line = await wsHandshake('')
  rec('未授权 WS → 401', line.includes('401'), line)
}
{
  const line = await wsHandshake(cookie)
  rec('授权 WS → 101 透传', line.includes('101'), line)
}

// ── 4) 已登录可以改密码，改完旧 cookie 失效、新密码可登录 ──
r = await fetch(`${GATE}/natfrp/api/config`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ gatePassword: 'NewPass-abcdef' }),
})
rec('带 cookie 改密码 → 200', r.status === 200, `status=${r.status}`)
{
  const after = await fetch(`${GATE}/natfrp/api/state`, { headers: { accept: 'application/json', cookie } })
  rec('改密后旧 cookie 失效', after.status === 401, `status=${after.status}`)
}
{
  const again = await login('NewPass-abcdef')
  rec('新密码可登录', again.status === 302 && Boolean(cookieOf(again)), `status=${again.status}`)
}

// ── 5) 普通页面仍是密码门（对照）──
{
  const page = await fetch(`${GATE}/`, { headers: { accept: 'text/html' } })
  const html = await page.text()
  rec('未登录访问 / → 登录页', /远程访问验证/.test(html), `status=${page.status}`)
}

console.log(results.join('\n'))
const passed = results.filter((x) => x.startsWith('PASS')).length
console.log(`\n${passed}/${results.length} passed`)

local.close()
upstream.close()
setTimeout(() => process.exit(passed === results.length ? 0 : 1), 200)
