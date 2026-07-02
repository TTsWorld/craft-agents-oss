/**
 * 二进制检测与文件保存工具
 *
 * 共享的二进制内容检测，被 guardLargeResult() 用于处理所有工具结果路径
 * 中的二进制数据（API 工具、MCP 工具、Claude SDK）。
 *
 * 从 api-tools.ts 中提取出来，以便集中使用。
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

// ============================================================
// 常量
// ============================================================

/** 二进制下载的最大文件大小（500MB）——防止 OOM */
export const MAX_DOWNLOAD_SIZE = 500 * 1024 * 1024;

/**
 * 常见二进制格式的魔数（文件签名）。
 * 当 MIME 类型未知或为通用类型时，用于检测文件类型。
 */
const MAGIC_SIGNATURES: Array<{ bytes: number[]; ext: string }> = [
  { bytes: [0x25, 0x50, 0x44, 0x46], ext: '.pdf' },           // %PDF
  { bytes: [0x89, 0x50, 0x4E, 0x47], ext: '.png' },           // .PNG
  { bytes: [0xFF, 0xD8, 0xFF], ext: '.jpg' },                  // JPEG
  { bytes: [0x47, 0x49, 0x46, 0x38], ext: '.gif' },           // GIF8
  { bytes: [0x50, 0x4B, 0x03, 0x04], ext: '.zip' },           // PK..（也含 docx、xlsx、pptx）
  { bytes: [0x52, 0x61, 0x72, 0x21], ext: '.rar' },           // Rar!
  { bytes: [0x1F, 0x8B], ext: '.gz' },                         // gzip
  { bytes: [0x42, 0x4D], ext: '.bmp' },                        // BM
  { bytes: [0x49, 0x44, 0x33], ext: '.mp3' },                  // ID3（带 ID3 标签的 MP3）
  { bytes: [0xFF, 0xFB], ext: '.mp3' },                        // MP3 帧同步
  { bytes: [0x52, 0x49, 0x46, 0x46], ext: '.wav' },           // RIFF（WAV 容器）
  { bytes: [0x4F, 0x67, 0x67, 0x53], ext: '.ogg' },           // OggS
  { bytes: [0x66, 0x4C, 0x61, 0x43], ext: '.flac' },          // fLaC
];

/**
 * MIME 类型到文件扩展名的映射，用于二进制下载。
 */
export const MIME_TO_EXT: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/gzip': '.gz',
  'application/x-gzip': '.gz',
  'application/x-tar': '.tar',
  'application/x-rar-compressed': '.rar',
  'application/x-7z-compressed': '.7z',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/x-icon': '.ico',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/flac': '.flac',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-msvideo': '.avi',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/octet-stream': '.bin',
};

// ============================================================
// 检测函数
// ============================================================

/**
 * 检查 buffer 内容判断是否为二进制数据。
 * 检查空字节和不可打印字符的高比例。
 *
 * UTF-8 处理：跳过所有 >= 0x80 的字节（多字节序列），避免把国际文本
 * （带重音符号、emoji、CJK）误判为二进制。只分析 ASCII 字节（0x00-0x7F）的可打印性。
 */
export function looksLikeBinary(buffer: Buffer): boolean {
  // 只检查前 8KB
  const sample = buffer.slice(0, 8192);

  // 空字节是二进制的明显标志
  if (sample.includes(0x00)) return true;

  // 统计不可打印 ASCII 字符数量（完全跳过 UTF-8 多字节）
  let nonPrintable = 0;
  let asciiCount = 0;
  for (const byte of sample) {
    // 跳过 UTF-8 多字节序列（首字节和延续字节都跳过）
    if (byte >= 0x80) continue;

    asciiCount++;
    // 判断 ASCII 字节是否不可打印（排除常见空白）
    if (byte < 0x09 || (byte > 0x0D && byte < 0x20)) {
      nonPrintable++;
    }
  }

  // 若 ASCII 字节中超过 10% 不可打印，则可能是二进制
  return asciiCount > 0 && (nonPrintable / asciiCount) > 0.10;
}

/**
 * 根据魔数（文件签名）检测文件扩展名。
 * 检查 buffer 前几个字节来识别常见文件格式。
 * 返回带点号的扩展名（如 '.pdf'），未知返回空字符串。
 */
