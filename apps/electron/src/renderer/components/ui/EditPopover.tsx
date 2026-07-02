/**
 * EditPopover — 设置编辑浮层。
 *
 * 一个带标题、副标题和多行输入区的浮层，用于让 Agent 协助编辑配置。
 * 支持两种模式：
 * - Legacy：打开新的独立窗口，在新聊天会话中执行
 * - Inline：在浮层内用紧凑版 ChatDisplay 直接执行 mini agent
 */

import * as React from 'react'
import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from 'i18next'
import { GripHorizontal } from 'lucide-react'
import { motion, AnimatePresence } from 'motion/react' // 仅用于处理中的全屏遮罩
import { Popover, PopoverTrigger, PopoverContent } from './popover'
import { Button } from './button'
import { cn } from '@/lib/utils'
import { usePlatform } from '@craft-agent/ui'
import type { ContentBadge, Session, CreateSessionOptions } from '../../../shared/types'
import { useActiveWorkspace, useAppShellContext, useSession, usePendingPermission, usePendingCredential } from '@/context/AppShellContext'
import { useEscapeInterrupt } from '@/context/EscapeInterruptContext'
import { ChatDisplay } from '../app-shell/ChatDisplay'

/** inline 模式输入框的轮播占位提示 key，短句、偏动作导向 */
const COMPACT_PLACEHOLDER_KEYS = [
  'editPopover.placeholder1',
  'editPopover.placeholder2',
  'editPopover.placeholder3',
] as const

/**
 * 传给新聊天会话的上下文，让 Agent 知道当前在编辑什么，从而快速执行。
 *
 * 结构简单：显示用 label、文件路径 filePath、可选的额外说明 context。
 */
export interface EditContext {
  /** 给人看的标签，也作为 Agent 上下文（如 "Permissions"） */
  label: string
  /** 被编辑文件的绝对路径 */
  filePath: string
  /** 给 Agent 的额外说明/指令 */
  context?: string
}

/* ============================================================================
 * 编辑上下文注册表 — 唯一真相源
 * ============================================================================
 * 所有编辑上下文必须在这里定义，禁止在代码其他地方内联创建 EditContext。
 * 应使用本文件导出的 getEditConfig()。
 *
 * 新增编辑上下文的步骤：
 * 1. 在 EditContextKey 类型里加 key
 * 2. 在 EDIT_CONFIGS 里加配置
 * 3. 通过 getEditConfig(key, location) 使用
 *
 * 这样能保证：
 * - 所有给 Agent 的提示和示例在一个地方审阅
 * - 与 Agent 的沟通口径一致
 * - 上下文格式变化时容易统一更新
 * ============================================================================ */

/** 可用的编辑上下文 key — 新增请在这里扩展 */
export type EditContextKey =
  | 'workspace-permissions'
  | 'default-permissions'
  | 'skill-instructions'
  | 'skill-metadata'
  | 'source-guide'
  | 'source-config'
  | 'source-permissions'
  | 'source-tool-permissions'
  | 'preferences-notes'
  | 'add-source'
  | 'add-source-api'   // 过滤后场景：用户正在查看 API 列表
  | 'add-source-mcp'   // 过滤后场景：用户正在查看 MCP 列表
  | 'add-source-local' // 过滤后场景：用户正在查看本地文件夹列表
  | 'add-skill'
  | 'edit-statuses'
  | 'edit-labels'
  | 'edit-auto-rules'
  | 'add-label'
  | 'edit-views'
  | 'edit-tool-icons'
  | 'automation-config'

/**
 * 完整编辑配置，包含给 Agent 的上下文和给 UI 的示例。
 * 由 getEditConfig() 返回，供 EditPopover 使用。
 */
export interface EditConfig {
  /** 给 Agent 的上下文 */
  context: EditContext
  /** 显示在浮层占位符里的示例文本 */
  example: string
  /** 自定义占位符文本，覆盖默认的“Describe what you'd like to change” */
  overridePlaceholder?: string
  /** UI 显示用的翻译后标签（从 displayLabelKey 解析，回退到 context.label） */
  displayLabel?: string
  /** 显示标签的 i18n key（UI 显示用中文；context.label 仍保持英文给 Agent） */
  displayLabelKey?: string
  /** 示例文本的 i18n key */
  exampleKey?: string
  /** 自定义占位符的 i18n key */
  overridePlaceholderKey?: string
  /** 模型层级提示：fast 用连接的 mini 模型，default 用主模型 */
  model?: 'fast' | 'default'
  /** mini agent 的系统提示预设（如 'mini' 用于聚焦编辑） */
  systemPromptPreset?: 'default' | 'mini'
  /** 为 true 时在浮层内 inline 执行，而不是打开新窗口 */
  inlineExecution?: boolean
}

/**
 * 所有编辑配置的注册表。
 * 每个条目包含浮层展示和 Agent 上下文所需的全部字符串。
 */
