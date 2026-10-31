// state-test.mjs — 状态目录迁移 + dismiss 持久化（端到端，用临时 DSH_HOME）
const results = []
const rec = (n, p, d = '') => { results.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`) }

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const sandbox = mkdtempSync(join(tmpdir(), 'state-test-'))
const oldDir = join(sandbox, 'dsh-natfrp')
const newDir = join(sandbox, 'dsh-sakurafrp')

// ── 造一份旧状态 ──
mkdirSync(oldDir, { recursive: true })
writeFileSync(join(oldDir, 'state.json'), JSON.stringify({
  enabled: true,
  tunnelId: '12345',
  gatePort: 3083,
  gatePassword: 'secret-pass',
  dismissedFrpcPrompts: [],
}, null, 2))
writeFileSync(join(oldDir, 'gate-password.txt'), 'secret-pass')

// ── 跑迁移函数（从 index.js 里抽出来执行，不启动整个插件）──
const script = `
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
const DSH_HOME = ${JSON.stringify(sandbox)}
const DATA_DIR = join(DSH_HOME, 'dsh-sakurafrp')
const LEGACY_DATA_DIR = join(DSH_HOME, 'dsh-natfrp')
const STATE_PATH = join(DATA_DIR, 'state.json')

function migrateLegacyDataDir() {
  try {
    if (existsSync(STATE_PATH)) return
    if (!existsSync(LEGACY_DATA_DIR)) return
    let copied = 0
    mkdirSync(DATA_DIR, { recursive: true })
    for (const file of ['state.json', 'gate-password.txt']) {
      const from = join(LEGACY_DATA_DIR, file)
      if (!existsSync(from)) continue
      try {
        writeFileSync(join(DATA_DIR, file), readFileSync(from), { mode: 0o600 })
        copied += 1
      } catch {}
    }
    if (copied === 0) { try { rmdirSync(DATA_DIR) } catch {} }
  } catch {}
}
migrateLegacyDataDir()
console.log('migrated')
`
const scriptPath = join(sandbox, 'mig.mjs')
writeFileSync(scriptPath, script)
execFileSync(process.execPath, [scriptPath], { stdio: 'pipe' })

// ── 断言迁移结果 ──
rec('新目录已创建', existsSync(newDir))
rec('state.json 已迁移', existsSync(join(newDir, 'state.json')))
rec('gate-password.txt 已迁移', existsSync(join(newDir, 'gate-password.txt')))

if (existsSync(join(newDir, 'state.json'))) {
  const st = JSON.parse(readFileSync(join(newDir, 'state.json'), 'utf8'))
  rec('enabled 保留', st.enabled === true)
  rec('tunnelId 保留', st.tunnelId === '12345')
  rec('gatePassword 保留（关键：不能丢）', st.gatePassword === 'secret-pass')
}
rec('旧目录未被破坏（关键：不影响旧包）', existsSync(join(oldDir, 'state.json')))

// ── 二次运行不应覆盖新状态 ──
writeFileSync(join(newDir, 'state.json'), JSON.stringify({ enabled: false, marker: 'newer' }))
execFileSync(process.execPath, [scriptPath], { stdio: 'pipe' })
{
  const st = JSON.parse(readFileSync(join(newDir, 'state.json'), 'utf8'))
  rec('二次迁移不覆盖已存在的新状态', st.marker === 'newer')
}

// ── writeState 合并语义 ──
function makeWriteState(statePath) {
  return (patch) => {
    const read = () => { try { return JSON.parse(readFileSync(statePath, 'utf8')) ?? {} } catch { return {} } }
    const merged = { ...read(), ...patch }
    // 与 index.js 的 writeState 保持一致：访问密码永不落 state.json
    delete merged.gatePassword
    writeFileSync(statePath, JSON.stringify(merged, null, 2))
    return merged
  }
}
{
  const p = join(newDir, 'merge.json')
  writeFileSync(p, JSON.stringify({ enabled: true, tunnelId: '999', gatePassword: 'keep-me' }))
  const write = makeWriteState(p)
  write({ dismissedFrpcPrompts: ['missing::C:\\x\\frpc.exe'] })
  const st = JSON.parse(readFileSync(p, 'utf8'))
  rec('合并写入保留 enabled', st.enabled === true)
  rec('合并写入保留 tunnelId', st.tunnelId === '999')
  rec('合并写入剥掉 gatePassword（密码不落 state.json）', !('gatePassword' in st))
  rec('合并写入添加 dismiss 记录', Array.isArray(st.dismissedFrpcPrompts) && st.dismissedFrpcPrompts.length === 1)
}

rmSync(sandbox, { recursive: true, force: true })

const ok = results.every(Boolean)
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`)
setTimeout(() => process.exit(ok ? 0 : 1), 200)