export function detectExtensionFromMagic(buffer: Buffer): string {
  if (buffer.length < 8) return '';

  for (const sig of MAGIC_SIGNATURES) {
    if (sig.bytes.every((byte, i) => buffer[i] === byte)) {
      return sig.ext;
    }
  }
  return '';
}

/**
 * 根据 MIME 类型获取文件扩展名，可选魔数回退。
 */
export function getMimeExtension(mimeType: string | null, buffer?: Buffer): string {
  if (mimeType) {
    const normalized = (mimeType.toLowerCase().split(';')[0] ?? '').trim();
    const ext = MIME_TO_EXT[normalized];
    if (ext && ext !== '.bin') return ext;
  }

  if (buffer) {
    return detectExtensionFromMagic(buffer);
  }

  return '';
}

// ============================================================
// 内联 Base64 检测
// ============================================================

/** 视为有意义二进制所需的最小 base64 载荷长度（避免短 token、API key、JWT） */
const MIN_BASE64_LENGTH = 256;

/** 视为有意义内容所需的最小解码后字节数 */
const MIN_DECODED_SIZE = 128;

/**  inherently 二进制的 MIME 类型（解码后跳过 looksLikeBinary 校验） */
const BINARY_MIME_PREFIXES = ['image/', 'audio/', 'video/', 'application/pdf', 'application/zip', 'application/gzip', 'application/octet-stream'];

/** Data URL 正则：data:<mime>;base64,<payload> */
const DATA_URL_RE = /^data:([^;,]+);base64,(.+)$/s;

/**
 * 从字符串中提取 base64 编码二进制的结果。
 */
export interface Base64ExtractionResult {
  buffer: Buffer;
  mimeType: string | null;
  /** 从 MIME 或魔数推导出的文件扩展名（含点号） */
  ext: string;
  source: 'data-url' | 'raw-base64';
}

/**
 * 判断 MIME 类型是否本质上是二进制（无需再校验解码后的字节）。
 */
function isBinaryMime(mime: string): boolean {
  const normalized = mime.toLowerCase().trim();
  return BINARY_MIME_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

/**
 * 尝试从文本字符串中提取 base64 编码的二进制内容。
 *
 * 处理两种形式：
 * 1. Data URL：`data:<mime>;base64,<payload>`
 * 2. 原始 base64 块：长串 base64 字符
 *
 * 两步校验以降低误报：
 * - 字符集 + 结构检查（是否可能是 base64？）
 * - 解码 + 二进制校验（解码后的字节是否真是二进制？）
 *
 * 返回 null 表示不包含可提取的 base64 二进制。
 */
export function extractBase64Binary(text: string): Base64ExtractionResult | null {
  const trimmed = text.trim();

  // --- 路径 A：Data URL ---
  const dataUrlMatch = trimmed.match(DATA_URL_RE);
  if (dataUrlMatch) {
    const mime = dataUrlMatch[1]!;
    const payload = dataUrlMatch[2]!;
    if (payload.length < MIN_BASE64_LENGTH) return null;

    try {
      const decoded = Buffer.from(payload, 'base64');
      if (decoded.length < MIN_DECODED_SIZE) return null;

      // 已知二进制 MIME 直接信任，跳过 looksLikeBinary
      if (!isBinaryMime(mime) && !looksLikeBinary(decoded)) return null;

      const ext = getMimeExtension(mime, decoded) || '.bin';
      return { buffer: decoded, mimeType: mime, ext, source: 'data-url' };
    } catch {
      return null;
    }
  }

  // --- 路径 B：原始 base64 块 ---
  // 严格规范化管线——拒绝结构上不是标准 base64 的输入，
  // 消除 Node 宽松 Buffer.from() 带来的误报。
  if (trimmed.length < MIN_BASE64_LENGTH) return null;

  // 快速拒绝：结构化数据分隔符
  const firstChar = trimmed.charCodeAt(0);
  if (firstChar === 0x7B || firstChar === 0x5B || firstChar === 0x3C) return null; // { [ <

  // 步骤 1：只剥离 CR/LF（RFC 2045 标准 base64 行换行）。
  // 空格不剥离——真正的 base64 不会包含空格。
  const stripped = trimmed.replace(/[\r\n]/g, '');

  // 步骤 2：严格字符集——检测字母表变体。
  // 标准：[A-Za-z0-9+/]，可选 = 填充
  // URL-safe：[A-Za-z0-9\-_]，可选 = 填充
  const isStandard = /^[A-Za-z0-9+/]+=*$/.test(stripped);
  const isUrlSafe = !isStandard && /^[A-Za-z0-9\-_]+=*$/.test(stripped);
  if (!isStandard && !isUrlSafe) return null;

  // 步骤 3：规范化为标准字母表以便解码
  const normalized = isUrlSafe
    ? stripped.replace(/-/g, '+').replace(/_/g, '/')
    : stripped;

  // 步骤 4：自动填充，使长度能被 4 整除
  const padded = normalized.length % 4 === 0
    ? normalized
    : normalized + '='.repeat((4 - (normalized.length % 4)) % 4);

  // 步骤 5：解码
  let decoded: Buffer;
  try {
    decoded = Buffer.from(padded, 'base64');
  } catch {
    return null;
  }
  if (decoded.length < MIN_DECODED_SIZE) return null;

  // 步骤 6：规范往返——重新编码并与填充后的输入比较。
  // 捕获任何被 Node 宽松解码器静默篡改的输入。
  if (decoded.toString('base64') !== padded) return null;

  // 步骤 7：二进制相似性检查
  if (!looksLikeBinary(decoded)) return null;

  const ext = detectExtensionFromMagic(decoded) || '.bin';
  return { buffer: decoded, mimeType: null, ext, source: 'raw-base64' };
}

// ============================================================
// 文件保存
// ============================================================

/** 将字节数格式化为可读字符串。 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const size = bytes / Math.pow(k, i);
  return `${size.toFixed(i > 0 ? 1 : 0)} ${sizes[i]}`;
}

/** 清理文件名，移除不安全字符。 */
export function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 200);
}