const EDIT_CONFIGS: Record<EditContextKey, (location: string) => EditConfig> = {
  'workspace-permissions': (location) => ({
    context: {
      label: 'Permission Settings',
      filePath: `${location}/permissions.json`,
      context:
        'The user is on the Settings Screen and pressed the edit button on Workspace Permission settings. ' +
        'Their intent is likely to update the setting immediately unless otherwise specified. ' +
        'The permissions.json file configures Explore mode rules. It can contain: allowedBashPatterns, ' +
        'allowedMcpPatterns, allowedApiEndpoints, blockedTools, and allowedWritePaths. ' +
        'After editing, call config_validate with target "permissions" to verify the changes. ' +
        'Confirm clearly when done.',
    },
    example: "Allow running 'make build' in Explore mode",
    displayLabelKey: 'editPopover.label.permissionSettings',
    exampleKey: 'editPopover.example.workspacePermissions',
    model: 'default',
    systemPromptPreset: 'mini',
    inlineExecution: true,
  }),

  'default-permissions': (location) => ({
    context: {
      label: 'Default Permissions',
      filePath: location, // 这里 location 就是默认权限的完整路径
      context:
        'The user is editing app-level default permissions (~/.craft-agent/permissions/default.json). ' +
        'This file configures Explore mode rules that apply to ALL workspaces. ' +
        'It can contain: allowedBashPatterns, allowedMcpPatterns, allowedApiEndpoints, blockedTools, and allowedWritePaths. ' +
        'Each pattern can be a string or an object with pattern and comment fields. ' +
        'Be careful - these are app-wide defaults. ' +
        'After editing, call config_validate with target "permissions" to verify the changes. ' +
        'Confirm clearly when done.',
    },
    example: 'Allow git fetch command',
    displayLabelKey: 'editPopover.label.defaultPermissions',
    exampleKey: 'editPopover.example.defaultPermissions',
    model: 'default',
    systemPromptPreset: 'mini',
    inlineExecution: true,
  }),

  // 技能编辑上下文
  'skill-instructions': (location) => ({
    context: {
      label: 'Skill Instructions',
      filePath: `${location}/SKILL.md`,
      context:
        'The user is editing skill instructions in SKILL.md. ' +
        'IMPORTANT: Preserve the YAML frontmatter (between --- markers) at the top of the file. ' +
        'Focus on editing the markdown content after the frontmatter. ' +
        'The skill instructions guide the AI on how to use this skill. ' +
        'After editing, call skill_validate with the skill slug to verify the changes. ' +
        'Confirm clearly when done.',
    },
    example: 'Add error handling guidelines',
    displayLabelKey: 'editPopover.label.skillInstructions',
    exampleKey: 'editPopover.example.skillInstructions',
    model: 'fast',
    systemPromptPreset: 'mini',
    inlineExecution: true,
  }),

  'skill-metadata': (location) => ({
    context: {
      label: 'Skill Metadata',
      filePath: `${location}/SKILL.md`,
      context:
        'The user is editing skill metadata in the YAML frontmatter of SKILL.md. ' +
        'Frontmatter fields: name (required), description (required), globs (optional array), alwaysAllow (optional array), requiredSources (optional array of source slugs), icon (optional string — emoji or URL). ' +
        'Keep the content after the frontmatter unchanged unless specifically requested. ' +
        'After editing, call skill_validate with the skill slug to verify the changes. ' +
        'Confirm clearly when done.',
    },
    example: 'Update the skill description',
    displayLabelKey: 'editPopover.label.skillMetadata',
    exampleKey: 'editPopover.example.skillMetadata',
    model: 'fast',
    systemPromptPreset: 'mini',
    inlineExecution: true,
  }),

  // Source 编辑上下文
  'source-guide': (location) => ({
    context: {
      label: 'Source Documentation',
      filePath: `${location}/guide.md`,
      context:
        'The user is editing source documentation (guide.md). ' +
        'This file provides context to the AI about how to use this source - rate limits, API patterns, best practices. ' +
        'Keep content clear and actionable. ' +
        'Confirm clearly when done.',
    },
    example: 'Add rate limit documentation',
    displayLabelKey: 'editPopover.label.sourceDocumentation',
    exampleKey: 'editPopover.example.sourceGuide',
    model: 'fast',
    systemPromptPreset: 'mini',
    inlineExecution: true,
  }),

  'source-config': (location) => ({
    context: {
      label: 'Source Configuration',
      filePath: `${location}/config.json`,
      context:
        'The user is editing source configuration (config.json). ' +
        'Be careful with JSON syntax. Fields include: type, slug, name, tagline, iconUrl, and transport-specific settings (mcp, api, local). ' +
        'Do NOT modify the slug unless explicitly requested. ' +
        'After editing, call source_test with the source slug to verify the configuration. ' +
        'Confirm clearly when done.',
    },
    example: 'Update the display name',
    displayLabelKey: 'editPopover.label.sourceConfiguration',
    exampleKey: 'editPopover.example.sourceConfig',
    model: 'default',
    systemPromptPreset: 'mini',
    inlineExecution: true,
  }),

  'source-permissions': (location) => ({
    context: {
      label: 'Source Permissions',
      filePath: `${location}/permissions.json`,
      context:
        'The user is editing source-level permissions (permissions.json). ' +
        'These rules are auto-scoped to this source - write simple patterns without prefixes. ' +
        'For MCP: use allowedMcpPatterns (e.g., "list", "get"). For API: use allowedApiEndpoints. ' +
        'After editing, call config_validate with target "permissions" and the source slug to verify the changes. ' +
        'Confirm clearly when done.',
    },
    example: 'Allow list operations in Explore mode',
    displayLabelKey: 'editPopover.label.sourcePermissions',
    exampleKey: 'editPopover.example.sourcePermissions',
    model: 'default',
    systemPromptPreset: 'mini',
    inlineExecution: true,
  }),

  'source-tool-permissions': (location) => ({
    context: {
      label: 'Tool Permissions',
      filePath: `${location}/permissions.json`,
      context:
        'The user is viewing the Tools list for an MCP source and wants to modify tool permissions. ' +
        'Edit the permissions.json file to control which tools are allowed in Explore mode. ' +
        'Use allowedMcpPatterns to allow specific tools (e.g., ["list_*", "get_*"] for read-only). ' +
        'Use blockedTools to explicitly block specific tools. ' +
        'Patterns are auto-scoped to this source. ' +
        'After editing, call config_validate with target "permissions" and the source slug to verify the changes. ' +
        'Confirm clearly when done.',
    },
    example: 'Only allow read operations (list, get, search)',
    displayLabelKey: 'editPopover.label.toolPermissions',
    exampleKey: 'editPopover.example.sourceToolPermissions',
    model: 'default',
    systemPromptPreset: 'mini',
    inlineExecution: true,
  }),

  // 偏好设置编辑上下文
  'preferences-notes': (location) => ({
    context: {
      label: 'Preferences Notes',
      filePath: location, // 这里 location 就是偏好设置的完整路径
      context:
        'The user is editing the notes field in their preferences (~/.craft-agent/preferences.json). ' +
        'This is a JSON file. Only modify the "notes" field unless explicitly asked otherwise. ' +
        'The notes field is free-form text that provides context about the user to the AI. ' +
        'After editing, call config_validate with target "preferences" to verify the changes. ' +
        'Confirm clearly when done.',
    },
    example: 'Add coding style preferences',
    displayLabelKey: 'editPopover.label.preferencesNotes',
    exampleKey: 'editPopover.example.preferencesNotes',
    model: 'fast',
    systemPromptPreset: 'mini',
    inlineExecution: true,
  }),

  // 新增 Source/Skill 上下文 —— 用 overridePlaceholder 提供场景化提示
  'add-source': (location) => ({
    context: {
      label: 'Add Source',
      filePath: `${location}/sources/`, // 这里 location 是 workspace 根路径
      context:
        'The user wants to add a new source to their workspace. ' +
        'Sources can be MCP servers (HTTP/SSE or stdio), REST APIs, or local filesystems. ' +
        'Ask clarifying questions if needed: What service? MCP or API? Auth type? ' +
        'Create the source folder and config.json in the workspace sources directory. ' +
        'Follow the patterns in ~/.craft-agent/docs/sources.md. ' +
        'After creating the source, call source_test with the source slug to verify the configuration.',
    },
    example: 'Connect to my Craft space',
    overridePlaceholder: 'What would you like to connect?',
    displayLabelKey: 'editPopover.label.addSource',
    exampleKey: 'editPopover.example.addSource',
    overridePlaceholderKey: 'editPopover.placeholder.addSource',
  }),

  // 按类型过滤后的“新增 Source”上下文：用户正在看某类 Source 列表并想添加该类型
  'add-source-api': (location) => ({
    context: {
      label: 'Add API',
      filePath: `${location}/sources/`,
      context:
        'The user is viewing API sources and wants to add a new REST API. ' +
        'Default to creating an API source (type: "api") unless they specify otherwise. ' +
        'APIs connect to REST endpoints with authentication (bearer, header, basic, or query). ' +
        'Ask about the API endpoint URL and auth type. ' +
        'Create the source folder and config.json in the workspace sources directory. ' +
        'Follow the patterns in ~/.craft-agent/docs/sources.md. ' +
        'After creating the source, call source_test with the source slug to verify the configuration.',
    },
    example: 'Connect to the OpenAI API',
    overridePlaceholder: 'What API would you like to connect?',
    displayLabelKey: 'editPopover.label.addApi',
    exampleKey: 'editPopover.example.addSourceApi',
    overridePlaceholderKey: 'editPopover.placeholder.addSourceApi',
  }),

  'add-source-mcp': (location) => ({
    context: {
      label: 'Add MCP Server',
      filePath: `${location}/sources/`,
      context:
        'The user is viewing MCP sources and wants to add a new MCP server. ' +
        'Default to creating an MCP source (type: "mcp") unless they specify otherwise. ' +
        'MCP servers can use HTTP/SSE transport (remote) or stdio transport (local subprocess). ' +
        'Ask about the service they want to connect to and whether it\'s a remote URL or local command. ' +
        'Create the source folder and config.json in the workspace sources directory. ' +
        'Follow the patterns in ~/.craft-agent/docs/sources.md. ' +
        'After creating the source, call source_test with the source slug to verify the configuration.',
    },
    example: 'Connect to Linear',
    overridePlaceholder: 'What MCP server would you like to connect?',
    displayLabelKey: 'editPopover.label.addMcpServer',
    exampleKey: 'editPopover.example.addSourceMcp',
    overridePlaceholderKey: 'editPopover.placeholder.addSourceMcp',
  }),

  'add-source-local': (location) => ({
    context: {
      label: 'Add Local Folder',
      filePath: `${location}/sources/`,
      context:
        'The user wants to add a local folder source. ' +
        'First, look up the guide: mcp__craft-agents-docs__SearchCraftAgents({ query: "filesystem" }). ' +
        'Local folders are bookmarks - use type: "local" with a local.path field. ' +
        'They use existing Read, Write, Glob, Grep tools - no MCP server needed. ' +
        'If unclear, ask about the folder path they want to connect. ' +
        'Create the source folder and config.json in the workspace sources directory. ' +
        'Follow the patterns in ~/.craft-agent/docs/sources.md. ' +
        'After creating the source, call source_test with the source slug to verify the configuration.',
    },
    example: 'Connect to my Obsidian vault',
    overridePlaceholder: 'What folder would you like to connect?',
    displayLabelKey: 'editPopover.label.addLocalFolder',
    exampleKey: 'editPopover.example.addSourceLocal',
    overridePlaceholderKey: 'editPopover.placeholder.addSourceLocal',
  }),

  'add-skill': (location) => ({
    context: {
      label: 'Add Skill',
      filePath: `${location}/skills/`, // 这里 location 是 workspace 根路径
      context:
        'The user wants to add a new skill to their workspace. ' +
        'Skills are specialized instructions with a SKILL.md file containing YAML frontmatter (name, description) and markdown instructions. ' +
        'Ask clarifying questions if needed: What should the skill do? When should it trigger? ' +
        'Create the skill folder and SKILL.md in the workspace skills directory. ' +
        'Follow the patterns in ~/.craft-agent/docs/skills.md. ' +
        'After creating the skill, call skill_validate with the skill slug to verify the SKILL.md file.',
    },
    example: 'Review PRs following our code standards',
    overridePlaceholder: 'What should I learn to do?',
    displayLabelKey: 'editPopover.label.addSkill',
    exampleKey: 'editPopover.example.addSkill',
    overridePlaceholderKey: 'editPopover.placeholder.addSkill',
  }),

  // 状态配置上下文
  'edit-statuses': (location) => ({
    context: {
      label: 'Status Configuration',
      filePath: `${location}/statuses/config.json`,
      context:
        'The user wants to customize session statuses (workflow states). ' +
        'Statuses are stored in statuses/config.json with fields: id, label, icon, category (open/closed), order, isFixed, isDefault. ' +
        'Fixed statuses (todo, done, cancelled) cannot be deleted but can be reordered or have their label changed. ' +
        'Icon can be an emoji, an https URL, or a local filename like "name.svg" that maps to statuses/icons/name.svg. ' +
        'Category "open" shows in inbox, "closed" shows in archive. ' +
        'After editing, call config_validate with target "statuses" to verify the changes. ' +
        'Confirm clearly when done.',
    },
    example: 'Add a "Blocked" status',
    displayLabelKey: 'editPopover.label.statusConfiguration',
    exampleKey: 'editPopover.example.editStatuses',
    model: 'fast',               // 快速配置编辑用轻量模型
    systemPromptPreset: 'mini',   // 使用聚焦的 mini 提示
    inlineExecution: true,        // 在浮层内 inline 执行
  }),

  // Label 配置上下文
  'edit-labels': (location) => ({
    context: {
      label: 'Label Configuration',
      filePath: `${location}/labels/config.json`,
      context:
        'The user wants to customize session labels (tagging/categorization). ' +
        'Labels are stored in labels/config.json as a hierarchical tree. ' +
        'Each label has: id (slug, globally unique), name (display), color (optional EntityColor), children (sub-labels array). ' +
        'Colors use EntityColor format: string shorthand (e.g. "blue") or { light, dark } object for theme-aware colors. ' +
        'Labels are color-only (no icons) — rendered as colored circles in the UI. ' +
        'Children form a recursive tree structure — array position determines display order. ' +
        'Read ~/.craft-agent/docs/labels.md for full format reference. ' +
        'Confirm clearly when done.',
    },
    example: 'Add a "Bug" label with red color',
    displayLabelKey: 'editPopover.label.labelConfiguration',
    exampleKey: 'editPopover.example.editLabels',
    model: 'fast',               // 快速配置编辑用轻量模型
    systemPromptPreset: 'mini',   // 使用聚焦的 mini 提示
    inlineExecution: true,        // 在浮层内 inline 执行
  }),

  // 自动标签规则上下文（聚焦 label 内的正则规则）
  'edit-auto-rules': (location) => ({
    context: {
      label: 'Auto-Apply Rules',
      filePath: `${location}/labels/config.json`,
      context:
        'The user wants to edit auto-apply rules (regex patterns that auto-tag sessions). ' +
        'Rules live inside the autoRules array on individual labels in labels/config.json. ' +
        'Each rule has: pattern (regex with capture groups), flags (default "gi"), valueTemplate ($1/$2 substitution), description. ' +
        'Multiple rules on the same label = multiple ways to trigger. The "g" flag is always enforced. ' +
        'Avoid catastrophic backtracking patterns (e.g., (a+)+). ' +
        'Read ~/.craft-agent/docs/labels.md for full format reference. ' +
        'Confirm clearly when done.',
    },
    example: 'Add a rule to detect GitHub issue URLs',
    displayLabelKey: 'editPopover.label.autoApplyRules',
    exampleKey: 'editPopover.example.editAutoRules',
    model: 'fast',               // 快速配置编辑用轻量模型
    systemPromptPreset: 'mini',   // 使用聚焦的 mini 提示
    inlineExecution: true,        // 在浮层内 inline 执行
  }),

  // 新增 Label 上下文（从 # 菜单无匹配时触发）
  'add-label': (location) => ({
    context: {
      label: 'Add Label',
      filePath: `${location}/labels/config.json`,
      context:
        'The user wants to create a new label from the # inline menu. ' +
        'Labels are stored in labels/config.json as a hierarchical tree. ' +
        'Each label has: id (slug, globally unique), name (display), color (optional EntityColor), children (sub-labels array). ' +
        'Colors use EntityColor format: string shorthand (e.g. "blue") or { light, dark } object for theme-aware colors. ' +
        'Labels are color-only (no icons) — rendered as colored circles in the UI. ' +
        'Read ~/.craft-agent/docs/labels.md for full format reference. ' +
        'Confirm clearly when done.',
    },
    example: 'A red "Bug" label',
    overridePlaceholder: 'What label would you like to create?',
    displayLabelKey: 'editPopover.label.addLabel',
    exampleKey: 'editPopover.example.addLabel',
    overridePlaceholderKey: 'editPopover.placeholder.addLabel',
    model: 'fast',               // 快速配置编辑用轻量模型
    systemPromptPreset: 'mini',   // 使用聚焦的 mini 提示
    inlineExecution: true,        // 在浮层内 inline 执行
  }),

  // Views 配置上下文
  'edit-views': (location) => ({
    context: {
      label: 'Views Configuration',
      filePath: `${location}/views.json`,
      context:
        'The user wants to edit views (dynamic, expression-based filters). ' +
        'Views are stored in views.json at the workspace root under a "views" array. ' +
        'Each view has: id (unique slug), name (display text), description (optional), color (optional EntityColor), expression (Filtrex string). ' +
        'Expressions are evaluated against session context fields: name, preview, sessionStatus (also available as deprecated alias todoState), permissionMode, model, lastMessageRole, ' +
        'lastUsedAt, createdAt, messageCount, labelCount, isFlagged, hasUnread, isProcessing, hasPendingPlan, tokenUsage.*, labels. ' +
        'Available functions: daysSince(timestamp), contains(array, value). ' +
        'Colors use EntityColor format: string shorthand (e.g. "orange") or { light, dark } object. ' +
        'Confirm clearly when done.',
    },
    example: 'Add a "Stale" view for sessions inactive > 7 days',
    displayLabelKey: 'editPopover.label.viewsConfiguration',
    exampleKey: 'editPopover.example.editViews',
    model: 'fast',               // 快速配置编辑用轻量模型
    systemPromptPreset: 'mini',   // 使用聚焦的 mini 提示
    inlineExecution: true,        // 在浮层内 inline 执行
  }),

  // 工具图标配置上下文
  'edit-tool-icons': (location) => ({
    context: {
      label: 'Tool Icons',
      filePath: location, // 这里 location 是 tool-icons.json 的完整路径
      context:
        'The user wants to edit CLI tool icon mappings. ' +
        'The file is tool-icons.json in ~/.craft-agent/tool-icons/. Icon image files live in the same directory. ' +
        'Schema: { version: 1, tools: [{ id, displayName, icon, commands }] }. ' +
        'Each tool has: id (unique slug), displayName (shown in UI), icon (filename like "git.ico"), commands (array of CLI command names). ' +
        'Supported icon formats: .png, .ico, .svg, .jpg. Icons display at 20x20px. ' +
        'Read ~/.craft-agent/docs/tool-icons.md for full format reference. ' +
        'After editing, call config_validate with target "tool-icons" to verify the changes are valid. ' +
        'Confirm clearly when done.',
    },
    example: 'Add an icon for my custom CLI tool "deploy"',
    displayLabelKey: 'editPopover.label.toolIcons',
    exampleKey: 'editPopover.example.editToolIcons',
    model: 'fast',               // 快速配置编辑用轻量模型
    systemPromptPreset: 'mini',   // 使用聚焦的 mini 提示
    inlineExecution: true,        // 在浮层内 inline 执行
  }),

  'automation-config': (location) => ({
    context: {
      label: 'Automation Configuration',
      filePath: `${location}/automations.json`,
      context:
        'The user is editing automations.json which configures automations. ' +
        'Structure: { version: 2, automations: { EventName: [{ name?, matcher?, cron?, timezone?, permissionMode?, labels?, actions: [...] }] } }. ' +
        'Each event maps to an array of matcher entries. Each matcher has an actions array ({ type: "prompt", prompt }). ' +
        'Read ~/.craft-agent/docs/automations.md for full format reference. ' +
        'After editing, confirm clearly what changed.',
    },
    example: 'Change the cron schedule to every 30 minutes',
    displayLabelKey: 'editPopover.label.automationConfiguration',
    exampleKey: 'editPopover.example.automationConfig',
    model: 'default',
    systemPromptPreset: 'mini',
    inlineExecution: true,
  }),
}

