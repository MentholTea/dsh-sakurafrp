// dsh-sakurafrp — 宿主半侧。
//
// 数据流：
//   公网 → frpc(-f 语义, env 鉴权) → 127.0.0.1:<gatePort>(本插件网关)
//            ├─ /natfrp/* 管理路由
//            ├─ 密码门（HMAC cookie / ?gate=）
//            └─ Host 围栏反代 + WS 透传 → 127.0.0.1:<dshPort>(DSH WebServer)
//
// 自动同步端口：frpc 启动前先查 API，若面板里该隧道的 local_port ≠ gatePort，
// 先 POST /tunnel/edit 改成 gatePort，再拉起 frpc —— 根治「隧道成功但 502」。

import { createServer } from 'node:http'
import { readFileSync, mkdirSync, writeFileSync, rmSync, existsSync, rmdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'

import { createClient, ApiError } from './natfrp.mjs'
import { createFrpcManager } from './frpc.mjs'
import { createPasswordGate, createGateServer } from './gate.mjs'
import { installFrpc, checkInstalled } from './installer.mjs'
import { resolveDshHome, resolveFrpcPath, displayPath } from './paths.mjs'

export const name = 'natfrp'
export const inject = ['credentials', 'webServer', 'timer', 'connection']

// ⚠️ 同样不能直接用 process.env.DSH_HOME：空白串会让 join 出相对路径，
//    状态文件就落到当前工作目录里了。统一走 resolveDshHome。
const DSH_HOME = resolveDshHome()
// 目录名与包名一致（dsh-sakurafrp）。旧版用 dsh-natfrp，下面做一次性迁移。
const DATA_DIR = join(DSH_HOME, 'dsh-sakurafrp')
const LEGACY_DATA_DIR = join(DSH_HOME, 'dsh-natfrp')
const STATE_PATH = join(DATA_DIR, 'state.json')
const PASSWORD_FILE = join(DATA_DIR, 'gate-password.txt')

/**
 * 一次性迁移旧状态目录（包名从 dsh-natfrp 改为 dsh-sakurafrp）。
 *
 * ⚠️ 用「复制」而不是 rename：旧包可能仍被安装着，rename 会把它的状态目录搬走，
 *    让它下一轮读不到 state.json 与网关密码。
 * 只在「新目录没有 state.json、旧目录有」时动作；失败静默（退化为首次使用）。
 */
function migrateLegacyDataDir() {
  try {
    if (existsSync(STATE_PATH)) return // 新位置已有状态，不覆盖
    if (!existsSync(LEGACY_DATA_DIR)) return
    let copied = 0
    mkdirSync(DATA_DIR, { recursive: true })
    for (const file of ['state.json', 'gate-password.txt']) {
      const from = join(LEGACY_DATA_DIR, file)
      if (!existsSync(from)) continue
      try {
        writeFileSync(join(DATA_DIR, file), readFileSync(from), { mode: 0o600 })
        copied += 1
      } catch { /* 单文件失败不影响其它 */ }
    }
    if (copied === 0) {
      try { rmdirSync(DATA_DIR) } catch { /* 不留空目录，避免下次误判已迁移 */ }
    }
  } catch { /* 权限/IO 问题 —— 退化为重新配置 */ }
}
migrateLegacyDataDir()

function safeRead(p) {
  if (!p) return ''
  try { return readFileSync(p, 'utf8').trim() } catch { return '' }
}

function readState() {
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')) ?? {} } catch { return {} }
}

/**
 * 写入状态文件。
 * ⚠️ 采用「合并」语义：调用方只需传要改的键，其余键保留。
 *    原先整对象覆盖，每加一个新字段就得改所有调用点，漏一个就静默丢配置。
 * @param {object} patch 要写入的键
 * @param {string[]} remove 要显式删除的键（合并语义下无法用 undefined 表达删除）
 */
function writeState(patch, remove = []) {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true })
    const merged = { ...readState(), ...patch }
    for (const k of remove) delete merged[k]
    writeFileSync(STATE_PATH, JSON.stringify(merged, null, 2), { mode: 0o600 })
    return merged
  } catch {
    return null // 持久化失败不致命
  }
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger?.(name) ?? console
  const logInfo = (...a) => (logger.info ?? logger.log).call(logger, ...a)
  const logWarn = (...a) => logger.warn(...a)
  const logError = (...a) => logger.error(...a)

  // ---------- 配置与状态 ----------

  const state = readState()
  // frpc 路径三层回退：config.frpcPath → $DSH_HOME/bin → ~/.dsh/bin
  // ⚠️ 不能硬编码 ~/.dsh：DSH 装在便携位置或设了 $DSH_HOME 时，写错目录会让插件永远找不到 frpc。
  const frpcResolved = resolveFrpcPath({ configured: config.frpcPath })
  const cfg = {
    frpcPath: frpcResolved.path,
    frpcPathSource: frpcResolved.source,
    tokenFile: String(config.tokenFile || '').trim(),
    tokenRef: String(config.tokenRef || 'NATFRP_TOKEN'),
    maxLogLines: Number(config.maxLogLines) || 500,
    autoAlign: config.autoAlign !== false,
    dshPort: Number(config.dshPort) || 0,
    /**
     * 网关监听地址。
     *
     * ⚠️ 默认 127.0.0.1 而不是 0.0.0.0：frpc 与本插件跑在同一台机器上，
     *    公网流量是 frpc → 127.0.0.1:gatePort 进来的，网关根本不需要对局域网监听。
     *    监听 0.0.0.0 等于把「绕过密码门的第二条入口」开到整个网段。
     *    确实需要局域网直连的用户可以显式配置 gateHost: '0.0.0.0'。
     */
    gateHost: String(config.gateHost || '').trim() || '127.0.0.1',
  }

  /**
   * 总开关的初始值。
   *
   * ⚠️ 默认关闭：这个插件的作用是把 DSH 暴露到公网，装上就应该先关着，
   *    由用户在确认端口、密码、隧道之后主动打开。以前默认 true，
   *    等于「装上那一刻起，公网就能访问（只要密码也配了）」。
   *    只有两种情况下才是开的：state.json 里记录了用户自己开过，
   *    或者配置文件显式写了 enabled: true。
   */
  let enabled = typeof state.enabled === 'boolean' ? state.enabled : config.enabled === true
  let tunnelId = String(state.tunnelId ?? config.tunnelId ?? '').trim()

  /**
   * 本机端口。
   *
   * ⚠️ 新装时为 null（不是 3083）。
   *    预填一个数字等于替用户做了三个决定：用这个端口、这个端口现在空闲、这个端口
   *    就是要写进隧道里的那个。三者都可能不成立，而用户看到有值就会直接点保存，
   *    然后把「外网打不开」怪到插件头上。留空则必须自己填，填的时候会当场检测占用。
   *    null 也意味着「网关还没起」——状态栏会明说「端口未设置」，而不是显示一个假端口。
   */
  const parsePort = (v) => {
    const n = Number(v)
    return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : null
  }
  // state 里存在这个键就以它为准（哪怕值是 null = 用户主动清空），
  // 不能被 config 里的默认值"复活"回来。
  let gatePort = 'gatePort' in state ? parsePort(state.gatePort) : parsePort(config.gatePort)

  /**
   * 用户叉掉过的「问题指纹」。
   *
   * 为什么存指纹而不是一个 boolean：
   *   如果只记「dismissed: true」，那么叉掉之后即使 frpc 被删了、换机器了、
   *   版本坏了，也永远不会再提醒 —— 这就变成"关掉后再也发现不了问题"。
   * 指纹 = 问题类型 + 关键上下文（如路径）。问题变了指纹就变，卡片自然重新出现。
   */
  let dismissedFingerprints = Array.isArray(state.dismissedFrpcPrompts) ? state.dismissedFrpcPrompts : []

  function fingerprintOf(problem) {
    // 同一类问题 + 同一路径才算"同一个问题"
    return `${problem.kind}::${cfg.frpcPath}`
  }

  function isDismissed(problem) {
    return dismissedFingerprints.includes(fingerprintOf(problem))
  }

  function dismiss(problem) {
    const fp = fingerprintOf(problem)
    if (dismissedFingerprints.includes(fp)) return dismissedFingerprints
    // 只保留最近 8 条，避免状态文件无限增长
    dismissedFingerprints = [...dismissedFingerprints, fp].slice(-8)
    writeState({ dismissedFrpcPrompts: dismissedFingerprints })
    return dismissedFingerprints
  }

  function undismissAll() {
    dismissedFingerprints = []
    writeState({ dismissedFrpcPrompts: [] })
  }

  /**
   * 已被用户确认过的「安装成功」结果时间点。
   *
   * 为什么需要落盘：
   *   installResult 只存在内存里，而成功卡片有 8 秒自动收起 —— 收起只是本地 state，
   *   组件重新挂载（关掉设置再打开）就复活了。用户点叉也一样，因为叉只写本地。
   *   结果就是「frpc 安装成功」这条一次性消息每次进设置都弹一遍，永远关不掉。
   *
   * 为什么存时间戳而不是一个 boolean：
   *   frpc 后来坏了、重新下载又成功，这是一次新的成功事件，理应再提示一次。
   *   `installResult.at > successAckAt` 正好能区分「旧消息」和「新消息」。
   */
  let successAckAt = Number(state.frpcSuccessAckAt) || 0

  function ackSuccessResult(at) {
    const when = Number(at) || 0
    if (when > successAckAt) {
      successAckAt = when
      writeState({ frpcSuccessAckAt: successAckAt })
    }
    return successAckAt
  }
  // 兼容旧版：早期把密码写进了 state.json，这里仍优先读它；新版不再写入。
  let gatePassword = String(state.gatePassword ?? '') || safeRead(PASSWORD_FILE) || String(config.gatePassword ?? '')

  /**
   * DSH WebServer 端口。
   *
   * ⚠️ 必须每次现取，不能 apply 时求值存常量：
   *    webServer.port 的 getter 在 listen 之前返回 undefined，若此刻取不到就会
   *    固化成 cfg.dshPort（通常 0），而网关 upstream 是启动时定死的 ——
   *    之后 DSH 真正监听上来了，网关仍然把请求转发到 0 端口，全部 502。
   */
  const dshPortNow = () => Number(ctx.webServer?.port) || cfg.dshPort || 0

  /**
   * token 的「可写回退位置」。
   *
   * 真实场景：配置里的 tokenFile 若是管理员创建的，普通账号只有读权限，
   * 保存密钥会 EPERM。与其让用户去改 ACL，不如把密钥存到插件自己的状态目录
   * （那里一定可写），并优先读最新写入的那个。
   */
  const FALLBACK_TOKEN_FILE = join(DATA_DIR, 'token.txt')

  /** 按「最近修改时间」挑出应该优先读的 token 文件。 */
  function tokenFilePath() {
    const candidates = [cfg.tokenFile, FALLBACK_TOKEN_FILE].filter(Boolean)
    let best = null
    let bestTime = -1
    for (const p of candidates) {
      try {
        const st = statSync(p)
        if (st.isFile() && st.size > 0 && st.mtimeMs > bestTime) {
          bestTime = st.mtimeMs
          best = p
        }
      } catch { /* 不存在就跳过 */ }
    }
    return best ?? cfg.tokenFile
  }

  /**
   * 从 DSH 凭据库解析出的密钥，缓存在内存里供同步调用方使用。
   *
   * 为什么必须有这个缓存：
   *   frpc 的 `getToken` 是**同步**接口（子进程 spawn 前就要拿到值），
   *   而 `ctx.credentials.resolve()` 是**异步**的，两者无法直接对接。
   *   之前 tokenNow() 只读本地文件，于是「密钥只存在 DSH 凭据库」的用户
   *   永远起不来 frpc：
   *     startAll() 里 await resolveToken() 明明拿到了密钥（能过判空、能调 API），
   *     紧接着 frpc.start() 调 tokenNow() 却返回空 → `start 拒绝: no-token`。
   *   同一个函数里上一步有、下一步没有，就是这个断点。
   */
  let resolvedTokenCache = ''

  function tokenNow() {
    const fromFile = safeRead(tokenFilePath())
    if (fromFile) return fromFile // 文件优先（显式配置的最高优先级）
    return resolvedTokenCache
  }

  async function resolveToken() {
    // 这里刻意不复用 tokenNow()：它可能返回缓存，而缓存正是要被刷新的对象。
    // 每次重新读文件 / 问凭据库，用户改了密钥才能立刻生效。
    const fromFile = safeRead(tokenFilePath())
    if (fromFile) return fromFile
    try {
      const r = await ctx.credentials?.resolve?.(cfg.tokenRef)
      const value = !r ? '' : (typeof r === 'string' ? r : (r.value ?? r.secret ?? ''))
      resolvedTokenCache = value || ''
      return value || ''
    } catch (e) {
      logError(`natfrp: credentials resolve 失败: ${e?.message ?? e}`)
      resolvedTokenCache = ''
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

  /**
   * 让隧道连到插件正在监听的端口。
   *
   * 面板里那条隧道有个「本地端口」，frpc 会把公网流量转到这里。
   * 它和 gatePort 不一致 = 公网访问必然失败，所以在拉起 frpc 前先对齐。
   *
   * ⚠️ 返回值字段仍叫 aligned（内部/接口层沿用），但界的文案不再用「对齐」二字。
   */
  async function autoAlign(api) {
    if (!cfg.autoAlign || !api || !tunnelId) return { skipped: true }
    if (!gatePort) return { skipped: true, reason: '本机端口还没填' }
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
      logInfo(`natfrp: 已把隧道 ${tunnelId} 的端口从 ${tn.local_port} 改成 ${gatePort}`)
      return { aligned: true, changed: true, from: Number(tn.local_port), to: gatePort }
    } catch (e) {
      lastApiError = e instanceof ApiError ? e.message : String(e?.message ?? e)
      logWarn(`natfrp: 改隧道端口失败: ${lastApiError}`)
      return { aligned: false, error: lastApiError }
    }
  }

  async function startAll(reason = '') {
    if (!enabled) return
    if (!gatePort) {
      // 没端口就没有网关，frpc 连上来也是 502 —— 不如不启动，并说清缺什么
      logWarn('natfrp: 本机端口未设置，先填端口再开启')
      frpc.note('未启动：本机端口未设置')
      return
    }
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
      if (report.error) logWarn(`natfrp: 隧道端口检查失败: ${JSON.stringify(report)}`)
      frpc.note(`隧道端口: ${JSON.stringify(report)}`)
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
      host: cfg.gateHost,
      // port 传函数：gate.mjs 每次请求现取，避免把启动瞬间的 undefined 固化成 0
      upstream: { host: '127.0.0.1', port: dshPortNow },
      launchToken: () => {
        try {
          const conn = ctx.connection
          if (!conn || typeof conn.authenticatedUrl !== 'function') return ''
          const target = dshPortNow()
          if (!target) return ''
          const u = new URL(conn.authenticatedUrl(`http://127.0.0.1:${target}`))
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
        // DSH 还没监听（或端口未知）时明确报错，而不是转到 0 端口拿一个看不懂的 502
        if (!dshPortNow()) {
          if (opts.upgrade) {
            try { res?.destroy?.() } catch { /* noop */ }
            return true
          }
          res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
          res.end('DSH WebServer 尚未就绪，请稍后重试')
          return true
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
        // 其余全部走密码门（未配置密码时 gate 直接拒绝，不会放行）
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
    logInfo(`natfrp: 网关 ${cfg.gateHost}:${info.port} → dsh :${dshPortNow()}` +
      `${gatePassword ? ' (密码门已启用)' : ' (⚠ 未设密码：公网请求将被拒绝)'}`)
    return info.port
  }

  async function restartGate(port) {
    if (gateServer) await gateServer.close().catch(() => {})
    gateServer = null
    actualGatePort = null
    return startGate(port)
  }

  /** 把网关停在「没端口」的状态（端口被清空 / 回退失败时用）。 */
  async function closeGate() {
    if (gateServer) await gateServer.close().catch(() => {})
    gateServer = null
    actualGatePort = null
  }

  /** 端口 → 想要的监听状态：null 就是关掉，别拿 0 / undefined 去 listen。 */
  async function applyGatePort(p) {
    if (!p) { await closeGate(); return }
    await restartGate(p)
  }

  /**
   * 检测「这个端口本机现在能不能占」。
   *
   * 做法是往 127.0.0.1 上真的试绑一次，绑上就立刻关掉。为什么不只用 connect 探测：
   *   connect 成功只能说明"有人在听"，分不清是别的程序还是本插件自己的网关。
   * 这里额外处理了「就是我自己在听」这一种，避免用户改回当前端口时被误报占用。
   *
   * 返回 { available:boolean, reason?:'occupied'|'bad-port'|'EACCES'…, self?:true }
   */
  function checkPortFree(port) {
    const p = Number(port)
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      return Promise.resolve({ available: false, reason: 'bad-port' })
    }
    // 当前网关正听着这个端口 —— 那是自己，不是冲突
    if (gateServer?.listening && Number(actualGatePort) === p) {
      return Promise.resolve({ available: true, self: true })
    }
    return new Promise((resolve) => {
      const srv = createServer()
      let done = false
      const finish = (r) => { if (!done) { done = true; resolve(r) } }
      srv.once('error', (e) => {
        const code = String(e?.code ?? '')
        finish({ available: false, reason: code === 'EADDRINUSE' ? 'occupied' : (code || 'listen-failed') })
      })
      srv.once('listening', () => {
        srv.close(() => finish({ available: true }))
      })
      try {
        // 只测回环：网关默认也只监听回环，用 0.0.0.0 试绑会误报「被占用」
        srv.listen(p, '127.0.0.1')
      } catch (e) {
        finish({ available: false, reason: String(e?.code ?? e) })
      }
    })
  }

  /**
   * 选定隧道后，让**本机端口跟随隧道端口**。
   *
   * 方向与 autoAlign 相反，两者别混：
   *   autoAlign       本地是权威：用户手填了端口 → 把面板那条隧道改成一致
   *   adoptTunnelPort 面板是权威：用户只是选了一条隧道 → 本机端口跟着它走
   *
   * 为什么需要后者：用户从下拉里挑一条已有隧道时，他并没有表达"我要用哪个端口"，
   * 只表达了"我要这条隧道"。这时把本机端口改成隧道里写着的数字，两边天然一致，
   * 不用再点一次「把隧道端口改成 X」。
   *
   * 隧道端口在本机被别的程序占着时没法跟随，退回 autoAlign（改面板），
   * 否则用户只能自己去面板里改数字。
   */
  async function adoptTunnelPort(api) {
    if (!api || !tunnelId) return { skipped: true }
    try {
      const list = await api.tunnels()
      const tn = Array.isArray(list) ? list.find((t) => String(t.id) === tunnelId) : null
      if (!tn) return { skipped: true, reason: `面板上没有隧道 ${tunnelId}` }
      lastTunnelInfo = tn
      const target = Number(tn.local_port)
      if (!Number.isFinite(target) || target <= 0) return { skipped: true, reason: '这条隧道没填本地端口' }
      if (target === gatePort) return { already: true, port: target }
      const free = await checkPortFree(target)
      if (!free.available) {
        const report = await autoAlign(api)
        return { ...report, direction: 'to-panel', blockedPort: target }
      }
      const from = gatePort
      gatePort = target
      try {
        await restartGate(target)
      } catch (e) {
        gatePort = from
        try { await applyGatePort(from) } catch { /* 已在 startGate 里报错 */ }
        return { error: `端口 ${target} 起不来：${e?.message ?? e}` }
      }
      logInfo(`natfrp: 本机端口已跟随隧道 ${tunnelId} 改成 ${target}（原来是 ${from}）`)
      return { changed: true, direction: 'to-local', from, to: target }
    } catch (e) {
      lastApiError = e instanceof ApiError ? e.message : String(e?.message ?? e)
      logWarn(`natfrp: 读取隧道端口失败: ${lastApiError}`)
      return { error: lastApiError }
    }
  }

  // ---------- 管理路由（/natfrp/*，双挂：网关 + DSH webServer） ----------

  function readBody(req, limit = 16384) {
    return new Promise((resolve) => {
      let body = ''
      let done = false
      const finish = () => { if (!done) { done = true; resolve(body) } }
      req.on('data', (c) => { body += c; if (body.length > limit) req.destroy() })
      req.on('end', finish)
      req.on('error', finish)
      // destroy() 之后不一定触发 error，'close' 兜底，避免请求处理永久挂起
      req.on('close', finish)
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
    return `http://127.0.0.1:${dshPortNow()}`
  }

  // ---------- frpc 存在性检测与一键安装 ----------
  //
  // 为什么不每次快照都探测：checkInstalled 会 spawn 一个子进程跑 `-V`，
  // 而快照每 4 秒被拉一次。改为命中缓存，只在以下时机刷新：
  //   · 插件启动时
  //   · 安装完成后
  //   · 前端显式请求 /natfrp/api/frpc/check
  let frpcPresence = { present: false }
  let installProgress = null // { phase, received, total } 或 null
  let installing = false
  let installWritable = null // null=未检测, true/false
  // 最近一次安装的结果：{ at, ok, version?, bytes?, error? }
  // 前端靠它显示"成功/失败"，否则装完界面静默恢复原样，用户毫无反馈。
  let installResult = null

  /**
   * 预检目标目录是否可写。
   * 用户可能把 DSH 装在 Program Files 这类只读位置 → 写 bin/ 会失败。
   * 与其让用户点了按钮才看到 EACCES，不如提前告诉他，并给出手动方案。
   */
  function probeWritable(destPath) {
    const dir = dirname(destPath)
    try {
      mkdirSync(dir, { recursive: true })
      const probe = join(dir, `.write-probe-${process.pid}-${Date.now()}`)
      writeFileSync(probe, 'x')
      rmSync(probe, { force: true })
      return true
    } catch {
      return false
    }
  }

  async function refreshFrpcPresence() {
    try {
      frpcPresence = await checkInstalled(cfg.frpcPath)
    } catch (err) {
      frpcPresence = { present: false, error: String(err?.message ?? err) }
    }
    // 只有「没装好」时才算可写性，已装好就不必探测（省一次磁盘写）
    if (!frpcPresence.present || frpcPresence.ok === false) {
      installWritable = probeWritable(cfg.frpcPath)
    } else {
      installWritable = null
    }
    return frpcPresence
  }

  async function snapshot(originBase = '') {
    const token = tokenNow()
    // 有 token 且上次 API 调用没报错，才算「接口可用」——
    // 只判 Boolean(token) 是名不副实，密钥填错时仍然显示可用。
    const apiOk = Boolean(token) && !lastApiError
    return {
      enabled,
      tunnelId,
      gatePort: actualGatePort ?? gatePort,
      gateRunning: Boolean(gateServer?.listening),
      gatePasswordConfigured: Boolean(gatePassword),
      tokenConfigured: Boolean(token),
      tokenFile: cfg.tokenFile,
      autoAlign: cfg.autoAlign,
      dshPort: dshPortNow(),
      frpc: frpc.snapshot(),
      tunnelInfo: lastTunnelInfo,
      apiOk,
      apiError: lastApiError || undefined,
      // 绝对化的日志地址：桌面端内置浏览器/外部浏览器都无法解析相对路径，
      // 客户端拿不到 webServer 服务，所以必须由服务端按实际请求来源拼出来。
      logsUrl: `${originBase}/natfrp/api/logs`,
      // 一键安装 frpc 的状态（缓存，避免每次快照都 spawn 子进程探版本）
      frpcInstall: {
        path: cfg.frpcPath,
        // 面向用户的显示路径：默认位置显示 ~/.dsh/...，自定义位置才显示绝对路径
        displayPath: displayPath(cfg.frpcPath, frpcResolved.home),
        pathSource: cfg.frpcPathSource,
        homeSource: frpcResolved.homeSource,
        writable: installWritable,
        ...frpcPresence,
        progress: installProgress,
        // acknowledged = 这条结果用户已经看过并关掉了（跨会话有效，见 successAckAt）
        lastResult: installResult
          ? { ...installResult, acknowledged: Number(installResult.at) <= successAckAt }
          : null,
        // 当前问题的类型（用于指纹比对）与是否已被用户叉掉
        problemKind: currentProblemKind(),
        dismissed: isDismissed({ kind: currentProblemKind() }),
      },
    }
  }

  /**
   * 归类当前 frpc 的问题。
   * 只有类型变化（例如从「未安装」变成「版本不对」）才算新问题，卡片才会重新出现。
   */
  function currentProblemKind() {
    if (installProgress) return 'installing'
    if (!frpcPresence.present) return 'missing'
    if (frpcPresence.ok === false) return 'invalid'
    return 'ok'
  }

/**
 * 把底层写文件错误翻译成用户能照做的提示。
 *
 * 典型场景（真实遇到过）：文件是管理员创建的，普通用户只有读权限，
 * writeFileSync 抛 EPERM。原始信息是
 *   "EPERM: operation not permitted, open '<tokenFile>'"
 * 用户看到完全不知道该怎么办。
 */
function diagnoseWriteFailure(path, err) {
  const code = err?.code ?? ''
  const dir = dirname(path)
  const base = { path, dir, code }

  if (code === 'EPERM' || code === 'EACCES') {
    // 进一步区分：目录可写吗？文件属主是谁？
    let ownerNote = ''
    try {
      const st = statSync(path)
      ownerNote = `（当前文件属主可能不是你的账号，属主 UID ${st.uid}）`
    } catch { /* 拿不到就算了 */ }

    return {
      ...base,
      message: `没有写入权限：${path}`,
      hint:
        `该文件可能是管理员创建的，普通账号只能读。解决办法（任选其一）：\n` +
        `① 以管理员身份运行 PowerShell，执行：\n` +
        `   takeown /f "${path}"\n` +
        `   icacls "${path}" /grant "%USERNAME%:F"\n` +
        `② 或者直接删除它，让插件重新创建（会用你的账号，权限自然正确）：\n` +
        `   Remove-Item "${path}" -Force\n` +
        `③ 或在 cordis.patch.yml 里把 tokenFile 指到你有写权限的位置。${ownerNote}`,
    }
  }

  if (code === 'ENOENT') {
    return {
      ...base,
      message: `目标目录不存在：${dir}`,
      hint: `请确认 ${dir} 可创建，或在配置里把 tokenFile 指到已存在的目录。`,
    }
  }

  if (code === 'ENOSPC') {
    return { ...base, message: '磁盘空间不足', hint: `请清理 ${dir} 所在磁盘。` }
  }

  return {
    ...base,
    message: `写入失败：${String(err?.message ?? err)}`,
    hint: `请检查 ${path} 的权限与所在磁盘状态。`,
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

    /**
     * 可用节点 —— 新建隧道时给用户挑。
     *
     * 筛选口径：
     *   flag & 1<<9   → 离线，剔除（离线节点建了也连不上）
     *   vip > 0       → 付费节点，免费账号建上去会被服务端拒绝，剔除
     * 注意**不再**按 flag & 0b100（允许创建）过滤：满载节点也要列出来，
     * 否则用户看到的是"只剩三个节点"，不知道其它节点是满载而不是不存在。
     * 满载节点由界面置灰并标注，不给点。
     *
     * 负载来自 /node/stats（官方只在那里给 load 百分比），
     * 拉不到就整列 load = -1，界面显示「未知」，不影响选节点。
     */
    if (path === '/natfrp/api/nodes' && req.method === 'GET') {
      const token = await resolveToken()
      const api = apiOrNull(token)
      if (!api) { json(res, 400, { error: 'no-token' }); return true }
      try {
        const [all, stats] = await Promise.all([
          api.nodes(),
          api.nodeStats().catch(() => null),
        ])
        const loadOf = new Map()
        for (const n of (stats?.nodes ?? [])) {
          const id = Number(n?.id)
          if (Number.isFinite(id)) loadOf.set(id, n)
        }
        const list = Object.entries(all ?? {})
          .map(([id, n]) => ({ id: Number(id), ...n }))
          .filter((n) => Number.isFinite(n.id) && n.id > 0)
          .filter((n) => (Number(n.flag) & (1 << 9)) === 0)
          .filter((n) => !Number(n.vip))
          .map((n) => {
            const st = loadOf.get(n.id)
            // online: -1 离线、>=0 在线；没有 stats 时按 flag 判断（已剔除离线 flag）
            const online = st ? Number(st.online) >= 0 : true
            const load = st && Number.isFinite(Number(st.load)) ? Number(st.load) : -1
            return {
              id: n.id,
              name: String(n.name ?? `节点 ${n.id}`),
              host: String(n.host ?? ''),
              mainland: (Number(n.flag) & (1 << 3)) !== 0,
              description: String(n.description ?? ''),
              // 官方「允许创建」位：满载时为 0。界面据此置灰，不据此隐藏
              createAllowed: (Number(n.flag) & 0b100) !== 0,
              online,
              load,
            }
          })
          // 能建的排前面 → 内地优先（延迟低）→ 负载低的优先 → id 稳定排序
          .sort((a, b) => Number(b.createAllowed) - Number(a.createAllowed)
            || Number(b.mainland) - Number(a.mainland)
            || ((a.load < 0 ? 999 : a.load) - (b.load < 0 ? 999 : b.load))
            || a.id - b.id)
        json(res, 200, { nodes: list, statsTime: stats?.time ?? null })
      } catch (e) {
        json(res, 502, { error: 'api-failed', message: e instanceof ApiError ? e.message : String(e?.message ?? e) })
      }
      return true
    }

    /** 端口可用性检测：界面填端口时就给出结论，别等保存后才报错。 */
    if (path === '/natfrp/api/port/check' && req.method === 'GET') {
      let raw = ''
      try { raw = new URLSearchParams(String(req.url ?? '').split('?')[1] ?? '').get('port') ?? '' } catch { /* noop */ }
      const p = Number(raw)
      if (!Number.isInteger(p) || p < 1 || p > 65535) {
        json(res, 400, { error: 'bad-port', message: '端口要是 1024–65535 之间的整数', port: raw })
        return true
      }
      const r = await checkPortFree(p)
      json(res, 200, { port: p, inRange: p >= 1024 && p <= 65535, ...r })
      return true
    }

    /**
     * 新建隧道。
     *
     * 只建 TCP：本地端口固定指向本插件，远程端口交给官方自动分配。
     * 不建 HTTP(S) —— 那要求用户先有域名并配好 CNAME 解析，新手必然卡在这一步；
     * 想要域名/证书可以之后在管理面板补「子域绑定」。
     */
    if (path === '/natfrp/api/tunnel/create' && req.method === 'POST') {
      const token = await resolveToken()
      const api = apiOrNull(token)
      if (!api) { json(res, 400, { error: 'no-token' }); return true }
      const raw = await readBody(req)
      let patch
      try { patch = JSON.parse(raw || '{}') } catch { json(res, 400, { error: 'invalid-json' }); return true }

      const name = String(patch.name ?? '').trim() || 'DSH'
      const node = Number(patch.node)
      if (!Number.isInteger(node) || node <= 0) { json(res, 400, { error: 'bad-node' }); return true }

      /**
       * 自动 HTTPS：官方把它放在隧道的 `extra`（自定义配置）里，取值 auto / on / off。
       * 默认 auto —— 和官方面板新建隧道时的默认值一致；禁用会让 http(s) 隧道拿不到证书。
       * TCP 隧道用不上这一项（没有域名可签），但照旧写进去：将来切成 http 类型时
       * 不必回头改，官方也只会原样存着。
       */
      const autoHttps = ['auto', 'on', 'off'].includes(String(patch.autoHttps))
        ? String(patch.autoHttps)
        : 'auto'
      const extra = `auto_https = ${autoHttps}`

      /**
       * 端口：新建表单里填的那个数同时作为「本机端口」和「隧道本地端口」。
       * 不填就沿用当前本机端口 —— 让"建隧道"和"设端口"是一件事，而不是两步。
       * 本机端口还没设过时就没有"当前值"可沿用，必须让用户先填一个。
       */
      const wantPort = patch.port === undefined || patch.port === '' || patch.port === null
        ? gatePort
        : Number(patch.port)
      if (wantPort === null || wantPort === undefined) {
        json(res, 400, {
          error: 'no-port',
          message: '先填一个本机端口（比如 3083），隧道才知道往哪转发',
        })
        return true
      }
      if (!Number.isInteger(wantPort) || wantPort < 1024 || wantPort > 65535) {
        json(res, 400, { error: 'bad-port', message: '端口要是 1024–65535 之间的整数', port: patch.port })
        return true
      }
      if (wantPort !== gatePort) {
        const free = await checkPortFree(wantPort)
        if (!free.available) {
          json(res, 409, {
            error: 'port-in-use',
            message: free.reason === 'occupied'
              ? `端口 ${wantPort} 已被其它程序占用，换一个吧`
              : `端口 ${wantPort} 用不了（${free.reason}）`,
            port: wantPort,
          })
          return true
        }
        const from = gatePort
        gatePort = wantPort
        try {
          await restartGate(wantPort)
        } catch (e) {
          gatePort = from
          try { await applyGatePort(from) } catch { /* 已报错 */ }
          json(res, 409, {
            error: 'port-listen-failed',
            message: `端口 ${wantPort} 切换失败：${e?.message ?? e}`,
            port: from,
          })
          return true
        }
        frpc.stop()
      }

      // extra 被官方拒掉、降级重试过的话记一下，响应里告诉前端
      let autoHttpsDropped = false
      try {
        const payload = {
          name: name.slice(0, 24),
          type: 'tcp',
          node,
          local_ip: '127.0.0.1',
          local_port: gatePort,
          note: '由 dsh-sakurafrp 创建',
          extra,
        }
        let created
        try {
          created = await api.tunnelCreate(payload)
        } catch (e) {
          /**
           * 兜底：extra 里的配置项是「按隧道类型各自支持」的，万一官方的 TCP 隧道
           * 不认 auto_https 而直接报错，不能因为一个可选配置就让用户建不出隧道 ——
           * 去掉 extra 再试一次，成功后把原因说清楚。
           */
          if (!/extra|auto_https|invalid/i.test(String(e?.message ?? e))) throw e
          logWarn(`natfrp: 带 extra 创建失败（${e?.message ?? e}），去掉 extra 重试`)
          const { extra: _drop, ...bare } = payload
          created = await api.tunnelCreate(bare)
          autoHttpsDropped = true
        }
        const id = created?.id
        if (!id) {
          json(res, 502, { error: 'api-failed', message: '官方返回成功但没给隧道 ID' })
          return true
        }
        logInfo(`natfrp: 已创建隧道 ${id} ${created?.name ?? name} (node=${node}, local=127.0.0.1:${gatePort})`)
        // 建完直接设为当前隧道 —— 用户刚点完「新建」，不该再让他去下拉里找一遍
        tunnelId = String(id)
        writeState({ enabled, tunnelId, gatePort })
        if (enabled) {
          frpc.stop()
          void startAll('tunnel created')
        }
        json(res, 200, {
          ok: true,
          id,
          name: created?.name ?? name,
          remote: created?.remote ?? null,
          port: gatePort,
          // 官方可能在响应里塞限制说明（节点规则、配额等），有就必须让用户看到
          warning: created?.important_warning_for_ai ?? null,
          // true = 官方不认 auto_https，已降级成不带该配置创建
          autoHttpsDropped,
        })
      } catch (e) {
        const msg = e instanceof ApiError ? e.message : String(e?.message ?? e)
        logWarn(`natfrp: 创建隧道失败: ${msg}`)
        json(res, 502, { error: 'api-failed', message: msg })
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
      // ⚠️ 不把 gatePassword 写进 state.json：该文件常被备份 / 同步 / 其它插件读取，
      //    密码只落 gate-password.txt（0600）。
      writeState({ enabled, tunnelId, gatePort })
      void startAll('manual start')
      json(res, 200, await snapshot(originOf(req)))
      return true
    }

    if (path === '/natfrp/api/stop' && req.method === 'POST') {
      enabled = false
      frpc.stop()
      // ⚠️ 不把 gatePassword 写进 state.json：该文件常被备份 / 同步 / 其它插件读取，
      //    密码只落 gate-password.txt（0600）。
      writeState({ enabled, tunnelId, gatePort })
      logInfo('natfrp: 已手动停止')
      json(res, 200, await snapshot(originOf(req)))
      return true
    }

    // ---------- frpc 检测 / 一键安装 ----------

    if (path === '/natfrp/api/frpc/check' && req.method === 'GET') {
      json(res, 200, { path: cfg.frpcPath, ...(await refreshFrpcPresence()) })
      return true
    }

    // 叉掉提示：记住「这个问题已被忽略」，问题类型或路径变化后会自动重新出现
    if (path === '/natfrp/api/frpc/dismiss' && req.method === 'POST') {
      const kind = currentProblemKind()
      dismiss({ kind })
      json(res, 200, { dismissed: true, kind, fingerprints: dismissedFingerprints })
      return true
    }

    // 取消忽略（设置页「恢复提示」用，也方便用户改主意）
    if (path === '/natfrp/api/frpc/undismiss' && req.method === 'POST') {
      undismissAll()
      json(res, 200, { dismissed: false, fingerprints: [] })
      return true
    }

    // 确认「安装成功」提示：落盘后本次及以后都不再显示，
    // 直到 frpc 再次出问题并重新安装成功（产生新的 at）才会重新出现。
    if (path === '/natfrp/api/frpc/ack-result' && req.method === 'POST') {
      let at = Number(installResult?.at) || 0
      try {
        const raw = await readBody(req, 4096)
        const wanted = Number(JSON.parse(raw || '{}')?.at)
        // 只接受与当前结果一致的 at，避免前端传错把未来的提示也一起吞掉
        if (Number.isFinite(wanted) && wanted > 0 && wanted === Number(installResult?.at)) at = wanted
      } catch { /* 无 body / 非法 JSON 时用服务端当前结果 */ }
      json(res, 200, { acknowledgedAt: ackSuccessResult(at) })
      return true
    }

    if (path === '/natfrp/api/frpc/install' && req.method === 'POST') {
      if (installing) {
        json(res, 409, { error: 'busy', message: '已有安装任务在进行中' })
        return true
      }
      // 先验可写：只读位置（如 Program Files）重试也无法成功，直接给出手动方案
      if (probeWritable(cfg.frpcPath) === false) {
        installWritable = false
        json(res, 403, {
          error: 'not-writable',
          message: `目标目录不可写：${dirname(cfg.frpcPath)}。请改用手动下载，或在配置里把 frpcPath 指到可写位置。`,
          path: cfg.frpcPath,
        })
        return true
      }
      installWritable = true
      installing = true
      installProgress = { phase: 'checking', received: 0, total: 0 }
      installResult = null
      logInfo('natfrp: 开始一键安装 frpc')

      // 异步执行，路由立刻返回，前端轮询 /state 看进度
      void (async () => {
        try {
          const result = await installFrpc({
            dest: cfg.frpcPath,
            onProgress: ({ received, total }) => {
              installProgress = { phase: 'downloading', received, total }
            },
          })
          installProgress = null
          if (result.ok) {
            logInfo(`natfrp: frpc 安装完成 ${result.version ?? ''}`)
            await refreshFrpcPresence()
            // ⚠️ 结果要留给前端读：只写日志的话，界面会静默恢复原样，
            //    用户完全不知道刚才那次安装是成功还是失败。
            installResult = {
              at: Date.now(),
              ok: true,
              version: result.version,
              bytes: result.bytes,
            }
            // 装成功说明「未安装 / 不可用」这个问题已经解决了，把针对同一路径的
            // 旧忽略记录清掉 —— 否则以后 frpc 真出故障时，会因为这里残留的
            // dismissed 指纹而一声不响。
            dismissedFingerprints = dismissedFingerprints.filter(
              (fp) => !String(fp).endsWith(`::${cfg.frpcPath}`),
            )
            writeState({ dismissedFrpcPrompts: dismissedFingerprints })
            // 之前因为没有 frpc 而没启动，现在补上
            if (enabled) void startAll('frpc installed')
          } else {
            logInfo(`natfrp: frpc 安装失败 - ${result.error}`)
            await refreshFrpcPresence()
            installResult = {
              at: Date.now(),
              ok: false,
              error: result.error || '未知错误',
            }
          }
        } catch (err) {
          const msg = String(err?.message ?? err)
          logInfo(`natfrp: frpc 安装异常 - ${msg}`)
          await refreshFrpcPresence()
          installResult = { at: Date.now(), ok: false, error: msg }
        } finally {
          installProgress = null
          installing = false
        }
      })()

      json(res, 202, { started: true, path: cfg.frpcPath })
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
      const prevTunnelId = tunnelId
      let portChanged = false
      /** 端口在「本机 ↔ 面板」之间同步的结果，回给界面显示。 */
      let portSync = null

      if (typeof patch.enabled === 'boolean') enabled = patch.enabled
      if (typeof patch.tunnelId === 'string') tunnelId = patch.tunnelId.trim().replace(/[^0-9]/g, '')
      const tunnelChanged = tunnelId !== prevTunnelId
      if (patch.gatePort !== undefined) {
        // 传空 = 明确要「清掉端口」。清掉后网关就停下，等用户重新填。
        if (patch.gatePort === null || patch.gatePort === '') {
          if (gatePort !== null) {
            portChanged = true
            gatePort = null
          }
        } else {
          const n = Number(patch.gatePort)
          if (!Number.isInteger(n) || n < 1024 || n > 65535) {
            json(res, 400, { error: 'bad-port', message: '端口要是 1024–65535 之间的整数', port: patch.gatePort })
            return true
          }
          if (n !== gatePort) {
            // 换端口前先试绑一次：绑不上就别改，否则网关会停在「没起来」的状态，
            // 而用户只看到一句含糊的失败。
            const free = await checkPortFree(n)
            if (!free.available) {
              json(res, 409, {
                error: 'port-in-use',
                message: free.reason === 'occupied'
                  ? `端口 ${n} 已被其它程序占用，换一个吧（比如 ${n + 1}）`
                  : `端口 ${n} 用不了（${free.reason}）`,
                port: n,
                reason: free.reason,
              })
              return true
            }
            portChanged = true
            gatePort = n
          }
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
      } else if (patch.clearGatePassword === true) {
        // 清密码同时删掉 state.json 里的历史副本，否则下次启动又会被读回来
        gatePassword = ''
        try { rmSync(PASSWORD_FILE, { force: true }) } catch { /* noop */ }
        writeState({}, ['gatePassword'])
        logInfo('natfrp: 访问密码已清除（公网访问将被拒绝）')
      }
      if (typeof patch.token === 'string' && patch.token.trim()) {
        const tokenValue = patch.token.trim()
        if (cfg.tokenFile) {
          // 先试配置的路径；不可写就自动退到插件状态目录（一定可写），
          // 而不是把 EPERM 抛给用户让他去改 ACL。
          let savedTo = null
          let firstErr = null
          try {
            writeFileSync(cfg.tokenFile, tokenValue, { mode: 0o600 })
            savedTo = cfg.tokenFile
          } catch (e) {
            firstErr = e
          }
          if (!savedTo) {
            try {
              mkdirSync(DATA_DIR, { recursive: true })
              writeFileSync(FALLBACK_TOKEN_FILE, tokenValue, { mode: 0o600 })
              savedTo = FALLBACK_TOKEN_FILE
              logInfo(`natfrp: ${cfg.tokenFile} 不可写，密钥已改存 ${FALLBACK_TOKEN_FILE}`)
            } catch (e2) {
              const diag = diagnoseWriteFailure(cfg.tokenFile, firstErr ?? e2)
              json(res, 500, {
                error: 'token-write-failed',
                message: diag.message,
                hint: diag.hint,
                path: cfg.tokenFile,
                code: diag.code,
              })
              return true
            }
          }
        } else {
          try { await ctx.credentials?.set?.(cfg.tokenRef, tokenValue) }
          catch (e) {
            json(res, 500, {
              error: 'credential-set-failed',
              message: String(e?.message ?? e),
              hint: '无法写入 DSH credentials，请检查宿主是否启用了 credentials 服务。',
            })
            return true
          }
        }
      } else if (patch.clearToken === true) {
        // 清除访问密钥：三处都要清，只清一处等于没清。
        //   1) 配置指定的 token 文件  2) 兜底 token.txt  3) DSH 凭据库
        // 凭据服务不一定有 delete（宿主版本差异），退化成写空串同样能让
        // tokenNow() 返回空 —— 表现上都是"没密钥了"。
        try { if (cfg.tokenFile) rmSync(cfg.tokenFile, { force: true }) } catch { /* noop */ }
        try { rmSync(FALLBACK_TOKEN_FILE, { force: true }) } catch { /* noop */ }
        resolvedTokenCache = ''
        try {
          if (typeof ctx.credentials?.delete === 'function') await ctx.credentials.delete(cfg.tokenRef)
          else if (typeof ctx.credentials?.set === 'function') await ctx.credentials.set(cfg.tokenRef, '')
        } catch (e) {
          logWarn(`natfrp: 清除凭据失败: ${e?.message ?? e}`)
        }
        lastTunnelInfo = null
        lastApiError = ''
        logInfo('natfrp: 访问密钥已清除')
      }

      // ⚠️ 不把 gatePassword 写进 state.json：该文件常被备份 / 同步 / 其它插件读取，
      //    密码只落 gate-password.txt（0600）。
      // 端口真的切换：切不过去就退回原端口，否则后面 startAll 会对着没监听的端口拉 frpc
      if (portChanged) {
        try {
          await applyGatePort(gatePort)
        } catch (e) {
          gatePort = prevPort
          portChanged = false
          try { await applyGatePort(prevPort) } catch { /* 已在 startGate 里报错 */ }
          writeState({ enabled, tunnelId, gatePort })
          json(res, 409, {
            error: 'port-listen-failed',
            message: prevPort
              ? `端口切不过去，已退回 ${prevPort}：${e?.message ?? e}`
              : `端口起不来：${e?.message ?? e}`,
            port: gatePort,
          })
          return true
        }
      }

      /**
       * 端口同步方向由「用户改了什么」决定，两个方向别混：
       *   改了端口   → 本机是权威：把面板那条隧道改成一致（autoAlign）
       *   只换了隧道 → 面板是权威：本机端口跟着隧道走（adoptTunnelPort）
       */
      if (tunnelId && (portChanged || tunnelChanged)) {
        const token = await resolveToken()
        const api = apiOrNull(token)
        if (api) {
          portSync = portChanged
            ? { ...(await autoAlign(api)), direction: 'to-panel' }
            : await adoptTunnelPort(api)
        }
      }

      writeState({ enabled, tunnelId, gatePort })
      frpc.note(`配置更新: enabled=${enabled} tunnel=${tunnelId} gate=${gatePort}`)
      logInfo(`natfrp: 配置已更新 (enabled=${enabled} tunnel=${tunnelId} gate=${gatePort})`)

      const needRestartFrpc = portChanged || tunnelChanged || Boolean(portSync?.changed)
      if (needRestartFrpc || patch.clearToken === true) frpc.stop()
      if (enabled && (patch.enabled === true || needRestartFrpc)) {
        void startAll('config updated')
      } else if (patch.enabled === false) {
        frpc.stop()
      }

      json(res, 200, { ...(await snapshot(originOf(req))), portSync })
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

  // 预热密钥缓存：frpc 的 getToken 是同步取值，而凭据库是异步的。
  // 不预热的话，只把密钥存在 DSH 凭据库里的用户会看到「密钥未配置」，
  // 且 startAll 内的 frpc.start 拿不到 token（no-token）。
  void resolveToken().catch(() => { /* 凭据服务不可用时静默，startAll 会再试 */ })

  // 启动时探测一次 frpc 是否就位（供设置页显示"未安装"提示与一键安装按钮）
  void refreshFrpcPresence().then((r) => {
    if (!r.present) logInfo('natfrp: 未检测到 frpc，可在设置页点「一键安装」')
    else if (!r.ok) logInfo(`natfrp: frpc 异常 - ${r.error ?? '版本不符'}`)
  })

  if (gatePort) void startGate(gatePort).catch(() => { /* startGate 已报错 */ })
  else logInfo('natfrp: 本机端口未设置，网关未启动（设置页填端口后启动）')
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
