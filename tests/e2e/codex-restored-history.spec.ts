import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { startCodexThread, withNativeCodexFixture } from './support/nativeCodexFixture'
import { openThreads, resizeWindow } from './support/sottoLaunch'

test('Codex replies stay visible when saved user receipts replay after reconnect', async () => {
  test.setTimeout(90_000)
  await withNativeCodexFixture('sotto-e2e-codex-history-', { reply: 'The saved Codex reply is still here.' }, async ({ launched, root }) => {
    const { page } = launched
    await startCodexThread(page, root, { project: 'History recovery', thread: 'Saved conversation', prompt: 'Please keep this conversation.' })
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
  })
})
