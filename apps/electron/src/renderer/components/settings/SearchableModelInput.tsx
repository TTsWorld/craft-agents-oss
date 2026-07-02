/**
 * SearchableModelInput
 *
 * 带下拉按钮的可搜索模型输入框。
 * 用于 API 设置里的自定义模型名称配置：点击下拉会拉取模型列表，
 * 用户可以在弹出的Popover里搜索并选择模型。
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Spinner } from '@craft-agent/ui'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

export interface ModelOption {
  /** 模型唯一标识 */
  id: string
  /** 模型展示名称（可选） */
  name?: string
}

export interface SearchableModelInputProps {
  /** 当前输入值 */
  value: string
  /** 值变化时的回调 */
  onChange: (value: string) => void
  /** 失去焦点时的回调（常用于触发保存） */
  onBlur?: () => void
  /** 占位提示 */
  placeholder?: string
  /** 可供选择的模型列表 */
  models: ModelOption[]
  /** 是否正在拉取模型列表 */
  isLoading?: boolean
  /** 点击下拉按钮时触发拉取模型 */
  onFetchModels?: () => void
  /** 是否禁用拉取按钮 */
  fetchDisabled?: boolean
  /** 额外 className */
  className?: string
}

export function SearchableModelInput({
  value,
  onChange,
  onBlur,
  placeholder = 'e.g., claude-sonnet-4-6',
  models,
  isLoading,
  onFetchModels,
  fetchDisabled,
  className,
}: SearchableModelInputProps) {
  const { t } = useTranslation()
  // Popover 是否打开
  const [isOpen, setIsOpen] = React.useState(false)
  // 搜索关键词
  const [searchQuery, setSearchQuery] = React.useState('')
  // 搜索框 ref，用于打开后自动聚焦
  const searchInputRef = React.useRef<HTMLInputElement>(null)

  // 根据搜索词过滤模型列表（useMemo 避免每次渲染都重新过滤）
  const filteredModels = React.useMemo(() => {
    if (!searchQuery.trim()) return models
    const query = searchQuery.toLowerCase()
    return models.filter(
      (model) =>
        model.id.toLowerCase().includes(query) ||
        model.name?.toLowerCase().includes(query)
    )
  }, [models, searchQuery])

  // 选中某个模型后：更新值、关闭弹窗、清空搜索、触发 blur 保存
  const handleSelect = (modelId: string) => {
    onChange(modelId)
    setIsOpen(false)
    setSearchQuery('')
    onBlur?.()
  }

  // 点击下拉按钮：先拉取模型，打开弹窗，再聚焦搜索框
  const handleFetchClick = async () => {
    if (onFetchModels) {
      await onFetchModels()
      setIsOpen(true)
      // 等模型加载完后再聚焦搜索框
      setTimeout(() => searchInputRef.current?.focus(), 50)
    }
  }

  // Popover 打开/关闭时的清理和聚焦逻辑
  const handleOpenChange = (open: boolean) => {
    setIsOpen(open)
    if (!open) {
      setSearchQuery('')
    } else if (models.length > 0) {
      // 打开时聚焦搜索框
      setTimeout(() => searchInputRef.current?.focus(), 0)
    }
  }

  return (
    <div className={cn('relative', className)}>
      <Input
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        className="pr-12"
      />
      <Popover open={isOpen} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="absolute right-1 top-1 h-7"
            onClick={handleFetchClick}
            disabled={fetchDisabled || isLoading}
          >
            {isLoading ? <Spinner className="size-3" /> : '▼'}
          </Button>
        </PopoverTrigger>
        {models.length > 0 && (
          <PopoverContent
            align="end"
            sideOffset={4}
            collisionPadding={8}
            className="p-1.5 w-[var(--radix-popover-trigger-width)]"
            style={{ minWidth: 280 }}
          >
            {/* 搜索框 */}
            <div className="relative mb-1.5">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t("apiSetup.searchModels")}
                className={cn(
                  'w-full h-8 pl-8 pr-3 text-sm rounded-md',
                  'bg-foreground/5 border-0',
                  'placeholder:text-muted-foreground/50',
                  'focus:outline-none focus:ring-1 focus:ring-foreground/20'
                )}
              />
            </div>
            {/* 模型列表 */}
            <div className="max-h-64 overflow-auto space-y-0.5">
              {filteredModels.length === 0 ? (
                <div className="px-2.5 py-3 text-sm text-muted-foreground text-center">
                  No models found
                </div>
              ) : (
                filteredModels.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    className={cn(
                      'w-full px-2.5 py-2 text-left text-sm rounded-lg',
                      'hover:bg-foreground/5 transition-colors',
                      value === model.id && 'bg-foreground/3'
                    )}
                    onClick={() => handleSelect(model.id)}
                  >
                    {model.name || model.id}
                  </button>
                ))
              )}
            </div>
          </PopoverContent>
        )}
      </Popover>
    </div>
  )
}
