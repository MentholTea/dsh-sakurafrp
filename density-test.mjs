// density-test.mjs — 设置页「挤」到什么程度，用像素说话
//
// 背景：用户反馈「界面占用太大，挤一挤」。间距这类问题正则抓不到，
// 只能真排版再量。这里做两层检查：
//   1) 结构断言：标题/控件是否并成一行、间距是否回到统一入口（wrap 的 gap）
//   2) 真实像素：用无头浏览器渲染 preview-render.mjs 的产物，量出面板高度
//      超过预算就失败 —— 防止以后又悄悄长回去。
//
// 依赖：本机有 Edge 或 Chrome（没有则跳过像素部分，结构断言照跑）。
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const results = []
const rec = (n, p, d = '') => { results.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`) }
const skip = (n, why) => { results.push(true); console.log(`SKIP  ${n} — ${why}`) }

const here = dirname(fileURLToPath(import.meta.url))
const client = readFileSync(resolve(here, 'client.js'), 'utf8')

// ── 1) 结构：三行一组的字段压成一行 ──
rec('wrap 间距 ≤ 10px（间距统一由 wrap 控）', /wrap: \{ padding: '[^']*', display: 'flex', flexDirection: 'column', gap: '([0-9]|10)px' \}/.test(client))
rec('hint 默认不再压 margin（≤1px）', /hint: \{[^}]*marginTop: '0?1px'/.test(client))
rec('表单行用 grid 两列（标题 | 控件）', /field: \{\s*display: 'grid', gridTemplateColumns: '\d+px minmax\(0, 1fr\)'/.test(client))

// 字段本体：① / ② / ③ / ④ 四个带标签的行用同一套「标题 | 控件」网格。
// 新建隧道表单不算在内 —— 它把名字/端口/节点/保存压成一整行，用的是纯 flex，
// 挤进 138px 的标签列反而放不下。
const fieldUses = (client.match(/style: S\.field/g) || []).length
rec('四个带标签的字段都用单行版式', fieldUses >= 4, `${fieldUses} 处`)

// 旧版式是「label / hint / input」三层，这里不允许再出现
const legacy = /h\('div', \{ style: S\.label \}, '① SakuraFrp 访问密钥'\)[\s\S]{0,120}?S\.hint/.test(client)
rec('① 不再有「标题 + 说明」两层再跟输入框', !legacy)

// 状态区：原来「内网穿透 / frpc 状态 / 本机端口」三行标题
rec('三个状态徽标并在一行', /S\.badge\(frpc\.running\)[\s\S]{0,220}?S\.badge\(st\.gateRunning\)/.test(client))
// 分区标题行不再挂任何外链：「子域绑定」已删，「绑定教程」挪到域名提示句末
rec('分区标题行不再挂域名链接', !/连接设置'\)[\s\S]{0,420}?子域绑定/.test(client))
rec('绑定教程挂在域名提示句末', /消除。[\s\S]{0,300}?绑定教程 ↗/.test(client))
// 分割线只留状态区与配置区之间那一条，多出来的都在吃高度
rec('分割线最多 1 条', (client.match(/style: S\.divider/g) || []).length <= 1,
  `${(client.match(/style: S\.divider/g) || []).length} 条`)

// ── 2) 真实像素：渲染后量高度 ──
const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]
const browser = BROWSERS.find((p) => existsSync(p))

/** 渲染某个状态，返回面板内容的像素高度 */
function measure(variant) {
  const out = join(tmpdir(), `dsh-sakurafrp-density-${variant}.html`)
  execFileSync(process.execPath, [resolve(here, 'preview-render.mjs'), out], {
    cwd: here,
    env: { ...process.env, PREVIEW_VARIANT: variant },
    stdio: 'ignore',
  })
  const dom = execFileSync(browser, [
    '--headless=new', '--disable-gpu', '--dump-dom',
    `file:///${out.replace(/\\/g, '/')}`,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const m = dom.match(/HEIGHT=(\d+)/)
  return m ? Number(m[1]) : null
}

// 预算按 560px 宽面板量出来的实际值定的，留一点余量：
// 撑破就说明又回到「标题 / 说明 / 输入框」三层或者间距被调回去了。
const BUDGET = { ready: 540, fresh: 530 }

if (!browser) {
  skip('已配置状态高度在预算内', '未找到 Edge/Chrome')
  skip('首次使用状态高度在预算内', '未找到 Edge/Chrome')
} else {
  for (const variant of ['ready', 'fresh']) {
    const px = measure(variant)
    const ok = px !== null && px <= BUDGET[variant]
    rec(`${variant === 'ready' ? '已配置' : '首次使用'}状态高度 ${px}px ≤ ${BUDGET[variant]}px`, ok, px === null ? '没读到高度' : '')
  }
}

const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} passed`)
setTimeout(() => process.exit(passed === results.length ? 0 : 1), 200)
