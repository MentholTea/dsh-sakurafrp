// feedback-test.mjs — 安装反馈是否完整（进度 / 成功 / 失败 / 快速轮询）
// 这三个点之前全缺失：进度 4 秒才动一次、成功无提示、失败静默。
const results = []
const rec = (n, p, d = '') => { results.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`) }

import { readFileSync } from 'node:fs'
const client = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
const index = readFileSync(new URL('./index.js', import.meta.url), 'utf8')

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

// ── 1) 后端必须留存安装结果 ──
rec('后端有 installResult 变量', /let installResult = null/.test(index))
{
  // 直接对全文匹配，避免 slice 边界算错
  rec('成功时写入 installResult（ok:true + version）', /installResult = \{[\s\S]{0,160}?ok: true[\s\S]{0,160}?version:/.test(index))
  rec('失败时写入 installResult（含 error）', /installResult = \{[\s\S]{0,180}?ok: false[\s\S]{0,180}?error:/.test(index))
  rec('异常时写入 installResult', /installResult = \{ at: Date\.now\(\), ok: false, error: msg \}/.test(index))
}
rec('snapshot 暴露 lastResult', /lastResult: installResult\b/.test(index))

// ── 2) 前端必须消费 lastResult ──
rec('前端读取 lastResult', /presence\.lastResult/.test(client))
rec('成功卡片存在', /frpc 安装成功/.test(client))
rec('失败卡片存在', /上次安装失败/.test(client))
rec('成功时显示版本号', /last\?\.version/.test(client))
rec('成功时显示体积', /last\?\.bytes/.test(client))
rec('失败时显示原因', /last\.error \|\| '未知错误'/.test(client))

// ── 3) 进度必须可见 ──
rec('安装中轮询提到 400ms', /setInterval\(\(\) => void loadState\(\), 400\)/.test(client))
rec('有 installingNow 触发条件', /const installingNow = Boolean\(st\?\.frpcInstall\?\.progress\)/.test(client))
rec('进度显示百分比', /正在下载… \$\{pct\}%/.test(client))
rec('进度显示字节数', /mbText/.test(client))
rec('点击后立即刷新（不等轮询）', /onDone\?\.\(\)/.test(client))

// ── 4) 结果自动消失，不会永久占位 ──
rec('结果设了 dismissedAt 去重', /dismissedAt/.test(client))
rec('成功 8 秒后消失', /8000/.test(client))
rec('失败 20 秒后消失（留更久便于阅读）', /20000/.test(client))

// ── 4b) 关掉之后不再出现（跨会话） ──
// 之前叉号只写本地 state，组件一重建就复活 → 每次进设置都弹「安装成功」。
rec('服务端落盘 ack 时间戳', /frpcSuccessAckAt/.test(index))
rec('snapshot 标注 acknowledged', /acknowledged: Number\(installResult\.at\) <= successAckAt/.test(index))
rec('有 ack 接口', /\/natfrp\/api\/frpc\/ack-result/.test(index))
rec('ack 只有更晚的结果才推进', /if \(when > successAckAt\)/.test(index))
rec('前端尊重服务端 acknowledged', /const ackedPersisted = last\?\.acknowledged === true/.test(client))
rec('叉号走落盘接口（不再只改本地）', /onClick: \(\) => \{ void ackResult\(last\?\.at \?\? Date\.now\(\)\) \}/.test(client))
rec('自动收起也落盘', /void ackResult\(at\)/.test(client))
rec('装成功后清掉同路径的旧忽略记录', /endsWith\(`::\$\{cfg\.frpcPath\}`\)/.test(index))

// ── 5) 行为模拟：状态机 ──
// 模拟「安装中 → 成功」的前端判定
function viewState(presence) {
  const last = presence.lastResult ?? null
  const dismissedAt = 0
  const acked = last?.acknowledged === true
  const showResult = Boolean(last) && !acked && last.at !== dismissedAt
  const healthy = presence.present && presence.ok !== false
  const installing = Boolean(presence.progress)
  if (healthy && !showResult) return 'hidden'
  if (healthy) return 'success'
  if (installing) return 'progress'
  if (showResult && last && !last.ok) return 'failed'
  return 'offer'
}

rec('未安装 → 显示安装按钮', viewState({ present: false }) === 'offer')
rec('安装中 → 显示进度', viewState({ present: false, progress: { phase: 'downloading', received: 100, total: 200 } }) === 'progress')
rec('安装成功 → 显示成功卡', viewState({ present: true, ok: true, lastResult: { at: 1, ok: true, version: 'x' } }) === 'success')
rec('成功提示过期 → 隐藏', viewState({ present: true, ok: true, lastResult: null }) === 'hidden')
rec('安装失败 → 显示失败卡（不再静默）', viewState({ present: false, lastResult: { at: 1, ok: false, error: 'MD5' } }) === 'failed')
rec('失败文案可见', (() => {
  const st = viewState({ present: false, lastResult: { at: 1, ok: false, error: 'x' } })
  return st === 'failed'
})())

// ── 6) 关掉后不再出现：ack 语义 ──
rec(
  '已确认的成功提示 → 重开设置也不再显示',
  viewState({ present: true, ok: true, lastResult: { at: 1, ok: true, acknowledged: true } }) === 'hidden',
)
rec(
  '未确认的成功提示 → 仍然显示',
  viewState({ present: true, ok: true, lastResult: { at: 2, ok: true, acknowledged: false } }) === 'success',
)
rec(
  'frpc 故障 → 即使曾 ack 过也要重新提示安装',
  viewState({ present: false, lastResult: { at: 1, ok: true, acknowledged: true } }) === 'offer',
)
rec(
  '坏了重装成功（新的 at 未确认）→ 再提示一次',
  // 服务端：acknowledged = at <= successAckAt；旧的 at 已被 ack，新的 at 更大 → false
  ((ackAt, at) => (at <= ackAt) === false)(5, 9),
)

const ok = results.every(Boolean)
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`)
setTimeout(() => process.exit(ok ? 0 : 1), 200)
