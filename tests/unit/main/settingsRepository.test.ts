import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { SettingsRepository } from '../../../src/main/storage/settingsRepository'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../src/shared/settings'

const roots: string[] = []

async function createRepository(
  now: () => number = Date.now,
): Promise<{ filePath: string; repository: SettingsRepository }> {
  const root = await mkdtemp(join(tmpdir(), 'talktype-settings-repository-'))
  roots.push(root)
  const filePath = join(root, 'settings.json')
  return { filePath, repository: new SettingsRepository(filePath, { now }) }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('SettingsRepository', () => {
  it('returns fresh defaults for a missing settings file without creating it', async () => {
    const { repository } = await createRepository()

    const first = await repository.get()
    const second = await repository.get()

    expect(first).toEqual(DEFAULT_SETTINGS)
    expect(first).not.toBe(DEFAULT_SETTINGS)
    expect(second).not.toBe(first)
    first.theme = 'dark'
    expect(second.theme).toBe(DEFAULT_SETTINGS.theme)
    expect(await repository.exists()).toBe(false)
  })

  it('persists a valid field for a new repository instance', async () => {
    const { filePath, repository } = await createRepository()

    await repository.save({ theme: 'dark' })

    const reloaded = await new SettingsRepository(filePath).get()
    expect(reloaded.theme).toBe('dark')
    expect(reloaded.hotkey).toBe(DEFAULT_SETTINGS.hotkey)
    expect(await repository.exists()).toBe(true)
  })

  it('recovers only invalid fields from otherwise valid persisted JSON', async () => {
    const { filePath, repository } = await createRepository()
    await writeFile(
      filePath,
      JSON.stringify({ theme: 'dark', autoPaste: false, pasteDelayMs: -1 }),
      'utf8',
    )

    const settings = await repository.get()

    expect(settings.theme).toBe('dark')
    expect(settings.autoPaste).toBe(false)
    expect(settings.pasteDelayMs).toBe(DEFAULT_SETTINGS.pasteDelayMs)
  })

  it('strips unknown fields when loading valid JSON', async () => {
    const { filePath, repository } = await createRepository()
    await writeFile(
      filePath,
      JSON.stringify({ theme: 'light', cloudCredential: 'must-not-survive' }),
      'utf8',
    )

    const settings = await repository.get()

    expect(settings.theme).toBe('light')
    expect(settings).not.toHaveProperty('cloudCredential')
  })

  it('normalizes save input before persisting and returning it', async () => {
    const { filePath, repository } = await createRepository()

    const saved = await repository.save({
      theme: 'dark',
      pasteDelayMs: 2,
      cloudCredential: 'must-not-persist',
      rawAudio: [1, 2, 3],
    })

    expect(saved.theme).toBe('dark')
    expect(saved.pasteDelayMs).toBe(DEFAULT_SETTINGS.pasteDelayMs)
    expect(saved).not.toHaveProperty('cloudCredential')
    expect(saved).not.toHaveProperty('rawAudio')
    const persisted = await readFile(filePath, 'utf8')
    expect(persisted).not.toContain('cloudCredential')
    expect(persisted).not.toContain('rawAudio')
  })

  it('merges and normalizes updates without discarding untouched settings', async () => {
    const { repository } = await createRepository()
    await repository.save({ theme: 'dark', language: 'fr', autoPaste: true })

    const updated = await repository.update({
      language: 'es',
      autoPaste: false,
      pasteDelayMs: 1_000,
    })

    expect(updated.theme).toBe('dark')
    expect(updated.language).toBe('es')
    expect(updated.autoPaste).toBe(false)
    expect(updated.pasteDelayMs).toBe(1_000)
    expect(await repository.get()).toEqual(updated)
  })

  it('serializes concurrent disjoint updates without losing either patch', async () => {
    const { filePath, repository } = await createRepository()

    await Promise.all([
      repository.update({ theme: 'dark' }),
      repository.update({ soundCues: false }),
    ])

    const persisted = await new SettingsRepository(filePath).get()
    expect(persisted.theme).toBe('dark')
    expect(persisted.soundCues).toBe(false)
  })

  it('makes get observe a previously invoked update', async () => {
    const { repository } = await createRepository()

    const update = repository.update({ theme: 'dark' })
    const get = repository.get()
    const [, observed] = await Promise.all([update, get])

    expect(observed.theme).toBe('dark')
  })

  it('normalizes invalid runtime values supplied through update', async () => {
    const { repository } = await createRepository()
    await repository.save({ theme: 'dark', language: 'fr' })

    const updated = await repository.update({
      theme: 'invalid-theme',
      language: '',
    } as unknown as Partial<AppSettings>)

    expect(updated.theme).toBe(DEFAULT_SETTINGS.theme)
    expect(updated.language).toBe(DEFAULT_SETTINGS.language)
  })

  it('resets persisted settings to a fresh default value', async () => {
    const { repository } = await createRepository()
    await repository.save({ theme: 'dark', language: 'de', onboardingComplete: true })

    const reset = await repository.reset()

    expect(reset).toEqual(DEFAULT_SETTINGS)
    expect(reset).not.toBe(DEFAULT_SETTINGS)
    reset.theme = 'dark'
    expect((await repository.get()).theme).toBe(DEFAULT_SETTINGS.theme)
  })

  it('backs up corrupt JSON and recovers with fresh defaults', async () => {
    const { filePath, repository } = await createRepository(() => 1_725_000_000_003)
    const corruptBytes = Buffer.from('{"theme": "dark",', 'utf8')
    await writeFile(filePath, corruptBytes)

    const settings = await repository.get()

    expect(settings).toEqual(DEFAULT_SETTINGS)
    expect(settings).not.toBe(DEFAULT_SETTINGS)
    const backups = (await readdir(dirname(filePath))).filter((name) =>
      name.startsWith('settings.json.corrupt-1725000000003-'),
    )
    expect(backups).toHaveLength(1)
    expect(await readFile(join(dirname(filePath), backups[0]!))).toEqual(corruptBytes)
    expect(await repository.exists()).toBe(false)
  })

  it('reports one sanitized settings recovery after preserving syntax-corrupt bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'talktype-settings-repository-'))
    roots.push(root)
    const filePath = join(root, 'settings.json')
    const corruptBytes = Buffer.from('{"microphoneId":"private-device",', 'utf8')
    const recoveries: unknown[] = []
    await writeFile(filePath, corruptBytes)
    const repository = new SettingsRepository(filePath, {
      now: () => 1_725_000_000_021,
      onRecovery: (recovery) => recoveries.push(recovery),
    })

    await expect(repository.get()).resolves.toEqual(DEFAULT_SETTINGS)

    const backups = (await readdir(dirname(filePath))).filter((name) =>
      name.startsWith('settings.json.corrupt-1725000000021-'),
    )
    expect(backups).toHaveLength(1)
    expect(await readFile(join(dirname(filePath), backups[0]!))).toEqual(corruptBytes)
    expect(recoveries).toEqual([{ code: 'SETTINGS_RECOVERED' }])
    expect(JSON.stringify(recoveries)).not.toContain(root)
    expect(JSON.stringify(recoveries)).not.toContain('private-device')
  })
})
