// paths.mjs — frpc 路径解析（跟随 DSH 实际 home，而不是硬编码 ~/.dsh）
//
// 优先级（与 DSH 官方 @deepseek-ai/dsh-home-paths 的 resolveDshHome 保持一致）：
//   1. config.frpcPath —— 用户在 cordis.patch.yml 显式指定，最高优先，完全尊重
//   2. $DSH_HOME/bin/frpc-standalone(.exe) —— 跟随 DSH 真正的用户数据根
//   3. ~/.dsh/bin/frpc-standalone(.exe) —— 默认位置
//
// 为什么要自己实现等价逻辑而不直接 import 官方包：
//   · 插件在 profile 里以 link 安装，peer 依赖不一定能解析到 @deepseek-ai/dsh-home-paths
//   · 官方那三个行为细节必须复现，漏一个就会写错目录（见 expandTilde / resolveRoot）

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'

/** frpc 可执行文件名（Windows 带 .exe）。 */
export function frpcBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'frpc-standalone.exe' : 'frpc-standalone'
}

/**
 * 展开 `~` / `~/` / `~\` 前缀。
 * 官方 expandHomePath 只认这三种形式，其它（如 `~user/`）原样返回。
 */
export function expandTilde(input) {
  if (typeof input !== 'string' || input === '') return input
  if (input === '~') return homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) return join(homedir(), input.slice(2))
  return input
}

/**
 * 解析 DSH home。
 * ⚠️ 空白 $DSH_HOME 必须当作「未设置」：否则 resolve('') 会得到当前工作目录，
 *    把 frpc 写到用户正在操作的项目里，属于灾难性行为。
 */
/**
 * 解析 DSH home —— 带兜底探测链。
 *
 * 优先级：
 *   1. 显式配置（config.dshHome）
 *   2. $DSH_HOME                              ← 官方认定的唯一根，最权威
 *   3. 从 $DSH_PROFILE_DIR 反推                ← <home>/profiles/<name> 去掉末两段
 *   4. ~/.dsh                                  ← 默认
 *
 * 为什么要第 3 条：某些启动方式（CLI、自定义包装）可能只注入 PROFILE_DIR 而不注入
 * DSH_HOME。两者同源，能反推出来就不该退化到默认位置。
 *
 * ⚠️ 空白串一律视为「未设置」：resolve('') 会得到 CWD，把 frpc 写进用户当前项目目录。
 */
export function resolveDshHome(configured, env = process.env, platform = process.platform) {
  // 1) 显式配置
  const explicit = typeof configured === 'string' && configured.trim() !== '' ? configured : undefined
  if (explicit) return resolve(expandTilde(explicit))

  // 2) $DSH_HOME
  const fromEnv = env?.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return resolve(expandTilde(fromEnv))
  }

  // 3) 从 $DSH_PROFILE_DIR 反推：形如 <home>/profiles/<name>
  const profileDir = env?.DSH_PROFILE_DIR
  if (typeof profileDir === 'string' && profileDir.trim() !== '') {
    const inferred = inferHomeFromProfileDir(profileDir)
    if (inferred) return inferred
  }

  // 4) 默认
  return resolve(join(homedir(), '.dsh'))
}

/**
 * 从 profile 目录反推 home。
 * 只认 `<something>/profiles/<name>` 这种标准布局；不符合就返回 null，
 * 避免把任意路径误当 home（比如用户把 PROFILE_DIR 指到奇怪的地方）。
 */
export function inferHomeFromProfileDir(profileDir) {
  try {
    const normalized = resolve(expandTilde(String(profileDir).trim()))
    const parts = normalized.split(/[\\/]+/).filter(Boolean)
    // 至少要有 <home>/profiles/<name> 三段
    if (parts.length < 3) return null
    // 倒数第二段必须是 profiles
    if (parts[parts.length - 2].toLowerCase() !== 'profiles') return null
    // 去掉末两段
    const homeParts = parts.slice(0, -2)
    if (homeParts.length === 0) return null
    // Windows 盘符要还原（resolve 后 "C:" 会变成 "C:"，join 时需补分隔符）
    const isWin = /^[A-Za-z]:$/.test(homeParts[0])
    return isWin ? `${homeParts[0]}\\${homeParts.slice(1).join('\\')}` : `/${homeParts.join('/')}`
  } catch {
    return null
  }
}

