import { existsSync, readFileSync, statSync, writeFileSync, unlinkSync, mkdtempSync, renameSync } from 'fs';
import { extname, basename, resolve, join, relative } from 'path';
import { execSync } from 'child_process';
import { tmpdir } from 'os';

/**
 * 去除字符串开头的 UTF-8 BOM（字节顺序标记）。
 * 某些编辑器或工具写入的文件可能带 BOM（\uFEFF），会导致 JSON.parse() 报 "Unexpected token" 错误。
 *
 * @param text - 待处理的字符串
 * @returns 去掉 BOM 后的字符串
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

/**
 * 安全解析 JSON 字符串，自动去除开头的 UTF-8 BOM。
 * 对于可能来自文件的内容，请用本函数代替原生 JSON.parse()。
 *
 * @param text - JSON 字符串
 * @returns 解析后的值（unknown 类型，使用时通常需 as 断言）
 */
export function safeJsonParse(text: string): unknown {
  return JSON.parse(stripBom(text));
}

/**
 * 读取并解析 JSON 文件，透明处理 UTF-8 BOM。
 * 替代常见的 JSON.parse(readFileSync(path, 'utf-8')) 写法。
 *
 * @param filePath - JSON 文件路径
 * @returns 解析后的值；泛型 T 类似 Go 的泛型约束，调用方指定返回类型
 */
export function readJsonFileSync<T = unknown>(filePath: string): T {
  return JSON.parse(stripBom(readFileSync(filePath, 'utf-8'))) as T;
}

/**
 * 原子写入文件：先写入临时文件再重命名。
 * 防止崩溃/中断时产生部分写入导致文件损坏。
 * 在 POSIX 系统上，write-to-temp-then-rename 是原子的。
 *
 * @param filePath - 目标文件路径
 * @param data - 要写入的字符串
 */
export function atomicWriteFileSync(filePath: string, data: string): void {
  const tmpPath = filePath + '.tmp';
  try {
    writeFileSync(tmpPath, data);
    renameSync(tmpPath, filePath);
  } catch (error) {
    // 重命名失败时清理临时文件
    try { unlinkSync(tmpPath); } catch {}
    throw error;
  }
}

/**
 * 文件附件描述。
 * TS 的 `interface` 用于定义对象形状，类似 Go 中带 json tag 的 struct。
 */
export interface FileAttachment {
  type: 'image' | 'text' | 'pdf' | 'office' | 'audio' | 'unknown';
  path: string;
  name: string;
  mimeType: string;
  base64?: string;
  text?: string;
  size: number;
  /** 文件在会话 attachments 文件夹中的存储路径（由 Electron 应用设置） */
  storedPath?: string;
  /** 转换后的 markdown 路径（针对 office 文件） */
  markdownPath?: string;
}

// Claude API 支持的图片类型
const IMAGE_EXTENSIONS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.ico': 'image/x-icon',
  '.icns': 'image/x-icns',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.svg': 'image/svg+xml',
};

// 文本文件扩展名
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.js', '.ts', '.tsx', '.jsx',
  '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h',
  '.css', '.scss', '.html', '.xml', '.yaml', '.yml', '.toml',
  '.sh', '.bash', '.zsh', '.fish', '.sql', '.graphql',
  '.env', '.gitignore', '.dockerfile', '.makefile',
  '.csv', '.log', '.conf', '.ini', '.cfg',
]);

// Office 文件扩展名（会通过 markitdown-js 转换为 markdown）
const OFFICE_EXTENSIONS: Record<string, string> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword',
  '.xls': 'application/vnd.ms-excel',
  '.ppt': 'application/vnd.ms-powerpoint',
};

// 音频文件扩展名（以 base64 转发；后端决定如何处理）
const AUDIO_EXTENSIONS: Record<string, string> = {
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.weba': 'audio/webm',
  '.webm': 'audio/webm',
};

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB 总限制
const MAX_TEXT_SIZE = 100 * 1024; // 文本文件 100KB 上限

// Claude API 图片限制 - 超限会静默失败
// 参见：https://docs.anthropic.com/en/docs/build-with-claude/vision
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB - Claude API 硬限制
const MAX_IMAGE_DIMENSION = 8000; // 最大 8000x8000 像素
const OPTIMAL_IMAGE_EDGE = 1568; // 推荐最大边长，平衡质量与成本（约 1.15MP）

