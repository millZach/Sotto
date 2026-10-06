// @vitest-environment node
import { mkdir, mkdtemp, readFile, rename, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentCredentials, type CredentialEncryption } from '../../../src/main/agents/credentials'
import { SecureSettings } from '../../../src/main/agents/secureSettings'
import { SettingsRepository } from '../../../src/main/storage/settingsRepository'
import { NativeSettingsCoordinator } from '../../../src/main/settings/nativeSettingsCoordinator'

const roots: string[] = []
class FixtureEncryption implements CredentialEncryption {
  unlocked = true
  failWrites = false
  failReads = false
  isEncryptionAvailable(): boolean { return this.unlocked }
  encryptString(value: string): Buffer {
    if (this.failWrites) throw new Error('Fixture OS encryption is unavailable')
    return Buffer.from(Buffer.from(value).map(byte => byte ^ 0xa5))
  }
  decryptString(value: Buffer): string {
    if (this.failReads) throw new Error('Fixture Keychain access was denied')
    return Buffer.from(value.map(byte => byte ^ 0xa5)).toString('utf8')
  }
}

async function directory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'sotto-credential-storage-'))
  roots.push(value)
  return value
}

async function fixture() {
  const root = await directory()
  const encryption = new FixtureEncryption()
  const credentials = new AgentCredentials(root, encryption)
  await credentials.load()
  return { root, encryption, credentials }
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir())) throw new Error('Unexpected temporary test directory')
    await rm(root, { recursive: true, force: true })
  }
})
describe('credential storage and formatting migration', () => {
  it.each(['success', 'repository failure', 'verification failure', 'locked vault'])('keeps the saved key through reset with %s', async outcome => {
    const f = await fixture()
    const settingsPath = join(f.root, 'settings.json')
    const repository = new SettingsRepository(settingsPath)
    const settings = new SecureSettings(repository, f.credentials)
    const previous = await settings.update({ llmApiKey: 'fixture-reset-key', theme: 'light' })
    const reset = repository.reset.bind(repository)
    vi.spyOn(repository, 'reset').mockImplementation(async () => {
      if (outcome === 'repository failure') throw new Error('Fixture reset failed')
      const result = await reset()
      return outcome === 'verification failure' ? { ...result, autoPaste: !result.autoPaste } : result
    })
    if (outcome === 'locked vault') f.encryption.unlocked = false
    const vaultWrite = vi.spyOn(f.credentials, 'set')
    const coordinator = new NativeSettingsCoordinator({
      repository: settings,
      hotkeys: { current: () => previous.hotkey, replace: () => ({ ok: true }) },
      startup: { get: () => ({ enabled: false }), set: enabled => ({ enabled }) },
      onAutoPasteChanged: () => undefined,
      onSettingsChanged: () => undefined,
    })
    if (outcome.includes('failure')) {
      await expect(coordinator.resetSettings()).rejects.toThrow('Native settings transaction failed')
      expect((await coordinator.getSettings()).theme).toBe('light')
    } else {
      expect((await coordinator.resetSettings()).llmApiKey).toContain('operating system credential store')
    }
    expect(vaultWrite).not.toHaveBeenCalled()
    f.encryption.unlocked = true
    const reloaded = new AgentCredentials(f.root, f.encryption)
    await reloaded.load()
    expect(reloaded.get('formatting')).toBe('fixture-reset-key')
    expect(await readFile(settingsPath, 'utf8')).not.toContain('fixture-reset-key')
  })

  it('restores the previous secure key when the real settings file cannot be replaced', async () => {
    const f = await fixture()
    const settingsPath = join(f.root, 'settings.json')
    const preservedPath = join(f.root, 'settings-before-failure.json')
    const settings = new SecureSettings(new SettingsRepository(settingsPath), f.credentials)
    const previous = await settings.update({ llmApiKey: 'fixture-original-key', theme: 'light' })
    // A directory at the destination makes the actual atomic rename fail. The
    // independent credential file remains writable so rollback is exercised.
    await rename(settingsPath, preservedPath)
    await mkdir(settingsPath)
    await expect(settings.save({ ...previous, llmApiKey: 'fixture-rejected-key', theme: 'dark' })).rejects.toThrow()
    await rmdir(settingsPath)
    await rename(preservedPath, settingsPath)
    const reloaded = new AgentCredentials(f.root, f.encryption)
    await reloaded.load()
    expect(reloaded.get('formatting')).toBe('fixture-original-key')
    expect((await settings.forFormatting()).theme).toBe('light')
    expect(JSON.stringify(await settings.get())).not.toContain('fixture-original-key')
    expect(await readFile(settingsPath, 'utf8')).not.toContain('fixture-rejected-key')
  })

  it('rolls back the secure key with a failed native auto-paste settings transaction', async () => {
    const f = await fixture()
    const settings = new SecureSettings(new SettingsRepository(join(f.root, 'settings.json')), f.credentials)
    const previous = await settings.update({ llmApiKey: 'fixture-previous-native-key', autoPaste: true })
    const nativeAutoPaste: boolean[] = []
    const coordinator = new NativeSettingsCoordinator({
      repository: settings,
      hotkeys: { current: () => previous.hotkey, replace: () => ({ ok: true }) },
      startup: { get: () => ({ enabled: false }), set: enabled => ({ enabled }) },
      onAutoPasteChanged: enabled => {
        nativeAutoPaste.push(enabled)
        if (!enabled) throw new Error('Fixture native tray update failed')
      },
      onSettingsChanged: () => undefined,
    })
    await expect(coordinator.updateSettings({ llmApiKey: 'fixture-rejected-native-key', autoPaste: false })).rejects.toThrow('Native settings transaction failed')
    const reloaded = new AgentCredentials(f.root, f.encryption)
    await reloaded.load()
    expect(reloaded.get('formatting')).toBe('fixture-previous-native-key')
    expect((await coordinator.getSettings()).autoPaste).toBe(true)
    expect(nativeAutoPaste.at(-1)).toBe(true)
  })

  it('preserves independent concurrent credential writes and decrypts them only through the native vault after restart', async () => {
    const f = await fixture()
    await Promise.all([
      f.credentials.set('grokSpeech', 'fixture-speech-secret'),
      f.credentials.set('reasoning', 'fixture-reasoning-secret'),
      f.credentials.set('independent', 'fixture-independent-secret'),
    ])
    const reloaded = new AgentCredentials(f.root, f.encryption)
    await reloaded.load()
    expect(reloaded.get('grokSpeech')).toBe('fixture-speech-secret')
    expect(reloaded.get('reasoning')).toBe('fixture-reasoning-secret')
    expect(reloaded.get('independent')).toBe('fixture-independent-secret')
    const stored = await readFile(join(f.root, 'credentials.json'), 'utf8')
    expect(stored).not.toContain('fixture-speech-secret')
    expect(stored).not.toContain('fixture-reasoning-secret')
    expect(stored).not.toContain('fixture-independent-secret')
    f.encryption.unlocked = false
    expect(() => reloaded.get('reasoning')).toThrow('Unlock')
    await expect(reloaded.set('reasoning', 'replacement-secret')).rejects.toThrow('unavailable')
    f.encryption.unlocked = true
    expect(reloaded.get('reasoning')).toBe('fixture-reasoning-secret')
  })

  it('migrates legacy formatting keys off settings disk and never returns decrypted keys through public settings operations', async () => {
    const f = await fixture()
    const settingsPath = join(f.root, 'settings.json')
    const repository = new SettingsRepository(settingsPath)
    await repository.update({ llmApiKey: 'fixture-legacy-formatting-key', llmFormatting: true })
    const settings = new SecureSettings(repository, f.credentials)
    await Promise.all([settings.migrate(), f.credentials.set('reasoning', 'fixture-independent-reasoning-key')])
    expect((await settings.forFormatting()).llmApiKey).toBe('fixture-legacy-formatting-key')
    expect(f.credentials.get('reasoning')).toBe('fixture-independent-reasoning-key')
    const publicSettings = await settings.get()
    expect(publicSettings.llmApiKey).toContain('operating system credential store')
    expect(JSON.stringify(publicSettings)).not.toContain('fixture-legacy-formatting-key')
    expect(await readFile(settingsPath, 'utf8')).not.toContain('fixture-legacy-formatting-key')
    expect(await readFile(join(f.root, 'credentials.json'), 'utf8')).not.toContain('fixture-legacy-formatting-key')
    const saved = await settings.save({ ...publicSettings, theme: 'dark' })
    expect(saved.theme).toBe('dark')
    expect((await settings.forFormatting()).llmApiKey).toBe('fixture-legacy-formatting-key')
    const updated = await settings.update({ llmApiKey: 'fixture-replacement-formatting-key' })
    expect(JSON.stringify(updated)).not.toContain('fixture-replacement-formatting-key')
    expect((await settings.forFormatting()).llmApiKey).toBe('fixture-replacement-formatting-key')
    expect(await readFile(settingsPath, 'utf8')).not.toContain('fixture-replacement-formatting-key')
    const cleared = await settings.update({ llmApiKey: '' })
    expect(cleared.llmApiKey).toBe('')
    expect((await settings.forFormatting()).llmApiKey).toBe('')
    expect(f.credentials.has('formatting')).toBe(false)
  })

  it.each(['locked', 'write failure'])('removes a legacy plaintext key after vault %s and asks for re-entry', async failure => {
    const f = await fixture()
    const settingsPath = join(f.root, 'settings.json')
    const repository = new SettingsRepository(settingsPath)
    await repository.update({ llmApiKey: 'fixture-unmigrated-key' })
    const settings = new SecureSettings(repository, f.credentials)
    f.encryption.unlocked = failure !== 'locked'
    f.encryption.failWrites = failure === 'write failure'
    const onStorageFailure = vi.fn()
    await expect(settings.migrate(onStorageFailure)).rejects.toThrow()
    expect(onStorageFailure).toHaveBeenCalledOnce()
    expect((await repository.get()).llmApiKey).toBe('')
    expect(await readFile(settingsPath, 'utf8')).not.toContain('fixture-unmigrated-key')
    expect((await settings.get()).llmApiKey).toBe('')
    f.encryption.unlocked = true
    f.encryption.failWrites = false
    await settings.migrate(onStorageFailure)
    expect(onStorageFailure).toHaveBeenCalledOnce()
    expect((await settings.forFormatting()).llmApiKey).toBe('')
    await settings.update({ llmApiKey: 'fixture-reentered-key' })
    expect((await settings.forFormatting()).llmApiKey).toBe('fixture-reentered-key')
  })

  it('keeps a saved key it cannot decrypt, says so, and still accepts a replacement', async () => {
    const f = await fixture()
    const credentialsPath = join(f.root, 'credentials.json')
    const onKeyUnreadable = vi.fn()
    const settings = new SecureSettings(new SettingsRepository(join(f.root, 'settings.json')), f.credentials, onKeyUnreadable)
    await settings.update({ llmApiKey: 'fixture-keychain-key' })
    const sealed = await readFile(credentialsPath, 'utf8')

    // A denied Keychain prompt on macOS: storage still reports available, decryption fails.
    f.encryption.failReads = true
    await expect(settings.forFormatting()).rejects.toThrow('denied')
    expect(onKeyUnreadable).toHaveBeenCalledOnce()
    expect(await readFile(credentialsPath, 'utf8')).toBe(sealed)
    expect(f.credentials.has('formatting')).toBe(true)
    expect((await settings.get()).llmApiKey).toContain('operating system credential store')

    // Allowing access later reads the same key back.
    f.encryption.failReads = false
    expect((await settings.forFormatting()).llmApiKey).toBe('fixture-keychain-key')

    // Entering the key again works even while the old one stays unreadable.
    f.encryption.failReads = true
    await settings.update({ llmApiKey: 'fixture-reentered-keychain-key' })
    f.encryption.failReads = false
    expect((await settings.forFormatting()).llmApiKey).toBe('fixture-reentered-keychain-key')
  })
})
