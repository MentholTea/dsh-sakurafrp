// token-test.mjs — token 写入权限处理（EPERM 回退 + 友好诊断）
const results = []
const rec = (n, p, d = '') => { results.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`) }

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { readFileSync as rf } from 'node:fs'
const index = rf(new URL('./index.js', import.meta.url), 'utf8')
const client = rf(new URL('./client.js', import.meta.url), 'utf8')

// ── 1) 静态结构 ──
rec('有 FALLBACK_TOKEN_FILE 常量', /const FALLBACK_TOKEN_FILE = join\(DATA_DIR, 'token\.txt'\)/.test(index))
rec('有 tokenFilePath 选择函数', /function tokenFilePath\(\)/.test(index))
rec('按 mtime 选最新（读到刚写的值）', /st\.mtimeMs > bestTime/.test(index))
rec('写入失败会回退', /if \(!savedTo\)[\s\S]{0,400}?writeFileSync\(FALLBACK_TOKEN_FILE/.test(index))
rec('回退成功写日志告知用户', /不可写，密钥已改存/.test(index))
rec('有 diagnoseWriteFailure', /function diagnoseWriteFailure/.test(index))
rec('EPERM/EACCES 有专门诊断', /code === 'EPERM' \|\| code === 'EACCES'/.test(index))
rec('诊断含 takeown 指引', /takeown \/f/.test(index))
rec('诊断含 icacls 指引', /icacls/.test(index))
rec('诊断含删除重建方案', /Remove-Item/.test(index))
rec('ENOENT 有专门诊断', /code === 'ENOENT'/.test(index))
rec('ENOSPC 有专门诊断', /code === 'ENOSPC'/.test(index))

// ── 2) 前端要显示 hint ──
rec('postConfig 附带 hint', /err\.hint = body\.hint/.test(client))
rec('apply 显示 hint', /e\.hint \? `\$\{msg\}\\n\\n\$\{e\.hint\}`/.test(client))
rec('错误样式支持换行', /whiteSpace: 'pre-wrap'/.test(client))

// ── 3) 行为模拟：只读文件 → 回退 ──
const sandbox = mkdtempSync(join(tmpdir(), 'token-test-'))
const DATA_DIR = join(sandbox, 'data')
mkdirSync(DATA_DIR, { recursive: true })
const FALLBACK = join(DATA_DIR, 'token.txt')
const cfgTokenFile = join(sandbox, 'readonly.txt')

// 复现真实逻辑
function tokenFilePath(cfgFile, fallback) {
  const candidates = [cfgFile, fallback].filter(Boolean)
  let best = null, bestTime = -1
  for (const p of candidates) {
    try {
      const st = statSync(p)
      if (st.isFile() && st.size > 0 && st.mtimeMs > bestTime) { bestTime = st.mtimeMs; best = p }
    } catch { /* skip */ }
  }
  return best ?? cfgFile
}
function saveToken(value, cfgFile, fallback, dataDir) {
  try { writeFileSync(cfgFile, value, { mode: 0o600 }); return cfgFile } catch { /* fall */ }
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(fallback, value, { mode: 0o600 })
  return fallback
}

// 场景 A：正常可写 → 写原路径
{
  writeFileSync(cfgTokenFile, 'old', { mode: 0o600 })
  const where = saveToken('new-a', cfgTokenFile, FALLBACK, DATA_DIR)
  rec('可写时写原路径', where === cfgTokenFile, where === cfgTokenFile ? 'cfg' : 'fallback')
  rec('原路径内容更新', readFileSync(cfgTokenFile, 'utf8') === 'new-a')
}

// 场景 B：原路径是目录（模拟不可写）+ fallback 空 → 回退
{
  const dirAsFile = join(sandbox, 'is-a-dir')
  mkdirSync(dirAsFile, { recursive: true })
  const fb = join(sandbox, 'fb1.txt')
  const where = saveToken('new-b', dirAsFile, fb, sandbox)
  rec('不可写时回退到 fallback', where === fb, where)
  rec('fallback 内容正确', readFileSync(fb, 'utf8') === 'new-b')
}

// 场景 C：两个都存在时，读最新的那个
{
  const cfg2 = join(sandbox, 'cfg2.txt')
  const fb2 = join(sandbox, 'fb2.txt')
  writeFileSync(cfg2, 'from-cfg')
  writeFileSync(fb2, 'from-fallback')
  // 让 fallback 更新
  const now = Date.now() / 1000
  const fs2 = await import('node:fs')
  fs2.utimesSync(fb2, now + 10, now + 10)
  const picked = tokenFilePath(cfg2, fb2)
  rec('选最近修改的（fallback）', picked === fb2, picked === fb2 ? 'fallback' : 'cfg')
  rec('读到的值来自 fallback', readFileSync(picked, 'utf8') === 'from-fallback')
}

// 场景 D：只有 cfg 存在
{
  const cfg3 = join(sandbox, 'cfg3.txt')
  writeFileSync(cfg3, 'only-cfg')
  rec('只有 cfg 时用它', tokenFilePath(cfg3, join(sandbox, 'nope.txt')) === cfg3)
}

// 场景 E：都不存在 → 返回 cfg（后续会失败但仍给出一致的路径）
{
  const cfg4 = join(sandbox, 'missing.txt')
  rec('都不存在时返回 cfg 路径', tokenFilePath(cfg4, join(sandbox, 'nope2.txt')) === cfg4)
}

// 场景 F：空文件不算有效 token
{
  const cfg5 = join(sandbox, 'empty.txt')
  const fb5 = join(sandbox, 'fb5.txt')
  writeFileSync(cfg5, '')            // 空
  writeFileSync(fb5, 'real-token')   // 有内容
  rec('空文件被跳过，选有内容的', tokenFilePath(cfg5, fb5) === fb5)
}

rmSync(sandbox, { recursive: true, force: true })

const ok = results.every(Boolean)
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`)
setTimeout(() => process.exit(ok ? 0 : 1), 200)
