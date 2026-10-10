import { expectPromptText, fillPrompt, promptField } from './support/prompt'
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { expect, test } from '@playwright/test'
import type { AgentCommand, AgentCommandReceipt } from '../../src/shared/agents'
import { hostKeys } from './support/hostKeys'
import { closeSotto, launchSotto, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'

const ARTIFACTS = evidenceDirectory('artifacts/review-381/electron')
type Prompt = Extract<AgentCommand, { type: 'manual-send' }>
type Receipt = Pick<AgentCommandReceipt, 'error' | 'notice' | 'deliveries' | 'deliveredDrafts' | 'followups'>
interface Evidence {
  original: Prompt | null
  first: Receipt | null
  conflict: Receipt | null
  retry: Receipt | null
  done: boolean
}

/**
 * Like command-receipt.spec.ts, watch the real main IPC handler. The existing uncertain provider event
 * retains the message without emitting it. Retry inside this wrapper so no window round trip can
 * refresh that message before admission is tested. Every answer comes from the original handler;
 * the window still receives its original first receipt, untouched. No provider/controller is replaced.
 */
async function watchFileRetry({ app }: LaunchedSotto): Promise<() => Promise<Evidence>> {
  await app.evaluate(({ ipcMain }) => {
    type Handler = (...args: unknown[]) => Promise<AgentCommandReceipt>
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, Handler> })._invokeHandlers
    const command = handlers?.get('sotto:agents:command')
    if (!handlers || !command) throw new Error('This Electron keeps its invoke handlers elsewhere; update the watcher.')
    const evidence: Evidence = { original: null, first: null, conflict: null, retry: null, done: false }
    ;(globalThis as unknown as { fileIdentityEvidence: Evidence }).fileIdentityEvidence = evidence
    const keep = ({ error, notice, deliveries, deliveredDrafts, followups }: AgentCommandReceipt): Receipt =>
      structuredClone({ error, notice, deliveries, deliveredDrafts, followups })
    handlers.set('sotto:agents:command', async (...args) => {
      const request = args[1] as AgentCommand
      if (request.type !== 'manual-send' || evidence.original) return command(...args)
      evidence.original = structuredClone(request)
      const first = await command(...args)
      evidence.first = keep(first)
      try {
        // If a background read already reconciled it, fail the test rather than pass via a delivered receipt.
        if (first.deliveries?.find(item => item.draftId === request.draftId)?.status !== 'uncertain') return first
        const changed = [...args]
        changed[1] = { ...evidence.original, files: [{ path: 'src/main.ts' }] }
        evidence.conflict = keep(await command(...changed))
        const same = [...args]
        same[1] = structuredClone(evidence.original)
        evidence.retry = keep(await command(...same))
        return first
      } finally { evidence.done = true }
    })
  })
  return () => app.evaluate(() => structuredClone((globalThis as unknown as { fileIdentityEvidence: Evidence }).fileIdentityEvidence))
}

test('reconciles the original selected-file revision and refuses a different selection through real admission', async () => {
  test.setTimeout(90_000)
  await mkdir(ARTIFACTS, { recursive: true })
  const launched = await launchSotto('success')
  const { page } = launched
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    const threadId = (await hostKeys(page))('workshop')
    const folder = await page.evaluate(async id => {
      const state = await window.sotto!.agents!.get()
      const thread = state.host.threads.find(item => item.id === id)!
      return state.host.projects.find(item => item.id === thread.projectId)!.path
    }, threadId)
    const withinProfile = relative(launched.userData, folder)
    expect(withinProfile).not.toBe('')
    expect(isAbsolute(withinProfile) || withinProfile.startsWith('..')).toBe(false)
    await mkdir(join(folder, 'src'), { recursive: true })
    await writeFile(join(folder, 'README.md'), '# File identity fixture\n', 'utf8')
    await writeFile(join(folder, 'src/main.ts'), 'export const fixture = true\n', 'utf8')
    await page.reload()
    await resizeWindow(launched, 1280, 800)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openThreads(page)
    await page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: 'Workshop', exact: true }).click()
    const pane = page.locator(`section.thread-pane[data-thread-id="${threadId}"]`)
    const prompt = promptField(pane)
    const draft = () => page.evaluate(async id => (await window.sotto!.agents!.get()).threadDrafts?.find(item => item.threadId === id), threadId)

    // Typed tokens are not selected files. Both valid paths stay in the text when the selection changes below.
    const typed = 'Read @README.md and @src/main.ts '
    await fillPrompt(prompt, typed)
    await expect.poll(async () => ({ text: (await draft())?.text, files: (await draft())?.files ?? [] })).toEqual({ text: typed, files: [] })
    await fillPrompt(prompt, 'Read @src/main.ts and @READ')
    const files = pane.getByRole('listbox', { name: 'Files' })
    await expect(files.getByRole('option')).toHaveCount(1)
    await expect(files.getByRole('option')).toContainText('README.md')
    await page.screenshot({ path: `${ARTIFACTS}/file-picker.png`, animations: 'disabled' })
    await prompt.press('Enter')
    const text = 'Read @src/main.ts and @README.md '
    await expectPromptText(prompt, text)
    await expect(files).toHaveCount(0)
    await expect.poll(async () => (await draft())?.files).toEqual([{ path: 'README.md' }])
    const selected = await draft()

    const evidence = await watchFileRetry(launched)
    await page.evaluate(() => window.sottoE2E!.agentEvent!({ type: 'uncertain', threadId: 'workshop', text: '' }))
    await prompt.press('Enter')
    await expect.poll(async () => (await evidence()).done).toBe(true)
    const seen = await evidence()
    await writeFile(`${ARTIFACTS}/receipts.json`, JSON.stringify(seen, null, 2) + '\n', 'utf8')
    expect(seen.original).toMatchObject({ type: 'manual-send', threadId, draftId: selected!.draftId, text, files: [{ path: 'README.md' }] })
    const delivery = (receipt: Receipt | null) => receipt?.deliveries?.find(item => item.draftId === seen.original!.draftId)
    const first = delivery(seen.first)
    expect(first).toMatchObject({ status: 'uncertain', commandId: expect.any(String), messageId: expect.any(String) })
    expect(seen.conflict?.error).toMatch(/new draft revision/)
    expect(delivery(seen.conflict)).toMatchObject({ status: 'uncertain', commandId: first!.commandId, messageId: first!.messageId })
    expect(seen.retry?.error).toBeNull()
    expect(seen.retry?.notice).toContain('Reconciled the earlier action')
    expect(delivery(seen.retry)).toMatchObject({ status: 'accepted', commandId: first!.commandId, messageId: first!.messageId })
    expect(seen.retry?.deliveredDrafts).toContainEqual({ threadId, draftId: seen.original!.draftId })
    expect(seen.retry?.followups).toEqual([])

    // Reload adopts main's final state; the wrapper deliberately returned the untouched uncertain first receipt.
    await page.reload()
    await openThreads(page)
    await page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: 'Workshop', exact: true }).click()
    const messages = await page.evaluate(async id => (await window.sotto!.agents!.threadDetail!(id))?.messages.filter(item => item.role === 'user'), threadId)
    expect(messages).toEqual([expect.objectContaining({ id: first!.messageId, commandId: first!.commandId, text: text.trim() })])
    await expect(pane.getByLabel('Thread transcript')).toContainText(text.trim())
    await expectPromptText(prompt, '')
    await page.screenshot({ path: `${ARTIFACTS}/reconciled.png`, animations: 'disabled' })
  } finally { await closeSotto(launched) }
})
