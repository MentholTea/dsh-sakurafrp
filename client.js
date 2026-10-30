window.__ModuleLoader__.load({
  id: '@local/dsh-natfrp',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const API = '/natfrp/api'

    /** 宿主 ctx，由 apply(ctx) 注入；用于取宿主服务（sidebarRight / webServer）。 */
    let hostCtx = null

    /** 右侧栏控制器（可选能力）：桌面端用它把外链开进内置浏览器标签。 */
    let sidebarRight = null

    /**
     * 解析「本插件路由的绝对地址」。
     * ⚠️ 不能直接用 location.origin：Electron 里页面 origin 是 _dsh-app://app，
     * 拼出来的 URL 无法与 webserver 路由对应。优先用宿主给出的 origin，
     * 退化到 location.origin（浏览器端天然正确）。
     */
    function apiBase() {
      try {
        const ws = hostCtx?.get?.('webServer')
        if (ws && typeof ws.getOrigin === 'function') {
          const o = ws.getOrigin()
          if (typeof o === 'string' && o) return o
        }
      } catch { /* noop */ }
      try {
        if (typeof location !== 'undefined' && location.origin && /^https?:/.test(location.origin)) {
          return location.origin
        }
      } catch { /* noop */ }
      return ''
    }

    function logsUrl() {
      const base = apiBase()
      return base ? `${base}${API}/logs` : `${API}/logs`
    }

    /**
     * 打开外链的统一入口。
     *
     * 为什么不能只靠 <a target="_blank">：Electron 桌面端的主进程策略会拦掉
     * window.open / target=_blank，点了没反应（手机浏览器正常，桌面端失效）。
     *
     * 照 DSH 自家 chat 视图的做法：
     *   Electron → ctx.get('sidebarRight').openTab('browser', { params: { url } })
     *              在宿主右侧栏的内置浏览器标签里打开
     *   浏览器   → 没有该服务时退化为 window.open
     *
     * ⚠️ sidebarRight / sidebarRightTabs 是 ctx.reflect.provide() 注册的服务，
     * 必须用 ctx.get(name) 取，不是 ctx[name]。
     */
    function openExternal(url) {
      // 兜底：拿到相对路径时按当前 origin 补全（桌面端 origin 非 http 时无法补，
      // 因此正常路径应由服务端 snapshot 提供的 logsUrl 绝对地址）
      let target = String(url ?? '')
      if (!/^https?:|^file:|^mailto:/.test(target)) {
        try {
          const base = apiBase()
          if (base) target = `${base}${target.startsWith('/') ? '' : '/'}${target}`
        } catch { /* noop */ }
      }
      if (!/^https?:|^file:|^mailto:/.test(target)) {
        // 仍不是绝对地址 —— 内置浏览器与外部浏览器都无法打开，明确放弃而不是静默失败
        console.warn('[natfrp] 无法打开非绝对地址:', target)
        return
      }
      try {
        const right = sidebarRight
        const tabs = hostCtx?.get?.('sidebarRightTabs')
        const hasBrowserTab = tabs && typeof tabs.get === 'function' && tabs.get('browser') !== undefined
        if (right && typeof right.openTab === 'function' && hasBrowserTab) {
          right.openTab('browser', { params: { url: target } })
          return
        }
      } catch { /* 落到退化路径 */ }
      try {
        window.open(target, '_blank', 'noopener,noreferrer')
      } catch { /* noop */ }
    }

    /**
     * 外链按钮：桌面（Electron）里 <a target="_blank"> 会被宿主拦掉，
     * 必须走 openExternal 的宿主策略（内置浏览器标签）。
     * 视觉保持链接样式，语义仍是"跳到站外"。
     */
    function ExternalLink({ href, style, children }) {
      return h('a', {
        href,
        role: 'link',
        style: { color: '#4f6ef7', cursor: 'pointer', textDecoration: 'none', ...style },
        onClick: (e) => {
          // 始终交给统一入口：浏览器里会 window.open，桌面里开内置标签
          e.preventDefault()
          e.stopPropagation()
          openExternal(href)
        },
        // 中键/右键"新标签打开"仍交给浏览器原生行为
        onAuxClick: (e) => {
          if (e.button === 1) openExternal(href)
        },
      }, children)
    }

    async function getJSON(path) {
      const r = await fetch(`${API}${path}`, { credentials: 'same-origin' })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.message || body.error || `HTTP ${r.status}`)
      return body
    }
    async function post(path) {
      const r = await fetch(`${API}${path}`, { method: 'POST', credentials: 'same-origin' })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.message || body.error || `HTTP ${r.status}`)
      return body
    }
    async function postConfig(patch) {
      const r = await fetch(`${API}/config`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.message || body.error || `HTTP ${r.status}`)
      return body
    }

    function fmtBytes(n) {
      const v = Number(n) || 0
      if (v < 1024) return `${v} B`
      const u = ['KiB', 'MiB', 'GiB', 'TiB']
      let i = -1, x = v
      do { x /= 1024; i++ } while (x >= 1024 && i < u.length - 1)
      return `${x.toFixed(x >= 100 ? 0 : 1)} ${u[i]}`
    }

    const S = {
      wrap: { padding: '16px 0', display: 'flex', flexDirection: 'column', gap: '18px' },
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px' },
      label: { fontSize: '13px', fontWeight: 600 },
      hint: { fontSize: '12px', opacity: 0.65, marginTop: '2px', lineHeight: 1.6 },
      input: {
        width: '100%', boxSizing: 'border-box', padding: '7px 10px', fontSize: '13px',
        borderRadius: '6px', border: '1px solid var(--dsw-alias-border-1, #d0d5dd)',
        background: 'var(--dsw-alias-bg-1, #fff)', color: 'inherit',
      },
      btn: {
        padding: '6px 14px', fontSize: '13px', borderRadius: '6px', cursor: 'pointer',
        border: '1px solid transparent', background: '#4f6ef7', color: '#fff',
      },
      btnGhost: {
        padding: '6px 14px', fontSize: '13px', borderRadius: '6px', cursor: 'pointer',
        background: 'transparent', color: 'inherit', border: '1px solid var(--dsw-alias-border-1, #d0d5dd)',
      },
      sw: (on) => ({
        width: '40px', height: '22px', borderRadius: '11px', cursor: 'pointer', flex: '0 0 auto',
        border: 'none', position: 'relative', transition: 'background .15s',
        background: on ? '#4f6ef7' : 'var(--dsw-alias-border-2, #c8ccd4)',
      }),
      knob: (on) => ({
        position: 'absolute', top: '2px', left: on ? '20px' : '2px',
        width: '18px', height: '18px', borderRadius: '50%', background: '#fff',
        transition: 'left .15s', boxShadow: '0 1px 2px rgba(0,0,0,.2)',
      }),
      badge: (ok) => ({
        display: 'inline-block', padding: '2px 8px', borderRadius: '10px', fontSize: '12px',
        background: ok ? 'rgba(22,163,74,.12)' : 'rgba(120,120,120,.12)',
        color: ok ? '#16a34a' : 'inherit',
      }),
      badgeWarn: {
        display: 'inline-block', padding: '2px 8px', borderRadius: '10px', fontSize: '12px',
        background: 'rgba(217,119,6,.12)', color: '#d97706',
      },
      warn: { fontSize: '12px', color: '#d97706', lineHeight: 1.7 },
      err: { fontSize: '12px', color: '#dc2626' },
      ok: { fontSize: '12px', color: '#16a34a' },
      divider: { height: '1px', background: 'var(--dsw-alias-border-1, #e5e7eb)' },
      code: {
        fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', fontSize: '12px',
        background: 'rgba(127,127,127,.1)', padding: '1px 5px', borderRadius: '4px',
      },
      trafficBar: {
        height: '8px', borderRadius: '4px', overflow: 'hidden',
        background: 'rgba(127,127,127,.15)', marginTop: '6px',
      },
      /**
       * 流量条填充色 —— 入参是「剩余占比」（不是已用占比）。
       * 语义：剩余充裕=绿，见底=红。阈值方向与已用占比相反，别搞混：
       *   剩余 > 30%  → 绿（够用）
       *   剩余 10–30% → 橙（留意）
       *   剩余 < 10%  → 红（快用完）
       */
      trafficFill: (remainPct) => ({
        height: '100%',
        width: `${Math.min(100, Math.max(0, remainPct))}%`,
        borderRadius: '4px',
        background: remainPct < 10 ? '#dc2626' : remainPct < 30 ? '#d97706' : '#16a34a',
        transition: 'width .3s, background .3s',
      }),
    }

    function Toggle({ on, onChange, disabled }) {
      return h('button', {
        type: 'button', style: { ...S.sw(on), opacity: disabled ? 0.5 : 1 },
        'aria-pressed': on, disabled, onClick: () => !disabled && onChange(!on),
      }, h('span', { style: S.knob(on) }))
    }

    // ── 侧边栏状态点 ──
    // 模块级单例轮询：无论多少个图标实例（折叠/展开、多页签）都只打一份 /state。
    // 判定优先级：错误 > 连接 > 未连接
    //   green  连接中（启用 + frpc 运行 + 隧道已上线）
    //   yellow 未连接（插件停用 / frpc 未运行 / 已启动但隧道未就绪）
    //   red    错误（互踢、密钥缺失、网关未监听、API 失败、路由不可达）
    const DIAG = { green: '#22c55e', yellow: '#eab308', red: '#ef4444' }

    function diagOf(st) {
      if (!st) return 'yellow'
      const f = st.frpc || {}
      if (f.kickSuspect) return 'red'
      if (st.apiError) return 'red'
      if (!st.tokenConfigured) return 'red'
      if (!st.gateRunning) return 'red'
      if (st.enabled && !f.running) return 'red'
      if (st.enabled && f.running && f.tunnelOk) return 'green'
      return 'yellow'
    }

    const diagStore = (() => {
      let value = 'yellow'
      let enabled = true     // 开关状态（独立于连通诊断）
      let timer = null
      const listeners = new Set()
      const enableListeners = new Set()

      function publish(next) {
        if (next === value) return
        value = next
        for (const fn of [...listeners]) {
          try { fn(value) } catch { /* noop */ }
        }
      }

      function publishEnabled(next) {
        if (next === enabled) return
        enabled = next
        for (const fn of [...enableListeners]) {
          // ⚠️ 传 enabled（布尔）不是 value（诊断字符串）—— 曾传错导致订阅者永远收到真值
          try { fn(enabled) } catch { /* noop */ }
        }
      }

      async function tick() {
        try {
          const st = await getJSON('/state')
          publishEnabled(st?.enabled !== false)
          publish(diagOf(st))
        } catch {
          publish('red')
        }
        // 兜底自愈：React 重渲染可能冲掉注入的开关节点，每轮轮询补挂一次。
        // 用惰性调用（syncAllSwitches 定义在后面，运行时已就绪）。
        try {
          if (typeof document !== 'undefined' && document.body) {
            const rows = document.querySelectorAll('button[aria-label="内网穿透"]')
            for (const row of rows) {
              if (!row.querySelector('.natfrp-switch')) {
                ensureSwitchNode(row)
                syncSwitch(row, enabled)
              }
            }
          }
        } catch { /* noop */ }
      }

      return {
        get: () => value,
        getEnabled: () => enabled,
        subscribe(fn) {
          listeners.add(fn)
          if (timer === null) {
            void tick()
            timer = setInterval(() => void tick(), 5000)
            if (timer && typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
          }
          return () => {
            listeners.delete(fn)
            if (listeners.size === 0 && enableListeners.size === 0 && timer !== null) {
              clearInterval(timer)
              timer = null
            }
          }
        },
        subscribeEnabled(fn) {
          enableListeners.add(fn)
          if (timer === null) {
            void tick()
            timer = setInterval(() => void tick(), 5000)
            if (timer && typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
          }
          return () => {
            enableListeners.delete(fn)
            if (listeners.size === 0 && enableListeners.size === 0 && timer !== null) {
              clearInterval(timer)
              timer = null
            }
          }
        },
        kick: () => void tick(),
        /** 供外部（面板开关）主动推送，避免等 5s 轮询 */
        setEnabled: (v) => { publishEnabled(v); },
      }
    })()

    function Panel() {
      const [st, setSt] = useState(null)
      const [user, setUser] = useState(null)
      const [tunnels, setTunnels] = useState(null)
      const [err, setErr] = useState('')
      const [busy, setBusy] = useState(false)
      const [saved, setSaved] = useState('')
      const [alignMsg, setAlignMsg] = useState('')
      const [gatePort, setGatePort] = useState('')
      const [gatePassword, setGatePassword] = useState('')
      const [token, setToken] = useState('')
      const [logsOpen, setLogsOpen] = useState(false)
      const [logs, setLogs] = useState('')
      const mounted = useRef(true)

      const loadState = useCallback(async () => {
        try {
          const s = await getJSON('/state')
          if (!mounted.current) return
          setSt(s)
          setGatePort(String(s.gatePort ?? ''))
          setErr('')
          diagStore.kick() // 面板拿到最新状态后立刻同步侧边栏状态点
        } catch (e) {
          if (mounted.current) setErr(String(e.message || e))
        }
      }, [])

      useEffect(() => {
        mounted.current = true
        void loadState()
        const t = setInterval(() => void loadState(), 4000)
        return () => { mounted.current = false; clearInterval(t) }
      }, [loadState])

      const loadExtra = useCallback(async () => {
        try {
          const [u, t] = await Promise.all([getJSON('/user'), getJSON('/tunnels')])
          if (!mounted.current) return
          setUser(u)
          setTunnels(t.tunnels ?? [])
        } catch {
          /* 轮询失败不打断 UI */
        }
      }, [])

      useEffect(() => { void loadExtra() }, [loadExtra])

      const flash = (setter, text, ms = 2000) => {
        setter(text)
        setTimeout(() => { if (mounted.current) setter('') }, ms)
      }

      const apply = async (patch) => {
        setBusy(true); setErr('')
        try {
          const s = await postConfig(patch)
          if (!mounted.current) return
          setSt(s)
          setGatePort(String(s.gatePort ?? ''))
          flash(setSaved, '已保存')
        } catch (e) {
          if (mounted.current) setErr(String(e.message || e))
        } finally {
          if (mounted.current) setBusy(false)
        }
      }

      const doAlign = async () => {
        setBusy(true); setAlignMsg('')
        try {
          const r = await post('/align')
          if (!mounted.current) return
          const msg = r.already ? '已对齐（无需修改）'
            : r.changed ? `已把面板端口 ${r.from} → ${r.to}`
            : r.error ? `失败：${r.error}`
            : r.reason ? `跳过：${r.reason}` : '完成'
          setAlignMsg(msg)
        } catch (e) {
          if (mounted.current) setAlignMsg(`失败：${e.message}`)
        } finally {
          if (mounted.current) setBusy(false)
        }
      }

      const doToggle = async (v) => {
        setBusy(true)
        try {
          const s = v ? await post('/start') : await post('/stop')
          if (mounted.current) setSt(s)
          // 面板切换后立刻同步侧边栏开关与状态点，不必等 5s 轮询
          diagStore.setEnabled(v)
          diagStore.kick()
        } catch (e) {
          if (mounted.current) setErr(String(e.message || e))
          diagStore.kick()
        } finally {
          if (mounted.current) setBusy(false)
        }
      }

      const loadLogs = async () => {
        const open = !logsOpen
        setLogsOpen(open)
        if (open) {
          const r = await fetch(`${API}/logs`, { credentials: 'same-origin' })
          setLogs(await r.text())
        }
      }

      if (!st) {
        return h('div', { style: S.wrap }, err
          ? h('div', { style: S.err }, `读取状态失败：${err}`)
          : h('div', { style: S.hint }, '加载中…'))
      }

      // 口径分成两个来源，别混：
      //   userInfo.traffic = [本日消耗流量, 总剩余流量]  ← 没有「总量」
      //   data_plans      = [{total, remaining, ...}]     ← 才有真总量
      const todayUsed = user?.traffic?.[0] ?? 0
      const remaining = user?.traffic?.[1] ?? 0

      // 优先用流量包的真总量算剩余百分比；拿不到就退化为「本日+剩余」的近似
      // （近似值偏乐观——它把今天用的当成了全部已用，仅作无数据时的兜底）。
      const plans = Array.isArray(user?.dataPlans) ? user.dataPlans : []
      const planTotal = plans.reduce((s, p) => s + (Number(p?.total) || 0), 0)
      const planRemaining = plans.reduce((s, p) => s + (Number(p?.remaining) || 0), 0)
      const hasPlan = planTotal > 0
      const baseRemaining = hasPlan ? planRemaining : remaining
      const baseTotal = hasPlan ? planTotal : todayUsed + remaining
      const remainPct = baseTotal > 0 ? (baseRemaining / baseTotal) * 100 : 0
      // 显示用：整数百分比，夹在 0–100
      const remainPctText = `${Math.min(100, Math.max(0, Math.round(remainPct)))}%`

      const frpc = st.frpc ?? {}

      return h('div', { style: S.wrap },
        // ── 总开关 ──
        h('div', { style: S.row },
          h('div', {},
            h('div', { style: S.label }, '内网穿透'),
            h('div', { style: S.hint }, '关闭后 frpc 立即停止，DSH 重启也不再启动。网关与密码门不受影响。')),
          h(Toggle, { on: st.enabled, disabled: busy, onChange: doToggle })),

        // ── 运行状态 ──
        h('div', { style: S.row },
          h('div', { style: S.label }, 'frpc 状态'),
          h('span', { style: S.badge(frpc.running) },
            frpc.running ? `运行中${frpc.pid ? ` (PID ${frpc.pid})` : ''}` : '已停止')),

        frpc.kickSuspect
          ? h('div', { style: S.warn },
            '⚠ 疑似互踢：同一隧道被其它客户端（SakuraFrp 启动器或别的机器）连接。' +
            '请关闭其它客户端后点击「重启」。')
          : null,

        frpc.tunnelUrl
          ? h('div', { style: S.row },
            h('div', { style: S.label }, '公网地址'),
            h(ExternalLink, {
              href: frpc.tunnelUrl.includes('://') ? frpc.tunnelUrl : `https://${frpc.tunnelUrl}`,
              style: { fontSize: '13px' },
            }, frpc.tunnelUrl))
          : null,

        // ── 账号信息 ──
        user ? h('div', {},
          h('div', { style: S.row },
            h('div', { style: S.label }, `${user.name} · ${user.speed}`),
            h('span', { style: S.badge(true) }, user.realname === 2 ? '已实名' : `实名 L${user.realname}`)),
          // 进度条 + 右侧百分比：百分比紧贴条尾，一眼看到"还剩多少"
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
            h('div', { style: { ...S.trafficBar, flex: '1 1 auto', minWidth: 0, marginTop: '6px' } },
              h('div', { style: S.trafficFill(remainPct) })),
            h('span', {
              style: {
                flex: 'none', fontSize: '12px', fontWeight: 600,
                color: remainPct < 10 ? '#dc2626' : remainPct < 30 ? '#d97706' : '#16a34a',
                fontVariantNumeric: 'tabular-nums',
              },
              title: hasPlan
                ? `剩余 ${fmtBytes(baseRemaining)} / 总量 ${fmtBytes(baseTotal)}`
                : '未取到流量包总量，按「今日+剩余」估算',
            }, remainPctText)),
          h('div', { style: { ...S.hint, display: 'flex', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' } },
            h('span', {}, `今日已用 ${fmtBytes(todayUsed)}`),
            h('span', {}, `剩余 ${fmtBytes(remaining)}`))) : null,

        h('div', { style: S.divider }),

        // ── 隧道选择 ──
        h('div', {},
          h('div', { style: S.row },
            h('div', { style: S.label }, '隧道'),
            tunnels && tunnels.length
              ? h('select', {
                style: { ...S.input, width: 'auto' },
                value: st.tunnelId || '',
                disabled: busy,
                onChange: (e) => apply({ tunnelId: e.target.value }),
              },
                tunnels.map((t) => h('option', { key: t.id, value: String(t.id) },
                  `${t.name} · ${t.nodeName}${t.online ? '' : ' · 离线'}`)))
              : h('span', { style: S.hint }, st.tunnelId ? `ID ${st.tunnelId}（列表加载中…）` : '未配置')),

          tunnels && tunnels.length
            ? h('div', { style: { ...S.hint, marginTop: '6px' } },
              (() => {
                const t = tunnels.find((x) => String(x.id) === String(st.tunnelId))
                if (!t) return null
                const mismatch = Number(t.local_port) !== Number(st.gatePort)
                return mismatch
                  ? h('span', { style: S.warn },
                    `⚠ 面板端口 ${t.local_port} ≠ 网关 ${st.gatePort}，公网访问会 502。`)
                  : h('span', { style: S.ok }, `✓ 面板端口 ${t.local_port} = 网关端口（已对齐）`)
              })())
            : null,

          h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'center', flexWrap: 'wrap' } },
            h('button', {
              type: 'button', style: busy ? { ...S.btnGhost, opacity: 0.6 } : S.btnGhost,
              disabled: busy, onClick: doAlign,
            }, '一键对齐面板端口'),
            h('button', {
              type: 'button', style: S.btnGhost, onClick: () => void loadExtra(),
            }, '刷新'),
            h(ExternalLink, {
              href: 'https://www.natfrp.com/user/',
              style: { fontSize: '12px', marginLeft: 'auto' },
            }, '管理面板 ↗'),
            h(ExternalLink, {
              href: 'https://www.natfrp.com/tunnel/domain',
              style: { fontSize: '12px' },
            }, '子域绑定 ↗'),
            h(ExternalLink, {
              href: 'https://doc.natfrp.com/bestpractice/domain-bind.html',
              style: { fontSize: '12px' },
            }, '绑定教程 ↗')),

          h('div', { style: { ...S.hint, marginTop: '6px' } },
            '新建/删除隧道、换节点、看流量明细都在管理面板；这里只做选择与启动。'),

          frpc.tunnelUrl
            ? h('div', { style: { ...S.hint, marginTop: '6px' } },
              '默认域名（', h('span', { style: S.code }, 'xxx.nyat.app'),
              '）访问会有证书警告，部分浏览器继续后仍白屏；',
              h(ExternalLink, {
                href: 'https://www.natfrp.com/tunnel/domain',
              }, '绑定子域名'), ' 后用 ', h('span', { style: S.code }, '你的子域名:远程端口'),
              ' 访问即可消除。')
            : null),

        h('div', { style: S.divider }),

        // ── 网关 ──
        h('div', { style: S.row },
          h('div', { style: S.label }, '本地网关'),
          h('span', { style: S.badge(st.gateRunning) },
            st.gateRunning ? `:${st.gatePort} 运行中` : '未运行')),

        !st.gatePasswordConfigured
          ? h('div', { style: S.warn }, '⚠ 未设置访问密码，公网任何人都能进入你的 DSH。')
          : null,

        h('div', {},
          h('div', { style: S.label }, '网关端口'),
          h('div', { style: S.hint },
            'frpc 连到这里。改端口会自动重启 frpc，并用「一键对齐」语义同步面板。'),
          h('input', {
            style: { ...S.input, marginTop: '6px' },
            value: gatePort,
            placeholder: '3083',
            onChange: (e) => setGatePort(e.target.value.replace(/[^0-9]/g, '')),
          })),

        h('div', {},
          h('div', { style: S.label }, '网关访问密码'),
          h('div', { style: S.hint },
            st.gatePasswordConfigured ? '已设置。留空 = 保持不变；填写则覆盖。' : '建议 20 位以上随机串。'),
          h('input', {
            style: { ...S.input, marginTop: '6px' },
            type: 'password', value: gatePassword, placeholder: '留空 = 保持不变',
            autoComplete: 'new-password',
            onChange: (e) => setGatePassword(e.target.value),
          })),

        h('div', {},
          h('div', { style: S.label }, 'SakuraFrp 访问密钥'),
          h('div', { style: S.hint },
            st.tokenConfigured ? '已配置。留空 = 保持不变；填写则覆盖。' : '管理面板 → 用户信息 → 查看访问密钥。'),
          h('input', {
            style: { ...S.input, marginTop: '6px' },
            type: 'password', value: token, placeholder: '留空 = 保持不变',
            autoComplete: 'new-password',
            onChange: (e) => setToken(e.target.value),
          })),

        // ── 保存 ──
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
          h('button', {
            type: 'button', style: busy ? { ...S.btn, opacity: 0.6 } : S.btn,
            disabled: busy,
            onClick: () => {
              const patch = {}
              if (gatePort) patch.gatePort = Number(gatePort)
              if (gatePassword.trim()) patch.gatePassword = gatePassword.trim()
              if (token.trim()) patch.token = token.trim()
              apply(patch).then(() => { setToken(''); setGatePassword('') })
            },
          }, busy ? '保存中…' : '保存'),
          saved ? h('span', { style: S.ok }, saved) : null,
          alignMsg ? h('span', { style: alignMsg.startsWith('失败') ? S.err : S.ok }, alignMsg) : null,
          err ? h('span', { style: S.err }, err) : null),

        // ── 日志 ──
        // ⚠️ 不再给 <pre> 单独设 maxHeight + overflow：主面板本身已是滚动容器，
        // 嵌套滚动会让「鼠标停在日志上时滚不动外层」，且日志尾部被二次裁切。
        // 改为随内容增高，滚动手势统一交给外层。
        h('div', {},
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
            h('button', { type: 'button', style: S.btnGhost, onClick: () => void loadLogs() },
              logsOpen ? '收起日志' : '展开 frpc 日志'),
            logsOpen
              ? h('button', {
                type: 'button',
                onClick: () => openExternal(st.logsUrl || logsUrl()),
                style: { fontSize: '12px', color: '#4f6ef7', background: 'none', border: 'none', padding: 0, cursor: 'pointer' },
              }, '在新窗口打开 ↗')
              : null),
          logsOpen
            ? h('pre', {
              style: {
                marginTop: '8px', padding: '10px', borderRadius: '6px',
                background: 'rgba(127,127,127,.08)', fontSize: '11px', lineHeight: 1.5,
                whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                maxHeight: 'none', overflow: 'visible',
              },
            }, logs || '(空)')
            : null),
      )
    }
    // ── 侧边栏图标 + 状态点 ──
    //
    // DSH 传给 sidebar.panellist 的 size 是 `wide ? 16 : 18`：
    //   wide   = 侧边栏展开，图标 16px，右侧还有文字 span
    //   !wide  = 侧边栏折叠，图标 18px，只有图标
    //
    // 因此状态点分两处呈现：
    //   · 展开模式：图标不画点，由 CSS 注入的 ::after 画在「文字右侧」（占半个字高）
    //   · 折叠模式：没有文字，把点画在 SVG 内部右上角
    const SIDEBAR_CSS_ID = '@local/dsh-natfrp/sidebar-dot.css'

    function ensureSidebarCss() {
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css="${SIDEBAR_CSS_ID}"]`) !== null) return
      const css = `