/**
 * 根据 key 获取完整编辑配置，同时返回给 Agent 的上下文和给 UI 的示例。
 *
 * @param key - 编辑上下文 key
 * @param location - 基础路径（如 workspace 根路径）
 *
 * @example
 * const { context, example } = getEditConfig('workspace-permissions', workspace.rootPath)
 */
export function getEditConfig(key: EditContextKey, location: string): EditConfig {
  const factory = EDIT_CONFIGS[key]
  if (!factory) {
    throw new Error(`Unknown edit context key: ${key}. Add it to EDIT_CONFIGS in EditPopover.tsx`)
  }
  const config = factory(location)

  // 把 i18n key 解析为翻译后的 UI 字符串
  // context.label 保持英文给 Agent 作提示；displayLabel 用于界面展示
  return {
    ...config,
    displayLabel: config.displayLabelKey ? i18n.t(config.displayLabelKey) : config.context.label,
    example: config.exampleKey ? i18n.t(config.exampleKey) : config.example,
    overridePlaceholder: config.overridePlaceholderKey ? i18n.t(config.overridePlaceholderKey) : config.overridePlaceholder,
  }
}

/**
 * 浮层底部左侧可选的次要操作按钮。
 * 样式为纯文本、hover 下划线，常用于“编辑文件”动作。
 */
