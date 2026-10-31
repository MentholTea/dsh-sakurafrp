// installer-test.mjs — 一键安装 frpc 的离线验证
// 不真下载：用 mock fetch 模拟清单与二进制，验证选平台、校验、回滚。
const results = []
const rec = (n, p, d = '') => { results.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`) }

import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { archKey, pickAsset, installFrpc, checkInstalled, isSakuraFrpc, extractSakuraVersion, compareFrpcVersion } from './../installer.mjs'

// ── 1) 平台映射 ──
rec('win32+x64 → windows_amd64', archKey('win32', 'x64') === 'windows_amd64', archKey('win32', 'x64'))
rec('win32+ia32 → windows_386', archKey('win32', 'ia32') === 'windows_386')
rec('win32+arm64 → windows_arm64', archKey('win32', 'arm64') === 'windows_arm64')
rec('linux+x64 → linux_amd64', archKey('linux', 'x64') === 'linux_amd64')
rec('linux+arm → linux_armv7', archKey('linux', 'arm') === 'linux_armv7')
rec('darwin+arm64 → darwin_arm64', archKey('darwin', 'arm64') === 'darwin_arm64')

// ── 1.5) 版本串判定（真实 bug 回归：not-sakura 曾被误判通过）──
rec('真 sakura 版本通过', isSakuraFrpc('0.51.0-sakura-15.1 (built: 2026-10-24 02:32) cbfb558') === true)
rec('无构建号的 sakura 通过', isSakuraFrpc('0.51.0-sakura') === true)
rec('原版 frp 被拒', isSakuraFrpc('0.62.0 (original frp)') === false)
rec('not-sakura 被拒（回归）', isSakuraFrpc('not-sakura') === false, '这是刚发现的真 bug')
rec('sakura-disabled 被拒', isSakuraFrpc('sakura-disabled') === false)
rec('空串被拒', isSakuraFrpc('') === false)
rec('null 被拒', isSakuraFrpc(null) === false)
rec('只有 sakura 单词被拒', isSakuraFrpc('sakura') === false)

// ── 2) 清单挑选 ──
// payload 先在前面定义，才能给清单填真实 md5
const __payload = Buffer.from('FAKE-FRPC-BINARY-SAKURA')
const __md5 = createHash('md5').update(__payload).digest('hex')
const fakeClients = {
  frpc: {
    ver: '0.51.0-sakura-15.1',
    archs: {
      windows_amd64: { title: 'win', url: 'https://example.test/frpc.exe', hash: __md5, size: __payload.length },
      linux_amd64: { title: 'linux', url: 'https://example.test/frpc', hash: __md5, size: __payload.length },
      docker_hub: { title: 'docker', url: 'https://hub.docker.com/r/natfrp/frpc' },
    },
  },
}
{
  const a = pickAsset(fakeClients, 'win32', 'x64')
  rec('选到 windows_amd64', a.key === 'windows_amd64' && a.url === 'https://example.test/frpc.exe', a.key)
  rec('带上版本号', a.version === '0.51.0-sakura-15.1')
}
{
  let threw = false
  try { pickAsset(fakeClients, 'freebsd', 'x64') } catch { threw = true }
  rec('不支持的平台抛错', threw)
}
{
  // 错误信息应列出可选平台（且排除 docker_*）
  let msg = ''
  try { pickAsset(fakeClients, 'freebsd', 'x64') } catch (e) { msg = e.message }
  rec('错误信息列可选平台', msg.includes('windows_amd64') && !msg.includes('docker_hub'), msg.slice(0, 70))
}

// ── 3) 安装全流程（mock）──
const sandbox = mkdtempSync(join(tmpdir(), 'frpc-test-'))
const payload = Buffer.from('FAKE-FRPC-BINARY-SAKURA')
const payloadMd5 = createHash('md5').update(payload).digest('hex')

function mockFetch({ clients = fakeClients, body = payload, md5Override = null, status = 200 } = {}) {
  return async (url) => {
    if (url.includes('/system/clients')) {
      return { ok: true, status: 200, json: async () => clients, headers: new Map() }
    }
    const hash = md5Override ?? payloadMd5
    const headers = new Map([['content-length', String(body.length)]])
    return {
      ok: status === 200, status,
      headers: { get: (k) => headers.get(k.toLowerCase()) ?? null },
      body: (async function* () { yield body })(),
      _debugMd5: hash,
    }
  }
}

// 安装成功路径
{
  const dest = join(sandbox, 'a', 'frpc.exe')
  const r = await installFrpc({
    dest, platform: 'win32', arch: 'x64',
    fetchImpl: mockFetch(),
    probe: async () => '0.51.0-sakura-15.1 (built: 2026-10-24)',
  })
  rec('安装成功', r.ok === true, r.error ?? '')
  rec('文件已落盘', existsSync(dest))
  rec('内容正确', existsSync(dest) && readFileSync(dest).equals(payload))
  rec('返回版本号', /sakura-15\.1/.test(r.version ?? ''), r.version ?? '')
  rec('无 .part 残留', !existsSync(`${dest}.part`))
}

// MD5 不匹配 → 必须失败且不留文件
{
  const dest = join(sandbox, 'b', 'frpc.exe')
  const badClients = {
    frpc: { ver: 'x', archs: { windows_amd64: { url: 'https://example.test/f', hash: 'deadbeefdeadbeefdeadbeefdeadbeef', size: 0 } } },
  }
  const r = await installFrpc({
    dest, platform: 'win32', arch: 'x64',
    fetchImpl: mockFetch({ clients: badClients }),
    probe: async () => 'sakura',
  })
  rec('MD5 不符时失败', r.ok === false && /MD5/.test(r.error ?? ''), r.error ?? '')
  rec('MD5 失败不留成品', !existsSync(dest))
  rec('MD5 失败不留 .part', !existsSync(`${dest}.part`))
}

// 拿到原版 frp（-V 无 sakura）→ 必须失败
{
  const dest = join(sandbox, 'c', 'frpc.exe')
  const r = await installFrpc({
    dest, platform: 'win32', arch: 'x64',
    fetchImpl: mockFetch(),
    probe: async () => '0.62.0 (original frp)',
  })
  rec('非 sakura 版被拒绝', r.ok === false && /SakuraFrp/.test(r.error ?? ''), (r.error ?? '').slice(0, 60))
  rec('非 sakura 版不留文件', !existsSync(dest))
}

// 已有旧文件 + 新安装失败 → 旧文件必须保住
{
  const dest = join(sandbox, 'd', 'frpc.exe')
  mkdirSync(join(sandbox, 'd'), { recursive: true })
  writeFileSync(dest, 'OLD-GOOD-BINARY')
  const r = await installFrpc({
    dest, platform: 'win32', arch: 'x64',
    fetchImpl: mockFetch(),
    probe: async () => 'not-sakura-at-all',
  })
  rec('失败时保留旧文件', existsSync(dest) && readFileSync(dest, 'utf8') === 'OLD-GOOD-BINARY', r.error ?? '')
}

// 网络失败
{
  const dest = join(sandbox, 'e', 'frpc.exe')
  const r = await installFrpc({
    dest, platform: 'win32', arch: 'x64',
    fetchImpl: async () => { throw new Error('ECONNRESET mock') },
    probe: async () => '',
  })
  rec('网络失败被捕获', r.ok === false && /ECONNRESET/.test(r.error ?? ''), (r.error ?? '').slice(0, 50))
  rec('网络失败不留文件', !existsSync(dest))
}

// ── 4) checkInstalled ──
{
  const dest = join(sandbox, 'f', 'frpc.exe')
  mkdirSync(join(sandbox, 'f'), { recursive: true })
  rec('不存在时 present=false', (await checkInstalled(dest, { probe: async () => '' })).present === false)

  writeFileSync(dest, 'x')
  const good = await checkInstalled(dest, { probe: async () => '0.51.0-sakura-15.1' })
  rec('存在且是 sakura 版 → ok', good.present && good.ok, good.version ?? '')

  const bad = await checkInstalled(dest, { probe: async () => '0.62.0' })
  rec('存在但非 sakura → ok=false', bad.present && !bad.ok)
}

// 进度回调
{
  const dest = join(sandbox, 'g', 'frpc.exe')
  const events = []
  await installFrpc({
    dest, platform: 'win32', arch: 'x64',
    fetchImpl: mockFetch(),
    probe: async () => 'sakura',
    onProgress: (p) => events.push(p),
  })
  rec('进度回调被调用', events.length > 0, `${events.length} 次`)
  rec('进度含 received/total', events[0] && 'received' in events[0] && 'total' in events[0])
}

// ── 5) 版本提取 ──
{
  const full = '0.51.0-sakura-15.1 (built: 2026-10-24 02:32) cbfb558'
  rec('完整 -V 输出提取版本', extractSakuraVersion(full) === '0.51.0-sakura-15.1', extractSakuraVersion(full))
  rec('无构建号变体提取', extractSakuraVersion('0.51.0-sakura') === '0.51.0-sakura')
  rec('裸版本号不匹配 sakura 串返回空', extractSakuraVersion('0.62.0') === '')
  rec('空串返回空', extractSakuraVersion('') === '')
  rec('null 返回空', extractSakuraVersion(null) === '')
  rec('not-sakura 返回空（回归）', extractSakuraVersion('not-sakura') === '')
}

// ── 6) 版本比较 ──
{
  rec('构建号更大 → 有更新', compareFrpcVersion('0.51.0-sakura-15.1', '0.51.0-sakura-16.0') === -1)
  rec('构建号相同 → 无更新', compareFrpcVersion('0.51.0-sakura-15.1', '0.51.0-sakura-15.1') === 0)
  rec('小数构建号比较', compareFrpcVersion('0.51.0-sakura-15.1', '0.51.0-sakura-15.2') === -1)
  rec('主版本更新 → 有更新', compareFrpcVersion('0.51.0-sakura-15.1', '0.52.0-sakura-1.0') === -1)
  rec('本地比官方新', compareFrpcVersion('0.53.0-sakura-1.0', '0.52.0-sakura-9.9') === 1)
  rec('带 -sakura 比不带新', compareFrpcVersion('0.51.0-sakura', '0.51.0') === 1)
  rec('缺 patch 段按 0 补齐', compareFrpcVersion('0.51-sakura-1', '0.51.0-sakura-1') === 0)
  rec('解析失败返回 null（不冒充相同）', compareFrpcVersion('garbage', '0.51.0-sakura-15.1') === null)
  rec('null 入参返回 null', compareFrpcVersion(null, '0.51.0-sakura-15.1') === null)
  rec('两边都解析失败也返回 null', compareFrpcVersion('', '') === null)
}

rmSync(sandbox, { recursive: true, force: true })

const ok = results.every(Boolean)
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`)
setTimeout(() => process.exit(ok ? 0 : 1), 200)
