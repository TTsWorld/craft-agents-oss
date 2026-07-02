import { atom } from 'jotai'

/**
 * 标记是否打开了全屏遮罩层（例如创建工作区时）。
 * AppShell 用它给主内容区加一个缩放回退效果。
 *
 * Jotai 的 atom(false) 创建一个布尔状态；get/set 由 useAtom/useSetAtom 在组件里消费。
 */
export const fullscreenOverlayOpenAtom = atom(false)
