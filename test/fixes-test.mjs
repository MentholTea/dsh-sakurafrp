// fixes-test.mjs —— 针对已修 bug 的回归用例（每个用例都对应一次真实踩坑）。
//
//   1) displayPath 跨盘截断，显示成 "~/.dsh/.exe"
//   2) 「login to server failed」被误计入互踢，密钥填错却提示"疑似互踢"
//   3) 旧版 state.json 里的明文 gatePassword 迁移后仍留在原处
//   4) /port/check 接受 80 这类特权端口，与保存时的校验口径不一致
//
// 全部离线：只写临时 DSH_HOME。

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { Readable } from 'node:stream'

const results = []
const rec = (name, cond, extra = '') => {
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`)
  return cond
}

// ---------- 1) displayPath ----------
{
  const { displayPath } = await import('../paths.mjs')
  const home = join(homedir(), '.dsh')
  const cross = 'D:\\tools\\frpc.exe'
  const d = displayPath(cross, home)
  rec('跨盘自定义路径原样显示（不被截成 ~/.dsh/.exe）', d === cross, d)
  rec('跨盘路径不出现半截后缀', !/^~\/\.dsh\/\.[a-z]+$/i.test(d), d)

  const inside = join(home, 'dsh-sakurafrp', 'frpc.exe')
  rec('home 之下的路径仍缩成 ~/.dsh/...',
    displayPath(inside, home) === '~/.dsh/dsh-sakurafrp/frpc.exe', displayPath(inside, home))
  rec('home 本身仍是 ~/.dsh', displayPath(home, home) === '~/.dsh', displayPath(home, home))
}

// ---------- 2) frpc 互踢判定 ----------
{
  const { createFrpcManager } = await import('../frpc.mjs')

  const badToken = createFrpcManager({ frpcPath: 'x', getToken: () => 't' })
  for (let i = 0; i < 8; i++) badToken._feed('[E] login to server failed: token invalid')
  rec('密钥错误不再误判为互踢', badToken.snapshot().kickSuspect === false)

  const kicked = createFrpcManager({ frpcPath: 'x', getToken: () => 't' })
  for (let i = 0; i < 6; i++) kicked._feed('[E] 网络波动导致数据连接断开, 正在重试: EOF')
  rec('真实断线风暴仍判定互踢', kicked.snapshot().kickSuspect === true)
}

// ---------- 3) 旧 state.json 明文密码迁移 ----------
const home = mkdtempSync(join(tmpdir(), 'dsh-fixes-test-'))
process.env.DSH_HOME = home
mkdirSync(join(home, 'dsh-sakurafrp'), { recursive: true })
writeFileSync(
  join(home, 'dsh-sakurafrp', 'state.json'),
  JSON.stringify({ enabled: false, tunnelId: '', gatePassword: 'legacy-plain-pass' }),
)

const mod = await import('../index.js')
let handler = null
const ctx = {
  logger: () => ({ info: () => {}, warn: () => {}, error: () => {}, log: () => {} }),
  webServer: { port: 65000, register: ({ handler: h }) => { handler = h; return () => {} } },
  credentials: { resolve: async () => '', set: async () => {} },
  connection: { authenticatedUrl: (u) => u },
  timer: {},
  effect: (fn) => { const d = fn?.(); if (typeof d === 'function') d(); return () => {} },
  inject: () => {},
  get: () => undefined,
}
mod.apply(ctx, { enabled: false })

{
  const stateRaw = readFileSync(join(home, 'dsh-sakurafrp', 'state.json'), 'utf8')
  const state = JSON.parse(stateRaw)
  rec('state.json 不再包含 gatePassword', !('gatePassword' in state), stateRaw.slice(0, 100))
  rec('state.json 里搜不到明文密码', !stateRaw.includes('legacy-plain-pass'))
  const pwFile = join(home, 'dsh-sakurafrp', 'gate-password.txt')
  rec('密码已迁到 0600 密码文件', existsSync(pwFile) && readFileSync(pwFile, 'utf8') === 'legacy-plain-pass')
}

// ---------- 4) /port/check 与保存口径一致 ----------
let base = ''
let localSrv = null
{
  const srv = createServer((req, res) => handler(req, res))
  localSrv = srv
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${srv.address().port}`

  const r80 = await fetch(`${base}/natfrp/api/port/check?port=80`)
  rec('特权端口 80 → 400', r80.status === 400, `status=${r80.status}`)

  const rOk = await fetch(`${base}/natfrp/api/port/check?port=65001`)
  const body = await rOk.json().catch(() => null)
  rec('合法端口 65001 → 200 且 inRange', rOk.status === 200 && body?.inRange === true, `status=${rOk.status}`)

  const rBad = await fetch(`${base}/natfrp/api/port/check?port=99999`)
  rec('越界端口 99999 → 400', rBad.status === 400, `status=${rBad.status}`)
}