/**
 * 图片校验结果。
 */
export interface ImageValidationResult {
  valid: boolean;
  /** 硬错误 - 图片无法发送 */
  error?: string;
  /** 错误码，用于程序化处理 */
  errorCode?: 'dimension_exceeded' | 'size_exceeded';
  /** 警告 - 图片可用但可能有问题 */
  warning?: string;
  /** 建议缩放以获得最佳性能 */
  needsResize?: boolean;
  /** 需要缩放时的建议尺寸 */
  suggestedSize?: { width: number; height: number };
}

/**
 * 校验图片是否符合 Claude API 要求。
 * 返回包含错误、警告和缩放建议的校验结果。
 *
 * @param size - 文件大小（字节）
 * @param width - 图片宽度（像素，可选）
 * @param height - 图片高度（像素，可选）
 */
export function validateImageForClaudeAPI(
  size: number,
  width?: number,
  height?: number
): ImageValidationResult {
  // 先检查文件大小（硬限制，无法通过缩放修复）
  if (size > MAX_IMAGE_SIZE) {
    const sizeMB = (size / 1024 / 1024).toFixed(1);
    return {
      valid: false,
      errorCode: 'size_exceeded',
      error: `Image too large (${sizeMB}MB). Claude API limit is 5MB. Please resize or compress the image.`,
    };
  }

  // 如果提供了宽高，检查尺寸
  if (width !== undefined && height !== undefined) {
    // 尺寸硬限制 - 可通过缩放修复
    if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
      return {
        valid: false,
        errorCode: 'dimension_exceeded',
        error: `Image dimensions too large (${width}×${height}). Maximum is ${MAX_IMAGE_DIMENSION}×${MAX_IMAGE_DIMENSION} pixels.`,
      };
    }

    // 检查是否建议缩放以优化性能
    const maxEdge = Math.max(width, height);
    if (maxEdge > OPTIMAL_IMAGE_EDGE) {
      const scale = OPTIMAL_IMAGE_EDGE / maxEdge;
      return {
        valid: true,
        needsResize: true,
        warning: `Large image (${width}×${height}). Will be resized to optimize tokens and latency.`,
        suggestedSize: {
          width: Math.round(width * scale),
          height: Math.round(height * scale),
        },
      };
    }
  }

  return { valid: true };
}

// 导出常量供其他模块使用
export const IMAGE_LIMITS = {
  MAX_SIZE: MAX_IMAGE_SIZE,
  /** base64 编码前的最大原始大小（base64 会膨胀 4/3，所以 5MB base64 ≈ 3.75MB 原始大小） */
  MAX_RAW_SIZE: Math.floor(MAX_IMAGE_SIZE * 3 / 4),
  MAX_DIMENSION: MAX_IMAGE_DIMENSION,
  OPTIMAL_EDGE: OPTIMAL_IMAGE_EDGE,
  /** 照片类图片的 JPEG 质量 */
  JPEG_QUALITY_HIGH: 90,
  /** 尺寸仍超限时回退压缩的 JPEG 质量 */
  JPEG_QUALITY_FALLBACK: 75,
} as const;

/**
 * 从输入文本中提取文件路径。
 * 支持：
 * - 绝对路径（/path/to/file）
 * - 家目录相对路径（~/path/to/file）
 * - 带引号路径（"path with spaces"）
 * - Shell 转义路径（/path/to/file\ with\ spaces）
 * - 以 .extension 结尾且含空格的路径
 *
 * @param input - 包含路径的输入文本
 * @returns 提取到的路径数组
 */
