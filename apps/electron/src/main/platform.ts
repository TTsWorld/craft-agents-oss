/**
 * platform.ts —— Electron 平台服务工厂。
 *
 * 用 Electron 原生 API 构造 PlatformServices，供 bootstrapServer() 注入。
 * 这样 server-core 里与平台无关的代码可以通过 PlatformServices 接口调用系统能力，
 * 类似 Go 里通过 interface 把平台差异抽象出去。
 */

import type { PlatformServices } from '../runtime/platform'

// 构造 PlatformServices 所需的 Electron 原生对象
export interface ElectronPlatformOptions {
  app: Electron.App
  nativeImage: typeof import('electron').nativeImage
  shell: typeof import('electron').shell
  nativeTheme: typeof import('electron').nativeTheme
  logger: PlatformServices['logger']
  isDebugMode: boolean
  getLogFilePath?: () => string | undefined
  captureError?: (error: Error) => void
}

/**
 * 创建 Electron 平台服务实例。
 *
 * 返回的 PlatformServices 包含：打开外部链接、打开文件路径、显示文件、退出应用、
 * 获取系统主题、处理图片、写日志等能力。
 */
export function createElectronPlatform(opts: ElectronPlatformOptions): PlatformServices {
  const { app, nativeImage, shell, nativeTheme, logger } = opts

  return {
    appRootPath: app.isPackaged ? app.getAppPath() : process.cwd(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
    appVersion: app.getVersion(),
    openExternal: (url) => shell.openExternal(url),
    openPath: (p) => shell.openPath(p).then(() => {}),
    showItemInFolder: (p) => shell.showItemInFolder(p),
    quit: () => app.quit(),
    systemDarkMode: () => nativeTheme.shouldUseDarkColors,
    imageProcessor: {
      async getMetadata(buffer) {
        const img = nativeImage.createFromBuffer(buffer)
        if (img.isEmpty()) return null
        const { width, height } = img.getSize()
        return (width && height) ? { width, height } : null
      },
      async process(input, processOpts = {}) {
        const img = typeof input === 'string'
          ? nativeImage.createFromPath(input)
          : nativeImage.createFromBuffer(input)
        if (img.isEmpty()) throw new Error('Invalid image input')

        let result = img
        if (processOpts.resize) {
          const { width: tw, height: th } = processOpts.resize
          const fit = processOpts.fit ?? 'inside'
          if (fit === 'inside') {
            const { width: sw, height: sh } = result.getSize()
            const scale = Math.min(tw / sw, th / sh, 1)
            result = result.resize({
              width: Math.round(sw * scale),
              height: Math.round(sh * scale),
            })
          } else {
            result = result.resize({ width: tw, height: th })
          }
        }
        return (processOpts.format === 'jpeg')
          ? result.toJPEG(processOpts.quality ?? 90)
          : result.toPNG()
      },
    },
    logger,
    isDebugMode: opts.isDebugMode,
    getLogFilePath: opts.getLogFilePath,
    captureError: opts.captureError,
  }
}
