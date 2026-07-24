import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { expect, test, type ElectronApplication, type Page } from '@playwright/test'

import {
  E2E_CONFLICTING_HOTKEY,
  type E2ESnapshot,
  type SottoE2EBridge,
} from '../../src/shared/e2e'
import { DETERMINISTIC_TRANSCRIPT, PRESERVED_CLIPBOARD_TEXT } from '../fixtures/fakeTranscription'
import { closeSotto, e2eEnvironment, launchSotto } from './support/sottoLaunch'

async function reachFinalOnboardingStep(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: /test microphone/i }).click()
  await expect(page.getByText(/microphone ready/i)).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText(/balanced model is included and ready/i)).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()
}

async function finishOnboarding(page: Page): Promise<void> {
  await page.getByRole('button', { name: /finish setup/i }).click()
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible()
}

async function completeOnboarding(page: Page): Promise<void> {
  await reachFinalOnboardingStep(page)
  await finishOnboarding(page)
}

async function dictateWithButton(page: Page): Promise<void> {
  await page.getByRole('button', { name: /start dictation/i }).click()
  await page.getByRole('button', { name: /stop and transcribe/i }).click()
}

async function snapshot(page: Page): Promise<E2ESnapshot> {
  const value = await page.evaluate(() =>
    (globalThis as unknown as { sottoE2E?: SottoE2EBridge }).sottoE2E?.snapshot(),
  )
  if (value === undefined) throw new Error('E2E bridge unavailable')
  return value
}

interface NativeRectangle {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

interface NativeWidgetGeometry {
  readonly contentBounds: NativeRectangle
  readonly workArea: NativeRectangle
}

async function nativeWidgetGeometry(
  app: ElectronApplication,
): Promise<NativeWidgetGeometry | null> {
  return app.evaluate(({ BrowserWindow, screen }) => {
    const widget = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().endsWith('/widget.html'),
    )
    if (widget === undefined) return null
    const bounds = widget.getBounds()
    const workArea = screen.getDisplayNearestPoint({
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    }).workArea
    return { contentBounds: widget.getContentBounds(), workArea }
  })
}

async function sampleNativeWidgetContentBounds(
  app: ElectronApplication,
): Promise<readonly NativeRectangle[]> {
  return app.evaluate(async ({ BrowserWindow }) => {
    const widget = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().endsWith('/widget.html'),
    )
    if (widget === undefined) return []
    const samples = []
    for (let index = 0; index < 40; index += 1) {
      samples.push(widget.getContentBounds())
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return samples
  })
}

async function nativeWidgetVisible(app: ElectronApplication): Promise<boolean | null> {
  return app.evaluate(({ BrowserWindow }) => {
    const widget = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().endsWith('/widget.html'),
    )
    return widget?.isVisible() ?? null
  })
}

async function triggerShortcut(page: Page): Promise<void> {
  await page.evaluate(() =>
    (globalThis as unknown as { sottoE2E?: SottoE2EBridge }).sottoE2E?.triggerShortcut(),
  )
}

test('onboards, dictates through the registered shortcut, pastes, and records local history', async () => {
  const launched = await launchSotto()
  try {
    await reachFinalOnboardingStep(launched.page)
    const pasteTarget = launched.page.getByLabel('Paste test')
    await pasteTarget.focus()

    await triggerShortcut(launched.page)
    const widget = launched.app.windows().find((candidate) => candidate.url().endsWith('/widget.html'))
    if (widget === undefined) throw new Error('Widget window unavailable')
    await expect(widget.locator('.widget-shell[data-status="listening"]')).toBeVisible()
    await triggerShortcut(launched.page)

    await expect(pasteTarget).toHaveValue(DETERMINISTIC_TRANSCRIPT)
    await expect(widget.getByText('Pasted', { exact: true })).toBeVisible()
    await expect.poll(() => snapshot(launched.page)).toMatchObject({
      clipboardText: DETERMINISTIC_TRANSCRIPT,
      pasteAttempts: 1,
    })

    await finishOnboarding(launched.page)
    await launched.page.getByRole('link', { name: 'History' }).click()
    await expect(launched.page.getByText(DETERMINISTIC_TRANSCRIPT)).toBeVisible()
  } finally {
    await closeSotto(launched)
  }
})

