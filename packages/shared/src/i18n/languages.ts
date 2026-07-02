import { LOCALE_REGISTRY, type LanguageCode } from "./registry";

// 重新导出 LanguageCode 类型，方便外部直接从本文件导入
export type { LanguageCode } from "./registry";

// LanguageConfig：描述一门语言用于展示所需的元数据（类似 Go 里的一个轻量结构体描述）
export interface LanguageConfig {
  // 该语言在本国语言中的名称
  nativeName: string;
}

/**
 * 所有支持的语言代码列表，从 LOCALE_REGISTRY 的键派生。
 * readonly 表示数组本身不可重新赋值，也不可 push/pop（浅层只读）。
 */
export const SUPPORTED_LANGUAGE_CODES: readonly LanguageCode[] = Object.keys(
  LOCALE_REGISTRY,
) as LanguageCode[];

/**
 * 语言展示元数据表：把注册表中的 nativeName 抽取成 { [code]: { nativeName } } 结构，
 * 供 UI 下拉框、设置页等场景直接使用。
 */
export const LANGUAGES: Record<LanguageCode, LanguageConfig> =
  Object.fromEntries(
    // Object.entries 返回 [code, entry]，map 后生成 [code, LanguageConfig]
    Object.entries(LOCALE_REGISTRY).map(([code, entry]) => [
      code,
      { nativeName: entry.nativeName },
    ]),
  ) as Record<LanguageCode, LanguageConfig>;
