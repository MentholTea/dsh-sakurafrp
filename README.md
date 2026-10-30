# dsh-sakurafrp

DeepSeek Harness 内建的内网穿透面板——**替代 SakuraFrp 启动器**。
同一台机器上装了本插件后，不需要再开 SakuraLauncher。

- 设置页入口：**设置 → 内网穿透 (SakuraFrp)**
- 侧边栏入口：左侧面板列表里的「内网穿透」，带**三色状态点**（🟢已连接 / 🟡未连接 / 🔴故障）
  和一键启停**开关**（🟢开 / 🔴关）；折叠成图标栏时状态点回到图标右上角

## 架构

```
Web 设备 → xxx.nyat.app:端口 → SakuraFrp 节点 → frpc(本插件托管)
                                              → 127.0.0.1:<gatePort> 网关
                                                ├─ /natfrp/*  管理路由（仅本机）
                                                ├─ 密码门（HMAC cookie / ?gate=）
                                                └─ Host 围栏反代 + WS 透传
                                                  → 127.0.0.1:<dshPort> DSH WebServer
```

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
  登录页零外部依赖
- **Host 围栏反代**：改写 Host/Origin/Referer/Sec-Fetch-Site 为回环权威，
  透传 WebSocket upgrade，注入非安全上下文 polyfill（crypto.randomUUID / AbortSignal.any）
- **DSH 二次认证**：实时取 `ctx.connection.authenticatedUrl()` 的 launch token，
  首次 HTML 导航自动补 `?token=`
- **桌面/浏览器通吃**：外链在 Electron 里走宿主内置浏览器标签，浏览器里走新标签页

## 安装

```powershell
# 一条命令（desktop profile）
dsh plugin --profile desktop add dsh-sakurafrp -w

# web / CLI 场景把 --profile 换成你的 profile 名，例如：
# dsh plugin --profile web add dsh-sakurafrp -w

# 然后重启 DSH
```

**装完还要做两件事**（frpc 二进制不会被 npm 包携带）：

1. 打开设置页，若提示未装 frpc，点「一键安装」即可——插件会自动按平台/架构从官方
   接口挑包，下到 `~/.dsh/dsh-sakurafrp/frpc-standalone(.exe)`
   （也可以自己下好放到同一路径，或把 `frpcPath` 指到任意位置）
2. 重启 DSH → 设置页填访问密钥 → 下拉选隧道 → 设公网密码

> 想走源码：`git clone https://github.com/MentholTea/dsh-sakurafrp.git` 后把
> `dependencies` 写成 `"dsh-sakurafrp": "link:<克隆目录绝对路径>"`，并加入
> `dsh.profile.bundles`，再 `dsh plugin --profile desktop install`。

frpc 默认取 `~/.dsh/dsh-sakurafrp/frpc-standalone(.exe)`；旧版本放在
`~/.dsh/bin/` 的会被继续沿用，不必重下。`frpc -V` 输出应含 `sakura`。

## 配置（cordis.patch.yml → config）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 插件启用（设置页可改，持久化到 state.json） |
| `frpcPath` | `~/.dsh/dsh-sakurafrp/frpc-standalone(.exe)` | frpc 路径（旧 `~/.dsh/bin/` 下的也会被沿用） |
| `tunnelId` | — | 隧道 ID（设置页下拉选择后持久化） |
| `tokenFile` | — | 访问密钥文件（优先级最高；设置页写密钥即写此文件） |
| `tokenRef` | `NATFRP_TOKEN` | tokenFile 为空时走 DSH credentials |
| `gatePort` | — | 网关端口 = 隧道面板的「本地端口」。留空 = 未设置，网关不监听、frpc 不启动 |
| `gateHost` | `127.0.0.1` | 网关监听地址。frpc 同机时无需对外监听；改成 `0.0.0.0` 会给局域网开一条绕过密码门的入口 |
| `gatePassword` | — | 公网密码；也可用设置页写（落 `~/.dsh/dsh-sakurafrp/gate-password.txt`，**不写入 state.json**） |
| `autoAlign` | `true` | 启动前自动把隧道「本地端口」改成 `gatePort` |
| `maxLogLines` | `500` | 日志环形缓冲行数 |

## 管理接口（本机 only）

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

公网侧访问 `/natfrp/*` 一律 403；只有密码门 + 反代暴露在公网。

## 首次使用

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

## 验证

**全部离线**：不连 SakuraFrp、不需要访问密钥、不写任何用户目录（`fresh-install-test`
也是拿一个临时 `DSH_HOME` 跑冷启动）。

```powershell
node test-all.mjs        # 20 个套件、544 项，串行跑并汇总
node test-all.mjs path   # 只跑名字含关键字的套件
```

`npm test` 等价于 `node test-all.mjs`。单跑某一个：`node order-test.mjs`。

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
`$env:NATFRP_TOKEN='你的密钥'; node verify.mjs`
```

## 已知边界

- DSH 关闭 = 隧道断开（frpc 生命周期与宿主绑定）；需要常驻请另配系统服务
- 同一隧道绝不能被两个客户端同时连接（互踢），本插件有检测但无法替你关掉另一端
- 免费档：2 隧道 / 20 GB 每月 / 10 Mbps
- API 写操作（edit/delete/create）走官方 OpenAPI，但官方对滥用有风控，别高频调用

## License

MIT