export interface SecondaryAction {
  /** 按钮标签（如 "Edit File"） */
  label: string
  /** 直接用系统编辑器打开的文件路径（绕过链接拦截器） */
  filePath: string
}

/** EditPopover 的 props。 */
export interface EditPopoverProps {
  /** 触发浮层打开的 React 元素 */
  trigger: React.ReactNode
  /** 显示在占位符里的示例文本（如 "Allow 'make build' command"） */
  example?: string
  /** 传给新聊天会话的上下文 */
  context: EditContext
  /** 新会话的权限模式（默认 'allow-all'） */
  permissionMode?: CreateSessionOptions['permissionMode']
  /**
   * 新会话的工作目录：
   * - 'none'（默认）：无工作目录（仅用 session 文件夹），适合配置编辑
   * - 'user_default': 使用 workspace 配置的默认目录
   * - 绝对路径字符串：使用指定路径
   */
  workingDirectory?: string | 'user_default' | 'none'
  /** 模型层级提示：fast 用 mini 模型，default 用主模型 */
  model?: 'fast' | 'default'
  /** mini agent 的系统提示预设（如 'mini' 用于聚焦编辑） */
  systemPromptPreset?: 'default' | 'mini'
  /** 浮层宽度（默认 320） */
  width?: number
  /** 触发元素的额外 className */
  triggerClassName?: string
  /** 浮层相对触发元素的方向 */
  side?: 'top' | 'right' | 'bottom' | 'left'
  /** 浮层对齐方式 */
  align?: 'start' | 'center' | 'end'
  /** 底部左侧可选的次要操作按钮（如 "Edit File"） */
  secondaryAction?: SecondaryAction
  /** 自定义占位符，覆盖默认的“Describe what you'd like to change” */
  overridePlaceholder?: string
  /** 翻译后的显示标签，用于徽标和空状态（回退到 context.label） */
  displayLabel?: string
  /**
   * 受控打开状态。传入后浮层由父组件控制。
   * 在程序化打开时使用（例如从右键菜单触发）。
   */
  open?: boolean
  /** 打开状态变化回调（受控模式用） */
  onOpenChange?: (open: boolean) => void
  /**
   * 为 true 时点击外部不关闭浮层。
   * 适用于右键菜单触发的浮层，焦点管理较复杂时。
   */
  modal?: boolean
  /**
   * 输入框预填充值。
   * 例如用户输入 "#Test" 后点“新增 label”，可把输入框预填为 "Add new label Test"。
   */
  defaultValue?: string
  /**
   * 为 true 时 mini agent 在浮层内 inline 执行，而不是打开新窗口。
   * 适合用 mini agent 做快速配置编辑。
   */
  inlineExecution?: boolean
}

