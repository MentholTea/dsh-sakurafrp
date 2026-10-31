// apply-test.mjs — 真正调用 apply()，用假 ctx 把插件跑起来打管理接口。
//
// 为什么需要它：其它测试都在测单个模块，没有一条覆盖「apply 之后的真实快照」。
// 一旦 snapshot 里引用了不存在的变量（例如重构时把 lastTunnelInfo 写成 tunnelInfo），
// 单模块测试全绿、插件一装就 500 —— 这类错误只有端到端跑一遍才拦得住。

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'

// 必须在 import 插件之前设：paths.mjs 在模块加载时读 DSH_HOME
const home = mkdtempSync(join(tmpdir(), 'dsh-apply-test-'))
process.env.DSH_HOME = home

const results = []
const ok = (name, cond, extra = '') => {
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`)
  return cond
}

const mod = await import('../index.js')

let handler = null
const disposers = []
const logger = () => ({
  info: () => {}, warn: () => {}, error: () => {}, log: () => {},
})

// 假 DSH WebServer：只回一句固定文本，用来验证 dshPort 透传
const upstream = createServer((req, res) => { res.writeHead(200); res.end('dsh-ok') })
await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
const dshPort = upstream.address().port

// 本机端口默认是空的（新装什么都不知道），所以测试必须自己给一个真正的空闲端口，
// 否则网关根本不会启动，「网关已监听」这条永远失败。
const GATE_PORT = await (async () => {
  const probe = createServer()
  await new Promise((r) => probe.listen(0, '127.0.0.1', r))
  const p = probe.address().port
  await new Promise((r) => probe.close(r))
  return p
})()

const ctx = {
  logger,
  webServer: {
    port: dshPort,
    register: ({ handler: h }) => { handler = h; return () => { handler = null } },
  },
  credentials: { resolve: async () => '', set: async () => {} },
  connection: { authenticatedUrl: (u) => `${u}/?token=abc` },
  timer: {},
  effect: (fn) => { const d = fn?.(); if (typeof d === 'function') disposers.push(d); return () => {} },
  inject: () => {},
  get: () => undefined,
}

try {
  mod.apply(ctx, { enabled: false, gatePort: GATE_PORT })
  ok('apply() 不抛异常', true)
} catch (e) {
  ok('apply() 不抛异常', false, String(e?.stack ?? e?.message ?? e).split('\n').slice(0, 3).join(' | '))
}

ok('注册了 /natfrp 路由', typeof handler === 'function')

const srv = createServer((req, res) => handler(req, res))
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${srv.address().port}`
const getState = async () => {
  const r = await fetch(`${base}/natfrp/api/state`)
  return { status: r.status, body: await r.json().catch(() => null) }
}
const postConfig = async (patch) => {
  const r = await fetch(`${base}/natfrp/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}

let s = await getState()
ok('/natfrp/api/state → 200', s.status === 200, `status=${s.status}`)
ok('snapshot 里 dshPort 正确', s.body?.dshPort === dshPort, `got=${s.body?.dshPort} want=${dshPort}`)
ok('snapshot 结构完整（tunnelInfo 不炸）', s.body !== null && 'tunnelInfo' in s.body)
ok('初始未设密码', s.body?.gatePasswordConfigured === false)
ok('网关已监听', s.body?.gateRunning === true)

let r = await postConfig({ gatePassword: 'pw-123456' })
ok('设置密码 → 200', r.status === 200, `status=${r.status}`)
ok('设置后 gatePasswordConfigured=true', r.body?.gatePasswordConfigured === true)
ok('响应不含明文密码', !JSON.stringify(r.body).includes('pw-123456'))

r = await postConfig({ clearGatePassword: true })
ok('清除密码 → 200', r.status === 200, `status=${r.status}`)
ok('清除后 gatePasswordConfigured=false', r.body?.gatePasswordConfigured === false)

r = await postConfig({ tunnelId: '12ab34' })
ok('tunnelId 只保留数字', r.body?.tunnelId === '1234', `got=${r.body?.tunnelId}`)

r = await postConfig({ gatePort: 80 })
// 现在非法端口是明确报错（400），而不是悄悄忽略 —— 悄悄忽略会让用户以为改成功了
ok('非法端口 80 → 400 且不改端口',
  r.status === 400 && Number(r.body?.port) === 80, `status=${r.status} port=${r.body?.port}`)
r = await postConfig({})
ok('非法端口被拒后当前端口仍是原值', Number(r.body?.gatePort) === GATE_PORT, `gatePort=${r.body?.gatePort} want=${GATE_PORT}`)

r = await fetch(`${base}/natfrp/api/logs`)
ok('/natfrp/api/logs → 200', r.status === 200, `status=${r.status}`)

// ── 关掉「安装成功」提示后不再出现（跨会话）──
r = await fetch(`${base}/natfrp/api/frpc/ack-result`, { method: 'POST' })
let ack = await r.json().catch(() => null)
ok('/frpc/ack-result → 200', r.status === 200, `status=${r.status}`)
ok('没装过时 ack 不记录任何时间点', ack?.acknowledgedAt === 0, `acked=${ack?.acknowledgedAt}`)

// 前端若传一个「未来」的 at，不能把以后所有成功提示一起吞掉
r = await fetch(`${base}/natfrp/api/frpc/ack-result`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ at: Date.now() + 86_400_000 }),
})
ack = await r.json().catch(() => null)
ok('伪造的未来 at 被忽略', ack?.acknowledgedAt === 0, `acked=${ack?.acknowledgedAt}`)

// 畸形 body 不能让接口 500
r = await fetch(`${base}/natfrp/api/frpc/ack-result`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{not json',
})
ok('畸形 body 不 500', r.status === 200, `status=${r.status}`)

s = await getState()
ok('未安装时 lastResult 为 null', s.body?.frpcInstall?.lastResult === null)

// 忽略 / 恢复提示仍然可用
r = await fetch(`${base}/natfrp/api/frpc/dismiss`, { method: 'POST' })
let dj = await r.json().catch(() => null)
ok('/frpc/dismiss → 200', r.status === 200 && dj?.dismissed === true, `status=${r.status}`)
ok('dismiss 后 state 标记 dismissed', (await getState()).body?.frpcInstall?.dismissed === true)
r = await fetch(`${base}/natfrp/api/frpc/undismiss`, { method: 'POST' })
ok('/frpc/undismiss → 200', r.status === 200)
ok('undismiss 后恢复未忽略', (await getState()).body?.frpcInstall?.dismissed === false)

r = await fetch(`${base}/natfrp/api/nope`)
ok('未知路由 → 404', r.status === 404, `status=${r.status}`)

console.log(results.join('\n'))
const passed = results.filter((x) => x.startsWith('PASS')).length
console.log(`\n${passed}/${results.length} passed`)

for (const d of disposers) { try { await d() } catch { /* noop */ } }
srv.close()
upstream.close()
setTimeout(() => process.exit(passed === results.length ? 0 : 1), 200)
