/**
 * 可拖拽排序列表组件（SortableList）。
 * 基于 @dnd-kit 实现扁平列表的拖拽重排，特性包括：
 * - SmartPointerSensor：5px 触发距离，并跳过带 data-no-dnd 的元素
 * - KeyboardSensor：支持键盘无障碍操作
 * - DragOverlay 使用 position:fixed，确保层级在所有面板之上
 * - 释放时交叉淡入淡出动画
 * - 兄弟节点通过 CSS transform 平滑重排
 */

import * as React from 'react'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  DragOverlay,
  type DragStartEvent,
  type DragEndEvent,
  type DropAnimation,
  type MeasuringConfiguration,
  MeasuringStrategy,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

// ============================================================
// 自定义 PointerSensor：跳过 data-no-dnd 元素
// 这样可交互元素（如折叠箭头）即便在可拖拽容器内也能正常接收点击。
// ============================================================

function hasNoDndAncestor(element: HTMLElement | null): boolean {
  while (element) {
    if (element.dataset?.noDnd === 'true') return true
    element = element.parentElement
  }
  return false
}

/** 智能指针传感器。 */
export class SmartPointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: 'onPointerDown' as const,
      handler: ({ nativeEvent }: { nativeEvent: PointerEvent }) => {
        // 如果点击目标或其任意祖先有 data-no-dnd="true"，则不触发拖拽
        if (hasNoDndAncestor(nativeEvent.target as HTMLElement)) {
          return false
        }
        return true
      },
    },
  ]
}

// ============================================================
// 释放动画配置
// 交叉淡入淡出：overlay 在最终位置淡出，同时 ghost 在新位置淡入。
// ============================================================

const DROP_DURATION = 250

const dropAnimationConfig: DropAnimation = {
  keyframes({ transform }) {
    return [
      { opacity: 1, transform: CSS.Transform.toString(transform.initial) },
      { opacity: 0, transform: CSS.Transform.toString(transform.final) },
    ]
  },
  duration: DROP_DURATION,
  easing: 'ease',
  sideEffects({ active }) {
    // ghost 同时在新位置淡入
    active.node.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: DROP_DURATION,
      easing: 'ease',
    })
  },
}

// 测量配置：始终重新测量，以支持带动画的布局
const measuringConfig: MeasuringConfiguration = {
  droppable: {
    strategy: MeasuringStrategy.Always,
  },
}

// ============================================================
// 类型
// ============================================================

/** 可排序项数据，要求每项都有唯一 id。 */
export interface SortableItemData {
  id: string
}

interface SortableListProps<T extends SortableItemData> {
  /** 要渲染的数据数组，每项必须有唯一 id。 */
  items: T[]
  /** 释放后回调，传入新的数组顺序。 */
  onReorder: (items: T[]) => void
  /** 每项的渲染函数；isDragging 为 true 表示当前项是 ghost。 */
  renderItem: (item: T, isDragging: boolean) => React.ReactNode
  /** 拖拽时悬浮克隆内容的渲染函数，默认使用 renderItem。 */
  renderOverlay?: (item: T) => React.ReactNode
  /** 拖拽时是否显示 DragOverlay 克隆（默认 true）。 */
  showOverlay?: boolean
  /** 列表容器额外的 className。 */
  className?: string
}

// ============================================================
// SortableList 组件
// ============================================================

/** 可拖拽排序列表。 */
export function SortableList<T extends SortableItemData>({
  items,
  onReorder,
  renderItem,
  renderOverlay,
  showOverlay = true,
  className,
}: SortableListProps<T>) {
  const [activeId, setActiveId] = React.useState<string | null>(null)

  // 传感器：SmartPointerSensor 跳过 data-no-dnd，KeyboardSensor 支持键盘
  const sensors = useSensors(
    useSensor(SmartPointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(KeyboardSensor)
  )

  const activeItem = React.useMemo(
    () => items.find(item => item.id === activeId),
    [items, activeId]
  )

  const handleDragStart = React.useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id))
  }, [])

  const handleDragEnd = React.useCallback((event: DragEndEvent) => {
    const { active, over } = event
    setActiveId(null)

    if (!over || active.id === over.id) return

    const oldIndex = items.findIndex(item => item.id === active.id)
    const newIndex = items.findIndex(item => item.id === over.id)

    if (oldIndex !== -1 && newIndex !== -1) {
      onReorder(arrayMove(items, oldIndex, newIndex))
    }
  }, [items, onReorder])

  const handleDragCancel = React.useCallback(() => {
    setActiveId(null)
  }, [])

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
      measuring={measuringConfig}
    >
      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        <div className={className}>
          {items.map(item => (
            <SortableItemWrapper
              key={item.id}
              id={item.id}
              isDragActive={activeId === item.id}
              hideWhileDragging={showOverlay}
            >
              {renderItem(item, activeId === item.id)}
            </SortableItemWrapper>
          ))}
        </div>
      </SortableContext>

      {/* DragOverlay 使用 position:fixed，能脱离所有层叠上下文和 overflow 裁剪。
         内联 boxShadow 是为了避免 Tailwind CSS 变量在 portal 中的作用域问题。 */}
      {showOverlay && (
        <DragOverlay
          dropAnimation={dropAnimationConfig}
          style={{ zIndex: 'var(--z-floating-menu, 400)' }}
        >
          {activeItem ? (
            <div
              className="sortable-overlay rounded-[6px] bg-background"
              style={{
                boxShadow: '0 0 0 1px rgba(63, 63, 68, 0.05), 0px 15px 15px 0 rgba(34, 33, 81, 0.25)',
              }}
            >
              {(renderOverlay ?? renderItem)(activeItem, false)}
            </div>
          ) : null}
        </DragOverlay>
      )}
    </DndContext>
  )
}

// ============================================================
// SortableItemWrapper —— 为每个项提供 useSortable 能力
// ============================================================

interface SortableItemWrapperProps {
  id: string
  isDragActive: boolean
  hideWhileDragging: boolean
  children: React.ReactNode
}

function SortableItemWrapper({ id, isDragActive, hideWhileDragging, children }: SortableItemWrapperProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    // 只在启用 DragOverlay 时隐藏 ghost，避免重复显示
    opacity: isDragging && hideWhileDragging ? 0 : 1,
    cursor: isDragActive ? 'grabbing' : 'grab',
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  )
}

export { arrayMove } from '@dnd-kit/sortable'
