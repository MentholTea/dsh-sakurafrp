// preview-render.mjs — 把设置面板「真渲染」成一张静态 HTML，用来肉眼检查布局密度
//
// 为什么要有这个：间距/密度这类问题没法靠正则断言判断，只能看。
// 这里不手抄样式，而是直接跑 client.js 里的 Panel 组件：
//   伪造一个极简 React（useState / useEffect / useRef / useCallback）
//   + 伪造 fetch 返回一份假状态，
//   把组件树渲染成带 inline style 的 HTML，再交给浏览器排版。
//
// 用法：node preview-render.mjs [输出路径]
//   不带参数时输出到 .preview/panel.html

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outPath = resolve(here, process.argv[2] ?? '.preview/panel.html')

// ────────────────────────────── 极简 React ──────────────────────────────
const hookStore = new Map()      // key -> { hooks: [], deps: [] }
let currentCtx = null            // { key, cursor, effects }
let dirty = false

function slotOf(init) {
  const { hooks } = hookStore.get(currentCtx.key)
  const i = currentCtx.cursor++
  if (!(i in hooks)) hooks[i] = { value: init }
  return { hooks, i }
}

const React = {
  createElement(type, props, ...children) {
    const kids = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
    return { type, props: props ?? {}, children: kids }
  },
  useState(init) {
    const { hooks, i } = slotOf(init)
    const set = (next) => {
      const v = typeof next === 'function' ? next(hooks[i].value) : next
      if (v === hooks[i].value) return
      hooks[i].value = v
      dirty = true
    }
    return [hooks[i].value, set]
  },
  useRef(init) {
    const { hooks, i } = slotOf({ current: init })
    return hooks[i].value
  },
  useCallback(fn) { return fn },
  useEffect(fn, deps) {
    const { hooks, i } = slotOf(undefined)
    const prev = hooks[i].value
    const same = prev && deps && prev.deps && deps.length === prev.deps.length
      && deps.every((d, k) => d === prev.deps[k])
    if (same) return
    hooks[i].value = { deps }
    currentCtx.effects.push(fn)
  },
}

// ────────────────────────────── 假宿主环境 ──────────────────────────────
// PREVIEW_VARIANT=fresh   渲染「首次使用」状态（没密钥、没密码、没有隧道）
// PREVIEW_VARIANT=create  渲染「新建隧道」表单展开的状态（看节点列表的空闲配色）
// PREVIEW_VARIANT=noport  渲染「开关已开但端口还空着」的状态（看缺端口的提示）
const VARIANT = process.env.PREVIEW_VARIANT ?? 'ready'
const isCreate = VARIANT === 'create'
const isFresh = VARIANT === 'fresh'
const isNoPort = VARIANT === 'noport'

const SNAPSHOT = isFresh
  ? {
    // 真正的新装状态：开关关着、端口空着（不是 3083）、没密钥、没密码、没隧道
    enabled: false,
    gatePort: null,
    gateRunning: false,
    gatePasswordConfigured: false,
    tokenConfigured: false,
    tunnelId: '',
    logsUrl: 'http://127.0.0.1:3080/natfrp/api/logs',
    frpcInstall: { present: true, ok: true },
    frpc: { running: false },
  }
  : isNoPort
    ? {
      enabled: true,
      gatePort: null,
      gateRunning: false,
      gatePasswordConfigured: true,
      tokenConfigured: true,
      tunnelId: '12345',
      logsUrl: 'http://127.0.0.1:3080/natfrp/api/logs',
      frpcInstall: { present: true, ok: true },
      frpc: { running: false },
    }
    : {
      enabled: true,
      gatePort: 3083,
      gateRunning: true,
      gatePasswordConfigured: true,
      tokenConfigured: true,
      tunnelId: '12345',
      logsUrl: 'http://127.0.0.1:3080/natfrp/api/logs',
      frpcInstall: { present: true, ok: true },
      frpc: { running: true, pid: 8124, tunnelOk: true, tunnelUrl: 'abc123.nyat.app:24567', kickSuspect: false },
    }
// 没密钥时官方账号接口本来就取不到东西，预览也不该凭空造一个账号
const USER = isFresh
  ? null
  : {
    name: 'demo-user', speed: '免费用户 · 10Mbps', realname: 2,
    traffic: [12_800_000_000, 38_000_000_000],
    dataPlans: [{ total: 50_000_000_000, remaining: 38_000_000_000 }],
  }
