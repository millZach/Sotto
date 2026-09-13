// @vitest-environment node
import { mkdir, mkdtemp, readFile, rename, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentCredentials, type CredentialEncryption } from '../../../src/main/agents/credentials'
import { AgentMembershipClient } from '../../../src/main/agents/membership'
import { SecureSettings } from '../../../src/main/agents/secureSettings'
import { SettingsRepository } from '../../../src/main/storage/settingsRepository'
import { NativeSettingsCoordinator } from '../../../src/main/settings/nativeSettingsCoordinator'

const roots: string[] = []
const START = Date.parse('2026-09-09T12:00:00.000Z')
const SERVICE = 'https://membership.sotto.example'
const TOKEN = 'fixture-desktop-account-token'
const iso = (milliseconds: number): string => new Date(milliseconds).toISOString()

// This stand-in replaces only the operating system encryption effect. Tests
// exercise the real credential repository, disk writes, and membership client.
class FixtureEncryption implements CredentialEncryption {
  unlocked = true
  failWrites = false
  isEncryptionAvailable(): boolean { return this.unlocked }
  encryptString(value: string): Buffer {
    if (this.failWrites) throw new Error('Fixture OS encryption is unavailable')
    return Buffer.from(Buffer.from(value).map(byte => byte ^ 0xa5))
  }
  decryptString(value: Buffer): string { return Buffer.from(value.map(byte => byte ^ 0xa5)).toString('utf8') }
}

async function directory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'sotto-membership-contract-'))
  roots.push(value)
  return value
}

async function fixture() {
  const root = await directory()
  const encryption = new FixtureEncryption()
  const credentials = new AgentCredentials(root, encryption)
  await credentials.load()
  const clock = { now: START }
  const configuration = { membershipEndpoint: SERVICE }
  const service = {
    offline: false, entitlementStatus: 200,
    deviceUri: SERVICE + '/activate?user_code=ABCD-EFGH',
    checkoutUri: 'https://checkout.stripe.com/c/pay/fixture', portalUri: 'https://billing.stripe.com/p/session/fixture',
    deviceStatus: 'authorized' as 'authorized' | 'pending' | 'slow_down' | 'expired' | 'denied',
    entitlement: { status: 'active' as 'active' | 'expired' | 'free', expiresAt: iso(START + 30 * 86_400_000),
      cacheUntil: iso(START + 3_600_000), cancelAtPeriodEnd: false },
    accessToken: TOKEN, tokenExpiresAt: iso(START + 30 * 86_400_000),
  }
  const requests: { url: string; method: string; authorization: string | null; body: unknown; redirect: string | undefined }[] = []
  const opened: string[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const parsed = new URL(url)
    const headers = new Headers(init?.headers)
    requests.push({ url, method: init?.method ?? 'GET', authorization: headers.get('authorization'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null, redirect: init?.redirect })
    if (service.offline) throw new TypeError('Fixture network disconnected')
    if (parsed.origin !== SERVICE) throw new Error('A credential must not be sent to another origin')
    if (parsed.pathname === '/v1/device/authorize') return Response.json({
      deviceCode: 'fixture-secret-device-code', userCode: 'ABCD-EFGH', verificationUri: service.deviceUri, expiresIn: 600, interval: 5,
    })
    if (parsed.pathname === '/v1/device/token') return Response.json(service.deviceStatus === 'authorized' ?
      { status: 'authorized', accessToken: service.accessToken, expiresAt: service.tokenExpiresAt } : { status: service.deviceStatus })
    if (parsed.pathname === '/v1/entitlement') return Response.json(service.entitlement, { status: service.entitlementStatus })
    if (parsed.pathname === '/v1/billing/checkout') return Response.json({ url: service.checkoutUri })
    if (parsed.pathname === '/v1/billing/portal') return Response.json({ url: service.portalUri })
    throw new Error('Unexpected membership contract endpoint')
  })
  const makeClient = (vault = credentials, isPackaged = true) => new AgentMembershipClient({ configuration: () => configuration, credentials: vault, directory: root,
    isPackaged, now: () => clock.now, openExternal: async url => { opened.push(url) } })
  const client = makeClient()
  const signIn = async () => {
    await client.action('signin')
    clock.now += 5_000
    return client.status()
  }
  return { root, encryption, credentials, clock, configuration, service, requests, opened, client, signIn, makeClient }
}

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-membership-contract-')) throw new Error('Unexpected temporary test directory')
    await rm(root, { recursive: true, force: true })
  }
})

