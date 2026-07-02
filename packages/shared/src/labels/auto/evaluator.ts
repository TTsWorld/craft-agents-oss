/**
 * 自动标签求值器
 *
 * 自动标签规则的核心引擎。扫描用户消息，根据配置的正则模式生成标签匹配。
 *
 * 求值流程：
 * 1. 去掉消息中的代码块（避免在代码中匹配）
 * 2. 遍历标签树，收集所有带 autoRules 的标签
 * 3. 对每条规则：强制使用 'g' flag 运行正则，替换捕获组
 * 4. 根据标签的 valueType 归一化提取出的值
 * 5. 去重（相同 labelId + value 只保留第一条）
 * 6. 限制为 MAX_MATCHES_PER_MESSAGE，防止粘贴日志/数据时标签爆炸
 * 7. 返回可直接存入 session 的 AutoLabelMatch 数组
 */

import type { LabelConfig, AutoLabelRule } from '../types.ts'
import type { AutoLabelMatch } from './types.ts'
import { normalizeValue } from './normalize.ts'

/** 单条消息最多允许的自动标签匹配数，防止粘贴日志/数据时标签爆炸 */
const MAX_MATCHES_PER_MESSAGE = 10

/**
 * 递归收集所有定义了 autoRules 的标签。
 * 按深度优先遍历整棵标签树。
 */
export function collectAutoLabelRules(labels: LabelConfig[]): Array<{
  label: LabelConfig
  rule: AutoLabelRule
}> {
  const result: Array<{ label: LabelConfig; rule: AutoLabelRule }> = []

  function walk(nodes: LabelConfig[]) {
    for (const label of nodes) {
      if (label.autoRules) {
        for (const rule of label.autoRules) {
          result.push({ label, rule })
        }
      }
      if (label.children) {
        walk(label.children)
      }
    }
  }

  walk(labels)
  return result
}

/**
 * 去掉文本中的围栏代码块和行内代码。
 * 防止正则匹配到代码示例、日志等内容内部。
 */
function stripCodeBlocks(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')  // 围栏代码块
    .replace(/`[^`]+`/g, '')          // 行内代码
}

/**
 * 对用户消息求值所有自动标签规则。
 * 返回去重、归一化后的匹配结果，数量上限为 MAX_MATCHES_PER_MESSAGE。
 *
 * @param message - 要扫描的用户消息文本
 * @param labels - workspace 的标签树（来自配置）
 */
export function evaluateAutoLabels(
  message: string,
  labels: LabelConfig[],
): AutoLabelMatch[] {
  // 扫描前先去掉代码块，避免匹配到代码内部
  const cleanMessage = stripCodeBlocks(message)

  const rules = collectAutoLabelRules(labels)
  const matches: AutoLabelMatch[] = []
  // 用 Set 记录已出现的 label+value，实现去重
  const seen = new Set<string>()

  for (const { label, rule } of rules) {
    // 达到上限就停止
    if (matches.length >= MAX_MATCHES_PER_MESSAGE) break

    const ruleMatches = evaluateRegexRule(cleanMessage, label, rule)

    // 去重后加入结果（同时尊重上限）
    for (const match of ruleMatches) {
      if (matches.length >= MAX_MATCHES_PER_MESSAGE) break

      const key = `${match.labelId}::${match.value}`
      if (!seen.has(key)) {
        seen.add(key)
        matches.push(match)
      }
    }
  }

  return matches
}

/**
 * 求值单条基于正则的自动标签规则。
 * 始终强制加上 'g' flag，防止 exec() 死循环。
 * 使用单次 $N 替换，避免捕获文本本身包含 $N 导致的二次注入。
 */
function evaluateRegexRule(
  message: string,
  label: LabelConfig,
  rule: AutoLabelRule
): AutoLabelMatch[] {
  const matches: AutoLabelMatch[] = []

  try {
    // 始终强制全局 flag，防止 exec() 在相同位置无限循环
    const flags = rule.flags
      ? (rule.flags.includes('g') ? rule.flags : rule.flags + 'g')
      : 'gi'
    const regex = new RegExp(rule.pattern, flags)
    let match: RegExpExecArray | null

    while ((match = regex.exec(message)) !== null) {
      // 单次 $N 替换：防止捕获文本里含有 $N 模式而被二次替换
      let value = rule.valueTemplate
        ? rule.valueTemplate.replace(/\$(\d+)/g, (_, n) => match![parseInt(n)] ?? '')
        : match[1] ?? match[0]

      // 根据标签声明的 valueType 做归一化
      value = normalizeValue(value, label.valueType)

      matches.push({
        labelId: label.id,
        value,
        matchedText: match[0],
      })

      // 避免零长度匹配导致无限循环
      if (match[0].length === 0) {
        regex.lastIndex++
      }
    }
  } catch (e) {
    // 正则非法时静默跳过（配置保存时的校验应当能提前发现）
    console.warn(`[AutoLabel] Invalid regex for label "${label.id}": ${rule.pattern}`, e)
  }

  return matches
}