/**
 * 返回给 Agent 的二进制下载结果。
 */
export interface BinaryDownloadResult {
  type: 'file_download';
  path: string;
  filename: string;
  mimeType: string | null;
  size: number;
  sizeHuman: string;
}

/**
 * 二进制保存失败时返回的错误结果。
 */
export interface BinaryDownloadError {
  type: 'file_download_error';
  error: string;
}

/**
 * 将二进制响应保存到会话的 downloads 文件夹。
 * 使用原子文件创建（O_EXCL）防止 TOCTOU 竞态条件。
 */
export function saveBinaryResponse(
  sessionPath: string,
  filename: string,
  buffer: Buffer,
  mimeType: string | null
): BinaryDownloadResult | BinaryDownloadError {
  const downloadsDir = join(sessionPath, 'downloads');

  try {
    mkdirSync(downloadsDir, { recursive: true });
  } catch (err) {
    return {
      type: 'file_download_error',
      error: `Failed to create downloads directory: ${(err as Error).message}`,
    };
  }

  let finalFilename = filename;
  let filePath = join(downloadsDir, finalFilename);
  let counter = 0;
  const maxAttempts = 100;

  while (counter < maxAttempts) {
    try {
      writeFileSync(filePath, buffer, { flag: 'wx' });
      return {
        type: 'file_download',
        path: filePath,
        filename: finalFilename,
        mimeType,
        size: buffer.length,
        sizeHuman: formatBytes(buffer.length),
      };
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'EEXIST') {
        counter++;
        const dotIdx = filename.lastIndexOf('.');
        if (dotIdx > 0) {
          const base = filename.slice(0, dotIdx);
          const ext = filename.slice(dotIdx);
          finalFilename = `${base}-${counter}${ext}`;
        } else {
          finalFilename = `${filename}-${counter}`;
        }
        filePath = join(downloadsDir, finalFilename);
      } else {
        return {
          type: 'file_download_error',
          error: `Failed to save file: ${error.message}`,
        };
      }
    }
  }

  return {
    type: 'file_download_error',
    error: `Failed to save file after ${maxAttempts} attempts - too many collisions`,
  };
}
