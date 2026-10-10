import { writeFile } from 'node:fs/promises'
import type { ElectronApplication, Page } from '@playwright/test'
import type { LaunchedSotto } from './sottoLaunch'

/** Electron's composited content frame, including embedded guests at their actual scale. */
export async function captureWindow(application: ElectronApplication, path: string): Promise<void> {
  const png = await application.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))
    if (!window) throw new Error('No main window to capture.')
    return (await window.webContents.capturePage()).toPNG().toString('base64')
  })
  await writeFile(path, Buffer.from(png, 'base64'))
}

export type SottoCaptureOptions =
  | { mode: 'dom'; screenshot?: Omit<Parameters<Page['screenshot']>[0], 'path'> }
  | { mode: 'composited' }
  | { mode: 'native-window'; title: string; retries?: number; retryDelayMs?: number }
  | { mode: 'desktop-cropped'; settleMs?: number }

/** Callers supply an evidence path; this helper never chooses a committed artifact folder. */
export async function captureSotto(launched: LaunchedSotto, path: string, options: SottoCaptureOptions): Promise<void> {
  if (options.mode === 'dom') { await launched.page.screenshot({ ...options.screenshot, path }); return }
  if (options.mode === 'composited') { await captureWindow(launched.app, path); return }
  const png = options.mode === 'native-window'
    ? await launched.app.evaluate(async ({ BrowserWindow, desktopCapturer, screen }, settings) => {
      const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
      window.setTitle(settings.title); window.show()
      const bounds = window.getBounds(), scale = screen.getDisplayMatching(bounds).scaleFactor
      for (let attempt = 0; ; attempt++) {
        const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: Math.round(bounds.width * scale), height: Math.round(bounds.height * scale) } })
        const source = sources.find(item => item.name === settings.title)
        if (source) return source.thumbnail.toPNG().toString('base64')
        if (attempt >= settings.retries) throw new Error('Native window capture unavailable')
        await new Promise(resolve => setTimeout(resolve, settings.retryDelayMs))
      }
    }, { title: options.title, retries: options.retries ?? 9, retryDelayMs: options.retryDelayMs ?? 500 })
    : await launched.app.evaluate(async ({ BrowserWindow, desktopCapturer, screen }, settleMs) => {
      const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
      const onTop = window.isAlwaysOnTop()
      window.setAlwaysOnTop(true, 'screen-saver'); window.moveTop(); window.focus()
      try {
        await new Promise(resolve => setTimeout(resolve, settleMs))
        const bounds = window.getBounds(), display = screen.getDisplayMatching(bounds), scale = display.scaleFactor
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(display.bounds.width * scale), height: Math.round(display.bounds.height * scale) } })
        const source = sources.find(item => item.display_id === String(display.id)) ?? sources[0]!
        return source.thumbnail.crop({ x: Math.round((bounds.x - display.bounds.x) * scale), y: Math.round((bounds.y - display.bounds.y) * scale),
          width: Math.round(bounds.width * scale), height: Math.round(bounds.height * scale) }).toPNG().toString('base64')
      } finally { window.setAlwaysOnTop(onTop) }
    }, options.settleMs ?? 800)
  await writeFile(path, Buffer.from(png, 'base64'))
}
