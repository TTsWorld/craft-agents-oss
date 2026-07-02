/**
 * 标准 locale 注册表：所有支持语言的唯一事实来源（single source of truth）。
 *
 * 新增一门语言只需三步：
 * 1. 在 ./locales/ 下新增对应的 JSON 翻译文件；
 * 2. 在下方导入该文件的 messages 和 date-fns 对应的 locale；
 * 3. 在 LOCALE_REGISTRY 中新增一条记录。
 *
 * 其余地方（SUPPORTED_LANGUAGE_CODES、LANGUAGES、i18n resources、日期 locale 查找）
 * 都会自动从该注册表派生，无需再手动修改。
 */

// 从 date-fns 导入 Locale 类型（TS 类型导入，类似 Go 的接口声明引用，只在编译期生效）
import type { Locale } from "date-fns";

// ─── 翻译资源 ───────────────────────────────────────────────────────────────
import enMessages from "./locales/en.json";
import esMessages from "./locales/es.json";
import zhHansMessages from "./locales/zh-Hans.json";
import jaMessages from "./locales/ja.json";
import huMessages from "./locales/hu.json";
import deMessages from "./locales/de.json";
import plMessages from "./locales/pl.json";

// ─── date-fns 日期 locale ───────────────────────────────────────────────────
import { enUS } from "date-fns/locale/en-US";
import { es as esDateLocale } from "date-fns/locale/es";
import { zhCN } from "date-fns/locale/zh-CN";
import { ja as jaDateLocale } from "date-fns/locale/ja";
import { hu as huDateLocale } from "date-fns/locale/hu";
import { de as deDateLocale } from "date-fns/locale/de";
import { pl as plDateLocale } from "date-fns/locale/pl";

// ─── 注册表 ─────────────────────────────────────────────────────────────────

// LocaleEntry：一条 locale 记录的结构定义
// interface 类似 Go 里的 interface，用来描述对象必须有哪些字段
interface LocaleEntry {
  // 该语言在本国语言中的名称，例如 "简体中文"
  nativeName: string;
  // 翻译消息表：键为翻译 key，值为对应语言的文本
  // Record<string, string> 是 TS 内置类型，表示“键为 string、值为 string 的对象”
  messages: Record<string, string>;
  // date-fns 的日期格式化 locale
  dateLocale: Locale;
}

// LOCALE_REGISTRY：所有支持语言的字典
// satisfies 是 TS 的类型约束运算符：要求对象符合 Record<string, LocaleEntry>，
// 但不改变对象本身的推导类型，这样 keyof 拿到的键名仍然是具体的 "en" | "es" | ...
export const LOCALE_REGISTRY = {
  en: { nativeName: "English", messages: enMessages, dateLocale: enUS },
  es: { nativeName: "Español", messages: esMessages, dateLocale: esDateLocale },
  "zh-Hans": {
    nativeName: "简体中文",
    messages: zhHansMessages,
    dateLocale: zhCN,
  },
  ja: { nativeName: "日本語", messages: jaMessages, dateLocale: jaDateLocale },
  hu: { nativeName: "Magyar", messages: huMessages, dateLocale: huDateLocale },
  de: {
    nativeName: "Deutsch",
    messages: deMessages,
    dateLocale: deDateLocale,
  },
  pl: { nativeName: "Polski", messages: plMessages, dateLocale: plDateLocale },
} satisfies Record<string, LocaleEntry>;

// LanguageCode：从 LOCALE_REGISTRY 的键派生出的联合类型
// keyof typeof 表示“取对象的键集合作为类型”，这里结果为 "en" | "es" | "zh-Hans" | ...
export type LanguageCode = keyof typeof LOCALE_REGISTRY;
