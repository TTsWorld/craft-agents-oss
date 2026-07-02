import { enUS } from "date-fns/locale/en-US";
import { LOCALE_REGISTRY, type LanguageCode } from "./registry";

/**
 * 根据语言代码获取对应的 date-fns Locale。
 * 如果传入的语言不在 LOCALE_REGISTRY 中，则回退到美式英语 enUS。
 */
export function getDateLocale(lang: string): import("date-fns").Locale {
  // as LanguageCode：把 string 断言为 LanguageCode 联合类型，以便能索引 LOCALE_REGISTRY
  const entry = LOCALE_REGISTRY[lang as LanguageCode];
  // entry?.dateLocale 是可选链：若 entry 不存在则返回 undefined，?? 再提供默认值 enUS
  return entry?.dateLocale ?? enUS;
}
