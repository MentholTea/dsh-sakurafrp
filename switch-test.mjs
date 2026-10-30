// switch-test.mjs — 复现「三次点击才生效」的状态机并验证修复
// 用最小 DOM 模拟 + 真实 diagStore/toggleEnabled/syncSwitch 逻辑

const results = []
const rec = (n, p, d = '') => { results.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`) }

// ── 极简 DOM 模拟 ──
class El {
  constructor(tag) {
    this.tagName = tag
    this.dataset = {}
    this.children = []
    this.className = ''
    this._attrs = {}
    this.listeners = {}
  }
  setAttribute(k, v) { this._attrs[k] = v }
  getAttribute(k) { return this._attrs[k] }
  appendChild(c) { this.children.push(c); c.parent = this; return c }
  querySelector(sel) {
    if (sel === '.natfrp-switch') return this.children.find((c) => c.className === 'natfrp-switch') || null
    return null
  }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn) }
  dispatch(t, ev = {}) {
    ev.preventDefault ||= () => {}
    ev.stopPropagation ||= () => {}
    for (const fn of this.listeners[t] || []) fn(ev)
  }
}

const row = new El('button')
row.setAttribute('aria-label', '内网穿透')
const fakeDoc = {
  body: new El('body'),
  querySelector: () => row,
  querySelectorAll: () => [row],
  createElement: (t) => new El(t),
}
globalThis.document = fakeDoc
globalThis.requestAnimationFrame = (fn) => { fn(); return 1 }
globalThis.cancelAnimationFrame = () => {}

// ── 被测逻辑（与 client.js 保持同步的核心）──
let storeEnabled = true
const enableSubs = new Set()
function publishEnabled(next) {
  if (next === storeEnabled) return
  storeEnabled = next
  for (const fn of [...enableSubs]) fn(storeEnabled)   // ← 修复：传布尔
}
function setEnabled(v) { publishEnabled(v) }

const posts = []
async function post(path) {
  posts.push(path)
  // 模拟服务端：/stop -> enabled=false, /start -> enabled=true
  return { enabled: path === '/start' }
}

const SWITCH_CLASS = 'natfrp-switch'
function ensureSwitchNode(r) {
  let node = r.querySelector('.' + SWITCH_CLASS)
  if (node) return node
  node = new El('button')
  node.className = SWITCH_CLASS
  node.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); void toggleEnabled(node) })
  r.appendChild(node)
  return node
}

async function toggleEnabled(node) {
  if (!node || node.dataset.busy === 'true') return
  const turningOn = node.dataset.on !== 'true'
  node.dataset.on = turningOn ? 'true' : 'false'   // 乐观更新
  node.dataset.busy = 'true'
  try {
    const st = await post(turningOn ? '/start' : '/stop')
    const actual = st?.enabled !== false            // ← 以服务端为准
    node.dataset.on = actual ? 'true' : 'false'
    setEnabled(actual)
  } catch {
    node.dataset.on = turningOn ? 'false' : 'true'
  } finally {
    node.dataset.busy = 'false'
  }
}

function syncSwitch(r) {
  const node = ensureSwitchNode(r)
  if (!node) return
  if (node.dataset.busy === 'true') return
  const want = storeEnabled ? 'true' : 'false'      // ← 读 store 同步值
  if (node.dataset.on !== want) node.dataset.on = want
}

// 初始化：开关是开的
const sw = ensureSwitchNode(row)
syncSwitch(row)
rec('初始化 = 开', sw.dataset.on === 'true')

// ── 你的实测序列 ──
// 第 1 次点击：期望 视觉立刻变关，且服务端也变关
await new Promise((r) => sw.dispatch('click') || r())
await new Promise((r) => setTimeout(r, 0))
rec('第1次点击 → 视觉=关', sw.dataset.on === 'false', `on=${sw.dataset.on} store=${storeEnabled}`)
rec('第1次点击 → 服务端=关', storeEnabled === false)
rec('第1次点击 → 发了 /stop', posts.at(-1) === '/stop')

// React 重渲染 → useEffect 调 syncAllSwitches（此时可能还是旧 state，但函数读 store）
syncSwitch(row)
rec('重渲染后不被覆盖', sw.dataset.on === 'false', `on=${sw.dataset.on}`)

// 第 2 次点击：期望 视觉立刻变开，服务端变开
await new Promise((r) => sw.dispatch('click') || r())
await new Promise((r) => setTimeout(r, 0))
rec('第2次点击 → 视觉=开', sw.dataset.on === 'true', `on=${sw.dataset.on} store=${storeEnabled}`)
rec('第2次点击 → 服务端=开', storeEnabled === true)
rec('第2次点击 → 发了 /start', posts.at(-1) === '/start')

// 第 3 次点击：关
await new Promise((r) => sw.dispatch('click') || r())
await new Promise((r) => setTimeout(r, 0))
rec('第3次点击 → 视觉=关', sw.dataset.on === 'false')
rec('第3次点击 → 服务端=关', storeEnabled === false)

// 连点保护：busy 期间第二次点击被忽略
const node2 = ensureSwitchNode(row)
node2.dataset.busy = 'true'
const before = posts.length
node2.dispatch('click')
rec('busy 期间点击被忽略', posts.length === before)

const ok = results.every(Boolean)
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`)
process.exit(ok ? 0 : 1)
