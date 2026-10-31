// defaults-test.mjs — 「装上时什么都没配」的回归测试。
//
// 为什么单独一个文件：
//   这是产品决定，不是实现细节——新装必须是「关着的 + 没端口 + 没密钥」。
//   一旦有人在 config、cordis.patch.yml 或代码里塞回一个默认端口 3083，
//   用户就会看着一个自己没填过的数字点保存，然后把「外网打不开」算在插件头上。
//   这类回退不会让其它测试变红，只能靠这条断言盯着。

import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'

const home = mkdtempSync(join(tmpdir(), 'dsh-defaults-test-'))
process.env.DSH_HOME = home

const results = []
const ok = (name, cond, extra = '') => {
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`)
  return cond
}

const mod = await import('./index.js')

let handler = null
const creds = new Map()
const ctx = {
  logger: () => ({ info: () => {}, warn: () => {}, error: () => {}, log: () => {} }),
  webServer: { port: 0, register: ({ handler: h }) => { handler = h; return () => { handler = null } } },
  // 内存版凭据库：没配 tokenFile 时插件就走这条路，假实现必须真的存得住值
  credentials: {
    resolve: async (k) => creds.get(k) ?? '',
    set: async (k, v) => { creds.set(k, v) },
    delete: async (k) => { creds.delete(k) },
  },
  connection: { authenticatedUrl: (u) => `${u}/?token=abc` },
  timer: {},
  // 必须真的执行一次回调：路由就是在 ctx.effect 里注册的，不跑就永远拿不到 handler
  effect: (fn) => { const d = fn?.(); return () => { try { d?.() } catch { /* noop */ } } },
  inject: () => {},
  get: () => undefined,
}

// ⚠️ 空配置：模拟「刚装好、什么都没设」
try {
  mod.apply(ctx, {})
  ok('apply() 不抛异常', true)
} catch (e) {
  ok('apply() 不抛异常', false, String(e?.message ?? e))
}

const srv = createServer((req, res) => handler(req, res))
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${srv.address().port}`

const getState = async () => {
  const r = await fetch(`${base}/natfrp/api/state`)
  return await r.json().catch(() => null)
}
const postConfig = async (patch) => {
  const r = await fetch(`${base}/natfrp/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}

// ── 1) 新装三项都必须是「没有」──
let s = await getState()
ok('新装默认关闭', s?.enabled === false, `enabled=${s?.enabled}`)
ok('新装本机端口为空', s?.gatePort === null, `gatePort=${JSON.stringify(s?.gatePort)}`)
ok('没端口时网关不监听', s?.gateRunning === false, `gateRunning=${s?.gateRunning}`)
ok('新装没有访问密钥', s?.tokenConfigured === false)

const dataState = existsSync(join(home, 'dsh-sakurafrp', 'state.json'))
  ? JSON.parse(readFileSync(join(home, 'dsh-sakurafrp', 'state.json'), 'utf8'))
  : {}
ok('新装不往 state.json 里写默认端口', !('gatePort' in dataState),
  JSON.stringify(Object.keys(dataState)))

// ── 2) 显式填端口才起来 ──
const probe = createServer()
await new Promise((r) => probe.listen(0, '127.0.0.1', r))
const PORT = probe.address().port
await new Promise((r) => probe.close(r))

let r = await postConfig({ gatePort: PORT })
ok('填端口 → 保存成功', r.status === 200, `status=${r.status} ${r.body?.message ?? ''}`)
ok('填完端口网关就起来了', r.body?.gateRunning === true && Number(r.body?.gatePort) === PORT,
  `gate=${r.body?.gatePort} running=${r.body?.gateRunning}`)

// ── 3) 清空端口 = 网关停下（不留一个假端口继续跑）──
r = await postConfig({ gatePort: null })
ok('清空端口 → 200', r.status === 200, `status=${r.status}`)
ok('清空后端口为空', r.body?.gatePort === null, `gatePort=${JSON.stringify(r.body?.gatePort)}`)
ok('清空后网关停止监听', r.body?.gateRunning === false, `gateRunning=${r.body?.gateRunning}`)

// 清空后不能被 config 里的旧值 / 代码里的默认值复活
s = await getState()
ok('重新读取仍是空（不复活默认值）', s?.gatePort === null, `gatePort=${JSON.stringify(s?.gatePort)}`)

// ── 4) 没有端口时不许建隧道（否则建出来就连不到东西）──
await postConfig({ token: 'dummy-token-for-test' })
const create = await fetch(`${base}/natfrp/api/tunnel/create`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'T', node: 1 }),
})
const createBody = await create.json().catch(() => null)
ok('无端口时建隧道被拒（400 no-port）',
  create.status === 400 && createBody?.error === 'no-port',
  `status=${create.status} error=${createBody?.error}`)
ok('拒绝时给出人话提示', /端口/.test(createBody?.message ?? ''), createBody?.message ?? '')

// ── 5) 端口检测接口对空值给 400，不是 200 ──
const chk = await fetch(`${base}/natfrp/api/port/check?port=`)
ok('空端口检测 → 400', chk.status === 400, `status=${chk.status}`)

// ── 6) 界面层不许把「空端口」渲染成 0 或一个假数字 ──
const client = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
ok('空端口不当成 0 去比较', /Number\.isInteger\(Number\(st\.gatePort\)\)/.test(client))
ok('端口输入框没有预设数字占位', !/placeholder: '3083'/.test(client))
ok('状态栏对空端口有专门文案', /端口未设置/.test(client))
ok('空端口时不显示「改隧道端口」按钮', /gatePortNum !== null && tunnelPort !== gatePortNum/.test(client))

await new Promise((r) => srv.close(r))

console.log(results.join('\n'))
const failed = results.filter((x) => x.startsWith('FAIL')).length
console.log(`\n${results.length - failed}/${results.length} passed`)

// ⚠️ 不能直接 process.exit：上面几轮 fetch 的 keep-alive socket 还没释放完，
//    在 Windows 上会撞上 libuv 的
//    `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c`
//    断言 —— 断言明明全过，退出码却是 0xC0000409，整套 npm test 因此变红。
//    延迟一拍再退，让 socket 与 handle 有时间收尾（与 apply-test / fixes-test 一致）。
setTimeout(() => process.exit(failed ? 1 : 0), 200)
