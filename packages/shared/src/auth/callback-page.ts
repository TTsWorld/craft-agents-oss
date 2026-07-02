/**
 * OAuth 回调页面 HTML 生成器
 *
 * 这个模块是浏览器安全的（没有 Node.js 依赖），既可以在回调服务器里用，
 * 也可以在 playground 预览里用。
 */

import { CRAFT_LOGO_HTML } from '../branding.ts';

/** 回调页面所属应用类型，决定样式细节 */
export type AppType = 'terminal' | 'electron';

/**
 * 生成简洁的 OAuth 回调页面，和 Craft 应用的设计系统保持一致。
 * 顶部是 Logo，下面是状态卡片。
 *
 * @param options.title - 页面标题（会拼到 <title> 里）
 * @param options.isSuccess - 是否成功
 * @param options.errorDetail - 失败时的错误详情
 * @param options.appType - 应用类型
 * @param options.deeplinkUrl - 成功时要跳转的 deeplink
 */
export function generateCallbackPage(options: {
  title: string;
  isSuccess: boolean;
  errorDetail?: string;
  appType?: AppType;
  deeplinkUrl?: string;
}): string {
  const { title, isSuccess, errorDetail, deeplinkUrl } = options;

  // 根据成功/失败生成状态文案
  const statusMessage = isSuccess
    ? 'Authorization successful'
    : errorDetail
      ? `Authorization failed: ${errorDetail}`
      : 'Authorization failed';

  // 成功时 1.5 秒后自动跳转 deeplink 并关闭窗口
  const autoCloseScript = isSuccess
    ? `
    setTimeout(() => {
      ${deeplinkUrl ? `window.location.href = '${deeplinkUrl}';` : ''}
      window.close();
    }, 1500);`
    : '';


  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Craft - ${title}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      width: 100vw;
      height: 100vh;
      /* 背景色：前景色 2% 混合背景 */
      background-color: #f7f7f7;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }

    .logo {
      /* 紫色强调色：oklch(0.62 0.13 293) */
      color: #8b5fb3;
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace;
      font-size: 6px;
      line-height: 1;
      white-space: pre;
      /* 负字距，让方块字符之间没有缝隙 */
      letter-spacing: -0.05em;
      /* 卡片上方留 48px */
      margin-bottom: 48px;
    }

    .content {
      display: flex;
      flex-direction: column;
      align-items: center;
    }

    .card {
      max-width: 480px;
      border-radius: 8px;
      padding: 16px 24px;
      text-align: center;
      /* 根据状态着色背景和阴影 */
      ${isSuccess
        ? `/* 成功态 - 绿色微调 */
      background-color: rgba(34, 120, 60, 0.03);
      box-shadow:
        rgba(34, 120, 60, 0.12) 0px 0px 0px 1px,
        rgba(34, 120, 60, 0.08) 0px 1px 1px -0.5px,
        rgba(34, 120, 60, 0.06) 0px 3px 3px -1.5px,
        rgba(34, 120, 60, 0.04) 0px 6px 6px -3px;`
        : `/* 失败态 - 红色微调 */
      background-color: rgba(180, 60, 50, 0.03);
      box-shadow:
        rgba(180, 60, 50, 0.12) 0px 0px 0px 1px,
        rgba(180, 60, 50, 0.08) 0px 1px 1px -0.5px,
        rgba(180, 60, 50, 0.06) 0px 3px 3px -1.5px,
        rgba(180, 60, 50, 0.04) 0px 6px 6px -3px;`
      }
    }

    .status {
      font-size: 14px;
      font-weight: 400;
      /* 文字颜色混入 50% 前景色以提高可读性 */
      color: ${isSuccess ? '#2d6b47' : '#a14040'};
    }

    .hint {
      margin-top: 24px;
      font-size: 13px;
      color: rgba(0, 0, 0, 0.4);
    }

    .return-link {
      display: inline-block;
      margin-top: 16px;
      padding: 10px 20px;
      font-size: 14px;
      font-weight: 500;
      color: #fff;
      background-color: #8b5fb3;
      border-radius: 6px;
      text-decoration: none;
      transition: background-color 0.15s ease;
    }

    .return-link:hover {
      background-color: #7a4fa3;
    }

    @media (prefers-color-scheme: dark) {
      body {
        background-color: #1a1a1a;
      }
      .logo {
        /* 暗模式下更亮的紫色：oklch(0.68 0.13 293) */
        color: #a882c9;
      }
      .card {
        ${isSuccess
          ? `/* 成功态暗色 - 绿色微调 */
        background-color: rgba(50, 140, 80, 0.03);
        box-shadow:
          rgba(50, 140, 80, 0.12) 0px 0px 0px 1px,
          rgba(50, 140, 80, 0.08) 0px 1px 1px -0.5px,
          rgba(50, 140, 80, 0.06) 0px 3px 3px -1.5px,
          rgba(50, 140, 80, 0.04) 0px 6px 6px -3px;`
          : `/* 失败态暗色 - 红色微调 */
        background-color: rgba(200, 80, 70, 0.03);
        box-shadow:
          rgba(200, 80, 70, 0.12) 0px 0px 0px 1px,
          rgba(200, 80, 70, 0.08) 0px 1px 1px -0.5px,
          rgba(200, 80, 70, 0.06) 0px 3px 3px -1.5px,
          rgba(200, 80, 70, 0.04) 0px 6px 6px -3px;`
        }
      }
      .status {
        /* 暗模式下更亮的文字 */
        color: ${isSuccess ? '#6bc489' : '#e88080'};
      }
      .hint {
        color: rgba(255, 255, 255, 0.4);
      }
    }
  </style>
</head>
<body>
  <div class="content">
    <pre class="logo">${CRAFT_LOGO_HTML}</pre>
    <div class="card">
      <div class="status">${statusMessage}</div>
    </div>
    <div class="hint">${isSuccess ? 'You can now return to the application.' : 'Please close this window and try again.'}</div>
    ${deeplinkUrl ? `<a href="${deeplinkUrl}" class="return-link">Craft Agents</a>` : ''}
  </div>
  <script>${autoCloseScript}</script>
</body>
</html>`;
}
