import { promptField } from './support/prompt'
import { buildSshHost } from './support/sshHost'
import { ownedE2EProfile } from './support/e2eProfile'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { REMOTE_PERMISSION_DENIED } from '../../src/main/agents/authority'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, launchSotto, openPage, openThreads, type LaunchedSotto } from './support/sottoLaunch'

test('opening a remote thread keeps a disabled voice coordinator dormant', async () => {
  test.setTimeout(180_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-disabled-coordinator-' })).directory
  const root = join(profile, 'ssh-root')
  await mkdir(root, { recursive: true })
  const install = join(root, '~', '.local', 'share', 'sotto-host', 'host')
  await buildSshHost(install)
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true,
    localHostEnabled: true, voiceCoordinatorEnabled: false, reducedMotion: 'on' }))
  const modeFile = join(root, 'mode')
  await writeFile(modeFile, 'run')
  const keys = ['SOTTO_E2E_SSH_SCRIPT', 'SOTTO_E2E_SSH_EXECUTABLE', 'FAKE_SSH_MODE_FILE', 'FAKE_SSH_ROOT', 'FAKE_SSH_RECORD']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  Object.assign(process.env, { SOTTO_E2E_SSH_SCRIPT: resolve('tests/fixtures/fakeSsh.mjs'), SOTTO_E2E_SSH_EXECUTABLE: process.execPath,
    FAKE_SSH_MODE_FILE: modeFile, FAKE_SSH_ROOT: root, FAKE_SSH_RECORD: join(root, 'ssh.jsonl') })
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto('success', profile)
    const { page } = launched
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const localThread = await page.evaluate(async () => {
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, wakeModelDirectory: 'C:/local/wake', wakeRuntimeDirectory: 'C:/local/runtime' } })
      await window.sotto!.agents!.command({ type: 'connect', provider: 'claude' })
      const state = await window.sotto!.agents!.get()
      return state.host.threads.find(thread => thread.title === 'Workshop')!.id
    })
    await openPage(page, 'Settings')
    await page.getByRole('tab', { name: 'Hosts', exact: true }).click()
    await page.getByRole('button', { name: 'Add host', exact: true }).click()
    const form = page.getByRole('dialog', { name: 'Add host' })
    await form.getByRole('combobox', { name: 'Device' }).focus()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await form.getByRole('textbox', { name: 'SSH host' }).fill('forge')
    await form.getByRole('radio', { name: 'Add it', exact: true }).check()
    await form.getByRole('button', { name: 'Add host', exact: true }).click()
    const connected = page.getByRole('dialog', { name: 'forge is connected' })
    await expect(connected).toBeVisible({ timeout: 90_000 })
    await connected.getByRole('button', { name: 'Done' }).click()
    const remoteThread = await page.evaluate(async folder => {
      const hostId = (await window.sotto!.hosts!.get()).hosts.find(host => host.name === 'forge')!.hostId!
      await window.sotto!.hosts!.command({ type: 'select', hostId })
      const projects = await window.sotto!.agents!.command({ type: 'create-project', provider: 'codex', title: 'Remote voice regression', path: folder, useExisting: true })
      const project = projects.host.projects.find(item => item.path === folder)!
      const model = (await window.sotto!.agents!.get()).host.models.find(item => item.providerId === 'codex')!
      const created = await window.sotto!.agents!.command({ type: 'create-thread', projectId: project.id, modelId: model.id,
        title: 'Remote voice regression', managed: false })
      if (created.error) throw new Error(created.error)
      return created.host.threads.find(item => item.title === 'Remote voice regression')!.id
    }, root)
    await openThreads(page)
    await page.evaluate(async threadId => window.sotto!.agents!.command({ type: 'select-thread', threadId }), localThread)
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.agents!.get()).activeThreadId)).toBe(localThread)
    await page.getByRole('button', { name: 'Remote voice regression', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.agents!.get()).activeThreadId)).toBe(remoteThread)
    await expect(promptField(page)).toBeVisible()
    expect(await page.evaluate(async () => (await window.sotto!.agents!.get()).error)).toBeNull()
    await expect(page.getByText(REMOTE_PERMISSION_DENIED)).toHaveCount(0)
    await expect(page.locator('.thread-workspace__error')).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath('disabled-coordinator-remote-thread.png'), animations: 'disabled' })
    expect(errors).toEqual([])
  } finally {
    const descriptor = await readFile(join(root, '~', '.sotto', 'host-listener.json'), 'utf8').then(text => JSON.parse(text) as { pid?: number }, () => undefined)
    if (descriptor?.pid) { try { process.kill(descriptor.pid) } catch { /* already gone */ } }
    if (launched) await closeSotto(launched)
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