test('keeps history disabled without blocking private dictation', async () => {
  const launched = await launchSotto('history-disabled')
  try {
    await completeOnboarding(launched.page)
    await launched.page.getByRole('link', { name: 'Settings' }).click()
    await launched.page.getByRole('switch', { name: 'Keep local history' }).click()
    await expect(launched.page.getByText('Setting saved.')).toBeVisible()
    await launched.page.getByRole('link', { name: 'Home' }).click()
    await dictateWithButton(launched.page)
    await expect(launched.page.getByRole('heading', { name: 'Text pasted' })).toBeVisible()
    await launched.page.getByRole('link', { name: 'History' }).click()
    await expect(launched.page.getByRole('heading', { name: 'History is turned off' })).toBeVisible()
  } finally {
    await closeSotto(launched)
  }
})

test('persists the dark theme across a renderer reload', async () => {
  const launched = await launchSotto()
  try {
    await completeOnboarding(launched.page)
    await launched.page.getByRole('link', { name: 'Settings' }).click()
    await launched.page.getByLabel('Theme').selectOption('dark')
    await expect.poll(() => launched.page.locator('html').getAttribute('data-theme')).toBe('dark')
    await launched.page.reload()
    await expect(launched.page.getByRole('heading', { name: 'Home' })).toBeVisible()
    await expect(launched.page.locator('html')).toHaveAttribute('data-theme', 'dark')
  } finally {
    await closeSotto(launched)
  }
})

test('reports a hotkey conflict and preserves the previous shortcut', async () => {
  const launched = await launchSotto('hotkey-conflict')
  try {
    await completeOnboarding(launched.page)
    await launched.page.getByRole('link', { name: 'Settings' }).click()
    const shortcut = launched.page.getByLabel('Global shortcut')
    const previous = await shortcut.inputValue()
    await shortcut.fill(E2E_CONFLICTING_HOTKEY)
    await launched.page.getByRole('button', { name: 'Apply shortcut' }).click()
    await expect(launched.page.getByRole('alert')).toContainText(/another application is already using/i)
    await expect(shortcut).toHaveValue(previous)

    await triggerShortcut(launched.page)
    const widget = launched.app.windows().find((candidate) => candidate.url().endsWith('/widget.html'))
    if (widget === undefined) throw new Error('Widget window unavailable')
    await expect(widget.locator('.widget-shell[data-status="listening"]')).toBeVisible()
    await triggerShortcut(launched.page)
    await expect(widget.getByText('Pasted', { exact: true })).toBeVisible()
  } finally {
    await closeSotto(launched)
  }
})

test('recovers after microphone permission is denied once', async () => {
  const launched = await launchSotto('microphone-denied-once')
  try {
    await launched.page.getByRole('button', { name: 'Continue' }).click()
    await launched.page.getByRole('button', { name: /test microphone/i }).click()
    await expect(launched.page.getByText('Microphone access is blocked.')).toBeVisible()
    await expect(launched.page.getByText(/privacy & security.*microphone/i)).toBeVisible()
    await launched.page.getByRole('button', { name: /try microphone again/i }).click()
    await expect(launched.page.getByText(/microphone ready/i)).toBeVisible()
  } finally {
    await closeSotto(launched)
  }
})

test('silence preserves the clipboard and creates no history', async () => {
  const launched = await launchSotto('silence')
  try {
    await completeOnboarding(launched.page)
    expect(await snapshot(launched.page)).toMatchObject({
      clipboardText: PRESERVED_CLIPBOARD_TEXT,
      pasteAttempts: 0,
    })
    await dictateWithButton(launched.page)
    await expect(launched.page.getByRole('alert')).toContainText(/no speech was detected/i)
    expect(await snapshot(launched.page)).toMatchObject({
      clipboardText: PRESERVED_CLIPBOARD_TEXT,
      pasteAttempts: 0,
    })
    await launched.page.getByRole('link', { name: 'History' }).click()
    await expect(launched.page.getByRole('heading', { name: 'No saved transcripts yet' })).toBeVisible()
  } finally {
    await closeSotto(launched)
  }
})

test('paste rejection falls back to a durable copied result', async () => {
  const launched = await launchSotto('paste-failure')
  try {
    await completeOnboarding(launched.page)
    await dictateWithButton(launched.page)
    await expect(launched.page.getByRole('heading', { name: 'Text copied' })).toBeVisible()
    expect(await snapshot(launched.page)).toMatchObject({
      clipboardText: DETERMINISTIC_TRANSCRIPT,
      pasteAttempts: 1,
    })
  } finally {
    await closeSotto(launched)
  }
})