describe('desktop membership external contract', () => {
  it('completes browser device sign-in and keeps account credentials out of browser URLs, public state, and plaintext storage', async () => {
    const f = await fixture()
    const pending = await f.client.action('signin')
    expect(pending.status).toBe('free')
    expect(pending.label).toContain('ABCD-EFGH')
    expect(f.opened).toEqual([SERVICE + '/activate?user_code=ABCD-EFGH'])
    expect(f.requests[0]).toEqual({ url: SERVICE + '/v1/device/authorize', method: 'POST', authorization: null,
      body: { clientName: 'Sotto desktop' }, redirect: 'error' })
    f.clock.now += 5_000
    const active = await f.client.status()
    expect(active).toMatchObject({ status: 'active', expiresAt: '2026-09-09T13:00:00.000Z' })
    expect(f.requests.find(request => request.url.endsWith('/v1/device/token'))?.body).toEqual({ deviceCode: 'fixture-secret-device-code' })
    expect(f.requests.find(request => request.url.endsWith('/v1/entitlement'))?.authorization).toBe('Bearer fixture-desktop-account-token')
    expect(JSON.stringify(active)).not.toContain(TOKEN)
    expect(f.opened.join(' ')).not.toContain(TOKEN)
    const stored = await readFile(join(f.root, 'credentials.json'), 'utf8')
    expect(stored).not.toContain(TOKEN)
    expect(stored).not.toContain('fixture-secret-device-code')
    expect(stored).not.toContain('accessToken')
    const reloaded = new AgentCredentials(f.root, f.encryption)
    await reloaded.load()
    expect(reloaded.has('membership')).toBe(true)
  })

  it('does not restore a revoked lease when secure cache persistence fails and the service then goes offline', async () => {
    const f = await fixture()
    expect((await f.signIn()).status).toBe('active')
    f.service.entitlement.status = 'expired'
    f.encryption.failWrites = true
    expect((await f.client.status()).status).toBe('expired')
    f.encryption.failWrites = false
    f.service.offline = true
    expect((await f.client.status()).status).not.toBe('active')
    const reloaded = new AgentCredentials(f.root, f.encryption)
    await reloaded.load()
    expect((await f.makeClient(reloaded).status()).status).not.toBe('active')
  })

  it('recovers a bounded offline lease across restart, expires it, and applies renewal and scheduled cancellation from the service', async () => {
    const f = await fixture()
    expect((await f.signIn()).expiresAt).toBe('2026-09-09T13:00:00.000Z')
    f.service.offline = true
    f.clock.now = Date.parse('2026-09-09T12:30:00.000Z')
    const reloaded = new AgentCredentials(f.root, f.encryption)
    await reloaded.load()
    const resumed = f.makeClient(reloaded)
    expect(await resumed.status()).toMatchObject({ status: 'active', expiresAt: '2026-09-09T13:00:00.000Z', label: expect.stringContaining('offline') })
    f.clock.now = Date.parse('2026-09-09T13:00:00.000Z')
    expect((await resumed.status()).status).toBe('unavailable')
    f.service.offline = false
    f.service.entitlement.cacheUntil = '2026-09-09T14:00:00.000Z'
    expect(await resumed.status()).toMatchObject({ status: 'active', expiresAt: '2026-09-09T14:00:00.000Z' })
    f.service.entitlement.cancelAtPeriodEnd = true
    f.service.entitlement.expiresAt = '2026-09-09T13:45:00.000Z'
    expect(await resumed.status()).toMatchObject({ status: 'active', expiresAt: '2026-09-09T13:45:00.000Z', label: expect.stringContaining('cancellation scheduled') })
    f.clock.now = Date.parse('2026-09-09T13:45:00.000Z')
    f.service.offline = true
    expect((await resumed.status()).status).toBe('unavailable')
    f.service.offline = false
    f.service.entitlement.status = 'expired'
    expect((await resumed.status()).status).toBe('expired')
  })

  it('rejects untrusted browser destinations and never treats hosted checkout as a paid entitlement', async () => {
    const f = await fixture()
    f.service.deviceUri = 'https://membership.sotto.example.attacker.invalid/activate'
    await expect(f.client.action('signin')).rejects.toThrow('untrusted browser destination')
    expect(f.opened).toEqual([])
    expect(f.credentials.has('membership')).toBe(false)
    f.service.deviceUri = SERVICE + '/activate'
    f.service.entitlement.status = 'free'
    expect((await f.signIn()).status).toBe('free')
    f.service.checkoutUri = 'https://checkout.stripe.com.attacker.invalid/pay'
    await expect(f.client.action('checkout')).rejects.toThrow('untrusted browser destination')
    expect(f.opened).toEqual([SERVICE + '/activate'])
    f.service.checkoutUri = 'https://checkout.stripe.com/c/pay/fixture'
    expect((await f.client.action('checkout')).status).toBe('free')
    expect(f.opened.at(-1)).toBe('https://checkout.stripe.com/c/pay/fixture')
    f.service.portalUri = 'https://credential@billing.stripe.com/p/session/fixture'
    await expect(f.client.action('portal')).rejects.toThrow('untrusted browser destination')
    f.service.portalUri = 'https://billing.stripe.com/p/session/fixture'
    await f.client.action('portal')
    expect(f.opened.at(-1)).toBe('https://billing.stripe.com/p/session/fixture')
    expect(f.requests.filter(request => request.url.includes('/v1/billing/')).every(request => request.redirect === 'error')).toBe(true)
  })

  it('binds credentials to the service origin and revokes cached access after an authentication rejection', async () => {
    const f = await fixture()
    expect((await f.signIn()).status).toBe('active')
    const priorRequestCount = f.requests.length
    f.configuration.membershipEndpoint = 'https://different-service.example'
    expect((await f.client.status()).status).toBe('free')
    expect(f.requests).toHaveLength(priorRequestCount)
    await expect(f.client.action('portal')).rejects.toThrow('Sign in')
    f.configuration.membershipEndpoint = SERVICE
    f.service.entitlementStatus = 401
    expect((await f.client.status()).status).toBe('free')
    expect(f.credentials.has('membership')).toBe(false)
    expect(f.credentials.has('membership-cache')).toBe(false)
    f.service.offline = true
    expect((await f.client.status()).status).toBe('free')
    const reloaded = new AgentCredentials(f.root, f.encryption)
    await reloaded.load()
    expect((await f.makeClient(reloaded).status()).status).toBe('free')
  })

  it('honors device polling backoff, denial, and expiry without manufacturing account access', async () => {
    const f = await fixture()
    f.service.deviceStatus = 'slow_down'
    expect((await f.signIn()).status).toBe('free')
    const tokenRequests = () => f.requests.filter(request => request.url.endsWith('/v1/device/token')).length
    expect(tokenRequests()).toBe(1)
    f.clock.now += 5_000
    await f.client.status()
    expect(tokenRequests()).toBe(1)
    f.clock.now += 5_000
    f.service.deviceStatus = 'denied'
    expect((await f.client.status()).label).toContain('declined')
    expect(tokenRequests()).toBe(2)
    f.clock.now += 20_000
    await f.client.status()
    expect(tokenRequests()).toBe(2)
    expect(f.credentials.has('membership')).toBe(false)
    await f.client.action('signin')
    f.clock.now += 601_000
    expect((await f.client.status()).label).toContain('expired')
    expect(tokenRequests()).toBe(2)
  })

  it('caps service-issued offline access and refuses cached access after a clock rollback', async () => {
    const f = await fixture()
    f.service.entitlement.cacheUntil = '2026-09-20T00:00:00.000Z'
    expect(await f.signIn()).toMatchObject({ status: 'active', expiresAt: '2026-09-10T12:00:05.000Z' })
    f.service.offline = true
    f.clock.now = START - 120_000
    expect((await f.client.status()).status).toBe('unavailable')
    f.clock.now = Date.parse('2026-09-10T12:00:05.000Z')
    expect((await f.client.status()).status).toBe('unavailable')
  })

  it('keeps packaged no-service access free, labels development beta, and sends nothing to insecure endpoints', async () => {
    const f = await fixture()
    f.configuration.membershipEndpoint = ''
    expect((await f.client.status()).status).toBe('free')
    expect(await f.makeClient(f.credentials, false).status()).toMatchObject({ status: 'beta', label: expect.stringContaining('Private development beta') })
    await expect(f.client.action('checkout')).rejects.toThrow('not configured')
    f.configuration.membershipEndpoint = 'http://membership.sotto.example'
    expect((await f.client.status()).status).toBe('unavailable')
    await expect(f.client.action('signin')).rejects.toThrow('HTTPS')
    expect(f.requests).toEqual([])
    expect(f.opened).toEqual([])
  })

  it('never extends entitlement beyond account-session expiry or carries paid cache into a new sign-in', async () => {
    const f = await fixture()
    f.service.tokenExpiresAt = '2026-09-09T12:30:00.000Z'
    expect(await f.signIn()).toMatchObject({ status: 'active', expiresAt: '2026-09-09T12:30:00.000Z' })
    f.clock.now = Date.parse('2026-09-09T12:30:00.000Z')
    f.service.offline = true
    expect((await f.client.status()).status).toBe('free')
    f.service.offline = false
    f.service.accessToken = 'fixture-other-account-token'
    f.service.tokenExpiresAt = '2026-09-30T00:00:00.000Z'
    f.service.entitlementStatus = 503
    expect((await f.signIn()).status).toBe('unavailable')
    f.service.offline = true
    expect((await f.client.status()).status).toBe('unavailable')
    expect(f.requests.filter(request => request.url.endsWith('/v1/entitlement')).at(-1)?.authorization).toBe('Bearer fixture-other-account-token')
  })
})