const TUNNELS = isFresh
  ? { tunnels: [] }
  : { tunnels: [{ id: 12345, name: 'DSH', nodeName: '广州 1', local_port: 3083, online: true }] }
// 覆盖四档负载 + 一个查不到负载的节点，用来检查颜色与排版是否正常
const NODES = {
  nodes: [
    { id: 1, name: '广州 1', mainland: true, load: 12, createAllowed: true, online: true },
    { id: 2, name: '上海 2', mainland: true, load: 55, createAllowed: true, online: true },
    { id: 3, name: '北京 3', mainland: true, load: 78, createAllowed: true, online: true },
    { id: 4, name: '成都 4', mainland: true, load: 96, createAllowed: false, online: true },
    { id: 5, name: '香港 1', mainland: false, load: -1, createAllowed: true, online: true },
  ],
}

globalThis.window = {
  __ModuleLoader__: { load(mod) { module_ = mod } },
  // 让 Panel 初始就把「新建隧道」表单展开，好检查节点列表的排版与配色
  __natfrpPreviewCreate: isCreate,
  addEventListener() {}, removeEventListener() {},
  open() {}, matchMedia: () => ({ matches: false, addEventListener() {} }),
}
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, setAttribute() {} }),
  head: { appendChild() {} },
  body: { dataset: {}, appendChild() {}, classList: { add() {}, remove() {} } },
  addEventListener() {}, removeEventListener() {},
}
globalThis.location = { origin: 'http://127.0.0.1:3080' }
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}
globalThis.setTimeout = () => 0
globalThis.fetch = async (url) => {
  const u = String(url)
  let body = {}
  if (u.includes('/natfrp/api/state')) body = SNAPSHOT
  else if (u.includes('/natfrp/api/user')) body = USER
  else if (u.includes('/natfrp/api/tunnels')) body = TUNNELS
  else if (u.includes('/natfrp/api/nodes')) body = NODES
  // 端口可用性：面板一进来就会自动验一次（④ 的显示条件就是它），
  // 桩里必须答「可用」，否则预览永远缺 ④ 这一步
  else if (u.includes('/natfrp/api/port/check')) body = { port: 3083, inRange: true, available: true }
  else if (u.includes('/natfrp/api/logs')) body = {}
  return { ok: true, status: 200, json: async () => body, text: async () => '' }
}

// ────────────────────────────── 载入插件模块 ──────────────────────────────
let module_ = null
const src = readFileSync(resolve(here, 'client.js'), 'utf8')
// eslint-disable-next-line no-new-func
new Function('window', 'document', 'location', 'fetch', src)(
  globalThis.window, globalThis.document, globalThis.location, globalThis.fetch,
)
const exported = module_.factory((name) => {
  if (name === 'react') return React
  throw new Error(`preview: 未提供模块 ${name}`)
})

// 截获 settings.section 注册的 Panel 组件
let Panel = null
exported.apply({
  get: () => undefined,
  inject: () => {},
  slots: { inject: (_name, fn) => fn(), register: (_meta, comp) => { Panel ??= comp; return () => {} } },
})
if (typeof Panel !== 'function') throw new Error('preview: 没拿到 Panel 组件')

// ────────────────────────────── 渲染为 HTML ──────────────────────────────
const UNITLESS = new Set(['opacity', 'fontWeight', 'lineHeight', 'flex', 'flexGrow', 'flexShrink', 'zIndex'])

function css(style) {
  if (!style) return ''
  return Object.entries(style)
    .filter(([, v]) => v !== undefined && v !== null && v !== false)
    .map(([k, v]) => {
      const prop = k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)
      const val = typeof v === 'number' && !UNITLESS.has(k) ? `${v}px` : String(v)
      return `${prop}:${val.replace(/"/g, "'")}`
    })
    .join(';')
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

