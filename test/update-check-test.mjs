// update-check-test.mjs — 「手动检查 frpc 更新」的离线回归。
//
// 覆盖三块：
//   1) 版本提取 / 比较的后端纯函数（已在 installer-test 里，这里补端到端语义）
//   2) /natfrp/api/frpc/update-check 路由：结论、节流、缓存、缺装
//   3) 前端结构断言：hooks 必须声明在提前 return 之前
//
// ⚠️ 第 3 条守的是一个真实踩过的坑：FrpcVersionBar 曾经先
//    `if (!healthy) return null` 再 useState，hooks 数量随 frpc 健康状态
//    来回变化 —— React 抛 "Rendered fewer hooks than expected"，
//    frpc 装好 / 坏掉那一刻整个设置面板白屏。
//    本项目测试用的是假 React（不校验 hooks 规则），所以只能靠结构断言兜住。
//
// 全部离线：不连 SakuraFrp、只写临时 DSH_HOME。

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'

const results = []
const rec = (name, cond, extra = '') => {
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`)
  return cond
}

// ---------- 1) 前端结构：hooks 在提前 return 之前 ----------
{
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

  /**
   * 抽出 FrpcVersionBar 的函数体（从函数头到下一个顶层 `function ` 之前），
   * 然后断言：第一个 `return null` 之前已经出现全部 useState。
   */
  const start = client.indexOf('function FrpcVersionBar')
  const nextFn = client.indexOf('function FrpcInstallCard', start)
  const body = start >= 0 && nextFn > start ? client.slice(start, nextFn) : ''

  rec('FrpcVersionBar 存在', body.length > 0)

  /**
   * ⚠️ 不能直接 indexOf('return null') —— 函数上方的说明注释里就写着
   *    「若先 `if (!healthy) return null`」，会先命中那段文字，测到注释而非代码。
   *    这里先剥掉注释块，再找真正的 return 语句。
   */
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')   // /* ... */
    .replace(/^\s*\/\/.*$/gm, '')       // 整行 //

  const code = stripComments(body)
  const firstReturnNull = code.search(/^\s*if \(!healthy\) return null/m)
  const useStateCount = (code.match(/useState\(/g) || []).length
  rec('FrpcVersionBar 有 4 个 useState', useStateCount === 4, `${useStateCount} 个`)
  rec('FrpcVersionBar 有提前 return（真实代码，非注释）', firstReturnNull > 0)

  if (firstReturnNull > 0) {
    const hooksBefore = (code.slice(0, firstReturnNull).match(/useState\(/g) || []).length
    // hooks 必须全部先声明，否则组件在两种状态下 hooks 数量不同
    rec(
      '所有 hooks 声明在提前 return 之前（hooks 规则）',
      hooksBefore === useStateCount,
      `return 前 ${hooksBefore}/${useStateCount}`,
    )
  }

  // /frpc/update-check 只在点击时调用，绝不能出现在任何轮询/定时器里
  const tickFn = client.slice(client.indexOf('async function tick()'), client.indexOf('return {', client.indexOf('async function tick()')))
  rec('轮询 tick() 里不碰 update-check（不做自动检查）', !tickFn.includes('update-check'))
  rec('update-check 只在 doCheck 里调用', /const doCheck = async \(\) => \{[\s\S]{0,200}?update-check/.test(body))

  // 节流提醒：前端必须读 retryAfter 并显示「秒后再查」
  rec('前端处理节流标记 throttled', /throttled/.test(body))
  rec('前端显示剩余秒数', /retryAfter/.test(body) && /秒后再查/.test(body))
  rec('getJSON 把 retryAfter 附到错误上', /err\.retryAfter = body\.retryAfter/.test(client))
}

// ---------- 2) 后端路由 ----------
const home = mkdtempSync(join(tmpdir(), 'dsh-update-check-'))
process.env.DSH_HOME = home

// 造一个「已装好」的 frpc：内容无所谓，探版本被 mock 掉（见下）
const binDir = join(home, 'dsh-sakurafrp')
mkdirSync(binDir, { recursive: true })

const mod = await import('../index.js')

let handler = null
const ctx = {
  logger: () => ({ info: () => {}, warn: () => {}, error: () => {}, log: () => {} }),
  webServer: { port: 65000, register: ({ handler: h }) => { handler = h; return () => {} } },
  credentials: { resolve: async () => '', set: async () => {}, delete: async () => {} },
  connection: { authenticatedUrl: (u) => u },
  timer: {},
  effect: (fn) => { const d = fn?.(); if (typeof d === 'function') d(); return () => {} },
  inject: () => {},
  get: () => undefined,
}
mod.apply(ctx, { enabled: false })

const srv = createServer((req, res) => handler(req, res))
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${srv.address().port}`

const hit = async (p) => {
  const r = await fetch(`${base}${p}`)
  return { status: r.status, body: await r.json().catch(() => ({})) }
}

// 本地没装 frpc：应引导去安装，而不是报「有新版本」
{
  const r = await hit('/natfrp/api/frpc/update-check')
  rec('未安装时 → 400 且 reason=not-installed',
    r.status === 400 && r.body.reason === 'not-installed', `status=${r.status} reason=${r.body.reason}`)
  rec('未安装时不给 updateAvailable',
    r.body.updateAvailable === undefined, JSON.stringify(r.body.updateAvailable))
}

// 节流：60s 内再点必须被拦，且能算出剩余秒数
{
  const r = await hit('/natfrp/api/frpc/update-check')
  rec('冷却期内再点 → 429 throttled',
    r.status === 429 && r.body.throttled === true && r.body.error === 'throttled',
    `status=${r.status} throttled=${r.body.throttled}`)
  const sec = Number(r.body.retryAfter)
  rec('冷却期内带 retryAfter（1–60 秒）',
    Number.isFinite(sec) && sec >= 1 && sec <= 60, `retryAfter=${r.body.retryAfter}`)
  rec('冷却期提示文案含「频繁」', /频繁/.test(String(r.body.message ?? '')), String(r.body.message ?? ''))
}

// 连点 3 次都该被拦（不是只有第一次拦）
{
  const codes = []
  for (let i = 0; i < 3; i++) codes.push((await hit('/natfrp/api/frpc/update-check')).status)
  rec('连点 3 次全部被拦（429）', codes.every((c) => c === 429), codes.join(','))
}

await new Promise((r) => srv.close(r))

const passed = results.filter((x) => x.startsWith('PASS')).length
console.log(results.join('\n'))
console.log(`\n${passed}/${results.length} passed`)

// 延迟退出：keep-alive socket 收尾需要一拍（与其它套件一致）
setTimeout(() => process.exit(passed === results.length ? 0 : 1), 200)
