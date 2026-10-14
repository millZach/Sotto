import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { closeSotto, launchSotto, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'
import { fillPrompt, promptField } from './support/prompt'

const evidence = evidenceDirectory('artifacts/certified-detail')
test.describe.configure({ mode: 'serial' })

for (const enabled of [false, true]) test(`native certified detail stays whole with the cost gate ${enabled ? 'on' : 'off'}`, async () => {
  test.setTimeout(120_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-certified-detail-' })).directory
  const root = join(profile, 'native-fixture')
  for (const folder of ['claude', 'codex', 'project']) await mkdir(join(root, folder), { recursive: true })
  await writeFile(join(root, 'codex', 'script.json'), '{}')
  const names = ['SOTTO_OWL_FEATURES', 'SOTTO_E2E_NATIVE_FIXTURE_ROOT', 'SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE', 'SOTTO_E2E_CERTIFIED_DETAIL_OBSERVATION'] as const
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]))
  process.env.SOTTO_OWL_FEATURES = `streaming-publish-cost=${enabled ? 1 : 0}`
  process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = root
  process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = process.execPath
  process.env.SOTTO_E2E_CERTIFIED_DETAIL_OBSERVATION = '1'
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto('success', profile)
    const { page } = launched
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    expect(await page.evaluate(async () => {
      const status = await window.sotto!.getUpdateStatus()
      return 'owlFeatures' in status ? status.owlFeatures?.['streaming-publish-cost'] : undefined
    })).toBe(enabled)
    await page.evaluate(async project => {
      await window.sotto!.updateSettings({ onboardingComplete: true, reducedMotion: 'on' })
      const agents = window.sotto!.agents!
      await agents.command({ type: 'configure', patch: { provider: 'codex', enabled: true, enabledProviders: ['codex'], checkClientUpdates: false } })
      await agents.command({ type: 'connect', provider: 'codex' })
      const created = await agents.command({ type: 'create-project', provider: 'codex', title: 'Synthetic project', path: project, useExisting: true })
      const projectId = created.host.projects.find(item => item.title === 'Synthetic project')!.id
      const modelId = (await agents.get()).host.models.find(model => model.providerId === 'codex' && model.ready)!.id
      const thread = await agents.command({ type: 'create-thread', projectId, title: 'Certified detail', titleSource: 'user', modelId, workingCopy: 'shared' })
      if (thread.error) throw new Error(thread.error)
    }, join(root, 'project'))
    await page.reload(); await openThreads(page)
    await expect(page.getByRole('heading', { name: 'Certified detail', exact: true })).toBeVisible()
    const prompt = promptField(page)
    await fillPrompt(prompt, 'Inspect this streamed reply.')
    await prompt.press('Enter')
    const log = page.getByRole('log', { name: 'Thread transcript' })
    await expect(log).toContainText('Inspect this streamed reply.')
    await expect.poll(async () => {
      const state = JSON.parse(await readFile(join(root, 'codex', 'state.json'), 'utf8').catch(() => '{"threads":{}}')) as { threads: Record<string, { turns: unknown[] }> }
      return Object.values(state.threads).some(thread => thread.turns.length > 0)
    }).toBe(true)
    const state = JSON.parse(await readFile(join(root, 'codex', 'state.json'), 'utf8')) as { threads: Record<string, { id: string; turns: { id: string }[] }> }
    const native = Object.values(state.threads).find(thread => thread.turns.length > 0)!
    const turnId = native.turns.at(-1)!.id
    const notify = async (frames: { method: string; params: Record<string, unknown> }[]) => {
      const id = randomUUID()
      await writeFile(join(root, 'codex', 'control.json'), JSON.stringify({ id, type: 'notify-burst', threadId: native.id,
        frames: frames.map(frame => ({ ...frame, params: { threadId: native.id, turnId, ...frame.params } })) }))
      await expect.poll(async () => (await readFile(join(root, 'codex', 'actions.jsonl'), 'utf8').catch(() => '')).split('\n').some(line => line && JSON.parse(line).id === id)).toBe(true)
    }
    const command = (id: string, text: string) => ({ id, type: 'commandExecution', command: text, cwd: join(root, 'project'), status: 'inProgress', processId: 'synthetic', aggregatedOutput: '', exitCode: null, durationMs: null })
    await notify([
      { method: 'item/started', params: { item: command('retained-command', 'echo retained') } },
      { method: 'item/started', params: { item: command('growing-command', 'echo synthetic') } },
      { method: 'item/started', params: { item: { id: 'reply', type: 'agentMessage', text: '' } } },
      { method: 'item/commandExecution/outputDelta', params: { itemId: 'growing-command', delta: 'First output' } },
      { method: 'item/agentMessage/delta', params: { itemId: 'reply', delta: 'First' } },
    ])
    await expect(log).toContainText('First')
    await page.evaluate(() => window.sottoE2E!.snapshot())
    for (let chunk = 0; chunk < 6; chunk++) {
      await notify([
        { method: 'item/agentMessage/delta', params: { itemId: 'reply', delta: ' streamed words' } },
        { method: 'item/commandExecution/outputDelta', params: { itemId: 'growing-command', delta: ' streamed output' } },
      ])
      await expect(log).toContainText('First' + ' streamed words'.repeat(chunk + 1))
      const proof = await page.evaluate(async () => (await window.sottoE2E!.snapshot()).certifiedDetail)
      expect(proof?.trackedThreads).toBe(enabled ? 1 : 0)
      expect(proof?.ownedThreads).toBe(enabled ? 1 : 0)
      if (enabled) expect(proof!.reusedRecords).toBeGreaterThan(0)
      else expect(proof?.reusedRecords).toBe(0)
    }
    await log.getByRole('button', { name: /echo synthetic/ }).click()
    await expect(log.getByLabel('output code block')).toContainText('First output' + ' streamed output'.repeat(6))
    await mkdir(evidence, { recursive: true })
    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]]) for (const appearance of ['dark', 'light'] as const) {
      await resizeWindow(launched, width!, height!)
      await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), appearance)
      await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
      await log.locator('[data-role="assistant"]').last().scrollIntoViewIfNeeded()
      await expect(log).toContainText('First' + ' streamed words'.repeat(6))
      expect(await page.getByRole('main').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      await page.screenshot({ animations: 'disabled', path: join(evidence, `${enabled ? 'owl' : 'stable'}-${appearance}-${width}.png`) })
    }
    expect(errors).toEqual([])
  } finally {
    if (launched) await closeSotto(launched)
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name] }
    await removeOwnedE2EProfile(profile)
  }
})
