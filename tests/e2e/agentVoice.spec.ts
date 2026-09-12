import { expect, test, type Page } from '@playwright/test'
import type { AgentCommand, AgentState } from '../../src/shared/agents'
import type { SottoBridge, SottoWidgetBridge } from '../../src/shared/contracts'
import { closeSotto, launchSotto } from './support/sottoLaunch'
import { completeVoiceJourneySetup, openVoiceJourneyAgents } from './support/voiceJourney'

async function command(page: Page, request: AgentCommand): Promise<AgentState> {
  return page.evaluate(async value => {
    const bridge = (globalThis as unknown as { sotto: SottoBridge }).sotto.agents
    if (!bridge) throw new Error('Agent bridge unavailable')
    return bridge.command(value)
  }, request)
}
async function state(page: Page): Promise<AgentState> {
  return page.evaluate(async () => {
    const bridge = (globalThis as unknown as { sotto: SottoBridge }).sotto.agents
    if (!bridge) throw new Error('Agent bridge unavailable')
    return bridge.get()
  })
}
async function speak(page: Page, text: string): Promise<void> {
  await page.evaluate(value => {
    const target = globalThis as unknown as {
      CustomEvent: new (name: string, options: { detail: string }) => unknown
      dispatchEvent(event: unknown): boolean
    }
    target.dispatchEvent(new target.CustomEvent('sotto:e2e:microphone', { detail: value }))
  }, text)
}

test('routes activated voice through the real controller, retains paused prompts, and preserves widget dictation', async () => {
  const launched = await launchSotto()
  const { page } = launched
  try {
    await completeVoiceJourneySetup(page)
    await openVoiceJourneyAgents(page)
    await command(page, { type: 'configure', patch: { speak: false } })
    await page.getByRole('button', { name: 'Connect Codex' }).click()
    await page.getByRole('button', { name: 'Open Workshop', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Workshop', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Manage this thread', exact: true }).click()
    await expect.poll(async () => (await state(page)).voice.status).toBe('wake')

    await speak(page, 'start prompt This is background conversation')
    await speak(page, 'Hey Sotto')
    await expect.poll(async () => (await state(page)).voice.status).toBe('listening')
    expect((await state(page)).draft).toBe('')
    await speak(page, 'start prompt')
    await expect.poll(async () => (await state(page)).composing).toBe(true)
    await speak(page, 'Build a small engineering tool.')
    await expect(page.getByLabel('Prompt')).toHaveValue('Build a small engineering tool.')
    await speak(page, 'Keep the existing controls.')
    await expect(page.getByLabel('Prompt')).toHaveValue('Build a small engineering tool. Keep the existing controls.')
    await page.screenshot({ animations: 'disabled', path: 'artifacts/voice-journey/paused-prompt.png' })
    await speak(page, 'stop listening')
    await expect.poll(async () => (await state(page)).voice.status).toBe('wake')
    expect((await state(page)).host.threads[0]?.messages).toHaveLength(0)
    await speak(page, 'Hey Sotto')
    await expect.poll(async () => (await state(page)).voice.status).toBe('listening')
    await speak(page, 'send it')
    await expect.poll(async () => (await state(page)).host.threads[0]?.messages.length).toBe(1)
    expect((await state(page)).host.threads[0]?.messages[0]?.text).toBe('Build a small engineering tool. Keep the existing controls.')
    await expect(page.getByLabel('Prompt')).toHaveValue('')

    const widget = launched.app.windows().find(window => window.url().endsWith('/widget.html'))!
    await expect(widget.getByTestId('widget-sliver')).toBeVisible()
    expect(await widget.evaluate(async () => {
      const bridge = (globalThis as unknown as { sottoWidget: SottoWidgetBridge }).sottoWidget.agents!
      if (bridge.prepareWake || bridge.detectWake || bridge.synthesizeSpeech) return false
      try {
        await bridge.command({ type: 'credential', slot: 'reasoning', value: 'untrusted-widget-fixture' })
        return false
      } catch { return true }
    })).toBe(true)
    expect((await state(page)).credentials.reasoning).toBe(false)
    await widget.getByTestId('widget-sliver').hover()
    await widget.getByRole('button', { name: 'Mute microphone', exact: true }).click()
    await expect.poll(async () => (await state(page)).voice.status).toBe('muted')
    await speak(page, 'Hey Sotto send it')
    await widget.getByRole('button', { name: 'Unmute microphone', exact: true }).click()
    await expect.poll(async () => (await state(page)).voice.status).toBe('wake')
    expect((await state(page)).host.threads[0]?.messages).toHaveLength(1)
    await widget.getByTestId('widget-sliver').click()
    await expect.poll(async () => (await state(page)).voice.status).toBe('dictation')
    await expect(widget.locator('.widget-shell[data-status="listening"]')).toBeVisible()
    await widget.getByRole('button', { name: 'Stop dictation', exact: true }).click()
    await expect.poll(async () => (await state(page)).voice.status).toBe('wake')
    expect((await state(page)).host.threads[0]?.messages).toHaveLength(1)
    await widget.getByTestId('widget-sliver').hover()
    await widget.getByRole('button', { name: 'Expand threads', exact: true }).click()
    await expect(widget.getByRole('region', { name: 'Threads', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Close Workshop', exact: true }).click()
    await page.getByRole('button', { name: 'Connection settings', exact: true }).click()
    await page.getByRole('button', { name: 'Turn off agent control' }).click()
    await expect(widget.locator('.widget-shell')).toBeVisible()
    await expect(widget.getByRole('region', { name: 'Threads', exact: true })).toHaveCount(0)
    expect((await state(page)).assignments).toHaveLength(1)
  } finally { await closeSotto(launched) }
})