/**
 * buildEditPrompt 的返回结果，包含完整提示和用于隐藏 XML 上下文的 badge 元数据。
 */
interface EditPromptResult {
  /** 包含 XML 元数据和用户指令的完整提示 */
  prompt: string
  /** 标记隐藏元数据区域的 badge */
  badges: ContentBadge[]
}

/**
 * 构建要发送给 Agent 的提示。
 * 使用类 XML 标签让结构清晰。
 *
 * 同时返回一个 context badge，把元数据区域在 UI 中折叠隐藏，但仍会发给 Agent。
 *
 * @param context - 编辑上下文，含 label、filePath、可选 context
 * @param userInstructions - 用户指令（可传空字符串，仅预填充上下文）
 *
 * @example
 * // 用户提交时使用
 * const { prompt, badges } = buildEditPrompt(context, "Add a Blocked status")
 *
 * // 右键菜单打开窗口、仅预填充上下文时使用
 * const { prompt, badges } = buildEditPrompt(context, "")
 */
export function buildEditPrompt(context: EditContext, userInstructions: string, displayLabel?: string): EditPromptResult {
  // 构建元数据段（会被 badge 折叠隐藏）
  // 结构简单：label（显示/上下文）、file（编辑目标）、可选 context
  // context.label 保持英文给 Agent；displayLabel 是翻译后的 UI 显示
  const metadataSection = `<edit_request>
<label>${context.label}</label>
<file>${context.filePath}</file>
${context.context ? `<context>${context.context}</context>\n` : ''}</edit_request>

`

  // badge 显示标签：优先用翻译后的 displayLabel，否则用英文 label
  const collapsedLabel = displayLabel || context.label

  // 完整提示 = 元数据 + 用户指令
  const prompt = metadataSection + userInstructions

  // 创建标记元数据段的 badge（start=0，end=元数据长度）
  const badge: ContentBadge = {
    type: 'context',
    label: collapsedLabel,
    rawText: metadataSection,
    start: 0,
    end: metadataSection.length,
    collapsedLabel,
  }

  return { prompt, badges: [badge] }
}

