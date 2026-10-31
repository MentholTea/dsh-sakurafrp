// external-test.mjs — openExternal 分支 + 绝对地址校验 + 流量口径
const results = []
const rec = (n, p, d = '') => { results.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`) }

import { readFileSync } from 'node:fs'
const src = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
const idx = readFileSync(new URL('./index.js', import.meta.url), 'utf8')

function grab(code, fn) {
  const start = code.indexOf(`function ${fn}(`)
  if (start < 0) return null
  let i = code.indexOf('{', start), depth = 0
  const from = i
  for (; i < code.length; i++) {
    if (code[i] === '{') depth++
    else if (code[i] === '}') { depth--; if (depth === 0) break }
  }
  return code.slice(from, i + 1)
}

// ── 1) 静态结构 ──
const body = grab(src, 'openExternal')
rec('openExternal 存在', body !== null)
rec('拒绝非绝对地址（不再静默失败）', /无法打开非绝对地址/.test(body || ''))
rec('优先宿主内置浏览器标签', /right\.openTab\('browser'/.test(body || ''))
rec('退化 window.open', /window\.open\(target, '_blank'/.test(body || ''))
rec('全部外链已改造', !/target: '_blank'/.test(src))
// 6 处：① 获取密钥 / 域名提示的「绑定证书」与「绑定教程」/ 一键安装的下载说明（两处）/
//       隧道公网地址。原来标题栏的「子域绑定」和句中的「绑定子域名」都已撤掉
//       （前者纯多余，后者只是句子里的一串字，不需要可点）。
rec('ExternalLink 6 处', (src.match(/h\(ExternalLink/g) || []).length === 6)
// 「绑定证书」链到子域绑定页 —— 用户读到这句就想「那我去绑」，点它就是那一步。
// 但「不」必须留在链接外：连成一片蓝色会读成「不去绑定证书」，意思正好反了。
rec('「绑定证书」链到 natfrp.com/tunnel/domain',
  /href: 'https:\/\/www\.natfrp\.com\/tunnel\/domain'[\s\S]{0,200}?'绑定证书 ↗'/.test(src))
rec('「不」在链接之外（纯文本）',
  /'不',\s*\n\s*h\(ExternalLink, \{[\s\S]{0,200}?'绑定证书 ↗'/.test(src))
rec('证书提示不再有「你的子域名:远程端口」',
  !/'你的子域名:远程端口'/.test(src))
rec('日志按钮优先用服务端 logsUrl', /st\.logsUrl \|\| logsUrl\(\)/.test(src))

// ── 2) 服务端提供绝对 logsUrl ──
rec('index.js 有 originOf', grab(idx, 'originOf') !== null)
const snap = grab(idx, 'snapshot').replace('frpc.snapshot()', '')
rec('snapshot 返回 logsUrl', /logsUrl:/.test(snap))
rec('logsUrl 用传入 origin', /\$\{originBase\}/.test(snap))
const bareCalls = (idx.match(/await snapshot\(\)/g) || []).length
rec('所有 snapshot 调用都传 origin', bareCalls === 0, `无参调用 ${bareCalls} 处`)

// ── 3) 流量口径（官方 schema: [本日消耗, 总剩余]）──
rec('标注为「今日已用」', /今日已用/.test(src))
rec('标注为「剩余」', /剩余 \$\{fmtBytes\(remaining\)\}/.test(src))
rec('不再误标「本月」', !/本月 \$\{fmtBytes/.test(src))
rec('不再误标「共」', !/`共 \$\{fmtBytes/.test(src))
rec('变量语义正确 remaining', /const remaining = user\?\.traffic\?\.\[1\]/.test(src))

// ── 4) 行为模拟 ──
function makeOpen({ right, tabs, base }) {
  const calls = []
  const apiBase = () => base || ''
  const openExternal = (url) => {
    let target = String(url ?? '')
    if (!/^https?:|^file:|^mailto:/.test(target)) {
      const b = apiBase()
      if (b) target = `${b}${target.startsWith('/') ? '' : '/'}${target}`
    }
    if (!/^https?:|^file:|^mailto:/.test(target)) return 'rejected'
    // 与真实实现一致：openTab 抛错要捕获，然后退化到 window.open
    try {
      const hasBrowserTab = tabs && typeof tabs.get === 'function' && tabs.get('browser') !== undefined
      if (right && typeof right.openTab === 'function' && hasBrowserTab) {
        right.openTab('browser', { params: { url: target } })
        return 'tab'
      }
    } catch { /* 落到退化路径 */ }
    calls.push(['window.open', target])
    return 'window'
  }
  return { openExternal, calls }
}

{
  const tabCalls = []
  const { openExternal } = makeOpen({
    right: { openTab: (...a) => tabCalls.push(a) },
    tabs: { get: (k) => (k === 'browser' ? {} : undefined) },
    base: 'http://127.0.0.1:3080',
  })
  const r = openExternal('http://127.0.0.1:3080/natfrp/api/logs')
  rec('绝对 URL → 内置标签', r === 'tab' && tabCalls.length === 1, r)
}
{
  const tabCalls = []
  const { openExternal } = makeOpen({
    right: { openTab: (...a) => tabCalls.push(a) },
    tabs: { get: () => ({}) },
    base: 'http://127.0.0.1:3080',
  })
  openExternal('/natfrp/api/logs')
  const got = tabCalls[0]?.[1]?.params?.url
  rec('相对 URL 被补全', got === 'http://127.0.0.1:3080/natfrp/api/logs', String(got))
}
{
  const tabCalls = []
  const { openExternal } = makeOpen({ right: { openTab: (...a) => tabCalls.push(a) }, tabs: { get: () => ({}) }, base: '' })
  const r = openExternal('/natfrp/api/logs')
  rec('无 base 的相对 URL 被拒绝', r === 'rejected' && tabCalls.length === 0, r)
}
{
  const { openExternal, calls } = makeOpen({ right: null, tabs: null, base: 'http://x' })
  const r = openExternal('https://example.com')
  rec('纯浏览器 → window.open', r === 'window' && calls.length === 1)
}
{
  const { openExternal } = makeOpen({
    right: { openTab: () => { throw new Error('boom') } },
    tabs: { get: () => ({}) },
    base: 'http://x',
  })
  let crashed = false
  try { openExternal('https://example.com') } catch { crashed = true }
  rec('openTab 抛错不崩溃', !crashed)
}

const ok = results.every(Boolean)
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`)
setTimeout(() => process.exit(ok ? 0 : 1), 200)