/* 定位方式不依赖 DSH 的构建哈希类名（前缀随版本变）：
   本插件那一行的 aria-label 固定为「内网穿透」。
   状态写在 body 上（React 重渲染不会冲掉），ARIA 只用于定位行。

   行是 flex + align-items:center + line-height:22px，故伪元素与注入按钮
   都自然垂直居中。布局顺序：图标 → 文字 → 状态点 → 开关。

   ── 状态点（只读指示）──
   绿 = 已连接，黄 = 未连接，红 = 故障。
   点本身不可点（避免误触断线）——可点的是右侧开关。 */
button[aria-label="内网穿透"]::after {
  content: '';
  flex: none;
  order: 1;
  width: 11px;
  height: 11px;
  margin-left: 8px;
  border-radius: 50%;
  background: #eab308;
  transition: background .2s ease;
}
body[data-natfrp-mode="narrow"] button[aria-label="内网穿透"]::after {
  content: none;  /* 折叠模式：点画在图标内嵌位置 */
}
body[data-natfrp-state="green"] button[aria-label="内网穿透"]::after {
  background: #22c55e;
}
body[data-natfrp-state="red"] button[aria-label="内网穿透"]::after {
  background: #ef4444;
}

/* ── 开关（可点，红/绿表示开/关）──
   由组件动态插入为行的最后一个子元素；order:2 保证排在状态点右侧。 */
