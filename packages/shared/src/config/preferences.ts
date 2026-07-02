import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ensureConfigDir } from './storage.ts';
import { CONFIG_DIR } from './paths.ts';
import { readJsonFileSync } from '../utils/files.ts';
import { i18n, SUPPORTED_LANGUAGE_CODES } from '../i18n/index.ts';
import { LOCALE_REGISTRY, type LanguageCode } from '../i18n/registry.ts';

/** 用户地理位置（可选） */
export interface UserLocation {
  city?: string;
  region?: string;
  country?: string;
}

/**
 * Diff 查看器的显示偏好。
 * 作为用户级设置持久化到 preferences.json。
 */
export interface DiffViewerPreferences {
  /** Diff 布局：unified（合并）或 split（左右分栏） */
  diffStyle?: 'unified' | 'split';
  /** 是否禁用变更行的背景高亮 */
  disableBackground?: boolean;
}

/** 用户偏好设置结构（类似 Go struct） */
export interface UserPreferences {
  /** 用户称呼 */
  name?: string;
  /** 时区 */
  timezone?: string;
  /** 位置信息 */
  location?: UserLocation;
  /** Agent 可以学习的关于用户的自由备注 */
  notes?: string;
  /** Diff 查看器偏好 */
  diffViewer?: DiffViewerPreferences;
  /** git commit 是否附加 Co-Authored-By 尾注（默认 true） */
  includeCoAuthoredBy?: boolean;
  /**
   * 内部字段：持久化的 UI 语言代码（与 Appearance → Language 同步）。
   * 仅由主进程的 `i18n:changeLanguage` IPC handler 维护，
   * 不暴露给用户编辑，也不通过 `update_user_preferences` tool 修改。
   */
  uiLanguage?: LanguageCode;
  /** 上次更新时间戳 */
  updatedAt?: number;
}

const PREFERENCES_FILE = join(CONFIG_DIR, 'preferences.json');

/** 从磁盘加载用户偏好；文件不存在或解析失败时返回空对象 */
export function loadPreferences(): UserPreferences {
  try {
    if (!existsSync(PREFERENCES_FILE)) {
      return {};
    }
    const raw = readJsonFileSync<UserPreferences & { language?: unknown }>(PREFERENCES_FILE);
    // 读取时清理旧版自由文本 language 字段，避免它再次写回磁盘。
    // 旧值是 "Hungarian"、"English" 这类文本，不是语言代码，因此直接丢弃而非迁移。
    if (raw && typeof raw === 'object' && 'language' in raw) {
      delete (raw as { language?: unknown }).language;
    }
    return raw;
  } catch {
    return {};
  }
}

/** 保存用户偏好，自动更新 updatedAt */
export function savePreferences(prefs: UserPreferences): void {
  ensureConfigDir();
  prefs.updatedAt = Date.now();
  writeFileSync(PREFERENCES_FILE, JSON.stringify(prefs, null, 2), 'utf-8');
}

/**
 * 增量更新用户偏好。
 * location 和 diffViewer 会递归合并，而不是整体覆盖。
 */
export function updatePreferences(updates: Partial<UserPreferences>): UserPreferences {
  const current = loadPreferences();
  const updated = {
    ...current,
    ...updates,
    // 如果传了 location，就合并到现有 location
    location: updates.location
      ? { ...current.location, ...updates.location }
      : current.location,
    // 如果传了 diffViewer，就合并到现有 diffViewer
    diffViewer: updates.diffViewer
      ? { ...current.diffViewer, ...updates.diffViewer }
      : current.diffViewer,
  };
  savePreferences(updated);
  return updated;
}

/** 获取偏好文件路径 */
export function getPreferencesPath(): string {
  return PREFERENCES_FILE;
}

/**
 * 读取持久化的 UI 语言代码（会校验是否在支持列表中）。
 * 字段缺失或不被识别时返回 undefined。
 */
export function getPersistedUiLanguage(): LanguageCode | undefined {
  const prefs = loadPreferences();
  const candidate = prefs.uiLanguage;
  if (!candidate) return undefined;
  if (!SUPPORTED_LANGUAGE_CODES.includes(candidate)) return undefined;
  return candidate;
}

/**
 * 持久化 UI 语言代码。
 * 幂等：值未变时不重写文件（也不更新 updatedAt），
 * 避免启动同步时反复触发 config watcher 和重复 IPC 调用。
 */
export function setPersistedUiLanguage(code: LanguageCode): void {
  const current = loadPreferences();
  if (current.uiLanguage === code) return;
  savePreferences({ ...current, uiLanguage: code });
}

