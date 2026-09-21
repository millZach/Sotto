import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { firstSottoWindow, openThreads } from './support/sottoLaunch'

/**
 * The approval surface, end to end through the installed Claude Code client (ADR-0021). Sotto used to
 * launch the CLI without naming itself the answerer, which made the CLI deny every prompt itself and
 * withhold its question tool: a thread kept working and nothing reached the user. Only a real client
 * can show that fixed, so this sends two native turns and looks at what appears above the message bar.
 */
test.describe.configure({ retries: 0, timeout: 300_000 })
const enabled = process.env.SOTTO_APPROVAL_SURFACE_LIVE === '1'

test('claude: a real approval and a real question both reach the user', async () => {
  test.skip(!enabled, 'Explicit live approval-surface opt-in required.')
  const root = await mkdtemp(join(tmpdir(), 'sotto-e2e-native-'))
  const profile = join(root, 'profile'); const project = join(root, 'project')
  await mkdir(profile); await mkdir(project)
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ onboardingComplete: true }))
  const artifacts = resolve('artifacts/approval-surface')
  await mkdir(artifacts, { recursive: true })
  let app: ElectronApplication | undefined
  let page: Page | undefined
  try {
    app = await electron.launch({ args: [resolve('tests/fixtures/nativeThreadsMain.cjs')], env: Object.fromEntries(Object.entries({
      ...process.env, SOTTO_NATIVE_THREADS_ROOT: root, SOTTO_NATIVE_THREADS_LIVE: '1',
    }).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE')) })
    page = await firstSottoWindow(app)
    await page.waitForFunction(() => !!window.sotto?.agents)
    const connection = await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true })
      const configured = await window.sotto!.agents!.command({ type: 'configure', patch: {
        provider: 'claude', enabled: true, enabledProviders: ['claude'], speak: false, reasoning: 'none', followupLimit: 0 } })
      if (configured.error) throw new Error(configured.error)
      const connected = await window.sotto!.agents!.command({ type: 'connect', provider: 'claude' })
      if (connected.error) throw new Error(connected.error)
      const ready = connected.host.models.filter(model => model.providerId === 'claude' && model.ready)
      const model = ready.find(model => /haiku|sonnet/i.test(model.name)) ?? ready[0]
      if (!model) throw new Error('No ready Claude model; no native turn initiated.')
      const chosen = await window.sotto!.agents!.command({ type: 'configure', patch: { defaultModelId: model.id } })
      if (chosen.error) throw new Error(chosen.error)
      return { model: model.name, version: connected.host.providers?.find(value => value.id === 'claude')?.version ?? connected.host.version }
    })
    // The surface is claimed at launch, so a client that refused it is already reported by now.
    expect(await page.evaluate(async () => String((await window.sotto!.agents!.get()).host.error ?? ''))).not.toContain('permission prompts')
    await page.reload(); await openThreads(page)
    await page.getByRole('button', { name: 'New thread', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: 'New thread', exact: true })
    await dialog.getByRole('button', { name: /Local folder/ }).click()
    const name = dialog.getByRole('textbox', { name: 'Thread name' })
    if (!await name.isVisible()) await dialog.locator('summary', { hasText: 'Thread options' }).click()
    await name.fill('Approval surface')
    await dialog.getByRole('combobox', { name: 'Thread permissions' }).selectOption('approval-required')
    await dialog.getByRole('button', { name: 'Create thread' }).click()
    await expect(dialog).toHaveCount(0, { timeout: 45_000 })

    const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true })
    const requests = async () => page!.evaluate(async () => {
      const state = await window.sotto!.agents!.get()
      return state.host.threads.find(thread => thread.id === state.activeThreadId)?.requests.map(request => ({ kind: request.kind, text: request.text.slice(0, 120) })) ?? []
    })

    // A write needs a person under approval-required, and the CLI must ask Sotto rather than deny it.
    await prompt.fill('Create a file named surface.txt containing the word banana in this directory, using the Write tool. Do not ask first, just do it.')
    await page.getByRole('button', { name: 'Send prompt', exact: true }).click()
    await expect.poll(async () => (await requests()).map(request => request.kind), { timeout: 120_000 }).toContain('permission')
    const permission = page.locator('.agent-request').first()
    await expect(permission.getByRole('button', { name: 'Allow once' })).toBeVisible()
    await page.screenshot({ path: join(artifacts, 'claude-permission-reaches-the-user.png') })
    await permission.getByRole('button', { name: 'Deny' }).click()
    await expect.poll(async () => (await requests()).length, { timeout: 60_000 }).toBe(0)

    // AskUserQuestion exists only where there is a surface, so a real question card is the proof of it.
    await expect(prompt).toHaveValue('', { timeout: 60_000 })
    await prompt.fill('Use the AskUserQuestion tool right now to ask me which cache to use, offering Redis, Memcached and In-memory. Ask only; change nothing.')
    await page.getByRole('button', { name: 'Send prompt', exact: true }).click()
    await expect.poll(async () => (await requests()).map(request => request.kind), { timeout: 120_000 }).toContain('question')
    const question = page.locator('.agent-request').first()
    await expect(question.getByRole('button', { name: /^Send answers?$/u })).toBeVisible()
    await page.screenshot({ path: join(artifacts, 'claude-question-reaches-the-user.png') })
    // The evidence a verification note cites.
    console.info(`approval surface live: ${JSON.stringify({ ...connection, requests: await requests() })}`)
  } finally {
    await app?.close()
  }
})
