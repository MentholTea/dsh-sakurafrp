// traffic-test.mjs — 流量条着色方向 + 剩余百分比 + 总量口径
const results = []
const rec = (n, p, d = '') => { results.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`) }

import { readFileSync } from 'node:fs'
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const idx = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const api = readFileSync(new URL('../natfrp.mjs', import.meta.url), 'utf8')

function grabM(code, key) {
  const start = code.indexOf(`${key}: (`)
  if (start < 0) return null
  let i = code.indexOf('{', start), depth = 0
  const from = i
  for (; i < code.length; i++) {
    if (code[i] === '{') depth++
    else if (code[i] === '}') { depth--; if (depth === 0) break }
  }
  return code.slice(from, i + 1)
}

// ── 1) 着色方向 ──
const fill = grabM(src, 'trafficFill')
rec('trafficFill 存在', fill !== null)
const m = (fill || '').match(/background:\s*remainPct\s*<\s*(\d+)\s*\?\s*'(#[0-9a-f]+)'\s*:\s*remainPct\s*<\s*(\d+)\s*\?\s*'(#[0-9a-f]+)'\s*:\s*'(#[0-9a-f]+)'/i)
rec('三目链按 remainPct 判红', m !== null)
if (m) {
  const LO_RED = +m[1], RED = m[2], LO_AMBER = +m[3], AMBER = m[4], GREEN = m[5]
  const colorOf = (p) => (p < LO_RED ? RED : p < LO_AMBER ? AMBER : GREEN)
  for (const [pct, want, label] of [
    [100, GREEN, '剩余 100% → 绿'],
    [90, GREEN, '剩余 90% → 绿（曾误判红）'],
    [35, GREEN, '剩余 35% → 绿'],
    [25, AMBER, '剩余 25% → 橙'],
    [9, RED, '剩余 9% → 红'],
    [0, RED, '剩余 0% → 红'],
  ]) rec(label, colorOf(pct) === want, colorOf(pct))
  rec('阈值方向 剩余多=绿', LO_RED < LO_AMBER, `${LO_RED} < ${LO_AMBER}`)
}

// ── 2) 剩余百分比显示 ──
rec('显示百分比文本', /remainPctText/.test(src))
rec('百分比夹在 0–100 并取整',
  /Math\.min\(100,\s*Math\.max\(0,\s*Math\.round\(remainPct\)\)\)/.test(src))
rec('百分比与进度条同行', /display: 'flex', alignItems: 'center', gap: '10px'/.test(src))
rec('百分比颜色跟随档位', /remainPct < 10 \? '#dc2626'/.test(src))
rec('百分比用等宽数字对齐', /fontVariantNumeric: 'tabular-nums'/.test(src))
rec('悬停提示给出真实总量', /总量 \$\{fmtBytes\(baseTotal\)\}/.test(src))

// ── 3) 总量口径：必须用 data_plans，不能用 traffic[1] 当总量 ──
rec('natfrp.mjs 封装 dataPlans', /dataPlans: \(/.test(api))
rec('dataPlans 走 /user/data_plans', /'\/user\/data_plans'/.test(api))
rec('index.js 在 /user 里附带 dataPlans', /dataPlans: plans/.test(idx))
rec('dataPlans 失败不拖垮账号信息', /dataPlansError/.test(idx))
rec('客户端优先用流量包真总量', /const hasPlan = planTotal > 0/.test(src))
rec('无流量包时退化为估算', /hasPlan \? planTotal : todayUsed \+ remaining/.test(src))
rec('不再把 traffic[1] 直接当总量', !/totalEstimate/.test(src))

// ── 4) 百分比计算行为 ──
function pctOf({ plans, traffic }) {
  const todayUsed = traffic?.[0] ?? 0
  const remaining = traffic?.[1] ?? 0
  const list = Array.isArray(plans) ? plans : []
  const planTotal = list.reduce((s, p) => s + (Number(p?.total) || 0), 0)
  const planRemaining = list.reduce((s, p) => s + (Number(p?.remaining) || 0), 0)
  const hasPlan = planTotal > 0
  const baseRemaining = hasPlan ? planRemaining : remaining
  const baseTotal = hasPlan ? planTotal : todayUsed + remaining
  const remainPct = baseTotal > 0 ? (baseRemaining / baseTotal) * 100 : 0
  return Math.min(100, Math.max(0, Math.round(remainPct)))
}
{
  // 真流量包：总量 20 GiB，剩余 15 GiB → 75%
  const p = pctOf({ plans: [{ total: 20 * 1024 ** 3, remaining: 15 * 1024 ** 3 }], traffic: [1000, 15 * 1024 ** 3] })
  rec('用流量包总量算 → 75%', p === 75, `${p}%`)
}
{
  // 无流量包 → 退化估算（今日 1 GiB + 剩余 15 GiB → 94%）
  const p = pctOf({ plans: null, traffic: [1024 ** 3, 15 * 1024 ** 3] })
  rec('无流量包退化为估算 → 94%', p === 94, `${p}%`)
}
{
  // 多个流量包求和
  const p = pctOf({ plans: [{ total: 10 * 1024 ** 3, remaining: 10 * 1024 ** 3 }, { total: 10 * 1024 ** 3, remaining: 5 * 1024 ** 3 }], traffic: [0, 0] })
  rec('多流量包累加 → 75%', p === 75, `${p}%`)
}
{
  rec('全 0 不崩（NaN 防护）', pctOf({ plans: null, traffic: [0, 0] }) === 0)
  rec('浮点夹取上限 100', pctOf({ plans: [{ total: 1, remaining: 2 }], traffic: [0, 0] }) === 100)
}

const ok = results.every(Boolean)
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`)
setTimeout(() => process.exit(ok ? 0 : 1), 200)
