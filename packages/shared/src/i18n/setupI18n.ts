import i18n, { type i18n as I18nInstance, type InitOptions } from "i18next";
import { LOCALE_REGISTRY } from "./registry";
import { SUPPORTED_LANGUAGE_CODES } from "./languages";

// 从 locale 注册表构建 i18next 所需的资源结构：{ [code]: { translation: messages } }
// Object.entries 把对象变成 [key, value] 数组，map 做转换，Object.fromEntries 再还原成对象
const resources = Object.fromEntries(
  Object.entries(LOCALE_REGISTRY).map(([code, entry]) => [
    code,
    { translation: entry.messages },
  ]),
);

// 同步初始化标志位：因为 initImmediate 设为 false，init 是同步完成的，
// 所以用布尔值即可充当“单例是否已初始化”的守卫。
// 如果以后改为异步初始化，需要把这个标志换成基于 Promise 的单例。
let initialized = false;

/**
 * 初始化 i18next 并加载内置翻译资源。
 * 通常在应用启动时调用一次即可。
 *
 * @param plugins - 可选的 i18next 插件数组，例如 React 集成插件 initReactI18next、
 *                  浏览器语言探测插件 LanguageDetector 等。
 *                  类型写成 any[] 是为了兼容各式各样的第三方插件类型；
 *                  // eslint-disable-next-line 是 ESLint 指令，用来关闭 TS 对显式 any 的警告。
 */
export function setupI18n(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plugins: any[] = [],
): I18nInstance {
  // 已初始化则直接返回单例，避免重复 init
  if (initialized) return i18n;

  // 依次 use 插件，链式返回的仍是同一个 i18next 实例
  let instance = i18n;
  for (const plugin of plugins) {
    instance = instance.use(plugin);
  }

  // 初始化 i18next；as InitOptions 是 TS 类型断言，表示“把这个对象当成 InitOptions 类型”
  instance.init({
    resources,                       // 内置翻译资源
    fallbackLng: "en",              // 当前语言缺少翻译时回退到英语
    supportedLngs: [...SUPPORTED_LANGUAGE_CODES], // 允许切换的语言列表（展开为数组副本）
    interpolation: { escapeValue: false }, // 不转义插值内容（通常前端框架已自行处理 XSS）
    initImmediate: false,            // 同步初始化：资源已内联打包，无需异步加载
    detection: {
      order: ["localStorage", "navigator"], // 语言探测顺序：先本地存储，再浏览器语言
      caches: ["localStorage"],             // 把检测到的语言缓存到 localStorage
      lookupLocalStorage: "i18nextLng",     // localStorage 中使用的 key
    },
  } as InitOptions);

  initialized = true;
  return i18n;
}

export { i18n };
