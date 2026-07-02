import React, { createContext, useContext, useMemo } from 'react'
import {
  setDismissibleLayerBridge,
  type DismissibleLayerBridge,
  type DismissibleLayerRegistration,
} from '@/lib/dismissible-layer-bridge'

/**
 * 可关闭层（Dismissible Layer）上下文
 *
 * 管理页面中所有“按 Esc 或返回键可以关闭的层”，例如弹窗、下拉菜单、侧边抽屉等。
 * 它会按优先级和打开顺序维护一个栈，确保一次 Escape 只关闭最上面一层。
 *
 * 对 Go 同学来说，类似一个带优先级的堆栈，但这里用 Map + 排序实现，
 * 并且提供全局桥接（bridge），让键盘事件处理器能找到当前最上层。
 */

// DismissibleLayer 是内部使用的完整层对象
// Required<Pick<...>> 表示从 DismissibleLayerRegistration 里取出几个字段并设为必填
export interface DismissibleLayer extends Required<Pick<DismissibleLayerRegistration, 'id' | 'type' | 'priority' | 'close'>> {
  /** 该层当前是否处于打开状态 */
  isOpen: boolean
  /** 可选：判断当前层能否“返回上一级”（例如子菜单展开时） */
  canBack?: () => boolean
  /** 可选：执行返回上一级，返回 true 表示成功返回 */
  back?: () => boolean
  /** 注册顺序号；优先级相同时，后打开的在上面 */
  order: number
}

// 上下文值直接复用 DismissibleLayerBridge 的接口
interface DismissibleLayerContextValue extends DismissibleLayerBridge {}

const DismissibleLayerContext = createContext<DismissibleLayerContextValue | null>(null)

// 注册表接口：在 Bridge 基础上增加 registerLayer 方法
export interface DismissibleLayerRegistry extends DismissibleLayerBridge {
  registerLayer: (layer: DismissibleLayerRegistration) => () => void
}

/**
 * 创建层的注册表实例（工厂函数）
 * 返回一个包含注册、查询、关闭等方法的对象。
 */
export function createDismissibleLayerRegistry(): DismissibleLayerRegistry {
  // 用 Map 保存所有已注册的层，键是 layer id
  const layers = new Map<string, DismissibleLayer>()
  // 自增序号，用来在优先级相同时判断“后打开的在上面”
  let orderSeed = 0

  /**
   * 获取当前打开的层，并按优先级降序、再按 order 降序排列
   * 这样数组第一个元素就是最该被关闭的那一层。
   */
  const getOrderedOpenLayers = (): DismissibleLayer[] => {
    const open = Array.from(layers.values()).filter((layer) => layer.isOpen)
    open.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority
      return b.order - a.order
    })
    return open
  }

  /**
   * 注册一个层，返回注销函数。
   * 注册时会补上默认值：priority 默认 0，isOpen 默认 true。
   */
  const registerLayer = (layer: DismissibleLayerRegistration) => {
    const order = ++orderSeed
    layers.set(layer.id, {
      id: layer.id,
      type: layer.type,
      priority: layer.priority ?? 0,
      isOpen: layer.isOpen ?? true,
      close: layer.close,
      canBack: layer.canBack,
      back: layer.back,
      order,
    })

    return () => {
      layers.delete(layer.id)
    }
  }

  /** 当前是否有任何打开的层 */
  const hasOpenLayers = () => getOrderedOpenLayers().length > 0

  /** 获取最上层打开层的基本信息 */
  const getTopLayer = () => {
    const top = getOrderedOpenLayers()[0]
    if (!top) return null

    return {
      id: top.id,
      type: top.type,
      priority: top.priority,
    }
  }

  /** 关闭最上层打开的层，成功返回 true */
  const closeTop = () => {
    const top = getOrderedOpenLayers()[0]
    if (!top) return false
    top.close()
    return true
  }

  /**
   * 处理 Escape 键：先尝试 back（返回上一级），如果不能再调用 close。
   * 这样多层嵌套的菜单可以先回退，再关闭。
   */
  const handleEscape = () => {
    const top = getOrderedOpenLayers()[0]
    if (!top) return false

    if (top.canBack?.() && top.back) {
      const wentBack = top.back()
      if (wentBack) return true
    }

    top.close()
    return true
  }

  return {
    registerLayer,
    hasOpenLayers,
    getTopLayer,
    closeTop,
    handleEscape,
  }
}

/**
 * DismissibleLayerProvider：把注册表注入子树，并绑定全局 Escape 事件
 * 同时把注册表设置到 bridge，让应用其他部分也能拿到。
 */
export function DismissibleLayerProvider({ children }: { children: React.ReactNode }) {
  // useMemo 保证 Provider 生命周期内只创建一个注册表实例
  const registry = useMemo(() => createDismissibleLayerRegistry(), [])

  // 挂载时把注册表设到全局桥，卸载时清空
  React.useEffect(() => {
    setDismissibleLayerBridge(registry)
    return () => setDismissibleLayerBridge(null)
  }, [registry])

  // 监听 window 的 keydown，在冒泡阶段处理 Escape
  // 冒泡阶段能让输入框等内部控件先消费 Escape，处理不了的再交给层注册表
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (event.defaultPrevented) return

      const handled = registry.handleEscape()
      if (!handled) return

      event.preventDefault()
      event.stopPropagation()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [registry])

  return (
    <DismissibleLayerContext.Provider value={registry}>
      {children}
    </DismissibleLayerContext.Provider>
  )
}

/**
 * 获取层注册表的 Hook，必须在 DismissibleLayerProvider 内部使用
 */
export function useDismissibleLayerRegistry() {
  const context = useContext(DismissibleLayerContext)
  if (!context) {
    throw new Error('useDismissibleLayerRegistry must be used within a DismissibleLayerProvider')
  }
  return context
}

/**
 * 注册一个可关闭层的 Hook
 * layer 为 null 时不注册；组件卸载或 layer 变化时自动注销。
 */
export function useRegisterDismissibleLayer(layer: DismissibleLayerRegistration | null) {
  const { registerLayer } = useDismissibleLayerRegistry()

  React.useEffect(() => {
    if (!layer) return
    const unregister = registerLayer(layer)
    return unregister
  }, [layer, registerLayer])
}
