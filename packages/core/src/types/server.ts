/**
 * 无头服务器（headless server）相关的类型。
 *
 * Craft Agent 除了桌面端，还可以作为后台服务运行（`server:` RPC 命名空间）。
 * 这些类型用于：
 * - 服务器状态/健康检查
 * - 活跃会话发现
 * - 无头模式配置引导
 */

// ---------------------------------------------------------------------------
// 服务器状态与健康
// ---------------------------------------------------------------------------

/**
 * 服务器状态快照。
 *
 * 类似 Golang HTTP /status 接口返回的 JSON 结构体，
 * 包含运行时长、连接客户端数、工作区列表、内存使用等。
 */
export interface ServerStatus {
  serverId: string
  version: string
  uptime: number              // 自启动以来的秒数
  connectedClients: number
  workspaces: {
    id: string
    name: string
    slug: string
    activeSessions: number    // 该工作区下活跃会话数
    automationCount: number   // 自动化任务数
    schedulerRunning: boolean // 定时调度器是否运行中
  }[]
  memory: {
    heapUsed: number          // 堆内存使用（字节）
    heapTotal: number
    rss: number               // 常驻内存
  }
}

/**
 * 服务器健康检查结果。
 *
 * status 是整体状态，checks 是各个子检查项的明细。
 */
export interface ServerHealth {
  status: 'ok' | 'degraded' | 'unhealthy'
  checks: {
    name: string
    status: 'pass' | 'fail'
    message?: string
  }[]
}

// ---------------------------------------------------------------------------
// 活跃会话发现
// ---------------------------------------------------------------------------

/**
 * 会话处理状态（用类型化联合替代裸字符串，避免拼写错误）。
 */
export type SessionProcessingStatus =
  | 'idle'           // 空闲
  | 'processing'     // 处理中
  | 'waiting_input'  // 等待用户输入
  | 'error'          // 出错
  | 'completed'      // 完成

/**
 * 跨工作区的活跃会话信息（对客户端安全的 DTO）。
 */
export interface ActiveSessionInfo {
  sessionId: string
  workspaceId: string
  workspaceName: string
  title?: string
  status: SessionProcessingStatus
  triggeredBy?: {
    automationName: string // 由哪个自动化任务触发
    timestamp: number
  }
  createdAt: number
}

