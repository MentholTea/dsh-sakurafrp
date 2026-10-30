// credential-token-test.mjs — 密钥只存在 DSH 凭据库时，同步取值也必须拿得到
//
// 回归的 bug：
//   frpc 的 getToken 是同步接口，而 ctx.credentials.resolve() 是异步的。
//   原来 tokenNow() 只读本地 token 文件，于是「密钥存在凭据库」的用户：
//     startAll() 里 await resolveToken() 拿到了密钥（能过判空、能调 API），
//     紧接着 frpc.start() 调 tokenNow() 却返回空 → `start 拒绝: no-token`。
//   现象是隧道永远连不上，日志里 no-token 与 aligned 交替出现。
//
// 这里用 enabled:false 避免真的去连 SakuraFrp API，只验同步取值这一环。

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'

const home = mkdtempSync(join(tmpdir(), 'dsh-cred-test-'))
process.env.DSH_HOME = home

const mod = await import('./index.js')

const results = []
const ok = (n, c, e = '') => {
  results.push(c)
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? ` — ${e}` : ''}`)
}

const logs = []
const logger = () => ({
  info: (...a) => logs.push(a.join(' ')),
  warn: (...a) => logs.push(a.join(' ')),
  error: (...a) => logs.push(a.join(' ')),
  log: (...a) => logs.push(a.join(' ')),
})

// 32 位随机串，形如 SakuraFrp 访问密钥；故意不写任何 token 文件
const SECRET = 'k'.repeat(32)
let resolveCalls = 0

let handler = null
const ctx = {
  logger,
  webServer: { port: 12345, register: ({ handler: h }) => { handler = h; return () => { handler = null } } },
  credentials: {
    resolve: async (key) => { resolveCalls++; return key === 'NATFRP_TOKEN' ? SECRET : '' },
    set: async () => {},
  },
  connection: { authenticatedUrl: (u) => u },
  timer: {},
  effect: (fn) => { fn?.(); return () => {} },
  inject: () => {},
  get: () => undefined,
}

// enabled:false → 只跑预热与网关，不触发 startAll 的网络请求
mod.apply(ctx, { enabled: false, gatePort: 0 })

await new Promise((r) => setTimeout(r, 300))

ok('启动时预热过凭据库', resolveCalls > 0, `resolve 调用 ${resolveCalls} 次`)

const srv = createServer((req, res) => handler(req, res))
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${srv.address().port}`

const state = await fetch(`${base}/natfrp/api/state`).then((r) => r.json()).catch(() => null)

ok('/natfrp/api/state 可达', state !== null)
// 这条是核心：旧实现在这里恒为 false，因为 tokenNow() 不读凭据库
ok('snapshot.tokenConfigured = true（密钥来自凭据库）', state?.tokenConfigured === true, `got=${state?.tokenConfigured}`)

// frpc.start 与 snapshot 用的是同一个 tokenNow()，故此项成立即说明 frpc 能拿到密钥
ok('没有出现 no-token 拒绝', !logs.some((l) => l.includes('no-token')))

// 反向验证：凭据库为空时不能假报已配置
const mod2 = await import('./index.js?empty=1')
const home2 = mkdtempSync(join(tmpdir(), 'dsh-cred-empty-'))
process.env.DSH_HOME = home2
let handler2 = null
mod2.apply({
  ...ctx,
  webServer: { port: 12345, register: ({ handler: h }) => { handler2 = h; return () => {} } },
  credentials: { resolve: async () => '', set: async () => {} },
}, { enabled: false, gatePort: 0 })

await new Promise((r) => setTimeout(r, 200))
const srv2 = createServer((req, res) => handler2(req, res))
await new Promise((r) => srv2.listen(0, '127.0.0.1', r))
const state2 = await fetch(`http://127.0.0.1:${srv2.address().port}/natfrp/api/state`).then((r) => r.json()).catch(() => null)
ok('凭据库为空时 tokenConfigured = false', state2?.tokenConfigured === false, `got=${state2?.tokenConfigured}`)

const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} passed`)
srv.close(); srv2.close()
setTimeout(() => process.exit(passed === results.length ? 0 : 1), 200)
