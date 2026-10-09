import { join } from 'node:path'
import { evidenceDirectory } from '../fixtures/evidence'
import { mkdir } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto, openPage, openThreads, resizeWindow } from './support/sottoLaunch'

test('Settings effort stays a slider and new work uses the saved defaults', async () => {
  test.setTimeout(120_000)
  const launched = await launchSotto()
  const { page } = launched
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload()
    await openPage(page, 'Settings')
    await page.getByRole('tab', { name: 'Agents', exact: true }).click()
    const chip = page.getByRole('combobox', { name: 'Thread reasoning', exact: true })
    await chip.click()
    const slider = page.getByRole('slider', { name: 'Thread reasoning effort' })
    await expect(slider).toBeVisible()
    await mkdir(evidenceDirectory('artifacts/new-thread-defaults'), { recursive: true })
    await page.screenshot({ path: join(evidenceDirectory('artifacts/new-thread-defaults'), 'settings-current.png') })
    expect(await slider.evaluate(node => {
      const style = getComputedStyle(node)
      return { background: style.backgroundColor, border: style.borderTopWidth, padding: style.paddingTop, height: node.getBoundingClientRect().height }
    })).toEqual({ background: 'rgba(0, 0, 0, 0)', border: '0px', padding: '0px', height: 30 })
    await slider.press('End')
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.agents!.get()).configuration.newThreadReasoningEffort)).toBe('max')
    await expect(chip).toHaveText(/Max/)
    await slider.click({ position: { x: 13, y: 15 } })
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.agents!.get()).configuration.newThreadReasoningEffort)).toBe('low')
    await slider.press('End')
    await expect(chip).toHaveText(/Max/)
    const bounds = await slider.boundingBox()
    await page.mouse.move(bounds!.x + bounds!.width - 13, bounds!.y + bounds!.height / 2)
    await page.mouse.down()
    await page.mouse.move(bounds!.x + 13, bounds!.y + bounds!.height / 2, { steps: 12 })
    await expect.poll(async () => Number(await slider.inputValue())).toBeLessThan(.1)
    await page.mouse.up()
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.agents!.get()).configuration.newThreadReasoningEffort)).toBe('low')
    await slider.press('3')
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.agents!.get()).configuration.newThreadReasoningEffort)).toBe('high')
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), appearance)
      for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]]) {
        await resizeWindow(launched, width!, height!)
        await expect(slider).toBeInViewport()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.screenshot({ path: join(evidenceDirectory('artifacts/new-thread-defaults'), `settings-${appearance}-${width}.png`), animations: 'disabled' })
      }
    }
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await slider.press('End')
    await expect(chip).toHaveText(/Max/)
    expect(await page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running' && animation.effect?.getTiming().iterations === Infinity).length)).toBe(0)
    await page.screenshot({ path: join(evidenceDirectory('artifacts/new-thread-defaults'), 'settings-reduced-motion.png'), animations: 'disabled' })
    await slider.press('3')
    await expect(chip).toHaveText(/High/)
    await slider.press('Escape')
    await expect(chip).toBeFocused()
    await page.reload()
    await openPage(page, 'Settings')
    await page.getByRole('tab', { name: 'Agents', exact: true }).click()
    await expect(chip).toHaveText(/High/)
    await openThreads(page)
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    await sidebar.getByRole('button', { name: 'New thread', exact: true }).click()
    await page.getByRole('dialog', { name: 'New thread', exact: true }).getByRole('button', { name: /^Sotto test/ }).click()
    await expect(page.getByRole('heading', { name: 'New thread', exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(async () => {
      const state = await window.sotto!.agents!.get()
      return state.host.threads.find(thread => thread.id === state.activeThreadId)?.reasoningEffort
    })).toBe('high')
  } finally { await closeSotto(launched) }
})

test('the project pen rejects settled and stale empty threads', async () => {
  test.setTimeout(90_000)
  const launched = await launchSotto('design-threads-empty')
  const { page } = launched
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true })
      await window.sotto!.agents!.command({ type: 'connect' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { newThreadModelId: 'claude:sonnet' } })
    })
    await page.reload()
    await openThreads(page)
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    const pen = sidebar.getByRole('button', { name: 'New thread in workshop', exact: true })
    const active = () => page.evaluate(async () => {
      const state = await window.sotto!.agents!.get()
      return state.host.threads.find(thread => thread.id === state.activeThreadId)
    })
    await pen.click()
    await expect.poll(async () => (await active())?.modelId).toBe('claude:sonnet')
    const first = (await active())!
    await openPage(page, 'Settings')
    await page.getByRole('tab', { name: 'Agents', exact: true }).click()
    const model = page.getByRole('combobox', { name: 'Thread model', exact: true })
    await model.click()
    await page.getByRole('tab', { name: 'Codex', exact: true }).click()
    await page.getByRole('option', { name: 'GPT-5.4', exact: true }).click()
    await expect(model).toHaveText(/GPT-5.4/)
    await openThreads(page)
    await pen.click()
    await expect.poll(async () => (await active())?.modelId).toBe('codex:gpt')
    const second = (await active())!
    expect(second.id).not.toBe(first.id)
    await pen.click()
    await expect.poll(async () => (await active())?.id).toBe(second.id)
    await page.evaluate(async projectId => window.sotto!.agents!.command({ type: 'settle-project', projectId }), second.projectId)
    await sidebar.getByRole('button', { name: /^Settled / }).click()
    await sidebar.getByRole('button', { name: 'New thread', exact: true }).and(page.locator('.tt-button')).click()
    await page.getByRole('dialog', { name: 'New thread', exact: true }).getByRole('button', { name: /^workshop/ }).click()
    await expect.poll(async () => (await active())?.id).not.toBe(second.id)
    const projects = sidebar.getByRole('region', { name: 'Projects' })
    await expect(projects.getByRole('button', { name: 'New thread', exact: true })).toBeVisible()
    const third = (await active())!
    expect(third.modelId).toBe('codex:gpt')
    expect(third.workspaceSettledAt).toBeFalsy()
    await page.evaluate(async threadId => window.sotto!.agents!.command({ type: 'settle-thread', threadId }), third.id)
    await expect(projects.getByRole('button', { name: 'New thread', exact: true })).toHaveCount(0)
    await projects.getByRole('button', { name: 'New thread in workshop', exact: true }).click()
    await expect.poll(async () => (await active())?.id).not.toBe(third.id)
    await expect(projects.getByRole('button', { name: 'New thread', exact: true })).toBeVisible()
    await page.reload()
    await expect(projects.getByRole('button', { name: 'New thread', exact: true })).toBeVisible()
  } finally { await closeSotto(launched) }
})
