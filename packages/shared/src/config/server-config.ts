/**
 * 服务端模式配置：控制 Electron 应用是否接受来自其他机器的远程连接。
 *
 * 启用后，应用会绑定到 0.0.0.0 的固定端口（而不是 localhost 的随机端口），
 * 这样瘦客户端才能连进来。可以理解为“是否开启远程 Agent 服务”。
 */

/** 服务端模式配置项（类似 Go 的结构体） */
export interface ServerConfig {
  /** 是否启用远程服务（true 绑定 0.0.0.0，false 只监听 127.0.0.1） */
  enabled: boolean
  /** 固定监听端口，默认 9100 */
  port: number
  /** PEM 证书路径，设置后启用 wss:// TLS */
  tlsCertPath?: string
  /** PEM 私钥路径，配了证书时必须填 */
  tlsKeyPath?: string
  /** 远程客户端连接用的稳定鉴权 token，首次启用时自动生成 */
  token?: string
}

/** 服务端实时运行状态 */
export interface ServerStatus {
  /** 服务是否正在运行 */
  running: boolean
  /** 当前绑定地址 */
  host: string
  /** 当前监听端口 */
  port: number
  /** 是否启用了 TLS */
  tls: boolean
  /** 完整连接 URL（ws:// 或 wss://） */
  url: string
  /** 当前鉴权 token */
  token: string
  /** 已保存配置与运行中配置不一致，需要重启 */
  needsRestart: boolean
  /** 如果服务绑定到公网地址且没有 TLS，提示不安全 */
  insecureWarning: boolean
}

/** 服务端默认配置 */
export const DEFAULT_SERVER_CONFIG: ServerConfig = {
  enabled: false,
  port: 9100,
}
