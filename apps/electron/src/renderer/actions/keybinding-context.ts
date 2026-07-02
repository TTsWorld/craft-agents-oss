/**
 * Keybinding Context（快捷键上下文）。
 *
 * 为 action 注册表里的 when-clause（触发条件表达式）提供计算上下文。
 * 设计思路参考 VSCode 的 context key，但更简单：只支持布尔值。
 *
 * 上下文在 keydown 事件触发时根据 DOM 和模块级变量即时计算，
 * 不用 React state，因此不会导致组件重新渲染，只是一个同步快照。
 */

import type { FocusZoneId } from '@/context/FocusContext'
import { hasOpenOverlay } from '@/lib/overlay-detection'

/**
 * when 表达式里可以使用的上下文键。
 * 所有字段都是 boolean，最终由 evaluateWhen() 解释。
 */
export interface KeybindingContext {
  /** 当前焦点是否在文本输入框（INPUT/TEXTAREA/contentEditable）内 */
  inputFocus: boolean
  /** 焦点在输入框内且其中有文本被选中 */
  hasSelection: boolean
  /** 当前焦点区域是聊天区 */
  chatFocus: boolean
  /** 当前焦点区域是导航器/中间列表区 */
  navigatorFocus: boolean
  /** 当前焦点区域是侧边栏 */
  sidebarFocus: boolean
  /** 是否有模态框、下拉菜单等浮层打开 */
  menuOpen: boolean
}

// ─────────────────────────────────────────────
// 模块级焦点区域变量
// 更新来源：
//   1. FocusContext.focusZone() → setCurrentZone()（键盘导航 Cmd+1/2/3、Tab）
//   2. 下面的 focusin 监听器（鼠标点击、代码程序化聚焦）
// 键盘处理函数通过 getKeybindingContext() 同步读取它。
// ─────────────────────────────────────────────

let _currentZone: FocusZoneId | null = 'chat'

export function setCurrentZone(zone: FocusZoneId | null) {
  _currentZone = zone
}

/**
 * 通过 DOM focusin 事件追踪当前焦点区域。
 * 区域容器由 useFocusZone 打上 data-focus-zone 标记；这里只改模块变量，不触发 React 重渲染。
 */
if (typeof document !== 'undefined') {
  document.addEventListener('focusin', (e) => {
    // `as HTMLElement` 是 TS 类型断言：告诉编译器“这个 event.target 是 HTMLElement”，
    // 因为 EventTarget 本身没有 closest/getAttribute 等方法。
    const target = e.target as HTMLElement
    const zoneEl = target.closest<HTMLElement>('[data-focus-zone]')
    if (zoneEl) {
      // getAttribute 返回 string | null，用 `as FocusZoneId` 断言为我们已知的区域 ID 类型。
      _currentZone = zoneEl.getAttribute('data-focus-zone') as FocusZoneId
    }
  })
}

// ─────────────────────────────────────────────
// 上下文快照
// ─────────────────────────────────────────────

/**
 * 在键盘事件触发时，根据当前 DOM 状态生成上下文快照。
 * 在键盘处理函数的捕获阶段同步调用。
 */
export function getKeybindingContext(e: KeyboardEvent): KeybindingContext {
  const target = e.target as HTMLElement
  const isInput =
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.isContentEditable

  const hasSelection = (() => {
    if (!isInput) return false

    // 富文本编辑器：用 window.getSelection() 判断是否有选区
    if (target.isContentEditable) {
      const sel = window.getSelection()
      return sel !== null && sel.toString().length > 0
    }

    // 普通 INPUT/TEXTAREA：用 selectionStart/End 判断
    const input = target as HTMLInputElement | HTMLTextAreaElement
    if (
      typeof input.selectionStart === 'number' &&
      typeof input.selectionEnd === 'number'
    ) {
      return input.selectionStart !== input.selectionEnd
    }

    return false
  })()

  return {
    inputFocus: isInput,
    hasSelection,
    chatFocus: _currentZone === 'chat',
    navigatorFocus: _currentZone === 'navigator',
    sidebarFocus: _currentZone === 'sidebar',
    menuOpen: hasOpenOverlay(),
  }
}

// ─────────────────────────────────────────────
// when 条件求值器
// ─────────────────────────────────────────────

/**
 * 对 when-clause 表达式在当前上下文下求值。
 *
 * 支持的语法（VSCode when-clause 的子集）：
 *   undefined        → 恒为 true（任何场景都能触发）
 *   'inputFocus'     → inputFocus 为 true 时成立
 *   '!inputFocus'    → inputFocus 为 false 时成立
 *   'a && b'         → 逻辑与，两项都需为 true
 *   'a || b'         → 逻辑或，任意一组为 true 即可
 *   'a && !b || c'   → 与优先级高于或
 *
 * @example evaluateWhen(undefined, ctx)                // 始终 true
 * @example evaluateWhen('!inputFocus', ctx)            // 不在输入框内时触发
 * @example evaluateWhen('chatFocus && !hasSelection', ctx)
 */
export function evaluateWhen(
  when: string | undefined,
  ctx: KeybindingContext
): boolean {
  if (when === undefined) return true

  // 按 || 拆分成若干组，任意一组为 true 即可
  const orGroups = when.split(/\s*\|\|\s*/)
  return orGroups.some((group) => {
    // 每组再按 && 拆分，每一项都必须为 true
    const terms = group.split(/\s*&&\s*/)
    return terms.every((term) => {
      const trimmed = term.trim()
      const negated = trimmed.startsWith('!')
      // `keyof KeybindingContext` 表示 KeybindingContext 接口的所有键名，
      // 这样 ctx[key] 的访问才会被 TS 认为是安全的。
      const key = (negated ? trimmed.slice(1) : trimmed) as keyof KeybindingContext
      const value = ctx[key] ?? false
      return negated ? !value : value
    })
  })
}