let instanceSeq = 0
function renderNode(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return esc(node)
  if (Array.isArray(node)) return node.map(renderNode).join('')

  const { type, props, children } = node
  if (typeof type === 'function') {
    // 每个组件实例用「函数名 + 出现序号」作 hook 存储键：树结构稳定时跨轮次复用
    const name = type.name || 'anon'
    const key = `${name}#${instanceSeq++}`
    if (!hookStore.has(key)) hookStore.set(key, { hooks: [], deps: [] })
    const prev = currentCtx
    currentCtx = { key, cursor: 0, effects: [] }
    let out
    try {
      out = type({ ...props, children })
    } finally {
      const ctx = currentCtx
      currentCtx = prev
      if (prev) prev.effects.push(...ctx.effects)
    }
    return renderNode(out)
  }

  const attrs = []
  if (props.title) attrs.push(`title="${esc(props.title)}"`)
  if (props.placeholder) attrs.push(`placeholder="${esc(props.placeholder)}"`)
  if (props.type) attrs.push(`type="${esc(props.type)}"`)
  if (props.value !== undefined && props.value !== '') attrs.push(`value="${esc(props.value)}"`)
  if (props.href) attrs.push(`href="#"`)
  attrs.push(`style="${css(props.style)}"`)
  const inner = children.map(renderNode).join('')
  if (type === 'input') return `<input ${attrs.join(' ')}>`
  // <select value="x"> 是 React 的写法，浏览器不认：必须给对应 <option> 补 selected，
  // 否则预览永远显示第一项，看着像「没选中隧道」而误判排版。
  if (type === 'select') {
    const sel = String(props.value ?? '')
    const opts = children.map((c) => {
      if (!c || typeof c !== 'object' || c.type !== 'option') return renderNode(c)
      const v = String(c.props.value ?? '')
      const oa = [`value="${esc(v)}"`]
      if (v === sel) oa.push('selected')
      if (c.props.style) oa.push(`style="${css(c.props.style)}"`)
      return `<option ${oa.join(' ')}>${c.children.map(renderNode).join('')}</option>`
    }).join('')
    return `<select ${attrs.join(' ')}>${opts}</select>`
  }
  return `<${type} ${attrs.join(' ')}>${inner}</${type}>`
}

async function renderPanel() {
  let html = ''
  for (let pass = 0; pass < 40; pass++) {
    dirty = false
    instanceSeq = 0
    const rootCtx = { key: '__root__', cursor: 0, effects: [] }
    if (!hookStore.has('__root__')) hookStore.set('__root__', { hooks: [], deps: [] })
    currentCtx = rootCtx
    const tree = Panel({})
    html = renderNode(tree)      // 子组件的 effect 会顺着 ctx 汇总到 rootCtx
    currentCtx = null

    if (rootCtx.effects.length === 0 && !dirty) break
    for (const fn of rootCtx.effects) {
      try { fn() } catch { /* 预览环境没有真实宿主，忽略 */ }
    }
    // 把 fetch / setState 的微任务链跑完，再看有没有新状态
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r))
    if (!dirty) break
  }
  return html
}

const body = await renderPanel()

const page = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>内网穿透设置面板 · 布局预览</title>
<style>
  :root { color-scheme: light; }
  body {
    margin: 0; padding: 28px 24px; background: #f6f7f9;
    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    color: #1f2328; font-size: 13px;
  }
  .frame { width: 560px; margin: 0 auto; background: #fff; border-radius: 12px;
    box-shadow: 0 1px 3px rgba(0,0,0,.08); padding: 4px 20px 20px; }
  h1 { font: 600 14px/1.4 inherit; margin: 0 0 12px; }
  a { color: #4f6ef7; text-decoration: none; }
  input, select { font: inherit; color: inherit; }
  * { box-sizing: border-box; }
  #metrics { position: absolute; left: -9999px; }
</style></head>
<body>
  <div id="metrics">HEIGHT=0</div>
  <div class="frame">
    <div id="panel-body" style="padding-bottom:2px">
    ${body}
    </div>
  </div>
  <script>
    // 把排完版后的真实像素高度写回 DOM，供 density-test 用 --dump-dom 读取
    (function () {
      var el = document.getElementById('panel-body')
      var px = Math.round(el.getBoundingClientRect().height)
      document.getElementById('metrics').textContent = 'HEIGHT=' + px
    })()
  </script>
</body></html>`

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, page, 'utf8')
console.log(`已生成：${outPath}（${(page.length / 1024).toFixed(1)} KB）`)
