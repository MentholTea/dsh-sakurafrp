// installer.mjs — 一键下载并安装 SakuraFrp 官方 frpc
//
// 数据来源：https://api.natfrp.com/v4/system/clients
//   · 该端点无需认证（security: []），返回每个平台的下载地址 + MD5 + 字节数
//   · 我们只信任这个 API 返回的 URL，不接受任何用户输入的地址
//
// 安全约束：
//   · 目标路径由调用方决定（默认插件私有目录 ~/.dsh/dsh-sakurafrp/），
//     只信任官方 API 返回的下载地址，不接受任何用户输入的 URL
//   · 下载后 MD5 与官方 hash 比对，不一致立刻删除
//   · 再跑一次 `-V` 确认输出含 sakura 字样（防止拿到原版 frp）
//   · 过程中失败一律清理半成品，绝不留下损坏的可执行文件

import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { chmodSync, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { spawn } from 'node:child_process'

const CLIENTS_API = 'https://api.natfrp.com/v4/system/clients'

/** 把 Node 的 platform/arch 映射到官方 API 的 archs 键名。 */
export function archKey(platform = process.platform, arch = process.arch) {
  const p = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : platform
  const a = arch === 'x64' ? 'amd64'
    : arch === 'ia32' ? '386'
      : arch === 'arm64' ? 'arm64'
        : arch === 'arm' ? 'armv7'
          : arch
  return `${p}_${a}`
}

/** 拉取官方客户端清单（无需 token）。 */
export async function fetchClients({ timeoutMs = 20000, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node 运行时没有 fetch')
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetchImpl(CLIENTS_API, { signal: ac.signal, headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`清单请求失败 HTTP ${res.status}`)
    const data = await res.json()
    if (!data?.frpc?.archs) throw new Error('清单结构异常：缺少 frpc.archs')
    return data
  } finally {
    clearTimeout(timer)
  }
}

/** 从清单里挑出本平台的下载项。 */
export function pickAsset(clients, platform = process.platform, arch = process.arch) {
  const key = archKey(platform, arch)
  const archs = clients?.frpc?.archs ?? {}
  const hit = archs[key]
  if (!hit?.url) {
    const available = Object.keys(archs).filter((k) => !k.startsWith('docker_')).join(', ')
    throw new Error(`官方未提供 ${key} 的下载项。可选：${available}`)
  }
  return { key, url: hit.url, hash: hit.hash, size: hit.size, version: clients.frpc.ver }
}

/** 流式下载到指定文件，返回 MD5 与字节数。 */
export async function downloadToFile(url, dest, {
  timeoutMs = 180000,
  fetchImpl = globalThis.fetch,
  onProgress = () => {},
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node 运行时没有 fetch')
  mkdirSync(dirname(dest), { recursive: true })

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { signal: ac.signal })
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
    if (!res.body) throw new Error('响应没有 body')

    const total = Number(res.headers.get('content-length')) || 0
    const hash = createHash('md5')
    let received = 0

    // 先写 .part，校验通过才原子改名为最终文件
    const part = `${dest}.part`
    const ws = createWriteStream(part, { mode: 0o755 })
    /**
     * ⚠️ 必须显式监听 error：写流是 EventEmitter，磁盘满 / EACCES / EPERM 时
     *    发出的是「未捕获的 'error' 事件」，Node 会直接抛到进程顶层 —— 外层的
     *    try/catch 抓不到异步事件，宿主进程会被击穿。这里先落一个变量，
     *    主循环里同步抛，走统一的清理逻辑。
     */
    let wsError = null
    ws.on('error', (e) => { wsError = e })
    try {
      // Node 18+ 的 Response.body 是 Web ReadableStream
      for await (const chunk of res.body) {
        if (wsError) throw wsError
        hash.update(chunk)
        received += chunk.length
        // once(ws,'drain') 在写流报错时会 reject，不会永久挂起
        if (!ws.write(chunk)) await once(ws, 'drain')
        onProgress({ received, total })
      }
      await new Promise((resolve, reject) => {
        ws.end((err) => (err ? reject(err) : resolve()))
      })
      if (wsError) throw wsError
    } catch (err) {
      try { ws.destroy() } catch { /* noop */ }
      try { rmSync(part, { force: true }) } catch { /* noop */ }
      throw err
    }

    return { part, md5: hash.digest('hex'), bytes: received }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 判断 `frpc -V` 的输出是否为 SakuraFrp 版。
 *
 * ⚠️ 不能简单用 /sakura/i —— 像 "not-sakura"、"sakura-disabled" 这种否定串也会命中，
 * 导致把非官方客户端误判为合格。真实版本串形如：
 *   0.51.0-sakura-15.1 (built: 2026-10-24 02:32) cbfb558
 * 所以要求「语义版本号 + -sakura + 编号」三段同时成立。
 */
export function isSakuraFrpc(versionOutput) {
  const text = String(versionOutput ?? '')
  // 主版本号至少两段，后接 -sakura-<构建号>（构建号可能是 15.1 这类小数）
  if (/\b\d+\.\d+(?:\.\d+)?-sakura-\d+(?:\.\d+)?/i.test(text)) return true
  // 兼容 -sakura 后没有构建号的变体，但仍要求前面是版本号
  if (/\b\d+\.\d+(?:\.\d+)?-sakura\b/i.test(text)) return true
  return false
}
export function probeVersion(binPath, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (text) => { if (!done) { done = true; resolve(text) } }
    let child
    try {
      child = spawn(binPath, ['-V'], { windowsHide: true })
    } catch (err) {
      finish('')
      return
    }
    const timer = setTimeout(() => { try { child.kill() } catch { /* noop */ } finish(out) }, timeoutMs)
    child.stdout?.on('data', (c) => { out += c })
    child.stderr?.on('data', (c) => { out += c })
    child.on('error', () => { clearTimeout(timer); finish('') })
    child.on('close', () => { clearTimeout(timer); finish(out) })
  })
}

/**
 * 从 `frpc -V` 的完整输出中提取版本号（形如 "0.51.0-sakura-15.1"）。
 * 真实输出形如：
 *   0.51.0-sakura-15.1 (built: 2026-10-24 02:32) cbfb558
 * 与 isSakuraFrpc 用同一套「版本号 + -sakura + 编号」判定口径，保证
 * 「判定合格」的输出一定能提取出版本。提取失败返回 ''。
 */
export function extractSakuraVersion(versionOutput) {
  const m = String(versionOutput ?? '').match(/\b(\d+\.\d+(?:\.\d+)?-sakura(?:-\d+(?:\.\d+)?)?)\b/i)
  return m ? m[1] : ''
}

/**
 * 比较两个 SakuraFrp 版本号：返回 -1（a 旧）/ 0（相同）/ 1（a 新）；
 * 任何一个解析失败返回 null —— 调用方只能当作「无法判断」，绝不能当成「相同」。
 *
 * 版本形如 0.51.0-sakura-15.1：先比语义化主版本（major.minor.patch，
 * 缺 patch 段按 0 补齐），主版本相同时再比 -sakura-<构建号>（构建号可能是
 * 15.1 这类小数）；带 -sakura 的视为比不带的更新（0.51.0-sakura > 0.51.0）。
 */
export function compareFrpcVersion(a, b) {
  const parse = (v) => {
    const raw = String(v ?? '').trim().toLowerCase()
    const m = raw.match(/^(\d+)\.(\d+)(?:\.(\d+))?(?:-sakura(?:-(\d+)(?:\.(\d+))?)?)?$/)
    if (!m) return null
    return {
      major: Number(m[1]),
      minor: Number(m[2]),
      patch: m[3] === undefined ? 0 : Number(m[3]),
      // ⚠️ 不能用 m[4] 判断 hasSakura：它是「构建号」捕获组，0.51.0-sakura
      //    （有 -sakura 无构建号）时 m[4] 是 undefined，会被误判成不带 sakura。
      //    正则已锚定整串，匹配成功后 -sakura 只可能出现在预期位置。
      hasSakura: raw.includes('-sakura'),
      build: m[4] === undefined ? 0 : Number(m[4]),
      buildMinor: m[5] === undefined ? 0 : Number(m[5]),
    }
  }
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return null
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1
  // 主版本相同：有 -sakura-<构建号> 的比没有的更新
  if (pa.hasSakura !== pb.hasSakura) return pa.hasSakura ? 1 : -1
  if (pa.build !== pb.build) return pa.build < pb.build ? -1 : 1
  if (pa.buildMinor !== pb.buildMinor) return pa.buildMinor < pb.buildMinor ? -1 : 1
  return 0
}

/**
 * 完整安装流程：查清单 → 选平台 → 下载 → 校验 MD5 → 原子落盘 → 探版本。
 * @returns {{ok:boolean, version?:string, path?:string, error?:string, bytes?:number}}
 */
export async function installFrpc({
  dest,
  platform = process.platform,
  arch = process.arch,
  fetchImpl = globalThis.fetch,
  onProgress = () => {},
  probe = probeVersion,
} = {}) {
  if (!dest) throw new Error('installFrpc 缺少 dest')
  let part = null

  try {
    const clients = await fetchClients({ fetchImpl })
    const asset = pickAsset(clients, platform, arch)

    const dl = await downloadToFile(asset.url, dest, { fetchImpl, onProgress })
    part = dl.part

    // MD5 校验：官方给了 hash 就必须一致
    if (asset.hash && dl.md5.toLowerCase() !== String(asset.hash).toLowerCase()) {
      rmSync(part, { force: true })
      return { ok: false, error: `MD5 校验失败：期望 ${asset.hash}，实际 ${dl.md5}`, bytes: dl.bytes }
    }
    // 字节数校验（官方 size 存在时）
    if (asset.size && dl.bytes !== asset.size) {
      rmSync(part, { force: true })
      return { ok: false, error: `大小不符：期望 ${asset.size}，实际 ${dl.bytes}`, bytes: dl.bytes }
    }

    // 原子改名：已有旧文件先挪走，成功后再删
    let backup = null
    if (existsSync(dest)) {
      backup = `${dest}.old`
      try { rmSync(backup, { force: true }) } catch { /* noop */ }
      renameSync(dest, backup)
    }
    try {
      renameSync(part, dest)
    } catch (err) {
      if (backup) { try { renameSync(backup, dest) } catch { /* noop */ } }
      throw err
    }
    part = null

    if (platform !== 'win32') {
      try { chmodSync(dest, 0o755) } catch { /* noop */ }
    }

    // 探版本：必须含 sakura，否则是原版 frp，连不上 SakuraFrp 节点
    const verOut = await probe(dest)
    if (!isSakuraFrpc(verOut)) {
      // 回滚：恢复旧文件（若有），否则删掉刚下的
      try { rmSync(dest, { force: true }) } catch { /* noop */ }
      if (backup) { try { renameSync(backup, dest) } catch { /* noop */ } }
      return {
        ok: false,
        error: `下载到的不是 SakuraFrp 版 frpc（-V 输出：${String(verOut).trim().slice(0, 120) || '(空)'}）`,
        bytes: dl.bytes,
      }
    }

    if (backup) { try { rmSync(backup, { force: true }) } catch { /* noop */ } }

    return {
      ok: true,
      path: dest,
      version: String(verOut).trim().split('\n')[0],
      bytes: dl.bytes,
      expectedVersion: asset.version,
    }
  } catch (err) {
    if (part) { try { rmSync(part, { force: true }) } catch { /* noop */ } }
    return { ok: false, error: String(err?.message ?? err) }
  }
}

/** 只检查本地是否已有可用的 sakura 版 frpc。 */
export async function checkInstalled(dest, { probe = probeVersion } = {}) {
  try {
    if (!existsSync(dest)) return { present: false }
    const st = statSync(dest)
    const out = await probe(dest)
    const ok = isSakuraFrpc(out)
    return {
      present: true,
      ok,
      bytes: st.size,
      version: String(out).trim().split('\n')[0] || null,
      error: ok ? undefined : '本地文件不是 SakuraFrp 版 frpc',
    }
  } catch (err) {
    return { present: false, error: String(err?.message ?? err) }
  }
}