/**
 * 为 AI 生成会话标题时需要的“母语名称”，如果没有选择语言则返回 undefined。
 *
 * 使用显式持久化到磁盘的 UI 语言，而不是 i18n.resolvedLanguage：
 * 主进程的 i18n 在启动时是异步水合的，早期生成标题时可能还读到 'en' 回退（#885）。
 * 返回 undefined 会让标题 prompt 自动检测对话语言，而不是被强制用英文。
 */
export function resolveTitleLanguageName(): string | undefined {
  const code = getPersistedUiLanguage();
  return code ? LOCALE_REGISTRY[code]?.nativeName : undefined;
}

/**
 * 把用户偏好格式化成 system prompt 片段。
 * 空偏好或只有默认值时返回空字符串，避免污染 prompt。
 */
export function formatPreferencesForPrompt(): string {
  const prefs = loadPreferences();

  // 从应用 i18n 设置推导语言（Appearance > Language）
  const langCode = (i18n.resolvedLanguage ?? 'en') as LanguageCode;
  const langEntry = LOCALE_REGISTRY[langCode];
  const langName = langEntry?.nativeName ?? 'English';

  if (Object.keys(prefs).length === 0 ||
      (!prefs.name && !prefs.timezone && !prefs.location && !prefs.notes && langCode === 'en')) {
    return '';
  }

  const lines: string[] = ['## User Preferences - User has explicitly set these preferences, so adhere to them', ''];

  if (prefs.name) {
    lines.push(`- Name: ${prefs.name}`);
  }

  if (prefs.timezone) {
    lines.push(`- Timezone: ${prefs.timezone}`);
  }

  if (prefs.location) {
    const loc = prefs.location;
    const parts = [loc.city, loc.region, loc.country].filter(Boolean);
    if (parts.length > 0) {
      lines.push(`- Location: ${parts.join(', ')}`);
    }
  }

  // 始终包含语言，让 AI 知道应该用什么语言回复
  lines.push(`- Preferred language: ${langName}`);

  if (prefs.notes) {
    lines.push('', '### Notes about this user', prefs.notes);
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * 把用户偏好格式化成可读的展示文本。
 */
export function formatPreferencesDisplay(): string {
  const prefs = loadPreferences();

  const lines: string[] = ['**Your Preferences**', ''];

  // 检查是否有任何实际设置的偏好
  const hasName = !!prefs.name;
  const hasTimezone = !!prefs.timezone;
  const hasLocation = prefs.location && (prefs.location.city || prefs.location.region || prefs.location.country);
  const hasNotes = !!prefs.notes;
  const hasAnyPrefs = hasName || hasTimezone || hasLocation || hasNotes;

  lines.push('Your preferences help personalise your experience. The assistant uses these to provide more relevant responses (e.g., timezone for scheduling, language for communication).');
  lines.push('');

  if (!hasAnyPrefs) {
    lines.push('**Status:** Nothing saved yet.');
    lines.push('');
  } else {
    lines.push(`- Name: ${prefs.name || '(not set)'}`);
    lines.push(`- Timezone: ${prefs.timezone || '(not set)'}`);

    if (hasLocation) {
      const loc = prefs.location!;
      const parts = [loc.city, loc.region, loc.country].filter(Boolean);
      lines.push(`- Location: ${parts.join(', ')}`);
    } else {
      lines.push('- Location: (not set)');
    }

    const displayLangCode = (i18n.resolvedLanguage ?? 'en') as LanguageCode;
    const displayLangEntry = LOCALE_REGISTRY[displayLangCode];
    lines.push(`- Language: ${displayLangEntry?.nativeName ?? 'English'} (via Appearance settings)`);

    if (hasNotes) {
      lines.push('', '**Notes**', prefs.notes!);
    }

    if (prefs.updatedAt) {
      lines.push('', `_Last updated: ${new Date(prefs.updatedAt).toLocaleString()}_`);
    }
    lines.push('');
  }

  lines.push('**How to update:** Just tell the assistant (e.g., "My name is Alex" or "I\'m in London, GMT timezone").');
  lines.push(`**Config file:** \`${PREFERENCES_FILE}\``);

  return lines.join('\n');
}

/**
 * 是否应在 git commit 中附加 Co-Authored-By 尾注。
 * 用户未显式设置时默认 true。
 */
export function getCoAuthorPreference(): boolean {
  const prefs = loadPreferences();
  return prefs.includeCoAuthoredBy !== false;
}
