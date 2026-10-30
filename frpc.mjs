// frpc.mjs — frpc 进程管理器。
//
// 启动方式（实测验证）：不把 token 放进 argv（避免进程列表泄漏），
// 而是通过 NATFRP_TOKEN + NATFRP_TARGET 环境变量（frpc 官方支持，
// 见 doc.natfrp.com/frpc/manual.html「环境变量选项」）。
//
// 互踢检测：同一条隧道被两个客户端连接时，后连的会把先连的踢下线，
// 双方进入「网络波动导致数据连接断开, 正在重试」风暴。这里统计窗口内
// 断线次数，超阈值即判定「疑似互踢」并在状态里暴露，而不是无限重试。

import { spawn as nodeSpawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'

/** 窗口毫秒数与阈值：窗口内断线达到该次数判互踢。 */
const KICK_WINDOW_MS = 30_000
const KICK_THRESHOLD = 6

export function createFrpcManager({
  frpcPath,
  getToken,
  maxLogLines = 500,
  log = () => {},
} = {}) {
  let handle = null
  let generation = 0
  let stopping = false
  let backoffMs = 1000
  let retryTimer = null
  let tunnelUrl = ''
  let tunnelOk = false
  const lines = []
  let disconnectTimes = [] // 互踢检测窗口
  let kickSuspect = false

  function pushLine(text) {
    const s = String(text ?? '').replace(/\s+$/, '')
    if (!s) return
    for (const l of s.split(/\r?\n/)) {
      if (!l.trim()) continue
      lines.push(`[${new Date().toISOString()}] ${l}`)
      if (lines.length > maxLogLines) lines.shift()
    }
  }

  /** 从日志行提取状态。返回 true 表示该行已消费（用于测试钩子，不外露）。 */
  function parseLine(text) {
    if (/隧道启动成功/.test(text)) {
      tunnelOk = true
      backoffMs = 1000
      disconnectTimes = []
      kickSuspect = false
    }
    const m = String(text).match(/使用\s*>>\s*([^\s<]+)\s*<</)
    if (m) {
      // remote 形如 host:port；http/https 隧道没有端口
      tunnelUrl = m[1].includes(':') ? m[1] : `https://${m[1]}`
    }
    if (/网络波动导致数据连接断开|login to server failed/i.test(text)) {
      const now = Date.now()
      disconnectTimes.push(now)
      disconnectTimes = disconnectTimes.filter((t) => now - t < KICK_WINDOW_MS)
      if (disconnectTimes.length >= KICK_THRESHOLD && !kickSuspect) {
        kickSuspect = true
        log(`frpc: 疑似互踢——窗口 ${KICK_WINDOW_MS / 1000}s 内断线 ${disconnectTimes.length} 次。` +
          `请确认 SakuraFrp 启动器 / 其它机器上的 frpc 没有连接同一条隧道。`)
      }
    }
  }

  /** 管理事件同时进缓冲（/natfrp/api/logs 可见）与宿主日志。 */
  function internalLog(msg) {
    pushLine(`[manager] ${msg}`)
    log(msg)
  }

  /** 外部（index.js）向日志缓冲注入管理事件。 */
  function note(text) {
    pushLine(`[natfrp] ${String(text ?? '')}`)
  }

  let lastParams = null // 供退避重启用

  function killCurrent() {
    if (!handle) return
    const victim = handle
    handle = null
    generation++
    try { victim.removeAllListeners?.('exit') } catch { /* noop */ }
    try { victim.kill() } catch { /* noop */ }
  }

  function clearRetry() {
    if (retryTimer) {
      try { clearTimeout(retryTimer) } catch { /* noop */ }
      retryTimer = null
    }
  }

  /**
   * 启动 frpc。resolve 于「进程已拉起」，不等待隧道就绪。
   * @param {{tunnelIds:string[], cwd?:string, extraArgs?:string[]}} opts
   */
  function start({ tunnelIds, cwd, extraArgs = [] }) {
    if (stopping || handle) {
      internalLog(`start 拒绝: ${handle ? 'already-running (pid=' + handle.pid + ')' : 'stopping'}`)
      return { ok: false, reason: 'already-running' }
    }
    if (!tunnelIds.length) {
      internalLog('start 拒绝: no-tunnel')
      return { ok: false, reason: 'no-tunnel' }
    }
    const token = String(getToken?.() ?? '')
    if (!token) {
      internalLog('start 拒绝: no-token')
      return { ok: false, reason: 'no-token' }
    }

    // 文件可达性预检——spawn ENOENT 的报错路径在 Windows 上很难读
    try {
      accessSync(frpcPath, constants.X_OK)
    } catch {
      internalLog(`start 拒绝: frpc-not-found (${frpcPath})`)
      return { ok: false, reason: 'frpc-not-found', detail: frpcPath }
    }

    log(`frpc: starting (tunnels=${tunnelIds.join(',')})`)
    tunnelOk = false
    tunnelUrl = ''
    kickSuspect = false
    disconnectTimes = []

    const myGen = generation
    // ⚠️ 这里不能放 `-n`：它是个需要取值的 flag，extraArgs 为空时就悬在参数末位，
    //    frpc 会以 "flag needs an argument: -n" 立刻退出 —— 表现是启动即闪退、
    //    然后无限退避重启。鉴权走 NATFRP_TOKEN 环境变量，不需要任何 flag。
    const spawned = nodeSpawn(frpcPath, ['--disable_log_color', ...extraArgs], {
      cwd,
      env: {
        ...process.env,
        NATFRP_TOKEN: token,
        NATFRP_TARGET: tunnelIds.join(','),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    handle = spawned
    lastParams = { tunnelIds, cwd, extraArgs }

    // 行缓冲：管道 data 事件的切分点是任意的，一行日志可能被拆成两块，
    // 直接拿 data 块去匹配会让「隧道启动成功」「使用 >> xxx <<」这类关键行漏掉，
    // 表现为隧道明明起来了、侧边栏状态点还是黄。stdout/stderr 各自独立缓冲，避免交错串行。
    const bufs = { out: '', err: '' }
    const makeFeed = (key) => (d) => {
      const text = bufs[key] + String(d)
      const parts = text.split(/\r?\n/)
      bufs[key] = parts.pop() ?? ''
      // 防御：子进程长时间不输出换行时，别让残留缓冲无限增长
      if (bufs[key].length > 64 * 1024) bufs[key] = ''
      for (const line of parts) {
        if (!line.trim()) continue
        pushLine(line)
        parseLine(line)
      }
    }
    spawned.stdout?.on('data', makeFeed('out'))
    spawned.stderr?.on('data', makeFeed('err'))

    spawned.on('error', (e) => {
      pushLine(`spawn error: ${e?.message ?? e}`)
      log(`frpc: spawn error: ${e?.message ?? e}`)
    })

    spawned.on('exit', (code) => {
      if (generation !== myGen || handle !== spawned) return // 已被新一代取代
      handle = null
      pushLine(`frpc exited (code=${code ?? 'unknown'})`)
      if (stopping) return
      log(`frpc: exited (code=${code})，${Math.min(backoffMs, 60000)}ms 后重启`)
      scheduleRetry()
    })
    return { ok: true, pid: spawned.pid }
  }

  function scheduleRetry() {
    clearRetry()
    const d = Math.min(backoffMs, 60000)
    backoffMs = Math.min(d * 2, 60000)
    internalLog(`将于 ${d}ms 后退避重启`)
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (stopping || handle || !lastParams) return
      internalLog('退避重试触发')
      start(lastParams)
    }, d)
  }

  /**
   * 停止当前进程并清除重试计划。generation 递增使旧的 exit 回调失效。
   * stopping 同步复位：后续 start() 立即可用，无 50ms 竞态窗口。
   */
  function stop() {
    if (handle) internalLog(`stop (pid=${handle.pid})`)
    stopping = true
    clearRetry()
    killCurrent()
    stopping = false
  }

  function alive() {
    if (!handle) return false
    try {
      return handle.exitCode === null && handle.signalCode === null && !handle.killed
    } catch {
      return true
    }
  }

  function snapshot() {
    return {
      running: alive(),
      pid: alive() ? handle?.pid ?? null : null,
      tunnelUrl,
      tunnelOk,
      kickSuspect,
    }
  }

  return {
    start,
    stop,
    snapshot,
    logs: () => lines.slice(),
    note,
    /** 测试/调试：直接喂一行日志。 */
    _feed: (t) => { pushLine(t); parseLine(t) },
  }
}
