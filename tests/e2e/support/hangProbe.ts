import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { errors, test, type Locator } from '@playwright/test'
import type { LaunchedSotto } from './sottoLaunch'

/** How long each check is given before it is recorded as unanswered, so a hung app cannot spend the test's deadline. */
const CHECK_MS = 5_000
const SCREENSHOT_MS = 15_000

type Checked<T> = { readonly answer: T; readonly ms: number } | { readonly threw: string; readonly ms: number } | { readonly unanswered: true; readonly ms: number }

async function within<T>(work: () => Promise<T>, limitMs = CHECK_MS): Promise<Checked<T>> {
  const started = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<Checked<T>>(resolve => { timer = setTimeout(() => resolve({ unanswered: true, ms: Date.now() - started }), limitMs) })
  const answered = work().then(answer => ({ answer, ms: Date.now() - started }), (failed: unknown) => ({ threw: String(failed).slice(0, 300), ms: Date.now() - started }))
  try { return await Promise.race([answered, late]) } finally { clearTimeout(timer) }
}

/** The whole Windows desktop as a PNG, taken by the OS rather than through the app, so it works while the app does not answer. */
async function desktopScreenshot(): Promise<Buffer | string> {
  if (process.platform !== 'win32') return `no desktop screenshot on ${process.platform}`
  const folder = await mkdtemp(join(tmpdir(), 'sotto-hang-'))
  const path = join(folder, 'desktop.png')
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
    '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    '$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)',
    `$bmp.Save('${path.replace(/'/gu, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
  ].join('; ')
  try {
    await new Promise<void>((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: SCREENSHOT_MS, windowsHide: true }, failed => { if (failed) reject(failed); else resolve() })
    })
    return await readFile(path)
  } catch (failed) {
    return `desktop screenshot failed: ${String(failed).slice(0, 300)}`
  } finally { await rm(folder, { recursive: true, force: true }) }
}

/**
 * Clicks `target`, and only when the click times out records why before failing as it would have (#2051): whether
 * main and the renderer each still answer, every Electron process's CPU, and the OS's picture of the desktop, all
 * attached to the test result. A click that works costs nothing more, with no extra round trip before it that could
 * hide a race.
 */
export async function clickOrProbeHang(launched: LaunchedSotto, target: Locator, options?: Parameters<Locator['click']>[0]): Promise<void> {
  try {
    await target.click(options)
  } catch (error: unknown) {
    if (!(error instanceof errors.TimeoutError)) throw error
    const info = test.info()
    const page = target.page()
    const [main, renderer, rendererFreshSession, desktop] = await Promise.all([
      // Main's own answer, through Node's inspector: its windows, and CPU over one second, since the first reading of
      // getAppMetrics() has nothing to compare against.
      within(() => launched.app.evaluate(async ({ app, BrowserWindow }) => {
        const tick = Date.now()
        await new Promise(resolve => setTimeout(resolve, 0))
        const loopDelayMs = Date.now() - tick
        app.getAppMetrics()
        await new Promise(resolve => setTimeout(resolve, 1_000))
        return {
          loopDelayMs,
          windows: BrowserWindow.getAllWindows().map(window => ({
            id: window.id, visible: window.isVisible(), focused: window.isFocused(), minimized: window.isMinimized(),
            crashed: window.webContents.isCrashed(), loading: window.webContents.isLoading(), rendererPid: window.webContents.getOSProcessId(),
          })),
          processes: app.getAppMetrics().map(metric => ({ type: metric.type, pid: metric.pid, cpuPercent: metric.cpu.percentCPUUsage, idleWakeupsPerSecond: metric.cpu.idleWakeupsPerSecond, workingSetKb: metric.memory.workingSetSize })),
        }
      })),
      // The page's own answer, through the session the click was sent on.
      within(() => page.evaluate(() => ({
        openDialogs: document.querySelectorAll('dialog[open]').length,
        active: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? null,
        hidden: document.hidden, focused: document.hasFocus(),
      }))),
      // The page again through a CDP session of its own, so a session stuck behind the click's input cannot pass for a
      // renderer that does not answer.
      within(async () => {
        const session = await page.context().newCDPSession(page)
        try { return await session.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true, timeout: CHECK_MS }) } finally { await session.detach().catch(() => undefined) }
      }),
      desktopScreenshot(),
    ])
    // Written into the test's own output folder, which CI uploads with the job's artifact, and attached from there.
    const report = info.outputPath('hang-probe.json')
    await writeFile(report, JSON.stringify({ target: String(target), main, renderer, rendererFreshSession }, null, 2))
    await info.attach('hang-probe.json', { contentType: 'application/json', path: report })
    const picture = info.outputPath(typeof desktop === 'string' ? 'hang-probe-desktop.txt' : 'hang-probe-desktop.png')
    await writeFile(picture, desktop)
    await info.attach(typeof desktop === 'string' ? 'hang-probe-desktop.txt' : 'hang-probe-desktop.png', { contentType: typeof desktop === 'string' ? 'text/plain' : 'image/png', path: picture })
    throw error
  }
}