button[aria-label="内网穿透"] > .natfrp-switch {
  order: 2;
  flex: none;
  position: relative;
  width: 26px;
  height: 14px;
  margin-left: 6px;
  padding: 0;
  border: none;
  border-radius: 999px;
  cursor: pointer;
  background: #ef4444;   /* 关（默认安全色） */
  transition: background .18s ease, opacity .18s ease;
}
button[aria-label="内网穿透"] > .natfrp-switch[data-on="true"] {
  background: #22c55e;   /* 开 */
}
button[aria-label="内网穿透"] > .natfrp-switch::before {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0,0,0,.25);
  transition: transform .18s ease;
}
button[aria-label="内网穿透"] > .natfrp-switch[data-on="true"]::before {
  transform: translateX(12px);
}
button[aria-label="内网穿透"] > .natfrp-switch[data-busy="true"] {
  opacity: .55;
  cursor: progress;
}
body[data-natfrp-mode="narrow"] button[aria-label="内网穿透"] > .natfrp-switch {
  display: none;  /* 折叠模式空间不足，只在展开时提供开关 */
}
`.trim()
      const tag = document.createElement('style')
      tag.dataset.plugin = '@local/dsh-natfrp'
      tag.dataset.pluginCss = SIDEBAR_CSS_ID
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // 把状态写到 document.body（而不是行元素）：
    // React 每次重渲染会重建行上的 ARIA / class，外部塞的 dataset 不保证存活；
    // body 上的属性由本插件独占命名空间，不会与宿主冲突，且 CSS 可稳定继承。
    function writeRowState(diag, wide) {
      if (typeof document === 'undefined') return
      const root = document.body
      if (!root) return
      if (root.dataset.natfrpState !== diag) root.dataset.natfrpState = diag
      const mode = wide ? 'wide' : 'narrow'
      if (root.dataset.natfrpMode !== mode) root.dataset.natfrpMode = mode
    }

    // ── 侧边栏开关（真实 DOM，挂在行末尾）──
    // 为什么不用伪元素：一个元素只有一个 ::after，已被状态点占用；
    // 且伪元素不可点击。故注入真实 button，并阻止事件冒泡到行本身
    // （否则点开关会顺带打开面板）。
    const SWITCH_CLASS = 'natfrp-switch'

    function findRow() {
      if (typeof document === 'undefined') return null
      return document.querySelector('button[aria-label="内网穿透"]')
    }

    /**
     * 全量同步开关视觉。
     * ⚠️ 状态源必须用 diagStore.getEnabled()（同步值），不要传 React state ——
     * React 的 setState 异步，useEffect 里拿到的可能还是上一次的值，
     * 会把刚点击翻转的 dataset.on 覆盖回去，表现为「点一下不生效、再点才生效」。
     */
    function syncAllSwitches() {
      if (typeof document === 'undefined') return
      const enabled = diagStore.getEnabled()
      const rows = document.querySelectorAll('button[aria-label="内网穿透"]')
      for (const row of rows) syncSwitch(row, enabled)
    }

    function ensureSwitchNode(row) {
      if (!row) return null
      let node = row.querySelector(`.${SWITCH_CLASS}`)
      if (node) return node
      node = document.createElement('button')
      node.type = 'button'
      node.className = SWITCH_CLASS
      node.title = '开启 / 关闭内网穿透'
      node.setAttribute('aria-label', '切换内网穿透')
      node.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        void toggleEnabled(node)
      })
      // 也挡住 pointerdown，避免宿主行先收到
      node.addEventListener('pointerdown', (e) => e.stopPropagation())
      row.appendChild(node)
      return node
    }

    async function toggleEnabled(node) {
      if (!node || node.dataset.busy === 'true') return
      const turningOn = node.dataset.on !== 'true'

      // 乐观更新：先立刻翻转视觉，点击即反馈，不等网络
      node.dataset.on = turningOn ? 'true' : 'false'
      node.dataset.busy = 'true'

      try {
        const st = await post(turningOn ? '/start' : '/stop')
        // ✅ 以服务端返回的真实 enabled 为准（不是假设的 turningOn）
        const actual = st?.enabled !== false
        node.dataset.on = actual ? 'true' : 'false'
        // 把权威状态推给 store —— 面板与图标一起对齐
        diagStore.setEnabled(actual)
        diagStore.kick()
      } catch {
        // 失败：回滚视觉到服务端仍未变的状态（即点击前的反面）
        node.dataset.on = turningOn ? 'false' : 'true'
        diagStore.kick()
      } finally {
        node.dataset.busy = 'false'
      }
    }

    function syncSwitch(row, enabled) {
      if (!row) return
      // React 重渲染可能把外部 append 的节点冲掉 —— ensure 会就地重建
      const node = ensureSwitchNode(row)
      if (!node) return
      // ⚠️ 切换进行中：不覆盖，否则会把乐观更新打回去
      if (node.dataset.busy === 'true') return
      const want = enabled ? 'true' : 'false'
      if (node.dataset.on !== want) node.dataset.on = want
    }

    function NatfrpSidebarIcon({ size }) {
      const px = typeof size === 'number' && size > 0 ? size : 16
      // size 16 => 展开(有文字)；size 18 => 折叠(无文字)
      const wide = px <= 16
      const [diag, setDiag] = useState(() => diagStore.get())
      const [enabled, setEnabled] = useState(() => diagStore.getEnabled())

      useEffect(() => diagStore.subscribe(setDiag), [])
      useEffect(() => diagStore.subscribeEnabled(setEnabled), [])

      // 展开模式：点交给 CSS ::after（文字右侧）+ 注入开关；折叠：点画图标内
      useEffect(() => {
        ensureSidebarCss()
        writeRowState(diag, wide)
        // 行元素可能在本次渲染后尚未挂载，下一帧再挂开关。
        // syncAllSwitches 内部自行从 store 读同步值，不吃这里的 enabled（可能滞后）。
        const raf = requestAnimationFrame(() => syncAllSwitches())
        return () => cancelAnimationFrame(raf)
      }, [diag, wide, enabled])

      const dot = DIAG[diag] || DIAG.yellow

      return h('svg', {
        width: px, height: px, viewBox: '0 0 16 16',
        fill: 'none', xmlns: 'http://www.w3.org/2000/svg',
        'aria-hidden': 'true',
      },
        h('path', {
          d: 'M2.5 5.5v5l3 1.8v-5z', stroke: 'currentColor', strokeWidth: 1.2,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M8 3.2l3.5 2.1v5.4L8 12.8 4.5 10.7V5.3z',
          stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M8 3.2v9.6', stroke: 'currentColor', strokeWidth: 1.2,
        }),
        h('path', {
          d: 'M4.5 5.3 2.5 5.5m5.5-2.3 3.5 2.1', stroke: 'currentColor',
          strokeWidth: 1.2, strokeLinecap: 'round',
        }),
        h('circle', { cx: 8, cy: 8, r: 1.1, fill: 'currentColor' }),
        // 仅折叠模式画内嵌点（展开模式由 CSS 画在文字右侧）
        wide
          ? null
          : h('circle', {
            cx: 13.2, cy: 2.8, r: 2.6,
            fill: dot, stroke: 'var(--dsw-alias-bg-layer-1, #fff)', strokeWidth: 1,
          }))
    }

    // 主面板内容：与设置页同一个 Panel，但需要自己建立滚动容器。
    //
    // ⚠️ 为什么必须显式写滚动：main 槽渲染进 layout 的 centerCol，而 centerCol
    // 是 `display:flex; flex-direction:column; overflow:hidden` —— 溢出的内容
    // 直接被裁掉，不会出现滚动条。设置页之所以能滚，是宿主给了可滚动的 section
    // 容器（带 padding 的 overflow-y:auto 块）；main 槽没有这层，必须自建。
    //
    // 三层结构（照 Jet Hub 的 panelHost + panel 两段式）：
    //   外壳：height:100% + min-height:0 + flex 列  ← 让「可滚动区」拿到有界高度
    //   内层：flex:1 + overflow-y:auto            ← 真正滚动的那一层
    // 少了 min-height:0，flex 子项的最小高度会取内容高度，overflow 永远不触发。
    function NatfrpMainPanel() {
      return h('div', {
        style: {
          height: '100%',
          minHeight: 0,
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        },
        'data-plugin': 'natfrp',
      },
        h('div', {
          style: {
            flex: '1 1 auto',
            minHeight: 0,
            overflowY: 'auto',
            overflowX: 'hidden',
            padding: '28px 24px 24px',
            paddingTop: 'calc(28px + var(--dsh-frame-top-clearance, 0px))',
            boxSizing: 'border-box',
            // 给滚动条末端留出安全距离，避免最后一行贴着窗口底边
            paddingBottom: 'calc(24px + 8px)',
          },
        }, h(Panel)))
    }

    const NATFRP_PANEL_KEY = 'natfrp'
    const NATFRP_SIDEBAR_ORDER = 21 // Jet Hub 是 20，紧随其后

    return {
      // ⚠️ 不把 sidebarRight 写进 inject：它是可选能力，硬依赖会让插件在
      // 未装右侧栏的组合里加载失败。改为运行时柔性 inject，拿不到就退化到
      // window.open（浏览器端本来就能用）。
      inject: ['slots', 'layout'],
      apply(ctx) {
        // 暴露给 openExternal / apiBase
        hostCtx = ctx

        // 柔性绑定右侧栏服务：装了就用来开内置浏览器标签（桌面端唯一可用路径）
        try {
          ctx.inject(['sidebarRight'], (scope) => {
            sidebarRight = scope.sidebarRight
            return () => { sidebarRight = void 0 }
          })
        } catch { /* 未装右侧栏：保持 undefined */ }

        // 1) 主面板：点侧边栏图标后展示的整页内容
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: NATFRP_PANEL_KEY,
        }, NatfrpMainPanel))

        // 2) 侧边栏图标行（Jet Hub 模式：持有 layout 以便注销时取消选中）
        let layout
        try {
          ctx.inject(['layout'], (scoped) => {
            layout = scoped.layout
            return () => { layout = void 0 }
          })
        } catch { /* layout 不可用时仅跳过反选，不影响注册 */ }

        ctx.slots.inject('sidebar.panellist', () => {
          const stop = ctx.slots.register({
            name: 'sidebar.panellist',
            id: NATFRP_PANEL_KEY,
            order: NATFRP_SIDEBAR_ORDER,
            label: '内网穿透',
          }, NatfrpSidebarIcon)
          return () => {
            try { stop?.() } catch { /* noop */ }
            try {
              if (layout?.panelInfo?.getSnapshot?.()?.activePanelId !== NATFRP_PANEL_KEY) return
              layout.selectPanel(null)
            } catch { /* noop */ }
          }
        })

        // 3) 设置页区块（保留原入口）
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'natfrp',
          order: 61,
          label: '内网穿透 (SakuraFrp)',
        }, Panel))
      },
    }
  },
})