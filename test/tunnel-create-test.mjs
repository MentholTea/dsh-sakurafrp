// tunnel-create-test.mjs — 本地新建隧道：起真插件、拦官方 API、看发出去的报文
//
// 只测「调用链是否把参数拼对」这一件事：
//   · 节点列表：离线/付费剔掉；满载的**保留但标记不可选**（要能看到它，不然
//     用户以为节点不存在）；负载百分比要带出来给界面标颜色
//   · 创建时的表单字段（type=tcp、本地端口、remote 不填交给官方分配）
//   · 表单里填的端口要同时成为「本机端口」
//   · 改端口时反向把面板里那条隧道改成一致（to-panel）
//   · 官方塞回来的 important_warning_for_ai 要透传到界面
//
// 不碰真实账号：全局 fetch 被替换成内存桩，永远不会发到 api.natfrp.com。

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'

const home = mkdtempSync(join(tmpdir(), 'dsh-create-test-'))
process.env.DSH_HOME = home

const results = []
const rec = (n, p, d = '') => { results.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`) }

/** 找一个当前空闲的端口：绑 0 拿号再放掉 */
async function freePort() {
  const s = createServer()
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  const p = s.address().port
  await new Promise((r) => s.close(r))
  return p
}

const GATE_PORT = await freePort()
const NEW_PORT = await freePort()

// ── 官方 API 桩 ──
const calls = []
let tunnelPort = GATE_PORT
const NODES = {
  // 允许创建(0b100) + 海外 + 免费 → 保留
  1: { name: '香港节点', host: 'hk.natfrp.cloud', description: '海外', vip: 0, flag: 0b0100 },
  // 允许创建 + 内地(1<<3) + 免费 → 保留，且应排到第一位
  2: { name: '内地节点', host: 'cn.natfrp.cloud', description: '内地', vip: 0, flag: 0b0100 | 0b1000 },
  // 满载：ALLOW_CREATE 位是 0 → 保留在列表里但标成不可选
  3: { name: '满载节点', host: 'full.natfrp.cloud', description: '', vip: 0, flag: 0 },
  // 离线(1<<9) → 必须剔除
  4: { name: '离线节点', host: 'off.natfrp.cloud', description: '', vip: 0, flag: 0b0100 | (1 << 9) },
  // 付费节点 → 免费账号建不上去，必须剔除
  5: { name: 'VIP 节点', host: 'vip.natfrp.cloud', description: '', vip: 1, flag: 0b0100 },
}
const NODE_STATS = {
  time: 1760000000,
  nodes: [
    { id: 1, online: 0, uptime: 10, load: 12 },
    { id: 2, online: 0, uptime: 10, load: 58 },
    { id: 3, online: 0, uptime: 10, load: 96 },
  ],
}

const jsonRes = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

// ⚠️ 只拦 api.natfrp.com。测试自己也要用 fetch 打本地插件服务器，
//    一刀切拦掉的话连 /natfrp/api/nodes 都取不到。
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(String(input))
  if (u.hostname !== 'api.natfrp.com') return realFetch(input, init)

  const method = (init.method ?? 'GET').toUpperCase()
  const body = init.body
    ? Object.fromEntries(new URLSearchParams(String(init.body)).entries())
    : null
  calls.push({ method, path: u.pathname, search: u.search, body, headers: init.headers ?? {} })

  if (u.pathname === '/v4/nodes') return jsonRes(NODES)
  if (u.pathname === '/v4/node/stats') return jsonRes(NODE_STATS)
  if (u.pathname === '/v4/tunnels' && method === 'GET') {
    return jsonRes([{
      id: 90001, name: 'DSH', node: 2, type: 'tcp',
      local_ip: '127.0.0.1', local_port: tunnelPort, online: true,
    }])
  }
  if (u.pathname === '/v4/tunnel/edit' && method === 'POST') {
    tunnelPort = Number(body?.local_port ?? tunnelPort)
    return jsonRes({})
  }
  if (u.pathname === '/v4/tunnels' && method === 'POST') {
    tunnelPort = Number(body?.local_port ?? tunnelPort)
    return jsonRes({
      id: 90001,
      name: body?.name ?? 'DSH',
      remote: 41234,
      important_warning_for_ai: '该节点为 BETA 节点，稳定性可能不足。',
    }, 201)
  }
  if (u.pathname === '/v4/user/info') return jsonRes({ name: 'tester', speed: '10M', traffic: [0, 0], realname: 2 })
  if (u.pathname === '/v4/user/data_plans') return jsonRes([])
  return jsonRes({ code: 404, msg: 'not mocked' }, 404)
}

// ── 起插件 ──
const mod = await import('../index.js')
let handler = null
const upstream = createServer((req, res) => { res.writeHead(200); res.end('dsh-ok') })
await new Promise((r) => upstream.listen(0, '127.0.0.1', r))

const ctx = {
  logger: () => ({ info: () => {}, warn: () => {}, error: () => {}, log: () => {} }),
  webServer: { port: upstream.address().port, register: ({ handler: h }) => { handler = h; return () => {} } },
  // 给一个假密钥，否则所有官方调用都会以 no-token 提前返回
  credentials: { resolve: async () => 'FAKE-TOKEN', set: async () => {} },
  connection: { authenticatedUrl: (u) => `${u}/?token=abc` },
  timer: {},
  effect: (fn) => { fn?.(); return () => {} },
  inject: () => {},
  get: () => undefined,
}

// ⚠️ 故意不传 enabled：验证「装上默认就是关的」
mod.apply(ctx, { gatePort: GATE_PORT })

const srv = createServer((req, res) => handler(req, res))
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${srv.address().port}`
const getJSON = async (p) => {
  const r = await fetch(base + p)
  return { status: r.status, body: await r.json().catch(() => null) }
}
const postJSON = async (p, body) => {
  const r = await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}

// ── 0) 默认关闭 ──
const boot = await getJSON('/natfrp/api/state')
rec('没配 enabled 时默认是关的', boot.body?.enabled === false, `enabled=${boot.body?.enabled}`)
rec('默认关闭时 frpc 不运行', boot.body?.frpc?.running !== true)

// ── 1) 节点列表 ──
const nodesRes = await getJSON('/natfrp/api/nodes')
const list = nodesRes.body?.nodes ?? []
rec('GET /nodes 返回 200', nodesRes.status === 200, `status=${nodesRes.status}`)
rec('剔除了离线节点', !list.some((n) => n.name === '离线节点'))
rec('剔除了付费节点', !list.some((n) => n.name === 'VIP 节点'))
rec('满载节点仍然列出（让用户看见它满载，而不是以为不存在）',
  list.some((n) => n.name === '满载节点'))
rec('满载节点被标成不可选', list.find((n) => n.name === '满载节点')?.createAllowed === false)
rec('可创建节点为 true', list.find((n) => n.name === '内地节点')?.createAllowed === true)
rec('带出负载百分比', Number(list.find((n) => n.name === '内地节点')?.load) === 58,
  String(list.find((n) => n.name === '内地节点')?.load))
rec('可创建的排在满载之前', list[list.length - 1]?.name === '满载节点', list.map((n) => n.name).join(','))
rec('内地节点排在可创建里的第一位', list[0]?.name === '内地节点', list.map((n) => n.name).join(','))
rec('节点带上 mainland 标记', list[0]?.mainland === true && list[1]?.mainland === false)

// 发给官方的请求必须带 token
const nodesCall = calls.find((c) => c.path === '/v4/nodes')
rec('官方请求带 Bearer 认证', String(nodesCall?.headers?.authorization ?? '') === 'Bearer FAKE-TOKEN')
rec('节点负载来自 /node/stats', calls.some((c) => c.path === '/v4/node/stats'))

// ── 2) 创建隧道：参数拼装 ──
const created = await postJSON('/natfrp/api/tunnel/create', { name: 'DSH 面板', node: 2, port: NEW_PORT })
rec('POST /tunnel/create 返回 200', created.status === 200, `status=${created.status} ${JSON.stringify(created.body)}`)
rec('返回新隧道 id', created.body?.id === 90001, String(created.body?.id))
rec('返回实际使用的端口', Number(created.body?.port) === NEW_PORT, String(created.body?.port))

const createCall = calls.find((c) => c.path === '/v4/tunnels' && c.method === 'POST')
rec('打到官方 POST /tunnels', Boolean(createCall))
rec('类型固定 tcp（不需要域名解析）', createCall?.body?.type === 'tcp', String(createCall?.body?.type))
rec('本地 IP 固定 127.0.0.1', createCall?.body?.local_ip === '127.0.0.1', String(createCall?.body?.local_ip))
rec('本地端口用表单里填的那个', Number(createCall?.body?.local_port) === NEW_PORT, String(createCall?.body?.local_port))
rec('选了哪个节点就传哪个', Number(createCall?.body?.node) === 2, String(createCall?.body?.node))
rec('隧道名原样传过去', createCall?.body?.name === 'DSH 面板', String(createCall?.body?.name))
rec('不传 remote（交给官方分配端口）', createCall?.body?.remote === undefined, String(createCall?.body?.remote))
rec('创建请求用 form 编码', String(createCall?.headers?.['content-type'] ?? '').includes('x-www-form-urlencoded'))
// 自动 HTTPS：默认 auto，写进官方的 extra（key = value 每行一条）
rec('默认带 auto_https = auto', createCall?.body?.extra === 'auto_https = auto', String(createCall?.body?.extra))

// ── 2b) 前端传 off 时就写 off；非法值退回 auto ──
calls.length = 0
await postJSON('/natfrp/api/tunnel/create', { name: 'X', node: 2, port: NEW_PORT, autoHttps: 'off' })
const offCall = calls.find((c) => c.path === '/v4/tunnels' && c.method === 'POST')
rec('autoHttps=off → extra 写 off', offCall?.body?.extra === 'auto_https = off', String(offCall?.body?.extra))
calls.length = 0
await postJSON('/natfrp/api/tunnel/create', { name: 'X', node: 2, port: NEW_PORT, autoHttps: '乱写的' })
const junkCall = calls.find((c) => c.path === '/v4/tunnels' && c.method === 'POST')
rec('非法 autoHttps 退回 auto', junkCall?.body?.extra === 'auto_https = auto', String(junkCall?.body?.extra))
rec('响应里带 autoHttpsDropped（降级标记）', created.body?.autoHttpsDropped === false, String(created.body?.autoHttpsDropped))

// ── 3) 建完本机端口也跟着变成那个数 ──
const afterCreate = await getJSON('/natfrp/api/state')
rec('本机端口同步成表单端口', Number(afterCreate.body?.gatePort) === NEW_PORT, String(afterCreate.body?.gatePort))

// ── 4) 官方警告要透传 ──
rec('透传 important_warning_for_ai', /BETA 节点/.test(String(created.body?.warning ?? '')), String(created.body?.warning))

// ── 5) 创建后自动成为当前隧道 ──
rec('state 里的 tunnelId 变成新隧道', String(afterCreate.body?.tunnelId) === '90001', String(afterCreate.body?.tunnelId))

// ── 6) 改本机端口 → 面板里那条隧道跟着改（to-panel）──
const ANOTHER = await freePort()
calls.length = 0
const changed = await postJSON('/natfrp/api/config', { gatePort: ANOTHER })
rec('改端口成功', changed.status === 200, `status=${changed.status}`)
const editCall = calls.find((c) => c.path === '/v4/tunnel/edit')
rec('同步调用了 tunnel/edit', Boolean(editCall))
rec('tunnel/edit 带的是新端口', Number(editCall?.body?.local_port) === ANOTHER, String(editCall?.body?.local_port))
rec('回给界面方向 to-panel', changed.body?.portSync?.direction === 'to-panel', JSON.stringify(changed.body?.portSync))
rec('本机端口确实换了', Number(changed.body?.gatePort) === ANOTHER, String(changed.body?.gatePort))

// ── 6b) 隧道端口在本机被别的程序占着 → 反向往面板写，而不是一味失败 ──
const busy3 = createServer()
await new Promise((r) => busy3.listen(0, '127.0.0.1', r))
const busyPort3 = busy3.address().port
tunnelPort = busyPort3 // 假装面板里这条隧道连的是被占的那个端口
await postJSON('/natfrp/api/config', { tunnelId: '0' }) // 先切走，才能触发「重新选中」
const bounced = await postJSON('/natfrp/api/config', { tunnelId: '90001' })
rec('隧道端口被占时改面板而不是失败', bounced.body?.portSync?.direction === 'to-panel',
  JSON.stringify(bounced.body?.portSync))
rec('被占时本机端口保持原值', Number(bounced.body?.gatePort) === ANOTHER, String(bounced.body?.gatePort))
await new Promise((r) => busy3.close(r))

// ── 7) 端口可用性检测 ──
const busy = createServer()
await new Promise((r) => busy.listen(0, '127.0.0.1', r))
const busyPort = busy.address().port
const busyRes = await getJSON(`/natfrp/api/port/check?port=${busyPort}`)
rec('被占用的端口报占用', busyRes.body?.available === false && busyRes.body?.reason === 'occupied',
  JSON.stringify(busyRes.body))
await new Promise((r) => busy.close(r))

const okPort = await freePort()
const okRes = await getJSON(`/natfrp/api/port/check?port=${okPort}`)
rec('空闲端口报可用', okRes.body?.available === true, JSON.stringify(okRes.body))

const selfRes = await getJSON(`/natfrp/api/port/check?port=${ANOTHER}`)
rec('自己网关正听着的端口不算被占用', selfRes.body?.available === true, JSON.stringify(selfRes.body))

// 占用时改端口必须被挡住，且不改现状
const busy2 = createServer()
await new Promise((r) => busy2.listen(0, '127.0.0.1', r))
const busyPort2 = busy2.address().port
const rejected = await postJSON('/natfrp/api/config', { gatePort: busyPort2 })
rec('端口被占用 → 409 而不是静默改坏', rejected.status === 409 && rejected.body?.error === 'port-in-use',
  `status=${rejected.status}`)
const afterReject = await getJSON('/natfrp/api/state')
rec('被拒后端口保持原值', Number(afterReject.body?.gatePort) === ANOTHER, String(afterReject.body?.gatePort))
await new Promise((r) => busy2.close(r))

// ── 8) 参数不合法要挡住，而不是把脏数据发给官方 ──
const before = calls.filter((c) => c.path === '/v4/tunnels' && c.method === 'POST').length
const bad = await postJSON('/natfrp/api/tunnel/create', { name: 'x', node: 'abc' })
rec('node 非数字 → 400 bad-node', bad.status === 400 && bad.body?.error === 'bad-node', `status=${bad.status}`)
const badPort = await postJSON('/natfrp/api/tunnel/create', { name: 'x', node: 2, port: 80 })
rec('端口 80 → 400 bad-port', badPort.status === 400 && badPort.body?.error === 'bad-port', `status=${badPort.status}`)
const after = calls.filter((c) => c.path === '/v4/tunnels' && c.method === 'POST').length
rec('参数不合法时不打官方接口', before === after, `${before} -> ${after}`)

// ── 9) 空名字要有兜底 ──
calls.length = 0
await postJSON('/natfrp/api/tunnel/create', { name: '   ', node: 2 })
const fallback = calls.find((c) => c.path === '/v4/tunnels' && c.method === 'POST')
rec('空名字回落到默认名', fallback?.body?.name === 'DSH', String(fallback?.body?.name))

// ── 10) 清除访问密钥 ──
const cleared = await postJSON('/natfrp/api/config', { clearToken: true })
rec('clearToken 返回 200', cleared.status === 200, `status=${cleared.status}`)
rec('清完后 tokenConfigured=false', cleared.body?.tokenConfigured === false)

const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} passed`)
await new Promise((r) => srv.close(r))
await new Promise((r) => upstream.close(r))
setTimeout(() => process.exit(passed === results.length ? 0 : 1), 200)
