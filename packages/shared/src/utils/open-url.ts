/**
 * 用系统默认浏览器打开 URL
 *
 * 优先使用 Electron 的 shell.openExternal()，它调用原生 OS API，在打包应用中更可靠（不依赖 PATH）。
 * 非 Electron 环境回退到 'open' npm 包。
 *
 * 注意：'open' 包会 spawn `open`（macOS）/ `xdg-open`（Linux）子进程，在某些打包后的 Electron
 * 构建中可能因为 PATH 被剥离而失败（spawn open ENOENT）。
 *
 * 始终使用本函数，而不是直接 import 'open'。
 *
 * @param url - 要在默认浏览器中打开的 URL
 */
export async function openUrl(url: string): Promise<void> {
  // 优先走 Electron 原生 API：无子进程、无 PATH 问题
  try {
    const { shell } = await import('electron');
    await shell.openExternal(url);
    return;
  } catch {
    // 不在 Electron 主进程，回退到 'open' 包
  }

  const open = await import('open');
  const openFn = open.default || open;
  await openFn(url);
}
