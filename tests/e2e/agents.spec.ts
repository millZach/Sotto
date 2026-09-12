import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SottoBridge } from '../../src/shared/contracts'
import type { SottoE2EBridge } from '../../src/shared/e2e'
import { closeSotto, launchSotto } from './support/sottoLaunch'

async function setup(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: /test microphone/i }).click()
  await expect(page.getByText(/microphone ready/i)).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: /finish setup/i }).click()
  await page.getByRole('tab', { name: 'Agents', exact: true }).click()
}

test('selects each native subscription with its available model and reasoning effort without an API key', async () => {
  const launched = await launchSotto()
  const { page } = launched
  try {
    await setup(page)
    await page.getByRole('button', { name: 'Connection settings', exact: true }).click()
    await page.getByLabel('Sotto reasoning').selectOption('claude')
    await expect(page.getByText('Claude subscription connected', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Reasoning API key', { exact: true })).toHaveCount(0)
    await page.getByLabel('Reasoning model').selectOption('fixture-model')
    await page.getByLabel('Reasoning effort').selectOption('high')
    await page.getByRole('button', { name: 'Save connection settings', exact: true }).click()
    await expect(page.getByText('Settings saved', { exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as { sotto: SottoBridge }).sotto.agents?.get().then(state => ({
      provider: state.configuration.reasoning, model: state.configuration.reasoningModel, effort: state.configuration.reasoningEffort, key: state.credentials.reasoning,
    })))).toEqual({ provider: 'claude', model: 'fixture-model', effort: 'high', key: false })
    await page.getByLabel('Sotto reasoning').selectOption('grok')
    await expect(page.getByText('Grok subscription connected', { exact: true })).toBeVisible()
    await page.getByLabel('Reasoning model').selectOption('fixture-alternate')
    await page.getByLabel('Reasoning effort').selectOption('max')
    await page.getByRole('button', { name: 'Save connection settings', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as { sotto: SottoBridge }).sotto.agents?.get().then(state => ({
      provider: state.configuration.reasoning, model: state.configuration.reasoningModel, effort: state.configuration.reasoningEffort,
    })))).toEqual({ provider: 'grok', model: 'fixture-alternate', effort: 'max' })
    await page.getByLabel('Sotto reasoning').selectOption('codex')
    await expect(page.getByText('ChatGPT subscription connected', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Reasoning model')).toHaveValue('')
    await expect(page.getByLabel('Reasoning effort')).toHaveValue('')
    await page.getByRole('button', { name: 'Save connection settings', exact: true }).click()
    await expect(page.getByText('Settings saved', { exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as { sotto: SottoBridge }).sotto.agents?.get().then(state => state.configuration.reasoning))).toBe('codex')
    await page.getByRole('button', { name: 'Connection settings', exact: true }).click()
    await expect(page.getByLabel('Reasoning setup', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Connection settings', exact: true }).click()
    await expect(page.getByLabel('Sotto reasoning')).toHaveValue('codex')
    await page.getByLabel('Sotto reasoning').scrollIntoViewIfNeeded()
    await page.screenshot({ path: 'artifacts/agent-control-smoke/subscription-settings-e2e.png' })
  } finally { await closeSotto(launched) }
})

test('chooses and previews a natural voice without changing subscription reasoning', async () => {
  const launched = await launchSotto()
  const { page } = launched
  try {
    await setup(page)
    await page.getByRole('button', { name: 'Connection settings', exact: true }).click()
    await expect(page.getByLabel('Speech voice', { exact: true })).toHaveValue('grok')
    await page.getByLabel('Speech voice', { exact: true }).selectOption('natural')
    await page.getByLabel('Voice', { exact: true }).selectOption('M3')
    await page.getByRole('button', { name: 'Use and preview voice', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as { sotto: SottoBridge }).sotto.agents?.get().then(state => ({
      provider: state.configuration.speechProvider, voice: state.configuration.speechVoice, reasoning: state.configuration.reasoning, preview: state.speech.preview,
    })))).toEqual({ provider: 'natural', voice: 'M3', reasoning: 'none', preview: true })
    await page.getByLabel('Speech voice', { exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: 'artifacts/agent-control-smoke/natural-voice-settings-e2e.png' })
    await page.getByRole('button', { name: 'Close Agent configuration', exact: true }).click()
    await page.getByRole('button', { name: 'Connection settings', exact: true }).click()
    await expect(page.getByLabel('Voice', { exact: true })).toHaveValue('M3')
  } finally { await closeSotto(launched) }
})

test('configures Grok API speech, recovers from a rejected key, and previews a custom voice with agents off', async () => {
  const launched = await launchSotto()
  const { page } = launched
  try {
    await setup(page)
    await page.getByRole('button', { name: 'Connection settings', exact: true }).click()
    await page.getByLabel('Speech voice', { exact: true }).selectOption('grok')
    await expect(page.getByRole('button', { name: 'Use and preview voice', exact: true })).toBeDisabled()
    await expect(page.getByText(/\$15 per million characters, including previews/u)).toBeVisible()
    await page.getByLabel('Grok speech API key', { exact: true }).fill('fixture-invalid-grok-key')
    await page.getByRole('button', { name: 'Save API key', exact: true }).click()
    await expect(page.getByLabel('Grok speech API key', { exact: true })).toHaveValue('')
    await expect(page.getByText(/Grok speech rejected the API key/u).first()).toBeVisible()
    await page.getByRole('button', { name: 'Use and preview voice', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as { sotto: SottoBridge }).sotto.agents?.get().then(state => state.voice.error))).toContain('rejected the API key')
    await page.getByLabel('Grok speech API key', { exact: true }).fill('fixture-valid-grok-key')
    await page.getByRole('button', { name: 'Replace API key', exact: true }).click()
    await expect(page.getByLabel('Grok voice', { exact: true }).locator('option')).toHaveCount(4)
    await page.getByLabel('Grok voice', { exact: true }).selectOption('fixture-custom-voice')
    await page.getByRole('button', { name: 'Use and preview voice', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as { sotto: SottoBridge }).sotto.agents?.get().then(state => ({
      provider: state.configuration.speechProvider, voice: state.configuration.grokSpeechVoice,
      reasoning: state.configuration.reasoning, enabled: state.configuration.enabled,
      error: state.voice.error, keySaved: state.credentials.grokSpeech,
    })))).toEqual({ provider: 'grok', voice: 'fixture-custom-voice', reasoning: 'none', enabled: false, error: null, keySaved: true })
    await expect(page.getByText(/Grok speech rejected the API key/u)).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Stop speech', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Stop speech', exact: true }).click()
    await page.getByLabel('Speech voice', { exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: 'artifacts/agent-control-smoke/grok-tts-settings-e2e.png' })
    expect(await readFile(join(launched.userData, 'credentials.json'), 'utf8')).not.toContain('fixture-valid-grok-key')
    expect(await readFile(join(launched.userData, 'agents.json'), 'utf8')).not.toContain('fixture-valid-grok-key')
    await page.getByRole('button', { name: 'Close Agent configuration', exact: true }).click()
    await page.getByRole('button', { name: 'Connection settings', exact: true }).click()
    await expect(page.getByLabel('Speech voice', { exact: true })).toHaveValue('grok')
    await expect(page.getByLabel('Grok voice', { exact: true })).toHaveValue('fixture-custom-voice')
    await expect(page.getByLabel('Grok speech API key', { exact: true })).toHaveValue('')
    await page.getByRole('button', { name: 'Remove API key', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Use and preview voice', exact: true })).toBeDisabled()
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as { sotto: SottoBridge }).sotto.agents?.get().then(state => state.credentials.grokSpeech))).toBe(false)
  } finally { await closeSotto(launched) }
})

