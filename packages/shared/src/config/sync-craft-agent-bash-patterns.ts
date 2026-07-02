#!/usr/bin/env bun

/**
 * 同步 craft-agent CLI 的只读 Bash 模式到权限文件。
 *
 * 该脚本读取 permissions/default.json，把由 cli-domains.ts 生成的
 * craft-agent 只读命令正则替换进去，保证权限规则与 CLI 支持的命令一致。
 * 用法：bun run scripts/sync-craft-agent-bash-patterns.ts [targetPath]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getCraftAgentReadOnlyBashPatterns } from './cli-domains.ts'

/** 单条 Bash 允许规则 */
interface AllowedBashEntry {
  pattern: string
  comment?: string
}

/** permissions.json 的最小结构 */
interface PermissionsConfig {
  version?: string
  allowedBashPatterns?: AllowedBashEntry[]
  // 允许其他未知字段，用 unknown 表示不 care 具体类型
  [key: string]: unknown
}

/** 判断一条规则是否属于 craft-agent 的自动生成规则 */
function isCraftAgentPattern(entry: AllowedBashEntry): boolean {
  return typeof entry.pattern === 'string' && entry.pattern.startsWith('^craft-agent\\s')
}

/**
 * 把当前 CLI 域策略生成的只读模式同步进权限配置。
 * 保留原有非 craft-agent 规则的位置，只替换自动生成的部分。
 */
function syncCraftAgentPatterns(config: PermissionsConfig): PermissionsConfig {
  const patterns = config.allowedBashPatterns ?? []
  const firstCraftIndex = patterns.findIndex(isCraftAgentPattern)

  const withoutCraft = patterns.filter(entry => !isCraftAgentPattern(entry))
  const generated = getCraftAgentReadOnlyBashPatterns()

  // 如果有旧规则，插到原来的位置；否则追加到末尾
  const insertAt = firstCraftIndex >= 0 ? firstCraftIndex : withoutCraft.length
  const nextAllowedBashPatterns = [
    ...withoutCraft.slice(0, insertAt),
    ...generated,
    ...withoutCraft.slice(insertAt),
  ]

  return {
    ...config,
    allowedBashPatterns: nextAllowedBashPatterns,
  }
}

function main() {
  // 支持命令行指定目标路径，否则使用默认路径
  const targetPath = process.argv[2]
    ? resolve(process.argv[2])
    : resolve(process.cwd(), 'apps/electron/resources/permissions/default.json')

  const config = JSON.parse(readFileSync(targetPath, 'utf-8')) as PermissionsConfig
  const nextConfig = syncCraftAgentPatterns(config)

  writeFileSync(targetPath, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf-8')
  process.stdout.write(`Synced craft-agent bash patterns in ${targetPath}\n`)
}

if (import.meta.main) {
  main()
}
