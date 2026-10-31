# dsh-sakurafrp

DeepSeek Harness 内建的内网穿透面板——**替代 SakuraFrp 启动器**。
同一台机器上装了本插件后，不需要再开 SakuraLauncher。

> [!WARNING]
> **本插件是「与 AI 对话协作」的产物。** 代码与文档由作者与 AI（DeepSeek Harness 会话）
> 多轮对话生成并反复迭代而来，**没有经过人工逐行审计**，实测环境也仅限于作者本机的
> Windows + WSL2。请自行审阅源码后再使用；涉及安全敏感场景时请格外谨慎。
> 代码按 MIT「按原样（AS IS）」提供，不附带任何担保，风险自负。
>
> 与「AI 生成即不可靠」无关的部分：**测试是可复核的**。`npm test` 是 22 个套件、597 项
> 全离线的断言，其中 `admin-auth-test.mjs` 专门覆盖网关鉴权（8 种路径花招、WS 同权、
> 改密后旧 cookie 失效）。数字与结论都能自己跑一遍验证，不必只信这段说明。

---

## 第一步：装上并连上（四步，约 5 分钟）

只要你是第一次用，照这四步走就行。**这四步在界面上是逐步解锁的**：上一步没到位，
下一步不会出现，所以不会一上来就被一堆选项淹没。

**0. 装插件**

```powershell
dsh plugin --profile desktop add dsh-sakurafrp -w
# web / CLI 场景把 --profile 换成你的 profile 名，例如 --profile web
```

> **装不上就换这条**（不经过 npm，直接取 GitHub Release 的预构建包）：
>
> ```powershell
> dsh plugin --profile desktop add https://github.com/MentholTea/dsh-sakurafrp/releases/latest/download/dsh-sakurafrp.tgz -w
> ```
>
> 两条命令装的是同一个版本，功能完全一样。

重启 DSH。若设置页提示未装 frpc，点一次「一键安装」——插件会按平台/架构自动下载。

**1. 拿访问密钥**

到 SakuraFrp 面板 → 用户信息 → 查看访问密钥，复制。
在设置页 **① 访问密钥** 粘进去，点输入框右侧的「保存」。

**2. 选隧道**

密钥保存后出现 **② 隧道**。下拉选一条已有的；**一条都没有就点「新建」**，
选个节点（后面标着空闲/一般/拥挤）、填个端口，远端端口交给官方分配。

**3. 填本机端口**

出现 **③ 本机端口**。新装是空的，**必须自己填**——填完立刻检测能不能用。
选了已有隧道的话这里会自动填好。

**4. 设公网密码**

端口可用后出现 **④ 访问密码**。**强烈建议 20 位以上随机串**，未设密码时外网一律拒绝。

最后点「保存」→ 打开顶部开关 → 手机访问隧道公网地址 → 输密码 → 完整 DSH 界面。