test('defaults to Grok Altair and previews Kokoro Heart with the shared OpenRouter key', async () => {
  const launched = await launchSotto()
  const { page } = launched
  try {
    await setup(page)
    await page.getByRole('button', { name: 'Connection settings', exact: true }).click()
    await expect(page.getByLabel('Speech voice', { exact: true })).toHaveValue('grok')
    await expect(page.getByLabel('Grok voice', { exact: true })).toHaveValue('altair')
    await page.getByLabel('Speech voice', { exact: true }).selectOption('kokoro')
    await expect(page.getByText(/Add your OpenRouter API key in Settings/u)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Use and preview voice', exact: true })).toBeDisabled()
    await page.evaluate(() => (globalThis as unknown as { sotto: SottoBridge }).sotto.updateSettings({ llmApiKey: 'fixture-invalid-openrouter-key' }))
    await expect(page.getByRole('button', { name: 'Use and preview voice', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Use and preview voice', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as { sotto: SottoBridge }).sotto.agents?.get().then(state => state.voice.error))).toMatch(/OpenRouter.*key/iu)
    await page.evaluate(() => (globalThis as unknown as { sotto: SottoBridge }).sotto.updateSettings({ llmApiKey: 'fixture-valid-openrouter-key' }))
    await page.getByRole('button', { name: 'Use and preview voice', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as { sotto: SottoBridge }).sotto.agents?.get().then(state => ({
      provider: state.configuration.speechProvider, grokVoice: state.configuration.grokSpeechVoice,
      reasoning: state.configuration.reasoning, error: state.voice.error,
    })))).toEqual({ provider: 'kokoro', grokVoice: 'altair', reasoning: 'none', error: null })
    await page.getByRole('button', { name: 'Stop speech', exact: true }).click()
    await page.getByLabel('Speech voice', { exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: 'artifacts/agent-control-smoke/kokoro-voice-settings-e2e.png' })
    expect(await readFile(join(launched.userData, 'credentials.json'), 'utf8')).not.toContain('fixture-valid-openrouter-key')
    expect(await readFile(join(launched.userData, 'agents.json'), 'utf8')).not.toContain('fixture-valid-openrouter-key')
    await page.getByRole('button', { name: 'Close Agent configuration', exact: true }).click()
    await page.getByRole('button', { name: 'Connection settings', exact: true }).click()
    await expect(page.getByLabel('Speech voice', { exact: true })).toHaveValue('kokoro')
    await page.evaluate(() => (globalThis as unknown as { sotto: SottoBridge }).sotto.updateSettings({ llmApiKey: '' }))
    await expect(page.getByRole('button', { name: 'Use and preview voice', exact: true })).toBeDisabled()
    await page.getByLabel('Speech voice', { exact: true }).selectOption('grok')
    await expect(page.getByLabel('Grok voice', { exact: true })).toHaveValue('altair')
  } finally { await closeSotto(launched) }
})

test('collects an explicit prompt, queues ready threads, and yields only the directly controlled thread', async () => {
  const launched = await launchSotto()
  const { page } = launched
  try {
    await setup(page)
    await page.getByRole('button', { name: 'Connect Codex' }).click()
    await expect(page.getByText('Codex connected', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Manage Workshop', exact: true }).click()
    await page.getByRole('button', { name: 'Manage Docs', exact: true }).click()
    await page.getByRole('button', { name: 'Select Workshop', exact: true }).click()
    await page.getByLabel('Prompt').fill('Build the requested feature and run its checks.')
    await expect(page.getByRole('button', { name: 'Send it', exact: true })).toBeEnabled()
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as { sotto: SottoBridge }).sotto?.agents?.get().then(s => s.host.threads.find(t => t.title === 'Workshop')?.messages.length))).toBe(0)
    await page.getByRole('button', { name: 'Send it', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as { sotto: SottoBridge }).sotto?.agents?.get().then(s => s.host.threads.find(t => t.title === 'Workshop')?.messages.length))).toBe(1)
    await page.evaluate(() => (globalThis as unknown as { sottoE2E: SottoE2EBridge }).sottoE2E?.agentEvent?.({ type: 'ready', threadId: 'workshop', text: 'Feature is ready.' }))
    await page.evaluate(() => (globalThis as unknown as { sottoE2E: SottoE2EBridge }).sottoE2E?.agentEvent?.({ type: 'ready', threadId: 'docs', text: 'Docs are ready.' }))
    await expect(page.getByText('Feature is ready.', { exact: true }).first()).toBeVisible()
    await page.getByLabel('Prompt').fill('Inspect the result before proceeding.')
    await page.evaluate(() => (globalThis as unknown as { sottoE2E: SottoE2EBridge }).sottoE2E?.agentEvent?.({ type: 'manual', threadId: 'workshop', text: 'I will handle the review.' }))
    await expect(page.getByText('Manual control · Workshop', { exact: true }).first()).toBeVisible()
    await page.screenshot({ path: 'artifacts/agent-control-smoke/agents-manual-e2e.png' })
    const widget = launched.app.windows().find((window) => window.url().endsWith('/widget.html'))
    expect(widget).toBeDefined()
    await expect(widget!.getByRole('button', { name: 'Collapse agent controls', exact: true })).toBeVisible()
    await widget!.screenshot({ path: 'artifacts/agent-control-smoke/agents-widget-e2e.png' })
    await expect(page.getByLabel('Prompt')).toHaveValue('Inspect the result before proceeding.')
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as { sotto: SottoBridge }).sotto?.agents?.get().then(s => s.assignments.find(a => a.threadId === 'docs')?.mode))).toBe('managed')
    await page.getByRole('button', { name: 'Resume management', exact: true }).first().click()
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as { sotto: SottoBridge }).sotto?.agents?.get().then(s => s.assignments.find(a => a.threadId === 'workshop')?.mode))).toBe('managed')
    await page.locator('.app-content').evaluate((element) => { element.scrollTop = 0 })
    await page.screenshot({ path: 'artifacts/agent-control-smoke/agents-e2e.png' })
  } finally {
    await closeSotto(launched)
  }
})

