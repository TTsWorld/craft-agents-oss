/**
 * 可关闭层（弹窗、菜单、浮层等）的跨层通信桥。
 * 维护一份注册表，让全局快捷键（如 Esc）知道当前最上层是谁、该由谁处理返回/关闭。
 * 类似 Go 里的一个全局注册中心，只不过这里是浏览器侧的 globalThis 挂载点。
 */

export type DismissibleLayerType = 'radix-dialog' | 'radix-popover' | 'island' | 'modal' | 'custom'

export interface DismissibleLayerRegistration {
  id: string
  type: DismissibleLayerType
  priority?: number
  isOpen?: boolean
  close: () => void
  canBack?: () => boolean
  back?: () => boolean
}

export interface DismissibleLayerSnapshot {
  id: string
  type: DismissibleLayerType
  priority: number
}

export interface DismissibleLayerBridge {
  registerLayer: (layer: DismissibleLayerRegistration) => () => void
  hasOpenLayers: () => boolean
  getTopLayer: () => DismissibleLayerSnapshot | null
  closeTop: () => boolean
  handleEscape: () => boolean
}

const BRIDGE_KEY = '__craftAgentDismissibleLayerBridge__'

type BridgeHost = typeof globalThis & {
  [BRIDGE_KEY]?: DismissibleLayerBridge | null
}

function getBridgeHost(): BridgeHost {
  return globalThis as BridgeHost
}

export function setDismissibleLayerBridge(bridge: DismissibleLayerBridge | null): void {
  getBridgeHost()[BRIDGE_KEY] = bridge
}

export function getDismissibleLayerBridge(): DismissibleLayerBridge | null {
  return getBridgeHost()[BRIDGE_KEY] ?? null
}
