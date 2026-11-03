// tunnel-delete-test.mjs — 删除隧道：官方契约 + 当前隧道的本地清理
//
// 官方 /tunnel/delete 的 200 响应是 { deleted, failed }，其中 failed 的含义
// 容易看反：它不是「删除失败」，而是「已经删掉了、但没能把在线 frpc 踢下线」。
// 所以这里专门钉住：
//   · 只看 deleted 判断是否删掉；failed 里的 id 仍算成功
//   · 删的是当前隧道 → 清 tunnelId、停 frpc、开关落回关闭
//   · 删的是别的隧道 → 当前配置一个字都不能动
//   · 官方没删掉 / API 报错 → 502，且本地状态原样保留
//
// 不碰真实账号：只拦 api.natfrp.com，本机插件服务器照常用。

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'

const home = mkdtempSync(join(tmpdir(), 'dsh-delete-test-'))
process.env.DSH_HOME = home

const results = []
const rec = (n, p, d = '') => { results.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`) }

/** 找一个当前空闲的端口：绑 0 拿号再放掉 */
async function freePort() {
  const s = createServer()
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  const p = s.address().port
  await new Promise((r) => s.close(r))
  return p
}

const GATE_PORT = await freePort()

// ── 官方 API 桩 ──
const calls = []
const TUNNELS = [
  { id: 90001, name: 'DSH', node: 2, type: 'tcp', local_ip: '127.0.0.1', local_port: GATE_PORT, online: true, remote: 41234 },
  { id: 90002, name: '备用', node: 2, type: 'tcp', local_ip: '127.0.0.1', local_port: 40000, online: false, remote: 41235 },
]

const jsonRes = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

// ⚠️ 只拦 api.natfrp.com；本机插件服务器仍走真实 fetch。
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(String(input))
  if (u.hostname !== 'api.natfrp.com') return realFetch(input, init)

  const method = (init.method ?? 'GET').toUpperCase()
  const body = init.body
    ? Object.fromEntries(new URLSearchParams(String(init.body)).entries())
    : null
  calls.push({ method, path: u.pathname, body, headers: init.headers ?? {} })

  if (u.pathname === '/v4/nodes') return jsonRes({ 2: { name: '内地节点', host: 'cn.natfrp.cloud', vip: 0, flag: 0b0100 } })
  if (u.pathname === '/v4/tunnels' && method === 'GET') return jsonRes(TUNNELS)
  if (u.pathname === '/v4/tunnel/edit' && method === 'POST') return jsonRes({})
  if (u.pathname === '/v4/tunnel/delete' && method === 'POST') {
    const ids = String(body?.ids ?? '').split(',').filter(Boolean).map(Number)
    // 90003：删掉了，但官方没能把 frpc 踢下线（failed 语义）
    if (ids.includes(90003)) return jsonRes({ deleted: [90003], failed: [90003] })
    // 90004：官方没删（例如隧道不存在 / 不属于当前账号）
    if (ids.includes(90004)) return jsonRes({ deleted: [], failed: [] })
    // 90005：API 直接报错
    if (ids.includes(90005)) return jsonRes({ code: 500, msg: 'internal error' }, 500)
    return jsonRes({ deleted: ids, failed: [] })
  }
  if (u.pathname === '/v4/user/info') return jsonRes({ name: 'tester', speed: '10M', traffic: [0, 0], realname: 2 })
  if (u.pathname === '/v4/user/data_plans') return jsonRes([])
  return jsonRes({ code: 404, msg: 'not mocked' }, 404)
}

// ── 起插件 ──
const mod = await import('../index.js')
let handler = null
const upstream = createServer((req, res) => { res.writeHead(200); res.end('dsh-ok') })
await new Promise((r) => upstream.listen(0, '127.0.0.1', r))

const ctx = {
  logger: () => ({ info: () => {}, warn: () => {}, error: () => {}, log: () => {} }),
  webServer: { port: upstream.address().port, register: ({ handler: h }) => { handler = h; return () => {} } },
  credentials: { resolve: async () => 'FAKE-TOKEN', set: async () => {} },
  connection: { authenticatedUrl: (u) => `${u}/?token=abc` },
  timer: {},
  effect: (fn) => { fn?.(); return () => {} },
  inject: () => {},
  get: () => undefined,
}

// enabled: true + 当前隧道 90001 —— 验证删除当前隧道时开关会落回关闭
mod.apply(ctx, { gatePort: GATE_PORT, tunnelId: '90001', enabled: true })

const srv = createServer((req, res) => handler(req, res))
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${srv.address().port}`
const getJSON = async (p) => {
  const r = await fetch(base + p)
  return { status: r.status, body: await r.json().catch(() => null) }
}
const postJSON = async (p, body) => {
  const r = await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}

// 等启动流程（autoAlign）跑完，避免它和后面的调用计数混在一起
await new Promise((r) => setTimeout(r, 200))
calls.length = 0

const boot = await getJSON('/natfrp/api/state')
rec('前置：当前隧道是 90001', String(boot.body?.tunnelId) === '90001', String(boot.body?.tunnelId))
rec('前置：开关是开的', boot.body?.enabled === true, String(boot.body?.enabled))

// ── 1) 删除「非当前」隧道：配置不动 ──
const other = await postJSON('/natfrp/api/tunnel/delete', { id: 90002 })
rec('POST /tunnel/delete 返回 200', other.status === 200, `status=${other.status} ${JSON.stringify(other.body)}`)
rec('非当前隧道返回 wasCurrent=false', other.body?.wasCurrent === false, String(other.body?.wasCurrent))
rec('删非当前隧道后当前隧道不变', String(other.body?.tunnelId) === '90001', String(other.body?.tunnelId))
rec('删非当前隧道后开关不变', other.body?.enabled === true, String(other.body?.enabled))

const delCall = calls.find((c) => c.path === '/v4/tunnel/delete')
rec('打到官方 POST /tunnel/delete', Boolean(delCall))
rec('官方收到 ids=90002', delCall?.body?.ids === '90002', String(delCall?.body?.ids))
rec('删除请求用 form 编码', String(delCall?.headers?.['content-type'] ?? '').includes('x-www-form-urlencoded'))
rec('删除请求带 Bearer 认证', String(delCall?.headers?.authorization ?? '') === 'Bearer FAKE-TOKEN')
rec('响应带回官方 deleted', JSON.stringify(other.body?.deleted) === '[90002]', JSON.stringify(other.body?.deleted))

// ── 2) 删除当前隧道：清 tunnelId、关开关 ──
calls.length = 0
const current = await postJSON('/natfrp/api/tunnel/delete', { id: 90001 })
rec('删当前隧道返回 200', current.status === 200, `status=${current.status}`)
rec('删当前隧道返回 wasCurrent=true', current.body?.wasCurrent === true, String(current.body?.wasCurrent))
rec('删当前隧道后 tunnelId 清空', String(current.body?.tunnelId) === '', JSON.stringify(current.body?.tunnelId))
rec('删当前隧道后开关落回关闭', current.body?.enabled === false, String(current.body?.enabled))
rec('删当前隧道后 frpc 不运行', current.body?.frpc?.running !== true)

const currentAfter = await getJSON('/natfrp/api/state')
rec('状态已落盘（重新读 /state 仍是关的）', currentAfter.body?.enabled === false && String(currentAfter.body?.tunnelId) === '',
  `enabled=${currentAfter.body?.enabled} tunnelId=${JSON.stringify(currentAfter.body?.tunnelId)}`)

// ── 3) failed 里出现不代表删除失败（官方：已删除但没踢下线）──
calls.length = 0
const kicked = await postJSON('/natfrp/api/tunnel/delete', { id: 90003 })
rec('deleted 命中就算成功，即使 failed 里有它', kicked.status === 200 && kicked.body?.ok === true,
  `status=${kicked.status}`)
rec('failed 原样带回给界面', JSON.stringify(kicked.body?.failed) === '[90003]', JSON.stringify(kicked.body?.failed))
rec('非当前隧道删除后仍没有当前隧道', String(kicked.body?.tunnelId) === '', JSON.stringify(kicked.body?.tunnelId))

// ── 4) 官方没删掉 → 502，本地状态不动 ──
const beforeMiss = await getJSON('/natfrp/api/state')
const miss = await postJSON('/natfrp/api/tunnel/delete', { id: 90004 })
rec('deleted 里没有该 id → 502 delete-failed',
  miss.status === 502 && miss.body?.error === 'delete-failed', `status=${miss.status} ${JSON.stringify(miss.body)}`)
const afterMiss = await getJSON('/natfrp/api/state')
rec('删除未生效时本地状态不变',
  String(afterMiss.body?.tunnelId) === String(beforeMiss.body?.tunnelId)
  && afterMiss.body?.enabled === beforeMiss.body?.enabled)

// ── 5) 官方 API 报错 → 502 api-failed，透传原始信息 ──
const apiErr = await postJSON('/natfrp/api/tunnel/delete', { id: 90005 })
rec('API 500 → 502 api-failed', apiErr.status === 502 && apiErr.body?.error === 'api-failed',
  `status=${apiErr.status}`)
rec('透传官方错误信息', /internal error/.test(String(apiErr.body?.message ?? '')), String(apiErr.body?.message))

// ── 6) 参数不合法时不打官方接口 ──
calls.length = 0
const bad = await postJSON('/natfrp/api/tunnel/delete', { id: 'abc' })
rec('id 非数字 → 400 bad-id', bad.status === 400 && bad.body?.error === 'bad-id', `status=${bad.status}`)
const missing = await postJSON('/natfrp/api/tunnel/delete', {})
rec('缺少 id → 400 bad-id', missing.status === 400 && missing.body?.error === 'bad-id', `status=${missing.status}`)
rec('参数不合法时不调官方接口', calls.filter((c) => c.path === '/v4/tunnel/delete').length === 0,
  String(calls.filter((c) => c.path === '/v4/tunnel/delete').length))

const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} passed`)
await new Promise((r) => srv.close(r))
await new Promise((r) => upstream.close(r))
setTimeout(() => process.exit(passed === results.length ? 0 : 1), 200)
