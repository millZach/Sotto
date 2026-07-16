import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createStorageRepositories } from '../../src/main/storage/repositories'
import { RecoveryNoticeCenter } from '../../src/main/storage/recoveryNoticeCenter'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'

const roots: string[] = []

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'talktype-recovery-flow-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('storage recovery notice flow', () => {
  it('launches with defaults, preserves both corrupt stores, and retains only safe notices', async () => {
    const root = await fixtureRoot()
    const settingsBytes = Buffer.from('{"microphoneId":"private-device",', 'utf8')
    const historyBytes = Buffer.from('[{"text":"private transcript content"}', 'utf8')
    await writeFile(join(root, 'settings.json'), settingsBytes)
    await writeFile(join(root, 'history.json'), historyBytes)
    const notices = new RecoveryNoticeCenter()
    const repositories = createStorageRepositories(root, notices, () => 1_725_000_000_024)

    await expect(repositories.settings.get()).resolves.toEqual(DEFAULT_SETTINGS)
    await expect(repositories.history.list({ enabled: true })).resolves.toEqual([])

    const names = await readdir(root)
    const settingsBackup = names.find((name) => name.startsWith('settings.json.corrupt-'))
    const historyBackup = names.find((name) => name.startsWith('history.json.corrupt-'))
    expect(settingsBackup).toBeDefined()
    expect(historyBackup).toBeDefined()
    expect(await readFile(join(root, settingsBackup!))).toEqual(settingsBytes)
    expect(await readFile(join(root, historyBackup!))).toEqual(historyBytes)
    expect(notices.list()).toEqual([
      { code: 'SETTINGS_RECOVERED' },
      { code: 'HISTORY_RECOVERED' },
    ])
    expect(JSON.stringify(notices.list())).not.toContain(root)
    expect(JSON.stringify(notices.list())).not.toContain('private transcript content')
  })

  it('does not read, recover, back up, or report corrupt history while history is disabled', async () => {
    const root = await fixtureRoot()
    const historyBytes = Buffer.from('[{"text":"private disabled transcript"}', 'utf8')
    await writeFile(join(root, 'history.json'), historyBytes)
    const notices = new RecoveryNoticeCenter()
    const repositories = createStorageRepositories(root, notices, () => 1_725_000_000_025)

    await expect(repositories.history.list({ enabled: false })).resolves.toEqual([])

    expect(await readFile(join(root, 'history.json'))).toEqual(historyBytes)
    expect(await readdir(root)).toEqual(['history.json'])
    expect(notices.list()).toEqual([])
  })
})
