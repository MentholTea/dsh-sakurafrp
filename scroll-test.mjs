// scroll-test.mjs — 验证 main 面板的滚动容器链完整
// 不依赖真实 DOM：直接审视组件产出的 style 是否满足「可滚动」的必要条件

const results = []
const rec = (n, p, d = '') => { results.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`) }

// ── 提取 NatfrpMainPanel 源码并静态断言 ──
import { readFileSync } from 'node:fs'
const src = readFileSync(new URL('./client.js', import.meta.url), 'utf8')

function grab(fnName) {
  const start = src.indexOf(`function ${fnName}(`)
  if (start < 0) return null
  // 朴素括号配平，取完整函数体
  let depth = 0; let i = src.indexOf('{', start)
  const from = i
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(from, i + 1)
}

const mainPanel = grab('NatfrpMainPanel')
rec('找到 NatfrpMainPanel', mainPanel !== null)

if (mainPanel) {
  // 1) 外壳必须让「可滚动区」拿到有界高度：height:100% + minHeight:0 + flex 列 + overflow hidden
  rec('外壳 height:100%', /height:\s*'100%'/.test(mainPanel))
  rec('外壳 minHeight:0（否则 flex 子项按内容撑高，overflow 永不触发）', /minHeight:\s*0/.test(mainPanel))
  rec('外壳 flex 列', /flexDirection:\s*'column'/.test(mainPanel))
  rec('外壳 overflow hidden（边界裁切，滚动交给内层）', /overflow:\s*'hidden'/.test(mainPanel))

  // 2) 内层必须真正可滚
  rec('内层 flex:1', /flex:\s*'1 1 auto'/.test(mainPanel))
  rec('内层 overflowY:auto', /overflowY:\s*'auto'/.test(mainPanel))
  rec('内层 minHeight:0', (mainPanel.match(/minHeight:\s*0/g) || []).length >= 2)

  // 3) 内层有 padding（内容不贴边）且书箱模型正确
  rec('内层 padding', /padding:\s*'28px 24px 24px'/.test(mainPanel))
  rec('boxSizing border-box', (mainPanel.match(/boxSizing:\s*'border-box'/g) || []).length >= 2)

  // 4) 兼容 Windows 标题栏（否则顶部内容会被拖拽区盖住）
  rec('顶部避让 titlebar', /--dsh-frame-top-clearance/.test(mainPanel))
}

// ── 日志区不应有嵌套滚动 ──
const logsBlock = src.slice(src.indexOf('// ── 日志 ──'), src.indexOf('// ── 侧边栏图标'))
rec('日志不再 maxHeight 裁切', !/maxHeight:\s*'260px'/.test(logsBlock), logsBlock ? '' : '未找到日志段')
rec('日志改 overflow:visible', /overflow:\s*'visible'/.test(logsBlock))
rec('日志提供新窗口打开（长日志兜底）', /在新窗口打开/.test(logsBlock))

const ok = results.every(Boolean)
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`)
process.exit(ok ? 0 : 1)
