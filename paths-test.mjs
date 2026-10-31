// paths-test.mjs — frpc 路径解析（跟随 DSH 实际 home）
const results = []
const rec = (n, p, d = '') => { results.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`) }

import { homedir } from 'node:os'
import { join, resolve, isAbsolute } from 'node:path'
import { frpcBinaryName, expandTilde, resolveDshHome, resolveFrpcPath, displayPath, inferHomeFromProfileDir, dshHomeSource } from './paths.mjs'

const HOME = homedir()
const DEFAULT_HOME = join(HOME, '.dsh')

// ── 1) 二进制名 ──
rec('Windows 带 .exe', frpcBinaryName('win32') === 'frpc-standalone.exe', frpcBinaryName('win32'))
rec('Linux 无后缀', frpcBinaryName('linux') === 'frpc-standalone')
rec('macOS 无后缀', frpcBinaryName('darwin') === 'frpc-standalone')

// ── 2) ~ 展开 ──
rec('~ 展开为 home', expandTilde('~') === HOME)
rec('~/ 展开', expandTilde('~/bin/x') === join(HOME, 'bin', 'x'))
rec('~\\ 展开（Windows 写法）', expandTilde('~\\bin\\x') === join(HOME, 'bin\\x'))
rec('无 ~ 原样返回', expandTilde('/abs/path') === '/abs/path')
rec('~user 不展开', expandTilde('~user/x') === '~user/x')
rec('空串原样', expandTilde('') === '')
rec('非字符串原样', expandTilde(null) === null)

// ── 3) resolveDshHome 优先级 ──
{
  // 显式配置最高
  const r = resolveDshHome('D:\\mydsh', { DSH_HOME: 'E:\\envdsh' })
  rec('显式配置优先于环境变量', r === resolve('D:\\mydsh'), r)
}
{
  // $DSH_HOME 次之
  const r = resolveDshHome(undefined, { DSH_HOME: 'E:\\envdsh' })
  rec('$DSH_HOME 生效', r === resolve('E:\\envdsh'), r)
}
{
  // 都没有 → 默认
  const r = resolveDshHome(undefined, {})
  rec('默认 ~/.dsh', r === resolve(DEFAULT_HOME), r)
}
{
  // ⚠️ 关键回归：空白 $DSH_HOME 必须当作未设置，不能解析到 CWD
  const r = resolveDshHome(undefined, { DSH_HOME: '   ' })
  rec('空白 $DSH_HOME 退化为默认（不落到 CWD）', r === resolve(DEFAULT_HOME), r)
}
{
  const r = resolveDshHome(undefined, { DSH_HOME: '' })
  rec('空串 $DSH_HOME 退化为默认', r === resolve(DEFAULT_HOME), r)
}
{
  // 显式配置也可以为空白 → 应被忽略
  const r = resolveDshHome('  ', { DSH_HOME: 'E:\\envdsh' })
  rec('空白显式配置被忽略', r === resolve('E:\\envdsh'), r)
}
{
  // ~ 前缀
  const r = resolveDshHome('~/mydsh', {})
  rec('显式配置支持 ~ 前缀', r === resolve(join(HOME, 'mydsh')), r)
}

// ── 3.5) 从 $DSH_PROFILE_DIR 反推 home ──
{
  // 标准布局
  const r = resolveDshHome(undefined, { DSH_PROFILE_DIR: 'D:\\portable\\profiles\\desktop' })
  rec('从 PROFILE_DIR 反推 home', r === resolve('D:\\portable'), r)
}
{
  // DSH_HOME 存在时优先它，不看 PROFILE_DIR
  const r = resolveDshHome(undefined, {
    DSH_HOME: 'E:\\realhome',
    DSH_PROFILE_DIR: 'D:\\wrong\\profiles\\desktop',
  })
  rec('DSH_HOME 优先于 PROFILE_DIR 反推', r === resolve('E:\\realhome'), r)
}
{
  // 非标准布局 → 不瞎猜，退化默认
  const r = resolveDshHome(undefined, { DSH_PROFILE_DIR: 'D:\\random\\path' })
  rec('非 profiles 布局不反推', r === resolve(DEFAULT_HOME), r)
}
{
  const r = resolveDshHome(undefined, { DSH_PROFILE_DIR: 'D:\\x\\profiles' })
  rec('段数不足不反推', r === resolve(DEFAULT_HOME), r)
}
{
  const r = resolveDshHome(undefined, { DSH_PROFILE_DIR: '   ' })
  rec('空白 PROFILE_DIR 被忽略', r === resolve(DEFAULT_HOME), r)
}
{
  // 显式配置击败所有
  const r = resolveDshHome('F:\\explicit', {
    DSH_HOME: 'E:\\env',
    DSH_PROFILE_DIR: 'D:\\p\\profiles\\desktop',
  })
  rec('显式配置最高优先', r === resolve('F:\\explicit'), r)
}

// inferHomeFromProfileDir 单独测
{
  rec('infer: 标准三段以上', inferHomeFromProfileDir('C:\\Users\\a\\.dsh\\profiles\\desktop') === 'C:\\Users\\a\\.dsh',
    String(inferHomeFromProfileDir('C:\\Users\\a\\.dsh\\profiles\\desktop')))
  rec('infer: 无 profiles 段返回 null', inferHomeFromProfileDir('C:\\a\\b\\c') === null)
  rec('infer: 空串返回 null', inferHomeFromProfileDir('') === null)
}

// dshHomeSource
{
  rec('source=config', dshHomeSource('D:\\x', {}) === 'config')
  rec('source=DSH_HOME', dshHomeSource(undefined, { DSH_HOME: 'E:\\h' }) === 'DSH_HOME')
  rec('source=DSH_PROFILE_DIR', dshHomeSource(undefined, { DSH_PROFILE_DIR: 'D:\\p\\profiles\\desktop' }) === 'DSH_PROFILE_DIR')
  rec('source=default', dshHomeSource(undefined, {}) === 'default')
}

// ── 3.9) 新默认位置 + 旧位置兼容 ──
{
  // 新装（两边都没有）→ 插件私有目录
  const r = resolveFrpcPath({ env: {}, platform: 'win32', exists: () => false })
  rec('新装默认指向插件目录',
    r.path === join(DEFAULT_HOME, 'dsh-sakurafrp', 'frpc-standalone.exe'), r.path)
}
{
  const target = join(DEFAULT_HOME, 'dsh-sakurafrp', 'frpc-standalone.exe')
  const r = resolveFrpcPath({ env: {}, platform: 'win32', exists: (p) => p === target })
  rec('插件目录有则优先它', r.path === target && r.source === 'plugin-data', r.source)
}
{
  const legacy = join(DEFAULT_HOME, 'bin', 'frpc-standalone.exe')
  const r = resolveFrpcPath({ env: {}, platform: 'win32', exists: (p) => p === legacy })
  rec('旧位置有则兼容沿用', r.path === legacy && r.source === 'legacy-bin', r.source)
}
{
  const plugin = join(DEFAULT_HOME, 'dsh-sakurafrp', 'frpc-standalone.exe')
  const legacy = join(DEFAULT_HOME, 'bin', 'frpc-standalone.exe')
  const r = resolveFrpcPath({ env: {}, platform: 'win32', exists: (p) => p === plugin || p === legacy })
  rec('两边都有时插件目录优先', r.path === plugin && r.source === 'plugin-data', r.source)
}
{
  const r = resolveFrpcPath({ env: {}, platform: 'win32', exists: () => false })
  rec('candidates 含两个候选位置',
    Array.isArray(r.candidates) && r.candidates.length === 2,
    (r.candidates || []).map((c) => c.source).join(','))
}

// ── 4) resolveFrpcPath 三层回退 ──
{
  // 无配置无环境 → 默认
  const r = resolveFrpcPath({ env: {}, platform: 'win32', exists: () => false })
  rec('默认: 插件私有目录', r.path === join(DEFAULT_HOME, 'dsh-sakurafrp', 'frpc-standalone.exe'), r.path)
  rec('来源标记为 default', r.source === 'default', r.source)
}
{
  // 有 $DSH_HOME → 跟随它
  const r = resolveFrpcPath({ env: { DSH_HOME: 'D:\\portable-dsh' }, platform: 'win32', exists: () => false })
  rec('$DSH_HOME 下用其插件目录', r.path === join(resolve('D:\\portable-dsh'), 'dsh-sakurafrp', 'frpc-standalone.exe'), r.path)
  rec('来源标记为 plugin-data', r.source === 'plugin-data', r.source)
}
{
  // 显式配置绝对路径 → 原样
  const r = resolveFrpcPath({ configured: 'E:\\tools\\frpc.exe', env: {}, platform: 'win32' })
  rec('显式绝对路径原样使用', r.path === resolve('E:\\tools\\frpc.exe'), r.path)
  rec('来源标记为 config', r.source === 'config', r.source)
}
{
  // 显式配置相对路径 → 基于 DSH home
  const r = resolveFrpcPath({ configured: 'bin/frpc.exe', env: {}, platform: 'win32' })
  rec('相对路径基于 DSH home',
    r.path === resolve(DEFAULT_HOME, 'bin/frpc.exe'), r.path)
}
{
  // 显式配置 ~ 前缀
  const r = resolveFrpcPath({ configured: '~/tools/frpc', env: {}, platform: 'linux' })
  rec('显式配置 ~ 前缀可展开',
    r.path === resolve(join(HOME, 'tools', 'frpc')), r.path)
}
{
  // 显式配置优先于 $DSH_HOME
  const r = resolveFrpcPath({
    configured: 'E:\\explicit\\frpc.exe',
    env: { DSH_HOME: 'D:\\portable' },
    platform: 'win32',
  })
  rec('显式配置击败 $DSH_HOME', r.path === resolve('E:\\explicit\\frpc.exe'), r.path)
}
{
  // 空白 $DSH_HOME → 默认，不落 CWD
  const r = resolveFrpcPath({ env: { DSH_HOME: '  ' }, platform: 'win32', exists: () => false })
  rec('空白 $DSH_HOME 时用插件目录', r.path === join(DEFAULT_HOME, 'dsh-sakurafrp', 'frpc-standalone.exe'), r.path)
  rec('空白环境下 source=default', r.source === 'default', r.source)
}
{
  // 所有结果的 path 都必须是绝对路径（这是能安全写入的前提）
  const cases = [
    resolveFrpcPath({ env: {}, platform: 'win32' }),
    resolveFrpcPath({ env: { DSH_HOME: 'D:\\x' }, platform: 'linux' }),
    resolveFrpcPath({ configured: 'rel/frpc', env: {}, platform: 'darwin' }),
  ]
  rec('结果均为绝对路径', cases.every((c) => isAbsolute(c.path)), cases.map((c) => c.path).join(' | '))
}

// ── 5) displayPath（不泄漏用户名）──
{
  const p = join(DEFAULT_HOME, 'bin', 'frpc-standalone.exe')
  const d = displayPath(p, DEFAULT_HOME)
  rec('默认位置显示为 ~/.dsh/...', d === '~/.dsh/bin/frpc-standalone.exe', d)
  rec('显示串不含用户名', !d.includes(HOME.split(/[\\/]/).pop() ?? '\u0000'), d)
}
{
  const custom = resolve('D:\\portable-dsh')
  const p = join(custom, 'bin', 'frpc-standalone.exe')
  const d = displayPath(p, custom)
  rec('自定义位置显示绝对路径', d === p, d)
}
{
  rec('home 本身显示 ~/.dsh', displayPath(DEFAULT_HOME, DEFAULT_HOME) === '~/.dsh')
}

const ok = results.every(Boolean)
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`)
setTimeout(() => process.exit(ok ? 0 : 1), 200)
