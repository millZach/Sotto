// @vitest-environment node
import { X509Certificate } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginAccounts, type BridgeCheck, type PluginCredentials, type SecretCheck } from '../../../../src/main/plugins/accounts'
import { bridgeStatus, checkMailAccount, mailServersOf } from '../../../../src/main/plugins/mail/accounts'
import { BRIDGE_DEFAULT_PORTS, type PluginAccount } from '../../../../src/shared/plugins'
import { BRIDGE_CERTIFICATE, CHANGED_CERTIFICATE } from '../../../fixtures/bridgeCertificates'
import { startFakeImapServer, type FakeImapServer } from '../../../fixtures/fakeImapServer'

/**
 * Proton Mail accounts (ADR-0205, slice 10): reached through Proton Mail Bridge on this computer, at the ports the user
 * gave, with the certificate Bridge showed when the account was added. Every address, password and certificate here
 * is made up, and the Bridge is a stand-in on this computer.
 */
const ADDRESS = 'reader@proton.example'
const PASSWORD = 'made-up bridge password'
const kept = (cert: string): string => new X509Certificate(cert).fingerprint256.replace(/:/gu, '').toLowerCase()
const BRIDGE = kept(BRIDGE_CERTIFICATE.cert), CHANGED = kept(CHANGED_CERTIFICATE.cert)

const closing: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(closing.splice(0).map(close => close())) })

function credentials(): PluginCredentials {
  const slots = new Map<string, string>()
  return { has: slot => slots.has(slot), get: slot => slots.get(slot) ?? '', set: async (slot, value) => { if (value) slots.set(slot, value); else slots.delete(slot) } }
}
async function store(check: (plugin: string, secret: string, address: string | undefined, bridge?: BridgeCheck) => Promise<SecretCheck>) {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-proton-accounts-'))
  closing.push(() => rm(directory, { recursive: true, force: true }))
  const asked = vi.fn(check)
  return { made: new PluginAccounts(directory, { credentials: credentials(), check: asked, now: () => new Date('2026-11-14T08:00:00.000Z') }), asked, directory }
}
async function bridge(certificate = BRIDGE_CERTIFICATE): Promise<FakeImapServer> {
  const fake = await startFakeImapServer({ address: ADDRESS, password: PASSWORD, startTls: certificate, capabilities: ['UIDPLUS'], mailboxes: [{ name: 'INBOX', validity: 1, messages: [] }] })
  closing.push(() => fake.close())
  return fake
}

describe('a Proton Mail account in the record of accounts', () => {
  it('learns Bridge’s certificate when it is added, and keeps it with the ports in a record older builds refuse', async () => {
    const { made, asked, directory } = await store(async () => ({ ok: true, signedInAs: null, certificate: BRIDGE }))
    const added = await made.add({ plugin: 'proton-mail', name: 'Private', secret: PASSWORD, address: ADDRESS, bridge: { imapPort: 1143, smtpPort: 1025 } })
    expect(added.ok).toBe(true)
    expect(asked).toHaveBeenLastCalledWith('proton-mail', PASSWORD, ADDRESS, { ports: { imapPort: 1143, smtpPort: 1025 }, certificate: 'learn' })
    const account = (await made.list())[0]!
    expect(account.bridge).toEqual({ imapPort: 1143, smtpPort: 1025, certificate: BRIDGE })
    // A build from before Proton Mail refuses the whole file rather than drop the account and lose its password.
    const record = JSON.parse(await readFile(join(directory, 'plugin-accounts.json'), 'utf8')) as { version: number }
    expect(record.version).toBe(4)
    expect(JSON.stringify(record)).not.toContain(PASSWORD)
  })

  it('is refused without Bridge’s ports, or without a certificate to keep, and no other plugin takes ports', async () => {
    const { made } = await store(async () => ({ ok: true, signedInAs: null }))
    expect(await made.add({ plugin: 'proton-mail', name: 'Private', secret: PASSWORD, address: ADDRESS })).toEqual({ ok: false, problem: 'refused' })
    expect(await made.add({ plugin: 'proton-mail', name: 'Private', secret: PASSWORD, address: ADDRESS, bridge: BRIDGE_DEFAULT_PORTS })).toEqual({ ok: false, problem: 'refused' })
    expect(await made.add({ plugin: 'gmail', name: 'Personal', secret: 'abcdefghijklmnop', address: ADDRESS, bridge: BRIDGE_DEFAULT_PORTS })).toEqual({ ok: false, problem: 'refused' })
    expect(await made.list()).toEqual([])
  })

  it('checks a new Bridge password with the certificate kept, and trusts a new certificate only once Bridge takes the password', async () => {
    const answers: SecretCheck[] = [{ ok: true, signedInAs: null, certificate: BRIDGE }, { ok: true, signedInAs: null }, { ok: false, problem: 'refused' }, { ok: true, signedInAs: null, certificate: CHANGED }]
    const { made, asked } = await store(async () => answers.shift()!)
    const added = await made.add({ plugin: 'proton-mail', name: 'Private', secret: PASSWORD, address: ADDRESS, bridge: BRIDGE_DEFAULT_PORTS })
    const id = added.ok ? added.accounts[0]!.id : ''
    // Replacing the password trusts nothing new.
    expect((await made.replace({ id, secret: 'made-up new bridge password' })).ok).toBe(true)
    expect(asked).toHaveBeenLastCalledWith('proton-mail', 'made-up new bridge password', ADDRESS, { ports: BRIDGE_DEFAULT_PORTS, certificate: BRIDGE })
    // A Bridge that does not take the password has its certificate trusted by nobody.
    expect(await made.trustCertificate({ id })).toEqual({ ok: false, problem: 'refused' })
    expect((await made.list())[0]!.bridge!.certificate).toBe(BRIDGE)
    const trusted = await made.trustCertificate({ id })
    expect(trusted.ok).toBe(true)
    expect(asked).toHaveBeenLastCalledWith('proton-mail', 'made-up new bridge password', ADDRESS, { ports: BRIDGE_DEFAULT_PORTS, certificate: 'learn' })
    expect((await made.list())[0]!.bridge).toEqual({ ...BRIDGE_DEFAULT_PORTS, certificate: CHANGED })
  })
})

