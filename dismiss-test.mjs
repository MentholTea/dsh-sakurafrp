// dismiss-test.mjs — 提示忽略（叉号）的语义验证
//
// 核心要求：
//   1. 叉掉后不再显示
//   2. 但「问题变化」时必须重新出现（否则叉一下就永远看不到故障了）
//   3. 有办法恢复提示
const results = []
const rec = (n, p, d = '') => { results.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`) }

import { readFileSync } from 'node:fs'
const index = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
const client = readFileSync(new URL('./client.js', import.meta.url), 'utf8')

// ── 1) 后端：指纹机制 ──
rec('有 dismissedFingerprints 存储', /let dismissedFingerprints = /.test(index))
rec('指纹由 kind + 路径组成', /return `\$\{problem\.kind\}::\$\{cfg\.frpcPath\}`/.test(index))
rec('isDismissed 按指纹判断', /dismissedFingerprints\.includes\(fingerprintOf\(problem\)\)/.test(index))
rec('dismiss 持久化到 state', /writeState\(\{ dismissedFrpcPrompts: dismissedFingerprints \}\)/.test(index))
rec('undismiss 可清空', /dismissedFingerprints = \[\][\s\S]{0,80}writeState\(\{ dismissedFrpcPrompts: \[\] \}\)/.test(index))
rec('指纹列表有上限（防无限增长）', /\.slice\(-8\)/.test(index))
rec('从 state 恢复已忽略列表', /Array\.isArray\(state\.dismissedFrpcPrompts\)/.test(index))

// ── 2) 问题分类 ──
{
  const fn = index.slice(index.indexOf('function currentProblemKind()'))
  const body = fn.slice(0, fn.indexOf('\n  }'))
  rec('分类包含 installing', /'installing'/.test(body))
  rec('分类包含 missing', /'missing'/.test(body))
  rec('分类包含 invalid', /'invalid'/.test(body))
  rec('分类包含 ok', /'ok'/.test(body))
}
rec('snapshot 暴露 problemKind', /problemKind: currentProblemKind\(\)/.test(index))
rec('snapshot 暴露 dismissed', /dismissed: isDismissed\(\{ kind: currentProblemKind\(\) \}\)/.test(index))

// ── 3) 路由 ──
rec('有 dismiss 路由', /path === '\/natfrp\/api\/frpc\/dismiss' && req\.method === 'POST'/.test(index))
rec('有 undismiss 路由', /path === '\/natfrp\/api\/frpc\/undismiss' && req\.method === 'POST'/.test(index))

// ── 4) 前端 ──
rec('前端读 dismissed', /presence\.dismissed === true/.test(client))
rec('有叉号按钮', /'✕'/.test(client))
rec('叉号点击调 dismiss', /post\('\/frpc\/dismiss'\)/.test(client))
rec('收起后显示恢复入口', /frpc 提示已隐藏/.test(client))
rec('恢复按钮调 undismiss', /post\('\/frpc\/undismiss'\)/.test(client))
rec('成功卡片也有叉号', (client.match(/'✕'/g) || []).length >= 2, `${(client.match(/'✕'/g) || []).length} 个`)

// ── 5) 行为模拟：核心语义 ──
function makeStore(initial = []) {
  let fingerprints = [...initial]
  const fp = (kind, path) => `${kind}::${path}`
  return {
    dismiss: (kind, path) => { const f = fp(kind, path); if (!fingerprints.includes(f)) fingerprints = [...fingerprints, f].slice(-8) },
    undismissAll: () => { fingerprints = [] },
    isDismissed: (kind, path) => fingerprints.includes(fp(kind, path)),
    all: () => fingerprints,
  }
}

const PATH = 'C:\\Users\\x\\.dsh\\bin\\frpc-standalone.exe'

// 场景 1：叉掉 missing → 不再显示
{
  const s = makeStore()
  s.dismiss('missing', PATH)
  rec('叉掉后 missing 被忽略', s.isDismissed('missing', PATH) === true)
}
// 场景 2：⚠️ 关键 —— 问题从 missing 变成 invalid，必须重新出现
{
  const s = makeStore()
  s.dismiss('missing', PATH)
  rec('问题变成 invalid 时重新出现（关键）', s.isDismissed('invalid', PATH) === false)
}
// 场景 3：路径变化（用户改了 frpcPath）→ 也算新问题
{
  const s = makeStore()
  s.dismiss('missing', PATH)
  rec('路径变化后重新出现', s.isDismissed('missing', 'D:\\other\\frpc.exe') === false)
}
// 场景 4：同类同路径 → 保持忽略
{
  const s = makeStore()
  s.dismiss('missing', PATH)
  s.dismiss('missing', PATH) // 重复叉
  rec('重复叉不会重复入列', s.all().length === 1, `${s.all().length} 条`)
}
// 场景 5：恢复提示
{
  const s = makeStore()
  s.dismiss('missing', PATH)
  s.undismissAll()
  rec('恢复提示后重新显示', s.isDismissed('missing', PATH) === false)
}
// 场景 6：上限
{
  const s = makeStore()
  for (let i = 0; i < 12; i++) s.dismiss('missing', `C:\\p${i}\\frpc.exe`)
  rec('指纹列表上限 8 条', s.all().length === 8, `${s.all().length} 条`)
}
// 场景 7：ok 状态不该出现卡片（不该被 dismiss 影响）
rec('前端对 ok 状态直接不渲染', /if \(healthy && !showResult\) return null/.test(client))

// ── 6) writeState 必须合并语义（否则 dismiss 会冲掉 enabled 等配置）──
rec('writeState 采用合并写入', /const merged = \{ \.\.\.readState\(\), \.\.\.patch \}/.test(index))

const ok = results.every(Boolean)
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`)
setTimeout(() => process.exit(ok ? 0 : 1), 200)