> **两个容易踩的点**
>
> - **插件装上默认是关闭的，端口也是空的。** 这东西的作用就是把 DSH 暴露到公网，
>   装完就该先关着；而不预填端口是因为那等于替你决定了「用这个数字、它现在空闲、
>   且要写进隧道里」三件都可能不成立的事。
> - **一定要绑定子域名走 HTTPS。** 用默认域名 `xxx.nyat.app` 直接访问会撞证书警告，
>   部分浏览器点「继续」后还会白屏。绑定方法见文末[证书警告与白屏问题](#证书警告与白屏问题重要)——
>   这也是密码不被中间人截获的前提。

---

## 它长什么样

- 设置页入口：**设置 → 内网穿透 (SakuraFrp)**
- 侧边栏入口：左侧面板列表里的「内网穿透」，带**三色状态点**（🟢已连接 / 🟡未连接 / 🔴故障）
  和一键启停**开关**（🟢开 / 🔴关）；折叠成图标栏时状态点回到图标右上角

---

## 功能清单

- **frpc 全托管**：DSH 启动即拉起、退出即停止、崩溃指数退避重连（1s→2s→…→60s 封顶）
- **密钥零泄漏**：token 经 `NATFRP_TOKEN` 环境变量传递，不出现在 argv / 进程列表
- **隧道面板**：API v4 拉取隧道列表（带节点名），下拉直接切换；选完本机端口自动跟随隧道
- **本地新建隧道**：手上一条隧道都没有时，选个节点就能建——固定 TCP 类型、
  表单里的端口同时作为本机端口、远程端口交给官方分配，不用先有域名和解析；
  节点列表带实时负载（空闲/一般/拥挤/满载，颜色区分），满载的置灰不给选
- **端口双向同步**（`autoAlign` / `adoptTunnelPort`）：改端口前先试绑，绑得上才改；
  改完把面板里那条隧道的 `local_port` 一起改过去。反过来，只是选了条隧道时，
  本机端口跟着隧道走——根治「隧道连上了但访问 502」
- **互踢检测**：30s 窗口内断线 ≥6 次判定「疑似互踢」（SakuraLauncher 或其它机器
  连了同一条隧道），状态页醒目告警
- **侧边栏状态点 + 开关**：点管连通（绿/黄/红），开关管启停（红/绿），互不干扰；
  开关点击即时反馈（乐观更新），以服务端返回为准
- **流量面板**：本日已用 / 剩余流量 + **剩余百分比**（绿→橙→红三档）；
  百分比基于 `data_plans` 的真实总量，不是用「今日+剩余」硬凑的分母
- **公网密码门**：HMAC 签名 cookie、常量时间比较、按 IP 失败锁定（5 次锁 60s），
  登录页零外部依赖，登录成功后回到访客原本想去的地址（仅接受站内路径，防开放重定向）
- **Host 围栏反代**：改写 Host/Origin/Referer/Sec-Fetch-Site 为回环权威，
  透传 WebSocket upgrade，注入非安全上下文 polyfill（crypto.randomUUID / AbortSignal.any）
- **DSH 二次认证**：实时取 `ctx.connection.authenticatedUrl()` 的 launch token，
  首次 HTML 导航自动补 `?token=`
- **桌面/浏览器通吃**：外链在 Electron 里走宿主内置浏览器标签，浏览器里走新标签页

`frpc 日志默认展开，并且每 2 秒刷新一次`，不用收起再展开才看到新内容。

---

## 架构

```
Web 设备 → xxx.nyat.app:端口 → SakuraFrp 节点 → frpc(本插件托管)
                                              → 127.0.0.1:<gatePort> 网关
                                                ├─ /natfrp/*  管理路由（需密码门 cookie）
                                                ├─ 密码门（HMAC cookie / ?gate=）
                                                └─ Host 围栏反代 + WS 透传
                                                  → 127.0.0.1:<dshPort> DSH WebServer
```

---

## 安装（详细）

**方式 A：从 npm 装**（推荐）

```powershell
dsh plugin --profile desktop add dsh-sakurafrp -w
# web / CLI 场景把 --profile 换成你的 profile 名，例如 --profile web
# 然后重启 DSH
```

> 装完请确认 `dsh.profile.bundles` 里有 `dsh-sakurafrp`——没有这一条，DSH 不会加载插件。
> 正常情况会自动写入；若你看到安装过程报错退出（例如别的插件的构建脚本未获批准），
> 这一步会被跳过，需要手工补上。

**方式 A2：从 Release tarball 装**（不走 npm，也不需要构建，与方式 A 同版本）

```powershell
dsh plugin --profile desktop add https://github.com/MentholTea/dsh-sakurafrp/releases/latest/download/dsh-sakurafrp.tgz -w
```

**方式 B：从源码装**（不依赖 npm）

```powershell
git clone https://github.com/MentholTea/dsh-sakurafrp.git
# 在 profile 的 package.json 里：
#   "dependencies": { "dsh-sakurafrp": "link:<克隆目录绝对路径>" }
# 并把 "dsh-sakurafrp" 加进 dsh.profile.bundles
dsh plugin --profile desktop install
```

**装完还要做两件事**（frpc 二进制不会被 npm 包携带）：

1. 打开设置页，若提示未装 frpc，点「一键安装」即可——插件会自动按平台/架构从官方
   接口挑包，下到 `~/.dsh/dsh-sakurafrp/frpc-standalone(.exe)`
   （也可以自己下好放到同一路径，或把 `frpcPath` 指到任意位置）
2. 重启 DSH → 设置页填访问密钥 → 下拉选隧道 → 设公网密码

frpc 默认取 `~/.dsh/dsh-sakurafrp/frpc-standalone(.exe)`；旧版本放在
`~/.dsh/bin/` 的会被继续沿用，不必重下。`frpc -V` 输出应含 `sakura`。

---

## 首次使用（完整说明）

上面「第一步」是精简版。这里补上每一步的细节和判断依据。

1. 重启 DSH 后，设置页出现「内网穿透 (SakuraFrp)」区块；若提示未装 frpc，先点「一键安装」
2. **① 访问密钥**：这是唯一的必填项。点「获取密钥」→ 用户信息 → 查看访问密钥，粘贴进来，
   输入框右侧会出现「保存」，点它即可。想换掉已保存的密钥，点同一个字段后面的「清除」。
   ⚠️ 没填密钥之前，下面三步**根本不会出现** —— 密钥都没有，隧道列表也拉不到，
   摆出来只是给人添堵。
3. **② 隧道**（密钥保存后出现）：下拉选一条，或者点右边的「新建」现建一条。
   新建表单里一行放完：名字、端口、节点（下拉框，后面标着空闲/一般/拥挤）、保存。
   名字可以留空（就叫 DSH），建完自动选中。
   （自动 HTTPS 固定用「自动」，不在界面上让选 —— 新建的都是 TCP 隧道，这一项对它不起作用。）
4. **③ 本机端口**（选了隧道后出现）：**新装是空的，必须自己填**（插件不会替你猜一个）。
   填完立刻检测这个端口能不能用；保存时会把 SakuraFrp 面板里这条隧道的端口一起改掉。
   选了已有隧道的话，这里会自动填成隧道里写的端口，不用手动对。
5. **④ 访问密码**（端口确认可用后才出现）：**强烈建议 20 位以上随机串**。
   未设密码时外网一律拒绝，不会直通。
6. 点「保存」→ 打开顶部开关
7. 手机访问隧道公网地址 → 输密码 → 完整 DSH 界面（WebSocket 流式同步）

> 四步是**逐步解锁**的，不是一开始全摊在面前：密钥 → 隧道 → 端口 → 密码，
> 上一步没到位，下一步就不出现。旁边那句提示会告诉你当前只差哪一步。
>
> **插件装上默认是关闭的，端口也是空的**，需要自己填端口、开开关。原因很直接：
> 这东西的作用是把 DSH 暴露到公网，装完就该先关着；而预填一个端口等于替你决定了
> 「用这个数字、它现在空闲、且要写进隧道里」三件都可能不成立的事。
>
> 新建的隧道会把「本地端口」写成表单里那个端口，远程端口由官方分配；
> 之后改了本机端口，会把面板里那条隧道的端口一起改过去，不用回面板手动同步。

**frpc 日志默认展开，并且每 2 秒刷新一次**，不用收起再展开才看到新内容。

---

## 配置（cordis.patch.yml → config）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 插件启用（设置页可改，持久化到 state.json）。新装默认关闭，避免装完就把 DSH 挂上公网 |
| `frpcPath` | `~/.dsh/dsh-sakurafrp/frpc-standalone(.exe)` | frpc 路径（旧 `~/.dsh/bin/` 下的也会被沿用） |
| `tunnelId` | — | 隧道 ID（设置页下拉选择后持久化） |
| `tokenFile` | — | 访问密钥文件（优先级最高；设置页写密钥即写此文件） |
| `tokenRef` | `NATFRP_TOKEN` | tokenFile 为空时走 DSH credentials |
| `gatePort` | — | 网关端口 = 隧道面板的「本地端口」。留空 = 未设置，网关不监听、frpc 不启动 |
| `gateHost` | `127.0.0.1` | 网关监听地址。frpc 同机时无需对外监听；改成 `0.0.0.0` 会给局域网开一条绕过密码门的入口 |
| `gatePassword` | — | 公网密码；也可用设置页写（落 `~/.dsh/dsh-sakurafrp/gate-password.txt`，**不写入 state.json**） |
| `autoAlign` | `true` | 启动前自动把隧道「本地端口」改成 `gatePort` |
| `maxLogLines` | `500` | 日志环形缓冲行数 |

---

## 管理接口（需密码门 cookie）

```
GET  /natfrp/api/state     全量快照（frpc + 网关 + 隧道）
GET  /natfrp/api/tunnels   隧道列表（含节点名）
GET  /natfrp/api/nodes     免费节点（含负载 / 是否可新建；离线、付费已剔除）
GET  /natfrp/api/port/check?port=N  端口可用性（available / reason）
GET  /natfrp/api/user      账号信息
GET  /natfrp/api/logs      frpc 日志
POST /natfrp/api/start     启用并启动
POST /natfrp/api/stop      停止
POST /natfrp/api/align     把隧道「本地端口」改成插件正在用的端口
POST /natfrp/api/tunnel/create  新建一条 TCP 隧道 {name,node,port}，本地端口指向插件
POST /natfrp/api/config    更新配置 {enabled,tunnelId,gatePort,gatePassword,token,clearGatePassword}
                            gatePort 传 null / '' = 清空端口（网关随之停止）
```

**鉴权边界**：`/natfrp/*` 只在持有密码门 cookie 时才放行，否则返回登录页 / 401。
不能按来源地址判断「本机还是公网」——公网流量是 frpc 从 `127.0.0.1` 转发进来的，
两者来源完全相同。本机设置页打的是 DSH webServer 上的同名路由，不经过网关，
所以本机操作不需要密码。

---

## 证书警告与白屏问题（重要）

通过隧道默认域名（`xxx.nyat.app`）HTTPS 访问时，浏览器会提示证书不受信任；
部分浏览器在告警页选择继续后仍可能白屏。**解决方法是绑定自己的子域名**，
让 frpc 从服务端自动加载与域名匹配的证书：

1. 到 [子域绑定页面](https://www.natfrp.com/tunnel/domain) 申请/绑定子域名，
   并将记录关联到你的隧道
2. 详细教程见官方文档：[子域绑定指南](https://doc.natfrp.com/bestpractice/domain-bind.html)
3. 绑定完成后，用 `你的子域名:远程端口` 访问，证书正常加载、无白屏

插件设置页在隧道跑起来后，会把这句话连同两个入口一起显示出来：
「不**绑定证书 ↗** 会出现证书警告、白屏等；绑定子域名后即可消除。 **绑定教程 ↗**」
「绑定证书」指向子域绑定页，「绑定教程」指向官方文档。
（「不」不带链接——连成一片蓝色会读成「不去绑定证书」，意思正好反了。）

---

## 验证

**全部离线**：不连 SakuraFrp、不需要访问密钥、不写任何用户目录（`fresh-install-test`
也是拿一个临时 `DSH_HOME` 跑冷启动）。

```powershell
npm test                 # 22 个套件、597 项，串行跑并汇总
npm test -- path         # 只跑名字含关键字的套件
```

`npm test` 等价于 `node test-all.mjs`。单跑某一个：`node test/order-test.mjs`。

> 测试文件随包发布（`files` 里包含 `test-all.mjs` 与 `test/*.mjs`），
> 所以 `npm install` 之后**也能直接跑 `npm test`**，不必先 clone 仓库。
>
> 仓库用 `.gitattributes` 把换行符钉成 LF。部分断言用正则检查源码结构
> （如 `/note: '...',\n\s+extra,/`），CRLF 检出会让 `\n` 匹配不到 `\r\n`，
> 导致这些断言在本机全线飘红而代码本身无误。

| 套件 | 项 | 覆盖 |
|---|---|---|
| `verify.mjs` | 26 | 模块级 + 网关全链路（API 客户端 / frpc 解析 / 密码门 / 围栏 / WS 透传） |
| `order-test.mjs` | 61 | 四步解锁顺序、表单排布、按钮文案与出现条件 |
| `paths-test.mjs` | 51 | frpc / DSH home 路径解析（含 `$DSH_HOME` 空白、`PROFILE_DIR` 反推） |
| `tunnel-create-test.mjs` | 50 | 新建隧道（端口来源、`extra.auto_https`、官方告警回传） |
| `progressive-test.mjs` | 49 | 渐进解锁派生状态与提示语 |
| `feedback-test.mjs` | 37 | 操作反馈、错误码与文案 |
| `installer-test.mjs` | 36 | frpc 资产挑选 / 下载 / 版本校验 |
| `dismiss-test.mjs` | 29 | 官方提醒的关闭状态机（按路径记忆） |
| `traffic-test.mjs` | 27 | 流量口径与剩余百分比 |
| `apply-test.mjs` | 26 | `apply()` 装配、路由注册、冷启动默认值 |
| `external-test.mjs` | 24 | 外链策略（内置标签 / 退化 / 非绝对地址拒绝） |
| `token-test.mjs` | 24 | 密钥写入、清除、掩码 |
| `diag-test.mjs` | 22 | 诊断信息与状态徽标 |
| `admin-auth-test.mjs` | 22 | 网关管理接口鉴权（8 种路径花招 / WS 同权 / 改密后旧 cookie 失效） |
| `fixes-test.mjs` | 31 | 已修 bug 回归（跨盘路径 / 互踢误判 / 密码迁移 / 清空不复活 / API 自愈 / 登录回跳） |
| `defaults-test.mjs` | 19 | 配置默认值 |
| `scroll-test.mjs` | 14 | 主面板滚动容器链 |
| `state-test.mjs` | 12 | `state.json` 持久化与坏文件兜底 |
| `switch-test.mjs` | 11 | 侧边栏开关状态机（乐观更新 / 连点保护） |
| `density-test.mjs` | 11 | 面板信息密度与读屏高度 |
| `fresh-install-test.mjs` | 10 | 全新安装的冷启动形态 |
| `credential-token-test.mjs` | 5 | `tokenRef` → DSH credentials 读写 |

界面走查用 `preview-render.mjs`：它用极简 React 桩把真实的 `Panel` 渲染成静态 HTML，
可导出 `ready` / `fresh` / `create` / `noport` 四种形态，再用无头浏览器截图核对。

```powershell
$env:PREVIEW_VARIANT='fresh'; node preview-render.mjs .preview/fresh.html
```

追加真实 API 冒烟（只读端点，会消耗一次 API 调用）：

```powershell
$env:NATFRP_TOKEN='你的密钥'; node test/verify.mjs
```

---

## 已知边界

- DSH 关闭 = 隧道断开（frpc 生命周期与宿主绑定）；需要常驻请另配系统服务
- 同一隧道绝不能被两个客户端同时连接（互踢），本插件有检测但无法替你关掉另一端
- **带宽/流量跑满、密钥失效这类问题不会被判成互踢**：`login to server failed` 单独归类，
  只写日志并在提示里指向"密钥或网络"，不参与互踢计数
- **失败锁定在 frpc 下是全局的**：所有公网访客同源（都是 `127.0.0.1`），没法按真实 IP
  分开计数，所以一个人连错 5 次会把登录入口锁 60 秒；已登录的会话不受影响
- `?gate=<密码>` 直达会把密码写进浏览器历史 / 地址栏，公共设备上请用登录框输入
- **密码门 cookie 没有 `Secure` 标志**（只有 `HttpOnly; SameSite=Lax`）。这是有意为之：
  网关上游是 `http://127.0.0.1`，若加 `Secure`，未绑定证书、通过 `http://` 访问的用户
  会因为浏览器拒发 cookie 而**完全登不进去**。代价是走 HTTP 时 cookie 明文传输——
  **请务必绑定子域名走 HTTPS**（见上文「证书警告与白屏问题」），否则密码与会话可被中间人截获
- 界面文案目前只有中文（硬编码在 `client.js` 里）。`locale/*.json` **只提供
  `meta.title` / `meta.description`**，供插件管理器与设置页显示插件名与描述；
  界面内的按钮、提示、错误文案不走 i18n，英文环境看到的仍是中文
- 免费档：2 隧道 / 20 GB 每月 / 10 Mbps
- API 写操作（edit/delete/create）走官方 OpenAPI，但官方对滥用有风控，别高频调用

---

## License

MIT
