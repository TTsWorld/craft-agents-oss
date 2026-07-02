/**
 * InputContainer - 自由输入与结构化输入的容器与动画编排器。
 *
 * 负责：
 * - 在 FreeFormInput 和 StructuredInput 之间切换
 * - 测量结构化输入高度并做平滑动画
 * - 处理紧凑模式下 agent 思考时的折叠/展开
 */
import * as React from 'react'
import { motion, AnimatePresence, useMotionValue, useMotionValueEvent, animate } from 'motion/react'
import { cn } from '@/lib/utils'
import { FreeFormInput, type FreeFormInputProps } from './FreeFormInput'
import { StructuredInput } from './StructuredInput'
import type { RichTextInputHandle } from '@/components/ui/rich-text-input'
import { useOptionalAppShellContext } from '@/context/AppShellContext'
import type { StructuredInputState, StructuredResponse, InputMode } from './structured/types'
import { getStructuredInputMaxHeight } from './structured-height'
import { BackgroundFinishedChip } from '../BackgroundFinishedChip'

interface InputContainerProps extends Omit<FreeFormInputProps, 'inputRef'> {
  /** 结构化输入状态；存在时显示结构化 UI 而不是自由输入 */
  structuredInput?: StructuredInputState
  /** 用户响应结构化输入时的回调 */
  onStructuredResponse?: (response: StructuredResponse) => void
  /** 外部传入的输入框 ref（用于焦点控制） */
  textareaRef?: React.RefObject<RichTextInputHandle>
  /** 高度动画每一帧的回调（用于滚动同步） */
  onAnimatedHeightChange?: (delta: number) => void
}

// 动画时长——高度和透明度共用
const TRANSITION_DURATION = 0.25
const TRANSITION_EASE = [0.4, 0, 0.2, 1] as const

// 首次渲染测量前的回退高度
const FALLBACK_HEIGHTS: Record<InputMode | string, number> = {
  freeform: 114,
  'freeform-compact': 70,  // 紧凑模式更小
  permission: 200,
  credential: 240,  // 表单字段 + 提示需要更高
  admin_approval: 220,
}

/**
 * InputContainer - FreeFormInput 与 StructuredInput 的主编排容器。
 *
 * 动画实现：
 * - 用隐藏测量 div 获取内容的自然高度
 * - 容器动画过渡到测量高度
 * - 内部内容通过 AnimatePresence mode="sync" 交叉淡入淡出
 * - 所有可见子元素使用绝对定位，在过渡期间堆叠
 */
