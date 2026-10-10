import { expect } from '@playwright/test'
import type { LaunchedSotto } from './sottoLaunch'

/** Outer size, preserving sottoLaunch's existing width assertion and display-scaling tolerance. */
export async function resizeWindow(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
    window.setSize(size.width, size.height)
  }, { width, height })
  await expect.poll(async () => Math.abs(await launched.page.evaluate(() => innerWidth) - width)).toBeLessThanOrEqual(2)
}

/** Content size is a different contract. Only change the minimum when the caller explicitly asks. */
export async function resizeContentWindow(launched: LaunchedSotto, width: number, height: number,
  minimum?: readonly [number, number]): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
    if (size.minimum) window.setMinimumSize(...size.minimum)
    window.setContentSize(size.width, size.height)
  }, { width, height, minimum })
  await expect.poll(() => launched.page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width, height })
}