describe('credential storage and formatting migration', () => {
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
      f.credentials.set('membership', 'fixture-membership-secret'),
    ])
    const reloaded = new AgentCredentials(f.root, f.encryption)
    await reloaded.load()
    expect(reloaded.get('grokSpeech')).toBe('fixture-speech-secret')
    expect(reloaded.get('reasoning')).toBe('fixture-reasoning-secret')
    expect(reloaded.get('membership')).toBe('fixture-membership-secret')
    const stored = await readFile(join(f.root, 'credentials.json'), 'utf8')
    expect(stored).not.toContain('fixture-speech-secret')
    expect(stored).not.toContain('fixture-reasoning-secret')
    expect(stored).not.toContain('fixture-membership-secret')
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

  it('keeps an unmigrated key recoverable while encryption is locked without exposing it through renderer settings', async () => {
    const f = await fixture()
    const repository = new SettingsRepository(join(f.root, 'settings.json'))
    await repository.update({ llmApiKey: 'fixture-unmigrated-key' })
    const settings = new SecureSettings(repository, f.credentials)
    f.encryption.unlocked = false
    await expect(settings.migrate()).rejects.toThrow('unavailable')
    expect((await repository.get()).llmApiKey).toBe('fixture-unmigrated-key')
    expect((await settings.get()).llmApiKey).toBe('')
    expect((await settings.forFormatting()).llmApiKey).toBe('')
    f.encryption.unlocked = true
    await settings.migrate()
    expect((await repository.get()).llmApiKey).toBe('')
    expect((await settings.forFormatting()).llmApiKey).toBe('fixture-unmigrated-key')
    await settings.reset()
    expect((await settings.get()).llmApiKey).toBe('')
    expect(f.credentials.has('formatting')).toBe(false)
  })
})