export function InputContainer({
  structuredInput,
  onStructuredResponse,
  textareaRef,
  compactMode,
  isProcessing,
  onAnimatedHeightChange,
  ...freeFormProps
}: InputContainerProps) {
  const appShellContext = useOptionalAppShellContext()
  const isFocusedPanel = appShellContext?.isFocusedPanel ?? true
  const mode: InputMode = structuredInput ? 'structured' : 'freeform'
  const measureRef = React.useRef<HTMLDivElement>(null)
  // 自由输入用回调高度，结构化输入用测量 div；紧凑模式用更小的回退高度
  const [freeformHeight, setFreeformHeight] = React.useState<number>(
    compactMode ? FALLBACK_HEIGHTS['freeform-compact'] : FALLBACK_HEIGHTS.freeform
  )
  const [structuredHeight, setStructuredHeight] = React.useState<number | null>(null)
  const [viewportHeight, setViewportHeight] = React.useState<number>(() =>
    typeof window === 'undefined' ? 0 : window.innerHeight
  )
  const [isFocused, setIsFocused] = React.useState(false)
  const hasInitializedRef = React.useRef(false)

  // 当前内容的稳定 key
  const contentKey = mode === 'freeform' ? 'freeform' : `structured-${structuredInput?.type}`

  // 跟踪模式切换，在切换后的一段时间内启用高度动画
  const [isAnimating, setIsAnimating] = React.useState(false)
  const prevContentKeyRef = React.useRef(contentKey)

  // 在 render 期间同步检测是否正在过渡
  const isTransitioning = prevContentKeyRef.current !== contentKey

  // 处于过渡中或动画窗口期内都应启用高度动画
  const shouldAnimateHeight = isTransitioning || isAnimating

  React.useEffect(() => {
    if (isTransitioning) {
      prevContentKeyRef.current = contentKey
      setIsAnimating(true)
      // 持续动画到过渡时长 + 一点额外时间让测量稳定
      const timer = setTimeout(() => {
        setIsAnimating(false)
      }, TRANSITION_DURATION * 1000 + 100)
      return () => clearTimeout(timer)
    }
  }, [contentKey, isTransitioning])

  // 紧凑模式下 agent 思考时会折叠输入栏，但用户可以悬停或点击展开，
  // 不需要等 agent 结束。processing 结束时重置，以便下一次思考周期重新折叠。
  const [expandedDuringProcessing, setExpandedDuringProcessing] = React.useState(false)

  React.useEffect(() => {
    if (!isProcessing && expandedDuringProcessing) {
      setExpandedDuringProcessing(false)
    }
  }, [isProcessing, expandedDuringProcessing])

  const handleRequestExpand = React.useCallback(() => {
    setExpandedDuringProcessing(true)
  }, [])

  const isCollapsedInCompact = compactMode && isProcessing && !expandedDuringProcessing

  // 当 isProcessing 翻转或用户手动展开/收起时触发高度动画
  const prevIsProcessingRef = React.useRef(isProcessing)
  const prevExpandedRef = React.useRef(expandedDuringProcessing)
  React.useEffect(() => {
    if (!compactMode) return
    const isProcessingChanged = prevIsProcessingRef.current !== isProcessing
    const expandedChanged = prevExpandedRef.current !== expandedDuringProcessing
    prevIsProcessingRef.current = isProcessing
    prevExpandedRef.current = expandedDuringProcessing
    if (!isProcessingChanged && !expandedChanged) return
    setIsAnimating(true)
    const timer = setTimeout(() => {
      setIsAnimating(false)
    }, TRANSITION_DURATION * 1000 + 100)
    return () => clearTimeout(timer)
  }, [compactMode, isProcessing, expandedDuringProcessing])

  // 处理 FreeFormInput 的高度变化（同步回调，不需要测量 div）
  const handleFreeformHeightChange = React.useCallback((height: number) => {
    setFreeformHeight(height)
    if (!hasInitializedRef.current) {
      hasInitializedRef.current = true
    }
  }, [])

  // 处理 FreeFormInput 的焦点变化
  const handleFocusChange = React.useCallback((focused: boolean) => {
    setIsFocused(focused)
  }, [])

  React.useEffect(() => {
    if (typeof window === 'undefined') return

    const updateViewportHeight = () => setViewportHeight(window.innerHeight)
    updateViewportHeight()
    window.addEventListener('resize', updateViewportHeight)
    return () => window.removeEventListener('resize', updateViewportHeight)
  }, [])

  // 仅对结构化输入使用 ResizeObserver（自由输入使用 onHeightChange 回调）
  React.useEffect(() => {
    if (mode === 'freeform') return

    const measureEl = measureRef.current
    if (!measureEl) return

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const height = entry.contentRect.height
        if (height > 0) {
          setStructuredHeight(height)
          // 首次测量后标记为已初始化
          if (!hasInitializedRef.current) {
            requestAnimationFrame(() => {
              hasInitializedRef.current = true
            })
          }
        }
      }
    })

    observer.observe(measureEl)
    return () => observer.disconnect()
  }, [contentKey, mode])

  // 根据模式选择高度来源。结构化提示受视口感知上限限制，内部可滚动，保证操作按钮可达。
  const rawTargetHeight = mode === 'freeform'
    ? freeformHeight
    : (structuredHeight ?? FALLBACK_HEIGHTS[structuredInput?.type ?? 'freeform'] ?? FALLBACK_HEIGHTS.freeform)
  const structuredMaxHeight = getStructuredInputMaxHeight(viewportHeight)
  const targetHeight = mode === 'freeform'
    ? rawTargetHeight
    : Math.min(rawTargetHeight, structuredMaxHeight)

  // 用于帧同步高度动画的 motion value
  const heightMotionValue = useMotionValue(targetHeight)
  const prevAnimatedHeightRef = React.useRef(targetHeight)

  // 每帧输出高度变化量，用于外部滚动同步
  useMotionValueEvent(heightMotionValue, "change", (latest) => {
    const delta = latest - prevAnimatedHeightRef.current
    prevAnimatedHeightRef.current = latest
    if (delta !== 0) {
      onAnimatedHeightChange?.(delta)
    }
  })

  // 使用 motion value 执行高度动画
  React.useEffect(() => {
    if (shouldAnimateHeight) {
      animate(heightMotionValue, targetHeight, {
        duration: TRANSITION_DURATION,
        ease: TRANSITION_EASE
      })
    } else {
      // 非动画状态直接设置高度
      heightMotionValue.set(targetHeight)
      prevAnimatedHeightRef.current = targetHeight
    }
  }, [targetHeight, shouldAnimateHeight, heightMotionValue])

  const handleStructuredResponse = (response: StructuredResponse) => {
    onStructuredResponse?.(response)
  }

  // 渲染当前内容（测量 div 仅用于结构化，自由输入用回调）
  const renderContent = (forMeasuring: boolean) => {
    if (mode === 'freeform') {
      return (
        <FreeFormInput
          {...freeFormProps}
          compactMode={compactMode}
          isProcessing={isProcessing}
          isCollapsedInCompact={isCollapsedInCompact}
          onRequestExpand={handleRequestExpand}
          inputRef={forMeasuring ? undefined : textareaRef}
          onHeightChange={forMeasuring ? undefined : handleFreeformHeightChange}
          onFocusChange={forMeasuring ? undefined : handleFocusChange}
          unstyled
        />
      )
    }
    return (
      <StructuredInput
        state={structuredInput!}
        onResponse={forMeasuring ? () => {} : handleStructuredResponse}
        unstyled
      />
    )
  }

  return (
    <div className="relative">
      {/* 隐藏测量 div：仅结构化输入需要（自由输入用 onHeightChange） */}
      {mode !== 'freeform' && (
        <div
          ref={measureRef}
          className="absolute top-0 left-0 right-0 invisible pointer-events-none"
          aria-hidden="true"
        >
          <div className="rounded-[8px] bg-background overflow-hidden">
            {renderContent(true)}
          </div>
        </div>
      )}

      {/* 可见的动画容器 */}
      <motion.div
        className={cn(
          "input-container relative rounded-[12px] overflow-hidden transition-colors",
          isFocusedPanel ? "shadow-middle" : "shadow-minimal",
          "bg-background"
        )}
        style={{
          height: heightMotionValue,
          ...(mode !== 'freeform' ? { maxHeight: structuredMaxHeight } : {}),
        }}
      >
        {/* 交叉淡入淡出内容：自由输入锚定底部（为了自增长），其它填满 */}
        <AnimatePresence mode="sync" initial={false}>
          <motion.div
            key={contentKey}
            className={mode === 'freeform' ? "absolute bottom-0 left-0 right-0" : "absolute inset-0"}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: TRANSITION_DURATION, ease: TRANSITION_EASE }}
          >
            {renderContent(false)}
          </motion.div>
        </AnimatePresence>
      </motion.div>

      {/* Background-completion chip — floats in the input box's top-right corner.
       * Self-contained (its own atoms + navigation); renders nothing when idle.
       * Freeform-only so it never overlaps a structured prompt's header. The outer
       * wrapper is `relative` and (unlike the visible box) not `overflow-hidden`,
       * so the chip's soft shadow isn't clipped. */}
      {mode === 'freeform' && freeFormProps.sessionId && (
        <BackgroundFinishedChip sessionId={freeFormProps.sessionId} />
      )}
    </div>
  )
}