// ---------- 5) 清空密码后重启，config 里的旧密码不能复活 ----------
{
  // 用子进程模拟"重启"：apply() 的密码来源只在模块加载 + apply 时求值
  const bootPath = join(home, 'boot.mjs')
  writeFileSync(bootPath, `
import { createServer } from 'node:http'
const mod = await import(${JSON.stringify(new URL('../index.js', import.meta.url).href)})
let handler = null
const ctx = {
  logger: () => ({}),
  webServer: { port: 1, register: ({ handler: h }) => { handler = h; return () => {} } },
  credentials: { resolve: async () => '' },
  connection: {},
  timer: {},
  effect: (fn) => { const d = fn?.(); if (typeof d === 'function') d(); return () => {} },
  inject: () => {},
  get: () => undefined,
}
mod.apply(ctx, { enabled: false, gatePassword: 'cfg-pass' })
const srv = createServer((req, res) => handler(req, res))
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const res = await fetch('http://127.0.0.1:' + srv.address().port + '/natfrp/api/state')
const j = await res.json()
console.log('CONFIGURED=' + j.gatePasswordConfigured)
srv.close()
process.exit(0)
`)
  const boot = () => execFileSync(process.execPath, [bootPath], {
    env: { ...process.env, DSH_HOME: home }, encoding: 'utf8',
  })

  const postCfg = (patch) => fetch(`${base}/natfrp/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
  })
  const stateFile = join(home, 'dsh-sakurafrp', 'state.json')

  let r = await postCfg({ clearGatePassword: true })
  rec('清空密码 → 200', r.status === 200, `status=${r.status}`)
  rec('清空后落「已清空」墓碑', JSON.parse(readFileSync(stateFile, 'utf8')).gatePasswordCleared === true)
  rec('重启后 config 里的密码不复活', /CONFIGURED=false/.test(boot()), boot().trim().split('\n').pop())

  r = await postCfg({ gatePassword: 'brand-new-pass' })
  rec('重设密码 → 200', r.status === 200, `status=${r.status}`)
  rec('重设后撤掉墓碑', JSON.parse(readFileSync(stateFile, 'utf8')).gatePasswordCleared === false)
  rec('重启后密码正常生效', /CONFIGURED=true/.test(boot()), boot().trim().split('\n').pop())
}

// ---------- 6) 一次 API 失败不能被永久记成「接口异常」 ----------
{
  // 给插件一个假 token，让 apiOrNull() 真的建出客户端
  writeFileSync(join(home, 'dsh-sakurafrp', 'token.txt'), 'fake-token-for-test')

  const realFetch = globalThis.fetch
  let apiMode = 'fail'
  globalThis.fetch = async (input, init) => {
    const u = String(input?.url ?? input)
    if (u.includes('api.natfrp.com')) {
      return apiMode === 'fail'
        ? new Response(JSON.stringify({ code: 500, msg: 'boom' }), { status: 500, headers: { 'content-type': 'application/json' } })
        : new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return realFetch(input, init)
  }

  const state = async () => (await fetch(`${base}/natfrp/api/state`)).json()

  const bad = await fetch(`${base}/natfrp/api/tunnels`)
  rec('API 失败时 tunnels → 502', bad.status === 502, `status=${bad.status}`)
  rec('失败后 apiError 有值', Boolean((await state()).apiError))

  apiMode = 'ok'
  const good = await fetch(`${base}/natfrp/api/tunnels`)
  rec('API 恢复后 tunnels → 200', good.status === 200, `status=${good.status}`)
  rec('成功后 apiError 自愈（不会永久标红）', (await state()).apiError === undefined)

  globalThis.fetch = realFetch
}

// ---------- 7) 登录后回跳原地址（deep link 不再被丢回首页） ----------
{
  const { createPasswordGate } = await import('../gate.mjs')
  const gate = createPasswordGate({ getPassword: () => 'test-pass' })

  const fakeReq = (body, { url, method = 'GET' } = {}) => {
    const r = Readable.from(body ? [Buffer.from(body)] : [])
    r.method = method
    r.url = url
    r.headers = method === 'POST'
      ? { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' }
      : { accept: 'text/html' }
    r.socket = { remoteAddress: '127.0.0.1' }
    return r
  }
  const run = (req) => {
    let status = 0
    let loc = ''
    let page = ''
    const res = {
      writeHead: (s, h = {}) => { status = s; loc = h?.location ?? '' },
      end: (b) => { page = String(b ?? '') },
      destroy: () => {},
    }
    return gate.handle(req, res).then(() => ({ status, loc, page }))
  }

  // 未登录访问深链 → 登录页带隐藏 next，登录成功后回到原页
  const lp = await run(fakeReq(null, { url: '/natfrp?x=1' }))
  rec('登录页带上回跳地址', lp.page.includes('name="next" value="/natfrp?x=1"'))

  // next 来自请求 URL，可被攻击者构造 —— 嵌进属性前必须转义
  const xss = await run(fakeReq(null, { url: '/a?b="><script>alert(1)</script>' }))
  rec('next 的 HTML 特殊字符被转义', !xss.page.includes('"><script'))

  const login = (next) => run(fakeReq(
    `password=${encodeURIComponent('test-pass')}${next ? `&next=${encodeURIComponent(next)}` : ''}`,
    { method: 'POST', url: '/__gate/login' },
  ))
  rec('登录成功回跳原地址', (await login('/natfrp?a=1')).loc === '/natfrp?a=1')
  rec('没带 next 回首页', (await login('')).loc === '/')
  // 开放重定向防线：只认站内绝对路径
  rec('//evil.com 被拒回首页', (await login('//evil.com')).loc === '/')
  rec('https://evil.com 被拒回首页', (await login('https://evil.com')).loc === '/')
  rec('/__gate/login 不能作为回跳目标', (await login('/__gate/login')).loc === '/')
}

// ---------- 8) 快照脱敏与实名徽标两处小修 ----------
{
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  rec('快照的 tokenFile 走 displayPath 脱敏', /tokenFile: displayPath\(/.test(index))
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  rec('实名徽标不再无守卫渲染 Lundefined',
    !new RegExp("\\? '已实名' : `实名 L").test(client) && /realnameText/.test(client))
}

console.log(results.join('\n'))
const passed = results.filter((x) => x.startsWith('PASS')).length
console.log(`\n${passed}/${results.length} passed`)
localSrv?.close()
setTimeout(() => process.exit(passed === results.length ? 0 : 1), 100)