export function extractFilePaths(input: string): string[] {
  const paths: string[] = [];

  // 先匹配带引号路径（天然支持空格）
  const quotedRegex = /["']([^"']+)["']/g;
  let match;
  while ((match = quotedRegex.exec(input)) !== null) {
    const path = match[1];
    if (path && looksLikeFilePath(path)) {
      paths.push(path);
    }
  }

  // 匹配 shell 转义路径（空格前带反斜杠）：/path/to/file\ name.ext
  const escapedRegex = /(?:^|\s)((?:\/|\/\/)[^\s"']*(?:\\ [^\s"']*)+)/g;
  while ((match = escapedRegex.exec(input)) !== null) {
    let path = match[1];
    if (path) {
      // 去掉转义
      path = path.replace(/\\ /g, ' ');
      if (!paths.includes(path)) {
        paths.push(path);
      }
    }
  }

  // 尝试匹配带空格的路径：找以 / 或 ~/ 开头、以任意 .extension 结尾的路径
  // 处理：/Users/test/Screenshot 2024-01-01.png
  const lines = input.split('\n');
  for (const line of lines) {
    // 找以 / 或 ~/ 开头、以任意 .extension 结尾的路径
    const pathMatch = line.match(/^((?:\/|\/\/)[^\n]+?)(\.[a-zA-Z0-9]{1,10})(\s|$)/);
    if (pathMatch && pathMatch[1] && pathMatch[2]) {
      const fullPath = pathMatch[1] + pathMatch[2];
      if (!paths.includes(fullPath)) {
        paths.push(fullPath);
      }
    }
  }

  // 匹配简单无引号路径（无空格，以 / 或 ~ 开头）
  const unquotedRegex = /(?:^|\s)((?:\/|\/\/)[^\s"']+)/g;
  while ((match = unquotedRegex.exec(input)) !== null) {
    const path = match[1];
    if (path && !paths.includes(path)) {
      paths.push(path);
    }
  }

  return paths;
}

/**
 * 判断字符串是否像文件路径。
 */
function looksLikeFilePath(str: string): boolean {
  // 必须以 / 或 ~/ 开头
  if (!str.startsWith('/') && !str.startsWith('~/')) {
    return false;
  }
  // 前缀后必须有内容
  if (str.length < 2) {
    return false;
  }
  // 应有文件扩展名或为目录
  return true;
}

/**
 * 解析路径（处理 ~ 展开）。
 *
 * @param filePath - 待解析路径
 * @returns 解析后的绝对路径
 */
export function resolvePath(filePath: string): string {
  if (filePath.startsWith('~/')) {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    return resolve(home, filePath.slice(2));
  }
  return resolve(filePath);
}

/**
 * 根据扩展名判断文件类型。
 * 未知扩展名回退为 'text'（会尝试按文本读取）。
 *
 * @param filePath - 文件路径
 * @returns 文件类型
 */
export function getFileType(filePath: string): 'image' | 'text' | 'pdf' | 'office' | 'audio' | 'unknown' {
  const ext = extname(filePath).toLowerCase();

  if (ext in IMAGE_EXTENSIONS) {
    return 'image';
  }
  if (ext === '.pdf') {
    return 'pdf';
  }
  if (ext in OFFICE_EXTENSIONS) {
    return 'office';
  }
  if (ext in AUDIO_EXTENSIONS) {
    return 'audio';
  }
  if (TEXT_EXTENSIONS.has(ext)) {
    return 'text';
  }

  // 未知扩展名默认按文本处理——二进制文件会显示乱码，但至少能附加
  return 'text';
}

/**
 * 获取文件的 MIME 类型。
 *
 * @param filePath - 文件路径
 * @returns MIME 类型字符串
 */
export function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();

  const imageMime = IMAGE_EXTENSIONS[ext];
  if (imageMime) {
    return imageMime;
  }
  if (ext === '.pdf') {
    return 'application/pdf';
  }
  const officeMime = OFFICE_EXTENSIONS[ext];
  if (officeMime) {
    return officeMime;
  }
  const audioMime = AUDIO_EXTENSIONS[ext];
  if (audioMime) {
    return audioMime;
  }

  // 已知文本扩展名默认 text/plain
  if (TEXT_EXTENSIONS.has(ext)) {
    return 'text/plain';
  }

  return 'application/octet-stream';
}

/**
 * 读取文件并返回附件信息。
 *
 * @param filePath - 文件路径
 * @returns FileAttachment；读取失败返回 null
 */
export function readFileAttachment(filePath: string): FileAttachment | null {
  try {
    const resolved = resolvePath(filePath);

    if (!existsSync(resolved)) {
      return null;
    }

    const stats = statSync(resolved);

    if (!stats.isFile()) {
      return null;
    }

    if (stats.size > MAX_FILE_SIZE) {
      throw new Error(`File too large: ${basename(resolved)} (${Math.round(stats.size / 1024 / 1024)}MB > 20MB limit)`);
    }

    const type = getFileType(resolved);
    const mimeType = getMimeType(resolved);
    const name = basename(resolved);

    const attachment: FileAttachment = {
      type,
      path: resolved,
      name,
      mimeType,
      size: stats.size,
    };

    if (type === 'image') {
      // 图片以 base64 读取
      const buffer = readFileSync(resolved);
      attachment.base64 = buffer.toString('base64');
    } else if (type === 'text') {
      // 文本文件（受大小限制）
      if (stats.size > MAX_TEXT_SIZE) {
        // 大文本只读取前一部分
        const buffer = readFileSync(resolved);
        attachment.text = buffer.toString('utf-8').slice(0, MAX_TEXT_SIZE) +
          `\n\n[File truncated - showing first ${MAX_TEXT_SIZE / 1024}KB of ${Math.round(stats.size / 1024)}KB]`;
      } else {
        attachment.text = readFileSync(resolved, 'utf-8');
      }
    } else if (type === 'pdf') {
      // PDF 以 base64 读取
      const buffer = readFileSync(resolved);
      attachment.base64 = buffer.toString('base64');
    } else if (type === 'office') {
      // Office 文件以 base64 读取（后续再转换为 markdown）
      const buffer = readFileSync(resolved);
      attachment.base64 = buffer.toString('base64');
    } else if (type === 'audio') {
      // 音频以 base64 读取——识别 'audio' 的后端决定如何转发（转录、原生音频输入等）；
      // 不识别的后端会落到原有 'unknown' 分支，至少保证附件可见。
      const buffer = readFileSync(resolved);
      attachment.base64 = buffer.toString('base64');
    }

    return attachment;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('File too large')) {
      throw error;
    }
    return null;
  }
}

/**
 * 处理输入文本并提取其中的文件附件。
 * 返回清理后的文本和所有文件附件。
 *
 * @param input - 输入文本
 * @returns { text, attachments, errors }
 */
export function processInputWithFiles(input: string): {
  text: string;
  attachments: FileAttachment[];
  errors: string[];
} {
  const paths = extractFilePaths(input);
  const attachments: FileAttachment[] = [];
  const errors: string[] = [];

  // 逐个处理路径
  for (const path of paths) {
    try {
      const attachment = readFileAttachment(path);
      if (attachment) {
        attachments.push(attachment);
      } else {
        // 文件不存在——可能只是看起来像路径的普通文本
      }
    } catch (error) {
      if (error instanceof Error) {
        errors.push(error.message);
      }
    }
  }

  // 从文本中移除已成功附加的文件路径
  let cleanedText = input;
  for (const attachment of attachments) {
    // 移除带引号和不带引号的形式
    cleanedText = cleanedText.replace(`"${attachment.path}"`, '');
    cleanedText = cleanedText.replace(`'${attachment.path}'`, '');
    cleanedText = cleanedText.replace(attachment.path, '');

    // 也尝试用原始路径（解析前）
    const originalPath = paths.find(p => resolvePath(p) === attachment.path);
    if (originalPath && originalPath !== attachment.path) {
      cleanedText = cleanedText.replace(`"${originalPath}"`, '');
      cleanedText = cleanedText.replace(`'${originalPath}'`, '');
      cleanedText = cleanedText.replace(originalPath, '');
    }
  }

  // 清理多余空白
  cleanedText = cleanedText.replace(/\s+/g, ' ').trim();

  return { text: cleanedText, attachments, errors };
}

/**
 * 从剪贴板读取（跨平台）。
 * 检查：1) 文件 URL（复制的文件）；2) 图片。
 * 返回 FileAttachment[]，可能包含多个文件。
 *
 * @returns 附件数组
 */
export function readClipboard(): FileAttachment[] {
  if (process.platform === 'darwin') {
    return readClipboardMacOS();
  } else if (process.platform === 'win32') {
    return readClipboardWindows();
  } else if (process.platform === 'linux') {
    return readClipboardLinux();
  }
  return [];
}

/**
 * 从 macOS 剪贴板读取。
 * 检查：1) 文件 URL（Finder 中复制的文件）；2) 图片。
 */
function readClipboardMacOS(): FileAttachment[] {
  const attachments: FileAttachment[] = [];

  // 首先检查剪贴板中的文件 URL（Finder 中复制文件时）
  try {
    const scriptFile = join(tmpdir(), `craft-clipboard-files-${Date.now()}.js`);
    const jxaScript = `
ObjC.import('AppKit');
ObjC.import('Foundation');

var pb = $.NSPasteboard.generalPasteboard;

// Check for file URLs
var fileURLs = pb.propertyListForType($.NSFilenamesPboardType);
if (fileURLs && !fileURLs.isNil()) {
  var paths = ObjC.deepUnwrap(fileURLs);
  if (Array.isArray(paths) && paths.length > 0) {
    JSON.stringify({ type: 'files', paths: paths });
  } else {
    "no_files";
  }
} else {
  "no_files";
}
`;
    writeFileSync(scriptFile, jxaScript);

    const result = execSync(`osascript -l JavaScript "${scriptFile}"`, {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
    }).trim();

    try { unlinkSync(scriptFile); } catch {}

    if (result !== 'no_files' && result.startsWith('{')) {
      const parsed = JSON.parse(result);
      if (parsed.type === 'files' && Array.isArray(parsed.paths)) {
        for (const filePath of parsed.paths) {
          const attachment = readFileAttachment(filePath);
          if (attachment) {
            attachments.push(attachment);
          }
        }
      }
    }
  } catch {
    // 文件 URL 读取失败
  }

  // 拿到文件就直接返回
  if (attachments.length > 0) {
    return attachments;
  }

  // 否则检查剪贴板中的图片数据
  const imageAttachment = readClipboardImageDataMacOS();
  if (imageAttachment) {
    return [imageAttachment];
  }

  return [];
}

/**
 * 从 Windows 剪贴板读取。
 * 使用 PowerShell 访问文件和图片。
 */
function readClipboardWindows(): FileAttachment[] {
  const attachments: FileAttachment[] = [];

  // 检查剪贴板中的文件路径（资源管理器中复制的文件）
  try {
    const psScript = `
      Add-Type -AssemblyName System.Windows.Forms
      $files = [System.Windows.Forms.Clipboard]::GetFileDropList()
      if ($files.Count -gt 0) {
        $files | ConvertTo-Json -Compress
      } else {
        "no_files"
      }
    `;
    const result = execSync(`powershell -NoProfile -Command "${psScript.replace(/\n/g, ' ')}"`, {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
    }).trim();

    if (result !== 'no_files' && result.length > 0) {
      try {
        // PowerShell 单条返回字符串，数组返回 JSON 数组
        const paths = result.startsWith('[') ? JSON.parse(result) : [result.replace(/^"|"$/g, '')];
        for (const filePath of paths) {
          const attachment = readFileAttachment(filePath);
          if (attachment) {
            attachments.push(attachment);
          }
        }
      } catch {
        // JSON 解析失败
      }
    }
  } catch {
    // 文件读取失败
  }

  // 拿到文件就直接返回
  if (attachments.length > 0) {
    return attachments;
  }

  // 检查剪贴板中的图片数据
  const imageAttachment = readClipboardImageDataWindows();
  if (imageAttachment) {
    return [imageAttachment];
  }

  return [];
}

/**
 * 用 PowerShell 从 Windows 剪贴板读取图片数据。
 */
function readClipboardImageDataWindows(): FileAttachment | null {
  const tempFile = join(tmpdir(), `craft-clipboard-${Date.now()}.png`);

  try {
    // PowerShell 脚本：把剪贴板图片保存到文件
    const psScript = `
      Add-Type -AssemblyName System.Windows.Forms
      $img = [System.Windows.Forms.Clipboard]::GetImage()
      if ($img -ne $null) {
        $img.Save("${tempFile.replace(/\\/g, '\\\\')}", [System.Drawing.Imaging.ImageFormat]::Png)
        "success"
      } else {
        "no_image"
      }
    `;
    const result = execSync(`powershell -NoProfile -Command "${psScript.replace(/\n/g, ' ')}"`, {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
    }).trim();

    if (result === 'success' && existsSync(tempFile)) {
      return readImageFile(tempFile);
    }
  } catch {
    // PowerShell 剪贴板图片提取失败
  }

  return null;
}

/**
 * 从 Linux 剪贴板读取。
 * 使用 xclip 或 xsel 访问剪贴板。
 */
function readClipboardLinux(): FileAttachment[] {
  const attachments: FileAttachment[] = [];

  // 检查剪贴板中的 file URI（GNOME/KDE 文件管理器使用此格式）
  try {
    // 先尝试 xclip（最常见）
    let result: string | null = null;
    try {
      result = execSync('xclip -selection clipboard -t text/uri-list -o 2>/dev/null', {
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 5000,
      }).trim();
    } catch {
      // xclip 不可用，尝试 xsel
      try {
        result = execSync('xsel --clipboard --output 2>/dev/null', {
          encoding: 'utf-8',
          stdio: 'pipe',
          timeout: 5000,
        }).trim();
      } catch {
        // xsel 也不可用
      }
    }

    if (result && result.startsWith('file://')) {
      // 解析 file:// URI
      const lines = result.split('\n');
      for (const line of lines) {
        if (line.startsWith('file://')) {
          // URI 解码并转为路径
          const filePath = decodeURIComponent(line.replace('file://', ''));
          const attachment = readFileAttachment(filePath);
          if (attachment) {
            attachments.push(attachment);
          }
        }
      }
    }
  } catch {
    // 文件读取失败
  }

  // 拿到文件就直接返回
  if (attachments.length > 0) {
    return attachments;
  }

  // 检查剪贴板中的图片数据
  const imageAttachment = readClipboardImageDataLinux();
  if (imageAttachment) {
    return [imageAttachment];
  }

  return [];
}

/**
 * 用 xclip 从 Linux 剪贴板读取图片数据。
 */
function readClipboardImageDataLinux(): FileAttachment | null {
  const tempFile = join(tmpdir(), `craft-clipboard-${Date.now()}.png`);

  // 先用 xclip 取 image/png
  try {
    execSync(`xclip -selection clipboard -t image/png -o > "${tempFile}" 2>/dev/null`, {
      shell: '/bin/bash',
      stdio: 'pipe',
      timeout: 5000,
    });

    if (existsSync(tempFile)) {
      const stats = statSync(tempFile);
      if (stats.size > 0) {
        return readImageFile(tempFile);
      }
      // 空文件，清理
      try { unlinkSync(tempFile); } catch {}
    }
  } catch {
    // xclip 图片提取失败
  }

  // 再尝试 Wayland 的 wl-paste
  try {
    execSync(`wl-paste --type image/png > "${tempFile}" 2>/dev/null`, {
      shell: '/bin/bash',
      stdio: 'pipe',
      timeout: 5000,
    });

    if (existsSync(tempFile)) {
      const stats = statSync(tempFile);
      if (stats.size > 0) {
        return readImageFile(tempFile);
      }
      // 空文件，清理
      try { unlinkSync(tempFile); } catch {}
    }
  } catch {
    // wl-paste 失败
  }

  return null;
}

/**
 * 直接从 macOS 剪贴板读取图片数据（截图、复制图片）。
 */
function readClipboardImageDataMacOS(): FileAttachment | null {
  const tempFile = join(tmpdir(), `craft-clipboard-${Date.now()}.png`);

  // 方法 1：优先用 pngpaste（最可靠；可通过 brew install pngpaste 安装）
  try {
    execSync(`pngpaste "${tempFile}" 2>/dev/null`, { stdio: 'pipe' });
    if (existsSync(tempFile)) {
      const result = readImageFile(tempFile);
      if (result) return result;
    }
  } catch {
    // pngpaste 不可用或失败
  }

  // 方法 2：用 osascript + JXA（JavaScript for Automation）
  try {
    const scriptFile = join(tmpdir(), `craft-clipboard-script-${Date.now()}.js`);
    const jxaScript = `
ObjC.import('AppKit');
ObjC.import('Foundation');

var pb = $.NSPasteboard.generalPasteboard;

// 先尝试 PNG
var imgData = pb.dataForType($.NSPasteboardTypePNG);

// 没有 PNG 则尝试 TIFF
if (!imgData || imgData.isNil()) {
  imgData = pb.dataForType($.NSPasteboardTypeTIFF);
}

if (imgData && !imgData.isNil()) {
  var path = $.NSString.stringWithString("${tempFile}");
  var success = imgData.writeToFileAtomically(path, true);
  success ? "success" : "write_failed";
} else {
  "no_image";
}
`;
    writeFileSync(scriptFile, jxaScript);

    const result = execSync(`osascript -l JavaScript "${scriptFile}"`, {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
    }).trim();

    try { unlinkSync(scriptFile); } catch {}

    if (result === 'success' && existsSync(tempFile)) {
      const imageResult = readImageFile(tempFile);
      if (imageResult) return imageResult;
    }
  } catch {
    // JXA 方法失败
  }

  return null;
}

/**
 * 读取临时图片文件并创建附件。
 */
function readImageFile(tempFile: string): FileAttachment | null {
  try {
    const stats = statSync(tempFile);
    const buffer = readFileSync(tempFile);
    const base64 = buffer.toString('base64');

    // 清理临时文件
    try {
      unlinkSync(tempFile);
    } catch {
      // 忽略清理错误
    }

    return {
      type: 'image',
      path: 'clipboard',
      name: `pasted-image.png`, // Renderer 会分配顺序名称
      mimeType: 'image/png',
      base64,
      size: stats.size,
    };
  } catch {
    return null;
  }
}

/**
 * 将单个绝对路径格式化为相对于 cwd 的路径。
 *
 * @param absolutePath - 待格式化的绝对路径
 * @param cwd - 当前工作目录（默认 process.cwd()）
 * @returns cwd 内的相对路径（带 ./ 前缀）；cwd 外返回原路径
 */
export function formatSinglePathToRelative(absolutePath: string, cwd?: string): string {
  const basePath = cwd || process.cwd();

  if (absolutePath.startsWith(basePath)) {
    const relativePath = relative(basePath, absolutePath);
    if (relativePath && !relativePath.startsWith('..') && !relativePath.startsWith('./')) {
      return './' + relativePath;
    }
    return relativePath || absolutePath;
  }
  return absolutePath;
}

/**
 * 将文本中的绝对文件路径格式化为相对于 cwd 的路径。
 * 例如 /Users/john/project/src/file.ts → ./src/file.ts
 *
 * @param text - 包含文件路径的文本
 * @param cwd - 当前工作目录（默认 process.cwd()）
 * @returns 转换后的文本
 */
export function formatPathsToRelative(text: string, cwd?: string): string {
  const basePath = cwd || process.cwd();

  // 匹配绝对文件路径的正则：
  // 以 / 开头，后跟常见根路径段，再跟路径段
  // 处理常见文件扩展名和目录路径
  const absolutePathRegex = /(\/(?:Users|home|var|tmp|opt|etc)[^\s\n:,\]\})"'`]*)/g;

  return text.replace(absolutePathRegex, (match) => {
    return formatSinglePathToRelative(match, basePath);
  });
}

/**
 * 将工具输入对象中的文件路径格式化为相对路径。
 * 处理常见工具输入模式，如 { file_path: "..." } 或 { path: "..." }。
 *
 * @param input - 工具输入对象
 * @param cwd - 当前工作目录（默认 process.cwd()）
 * @returns 路径已格式化为相对路径的新对象
 */
export function formatToolInputPaths(
  input: Record<string, unknown> | undefined,
  cwd?: string
): Record<string, unknown> | undefined {
  if (!input) return input;

  const result: Record<string, unknown> = {};
  const pathKeys = ['file_path', 'path', 'directory', 'folder', 'source', 'destination', 'target'];

  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && pathKeys.includes(key) && value.startsWith('/')) {
      result[key] = formatSinglePathToRelative(value, cwd);
    } else if (typeof value === 'string') {
      // 也格式化字符串值中嵌入的路径
      result[key] = formatPathsToRelative(value, cwd);
    } else {
      result[key] = value;
    }
  }

  return result;
}
