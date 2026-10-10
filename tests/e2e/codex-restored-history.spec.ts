import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

test('Codex replies stay visible when saved user receipts replay after reconnect', async () => {
  test.setTimeout(90_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-codex-history-' })).directory
  const root = join(profile, 'native-fixture')
  for (const folder of ['claude', 'codex', 'project']) await mkdir(join(root, folder), { recursive: true })
  await writeFile(join(root, 'codex', 'script.json'), JSON.stringify({ reply: 'The saved Codex reply is still here.' }))
  const previous = { root: process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT, executable: process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE }
  process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = root
  process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = process.execPath
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto('success', profile)
    const { page } = launched
    await page.evaluate(async project => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
      const agents = window.sotto!.agents!
      await agents.command({ type: 'configure', patch: { provider: 'codex', enabled: true, enabledProviders: ['codex'], checkClientUpdates: false } })
      await agents.command({ type: 'connect', provider: 'codex' })
      const created = await agents.command({ type: 'create-project', provider: 'codex', title: 'History recovery', path: project, useExisting: true })
      const projectId = created.host.projects.find(p => p.title === 'History recovery')!.id
      const modelId = (await agents.get()).host.models.find(m => m.providerId === 'codex' && m.ready)!.id
      const thread = await agents.command({ type: 'create-thread', projectId, title: 'Saved conversation', titleSource: 'user', modelId, workingCopy: 'shared' })
      if (thread.error || !thread.activeThreadId) throw new Error(thread.error ?? 'Missing thread')
      await agents.command({ type: 'manual-send', threadId: thread.activeThreadId, text: 'Please keep this conversation.' })
    }, join(root, 'project'))
    await page.reload(); await openThreads(page)
    const transcript = page.getByLabel('Thread transcript')
    await expect(transcript).toContainText('The saved Codex reply is still here.')
    await page.evaluate(async () => { await window.sotto!.agents!.command({ type: 'disconnect', provider: 'codex' }) })
    const native = Object.values(JSON.parse(await readFile(join(root, 'codex', 'state.json'), 'utf8')).threads)[0] as {
      id: string; turns: { items: { id: string; content: unknown }[] }[]
    }
    const sessions = join(root, 'codex', 'home', 'sessions'); await mkdir(sessions, { recursive: true })
    await writeFile(join(sessions, `rollout-${native.id}.jsonl`), JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: {
      type: 'item_completed', item: { type: 'UserMessage', id: native.turns[0]!.items[0]!.id, content: native.turns[0]!.items[0]!.content },
    } }) + '\n')
    await page.evaluate(async () => { await window.sotto!.agents!.command({ type: 'connect', provider: 'codex' }) })
    await page.reload(); await openThreads(page)
    await expect(transcript).toContainText('The saved Codex reply is still here.')
    await expect(transcript.locator('[data-role="user"]')).toHaveCount(1)
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, appearance)
      await resizeWindow(launched, 1280, 800)
      await page.screenshot({ path: test.info().outputPath(`restored-${appearance}.png`), animations: 'disabled' })
    }
    await resizeWindow(launched, 820, 560)
    await expect(transcript).toContainText('The saved Codex reply is still here.')
    await page.screenshot({ path: test.info().outputPath('restored-minimum.png'), animations: 'disabled' })
    await resizeWindow(launched, 1600, 1000)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(transcript).toContainText('The saved Codex reply is still here.')
    await page.screenshot({ path: test.info().outputPath('restored-wide-reduced-motion.png'), animations: 'disabled' })
  } finally {
    if (launched) await closeSotto(launched)
    if (previous.root === undefined) delete process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT
    else process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = previous.root
    if (previous.executable === undefined) delete process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE
    else process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = previous.executable
    await removeOwnedE2EProfile(profile)
  }
})
