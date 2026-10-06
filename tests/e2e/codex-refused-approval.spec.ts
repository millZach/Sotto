import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'

test('Codex shows a refused child approval without approving or routing it', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-codex-refusal-'))
  const root = join(profile, 'native-fixture')
  for (const folder of ['claude', 'codex', 'project']) await mkdir(join(root, folder), { recursive: true })
  await writeFile(join(root, 'codex', 'script.json'), JSON.stringify({ reply: 'Ready for the next request.' }))
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
      await agents.command({ type: 'configure', patch: { provider: 'codex', enabled: true, enabledProviders: ['codex'], speak: false, checkClientUpdates: false } })
      await agents.command({ type: 'connect', provider: 'codex' })
      const created = await agents.command({ type: 'create-project', provider: 'codex', title: 'Approval notice', path: project, useExisting: true })
      const projectId = created.host.projects.find(p => p.title === 'Approval notice')!.id
      const modelId = (await agents.get()).host.models.find(m => m.providerId === 'codex' && m.ready)!.id
      const thread = await agents.command({ type: 'create-thread', projectId, title: 'Child approval', titleSource: 'user', modelId, workingCopy: 'shared', managed: false })
      if (thread.error || !thread.activeThreadId) throw new Error(thread.error ?? 'Missing thread')
      await agents.command({ type: 'manual-send', threadId: thread.activeThreadId, text: 'Start the session.' })
    }, join(root, 'project'))
    await page.reload(); await openThreads(page)
    await page.getByRole('button', { name: 'Child approval', exact: true }).click()
    await expect(page.getByLabel('Thread transcript')).toContainText('Ready for the next request.')
    // A previous command error must not mask the later refused-approval notice.
    await page.evaluate(async () => {
      const agents = window.sotto!.agents!
      const state = await agents.get()
      const result = await agents.command({ type: 'configure-thread', threadId: state.activeThreadId!, modelId: 'missing-model' })
      if (!result.error) throw new Error('The synthetic invalid model was not refused')
    })
    const native = Object.values(JSON.parse(await readFile(join(root, 'codex', 'state.json'), 'utf8')).threads)[0] as { id: string }
    await writeFile(join(root, 'codex', 'control.json'), JSON.stringify({ id: randomUUID(), threadId: native.id,
      type: 'permission', text: 'Build?', params: { threadId: 'unknown-child' } }))
    const notice = page.getByRole('alert').filter({ hasText: 'Codex asked for an approval Sotto could not show' })
    await expect(notice).toBeVisible()
    await expect(notice).toContainText('The request was refused. Nothing was approved.')
    await expect(page.locator('.agent-request')).toHaveCount(0)
    const frames = JSON.parse(`[${(await readFile(join(root, 'codex', 'requests.jsonl'), 'utf8')).trim().split('\n').join(',')}]`) as { error?: { code?: number }; result?: { decision?: string } }[]
    expect(frames.some(frame => frame.error?.code === -32601)).toBe(true)
    expect(frames.some(frame => frame.result?.decision?.startsWith('accept'))).toBe(false)
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(appearance => window.sotto!.updateSettings({ appearance }), appearance)
      for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]]) {
        await launched.app.evaluate(({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'))!.setContentSize(size[0]!, size[1]!)
        }, [width!, height!])
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
        await expect(notice).toBeVisible()
        const bounds = await notice.evaluate(element => {
          const rect = element.getBoundingClientRect()
          return { left: rect.left, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight,
            overflow: document.documentElement.scrollWidth - innerWidth }
        })
        expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(bounds.width)
        expect(bounds.bottom).toBeLessThanOrEqual(bounds.height); expect(bounds.overflow).toBe(0)
        await page.screenshot({ path: test.info().outputPath(`refusal-${appearance}-${width}.png`), animations: 'disabled' })
      }
    }
    await page.emulateMedia({ reducedMotion: 'reduce' }); await expect(notice).toBeVisible()
  } finally {
    if (launched) await closeSotto(launched)
    if (previous.root === undefined) delete process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT
    else process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = previous.root
    if (previous.executable === undefined) delete process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE
    else process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = previous.executable
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
  }
})