describe('Proton Mail Bridge, asked', () => {
  const account = (port: number, certificate = BRIDGE): PluginAccount => ({ id: '33333333-3333-4333-8333-000000000009', plugin: 'proton-mail', name: 'Private', address: ADDRESS, savedAt: '2026-11-14T08:00:00.000Z', signedInAs: null, on: true, projects: null, bridge: { imapPort: port, smtpPort: 1025, certificate } })

  it('reads and sends from this computer alone, at the ports given, with the certificate kept', () => {
    expect(mailServersOf(account(1144))).toEqual({
      read: { host: '127.0.0.1', port: 1144, startTls: { certificate: BRIDGE } },
      send: { host: '127.0.0.1', port: 1025, startTls: { certificate: BRIDGE } },
    })
    expect(mailServersOf({ ...account(1143), bridge: undefined } as unknown as PluginAccount)).toBeNull()
  })

  it('checks a Bridge password and hands back the certificate to keep, or says another was shown', async () => {
    const fake = await bridge()
    expect(await checkMailAccount('proton-mail', ADDRESS, PASSWORD, { connect: fake.connect }, { ports: BRIDGE_DEFAULT_PORTS, certificate: 'learn' })).toEqual({ ok: true, signedInAs: null, certificate: BRIDGE })
    expect(await checkMailAccount('proton-mail', ADDRESS, 'wrong', { connect: fake.connect }, { ports: BRIDGE_DEFAULT_PORTS, certificate: 'learn' })).toEqual({ ok: false, problem: 'refused' })
    expect(await checkMailAccount('proton-mail', ADDRESS, PASSWORD, { connect: fake.connect }, { ports: BRIDGE_DEFAULT_PORTS, certificate: CHANGED })).toEqual({ ok: false, problem: 'certificate' })
    expect(await checkMailAccount('proton-mail', ADDRESS, PASSWORD, { connect: fake.connect })).toEqual({ ok: false, problem: 'refused' })
  })

  it('says whether Bridge is running and shows the certificate kept, signing in to nothing', async () => {
    const fake = await bridge()
    expect(await bridgeStatus(account(1143), { connect: fake.connect })).toBe('running')
    const reinstalled = await bridge(CHANGED_CERTIFICATE)
    expect(await bridgeStatus(account(1143), { connect: reinstalled.connect })).toBe('certificate')
    for (const asked of [fake, reinstalled]) expect(asked.commands).not.toContain('LOGIN')
    // Nothing listening at Bridge's port, as while Bridge is closed.
    const listener = createServer()
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
    const address = listener.address()
    const port = typeof address === 'object' && address ? address.port : 0
    await new Promise<void>(resolve => listener.close(() => resolve()))
    expect(await bridgeStatus(account(port))).toBe('not-running')
  })
})
