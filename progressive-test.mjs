/**
 * 渐进式表单测试（第二轮界面改造）
 *
 * 覆盖的都是「该出现的才出现」这一类规则，光看代码容易被三元套三元绕晕，
 * 所以拆成一条条独立断言：
 *   · 没密钥 → 只有 ①，②③④ 一个都不渲染
 *   · 选了隧道 → 才出现 ③ 本机端口
 *   · 端口确认可用 → 才出现 ④ 访问密码
 *   · ① 行：获取密钥紧跟输入框，行尾是保存按钮；「保存密钥并加载隧道」已删
 *   · 新建表单：名字/端口同排、自动 HTTPS 默认 auto、节点、创建
 *   · 日志：默认展开 + 展开期间定时刷新
 */
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
const index = readFileSync(new URL('./index.js', import.meta.url), 'utf8')

let pass = 0
let fail = 0
const rec = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ''}`) }
}

// ── 1) 四步的显示条件 ──
rec('有 showTunnel / showPort / showPassword 三个派生条件',
  /const showTunnel = Boolean\(st\.tokenConfigured\)/.test(client)
  && /const showPort = showTunnel && Boolean\(st\.tunnelId\)/.test(client)
  && /const showPassword = showPort && portReady/.test(client))

rec('② 隧道只在有密钥时渲染', /showTunnel \? h\('div', \{\}/.test(client))
rec('③ 本机端口只在选了隧道后渲染', /showPort \? h\('div', \{ style: S\.field \}/.test(client))
rec('④ 访问密码只在端口可用后渲染', /showPassword \? h\('div', \{ style: S\.field \}/.test(client))

rec('端口「可用」= 检测通过 或 网关已在监听',
  /const portReady = portOk \|\| Boolean\(gatePortNum && st\.gateRunning\)/.test(client))

rec('密码缺失警告也跟随 ④ 一起显示', /showPassword && !st\.gatePasswordConfigured/.test(client))

// ③④ 的渲染不再是无条件 h('div', { style: S.field }, ...)
const barePort = /^\s{8}h\('div', \{ style: S\.field \},\n\s+h\('div', \{\n\s+style: S\.flabel,\n\s+title: '穿透流量/m.test(client)
rec('③ 不再是无条件渲染', !barePort)

// ── 2) 到位的下一步提示 ──
rec('有分阶段提示 nextHint', /const nextHint = !showTunnel/.test(client))
rec('没密钥时提示「粘贴密钥 + 点右边保存」', /把管理面板里的访问密钥粘贴进来，点右边保存。/.test(client))
rec('没隧道时提示「选一条或新建」', /选一条隧道，或者点「新建」现建一条。/.test(client))
rec('有隧道没端口时提示「填端口」', /填个本机端口，确认可用后才会出现最后一步。/.test(client))

// ── 3) ① 行：获取密钥左移 + 行尾保存 ──
const tokenBlock = client.slice(
  client.indexOf("h('div', { style: S.field },\n          h('div', { style: S.flabel, title: 'SakuraFrp 管理面板"),
  client.indexOf('// ── ② 隧道 ──'),
)
rec('① 块能定位到', tokenBlock.length > 200, `${tokenBlock.length} 字符`)
rec('保存按钮嵌在输入框内（absolute + 右侧留白）',
  /position: 'absolute', right: '4px', top: '50%'/.test(tokenBlock)
  && /paddingRight: token\.trim\(\) \? '50px'/.test(tokenBlock))
rec('保存按钮只在输入框有内容时出现', /token\.trim\(\)\s*\n?\s*\? h\('button', \{/.test(tokenBlock))
rec('① 行尾不再有独立保存按钮', !/marginLeft: 'auto', padding: '5px 12px'/.test(tokenBlock))
rec('① 的保存走 saveAll', /onClick: saveAll/.test(tokenBlock))

// 「保存密钥并加载隧道」现在只是内嵌按钮的 title（鼠标悬停说明），不再是独立按钮
rec('「保存密钥并加载隧道」不作为按钮文案', !/'保存密钥并加载隧道'\)/.test(client))
rec('没有残留的 apply({ token: ... }) 快捷保存', !/apply\(\{ token: token\.trim\(\) \}\)/.test(client))

// ── 4) 保存逻辑收敛成一个 ──
rec('抽出 saveAll 统一保存', /const saveAll = \(\) => \{/.test(client))
rec('saveAll 只提交真填了的键', /if \(token\.trim\(\)\) patch\.token = token\.trim\(\)/.test(client))
rec('底部保存也走 saveAll（不重复实现）',
  (client.match(/onClick: saveAll/g) || []).length === 2,
  `${(client.match(/onClick: saveAll/g) || []).length} 处`)

// ── 5) ② 的按钮文案跟下拉框走 ──
rec('未选隧道时按钮叫「新建」', /newOpen \? '取消' : st\.tunnelId \? '＋ 新建' : '新建'/.test(client))

// ── 6) 新建表单 ──
const createBlock = client.slice(
  client.indexOf('// ── 新建隧道（内联表单，不跳页面）──'),
  client.indexOf('// 选了隧道但本机端口还空着'),
)
rec('新建表单块能定位到', createBlock.length > 500, `${createBlock.length} 字符`)
rec('名字 / 端口 / 节点 / 保存 挤在同一行',
  /display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap'/.test(createBlock)
  && createBlock.indexOf('value: newName') < createBlock.indexOf('value: newPort')
  && createBlock.indexOf('value: newPort') < createBlock.indexOf('value: newNode')
  && createBlock.indexOf('value: newNode') < createBlock.indexOf("busy ? '创建中…' : '保存'"))
rec('名字默认留空（靠 placeholder 提示）', /placeholder: '名字（留空叫 DSH）'/.test(createBlock))
rec('名字输入框不预填 DSH', !/value: newName, placeholder: 'DSH'/.test(client))
// 只看标签字符串，不看注释：注释里提到「自动 HTTPS」是为了说明它为什么不出现
rec('表单里不出现「自动 HTTPS」选项', !/'自动 HTTPS'/.test(createBlock))
rec('自动 HTTPS 固定传 auto（不给用户选）', /autoHttps: 'auto'/.test(client))
rec('不再有 autoHttps 的 state 与 onChange',
  !/const \[autoHttps/.test(client) && !/setAutoHttps/.test(client))

// ── 7) 官方提醒能关掉 ──
rec('alignMsg 带「关闭」按钮', /onClick: \(\) => setAlignMsg\(''\)/.test(client))
rec('关闭按钮文案是「关闭」', /\}, '关闭'\)\)/.test(client))

// ── 8) 域名提示里的链接调整 ──
rec('「子域绑定」外链已删除', !client.includes("'子域绑定 ↗'"))
rec('句中的「绑定子域名」不再是链接', !/'绑定子域名'\)/.test(client))
rec('「绑定教程」挪到域名提示句末',
  // 不锁具体措辞，只要求它跟在提示句的句号之后、且是这一段里最后的外链
  /消除。', ' ',\n\s+h\(ExternalLink, \{\n\s+href: 'https:\/\/doc\.natfrp\.com\/bestpractice\/domain-bind\.html'/.test(client))
rec('标题栏不再有外链', !/h\(div, \{ style: S\.label \}, '连接设置'\),\n\s+h\(div, \{\n\s+style: \{ display: 'flex', gap: '12px'/.test(client))

// ── 9) 日志：默认展开 + 实时刷新 ──
rec('日志默认展开', /const \[logsOpen, setLogsOpen\] = useState\(true\)/.test(client))
rec('日志展开时定时拉取', /const t = setInterval\(\(\) => void pullLogs\(\), 2000\)/.test(client))
rec('收起后停掉定时器', /if \(!logsOpen\) return undefined/.test(client))
rec('展开/收起只切状态，不再单次拉取', /onClick: \(\) => setLogsOpen\(\(v\) => !v\)/.test(client))
rec('旧的 loadLogs 已移除', !client.includes('const loadLogs ='))
rec('日志限高（默认展开才不会把面板撑爆）', /maxHeight: '220px', overflowY: 'auto'/.test(client))
rec('新日志自动滚到底', /if \(el && logPinned\.current\) el\.scrollTop = el\.scrollHeight/.test(client))
rec('往上翻旧日志时不被抢滚动条', /logPinned\.current = el\.scrollHeight - el\.scrollTop - el\.clientHeight < 40/.test(client))

// ── 10) 服务端：auto_https 写进 extra ──
rec('服务端解析 autoHttps 并白名单校验',
  /const autoHttps = \['auto', 'on', 'off'\]\.includes\(String\(patch\.autoHttps\)\)/.test(index))
rec('服务端拼成 extra: auto_https = <v>', /const extra = `auto_https = \$\{autoHttps\}`/.test(index))
rec('建隧道时带上 extra', /note: '由 dsh-sakurafrp 创建',\n\s+extra,/.test(index))

// ── 11) 端口自动检测（④ 的显示依赖它） ──
rec('端口变了才自动检测', /if \(autoChecked\.current === p\) return/.test(client))
rec('自动检测只在有隧道时跑', /if \(!st\?\.tokenConfigured \|\| !st\?\.tunnelId\) return/.test(client))

// ── 12) 在隧道列表里改选 → 新建表单自动收起 ──
rec('新建表单展开时改选隧道会自动收起',
  /if \(newOpen\) \{ setNewOpen\(false\); setCreateErr\(''\) \}[\s\S]{0,120}?apply\(\{ tunnelId: e\.target\.value \}\)/.test(client))

console.log(`\n${pass}/${pass + fail} passed`)
setTimeout(() => process.exit(fail === 0 ? 0 : 1), 200)