test('keeps agent settings and widget prompts usable at the minimum window size', async () => {
  const launched = await launchSotto()
  const { page } = launched
  try {
    await setup(page)
    await page.evaluate(async () => {
      const bridge = (globalThis as unknown as { sotto: SottoBridge }).sotto
      await bridge.updateSettings({ theme: 'dark', reducedMotion: 'on' })
      await bridge.agents?.command({ type: 'configure', patch: { speak: false } })
    })
    await launched.app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!
      main.setBounds({ ...main.getBounds(), width: 820, height: 560 })
    })
    await page.getByRole('button', { name: 'Connect Codex' }).click()
    await page.getByRole('button', { name: 'Manage Workshop', exact: true }).click()
    await page.getByRole('button', { name: 'Connection settings', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'on')
    await page.getByLabel('Default projects directory').fill('D:\\Builder projects')
    await page.getByRole('button', { name: 'Save connection settings' }).click()
    await expect(page.getByText('Settings saved', { exact: true })).toBeVisible()
    expect(await page.locator('.app-content').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.getByLabel('Default projects directory').scrollIntoViewIfNeeded()
    await page.screenshot({ path: 'artifacts/agent-control-smoke/agents-settings-dark-minimum.png' })
    await page.getByRole('button', { name: 'Connection settings', exact: true }).click()
    await page.getByLabel('Prompt').fill('Review this small-screen prompt.')
    const widget = launched.app.windows().find(window => window.url().endsWith('/widget.html'))!
    await widget.getByTestId('widget-sliver').hover()
    await expect(widget.getByRole('button', { name: 'Expand threads' })).toBeVisible()
    await widget.getByRole('button', { name: 'Expand threads' }).click()
    await expect(widget.getByLabel('Prompt')).toHaveValue('Review this small-screen prompt.')
    await widget.getByRole('button', { name: 'Send it', exact: true }).scrollIntoViewIfNeeded()
    await widget.screenshot({ path: 'artifacts/agent-control-smoke/agents-widget-dark-prompt.png' })
    await widget.getByRole('button', { name: 'Send it', exact: true }).click()
    await expect(page.getByLabel('Prompt')).toHaveValue('')
    expect(await widget.locator('.widget-threads').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  } finally { await closeSotto(launched) }
})
