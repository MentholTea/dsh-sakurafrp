// diag-test.mjs — 侧边栏状态点颜色判定
//
// 用户定义的语义：
//   红 = 关闭状态 或 未安装 frpc / frpc 异常
//   黄 = 已开启但尚未连通（启动中 / 隧道未就绪）
//   绿 = 连接成功
const results = []
const rec = (n, p, d = '') => { results.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`) }

import { readFileSync } from 'node:fs'
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

// 从源码抽出 diagOf 真实实现来做行为验证（而不是复制一份逻辑）
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

const body = grab(src, 'diagOf')
rec('找到 diagOf', body !== null)

// 用真实函数体求值
const diagOf = new Function('st', body.replace(/^\{/, '').replace(/\}$/, ''))
const color = (st) => diagOf(st)

// 基准：一切正常的完整状态
const healthy = {
  enabled: true,
  tokenConfigured: true,
  gateRunning: true,
  frpcInstall: { present: true, ok: true },
  frpc: { running: true, tunnelOk: true },
}

// ── 绿：连接成功 ──
rec('一切正常 → 绿', color(healthy) === 'green', color(healthy))

// ── 红：关闭 / 未装 / 故障 ──
rec('enabled=false → 红', color({ ...healthy, enabled: false }) === 'red', color({ ...healthy, enabled: false }))
rec('未安装 frpc → 红', color({ ...healthy, frpcInstall: { present: false } }) === 'red')
rec('frpc 存在但异常 → 红', color({ ...healthy, frpcInstall: { present: true, ok: false } }) === 'red')
rec('无 token → 红', color({ ...healthy, tokenConfigured: false }) === 'red')
rec('网关未运行 → 红', color({ ...healthy, gateRunning: false }) === 'red')
rec('互踢 → 红', color({ ...healthy, frpc: { running: true, tunnelOk: true, kickSuspect: true } }) === 'red')
rec('API 报错 → 红', color({ ...healthy, apiError: 'boom' }) === 'red')
rec('开着但 frpc 没跑 → 红', color({ ...healthy, frpc: { running: false } }) === 'red')
rec('state 为 null → 红', color(null) === 'red')

// ── 黄：开启但未连通 ──
rec('运行中但隧道未上线 → 黄', color({ ...healthy, frpc: { running: true, tunnelOk: false } }) === 'yellow')
rec('隧道状态未知(undefined) → 黄', color({ ...healthy, frpc: { running: true } }) === 'yellow')

// ── 优先级：关闭优先于「运行中但隧道没好」──
rec('关闭状态优先判红（即使 frpc 在跑）',
  color({ ...healthy, enabled: false, frpc: { running: true, tunnelOk: false } }) === 'red')

// ── 优先级：未安装优先于其它一切 ──
rec('未安装优先判红（即使配置齐全）',
  color({ ...healthy, frpcInstall: { present: false } }) === 'red')

// ── 静态断言：源码必须真的按这三档实现 ──
rec('源码含三色定义', /const DIAG = \{ green: '#22c55e', yellow: '#eab308', red: '#ef4444' \}/.test(src))
rec('源码检查 present === false', /inst\.present === false/.test(src))
rec('源码检查 enabled === false', /st\.enabled === false/.test(src))
rec('源码检查 tunnelOk !== true（区分未就绪）', /f\.tunnelOk !== true/.test(src))
rec('初始值不误报为黄', /let value = 'red'/.test(src))

// ── 状态点渲染：颜色来自 DIAG 映射 ──
rec('图标用 DIAG 映射取色', /DIAG\[diag\] \|\| DIAG\.yellow/.test(src))
rec('CSS 有 red 档', /data-natfrp-state="red"/.test(src))

const ok = results.every(Boolean)
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`)
setTimeout(() => process.exit(ok ? 0 : 1), 200)