test('persists settings through reload', async () => {
  const launched = await launchSotto()
  try {
    await completeOnboarding(launched.page)
    await launched.page.getByRole('link', { name: 'Settings' }).click()
    const delay = launched.page.getByLabel('Paste delay')
    await delay.fill('275')
    await launched.page.getByRole('button', { name: 'Save paste delay' }).click()
    await expect(launched.page.getByText('Paste delay saved.')).toBeVisible()
    await launched.page.reload()
    await launched.page.getByRole('link', { name: 'Settings' }).click()
    await expect(launched.page.getByLabel('Paste delay')).toHaveValue('275')
  } finally {
    await closeSotto(launched)
  }
})

test('keeps the real main window frameless with one title bar before and after onboarding', async () => {
  const launched = await launchSotto()
  try {
    const geometry = await launched.app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().endsWith('/index.html'),
      )
      if (main === undefined) return null
      return {
        bounds: main.getBounds(),
        contentBounds: main.getContentBounds(),
      }
    })

    expect(geometry).not.toBeNull()
    expect(geometry?.contentBounds).toEqual(geometry?.bounds)
    expect(await launched.page.locator('.app-titlebar').count()).toBe(1)

    await completeOnboarding(launched.page)

    expect(await launched.page.locator('.app-titlebar').count()).toBe(1)
  } finally {
    await closeSotto(launched)
  }
})

test('keeps onboarding Continue reachable and clickable at the supported 820x560 minimum', async () => {
  const launched = await launchSotto()
  try {
    await expect(
      launched.page.getByRole('heading', { name: /private dictation/i }),
    ).toBeVisible()
    await launched.app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().endsWith('/index.html'),
      )
      if (main === undefined) throw new Error('Main window unavailable')
      main.setBounds({ ...main.getBounds(), width: 820, height: 560 }, false)
    })
    await expect.poll(() => launched.page.evaluate(() =>
      (globalThis as unknown as { readonly innerWidth: number }).innerWidth,
    )).toBe(820)
    await expect.poll(() => launched.app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().endsWith('/index.html'),
      )
      return main?.getMinimumSize() ?? null
    })).toEqual([820, 560])

    const continueButton = launched.page.getByRole('button', { name: 'Continue' })
    const access = await continueButton.evaluate((button) => {
      const shell = button.closest('.onboarding-shell')
      if (shell === null) return null
      const buttonInsideViewport = (): boolean => {
        const bounds = button.getBoundingClientRect()
        const viewportHeight = (
          globalThis as unknown as { readonly innerHeight: number }
        ).innerHeight
        return bounds.top >= 0 && bounds.bottom <= viewportHeight
      }
      const initiallyVisible = buttonInsideViewport()
      shell.scrollTop = shell.scrollHeight
      return {
        initiallyVisible,
        clientHeight: shell.clientHeight,
        scrollHeight: shell.scrollHeight,
        scrollTop: shell.scrollTop,
        visibleAfterScroll: buttonInsideViewport(),
      }
    })

    expect(access).not.toBeNull()
    expect(
      access!.initiallyVisible || (
        access!.scrollHeight > access!.clientHeight &&
        access!.scrollTop > 0 &&
        access!.visibleAfterScroll
      ),
    ).toBe(true)

    await continueButton.click()
    await expect(
      launched.page.getByRole('heading', { name: /check your microphone/i }),
    ).toBeVisible()
  } finally {
    await closeSotto(launched)
  }
})

test('uses stable content-sized native widget bounds for bottom-edge presentations', async () => {
  const launched = await launchSotto()
  const expectedGeometry = async (width: number) => {
    const geometry = await nativeWidgetGeometry(launched.app)
    if (geometry === null) return null
    return {
      width: geometry.contentBounds.width,
      height: geometry.contentBounds.height,
      centeredOffset: geometry.contentBounds.x - (
        geometry.workArea.x + Math.round((geometry.workArea.width - width) / 2)
      ),
      bottomInset: geometry.workArea.y + geometry.workArea.height - (
        geometry.contentBounds.y + geometry.contentBounds.height
      ),
    }
  }

  try {
    await completeOnboarding(launched.page)
    const widget = launched.app.windows().find((candidate) =>
      candidate.url().endsWith('/widget.html'),
    )
    if (widget === undefined) throw new Error('Widget window unavailable')
    const sliver = widget.getByTestId('widget-sliver')
    await expect(sliver).toBeVisible()

    await expect.poll(() => expectedGeometry(124)).toEqual({
      width: 124,
      height: 54,
      centeredOffset: 0,
      bottomInset: 16,
    })

    await sliver.hover()
    await expect.poll(() => expectedGeometry(248)).toEqual({
      width: 248,
      height: 76,
      centeredOffset: 0,
      bottomInset: 16,
    })
    const hoveredSamples = await sampleNativeWidgetContentBounds(launched.app)
    expect(hoveredSamples).toHaveLength(40)
    expect(hoveredSamples.every(({ width, height }) => width === 248 && height === 76)).toBe(true)

    await triggerShortcut(launched.page)
    await expect(widget.locator('.widget-shell[data-status="listening"]')).toBeVisible()
    await expect.poll(() => expectedGeometry(248)).toEqual({
      width: 248,
      height: 88,
      centeredOffset: 0,
      bottomInset: 16,
    })
  } finally {
    await closeSotto(launched)
  }
})

