/**
 * 标签类型定义
 *
 * 可配置会话标签的类型。标签是“叠加”的（一个 session 可多个），与 status 互斥（一个 session 一个）不同。
 * 存储位置：{workspaceRootPath}/labels/config.json
 *
 * 层级：标签通过 children 数组组成递归 JSON 树。
 * 数组位置决定显示顺序，不需要单独的 order 字段。
 * ID 是简单 slug，在整个树中全局唯一。
 *
 * 视觉：标签只通过颜色标识（UI 中渲染为彩色圆点）。
 *
 * 颜色格式：EntityColor（系统颜色字符串或自定义颜色对象）
 * - 系统："accent"、"foreground/50"、"info/80"（使用 CSS 变量，自动适配亮/暗模式）
 * - 自定义：{ light: "#EF4444", dark: "#F87171" }（显式值）
 */

import type { EntityColor } from '../colors/types.ts'

/**
 * 自动标签规则：用正则扫描用户消息，自动应用标签并提取值。
 *
 * 在 pattern 中使用捕获组（$1、$2...），然后替换到 valueTemplate。
 * 规则按顺序求值。一个标签可以有多个规则，意味着多种触发方式
 *（例如 URL 正则 + 裸 key 正则匹配 issue ID）。
 *
 * 类似 Golang：这里 interface 相当于 Go 的 interface，只描述字段形状。
 */
export interface AutoLabelRule {
  /** 用于提取值的正则表达式（含捕获组） */
  pattern: string
  /** 正则 flags（默认 'gi'，全局且忽略大小写）。'g' 一定会被强制加上。 */
  flags?: string
  /** 标签值模板，用 $1、$2 等替换捕获组 */
  valueTemplate?: string
  /** 这条规则匹配什么的可读说明 */
  description?: string
}

/**
 * 单个标签配置（存储在 labels/config.json）。
 * 递归结构：每个标签可有嵌套 children 形成树。
 * 数组位置 = 显示顺序。
 */
export interface LabelConfig {
  /** 唯一 ID — 简单 slug，整棵树内全局唯一，例如 'bug'、'frontend' */
  id: string;

  /** 显示名称 */
  name: string;

  /** 可选颜色，UI 中渲染为彩色圆点 */
  color?: EntityColor;

  /** 子标签，构成子树。数组位置 = 显示顺序 */
  children?: LabelConfig[];

  /**
   * 可选的值类型提示，用于 UI 渲染和 Agent 输入提示。
   * 设置后表示该标签携带一个有类型的值（如 "priority::3"）。
   * 解析器总是从原始值推断类型，但这个提示告诉 UI 用什么输入控件，
   * 并告诉 Agent 该写什么格式。
   * 不设置表示布尔标签（只判断是否存在）。
   */
  valueType?: 'string' | 'number' | 'date' | 'link';

  /**
   * 自动标签规则：用正则扫描用户消息并自动应用该标签、提取值。
   * 多个规则 = 多种触发方式（按顺序求值，收集所有匹配）。
   */
  autoRules?: AutoLabelRule[];
}

/**
 * 一个 workspace 的完整标签配置
 */
export interface WorkspaceLabelConfig {
  /** 配置版本号（从 1 开始） */
  version: number;

  /** 顶层标签数组。数组位置 = 显示顺序，可包含嵌套 children */
  labels: LabelConfig[];
}

/**
 * 创建新标签的输入（CRUD 用）。
 * parentId 决定插入位置（null/undefined 表示根级）。
 */
export interface CreateLabelInput {
  name: string;
  color?: EntityColor;
  parentId?: string; // 目标父标签 ID（null 表示根级）
  valueType?: 'string' | 'number' | 'date' | 'link';
}

/**
 * 更新已有标签的输入（只能改 name、color、valueType，不能改 ID 和层级）。
 */
export interface UpdateLabelInput {
  name?: string;
  color?: EntityColor;
  valueType?: 'string' | 'number' | 'date' | 'link';
}

/**
 * 解析后的会话标签条目（按 :: 切分后）。
 * 会话标签存储为扁平字符串，如 "bug" 或 "priority::3"。
 * 这个 interface 提供解析后的结构化访问。
 */
export interface ParsedLabelEntry {
  /** 标签 ID（:: 前面的部分，布尔标签则是整个字符串） */
  id: string;

  /** 原始字符串值（:: 后面的部分），布尔标签为 undefined */
  rawValue?: string;

  /**
   * 从 rawValue 推断出的有类型值：
   * - number：rawValue 能解析为有限数字
   * - Date：rawValue 匹配 ISO 日期格式（YYYY-MM-DD）
   * - string：其他情况
   * - undefined：布尔标签（没有 :: 分隔符）
   */
  value?: string | number | Date;
}
