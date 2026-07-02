/**
 * i18n 模块入口：统一导出国际化相关配置、初始化函数与类型。
 * 其他模块只需 import { ... } from '@shared/i18n' 即可使用。
 */
export { setupI18n, i18n } from "./setupI18n";
export { SUPPORTED_LANGUAGE_CODES, LANGUAGES } from "./languages";
export type { LanguageCode, LanguageConfig } from "./languages";
export { getDateLocale } from "./date-locale";
export { LOCALE_REGISTRY } from "./registry";