/** 编辑浮层组件 */
export function EditPopover({
  trigger,
  example,
  context,
  permissionMode = 'allow-all',
  workingDirectory = 'none', // 配置编辑默认只用 session 文件夹
  model,
  systemPromptPreset,
  width = 400, // 嵌入紧凑聊天默认 400px
  triggerClassName,
  side = 'bottom',
  align = 'end',
  secondaryAction,
  overridePlaceholder,
  displayLabel,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  modal = false,
  defaultValue = '',
  inlineExecution = false,
}: EditPopoverProps) {
  const { t } = useTranslation()
  const { onOpenFile, onOpenUrl } = usePlatform()
  const workspace = useActiveWorkspace()

  // 构建占位提示：inline 模式用轮播数组，否则用描述性字符串
  // overridePlaceholder 让 add-source/add-skill 等上下文显示“添加”而不是“修改”
  const placeholder = inlineExecution
    ? COMPACT_PLACEHOLDER_KEYS.map(key => t(key))
    : (() => {
        const basePlaceholder = overridePlaceholder ?? t("editPopover.describePlaceholder")
        return example
          ? `${basePlaceholder.replace(/\.{3}$/, '')}, e.g., "${example}"`
          : basePlaceholder
      })()

  // 同时支持受控和非受控模式：
  // - 非受控（默认）：内部 state 管理开关
  // - 受控：父组件通过 open/onOpenChange 管理
  const [internalOpen, setInternalOpen] = useState(false)
  const isControlled = controlledOpen !== undefined
  const open = isControlled ? controlledOpen : internalOpen
  const setOpen = (value: boolean) => {
    if (isControlled) {
      controlledOnOpenChange?.(value)
    } else {
      setInternalOpen(value)
    }
  }

  // 使用 App 上下文管理会话（与主聊天同一条代码路径）
  const { onCreateSession, onSendMessage, onRespondToPermission, onRespondToCredential } = useAppShellContext()

  // inline 执行用的会话 ID（在第一条消息时创建）
  const [inlineSessionId, setInlineSessionId] = useState<string | null>(null)

  // 从 Jotai atom 读取会话数据（与主聊天一致，包含乐观更新）
  // 还没有会话时传空字符串，atom 对未知 ID 返回 null
  const inlineSession = useSession(inlineSessionId || '')

  // inline 会话的待处理权限/凭据请求（与主聊天流程一致）
  const pendingPermission = usePendingPermission(inlineSessionId || '')
  const pendingCredential = usePendingCredential(inlineSessionId || '')

  // ChatDisplay 的模型状态（初始用 prop，用户可改）
  const [currentModel, setCurrentModel] = useState(model || 'haiku')

  // 还没有真实会话时，给 ChatDisplay 一个占位会话，
  // 这样第一条消息发出前就能显示输入框。
  const stubSession = useMemo((): Session => ({
    id: 'pending',
    workspaceId: workspace?.id || '',
    workspaceName: workspace?.name || '',
    messages: [],
    isProcessing: false,
    lastMessageAt: Date.now(),
  }), [workspace?.id, workspace?.name])

  // 有真实会话用真实会话，否则用占位
  const displaySession = inlineSession || stubSession

  // 跟踪处理中状态，用于阻止关闭和显示遮罩
  const isProcessing = displaySession.isProcessing

  // 使用已有的 ESC 中断上下文实现“按两次 Esc 中断”流程
  // 会在输入框显示“再按一次 Esc 中断”的覆盖提示
  const { handleEscapePress } = useEscapeInterrupt()

  // 浮层关闭时重置 inline 会话
  const resetInlineSession = useCallback(() => {
    setInlineSessionId(null)
  }, [])

  // 中断 inline 会话的生成
  const handleStopGeneration = useCallback(() => {
    if (inlineSessionId && isProcessing) {
      window.electronAPI.cancelProcessing(inlineSessionId, false)
    }
  }, [inlineSessionId, isProcessing])

  // 生成过程中处理 ESC 键：
  // 借助 EscapeInterruptContext 实现双击 ESC（第一次显示提示，第二次中断）
  const handleEscapeKeyDown = useCallback((e: KeyboardEvent) => {
    if (!isProcessing) {
      // 不在生成中，允许默认关闭行为
      return
    }

    // 生成中阻止默认关闭
    e.preventDefault()

    // 上下文的 ESC 处理器返回 true 表示是第二次按下，应中断
    const shouldInterrupt = handleEscapePress()
    if (shouldInterrupt) {
      handleStopGeneration()
    }
  }, [isProcessing, handleEscapePress, handleStopGeneration])

  // 生成过程中点击外部：
  // 阻止关闭，并通过上下文显示 ESC 提示，告诉用户如何取消
  const handleInteractOutside = useCallback((e: Event) => {
    if (isProcessing) {
      e.preventDefault()
      handleEscapePress()
    }
  }, [isProcessing, handleEscapePress])

  // 可拖拽浮层的状态
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const dragStartRef = useRef({ x: 0, y: 0, offsetX: 0, offsetY: 0 })
  const dragOffsetRef = useRef({ x: 0, y: 0 })
  const popoverRef = useRef<HTMLDivElement>(null)

  // 动态调整尺寸的状态
  const [containerSize, setContainerSize] = useState({ width: width || 400, height: 480 })
  const [isResizing, setIsResizing] = useState(false)
  const resizeStartRef = useRef({ x: 0, y: 0, width: 0, height: 0 })

  // 浮层打开时重置拖拽位置和尺寸
  useEffect(() => {
    if (open) {
      dragOffsetRef.current = { x: 0, y: 0 }
      setDragOffset({ x: 0, y: 0 })
      setContainerSize({ width: width || 400, height: 480 })
    }
  }, [open, width])

  // 拖拽事件处理
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsDragging(true)
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      offsetX: dragOffset.x,
      offsetY: dragOffset.y,
    }
  }, [dragOffset])

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      const rect = popoverRef.current?.getBoundingClientRect()
      if (!rect) return

      const MARGIN = 20
      const MARGIN_TOP = 50 // 保持在顶部标题栏（回退按钮、菜单按钮）下方
      const curr = dragOffsetRef.current
      const baseX = rect.left - curr.x
      const baseY = rect.top - curr.y

      const newX = dragStartRef.current.offsetX + e.clientX - dragStartRef.current.x
      const newY = dragStartRef.current.offsetY + e.clientY - dragStartRef.current.y

      const clampedX = Math.max(MARGIN - baseX, Math.min(window.innerWidth - MARGIN - rect.width - baseX, newX))
      const clampedY = Math.max(MARGIN_TOP - baseY, Math.min(window.innerHeight - MARGIN - rect.height - baseY, newY))

      dragOffsetRef.current = { x: clampedX, y: clampedY }
      setDragOffset({ x: clampedX, y: clampedY })
    }

    const handleMouseUp = () => {
      setIsDragging(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging])

  // 调整尺寸事件处理
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsResizing(true)
    resizeStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      width: containerSize.width,
      height: containerSize.height,
    }
  }, [containerSize])

  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - resizeStartRef.current.x
      const deltaY = e.clientY - resizeStartRef.current.y
      setContainerSize({
        width: Math.max(300, resizeStartRef.current.width + deltaX),
        height: Math.max(250, resizeStartRef.current.height + deltaY),
      })
    }

    const handleMouseUp = () => {
      setIsResizing(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing])

  // 浮层打开时重置状态
  useEffect(() => {
    if (open) {
      setCurrentModel(model || 'haiku')
      resetInlineSession()
    }
  }, [open, model, resetInlineSession])

  // ChatDisplay 发送消息处理（inline 模式）
  // 第一条消息时创建隐藏会话，之后用 App 上下文发送
  const handleInlineSendMessage = useCallback(async (message: string) => {
    const { prompt, badges } = buildEditPrompt(context, message, displayLabel)

    // 第一条消息时创建会话
    let sessionId = inlineSessionId
    if (!sessionId && workspace?.id) {
      const createOptions: CreateSessionOptions = {
        model: model || 'fast',
        systemPromptPreset: systemPromptPreset || 'mini',
        permissionMode,
        workingDirectory,
        hidden: true, // 隐藏会话走同一套 App 代码，但不出现在列表中
      }
      const newSession = await onCreateSession(workspace.id, createOptions)
      sessionId = newSession.id
      setInlineSessionId(sessionId)
    }

    // 通过 App 上下文发送消息（包含乐观的用户消息更新）
    // 传入 badges 把用户气泡里的 <edit_request> XML 元数据折叠隐藏
    if (sessionId) {
      onSendMessage(sessionId, prompt, undefined, undefined, badges)
    }
  }, [context, displayLabel, inlineSessionId, workspace?.id, model, systemPromptPreset, permissionMode, workingDirectory, onCreateSession, onSendMessage])

  // Legacy 模式：在当前窗口打开聊天
  const handleLegacySendMessage = useCallback((message: string) => {
    const { prompt, badges } = buildEditPrompt(context, message, displayLabel)
    const encodedInput = encodeURIComponent(prompt)
    const encodedBadges = encodeURIComponent(JSON.stringify(badges))

    const workdirParam = workingDirectory ? `&workdir=${encodeURIComponent(workingDirectory)}` : ''
    const modelParam = model ? `&model=${encodeURIComponent(model)}` : ''
    const systemPromptParam = systemPromptPreset ? `&systemPrompt=${encodeURIComponent(systemPromptPreset)}` : ''
    // 省略 window=focused 参数，在当前窗口打开
    const url = `craftagents://action/new-session?input=${encodedInput}&send=true&mode=${permissionMode}&badges=${encodedBadges}${workdirParam}${modelParam}${systemPromptParam}`

    window.electronAPI.openUrl(url)
    setOpen(false)
  }, [context, displayLabel, workingDirectory, model, systemPromptPreset, permissionMode, setOpen])

  return (
    <>
      {/* 处理中全屏遮罩 — 渲染在浮层后方 */}
      <AnimatePresence>
        {open && isProcessing && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5, ease: 'easeInOut' }}
            className="fixed inset-0 bg-black/5 z-40"
          />
        )}
      </AnimatePresence>

      <Popover open={open} onOpenChange={setOpen} modal={modal}>
        <PopoverTrigger asChild className={triggerClassName}>
          {trigger}
        </PopoverTrigger>
        <PopoverContent
            side={side}
            align={align}
            sticky="always"
            className="p-0"
            style={{
              width: containerSize.width,
              height: containerSize.height,
              background: 'transparent',
              border: 'none',
              boxShadow: 'none',
            }}
            onInteractOutside={handleInteractOutside}
            onEscapeKeyDown={handleEscapeKeyDown}
          >
            {/* 浮层容器 */}
            <div
              ref={popoverRef}
              className="relative bg-foreground-2 overflow-hidden w-full h-full shadow-modal-small"
              style={{
                transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)`,
                borderRadius: 16,
              }}
            >
              {/* 拖拽把手 — 悬浮覆盖层 */}
              <div
                onMouseDown={handleDragStart}
                className={cn(
                  "absolute top-0 left-1/2 -translate-x-1/2 z-50 px-4 py-2 cursor-grab rounded pointer-events-auto titlebar-no-drag",
                  isDragging && "cursor-grabbing"
                )}
              >
                <GripHorizontal className="w-4 h-4 text-muted-foreground/30" />
              </div>

              {/* 内容区 — 始终使用紧凑版 ChatDisplay */}
              <div className="flex-1 flex flex-col bg-foreground-2" style={{ height: '100%' }}>
                <ChatDisplay
                  session={displaySession}
                  onSendMessage={inlineExecution ? handleInlineSendMessage : handleLegacySendMessage}
                  onOpenFile={onOpenFile || (() => {})}
                  onOpenUrl={onOpenUrl || (() => {})}
                  currentModel={currentModel}
                  onModelChange={setCurrentModel}
                  pendingPermission={pendingPermission}
                  onRespondToPermission={onRespondToPermission}
                  pendingCredential={pendingCredential}
                  onRespondToCredential={onRespondToCredential}
                  compactMode={true}
                  placeholder={placeholder}
                  emptyStateLabel={displayLabel || context.label}
                />
              </div>
            </div>

            {/* 右下角调整大小把手 — 放在 overflow-hidden 容器外部 */}
            <div
              onMouseDown={handleResizeStart}
              className="absolute -bottom-2 -right-2 w-6 h-6 cursor-nwse-resize pointer-events-auto z-50"
              style={{ transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)` }}
            />
          </PopoverContent>
      </Popover>
    </>
  )
}

/**
 * 与 EditPopover 配套的标准编辑按钮。
 * 推荐作为 trigger prop 使用，保持应用内样式一致。
 *
 * 使用 forwardRef，以便配合 Radix 的 asChild 模式（子元素需要接受 ref 并展开 props）。
 *
 * @example
 * <EditPopover
 *   trigger={<EditButton />}
 *   context={getEditContext('workspace-permissions', { workspacePath })}
 * />
 */
export const EditButton = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof Button>
>(function EditButton({ className, ...props }, ref) {
  const { t } = useTranslation()
  return (
    <Button
      ref={ref}
      variant="ghost"
      size="sm"
      // 把基础样式与 asChild 传入的 className 合并
      className={cn("h-8 px-3 rounded-[6px] bg-background shadow-minimal text-foreground/70 hover:text-foreground", className)}
      {...props}
    >
      {t("common.edit")}
    </Button>
  )
})
