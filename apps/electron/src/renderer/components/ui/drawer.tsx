/**
 * Drawer — 从 @craft-agent/ui 重新导出。
 *
 * 实现已移到 packages/ui，以便共享聊天组件（例如 TurnCard 中的紧凑 Accept-Plan 抽屉）使用。
 * 现有 `@/components/ui/drawer` 导入通过此 shim 继续生效。
 */
export {
  Drawer,
  DrawerPortal,
  DrawerOverlay,
  DrawerTrigger,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerFooter,
  DrawerTitle,
  DrawerDescription,
} from '@craft-agent/ui/ui/drawer'
