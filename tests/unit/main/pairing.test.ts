// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  originAllowed, PairedClients, PAIRING_CODE_LIFETIME_MS, PAIRING_CODE_REJECTED, SESSION_LIFETIME_MS,
} from '../../../src/main/agents/pairing'

let root: string
let clock = Date.parse('2026-09-19T09:00:00.000Z')

function clients(): PairedClients {
  let counter = 0
  return new PairedClients(root, { now: () => clock, createId: () => `client-${(counter += 1)}` })
}

async function paired(): Promise<{ store: PairedClients; clientId: string; token: string }> {
  const store = clients()
  await store.load()
  const { code } = store.issuePairingCode()
  const { clientId, token } = await store.redeem(code, 'Studio laptop')
  return { store, clientId, token }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sotto-pairing-'))
  clock = Date.parse('2026-09-19T09:00:00.000Z')
})
afterEach(async () => {
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-pairing-')) throw new Error('Unexpected temporary test directory')
  await rm(root, { recursive: true, force: true })
})

describe('paired clients', () => {
  it('refuses every call before the store has been read', () => {
    const store = clients()
    expect(() => store.issuePairingCode()).toThrow('Paired clients have not been read yet.')
    expect(store.verifyToken('anything')).toBeUndefined()
    expect(store.verifySession('anything')).toBeUndefined()
  })

  it('redeems a code once and then refuses it', async () => {
    const { store, clientId, token } = await paired()
    expect(store.list()).toEqual([{ clientId, name: 'Studio laptop', pairedAt: '2026-09-19T09:00:00.000Z', tokenHash: expect.any(String) }])
    expect(store.verifyToken(token)).toBe(clientId)
    const second = store.issuePairingCode()
    await store.redeem(second.code, 'Second')
    await expect(store.redeem(second.code, 'Again')).rejects.toThrow(PAIRING_CODE_REJECTED)
  })

  it('refuses an unknown or expired code without pairing anything', async () => {
    const store = clients()
    await store.load()
    await expect(store.redeem('NOPE', 'Nobody')).rejects.toThrow(PAIRING_CODE_REJECTED)
    const { code, expiresAt } = store.issuePairingCode()
    expect(Date.parse(expiresAt)).toBe(clock + PAIRING_CODE_LIFETIME_MS)
    clock += PAIRING_CODE_LIFETIME_MS + 1
    await expect(store.redeem(code, 'Too late')).rejects.toThrow(PAIRING_CODE_REJECTED)
    expect(store.list()).toEqual([])
  })

  it('keeps only a hash of the token on disk and refuses a token it never issued', async () => {
    const { store, token } = await paired()
    const saved = await readFile(join(root, 'paired-clients.json'), 'utf8')
    expect(saved).not.toContain(token)
    expect(JSON.parse(saved)).toMatchObject({ secret: expect.any(String), clients: [{ name: 'Studio laptop' }] })
    expect(store.verifyToken(`${token}x`)).toBeUndefined()
    expect(store.verifyToken('')).toBeUndefined()
  })

  it('signs a session a reopened store still verifies, and expires it', async () => {
    const { clientId, token } = await paired()
    const reopened = clients()
    await reopened.load()
    expect(reopened.verifyToken(token)).toBe(clientId)
    const session = reopened.signSession(clientId)
    expect(reopened.verifySession(session)).toBe(clientId)
    expect(reopened.verifySession(session, clock + SESSION_LIFETIME_MS + 1)).toBeUndefined()
  })

  it('refuses a session that was edited, malformed, or signed for an unpaired client', async () => {
    const { store, clientId } = await paired()
    const session = store.signSession(clientId)
    const [id, expiry, signature] = session.split('.')
    expect(store.verifySession(`other.${expiry}.${signature}`)).toBeUndefined()
    expect(store.verifySession(`${id}.${Number(expiry) + 60_000}.${signature}`)).toBeUndefined()
    expect(store.verifySession(`${id}.${expiry}`)).toBeUndefined()
    expect(store.verifySession('')).toBeUndefined()
    expect(() => store.signSession('never-paired')).toThrow('This client is not paired with Sotto. Pair it on this PC first.')
  })

  it('stops a revoked client’s token and its signed sessions at once', async () => {
    const { store, clientId, token } = await paired()
    const session = store.signSession(clientId)
    expect(await store.revoke(clientId)).toBe(true)
    expect(await store.revoke(clientId)).toBe(false)
    expect(store.list()).toEqual([])
    expect(store.verifyToken(token)).toBeUndefined()
    expect(store.verifySession(session)).toBeUndefined()
  })
})

describe('origin check', () => {
  it('accepts loopback and the configured origins alone', () => {
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1', 'https://localhost', 'http://[::1]:7777']) {
      expect(originAllowed(origin)).toBe(true)
    }
    for (const origin of ['https://sotto.example', 'http://127.0.0.1.example.com', 'file://', 'null', '', undefined]) {
      expect(originAllowed(origin)).toBe(false)
    }
    expect(originAllowed('https://laptop.tailnet.ts.net', ['https://laptop.tailnet.ts.net'])).toBe(true)
    expect(originAllowed('https://laptop.tailnet.ts.net', ['https://other.ts.net'])).toBe(false)
  })
})


describe('pairing mutation boundaries', () => {
  it('preserves concurrent redemptions and revocation in durable state', async () => {
    const store = clients(); await store.load()
    const original = await store.redeem(store.issuePairingCode().code, 'Original')
    const first = store.issuePairingCode(), second = store.issuePairingCode()
    const [one, two] = await Promise.all([store.redeem(first.code, 'One'), store.redeem(second.code, 'Two'), store.revoke(original.clientId)])
    const reopened = clients(); await reopened.load()
    expect(reopened.list().map(client => client.clientId)).toEqual([one.clientId, two.clientId])
    expect(reopened.verifyToken(original.token)).toBeUndefined()
  })
  it('refuses corrupt authentication state without replacing the file', async () => {
    await writeFile(join(root, 'paired-clients.json'), '{broken')
    await expect(clients().load()).rejects.toThrow('Paired devices could not be read')
    expect(await readFile(join(root, 'paired-clients.json'), 'utf8')).toBe('{broken')
  })
  it('does not expose mutable authentication records to callers', async () => {
    const { store } = await paired()
    const listed = store.list()
    listed[0]!.name = 'Changed'
    expect(store.list()[0]!.name).toBe('Studio laptop')
  })
})