test('hiding the idle widget terminates its renderer drag before the next reveal', async () => {
  const launched = await launchSotto()
  try {
    await completeOnboarding(launched.page)
    const widget = launched.app.windows().find((candidate) =>
      candidate.url().endsWith('/widget.html'),
    )
    if (widget === undefined) throw new Error('Widget window unavailable')
    const sliver = widget.getByTestId('widget-sliver')
    await expect(sliver).toBeVisible()

    await sliver.dispatchEvent('pointerdown', {
      pointerId: 17, button: 0, isPrimary: true, screenX: 50, screenY: 60,
    })
    await sliver.dispatchEvent('pointermove', {
      pointerId: 17, button: 0, isPrimary: true, screenX: 80, screenY: 60,
    })
    await expect(widget.locator('.widget-shell')).toHaveAttribute('data-dragging', 'true')

    await launched.page.getByRole('link', { name: 'Settings' }).click()
    const idleWidgetToggle = launched.page.getByRole('switch', {
      name: 'Show floating widget when idle',
    })
    await idleWidgetToggle.click()
    await expect.poll(() => nativeWidgetVisible(launched.app)).toBe(false)
    await expect(widget.locator('.widget-shell')).not.toHaveAttribute('data-dragging', 'true')

    await idleWidgetToggle.click()
    await expect.poll(() => nativeWidgetVisible(launched.app)).toBe(true)
    await expect(widget.locator('.widget-shell')).not.toHaveAttribute('data-dragging', 'true')
  } finally {
    await closeSotto(launched)
  }
})

test('closing the main window hides it to the tray without quitting', async () => {
  const launched = await launchSotto()
  try {
    await completeOnboarding(launched.page)
    await launched.page.getByRole('button', { name: 'Close Sotto to tray' }).click()
    await expect.poll(async () => (await snapshot(launched.page)).mainVisible).toBe(false)
    expect(launched.app.process().exitCode).toBeNull()
  } finally {
    await closeSotto(launched)
  }
})

test('a second instance reveals the existing hidden window', async () => {
  const launched = await launchSotto()
  try {
    await completeOnboarding(launched.page)
    await launched.page.getByRole('button', { name: 'Close Sotto to tray' }).click()
    await expect.poll(async () => (await snapshot(launched.page)).mainVisible).toBe(false)

    const electronExecutable = createRequire(join(process.cwd(), 'package.json'))('electron') as string
    const second = spawn(electronExecutable, ['out/main/index.js'], {
      cwd: process.cwd(),
      env: e2eEnvironment('success', launched.userData),
      stdio: 'ignore',
      windowsHide: true,
    })
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { second.kill(); reject(new Error('Second instance did not exit')) }, 10_000)
      second.once('error', (error) => { clearTimeout(timeout); reject(error) })
      second.once('exit', () => { clearTimeout(timeout); resolve() })
    })
    await expect.poll(async () => (await snapshot(launched.page)).mainVisible).toBe(true)
  } finally {
    await closeSotto(launched)
  }
})

test('transcription failure is finite and leaves clipboard and history untouched', async () => {
  const launched = await launchSotto('transcription-failure')
  try {
    await completeOnboarding(launched.page)
    await dictateWithButton(launched.page)
    await expect(launched.page.getByRole('alert')).toContainText(/could not transcribe/i)
    expect(await snapshot(launched.page)).toMatchObject({
      clipboardText: PRESERVED_CLIPBOARD_TEXT,
      pasteAttempts: 0,
    })
    await launched.page.getByRole('link', { name: 'History' }).click()
    await expect(launched.page.getByRole('heading', { name: 'No saved transcripts yet' })).toBeVisible()
  } finally {
    await closeSotto(launched)
  }
})