/** 返回 DSH home 的解析来源，便于在设置页说明「为什么是这个路径」。 */
export function dshHomeSource(configured, env = process.env) {
  if (typeof configured === 'string' && configured.trim() !== '') return 'config'
  const fromEnv = env?.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return 'DSH_HOME'
  const profileDir = env?.DSH_PROFILE_DIR
  if (typeof profileDir === 'string' && profileDir.trim() !== '' && inferHomeFromProfileDir(profileDir)) {
    return 'DSH_PROFILE_DIR'
  }
  return 'default'
}

/**
 * 插件私有数据目录名（与包名一致）。
 * frpc 二进制、state.json、token 都放这里：权限天然正确、卸载即清净、
 * 不在 node_modules 里（npm 升级不会冲掉）。
 */
export const PLUGIN_DATA_DIR_NAME = 'dsh-sakurafrp'

/** 旧版放 frpc 的位置（~/.dsh/bin），保留读取兼容 */
export const LEGACY_BIN_DIR_NAME = 'bin'

/**
 * 推导 frpc 的完整路径。
 *
 * 顺序：
 *   1. config.frpcPath                        用户显式指定，最高优先
 *   2. <home>/dsh-sakurafrp/frpc-standalone   插件私有目录（新默认）
 *   3. <home>/bin/frpc-standalone             旧位置，若已存在则沿用（兼容老用户）
 *
 * 为什么写和读分开：新装写第 2 项；但如果用户机器上第 3 项已有可用二进制，
 * 不该无视它硬要再下一份 —— 所以「读」时会跳过不存在的项。
 *
 * @param {object} opts
 * @param {string} [opts.configured] config.frpcPath
 * @param {object} [opts.env] 环境变量（默认 process.env）
 * @param {string} [opts.platform]
 * @param {(p:string)=>boolean} [opts.exists] 存在性判断（可注入便于测试）
 * @returns {{ path: string, source: 'config'|'plugin-data'|'legacy-bin'|'default', home: string, homeSource: string, candidates: Array<{path:string,source:string}> }}
 */
export function resolveFrpcPath({
  configured,
  env = process.env,
  platform = process.platform,
  exists = existsSync,
} = {}) {
  const home = resolveDshHome(undefined, env, platform)
  const homeSource = dshHomeSource(undefined, env)
  const bin = frpcBinaryName(platform)

  // 1) 显式配置：相对路径按 DSH home 解析，绝对路径原样，支持 ~ 前缀
  if (typeof configured === 'string' && configured.trim() !== '') {
    const expanded = expandTilde(configured.trim())
    return {
      path: isAbsolute(expanded) ? resolve(expanded) : resolve(home, expanded),
      source: 'config',
      home,
      homeSource,
      candidates: [],
    }
  }

  const pluginDataPath = join(home, PLUGIN_DATA_DIR_NAME, bin)
  const legacyBinPath = join(home, LEGACY_BIN_DIR_NAME, bin)
  const candidates = [
    { path: pluginDataPath, source: 'plugin-data' },
    { path: legacyBinPath, source: 'legacy-bin' },
  ]

  // 读：优先插件目录；不存在但旧位置有 → 沿用旧的（不逼用户重下）
  for (const c of candidates) {
    try {
      if (exists(c.path)) {
        return { path: c.path, source: c.source, home, homeSource, candidates }
      }
    } catch { /* 探测失败当作不存在 */ }
  }

  // 都没有：返回插件私有目录作为「将要安装的位置」
  return {
    path: pluginDataPath,
    source: homeSource === 'default' ? 'default' : 'plugin-data',
    home,
    homeSource,
    candidates,
  }
}

/**
 * 面向用户的路径显示：默认位置显示成 `~/.dsh/bin/xxx`，否则显示绝对路径。
 * 避免设置页出现 `C:\Users\某某` 这种泄漏隐私的串。
 */
export function displayPath(absPath, home = resolveDshHome()) {
  try {
    const defaultHome = join(homedir(), '.dsh')
    const normalizedHome = resolve(home)
    const normalizedDefault = resolve(defaultHome)
    if (normalizedHome === normalizedDefault) {
      const rest = absPath.slice(normalizedHome.length).replace(/^[\\/]+/, '')
      return rest ? `~/.dsh/${rest.replace(/\\/g, '/')}` : '~/.dsh'
    }
    return absPath
  } catch {
    return absPath
  }
}
