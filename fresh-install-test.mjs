// fresh-install-test.mjs — 模拟「刚装好、从没配过」的第一次加载。
//
// 为什么需要它：插件的默认状态完全由「有没有 state.json」和 cordis 配置里写没写值决定。
// 数据没删干净时（旧 state.json 里留着 enabled:true、gatePort:3000），新装上来就自动开着、
// 端口还是上次那个 —— 用户看到的就是「装完就能用，但接错了地方」。
// 这条测试用空 DSH_HOME 跑一遍 apply()，断言冷启动快照是彻底空白的状态。

import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'

const home = mkdtempSync(join(tmpdir(), 'dsh-fresh-install-'))
process.env.DSH_HOME = home

const results = []
const ok = (name, cond, extra = '') => {
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`)
  return cond
}

const mod = await import('./index.js')

let handler = null
const upstream = createServer((req, res) => { res.writeHead(200); res.end('dsh-ok') })
await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
const dshPort = upstream.address().port

const ctx = {
  logger: () => ({ info: () => {}, warn: () => {}, error: () => {}, log: () => {} }),
  webServer: {
    port: dshPort,
    register: ({ handler: h }) => { handler = h; return () => { handler = null } },
  },
  // 全新安装：credentials 里没有 NATFRP_TOKEN
  credentials: { resolve: async () => '', set: async () => {}, delete: async () => {} },
  connection: { authenticatedUrl: (u) => `${u}/?token=abc` },
  timer: {},
  effect: (fn) => { fn?.(); return () => {} },
  inject: () => {},
  get: () => undefined,
}

// 关键：只传 tokenRef（cordis.patch.yml 里就这一个），不传 enabled / gatePort
mod.apply(ctx, { tokenRef: 'NATFRP_TOKEN' })

const srv = createServer((req, res) => handler(req, res))
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${srv.address().port}`
const s = await (await fetch(`${base}/natfrp/api/state`)).json()

console.log('冷启动快照:', JSON.stringify({
  enabled: s.enabled,
  gatePort: s.gatePort,
  tunnelId: s.tunnelId,
  tokenConfigured: s.tokenConfigured,
  gatePasswordConfigured: s.gatePasswordConfigured,
  gateRunning: s.gateRunning,
}, null, 0))

// ── 默认关闭 ──
ok('默认是关闭状态', s.enabled === false, `enabled=${s.enabled}`)
ok('默认不启动网关', s.gateRunning === false, `gateRunning=${s.gateRunning}`)

// ── 四个字段都是空的 ──
ok('本机端口默认空', !s.gatePort, `gatePort=${JSON.stringify(s.gatePort)}`)
ok('隧道默认未选', !s.tunnelId, `tunnelId=${JSON.stringify(s.tunnelId)}`)
ok('访问密钥默认未配', s.tokenConfigured === false)
ok('访问密码默认未配', s.gatePasswordConfigured === false)

// ── 不产生任何残留 ──
ok('首次加载不创建 state.json（没东西可存）', !existsSync(join(home, 'dsh-sakurafrp', 'state.json')))
ok('首次加载不创建密码文件', !existsSync(join(home, 'dsh-sakurafrp', 'gate-password.txt')))
ok('首次加载不下载 frpc', !existsSync(join(home, 'dsh-sakurafrp', 'frpc-standalone.exe')))

// 状态文件若存在，也不该含 enabled:true / 旧端口（防止 config 被写回磁盘时夹带）
const statePath = join(home, 'dsh-sakurafrp', 'state.json')
if (existsSync(statePath)) {
  const st = JSON.parse(readFileSync(statePath, 'utf8'))
  ok('state.json 里没有 enabled:true', st.enabled !== true)
  ok('state.json 里没有预置端口', !st.gatePort)
}

// ── 路由本身可用（不是靠错误页面蒙过去的）──
const r = await fetch(`${base}/natfrp/api/state`)
ok('/natfrp/api/state → 200', r.status === 200, `status=${r.status}`)

await new Promise((r2) => srv.close(r2))
await new Promise((r2) => upstream.close(r2))

const pass = results.filter((x) => x.startsWith('PASS')).length
console.log(results.join('\n'))
console.log(`\n${pass}/${results.length} passed`)
process.exit(pass === results.length ? 0 : 1)
