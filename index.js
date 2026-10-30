// dsh-sakurafrp — 宿主半侧。
//
// 数据流：
//   公网 → frpc(-f 语义, env 鉴权) → 127.0.0.1:<gatePort>(本插件网关)
//            ├─ /natfrp/* 管理路由
//            ├─ 密码门（HMAC cookie / ?gate=）
//            └─ Host 围栏反代 + WS 透传 → 127.0.0.1:<dshPort>(DSH WebServer)
//
// 自动对齐：frpc 启动前先查 API，若面板里该隧道的 local_port ≠ gatePort，
// 先 POST /tunnel/edit 改成 gatePort，再拉起 frpc —— 根治「隧道成功但 502」。

import { createServer } from 'node:http'
import { readFileSync, mkdirSync, writeFileSync, existsSync, rmdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

import { createClient, ApiError } from './natfrp.mjs'
import { createFrpcManager } from './frpc.mjs'
import { createPasswordGate, createGateServer } from './gate.mjs'

export const name = 'natfrp'
export const inject = ['credentials', 'webServer', 'timer', 'connection']

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const DATA_DIR = join(DSH_HOME, 'dsh-sakurafrp')
const LEGACY_DATA_DIR = join(DSH_HOME, 'dsh-natfrp') // 2.0.0 之前（旧包名）用过的目录
const STATE_PATH = join(DATA_DIR, 'state.json')
const PASSWORD_FILE = join(DATA_DIR, 'gate-password.txt')

/**
 * 一次性迁移旧状态目录（包名从 dsh-natfrp 改为 dsh-sakurafrp 时）。
 *
 * ⚠️ 用「复制」而不是 rename：
 *   旧包（@local/dsh-natfrp）可能仍被安装着，rename 会把它的状态目录搬走，
 *   让它下一轮读不到 state.json / 网关密码 —— 迁移不该有这种破坏性副作用。
 *   复制出来的副本让新包直接可用，旧目录留给旧包自己，用户卸载旧包时可自行清理。
 *
 * 只在「新目录不存在、旧目录存在」时动作；任何失败都静默放过（退化为首次使用），
 * 绝不能让插件起不来。
 */
const LEGACY_FILES = ['state.json', 'gate-password.txt']

function migrateLegacyDataDir() {
  try {
    if (existsSync(DATA_DIR)) return
    if (!existsSync(LEGACY_DATA_DIR)) return
    let copied = 0
    mkdirSync(DATA_DIR, { recursive: true })
    for (const file of LEGACY_FILES) {
      const from = join(LEGACY_DATA_DIR, file)
      if (!existsSync(from)) continue
      try {
        writeFileSync(join(DATA_DIR, file), readFileSync(from), { mode: 0o600 })
        copied += 1
      } catch {
        // 单个文件失败不影响其它文件
      }
    }
    if (copied === 0) {
      // 没复制到任何东西就别留空目录，避免下次误判「已迁移」
      try { rmdirSync(DATA_DIR) } catch { /* noop */ }
    }
  } catch {
    // 权限/IO 问题 —— 退化为重新配置一次
  }
}
migrateLegacyDataDir()

function safeRead(p) {
  if (!p) return ''
  try { return readFileSync(p, 'utf8').trim() } catch { return '' }
}

function readState() {
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')) ?? {} } catch { return {} }
}

function writeState(next) {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true })
    writeFileSync(STATE_PATH, JSON.stringify(next, null, 2), { mode: 0o600 })
  } catch { /* 持久化失败不致命 */ }
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger?.(name) ?? console
  const logInfo = (...a) => (logger.info ?? logger.log).call(logger, ...a)
  const logWarn = (...a) => logger.warn(...a)
  const logError = (...a) => logger.error(...a)

  // ---------- 配置与状态 ----------

  const state = readState()
  const cfg = {
    frpcPath: String(config.frpcPath || join(DSH_HOME, 'bin', process.platform === 'win32' ? 'frpc-standalone.exe' : 'frpc-standalone')),
    tokenFile: String(config.tokenFile || '').trim(),
    tokenRef: String(config.tokenRef || 'NATFRP_TOKEN'),
    maxLogLines: Number(config.maxLogLines) || 500,
    autoAlign: config.autoAlign !== false,
    dshPort: Number(config.dshPort) || 0,
  }

  let enabled = state.enabled ?? config.enabled !== false
  let tunnelId = String(state.tunnelId ?? config.tunnelId ?? '').trim()
  let gatePort = Number(state.gatePort ?? config.gatePort ?? 3083)
  let gatePassword = String(state.gatePassword ?? '') || safeRead(PASSWORD_FILE) || String(config.gatePassword ?? '')

  const dshPort = ctx.webServer?.port ?? (cfg.dshPort || 0)

  function tokenNow() {
    const fromFile = safeRead(cfg.tokenFile)
    if (fromFile) return fromFile
    return '' // 文件优先；credentials 异步走 resolveTokenAsync
  }

  async function resolveToken() {
    const fromFile = tokenNow()
    if (fromFile) return fromFile
    try {
      const r = await ctx.credentials?.resolve?.(cfg.tokenRef)
      if (!r) return ''
      return typeof r === 'string' ? r : (r.value ?? r.secret ?? '')
    } catch (e) {
      logError(`natfrp: credentials resolve 失败: ${e?.message ?? e}`)
      return ''
    }
  }

  // ---------- frpc ----------

  const frpc = createFrpcManager({
    frpcPath: cfg.frpcPath,
    getToken: tokenNow,
    maxLogLines: cfg.maxLogLines,
    log: (m) => logInfo(`natfrp: ${m}`),
  })

  // ---------- API ----------

  let lastTunnelInfo = null
  let lastApiError = ''

  function apiOrNull(token) {
    if (!token) return null
    return createClient(token, { log: (m) => logWarn(`natfrp: api ${m}`) })
  }

  /** 自动对齐：面板 local_port ≠ gatePort 时改面板。返回报告。 */
  async function autoAlign(api) {
    if (!cfg.autoAlign || !api || !tunnelId) return { skipped: true }
    try {
      const list = await api.tunnels()
      const tn = Array.isArray(list) ? list.find((t) => String(t.id) === tunnelId) : null
      if (!tn) return { skipped: true, reason: `面板上没有隧道 ${tunnelId}` }
      lastTunnelInfo = tn
      if (Number(tn.local_port) === gatePort && String(tn.local_ip ?? '127.0.0.1') === '127.0.0.1') {
        return { aligned: true, already: true }
      }
      await api.tunnelEdit({
        id: Number(tunnelId),
        local_ip: '127.0.0.1',
        local_port: gatePort,
      })
      logInfo(`natfrp: 已对齐隧道 ${tunnelId} local_port ${tn.local_port} → ${gatePort}`)
      return { aligned: true, changed: true, from: Number(tn.local_port), to: gatePort }
    } catch (e) {
      lastApiError = e instanceof ApiError ? e.message : String(e?.message ?? e)
      logWarn(`natfrp: 自动对齐失败: ${lastApiError}`)
      return { aligned: false, error: lastApiError }
    }
  }

  async function startAll(reason = '') {
    if (!enabled) return
    const token = await resolveToken()
    if (!token) {
      logError(`natfrp: 访问密钥为空（tokenFile=${cfg.tokenFile || '未配置'}, tokenRef=${cfg.tokenRef}）`)
      return
    }
    if (!tunnelId) {
      logError('natfrp: 未配置隧道 ID')
      return
    }
    const api = apiOrNull(token)
    if (api) {
      const report = await autoAlign(api)
      if (report.error) logWarn(`natfrp: 对齐报告: ${JSON.stringify(report)}`)
      frpc.note(`对齐: ${JSON.stringify(report)}`)
    }
    const r = frpc.start({ tunnelIds: [tunnelId] })
    if (!r.ok) {
      logWarn(`natfrp: frpc 启动失败: ${r.reason}${r.detail ? ` (${r.detail})` : ''}`)
      frpc.note(`frpc 启动失败: ${r.reason}`)
    } else {
      logInfo(`natfrp: frpc 已启动 (pid=${r.pid}${reason ? `, ${reason}` : ''})`)
      frpc.note(`frpc 已启动 (pid=${r.pid}${reason ? `, ${reason}` : ''})`)
    }
  }

  // ---------- 网关 ----------

  const gate = createPasswordGate({
    getPassword: () => gatePassword,
    log: (m) => logInfo(`natfrp: ${m}`),
  })

  let gateServer = null
  let actualGatePort = null

  async function startGate(port) {
    const server = createGateServer({
      port,
      host: '0.0.0.0',
      upstream: { host: '127.0.0.1', port: dshPort },
      launchToken: () => {
        try {
          const conn = ctx.connection
          if (!conn || typeof conn.authenticatedUrl !== 'function') return ''
          const u = new URL(conn.authenticatedUrl(`http://127.0.0.1:${dshPort}`))
          return u.searchParams.get('token') ?? ''
        } catch {
          return ''
        }
      },
      onRequest: async (req, res, opts = {}) => {
        const isLocal = (() => {
          const ip = String(req.socket?.remoteAddress ?? '')
          return ip.includes('127.0.0.1') || ip.includes('::1') || ip === '::ffff:127.0.0.1'
        })()
        const path = String(req.url ?? '')
        if (path.startsWith('/natfrp')) {
          // 管理路由：仅本机 HTTP；WS 升级一律销毁
          if (opts.upgrade) {
            try { res?.destroy?.() } catch { /* noop */ }
            return true
          }
          if (!isLocal) {
            res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('forbidden')
            return true
          }
          return handleOwnRoutes(req, res)
        }
        if (opts.upgrade) {
          // WS：gate.handle 假设 res 是 ServerResponse，对升级请求不适用。
          // 本机放行；公网需持有密码门 cookie，否则在握手层 401。
          if (isLocal) return false
          if (!gate.checkWs(req)) {
            try {
              res.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
              res.destroy()
            } catch { /* noop */ }
            return true
          }
          return false
        }
        // 其余全部走密码门（未配置密码时 gate.handle 返回 false → 放行）
        return gate.handle(req, res)
      },
      log: (m) => logWarn(`natfrp: ${m}`),
    })
    let info
    try {
      info = await server.listen()
    } catch (e) {
      logError(`natfrp: 网关端口 ${port} 监听失败（可能被占用）：${e?.message ?? e}`)
      await server.close().catch(() => {})
      throw e
    }
    gateServer = server
    actualGatePort = info.port
    logInfo(`natfrp: 网关 :${info.port} → dsh :${dshPort}${gatePassword ? ' (密码门已启用)' : ' (⚠ 无密码)'}`)
    return info.port
  }

  async function restartGate(port) {
    if (gateServer) await gateServer.close().catch(() => {})
    gateServer = null
    actualGatePort = null
    return startGate(port)
  }

  // ---------- 管理路由（/natfrp/*，双挂：网关 + DSH webServer） ----------

  function readBody(req, limit = 16384) {
    return new Promise((resolve) => {
      let body = ''
      req.on('data', (c) => { body += c; if (body.length > limit) req.destroy() })
      req.on('end', () => resolve(body))
      req.on('error', () => resolve(body))
    })
  }

  function json(res, code, obj) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(obj))
  }

  /**
   * 从请求推导可用的绝对 origin。
   * 优先用请求自带的 Origin（浏览器会带），退化到 Host 头 + 协议推断。
   * 这样桌面（_dsh-app://app 页面经 IPC 走 HTTP）与浏览器（http://127.0.0.1:port）
   * 都能拿到与当前 webserver 匹配的地址。
   */
  function originOf(req) {
    try {
      const o = req.headers?.origin
      if (o && /^https?:/.test(o)) return o.replace(/\/+$/, '')
    } catch { /* noop */ }
    const host = req.headers?.host
    if (host) {
      const proto = String(req.socket?.encrypted ? 'https' : 'http')
      return `${proto}://${host}`
    }
    return `http://127.0.0.1:${dshPort}`
  }

  async function snapshot(originBase = '') {
    const token = tokenNow()
    let tunnelInfo = lastTunnelInfo
    let apiOk = Boolean(token)
    // 轻量探测：有 token 就试一次 tunnels（有本地缓存优先缓存，避免每 4s 打 API）
    return {
      enabled,
      tunnelId,
      gatePort: actualGatePort ?? gatePort,
      gateRunning: Boolean(gateServer?.listening),
      gatePasswordConfigured: Boolean(gatePassword),
      tokenConfigured: Boolean(token),
      tokenFile: cfg.tokenFile,
      autoAlign: cfg.autoAlign,
      dshPort,
      frpc: frpc.snapshot(),
      tunnelInfo,
      apiOk,
      apiError: lastApiError || undefined,
      // 绝对化的日志地址：桌面端内置浏览器/外部浏览器都无法解析相对路径，
      // 客户端拿不到 webServer 服务，所以必须由服务端按实际请求来源拼出来。
      logsUrl: `${originBase}/natfrp/api/logs`,
    }
  }

  /** 处理 /natfrp 前缀；返回 true = 已接管。 */
  async function handleOwnRoutes(req, res) {
    let url
    try { url = new URL(req.url ?? '/', 'http://127.0.0.1') } catch { return false }
    const path = url.pathname.replace(/\/+$/, '')
    if (!path.startsWith('/natfrp')) return false

    if (path === '/natfrp/api/state' && req.method === 'GET') {
      json(res, 200, await snapshot(originOf(req)))
      return true
    }

    if (path === '/natfrp/api/logs' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end(frpc.logs().join('\n') || '(暂无日志)')
      return true
    }

    if (path === '/natfrp/api/tunnels' && req.method === 'GET') {
      const token = await resolveToken()
      const api = apiOrNull(token)
      if (!api) { json(res, 400, { error: 'no-token' }); return true }
      try {
        const [tunnels, nodes] = await Promise.all([api.tunnels(), api.nodes().catch(() => ({}))])
        const nodeMap = nodes ?? {}
        json(res, 200, {
          tunnels: (tunnels ?? []).map((t) => ({
            ...t,
            nodeName: nodeMap[t.node]?.name ?? `节点 ${t.node}`,
          })),
        })
      } catch (e) {
        json(res, 502, { error: 'api-failed', message: e instanceof ApiError ? e.message : String(e?.message ?? e) })
      }
      return true
    }

    if (path === '/natfrp/api/user' && req.method === 'GET') {
      const token = await resolveToken()
      const api = apiOrNull(token)
      if (!api) { json(res, 400, { error: 'no-token' }); return true }
      try {
        const info = await api.userInfo()
        // 附带流量包：userInfo.traffic 没有「总量」，算剩余百分比必须靠 data_plans。
        // 端点失败不能拖垮整个账号信息，故单独 catch 并在响应里标注。
        let plans = null
        let plansError
        try {
          plans = await api.dataPlans('valid')
        } catch (e) {
          plansError = e instanceof ApiError ? e.message : String(e?.message ?? e)
        }
        json(res, 200, { ...info, dataPlans: plans, dataPlansError: plansError })
      } catch (e) {
        json(res, 502, { error: 'api-failed', message: e instanceof ApiError ? e.message : String(e?.message ?? e) })
      }
      return true
    }

    if (path === '/natfrp/api/start' && req.method === 'POST') {
      enabled = true
      writeState({ enabled, tunnelId, gatePort, gatePassword })
      void startAll('manual start')
      json(res, 200, await snapshot(originOf(req)))
      return true
    }

    if (path === '/natfrp/api/stop' && req.method === 'POST') {
      enabled = false
      frpc.stop()
      writeState({ enabled, tunnelId, gatePort, gatePassword })
      logInfo('natfrp: 已手动停止')
      json(res, 200, await snapshot(originOf(req)))
      return true
    }

    if (path === '/natfrp/api/align' && req.method === 'POST') {
      const token = await resolveToken()
      const api = apiOrNull(token)
      if (!api) { json(res, 400, { error: 'no-token' }); return true }
      if (!tunnelId) { json(res, 400, { error: 'no-tunnel' }); return true }
      const report = await autoAlign(api)
      json(res, report.error ? 502 : 200, report)
      return true
    }

    if (path === '/natfrp/api/config' && req.method === 'POST') {
      const body = await readBody(req)
      let patch
      try { patch = JSON.parse(body || '{}') } catch { json(res, 400, { error: 'invalid-json' }); return true }

      const prevPort = gatePort
      let portChanged = false

      if (typeof patch.enabled === 'boolean') enabled = patch.enabled
      if (typeof patch.tunnelId === 'string') tunnelId = patch.tunnelId.trim().replace(/[^0-9]/g, '')
      if (patch.gatePort !== undefined) {
        const n = Number(patch.gatePort)
        if (Number.isInteger(n) && n >= 1024 && n <= 65535) {
          if (n !== gatePort) portChanged = true
          gatePort = n
        }
      }
      if (typeof patch.gatePassword === 'string' && patch.gatePassword.length > 0) {
        gatePassword = patch.gatePassword
        try {
          mkdirSync(DATA_DIR, { recursive: true })
          writeFileSync(PASSWORD_FILE, gatePassword, { mode: 0o600 })
        } catch (e) {
          json(res, 500, { error: 'password-write-failed', message: String(e?.message ?? e) })
          return true
        }
      }
      if (typeof patch.token === 'string' && patch.token.trim()) {
        if (cfg.tokenFile) {
          try { writeFileSync(cfg.tokenFile, patch.token.trim(), { mode: 0o600 }) }
          catch (e) { json(res, 500, { error: 'token-write-failed', message: String(e?.message ?? e) }); return true }
        } else {
          try { await ctx.credentials?.set?.(cfg.tokenRef, patch.token.trim()) }
          catch (e) { json(res, 500, { error: 'credential-set-failed', message: String(e?.message ?? e) }); return true }
        }
      }

      writeState({ enabled, tunnelId, gatePort, gatePassword })
      frpc.note(`配置更新: enabled=${enabled} tunnel=${tunnelId} gate=${gatePort}`)
      logInfo(`natfrp: 配置已更新 (enabled=${enabled} tunnel=${tunnelId} gate=${gatePort})`)

      if (portChanged) {
        try { await restartGate(gatePort) } catch { /* 已在 startGate 里报错 */ }
        // 端口变了必须重启 frpc 才会走新对齐
        frpc.stop()
        if (enabled) void startAll('gate port changed')
      } else if (patch.tunnelId !== undefined && enabled) {
        frpc.stop()
        void startAll('tunnel changed')
      } else if (patch.enabled === true) {
        void startAll('enabled')
      } else if (patch.enabled === false) {
        frpc.stop()
      }

      json(res, 200, await snapshot(originOf(req)))
      return true
    }

    // 首页（浏览器直接开 /natfrp）
    if (path === '/natfrp' || path === '/natfrp/') {
      const s = await snapshot(originOf(req))
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(`<!doctype html><meta charset="utf-8"><title>natfrp</title>
<pre>${JSON.stringify(s, null, 2)}</pre>
<p><a href="/natfrp/api/logs">frpc 日志</a> · <a href="/natfrp/api/tunnels">隧道列表</a> · <a href="/natfrp/api/user">账号信息</a></p>`)
      return true
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return true
  }

  // 管理路由同时挂到 DSH webServer（本机设置页用），必须用 ctx.effect 保证回收
  ctx.effect(() => {
    const dispose = ctx.webServer?.register?.({
      kind: 'prefix',
      path: '/natfrp',
      handler: async (req, res) => {
        try {
          const handled = await handleOwnRoutes(req, res)
          if (!handled) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('not found')
          }
        } catch (e) {
          try { json(res, 500, { error: 'internal', message: String(e?.message ?? e) }) } catch { /* noop */ }
        }
      },
    })
    return () => { try { dispose?.() } catch { /* noop */ } }
  }, 'natfrp: webServer route')

  // ---------- 启动 ----------

  void startGate(gatePort).catch(() => { /* startGate 已报错 */ })
  if (enabled) void startAll('initial')
  else logInfo('natfrp: 插件处于停用状态（设置页可开启）')

  ctx.effect(() => async () => {
    frpc.stop()
    if (gateServer) await gateServer.close().catch(() => {})
    logInfo('natfrp: 已停止')
  }, 'natfrp: frpc + gate')

  return () => {}
}

export { name as pluginName }
