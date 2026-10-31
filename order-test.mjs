// order-test.mjs — 设置页的填写顺序、按钮位置、用词是否说人话
//
// 用户历次反馈（每一条都对应下面的断言，改回去就会红）：
//   1. 「按顺序向下填完，还要回到最上面去更新隧道」→ 隧道排在密钥之后、端口之前
//   2. 「他说什么『对齐』，我不太明白」       → 界面文案里不许出现这个词
//   3. 「④ 隧道 移到第二个位置」              → 顺序 = 密钥 → 隧道 → 端口 → 密码
//   4. 「访问密钥最后面要有清除按钮 / 附近要获取密钥」
//   5. 「隧道名称最后的『离线』删掉，没啥用」
//   6. 「选节点时在后方显示空闲状态，并用颜色」
//
// 这类问题不会被语法错误或单元测试抓到，只能对源码做结构断言。
const results = []
const rec = (n, p, d = '') => { results.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`) }

import { readFileSync } from 'node:fs'
const client = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
const index = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8')

/** 取 Panel() 渲染区（从 return h('div', { style: S.wrap } 起）用于判断视觉顺序 */
const panelSrc = client.slice(client.indexOf("h('div', { style: S.wrap }"))
const pos = (needle) => panelSrc.indexOf(needle)

// ── 1) 填写顺序：密钥 → 隧道 → 端口 → 密码 → 保存 ──
const pToken = pos('① SakuraFrp 访问密钥')
const pTunnel = pos('② 隧道')
const pPort = pos('③ 本机端口')
const pPwd = pos('④ 访问密码')
// 保存入口现在有两处：① 右侧（主）和表单底部（次级）。
// 判断「密码之后还能存」要看最后那个，不能用第一个。
const pSave = panelSrc.lastIndexOf("busy ? '保存中…' : '保存'")

rec('① 访问密钥存在', pToken > 0, String(pToken))
rec('② 隧道存在', pTunnel > 0, String(pTunnel))
rec('③ 本机端口存在', pPort > 0, String(pPort))
rec('④ 访问密码存在', pPwd > 0, String(pPwd))

rec('密钥排在最前（隧道列表靠它才拉得到）', pToken > 0 && pToken < pTunnel)
rec('隧道排在端口之前（选完隧道端口自动跟随）', pTunnel > 0 && pTunnel < pPort, `tunnel=${pTunnel} port=${pPort}`)
rec('端口排在密码之前', pPort > 0 && pPort < pPwd)
rec('密码排在保存之前', pPwd > 0 && pPwd < pSave)
rec('旧编号不再出现（② 本机端口 / ④ 隧道 已对调）',
  !panelSrc.includes('② 本机端口') && !panelSrc.includes('③ 访问密码'))

// ── 2) ① 访问密钥：末尾清除 + 附近获取密钥 ──
const tokenBlock = client.slice(client.indexOf("'① SakuraFrp 访问密钥'"), client.indexOf('// ── ② 隧道 ──'))
rec('① 有「清除」按钮', /'清除'/.test(tokenBlock))
rec('清除走 clearToken（服务端能真的删干净）', /apply\(\{ clearToken: true \}\)/.test(tokenBlock))
rec('清除会同步清空本地隧道列表', /setTunnels\(\[\]\)/.test(tokenBlock))
rec('① 附近有「获取密钥」入口', /获取密钥 ↗/.test(tokenBlock))
rec('获取密钥指向官方用户页', /'https:\/\/www\.natfrp\.com\/user\/'/.test(tokenBlock))
rec('获取密钥是外链组件（桌面端也能开内置标签）', /h\(ExternalLink, \{\s*\n?\s*href: 'https:\/\/www\.natfrp\.com\/user\/'/.test(tokenBlock))

// ── 3) ② 隧道：不再拼「离线」 ──
rec('隧道下拉不再拼「离线」', !/\$\{t\.online \? '' : ' · 离线'\}/.test(client))
rec('隧道下拉只留 名字 · 节点', /`\$\{t\.name\} · \$\{t\.nodeName\}`/.test(client))

// ── 4) 节点：空闲状态 + 颜色 ──
rec('有节点状态判定函数', /function nodeStatus\(n\)/.test(client))
rec('状态分四档（空闲/一般/拥挤/满载）',
  /空闲/.test(client) && /一般/.test(client) && /拥挤/.test(client) && /满载/.test(client))
rec('状态文字写进 option（原生 option 无法着色）',
  /\$\{can \? st2\.text : '不可新建'\}/.test(client))
rec('颜色按档位给（绿/黄/橙/红）',
  /#16a34a/.test(client) && /#d97706/.test(client) && /#ea580c/.test(client) && /#dc2626/.test(client))
rec('拿不到负载时不冒充空闲', /没有|未知/.test(client) && /load < 0/.test(client))
rec('满载节点在下拉里禁用', /value: String\(n\.id\), disabled: !can/.test(client))
rec('节点用原生 select（一行放得下几十个）', /h\('select', \{[\s\S]{0,400}?— 选择节点 —/.test(client))

// ── 5) 端口：填完检测 + 双向同步 ──
rec('后端有端口检测端点', /path === '\/natfrp\/api\/port\/check'/.test(index))
rec('前端填完就查（onBlur 触发）', /onBlur: \(\) => void checkPort\(gatePort\)/.test(client))
rec('查完给「可以用 / 被占用」的结论', /端口 \$\{n\} 可以用/.test(client) && /已被其它程序占用/.test(client))
rec('服务端改端口前先试绑（绑不上不改）', /const free = await checkPortFree\(n\)/.test(index))
rec('端口被占用时明确报错而不是静默失败', /error: 'port-in-use'/.test(index))
rec('改端口会把隧道里的端口一起改（to-panel）', /direction: 'to-panel'/.test(index))
rec('选隧道时本机端口跟随隧道（to-local）', /direction: 'to-local'/.test(index))
rec('有 adoptTunnelPort 实现', /async function adoptTunnelPort\(api\)/.test(index))
rec('隧道端口被占时反向往面板写，不一味失败', /blockedPort/.test(index))
rec('同步结果回给界面', /portSync/.test(index) && /setSyncMsg\(describeSync\(s\.portSync\)\)/.test(client))
rec('同步结论区分两个方向的说法',
  /已把本机端口改成/.test(client) && /已把隧道里的端口改成/.test(client))

// ── 6) 新建隧道：表单里带端口，建完端口两边一致 ──
rec('新建表单里有端口输入', /const \[newPort, setNewPort\]/.test(client))
rec('创建请求带 port', /port: p,/.test(client))
rec('后端接受 patch.port', /patch\.port === undefined/.test(index))
rec('后端用这个端口建隧道', /local_port: gatePort/.test(index))
rec('创建成功提示端口已同步', /本机端口也已同步/.test(client))
rec('节点列表懒加载（展开才拉）', /const openCreate = async \(\) => \{[\s\S]{0,500}?getJSON\('\/nodes'\)/.test(client))
rec('创建成功后重拉列表与状态', /await Promise\.all\(\[loadExtra\(\), loadState\(\)\]\)/.test(client))

// ── 7) 界面文案不许出现「对齐」「网关」这种内部词 ──
function uiStrings(src) {
  return src.split('\n').filter((line) => {
    const t = line.trim()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false
    return true
  })
}
const uiLines = uiStrings(client)
const badAlign = uiLines.filter((l) => l.includes('对齐'))
const badGateway = uiLines.filter((l) => l.includes('网关'))
rec('界面代码行里没有「对齐」', badAlign.length === 0, badAlign[0]?.trim().slice(0, 60) ?? '')
rec('界面代码行里没有「网关」', badGateway.length === 0, badGateway[0]?.trim().slice(0, 60) ?? '')
rec('源码保留「为什么不用对齐」的说明', /不出现「对齐」/.test(client))

// ── 8) 端口真不一致时（在官方面板改过）仍有出口 ──
rec('不一致时按钮写明改什么', /把隧道端口改成 \$\{gatePortNum\}/.test(client))
rec('不一致时说明后果', /外网会打不开/.test(client))
rec('隧道端口做了 NaN 防护', /Number\.isFinite\(Number\(pickedTunnel\.local_port\)\)/.test(client))

// ── 9) 互踢提示里说的按钮必须真实存在 ──
rec('有 doRestart 实现', /const doRestart = async \(\) => \{/.test(client))
rec('doRestart 走 stop → start', /post\('\/stop'\)[\s\S]{0,200}?post\('\/start'\)/.test(client))
rec('互踢警告里有「重启」按钮', /kickSuspect[\s\S]{0,900}?onClick: doRestart/.test(client))

// ── 10) 后端日志也不再讲「对齐」 ──
rec('后端日志改为「改隧道端口」', /已把隧道 \$\{tunnelId\} 的端口从/.test(index))
rec('后端失败日志改为「改隧道端口失败」', /改隧道端口失败/.test(index))
rec('后端不再输出「对齐报告」', !/对齐报告/.test(index))

// ── 11) 安装后默认关闭 ──
rec('默认 enabled=false（装上就是关的）',
  /typeof state\.enabled === 'boolean' \? state\.enabled : config\.enabled === true/.test(index))
rec('不再有「默认开启」的旧写法', !/state\.enabled \?\? config\.enabled !== false/.test(index))

// ── 12) 文档同步 ──
rec('README 首次使用按新顺序（密钥→隧道→端口→密码）',
  /① 访问密钥[\s\S]{0,900}?② 隧道[\s\S]{0,900}?③ 本机端口[\s\S]{0,900}?④ 访问密码/.test(readme))
rec('README 说明四步是逐步解锁的', /逐步解锁/.test(readme))
rec('README 说明日志默认展开且实时刷新', /日志默认展开/.test(readme))
rec('README 不再叫「一键对齐」', !/一键对齐/.test(readme))

// ── 13) 刷新列表按钮去掉，改为选中/新建时自动刷新 ──
rec('隧道区不再有「刷新列表」按钮', !/刷新列表/.test(client))

const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} passed`)
setTimeout(() => process.exit(passed === results.length ? 0 : 1), 200)
