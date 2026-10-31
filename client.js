window.__ModuleLoader__.load({
  // ⚠️ 必须与 package.json 的 name 完全一致：DSH 的浏览器端模块身份 = 解析出的包名，
  //    写成别的值（如旧的 @local/dsh-natfrp）会让宿主在 boot 时抛
  //    `loaded without registering "<包名>"`，插件 UI 整半侧加载失败。
  id: 'dsh-sakurafrp',
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
    async function post(path, body) {
      const init = { method: 'POST', credentials: 'same-origin' }
      if (body !== undefined) {
        init.headers = { 'content-type': 'application/json' }
        init.body = JSON.stringify(body)
      }
      const r = await fetch(`${API}${path}`, init)
      const payload = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(payload.message || payload.error || `HTTP ${r.status}`)
      return payload
    }
    async function postConfig(patch) {
      const r = await fetch(`${API}/config`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) {
        // 把 hint 附在错误上，让界面能显示「怎么解决」而不只是「失败了」
        const err = new Error(body.message || body.error || `HTTP ${r.status}`)
        err.hint = body.hint
        err.code = body.code
        err.path = body.path
        throw err
      }
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
      // 密度：整页靠 wrap 的 gap 统一控制间距，子元素上别再撒 margin-top，
      // 否则「省一点」和「补回来」会互相打架。目标是一屏看到全部配置项。
      wrap: { padding: '2px 0', display: 'flex', flexDirection: 'column', gap: '9px' },
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' },
      label: { fontSize: '13px', fontWeight: 600 },
      hint: { fontSize: '12px', opacity: 0.6, marginTop: '1px', lineHeight: 1.45 },
      // 表单行：左边标题固定列宽，右边控件。
      // 原来每个字段都是「标题 / 说明 / 输入框」三层，现在是「标题 | 输入框」一行，
      // 三个字段省下约三行高度。
      field: {
        display: 'grid', gridTemplateColumns: '138px minmax(0, 1fr)',
        alignItems: 'center', gap: '10px',
      },
      flabel: { fontSize: '12px', fontWeight: 600, lineHeight: 1.35 },
      input: {
        width: '100%', boxSizing: 'border-box', padding: '5px 9px', fontSize: '13px',
        borderRadius: '6px', border: '1px solid var(--dsw-alias-border-1, #d0d5dd)',
        background: 'var(--dsw-alias-bg-1, #fff)', color: 'inherit',
      },
      btn: {
        padding: '5px 13px', fontSize: '13px', borderRadius: '6px', cursor: 'pointer',
        border: '1px solid transparent', background: '#4f6ef7', color: '#fff',
      },
      btnGhost: {
        padding: '5px 13px', fontSize: '13px', borderRadius: '6px', cursor: 'pointer',
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
      err: { fontSize: '12px', color: '#dc2626', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
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

    /**
     * 节点「忙不忙」的判定与配色。
     *
     * 负载来自官方 /node/stats 的 load（百分比），节点列表里直接标在名字后面，
     * 用户挑节点时不用去官网查。阈值按「还能不能愉快地建隧道」定：
     *   <40 空闲（绿） 40–70 一般（黄） 70–90 拥挤（橙） >=90 满载（红）
     *
     * ⚠️ load = -1 表示没拿到数据，必须显示「未知」（灰），不能当成空闲——
     *    否则一个查不到负载的节点会伪装成最空闲的那个。
     * createAllowed=false 时官方已经不允许在这个节点新建，直接用「满载」，
     * 与 load 数值无关。
     */
    function nodeStatus(n) {
      if (n?.createAllowed === false) return { text: '满载', color: '#dc2626' }
      const load = Number(n?.load)
      if (!Number.isFinite(load) || load < 0) return { text: '未知', color: '#6b7280' }
      const pct = Math.round(load)
      if (load < 40) return { text: `空闲 ${pct}%`, color: '#16a34a' }
      if (load < 70) return { text: `一般 ${pct}%`, color: '#d97706' }
      if (load < 90) return { text: `拥挤 ${pct}%`, color: '#ea580c' }
      return { text: `满载 ${pct}%`, color: '#dc2626' }
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

    /**
     * 侧边栏状态点判定。
     *
     * 语义（用户定义）：
     *   红 = 关闭状态（enabled=false）或 未安装 frpc / frpc 异常
     *   黄 = 已开启但尚未连通（启动中、隧道未就绪）
     *   绿 = 连接成功（frpc 运行 + 隧道已上线）
     *
     * ⚠️ 与旧实现的区别：以前「关闭」是黄，「故障」才红。
     *    现在关闭本身就算红（用户明确要求：关闭=红），
     *    因为「你想用它却没开/没装」才是需要被看见的状态。
     */
    function diagOf(st) {
      if (!st) return 'red' // 拿不到状态 = 异常，按红处理

      const f = st.frpc || {}
      const inst = st.frpcInstall || {}

      // ① 未安装 / frpc 不可用 → 红
      if (inst.present === false) return 'red'
      if (inst.present === true && inst.ok === false) return 'red'

      // ② 关闭状态 → 红
      if (st.enabled === false) return 'red'

      // ③ 其它硬故障 → 红
      if (!st.tokenConfigured) return 'red'
      if (!st.gateRunning) return 'red'
      if (f.kickSuspect) return 'red'
      if (st.apiError) return 'red'
      if (!f.running) return 'red' // 开着却没跑起来 = 故障

      // ④ 运行中但隧道还没上线 → 黄（启动过程）
      if (f.running && f.tunnelOk !== true) return 'yellow'

      // ⑤ 全部就绪
      return 'green'
    }

    const diagStore = (() => {
      let value = 'red'  // 初始=未就绪，按红显示，避免误报为黄
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

    /**
     * frpc 安装卡片。
     * 只在「未安装 / 装的不对 / 正在安装 / 刚装完要看结果」时出现；装好且提示过期后整卡消失。
     *
     * 安装走后端 POST /frpc/install（异步），进度靠 /state 里 frpcInstall 轮询：
     *   · progress  —— 进行中的阶段与字节数
     *   · lastResult —— 上一次的成败（后端留存，否则装完界面静默恢复，用户毫无反馈）
     */
    function FrpcInstallCard({ inst, onDone }) {
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState('')
      // 记录已被用户看过/已过期的结果时间戳，避免提示一直挂着
      const [dismissedAt, setDismissedAt] = useState(0)

      const presence = inst ?? {}
      const progress = presence.progress ?? null
      const installing = Boolean(progress)
      const present = Boolean(presence.present)
      const healthy = present && presence.ok !== false
      // 可写性：null=未检测，false=目标目录只读
      const writable = presence.writable
      const notWritable = writable === false
      const shownPath = presence.displayPath || presence.path || '~/.dsh/bin/frpc-standalone'

      const last = presence.lastResult ?? null
      // acknowledged 来自服务端（落盘的），跨会话有效：
      // 用户关掉过这条结果，就不该下次打开设置时又弹一遍。
      const ackedPersisted = last?.acknowledged === true
      const showResult = Boolean(last) && !ackedPersisted && last.at !== dismissedAt
      // 用户已叉掉「这一类问题」：整卡收起，只在下方留一行淡淡的「恢复提示」入口
      const dismissedByUser = presence.dismissed === true

      /**
       * 关掉结果提示。
       * ⚠️ 必须落盘（POST /frpc/ack-result），只写本地 state 是不够的：
       *    组件随设置面板卸载重建，本地 state 归零 → 卡片立刻复活，
       *    这条一次性消息就变成永远关不掉。
       * 之后只有「frpc 再次出问题并重新装好」产生新的 at，才会再提示一次。
       */
      const ackResult = (at) => {
        setDismissedAt(at) // 先本地收起，点击即时反馈
        return post('/frpc/ack-result', { at }).then(() => onDone?.()).catch(() => {})
      }

      // 结果展示 8 秒（失败 20 秒）后自动收起，并一并落盘：
      // 展示过就算看过了，否则用户不点叉的话每次进设置都会再弹一次。
      // 失败结果即使被 ack 也不会丢信息 —— healthy 为 false 时会继续显示安装引导卡。
      useEffect(() => {
        if (!showResult) return undefined
        const at = last.at
        const t = setTimeout(
          () => { void ackResult(at) },
          last.ok ? 8000 : 20000,
        )
        return () => clearTimeout(t)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [showResult, last?.at, last?.ok])

      // 已装好 且 没有待展示的结果 → 不占地方
      if (healthy && !showResult) return null

      // 用户叉掉过同类问题，且当前没有新的安装结果要看 → 收起成一行小字
      if (dismissedByUser && !showResult) {
        return h('div', {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            fontSize: '11px',
            opacity: 0.55,
            padding: '2px 0',
          },
        },
          h('span', {}, 'frpc 提示已隐藏'),
          h('button', {
            type: 'button',
            style: {
              background: 'none', border: 'none', padding: 0,
              color: '#4f6ef7', cursor: 'pointer', fontSize: '11px',
            },
            onClick: () => {
              void post('/frpc/undismiss').then(() => onDone?.()).catch(() => {})
            },
          }, '恢复提示'))
      }

      // 装好了：显示成功卡片（自动消失）
      if (healthy) {
        return h('div', {
          style: {
            padding: '12px 14px',
            borderRadius: '10px',
            border: '1px solid rgba(34,197,94,.45)',
            background: 'rgba(34,197,94,.10)',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
          },
        },
          h('span', { style: { fontSize: '16px' } }, '✅'),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', flex: '1 1 auto' } },
            h('span', { style: { fontWeight: 600, fontSize: '13px' } }, 'frpc 安装成功'),
            h('span', { style: { ...S.hint, fontSize: '11px' } },
              [last?.version, last?.bytes ? `${(last.bytes / 1048576).toFixed(1)}MB` : null]
                .filter(Boolean).join(' · ') || '已完成'),
            h('span', { style: { ...S.hint, fontSize: '11px' } }, shownPath)),
          h('button', {
            type: 'button',
            title: '关闭',
            'aria-label': '关闭',
            style: {
              flex: 'none', width: '22px', height: '22px', lineHeight: '20px',
              textAlign: 'center', padding: 0, border: 'none', borderRadius: '6px',
              background: 'transparent', color: 'inherit', opacity: 0.55,
              cursor: 'pointer', fontSize: '15px',
            },
            onClick: () => { void ackResult(last?.at ?? Date.now()) },
          }, '✕'))
      }

      const startInstall = async () => {
        setBusy(true); setErr('')
        try {
          await post('/frpc/install')
          // 立刻拉一次，让进度条马上出现（不用等下一轮轮询）
          onDone?.()
        } catch (e) {
          setErr(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      const pct = progress && progress.total
        ? Math.min(100, Math.round((progress.received / progress.total) * 100))
        : null
      // 字节数进度（total 缺失时也有反馈）
      const mbText = progress && progress.received
        ? `${(progress.received / 1048576).toFixed(1)}${progress.total ? ` / ${(progress.total / 1048576).toFixed(1)}` : ''} MB`
        : ''

      return h('div', {
        style: {
          padding: '14px',
          borderRadius: '10px',
          border: '1px solid rgba(234,179,8,.45)',
          background: 'rgba(234,179,8,.08)',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('span', { style: { fontSize: '15px' } }, '⚙️'),
          h('span', { style: { fontWeight: 600, fontSize: '13px', flex: '1 1 auto' } },
            present ? 'frpc 不可用' : '未检测到 frpc'),
          // 叉号：关闭后不再显示，直到问题类型或路径变化（或点「恢复提示」）
          h('button', {
            type: 'button',
            title: '关闭提示（问题解决或变化前不再显示）',
            'aria-label': '关闭提示',
            style: {
              flex: 'none',
              width: '22px',
              height: '22px',
              lineHeight: '20px',
              textAlign: 'center',
              padding: 0,
              border: 'none',
              borderRadius: '6px',
              background: 'transparent',
              color: 'inherit',
              opacity: 0.55,
              cursor: 'pointer',
              fontSize: '15px',
            },
            onMouseEnter: (e) => { e.currentTarget.style.opacity = '1' },
            onMouseLeave: (e) => { e.currentTarget.style.opacity = '0.55' },
            onClick: () => {
              // 先把本地视觉收起（即时反馈），再落盘
              void post('/frpc/dismiss').then(() => onDone?.()).catch(() => {})
            },
          }, '✕')),

        h('div', { style: S.hint },
          present
            ? `本地文件存在但不正确：${presence.error || '版本不符'}`
            : '内网穿透需要 SakuraFrp 官方 frpc。点下面的按钮自动下载并安装到本机，无需手动操作。'),

        h('div', { style: { ...S.hint, fontSize: '11px', opacity: 0.75, wordBreak: 'break-all' } },
          `安装位置：${shownPath}`,
          presence.pathSource === 'config'
            ? '（来自配置 frpcPath）'
            : presence.homeSource === 'DSH_HOME'
              ? '（跟随 $DSH_HOME）'
              : presence.homeSource === 'DSH_PROFILE_DIR'
                ? '（由 $DSH_PROFILE_DIR 推断）'
                : ''),

        // 上一次安装失败：明确告诉用户为什么，而不是静默恢复原样
        showResult && last && !last.ok
          ? h('div', {
            style: {
              padding: '10px 12px',
              borderRadius: '8px',
              border: '1px solid rgba(239,68,68,.45)',
              background: 'rgba(239,68,68,.10)',
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
            },
          },
            h('span', { style: { fontWeight: 600, fontSize: '12px', color: '#dc2626' } }, '❌ 上次安装失败'),
            h('span', { style: { ...S.hint, fontSize: '11px', wordBreak: 'break-word' } }, last.error || '未知错误'),
            h('span', { style: { ...S.hint, fontSize: '11px', opacity: 0.7 } }, '可重试，或用下方「手动下载说明」。'))
          : null,

        // 只读目录：不提供一键安装，直接给手动方案 + 改配置的提示
        notWritable
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
            h('div', { style: S.warn },
              '⚠ 该目录不可写（常见于系统级安装）。无法自动安装，请任选其一：'),
            h('div', { style: { ...S.hint, fontSize: '12px' } },
              h('div', {}, '① 手动下载 frpc 后放到上面这个路径（需要管理员权限）'),
              h('div', {}, '② 或在 cordis.patch.yml 里把 ',
                h('span', { style: S.code }, 'frpcPath'),
                ' 指到一个可写目录，重启后重新点安装')),
            h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
              h(ExternalLink, {
                href: 'https://doc.natfrp.com/frpc/usage.html',
                style: { fontSize: '12px' },
              }, '手动下载说明 ↗'),
              h('button', {
                type: 'button', style: S.btnGhost, onClick: onDone,
              }, '重新检测')))
          : installing
            ? h('div', {},
              h('div', {
                style: {
                  ...S.hint,
                  marginBottom: '6px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: '8px',
                },
              },
                h('span', {},
                  progress.phase === 'checking'
                    ? '正在查询官方下载地址…'
                    : pct === null
                      ? `正在下载…${mbText ? ` ${mbText}` : ''}`
                      : `正在下载… ${pct}%`),
                mbText ? h('span', { style: { opacity: 0.7 } }, mbText) : null),
              h('div', { style: S.trafficBar },
                h('div', {
                  style: {
                    height: '100%',
                    width: pct === null ? '15%' : `${Math.max(3, pct)}%`,
                    borderRadius: '4px',
                    background: '#3b82f6',
                    transition: 'width .25s ease',
                  },
                })),
              h('div', { style: { ...S.hint, fontSize: '11px', marginTop: '6px', opacity: 0.7 } },
                '下载约 14MB，请保持页面开启；完成后会自动启动隧道。'))
            : h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
              h('button', {
                type: 'button',
                style: busy ? { ...S.btn, opacity: 0.6 } : S.btn,
                disabled: busy,
                onClick: startInstall,
              }, busy ? '提交中…' : '一键安装 frpc'),
              h(ExternalLink, {
                href: 'https://doc.natfrp.com/frpc/usage.html',
                style: { fontSize: '12px' },
              }, '手动下载说明 ↗')),

        err ? h('div', { style: S.err }, err) : null)
    }

    /**
     * 仅给布局预览用的开关（preview-render.mjs 设置 window.__natfrpPreviewCreate）。
     * 生产环境这个属性不存在，恒为 false —— 不改变任何真实行为，
     * 只是让「新建表单展开」这一屏也能被渲染出来检查排版。
     */
    const PREVIEW_CREATE = typeof window !== 'undefined' && window.__natfrpPreviewCreate === true

    function Panel() {
      const [st, setSt] = useState(null)
      const [user, setUser] = useState(null)
      const [tunnels, setTunnels] = useState(null)
      // 两类错误分开存：
      //   err     = 用户操作（保存 / 改隧道端口 / 开关）产生的，必须留到下一次操作才清
      //   pollErr = 轮询 /state 失败的提示，下一轮成功即可消失
      // 混用一个 state 时，4 秒一次的轮询成功会把刚弹出的报错立刻清空。
      const [err, setErr] = useState('')
      const [pollErr, setPollErr] = useState('')
      const [busy, setBusy] = useState(false)
      const [saved, setSaved] = useState('')
      const [alignMsg, setAlignMsg] = useState('')
      const [gatePort, setGatePort] = useState('')
      const [gatePassword, setGatePassword] = useState('')
      const [token, setToken] = useState('')
      // 日志默认展开：很多问题（连不上、端口被抢）只有日志里有答案，
      // 藏起来等于让用户先猜一次。展开状态由下面 2s 一次的轮询保持最新。
      const [logsOpen, setLogsOpen] = useState(true)
      const [logs, setLogs] = useState('')
      // 「新建隧道」表单：默认收起，展开时才去拉节点列表（省一次 API 调用）
      const [newOpen, setNewOpen] = useState(PREVIEW_CREATE)
      // 名字留空 = 由服务端兜底成 DSH；不预填是为了让「我没填」和「填了 DSH」可区分
      const [newName, setNewName] = useState('')
      const [newNode, setNewNode] = useState('')
      /** 新建表单里的端口：默认跟当前本机端口一致，改了就以它为准 */
      const [newPort, setNewPort] = useState('')
      const [nodes, setNodes] = useState(null)
      const [nodeErr, setNodeErr] = useState('')
      const [createErr, setCreateErr] = useState('')
      /** 端口可用性检测的结论（填完就查，不用等保存） */
      const [portMsg, setPortMsg] = useState('')
      const [portOk, setPortOk] = useState(false)
      /** 新建表单里那个端口的检测结论，单独一份，避免两处互相冲掉 */
      const [newPortMsg, setNewPortMsg] = useState('')
      const [newPortOk, setNewPortOk] = useState(false)
      /** 「本机端口 ↔ 隧道端口」同步结果的一句话说明 */
      const [syncMsg, setSyncMsg] = useState('')
      // 用户一旦动过端口输入框，轮询就不能再覆盖它的值（否则打字打到一半被打回）
      const portDirty = useRef(false)
      const mounted = useRef(true)
      /** 日志容器：内容刷新后自动滚到最新一行 */
      const logRef = useRef(null)
      /** 是否还「钉」在底部 —— 用户往上翻看旧日志时解除，滚回底部自动恢复 */
      const logPinned = useRef(true)

      const loadState = useCallback(async () => {
        try {
          const s = await getJSON('/state')
          if (!mounted.current) return
          setSt(s)
          if (!portDirty.current) setGatePort(String(s.gatePort ?? ''))
          setPollErr('')
          diagStore.kick() // 面板拿到最新状态后立刻同步侧边栏状态点
        } catch (e) {
          if (mounted.current) setPollErr(String(e.message || e))
        }
      }, [])

      useEffect(() => {
        mounted.current = true
        void loadState()
        const t = setInterval(() => void loadState(), 4000)
        return () => { mounted.current = false; clearInterval(t) }
      }, [loadState])

      // 安装进行中：把轮询提到 400ms，否则 4s 一次的话进度条几乎看不出在动
      const installingNow = Boolean(st?.frpcInstall?.progress)
      useEffect(() => {
        if (!installingNow) return undefined
        const fast = setInterval(() => void loadState(), 400)
        return () => clearInterval(fast)
      }, [installingNow, loadState])

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

      /**
       * 把服务端回来的端口同步报告翻成一句人话。
       *
       * direction 决定谁跟着谁走，两种方向的措辞必须区分开，
       * 否则用户看到「已改成 3083」完全不知道改的是哪一边：
       *   to-panel = 改了本机端口，面板里那条隧道跟着改
       *   to-local = 选了隧道，本机端口跟着隧道改
       */
      const describeSync = (r) => {
        if (!r) return ''
        if (r.error) return `⚠ 端口没同步：${r.error}`
        if (r.changed && r.direction === 'to-local') {
          return `✓ 已把本机端口改成 ${r.to}（跟随这条隧道，原来是 ${r.from}）`
        }
        if (r.changed && r.direction === 'to-panel') {
          return `✓ 已把隧道里的端口改成 ${r.to}（本机 ${r.from} 被别的程序占着，只能用这个）`
        }
        if (r.already) return `✓ 隧道端口和本机端口一致（${r.port}）`
        if (r.skipped) return ''
        return ''
      }

      /** 新建表单里的端口也要当场给结论，别等点了「创建隧道」才报错。 */
      const checkNewPort = async () => {
        const n = Number(newPort)
        if (!Number.isInteger(n) || n < 1) { setNewPortMsg(''); setNewPortOk(false); return }
        if (n < 1024 || n > 65535) {
          setNewPortOk(false)
          setNewPortMsg('⚠ 要用 1024–65535 之间的端口')
          return
        }
        try {
          const r = await getJSON(`/port/check?port=${n}`)
          if (!mounted.current) return
          const ok = Boolean(r.available)
          setNewPortOk(ok)
          setNewPortMsg(ok ? `✓ ${n} 可以用` : `⚠ ${n} 已被占用`)
        } catch (e) {
          if (mounted.current) setNewPortMsg(`检测失败：${e.message || e}`)
        }
      }

      /** 填完端口就查一次能不能用，别等保存时才报错。 */
      const checkPort = async (v) => {
        const n = Number(v)
        if (!Number.isInteger(n) || n < 1) { setPortMsg(''); setPortOk(false); return }
        if (n < 1024 || n > 65535) {
          setPortOk(false)
          setPortMsg('⚠ 要用 1024–65535 之间的端口')
          return
        }
        try {
          const r = await getJSON(`/port/check?port=${n}`)
          if (!mounted.current) return
          const ok = Boolean(r.available)
          setPortOk(ok)
          setPortMsg(ok
            ? `✓ 端口 ${n} 可以用`
            : `⚠ 端口 ${n} 已被其它程序占用，换一个（比如 ${n + 1}）`)
        } catch (e) {
          if (mounted.current) setPortMsg(`端口检测失败：${e.message || e}`)
        }
      }

      /** @returns {Promise<boolean>} true = 已保存到服务端 */
      const apply = async (patch) => {
        setBusy(true); setErr('')
        try {
          const s = await postConfig(patch)
          if (!mounted.current) return false
          setSt(s)
          // 服务端已确认保存 → 输入框与权威值对齐，解除「用户正在编辑」锁定
          portDirty.current = false
          setGatePort(String(s.gatePort ?? ''))
          // 端口可能被服务端顺手同步到隧道（或反过来），把结论说出来
          setSyncMsg(describeSync(s.portSync))
          // 换了端口就等于换了个数，旧的可用性结论不能留着
          if (patch.gatePort !== undefined) { setPortMsg(''); setPortOk(false) }
          flash(setSaved, '已保存')
          return true
        } catch (e) {
          // 显示 message + hint：权限类错误光说"失败"没有用，用户要知道怎么改
          if (mounted.current) {
            const msg = String(e.message || e)
            setErr(e.hint ? `${msg}\n\n${e.hint}` : msg)
          }
          return false
        } finally {
          if (mounted.current) setBusy(false)
        }
      }

      /**
       * 保存：把界面上所有填过的值一次性提交。
       *
       * 入口有两个（①「访问密钥」右侧的主按钮、底部的 GHOST 按钮），
       * 走同一份逻辑 —— 否则两处迟早出现「这个能存、那个不能存」的偏差。
       * 只提交真正填了东西的键：空着 = 保持不变，不能把已有配置清掉。
       */
      const saveAll = () => {
        const patch = {}
        if (gatePort) patch.gatePort = Number(gatePort)
        if (gatePassword.trim()) patch.gatePassword = gatePassword.trim()
        if (token.trim()) patch.token = token.trim()
        // 只有真正保存成功才清空输入：失败还清空的话用户得重新敲一遍
        apply(patch).then((ok) => {
          if (!ok) return
          setToken('')
          setGatePassword('')
          // 密钥/端口变了 → 隧道列表和端口校验都得重拉，
          // 不然下面还停在「列表加载中」或者旧的端口警告上
          void loadExtra()
        })
      }

      /**
       *
       * ⚠️ 界面上一律不出现「对齐」二字：这是内部说法，用户看不懂「对齐什么」。
       *    对外只说清事实——「隧道连 3082，插件在 3083，所以外网打不开」。
       */
      const doAlign = async () => {
        setBusy(true); setAlignMsg('')
        try {
          const r = await post('/align')
          if (!mounted.current) return
          const msg = r.already ? '隧道端口本来就是对的，不用改'
            : r.changed ? `已把隧道端口从 ${r.from} 改成 ${r.to}`
              : r.error ? `没改成：${r.error}`
                : r.reason ? `没改成：${r.reason}`
                  : r.skipped ? '没有可改的（先在上面选一个隧道）' : '完成'
          setAlignMsg(msg)
          // 改完必须重拉隧道列表：不重拉的话界面还停在旧端口上，
          // 「端口不一致」的警告和按钮会一直挂着，看起来像没生效。
          void loadExtra()
        } catch (e) {
          if (mounted.current) setAlignMsg(`没改成：${e.message}`)
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

      /**
       * 重启 frpc（停 → 起）。
       * 互踢警告里原本写着「点击『重启』」，但界面上根本没有这个按钮，
       * 用户只能靠关掉再打开开关绕过去。这里补上真实入口。
       */
      const doRestart = async () => {
        setBusy(true); setErr('')
        try {
          await post('/stop')
          const s = await post('/start')
          if (mounted.current) setSt(s)
          diagStore.setEnabled(true)
          diagStore.kick()
        } catch (e) {
          if (mounted.current) setErr(String(e.message || e))
        } finally {
          if (mounted.current) setBusy(false)
        }
      }

      /** 拉一次日志。失败静默 —— 日志是辅助信息，不该盖住主界面的报错。 */
      const pullLogs = async () => {
        try {
          const r = await fetch(`${API}/logs`, { credentials: 'same-origin' })
          if (!r.ok) return
          const t = await r.text()
          if (mounted.current) setLogs(t)
        } catch { /* 拉不到就维持上一份 */ }
      }

      /**
       * 日志展开时每 2s 拉一次。
       * 原来只在点「展开」时拉一次，之后 frpc 再写什么都不会更新，
       * 用户得收起再展开才看得到 —— 看起来像日志不刷新。
       * 收起时立刻停掉，不在后台白耗请求。
       */
      useEffect(() => {
        if (!logsOpen) return undefined
        void pullLogs()
        const t = setInterval(() => void pullLogs(), 2000)
        return () => clearInterval(t)
      }, [logsOpen])

      /**
       * 有新日志就滚到底 —— 不然每 2s 刷新一次，看到的永远是上面那几十行旧的，
       * 还以为日志「不更新」。用户自己往上翻时（logPinned=false）不抢滚动条。
       */
      useEffect(() => {
        const el = logRef.current
        if (el && logPinned.current) el.scrollTop = el.scrollHeight
      }, [logs])

      /**
       * 展开「新建隧道」表单。
       *
       * 节点列表懒加载：只有真要点新建时才拉一次，不跟 4s 轮询一起跑。
       * 隧道类型固定为 TCP，所以这里只需要让用户挑节点 + 起个名字。
       */
      const openCreate = async () => {
        setNewOpen(true); setCreateErr(''); setNodeErr('')
        // 端口默认沿用当前本机端口：多数人不会想换，填一次就能同时建隧道 + 定端口
        setNewPort(String(st?.gatePort ?? ''))
        if (nodes) return
        try {
          const r = await getJSON('/nodes')
          if (!mounted.current) return
          const list = r.nodes ?? []
          setNodes(list)
          // 只有一个可选节点就直接选中，省一次点击
          if (list.length === 1) setNewNode(String(list[0].id))
        } catch (e) {
          if (!mounted.current) return
          const msg = String(e.message || e)
          setNodeErr(msg === 'no-token'
            ? '先在上面保存访问密钥，才能新建隧道'
            : `拿不到节点列表：${msg}`)
        }
      }

      /**
       * 展开表单时才拉节点列表（省一次 API 调用）。
       *
       * 放在 effect 里而不是按钮回调里：触发条件是「表单展开了」这个状态本身，
       * 按钮、恢复上次状态、外部预置都会走同一条路，不会漏。
       */
      useEffect(() => {
        if (!newOpen || nodes) return
        void openCreate()
      }, [newOpen, nodes])

      /**
       * 端口定了就自动验一次可用性。
       *
       * 为什么要自动：第 ④ 步（访问密码）的显示条件是「端口已确认可用」，
       * 如果只在用户 blur 输入框时才检测，那么重开面板 / 选完隧道之后
       * portOk 一直是 false，④ 就永远不出现 —— 用户会觉得密码框丢了。
       * 只在端口值真的变了才重测，避免 4s 轮询反复打检测接口。
       */
      const autoChecked = useRef('')
      useEffect(() => {
        if (!st?.tokenConfigured || !st?.tunnelId) return
        const p = String(st.gatePort ?? '')
        if (!p) { setPortOk(false); return }
        if (autoChecked.current === p) return
        autoChecked.current = p
        void checkPort(p)
      }, [st?.gatePort, st?.tunnelId, st?.tokenConfigured])

      /**
       * 真正建隧道。
       * 本地 IP 由服务端固定成 127.0.0.1；端口用表单里填的那个（同时会写进本机端口），
       * 远程端口由官方自动分配 —— 所以前端只需要名字 + 节点 + 端口。
       */
      const doCreate = async () => {
        if (!newNode) { setCreateErr('先选一个节点'); return }
        if (!String(newPort).trim()) { setCreateErr('再填一个端口，比如 3083'); return }
        const p = Number(newPort)
        if (!Number.isInteger(p) || p < 1024 || p > 65535) {
          setCreateErr('端口要填 1024–65535 之间的整数')
          return
        }
        setBusy(true); setCreateErr('')
        try {
          const r = await post('/tunnel/create', {
            name: (newName.trim() || 'DSH').slice(0, 24),
            node: Number(newNode),
            port: p,
            // 自动 HTTPS 固定走「自动」：这是官方面板新建时的默认值，也是唯一
            // 不会坑到用户的选择（选禁用，http(s) 隧道就拿不到证书）。
            // 不放进界面 —— 新建 TCP 隧道时它根本不起作用，摆出来只会多一个要判断的选项。
            autoHttps: 'auto',
          })
          if (!mounted.current) return
          setNewOpen(false)
          setSyncMsg(`✓ 隧道用的端口是 ${r.port ?? p}，本机端口也已同步成这个数`)
          if (r.autoHttpsDropped) {
            setAlignMsg('⚠ 官方没接受「自动 HTTPS」这一项，隧道已按默认设置建好；需要的话去管理面板里补。')
          } else if (r.warning) {
            // 官方一次性警告（节点规则/配额等）常驻显示，别用 flash 让它自己消失
            setAlignMsg(`⚠ ${r.warning}`)
          } else {
            flash(setAlignMsg, `已新建隧道「${r.name}」，并设为当前隧道`, 6000)
          }
          // 新隧道已在服务端设成当前隧道 → 列表和状态都要重拉
          await Promise.all([loadExtra(), loadState()])
        } catch (e) {
          if (mounted.current) setCreateErr(String(e.message || e))
        } finally {
          if (mounted.current) setBusy(false)
        }
      }

      if (!st) {
        const firstErr = err || pollErr
        return h('div', { style: S.wrap }, firstErr
          ? h('div', { style: S.err }, `读取状态失败：${firstErr}`)
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
      // 实名徽标文案：realname=2 已实名，0/1 显示等级；取不到就不显示（不能渲染成 Lundefined）
      const realnameText = user?.realname === 2
        ? '已实名'
        : Number.isFinite(Number(user?.realname)) ? `实名 L${user.realname}` : ''
      const planTotal = plans.reduce((s, p) => s + (Number(p?.total) || 0), 0)
      const planRemaining = plans.reduce((s, p) => s + (Number(p?.remaining) || 0), 0)
      const hasPlan = planTotal > 0
      const baseRemaining = hasPlan ? planRemaining : remaining
      const baseTotal = hasPlan ? planTotal : todayUsed + remaining
      const remainPct = baseTotal > 0 ? (baseRemaining / baseTotal) * 100 : 0
      // 显示用：整数百分比，夹在 0–100
      const remainPctText = `${Math.min(100, Math.max(0, Math.round(remainPct)))}%`

      const frpc = st.frpc ?? {}

      // 隧道端口 vs 本机端口：只有「列表已加载 + 选中了隧道」时才有结论，
      // 否则保持未知（不提示、不出按钮），免得凭空吓人。
      const pickedTunnel = tunnels && tunnels.length
        ? tunnels.find((x) => String(x.id) === String(st.tunnelId))
        : null
      // local_port 万一缺失（NaN）也不能当成「不一致」，否则会误报并显示改端口按钮
      const tunnelPort = pickedTunnel && Number.isFinite(Number(pickedTunnel.local_port))
        ? Number(pickedTunnel.local_port)
        : null
      // 本机端口可能是 null（新装还没填）——不能 Number(null)=0 参与比较，
      // 否则会被当成「端口 0」和隧道比对，凭空报出「不一致」。
      const gatePortNum = Number.isInteger(Number(st.gatePort)) && Number(st.gatePort) > 0
        ? Number(st.gatePort)
        : null
      const portMismatch = tunnelPort !== null && gatePortNum !== null && tunnelPort !== gatePortNum

      /**
       * 四步是「渐进解锁」的，不是四个常驻字段：
       *   第一步 密钥 —— 永远显示（没有它什么都做不了）
       *   第二步 隧道 —— 有密钥才显示（列表要凭密钥才拉得到）
       *   第三步 端口 —— 选了隧道才显示（端口就是往这条隧道里送）
       *   第四步 密码 —— 端口确认可用才显示（到这一步才真的能用了）
       * 四个全摊在一屏里，新人面对的就是一堆还不该他管的字段。
       */
      const showTunnel = Boolean(st.tokenConfigured)
      const showPort = showTunnel && Boolean(st.tunnelId)
      // 「可用」= 检测通过，或插件自己的网关已经在监听这个端口（等价于可用）
      const portReady = portOk || Boolean(gatePortNum && st.gateRunning)
      const showPassword = showPort && portReady

      /** 一句到位的下一步提示：只说要做的这一件，别复述整张表单。 */
      const nextHint = !showTunnel
        ? '把管理面板里的访问密钥粘贴进来，点右边保存。'
        : !showPort
          ? '选一条隧道，或者点「新建」现建一条。'
          : !showPassword
            ? '填个本机端口，确认可用后才会出现最后一步。'
            : ''

      return h('div', { style: S.wrap },
        // ── frpc 缺失时的安装引导（置顶，最显眼）──
        h(FrpcInstallCard, { inst: st.frpcInstall, onDone: () => void loadState() }),

        // ── 总开关 + 运行状态（原来三行标题，现在并成一行）──
        h('div', { style: S.row },
          h('div', {
            style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flexWrap: 'wrap' },
            // 原来挂在标题下的那句说明，收进悬停提示：信息还在，但不占一行
            title: '关闭后立即断开公网连接，DSH 重启也不再连；本机端口与密码设置都会保留。',
          },
            h('div', { style: S.label }, '内网穿透'),
            h('span', { style: S.badge(frpc.running) },
              frpc.running ? `frpc 运行中${frpc.pid ? ` ${frpc.pid}` : ''}` : 'frpc 已停止'),
            h('span', { style: S.badge(st.gateRunning) },
              gatePortNum
                ? `:${gatePortNum} ${st.gateRunning ? '已就绪' : '未就绪'}`
                : '端口未设置')),
          h(Toggle, { on: st.enabled, disabled: busy, onChange: doToggle })),

        // 开了开关却没端口：frpc 起不来，必须说清原因，否则用户只看到「已停止」
        st.enabled && !gatePortNum
          ? h('div', { style: S.warn },
            '⚠ 开关已开，但端口空着 —— frpc 不会启动。在 ③ 填一个端口。')
          : null,

        frpc.kickSuspect
          ? h('div', {
            style: {
              ...S.warn,
              display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
            },
          },
            h('span', { style: { flex: '1 1 240px' } },
              '⚠ 连接被抢了：这条隧道正被其它客户端（SakuraFrp 启动器或另一台机器）占着，' +
              '两边会轮流掉线。先关掉那边，再点「重启」。'),
            h('button', {
              type: 'button',
              style: busy ? { ...S.btnGhost, opacity: 0.6 } : S.btnGhost,
              disabled: busy,
              onClick: doRestart,
            }, busy ? '重启中…' : '重启'))
          : null,

        // ── 公网地址 / 账号 / 流量：三行压成两行 ──
        //   第一行：公网地址 …… 今日已用 · 剩余（靠右）
        //   第二行：账号名 | 流量条 | 百分比
        frpc.tunnelUrl || user
          ? h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
            frpc.tunnelUrl
              ? h('span', { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
                h('span', { style: { ...S.hint, marginTop: 0 } }, '公网地址'),
                h(ExternalLink, {
                  href: frpc.tunnelUrl.includes('://') ? frpc.tunnelUrl : `https://${frpc.tunnelUrl}`,
                  style: { fontSize: '12px' },
                }, frpc.tunnelUrl))
              : null,
            user
              ? h('span', { style: { ...S.hint, marginTop: 0, marginLeft: 'auto' } },
                `今日已用 ${fmtBytes(todayUsed)} · 剩余 ${fmtBytes(remaining)}`)
              : null)
          : null,

        // 流量条：百分比紧贴条尾，一眼看到「还剩多少」
        user
          ? h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
            h('span', {
              style: { ...S.label, fontSize: '12px', fontWeight: 500, flex: 'none', maxWidth: '46%',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              title: `${user.name} · ${user.speed}`,
            },
              realnameText
                ? h('span', { style: S.badge(true) }, realnameText, ' ')
                : null,
              `${user.name} · ${user.speed}`),
            h('div', { style: { ...S.trafficBar, flex: '1 1 auto', minWidth: 0, marginTop: 0 } },
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
            }, remainPctText))
          : null,

        h('div', { style: S.divider }),

        // ── 连接设置 ──
        // 这里的先后顺序就是操作顺序：密钥 → 隧道 → 端口 → 密码 → 保存。
        // ⚠️ 密钥必须排第一：隧道列表要靠它调官方接口才拉得到。
        // ⚠️ 隧道排在端口前面：选定隧道后本机端口会自动跟随隧道里的端口，
        //    用户不必先猜一个数字再去面板里对齐。
        // 版式：分区标题和官方入口同一行；每个字段「标题 | 控件」一行，
        //       说明文字收进 placeholder / 悬停提示，不再每个字段占三层。
        h('div', {},
          h('div', { style: { ...S.row, gap: '10px', flexWrap: 'wrap' } },
            h('div', { style: S.label }, '连接设置')),
          // 右上角不再挂那两个域名外链：它们都在讲域名，
          // 而域名提示要等隧道跑起来才出现，提前挂在这里只会分散注意力。
          // 教程链接已挪到那句域名提示的末尾 —— 缺什么点什么。

          nextHint
            ? h('div', { style: { ...S.hint, marginTop: '3px' } }, nextHint)
            : null),

        // ① 访问密钥：「获取密钥」紧跟输入框（它解释的就是这个框从哪来）。
        //    保存做成输入框内嵌按钮 —— 贴在框里右上角，粘完密钥手不用离开输入区；
        //    而且只有框里真有东西时才出现，空框上挂个「保存」纯属噪音。
        h('div', { style: S.field },
          h('div', { style: S.flabel, title: 'SakuraFrp 管理面板 → 用户信息 → 查看访问密钥' },
            '① SakuraFrp 访问密钥'),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, flexWrap: 'wrap' } },
            h('div', { style: { position: 'relative', flex: '1 1 130px', minWidth: 0, display: 'flex' } },
              h('input', {
                // 有内嵌按钮时右侧留出它的宽度，否则长密钥会钻到按钮底下
                style: { ...S.input, flex: '1 1 auto', minWidth: 0, paddingRight: token.trim() ? '50px' : '9px' },
                type: 'password', value: token,
                placeholder: st.tokenConfigured ? '已配置，留空保持不变' : '粘贴访问密钥',
                autoComplete: 'new-password',
                onChange: (e) => setToken(e.target.value),
              }),
              token.trim()
                ? h('button', {
                  type: 'button',
                  title: '保存密钥并加载隧道',
                  style: {
                    position: 'absolute', right: '4px', top: '50%', transform: 'translateY(-50%)',
                    padding: '2px 7px', fontSize: '11px', lineHeight: 1.5,
                    borderRadius: '4px', border: 'none', cursor: busy ? 'default' : 'pointer',
                    background: '#4f6ef7', color: '#fff', opacity: busy ? 0.6 : 1,
                  },
                  disabled: busy,
                  onClick: saveAll,
                }, busy ? '…' : '保存')
                : null),
            st.tokenConfigured
              ? h('button', {
                type: 'button',
                style: { ...S.btnGhost, flex: 'none', fontSize: '12px', padding: '4px 9px' },
                disabled: busy,
                onClick: () => {
                  const ok = typeof window === 'undefined' || window.confirm(
                    '清除后隧道列表和 frpc 都会失效，需要重新填密钥。确定清除？')
                  if (!ok) return
                  void apply({ clearToken: true }).then((done) => {
                    if (!done) return
                    // 密钥没了 → 列表也拉不到了，直接清空，别留着上一轮的旧数据
                    setTunnels([])
                    setSyncMsg('')
                  })
                },
              }, '清除')
              : null,
            h(ExternalLink, {
              href: 'https://www.natfrp.com/user/',
              title: '打开 SakuraFrp 管理面板，在「用户信息」里查看访问密钥',
              style: { flex: 'none', fontSize: '12px', whiteSpace: 'nowrap' },
            }, '获取密钥 ↗'))),

        // ── ② 隧道 ──
        // 有密钥才出现：列表要凭密钥才拉得到，没密钥时这一块只会显示「加载中…」。
        // 选完由服务端把本机端口改成隧道里的端口，所以不用在下面再手填一遍端口。
        showTunnel ? h('div', {},
          // 用和 ①③④ 一样的 grid 版式，标签与下拉框的列位置对齐，
          // 别用 space-between —— 那会让下拉框被推到最右边，和上一行错开一截
          h('div', { style: S.field },
            h('div', { style: S.flabel }, '② 隧道'),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 } },
              tunnels && tunnels.length
                ? h('select', {
                  style: { ...S.input, flex: '1 1 auto', minWidth: 0 },
                  value: st.tunnelId || '',
                  disabled: busy,
                  onChange: (e) => {
                    // 在列表里挑了一条现成的 → 新建表单没有存在的理由了，直接收起。
                    // 否则下面会同时挂着「已选好的隧道」和「一份填了一半的新建表单」，
                    // 让人不知道该按哪个。
                    if (newOpen) { setNewOpen(false); setCreateErr('') }
                    return apply({ tunnelId: e.target.value })
                      .then((done) => { if (done) void loadExtra() })
                  },
                },
                  // 必须有这个空值项：tunnelId 未配置时 select 会默认显示第一项，
                  // 看起来像「已经选好了」，实际服务端是空的。
                  h('option', { value: '' }, '— 请选择隧道 —'),
                  // 不再拼「· 离线」：这条信息对「选哪条」没有帮助，纯噪音
                  tunnels.map((t) => h('option', { key: t.id, value: String(t.id) },
                    `${t.name} · ${t.nodeName}`)))
                : h('span', { style: { ...S.hint, marginTop: 0, flex: '1 1 auto' } },
                  st.tokenConfigured ? '列表加载中…' : '还没有密钥，取不到隧道列表'),
              /**
               * 按钮跟着下拉框的状态走：
               *   还停在「请选择隧道」→「新建」（这就是他此刻唯一能做的事）
               *   已经选好了        →「＋ 新建」（多一条备选）
               *   表单展开中        →「取消」
               */
              h('button', {
                type: 'button',
                style: { ...S.btnGhost, flex: 'none' },
                disabled: busy,
                onClick: () => {
                  if (newOpen) { setNewOpen(false); setCreateErr('') } else void openCreate()
                },
              }, newOpen ? '取消' : st.tunnelId ? '＋ 新建' : '新建'))),

          // ── 新建隧道（内联表单，不跳页面）──
          // 只建 TCP：不用域名、不用配解析，远程端口官方自动分配。
          newOpen
            ? h('div', {
              style: {
                marginTop: '6px', padding: '9px 11px', borderRadius: '8px',
                background: 'rgba(127,127,127,.08)',
                display: 'flex', flexDirection: 'column', gap: '7px',
              },
            },
              h('div', { style: S.hint },
                '新建一条 TCP 隧道直连本机；远程端口由官方自动分配，你不用填。'),

              /**
               * 名字 / 端口 / 节点 / 保存 全挤在同一行。
               * 这三项都是「这条隧道自己的参数」，各占一整行只是白吃高度
               * （展开表单时整个面板也就四五百像素高）。
               * 一行里塞不下三个「标题 | 控件」小网格，所以标签交给 placeholder 和 title。
               */
              h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
                h('input', {
                  style: { ...S.input, flex: '1 1 110px', minWidth: '72px' },
                  title: '隧道名，留空就叫 DSH',
                  value: newName, placeholder: '名字（留空叫 DSH）', disabled: busy,
                  onChange: (e) => setNewName(e.target.value),
                }),
                h('input', {
                  style: { ...S.input, flex: '0 0 76px', width: '76px' },
                  title: '这条隧道要连的本机端口。建好后插件自己的端口也会改成它。',
                  value: newPort, placeholder: '端口', disabled: busy, inputMode: 'numeric',
                  onChange: (e) => {
                    setNewPortMsg('')
                    setNewPort(e.target.value.replace(/[^0-9]/g, ''))
                  },
                  onBlur: () => void checkNewPort(),
                }),
                // 节点改成下拉框：原来那个内嵌列表最高 150px，展开时把面板撑出一截；
                // 下拉一收就只占一行。代价是 <option> 无法着色，状态只能写进文字。
                nodeErr
                  ? h('span', { style: { ...S.err, flex: '1 1 140px' } }, nodeErr)
                  : !nodes
                    ? h('span', { style: { ...S.hint, marginTop: 0, flex: '1 1 140px' } }, '节点加载中…')
                    // 空列表要说清原因，别只给一个空框
                    : nodes.length === 0
                      ? h('span', { style: { ...S.warn, flex: '1 1 140px' } }, '没有可用节点（可能都离线了）')
                      : h('select', {
                        style: { ...S.input, flex: '1 1 150px', minWidth: 0 },
                        value: newNode, disabled: busy,
                        onChange: (e) => setNewNode(e.target.value),
                      },
                        h('option', { value: '' }, '— 选择节点 —'),
                        nodes.map((n) => {
                          const st2 = nodeStatus(n)
                          const can = n.createAllowed !== false
                          return h('option', {
                            key: n.id, value: String(n.id), disabled: !can,
                          }, `${n.name}${n.mainland ? ' · 内地' : ''} · ${can ? st2.text : '不可新建'}`)
                        })),
                h('button', {
                  type: 'button',
                  style: busy ? { ...S.btn, flex: 'none', opacity: 0.6 } : { ...S.btn, flex: 'none' },
                  disabled: busy || !nodes,
                  onClick: doCreate,
                }, busy ? '创建中…' : '保存')),

              // 端口检测结论与报错都压到主行下面 —— 主行只放「填什么」和「提交」
              newPortMsg
                ? h('div', { style: { ...S.hint, marginTop: 0, color: newPortOk ? '#16a34a' : '#d97706' } }, newPortMsg)
                : null,

              createErr ? h('div', { style: S.err }, createErr) : null)
            : null,

          // 选了隧道但本机端口还空着：这时候谈不上「对不上」，只差一个数字
          pickedTunnel && gatePortNum === null
            ? h('div', { style: { ...S.warn, marginTop: '4px' } },
              tunnelPort
                ? `这条隧道连本机 ${tunnelPort}，插件还没设端口 —— 到 ③ 填 ${tunnelPort} 就对上了。`
                : '插件还没设端口，先到 ③ 填一个（比如 3083）。')
            : null,

          /**
           * 端口对不上（比如在官方面板里改过）：一行提示 + 一个按钮就够了。
           * ⚠️ 全篇不出现「对齐」—— 用户不知道在对齐什么，只说清事实。
           */
          pickedTunnel && portMismatch
            ? h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '4px' } },
              h('span', { style: S.warn },
                `面板里这条隧道连的是本机 ${tunnelPort}，插件在 ${gatePortNum} —— 外网会打不开。`),
              h('button', {
                type: 'button', style: busy ? { ...S.btnGhost, opacity: 0.6 } : S.btnGhost,
                disabled: busy, onClick: doAlign,
              }, `把隧道端口改成 ${gatePortNum}`))
            : null,

          // 官方提醒（新建隧道时的节点规则 / 配额说明）会常驻，必须能关掉：
          // 它讲的是「以后注意」，不是「现在就错了」，赖着不走反而像一直在报错。
          alignMsg
            ? h('div', {
              style: {
                ...(/^没改成/.test(alignMsg) ? S.err : /^⚠/.test(alignMsg) ? S.warn : S.ok),
                marginTop: '4px',
                display: 'flex', alignItems: 'flex-start', gap: '8px',
              },
            },
              h('span', { style: { flex: '1 1 auto', minWidth: 0 } }, alignMsg),
              h('button', {
                type: 'button',
                title: '关掉这条提醒',
                style: {
                  flex: 'none', fontSize: '11px', padding: '1px 7px', borderRadius: '5px',
                  border: '1px solid currentColor', background: 'transparent',
                  color: 'inherit', cursor: 'pointer', opacity: 0.75, lineHeight: 1.5,
                },
                onClick: () => setAlignMsg(''),
              }, '关闭'))
            : null,

          // 域名提示：只在隧道真跑起来后才有意义（没有公网地址时说了也白说）。
          // 只有「绑定证书」四个字带链接，「不」留在外面 —— 这是个否定句，
          // 把「不」也染成链接色会变成「不去绑定证书」，读起来正好相反。
          frpc.tunnelUrl
            ? h('div', { style: { ...S.hint, marginTop: '4px' } },
              '不',
              h(ExternalLink, {
                href: 'https://www.natfrp.com/tunnel/domain',
                style: { fontSize: '12px', whiteSpace: 'nowrap' },
              }, '绑定证书 ↗'),
              ' 会出现证书警告、白屏等；绑定子域名后即可消除。', ' ',
              h(ExternalLink, {
                href: 'https://doc.natfrp.com/bestpractice/domain-bind.html',
                style: { fontSize: '12px', whiteSpace: 'nowrap' },
              }, '绑定教程 ↗'))
            : null)
          : null,

        // ③ 本机端口：选了隧道才出现（端口就是往这条隧道里送的，没隧道时填它没意义）。
        //    填完就查一次能不能用；改它会把隧道里的端口一起改掉。
        showPort ? h('div', { style: S.field },
          h('div', {
            style: S.flabel,
            title: '穿透流量从这个端口进出。改这里会同时把 SakuraFrp 面板里这条隧道的「本地端口」改成一样的数。',
          }, '③ 本机端口'),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
            h('input', {
              style: { ...S.input, width: '92px', flex: 'none' },
              value: gatePort,
              // 空就是空，不给占位数字冒充默认值：占位符一旦长得像已填好的值，
              // 用户会以为端口已经定了，直接点保存。
              placeholder: '例如 3083',
              onChange: (e) => {
                portDirty.current = true // 用户正在编辑，轮询不要覆盖
                setPortMsg('')
                setSyncMsg('')
                setGatePort(e.target.value.replace(/[^0-9]/g, ''))
              },
              onBlur: () => void checkPort(gatePort),
            }),
            portMsg
              ? h('span', {
                style: { ...S.hint, marginTop: 0, color: portOk ? '#16a34a' : '#d97706' },
              }, portMsg)
              : h('span', { style: { ...S.hint, marginTop: 0 } },
                gatePortNum ? '改这里会同时改隧道里的端口' : '还没填，比如 3083'))) : null,

        // 端口同步的结果（保存或选隧道后才有），没有就不占行
        syncMsg ? h('div', { style: /^⚠/.test(syncMsg) ? S.warn : S.ok }, syncMsg) : null,

        // ④ 访问密码：等端口确认可用才出现。
        //    到这里才是「能被外网访问了」，此时设密码才有对象可言；
        //    前面几步还没成型就先摆一个密码框，只会让人以为非填不可。
        showPassword ? h('div', { style: S.field },
          h('div', {
            style: S.flabel,
            title: '建议 20 位以上随机串。没密码时外网一律打不开（防止 DSH 被别人白用）。',
          }, '④ 访问密码'),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
            h('input', {
              style: S.input,
              type: 'password', value: gatePassword,
              placeholder: st.gatePasswordConfigured ? '已设置，留空保持不变' : '建议 20 位以上随机串',
              autoComplete: 'new-password',
              onChange: (e) => setGatePassword(e.target.value),
            }),
            st.gatePasswordConfigured
              ? h('button', {
                type: 'button',
                style: { ...S.btnGhost, flex: 'none', fontSize: '12px' },
                disabled: busy,
                onClick: () => {
                  const ok = typeof window === 'undefined' || window.confirm(
                    '清除后外网访问会一直失败，直到重新设置密码。确定清除？')
                  if (!ok) return
                  void apply({ clearGatePassword: true })
                },
              }, '清除')
              : null)) : null,

        showPassword && !st.gatePasswordConfigured
          ? h('div', { style: S.warn },
            '⚠ 还没设密码。没密码时外网一律打不开（防止 DSH 被别人白用），请填一个再保存。')
          : null,

        // ── 保存 ──
        // 主保存按钮在 ① 右侧（粘贴完密钥顺手就能存）；这里留一个次级入口，
        // 因为改完 ④ 密码时视线就在底部，不必再滚回面板顶部找按钮。
        // 两个按钮同一份逻辑（saveAll），不会出现「这个能存、那个不能存」。
        showTunnel
          ? h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginTop: '2px' } },
            h('button', {
              type: 'button', style: busy ? { ...S.btnGhost, opacity: 0.6 } : S.btnGhost,
              disabled: busy,
              onClick: saveAll,
            }, busy ? '保存中…' : '保存'),
            saved ? h('span', { style: S.ok }, saved) : null,
            err ? h('span', { style: S.err }, err) : null,
            !err && pollErr ? h('span', { style: S.err }, pollErr) : null)
          : h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
            saved ? h('span', { style: S.ok }, saved) : null,
            err ? h('span', { style: S.err }, err) : null,
            !err && pollErr ? h('span', { style: S.err }, pollErr) : null),

        // ── 日志 ──
        // 不再单独加分割线：按钮本身就是边界，多一条线多占一行高度
        // ⚠️ 日志现在默认展开且每 2s 刷新，所以必须限高：frpc 跑久了能写几千行，
        //    不限高就会把整个设置页拉成一屏都装不下的一条长条。
        //    限高后鼠标停在日志上滚动只在日志内部走，滚到边界会自然交给外层，
        //    因此不会出现「滚不动外层」——「在新窗口打开」也留着，看全量用那个。
        h('div', {},
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
            h('button', {
              type: 'button',
              style: { ...S.btnGhost, padding: '3px 10px', fontSize: '12px' },
              onClick: () => setLogsOpen((v) => !v),
            },
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
              ref: logRef,
              // 自动跟到最新一行，但用户往上翻看旧日志时不抢滚动条
              onScroll: (e) => {
                const el = e.currentTarget
                logPinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
              },
              style: {
                marginTop: '6px', padding: '8px 10px', borderRadius: '6px',
                background: 'rgba(127,127,127,.08)', fontSize: '11px', lineHeight: 1.5,
                whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                maxHeight: '220px', overflowY: 'auto',
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
    const SIDEBAR_CSS_ID = 'dsh-sakurafrp/sidebar-dot.css'

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
      tag.dataset.plugin = 'dsh-sakurafrp'
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