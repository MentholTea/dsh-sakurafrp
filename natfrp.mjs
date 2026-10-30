// natfrp.mjs — SakuraFrp OpenAPI v4 客户端。
//
// 契约来源：https://api.natfrp.com/docs/openapi.yaml (API 4.1.0, OAS 3.0)
//   鉴权：  Authorization: Bearer <token>（规范 securitySchemes.UserToken）
//   错误：  HTTP 非 2xx 时 body 为 {code:int, msg:string}
//   写端点：全部 POST，application/x-www-form-urlencoded 或 JSON 均可（规范锚点复用）

const BASE = 'https://api.natfrp.com/v4'
const UA = 'dsh-sakurafrp/2.0 (DeepSeek Harness plugin)'

export class ApiError extends Error {
  constructor(code, msg, status) {
    super(`[${status ?? code}] ${msg}`)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

/**
 * @param {string} token 访问密钥
 * @param {{timeoutMs?:number, log?:Function}} [opts]
 */
export function createClient(token, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) || 12000
  const log = opts.log ?? (() => {})

  async function call(method, path, { query, form } = {}) {
    const url = new URL(BASE + path)
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
    }

    const headers = {
      'user-agent': UA,
      authorization: `Bearer ${token}`,
    }

    let body
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded'
      body = new URLSearchParams(
        Object.fromEntries(Object.entries(form).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])),
      ).toString()
    }

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    let res
    try {
      res = await fetch(url, { method, headers, body, signal: ac.signal })
    } catch (e) {
      if (e?.name === 'AbortError') throw new ApiError(0, `请求超时 (${timeoutMs}ms): ${path}`, 0)
      throw new ApiError(0, `网络错误: ${e?.message ?? e}`, 0)
    } finally {
      clearTimeout(timer)
    }

    const text = await res.text()
    let data
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = text
    }

    if (!res.ok) {
      const code = typeof data === 'object' && data ? Number(data.code ?? res.status) : res.status
      const msg = typeof data === 'object' && data ? String(data.msg ?? '未知错误') : String(text).slice(0, 200)
      log(`api ${method} ${path} -> ${res.status} ${msg}`)
      throw new ApiError(code, msg, res.status)
    }
    return data
  }

  return {
    /** 隧道列表：[{id,name,node,type,online,status,status_reason,note,extra,remote,local_ip,local_port,export}] */
    tunnels: () => call('GET', '/tunnels'),
    /** 用户信息：{id,name,avatar,speed,tunnels,realname,group,traffic:[本日消耗,总剩余],sign,...} */
    userInfo: () => call('GET', '/user/info'),
    /**
     * 流量包：[{id,name,type,total,remaining,start_time,end_time}, ...]
     * ⚠️ 与 userInfo.traffic 的口径不同：这里才有「总量」(total)，
     * userInfo.traffic[1] 是「总剩余」而不是总量 —— 算百分比必须用本端点。
     */
    dataPlans: (status = 'valid') => call('GET', '/user/data_plans', { query: { status } }),
    /** 流量历史：type=day|week|month -> [['2026-10', used, total], ...] */
    trafficHistory: (type = 'day') => call('GET', '/user/traffic_history', { query: { type } }),
    /** 节点列表：{nodeId: {name,host,description,vip,flag,band}} */
    nodes: () => call('GET', '/nodes'),
    /** 节点状态：{time, nodes:[{id,online,uptime,load}]} */
    nodeStats: () => call('GET', '/node/stats'),
    /** 单隧道流量历史：{timestamp: bytes} */
    tunnelTraffic: (id) => call('GET', '/tunnel/traffic', { query: { id } }),
    /**
     * 编辑隧道（写操作）。只传要改的字段。
     * @param {{id:number, note?:string, local_ip?:string, local_port?:number, extra?:string}} patch
     */
    tunnelEdit: (patch) => call('POST', '/tunnel/edit', { form: patch }),
    /**
     * 获取隧道配置文件文本（ini/toml），可直接落盘给 frpc 用。
     * @param {string} query 如 '114514' 或 'n233,n234,114514'
     * @param {string} frpcVer 如 '0.51.0-sakura-15.1'
     */
    tunnelConfig: (query, frpcVer) => call('POST', '/tunnel/config', { form: { query, frpc: frpcVer } }),
    /** 锁定/解锁隧道编辑、删除、迁移。 */
    tunnelLock: (id, { edit, delete: del, migrate } = {}) =>
      call('POST', '/tunnel/lock', { form: { id, edit, delete: del, migrate } }),
    /** 迁移隧道到其它节点。 */
    tunnelMigrate: (id, node) => call('POST', '/tunnel/migrate', { form: { id, node } }),
    /** 删除隧道（最多 10 条），返回 {deleted:number[], failed:number[]}。 */
    tunnelDelete: (ids) => call('POST', '/tunnel/delete', { form: { ids: ids.join(',') } }),
    /** 创建隧道。remote 对 http/https 是绑定域名，对 tcp/udp 是远程端口。 */
    tunnelCreate: ({ name, type, node, note, extra, local_ip, local_port, remote }) =>
      call('POST', '/tunnels', { form: { name, type, node, note, extra, local_ip, local_port, remote } }),
  }
}

/** 节点 flag 位含义（OpenAPI /nodes.flag），用于 UI 提示。 */
export const NODE_FLAG = {
  HTTP_TUNNEL: 0b11,
  ALLOW_CREATE: 1 << 2,
  MAINLAND: 1 << 3,
  NO_PROTECT: 1 << 4,
  UDP: 1 << 5,
  PRIVATE: 1 << 6,
  TLS_SUCKS: 1 << 7,
  FORCE_AUTH: 1 << 8,
  OFFLINE: 1 << 9,
  BETA: 1 << 10,
  PUBLIC_GAME: 1 << 11,
}

/** 字节数转人类可读。 */
export function fmtBytes(n) {
  const v = Number(n) || 0
  if (v < 1024) return `${v} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let i = -1
  let x = v
  do { x /= 1024; i++ } while (x >= 1024 && i < units.length - 1)
  return `${x.toFixed(x >= 100 ? 0 : 1)} ${units[i]}`
}
