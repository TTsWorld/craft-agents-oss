/**
 * 通用实体面板组件（EntityPanel<T>）。
 * 基于 EntityList + EntityRow + useEntityListInteractions 封装，
 * 内置键盘导航与多选逻辑，调用方只需通过 mapItem 把数据映射为面板项。
 */

import * as React from 'react'
import { useAction } from '@/actions'
import { EntityList } from './entity-list'
import { EntityRow } from './entity-row'
import { useEntityListInteractions } from '@/hooks/useEntityListInteractions'
import type { createEntitySelection } from '@/hooks/useEntitySelection'

/** 单个面板项的结构，调用方通过 mapItem 返回该结构。 */
export interface EntityPanelItem {
  icon?: React.ReactNode           // 左侧图标
  title: React.ReactNode           // 主标题
  badges?: React.ReactNode         // 标题右侧徽章区域
  trailing?: React.ReactNode       // 最右侧附加内容
  menu?: React.ReactNode           // 右键菜单内容
  dataAttributes?: Record<string, string | undefined> // 自定义 data 属性
}

/** EntityPanel 的 props。 */
export interface EntityPanelProps<T> {
  items: T[]                       // 数据列表
  getId: (item: T) => string       // 从数据中提取唯一 ID
  mapItem: (item: T) => EntityPanelItem // 把数据映射为面板项
  selection: ReturnType<typeof createEntitySelection> // 多选状态管理
  onItemClick: (item: T) => void   // 点击回调
  selectedId?: string | null       // 当前选中项的 ID
  emptyState?: React.ReactNode     // 列表为空时展示的内容
  className?: string               // 外层样式类
  /** 合并到内部列表容器的额外 data/aria 属性，
   *  可用于设置 data-list-role，让紧凑模式下的 CSS 命中正确列表。 */
  containerProps?: Record<string, string>
}

/** 实体面板组件。 */
export function EntityPanel<T>({
  items,
  getId,
  mapItem,
  selection,
  onItemClick,
  selectedId,
  emptyState,
  className,
  containerProps,
}: EntityPanelProps<T>) {
  // 取出多选状态 store，用于列表交互 hook
  const selectionStore = selection.useSelectionStore()
  // 初始化键盘导航与多选交互
  const interactions = useEntityListInteractions<T>({
    items,
    getId,
    keyboard: {
      onNavigate: (item) => onItemClick(item),
      onActivate: (item) => onItemClick(item),
    },
    multiSelect: true,
    selectionStore,
  })

  // 注册全局 action：在多选激活时清空选择
  useAction('navigator.clearSelection', () => {
    interactions.selection.clear()
  }, {
    enabled: () => interactions.selection.isMultiSelectActive,
  }, [interactions.selection])

  // 合并外部传入的容器属性与交互 hook 生成的容器属性
  const mergedContainerProps = containerProps
    ? { ...interactions.listProps.containerProps, ...containerProps }
    : interactions.listProps.containerProps

  return (
    <EntityList
      items={items}
      getKey={getId}
      containerRef={interactions.listProps.containerRef}
      containerProps={mergedContainerProps}
      className={className}
      emptyState={emptyState}
      renderItem={(item, index, isFirst) => {
        const mapped = mapItem(item)
        const rowProps = interactions.getRowProps(item, index)
        return (
          <EntityRow
            icon={mapped.icon}
            title={mapped.title}
            badges={mapped.badges}
            trailing={mapped.trailing}
            isSelected={selectedId === getId(item)}
            isInMultiSelect={rowProps.isInMultiSelect}
            showSeparator={!isFirst}
            onMouseDown={(e) => {
              rowProps.onMouseDown(e)
              // 非组合键、非右键点击时触发点击回调
              if (!e.metaKey && !e.ctrlKey && !e.shiftKey && e.button !== 2) {
                onItemClick(item)
              }
            }}
            buttonProps={rowProps.buttonProps}
            menuContent={mapped.menu}
            dataAttributes={mapped.dataAttributes}
          />
        )
      }}
    />
  )
}
