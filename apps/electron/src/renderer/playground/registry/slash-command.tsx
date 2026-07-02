/**
 * slash-command 注册项
 *
 * 这个文件演示“斜杠命令菜单”组件：用户在输入框里输入 / 时会弹出的快捷命令面板。
 * 涉及概念：PermissionMode（权限模式，例如 ask/approve-yolo）、session（一次对话回合）、
 * source/skill（斜杠命令常用来触发某个 skill 或动作）。
 */
import * as React from 'react'
import type { ComponentEntry } from './types'
import { SquareSlash } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FreeFormInput } from '@/components/app-shell/input/FreeFormInput'
import type { PermissionMode } from '@craft-agent/shared/agent/modes'
import { ensureMockElectronAPI } from '../mock-utils'
import {
  SlashCommandMenu,
  DEFAULT_SLASH_COMMANDS,
  type SlashCommandId,
} from '@/components/ui/slash-command-menu'

// ============================================================================
// SlashCommandDemo - 可交互的完整演示
// ============================================================================

function SlashCommandDemo() {
  // React.useState<T>() 是 React 的“状态钩子”，类似 Go 里一个带 setter 的变量。
  // 状态变化会触发组件重新渲染。
  const [activeCommands, setActiveCommands] = React.useState<SlashCommandId[]>([])
  const [buttonMenuOpen, setButtonMenuOpen] = React.useState(false)
  const [inputValue, setInputValue] = React.useState('')
  const [permissionMode, setPermissionMode] = React.useState<PermissionMode>('ask')
  const [model, setModel] = React.useState('claude-sonnet-4-20250514')

  // useEffect 用于处理“副作用”，例如这里在组件挂载时注入模拟的 Electron API。
  // FreeFormInput 依赖 Electron 桥（附件、剪贴板等），playground 里需要 mock。
  React.useEffect(() => {
    ensureMockElectronAPI()
  }, [])

  // useCallback 会缓存函数引用，避免每次渲染都创建新函数，通常传给子组件时使用。
  const handleCommandSelect = React.useCallback((commandId: SlashCommandId) => {
    setActiveCommands(prev =>
      prev.includes(commandId)
        ? prev.filter(id => id !== commandId)
        : [...prev, commandId]
    )
  }, [])

  const handleButtonSelect = (commandId: SlashCommandId) => {
    handleCommandSelect(commandId)
    setButtonMenuOpen(false)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Description */}
      <div className="shrink-0 p-4 border-b border-border/50">
        <h2 className="text-sm font-medium text-foreground/80 mb-2">
          Slash Command Menu Demo
        </h2>
        <p className="text-xs text-muted-foreground">
          Type <code className="px-1 py-0.5 bg-muted rounded">/</code> to trigger inline autocomplete in the real input component, or click the button to open the standalone menu.
          Active commands in the standalone menu show a checkmark.
        </p>
      </div>

      {/* Active Commands Display */}
      {activeCommands.length > 0 && (
        <div className="shrink-0 px-4 py-2 border-b border-border/50 flex flex-wrap gap-2">
          <span className="text-xs text-muted-foreground">Standalone menu active:</span>
          {activeCommands.map(id => {
            const cmd = DEFAULT_SLASH_COMMANDS.find(c => c.id === id)
            const color = cmd?.color || '#888'
            return cmd ? (
              <button
                key={id}
                onClick={() => setActiveCommands(prev => prev.filter(c => c !== id))}
                className="h-6 px-2 text-[11px] font-medium rounded flex items-center gap-1.5 transition-all border"
                style={{
                  backgroundColor: `${color}1A`, // 10% opacity
                  color: color,
                  borderColor: `${color}4D`, // 30% opacity
                }}
              >
                {cmd.icon}
                <span>{cmd.label}</span>
                <span className="opacity-60 hover:opacity-100">×</span>
              </button>
            ) : null
          })}
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex gap-4 p-4">
        {/* Left: Button Menu with Filter */}
        <div className="flex-1">
          <div className="text-xs font-medium text-muted-foreground mb-2">
            Button Menu (with filter input)
          </div>
          <div className="relative">
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => setButtonMenuOpen(!buttonMenuOpen)}
            >
              <SquareSlash className="h-4 w-4" />
              Commands
            </Button>
            {buttonMenuOpen && (
              <div className="absolute top-full left-0 mt-2 z-10">
                <SlashCommandMenu
                  commands={DEFAULT_SLASH_COMMANDS}
                  activeCommands={activeCommands}
                  onSelect={handleButtonSelect}
                  showFilter={true}
                  className="w-[240px]"
                />
              </div>
            )}
          </div>
        </div>

        {/* Right: Static Menu (no filter) */}
        <div className="flex-1">
          <div className="text-xs font-medium text-muted-foreground mb-2">
            Static Menu (no filter)
          </div>
          <SlashCommandMenu
            commands={DEFAULT_SLASH_COMMANDS}
            activeCommands={activeCommands}
            onSelect={handleButtonSelect}
            className="w-full"
          />
        </div>
      </div>

      {/* Input Area using the real app input component */}
      <div className="shrink-0 p-4 border-t border-border/50">
        <div className="text-xs font-medium text-muted-foreground mb-2">
          Real FreeFormInput (type / in the input)
        </div>
        <FreeFormInput
          placeholder="Type / to see commands..."
          currentModel={model}
          onModelChange={setModel}
          permissionMode={permissionMode}
          onPermissionModeChange={setPermissionMode}
          inputValue={inputValue}
          onInputChange={setInputValue}
          sessionId="playground-session"
          onSubmit={() => {}}
          onStop={() => {}}
        />
      </div>
    </div>
  )
}

// ============================================================================
// 组件注册表条目（Component Registry Entries）
// ============================================================================
// 这个数组把一个 React 组件注册到 playground 侧边栏，让它可以被预览和切换 variant。

/** slash-command 组件注册列表。 */
export const slashCommandComponents: ComponentEntry[] = [
  {
    id: 'slash-command-demo',
    name: 'Slash Command Demo',
    category: 'Chat Inputs',
    description: 'Interactive demo showing both button-triggered and inline slash command menus',
    component: SlashCommandDemo,
    layout: 'full',
    props: [],
    variants: [],
    mockData: () => ({}),
  },
]
