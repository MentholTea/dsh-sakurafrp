# dsh-natfrp

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
- **隧道面板**：API v4 拉取隧道列表（带节点名 + 在线状态），下拉直接切换
- **一键对齐**（`autoAlign`）：启动前检查面板 `local_port` 是否等于网关端口，
  不等就先 `POST /tunnel/edit` 改掉——根治「隧道成功但访问 502」
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
# 1) 把本目录放到你想要的位置，例如 D:\plugins\dsh-natfrp
# 2) desktop profile 的 package.json dependencies 加：
"@local/dsh-natfrp": "link:D:/plugins/dsh-natfrp"
# 3) dsh.profile.bundles 列表加 "@local/dsh-natfrp"
# 4) 运行 dsh plugin --profile desktop install，然后重启 DSH
```

frpc 可执行文件默认取 `~/.dsh/bin/frpc-standalone(.exe)`（Sakura 官方分发版，
`-V` 输出应含 `sakura`）。

## 配置（cordis.patch.yml → config）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 插件启用（设置页可改，持久化到 state.json） |
| `frpcPath` | `~/.dsh/bin/frpc-standalone(.exe)` | frpc 路径 |
| `tunnelId` | — | 隧道 ID（设置页下拉选择后持久化） |
| `tokenFile` | — | 访问密钥文件（优先级最高；设置页写密钥即写此文件） |
| `tokenRef` | `NATFRP_TOKEN` | tokenFile 为空时走 DSH credentials |
| `gatePort` | `3083` | 网关端口 = 隧道面板的「本地端口」 |
| `gatePassword` | — | 公网密码；也可用设置页写（落 `~/.dsh/dsh-natfrp/gate-password.txt`） |
| `autoAlign` | `true` | 启动前自动对齐面板 local_port |
| `maxLogLines` | `500` | 日志环形缓冲行数 |

## 管理接口（本机 only）

```
GET  /natfrp/api/state     全量快照（frpc + 网关 + 隧道）
GET  /natfrp/api/tunnels   隧道列表（含节点名）
GET  /natfrp/api/user      账号信息
GET  /natfrp/api/logs      frpc 日志
POST /natfrp/api/start     启用并启动
POST /natfrp/api/stop      停止
POST /natfrp/api/align     一键对齐面板端口
POST /natfrp/api/config    更新配置 {enabled,tunnelId,gatePort,gatePassword,token}
```

公网侧访问 `/natfrp/*` 一律 403；只有密码门 + 反代暴露在公网。

## 首次使用

1. 重启 DSH 后，设置页出现「内网穿透 (SakuraFrp)」区块
2. 填 SakuraFrp 访问密钥（管理面板 → 用户信息 → 查看访问密钥）——落盘到本机文件，仅当前用户可读
3. 下拉选择隧道（列表实时来自 SakuraFrp API v4）
4. 设置公网访问密码（**强烈建议 20 位以上随机串**，不设则公网无认证直通）
5. 手机访问隧道公网地址 → 输密码 → 完整 DSH 界面（WebSocket 流式同步）

## 证书警告与白屏问题（重要）

通过隧道默认域名（`xxx.nyat.app`）HTTPS 访问时，浏览器会提示证书不受信任；
部分浏览器在告警页选择继续后仍可能白屏。**解决方法是绑定自己的子域名**，
让 frpc 从服务端自动加载与域名匹配的证书：

1. 到 [子域绑定页面](https://www.natfrp.com/tunnel/domain) 申请/绑定子域名，
   并将记录关联到你的隧道
2. 详细教程见官方文档：[子域绑定指南](https://doc.natfrp.com/bestpractice/domain-bind.html)
3. 绑定完成后，用 `你的子域名:远程端口` 访问，证书正常加载、无白屏

插件设置页提供这两个页面的快捷跳转。

## 验证

五个离线测试脚本，**不需要安装依赖、不需要真实密钥**：

```powershell
node verify.mjs        # 26 项：模块级 + 网关全链路（API 客户端 / frpc 解析 / 密码门 / 围栏 / WS 透传）
node scroll-test.mjs   # 14 项：主面板滚动容器链（外壳有界高度 → 内层可滚 → 无嵌套滚动）
node switch-test.mjs   # 11 项：侧边栏开关状态机（乐观更新 / 重渲染不被覆盖 / 连点保护）
node traffic-test.mjs  # 27 项：流量口径 + 剩余百分比（含流量包总量与退化路径）
node external-test.mjs # 21 项：外链打开策略（内置浏览器标签 / 退化 / 非绝对地址拒绝）

# 追加真实 API 冒烟（只读端点，会消耗一次 API 调用）
$env:NATFRP_TOKEN='你的密钥'; node verify.mjs
```

## 已知边界

- DSH 关闭 = 隧道断开（frpc 生命周期与宿主绑定）；需要常驻请另配系统服务
- 同一隧道绝不能被两个客户端同时连接（互踢），本插件有检测但无法替你关掉另一端
- 免费档：2 隧道 / 20 GB 每月 / 10 Mbps
- API 写操作（edit/delete/create）走官方 OpenAPI，但官方对滥用有风控，别高频调用

## License

MIT
