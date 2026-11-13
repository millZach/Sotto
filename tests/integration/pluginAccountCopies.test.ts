// @vitest-environment node
// Account copies (ADR-0205, amending ADR-0025): a headless host keeps a plugin account its desktop sends, over its real
// socket listener and its real encrypted credential file. Only the desktop the launch script recorded may send one, and
// a secret never comes back.
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { startFixtureHeadlessHost } from '../fixtures/desktopHostStack'
import { rawPeer } from '../fixtures/rawHostPeer'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { DESKTOP_CLIENTS_FILE } from '../../src/shared/desktopClients'
import type { PluginAccountCopy } from '../../src/shared/pluginAccountCopies'

const OWL = '0.1.38-owl.20261013.1'
const STABLE = '0.1.38'
/** A made-up account and a made-up token: nothing here is a real credential. */
const TOKEN = 'made-up-vercel-token-for-a-copy'
const COPY: PluginAccountCopy = {
  account: { id: '22222222-2222-4222-8222-000000000001', plugin: 'vercel', name: 'Work', savedAt: '2026-11-12T08:00:00.000Z', signedInAs: 'example-user', on: true, projects: null },
  secret: TOKEN,
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/** A headless host on its real listener. With `key`, it was started with a key file, as a host that keeps credentials is. */
async function hostFixture({ version = OWL, key = true }: { version?: string; key?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-plugin-account-copies-'))
  const keyFile = join(root, 'host.key')
  await writeFile(keyFile, 'made-up-host-key-of-enough-length')
  const host = await startFixtureHeadlessHost({ dataDirectory: join(root, 'data'), port: 0, sottoVersion: version, ...(key ? { keyFile } : {}) })
  const data = join(root, 'data')
  const url = 'http://127.0.0.1:' + host.descriptor!.port
  const clients: SocketHostService[] = []
  cleanups.push(async () => {
    await Promise.all(clients.map(client => client.close()))
    await host.close()
    if (dirname(root) === tmpdir() && root.includes('sotto-plugin-account-copies-')) await rm(root, { recursive: true, force: true })
  })
  const recorded: string[] = []
  /** A paired client. With `record`, the launch script recorded it as this host's desktop; without, it is any other paired client, as a phone is. */
  const client = async (record: boolean | 'after hello') => {
    const pairing = await SocketHostService.pair(url, host.pairing.issuePairingCode().code, record ? 'Synthetic desktop' : 'Synthetic phone')
    const write = async () => { recorded.push(pairing.clientId); await writeFile(join(data, DESKTOP_CLIENTS_FILE), JSON.stringify(recorded)) }
    if (record === true) await write()
    const socket = new SocketHostService({ url, token: pairing.token, expectedHostId: pairing.hostId })
    clients.push(socket)
    const hello = await socket.connect()
    // A host being added: the launch script records the desktop once its first hello has said which client it is.
    if (record === 'after hello') await write()
    return { socket, pairing, hello }
  }
  /** The host's own owner forgets a paired client, as `--revoke-client` does. */
  const revoke = async (clientId: string) => {
    const { adminToken } = JSON.parse(await readFile(join(data, 'host-listener.json'), 'utf8')) as { adminToken: string }
    const response = await fetch(url + '/v1/admin/revoke-client', { method: 'POST', headers: { Authorization: 'Bearer ' + adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId }) })
    expect(response.status).toBe(200)
  }
  /** A request sent as it is on the wire, after hello, whatever the client was offered: the host's own answer. */
  const raw = async (clientId: string, operation: Record<string, unknown>) => {
    const peer = await rawPeer(host.descriptor!.port, host.pairing.signSession(clientId, Date.now()))
    cleanups.push(async () => peer.frames.close())
    await peer.call('hello', { op: 'hello' })
    return await peer.call('request', operation)
  }
  /** Every file the host keeps, as text, to look for something that must not be in any of them in the clear. */
  const files = async (folder = data): Promise<{ path: string; text: string }[]> => {
    const found: { path: string; text: string }[] = []
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) found.push(...await files(path))
      else found.push({ path, text: await readFile(path, 'utf8').catch(() => '') })
    }
    return found
  }
  const kept = async (): Promise<{ version: number; accounts: Record<string, unknown>[] }> =>
    JSON.parse(await readFile(join(data, 'plugin-accounts.json'), 'utf8').catch(() => '{"version":1,"accounts":[]}')) as { version: number; accounts: Record<string, unknown>[] }
  return { host, data, client, raw, files, kept, revoke }
}

it('keeps a copy the recorded desktop sends, in the host’s own encrypted credential file, and never hands the secret back', async () => {
  const f = await hostFixture()
  const { socket, hello } = await f.client(true)
  expect(hello.features).toContain('plugin-account-copies')
  expect(socket.supportsPluginAccountCopies).toBe(true)
  await expect(socket.pluginAccountCopies()).resolves.toEqual([])

  const receipt = await socket.keepPluginAccountCopy(COPY)
  expect(receipt).toEqual({ kept: true, keptAt: expect.any(String) })
  // What the host says of the copy is which account and when its secret was saved. There is no secret to read.
  const held = await socket.pluginAccountCopies()
  expect(held).toMatchObject([{ id: COPY.account.id, plugin: 'vercel', savedAt: COPY.account.savedAt }])
  expect(JSON.stringify([receipt, held])).not.toContain(TOKEN)
  // The record of accounts holds the account without its secret, and the secret is in no file in the clear.
  expect((await f.kept()).accounts).toEqual([{ id: COPY.account.id, plugin: 'vercel', name: 'Work', savedAt: COPY.account.savedAt, signedInAs: 'example-user' }])
  for (const file of await f.files()) expect(file.text.includes(TOKEN), file.path).toBe(false)
  expect(JSON.parse(await readFile(join(f.data, 'credentials.json'), 'utf8'))).toHaveProperty(`plugin:${COPY.account.id}`)

  // Sent again with a new secret and a narrower account, the copy is replaced, not added to.
  const replaced = { account: { ...COPY.account, savedAt: '2026-11-13T08:00:00.000Z', on: false, projects: ['folder:one'] }, secret: `${TOKEN}-replaced` }
  await expect(socket.keepPluginAccountCopy(replaced)).resolves.toMatchObject({ kept: true })
  await expect(socket.pluginAccountCopies()).resolves.toMatchObject([{ id: COPY.account.id, plugin: 'vercel', savedAt: '2026-11-13T08:00:00.000Z' }])
  expect((await f.kept()).accounts).toMatchObject([{ id: COPY.account.id, on: false, projects: ['folder:one'] }])

  // Letting it go deletes the account and its secret, and letting it go again is done already.
  await expect(socket.removePluginAccountCopy(COPY.account.id)).resolves.toEqual({ removed: true })
  await expect(socket.pluginAccountCopies()).resolves.toEqual([])
  expect(JSON.parse(await readFile(join(f.data, 'credentials.json'), 'utf8'))).not.toHaveProperty(`plugin:${COPY.account.id}`)
  await expect(socket.removePluginAccountCopy(COPY.account.id)).resolves.toEqual({ removed: true })
})

it('takes a copy from a desktop the launch script recorded after its hello, as a host being added does', async () => {
  const f = await hostFixture()
  const { socket, hello } = await f.client('after hello')
  // The hello came before the record, so it listed no copies. The host keeps them, which its health said.
  expect(hello.features).not.toContain('plugin-account-copies')
  expect(socket.supportsPluginAccountCopies).toBe(true)
  // Nothing with a secret leaves before the host has said this desktop may send.
  await expect(socket.keepPluginAccountCopy(COPY)).rejects.toMatchObject({ code: 'version_mismatch' })
  expect(await f.kept()).toEqual({ version: 1, accounts: [] })
  // The list carries none, and its answer is the host saying so.
  await expect(socket.pluginAccountCopies()).resolves.toEqual([])
  await expect(socket.keepPluginAccountCopy(COPY)).resolves.toMatchObject({ kept: true })
  await expect(socket.pluginAccountCopies()).resolves.toMatchObject([{ id: COPY.account.id }])
})

it('takes a copy from no client but the recorded desktop: a paired client the launch script did not record is refused', async () => {
  const f = await hostFixture()
  // The desktop is recorded and holds a copy; another paired client, as a phone is, connects beside it.
  const desktop = await f.client(true)
  await desktop.socket.keepPluginAccountCopy(COPY)
  const other = await f.client(false)
  expect(other.hello.features).not.toContain('plugin-account-copies')
  // The host keeps copies, which its health says to anyone; whether this client may send them is the host's to say.
  expect(other.socket.supportsPluginAccountCopies).toBe(true)
  // Its own client refuses a secret before it leaves, and the host refuses the list, which carries none: a request the
  // host would not read, which this client words as a host of another version.
  await expect(other.socket.keepPluginAccountCopy(COPY)).rejects.toMatchObject({ code: 'version_mismatch' })
  await expect(other.socket.removePluginAccountCopy(COPY.account.id)).rejects.toMatchObject({ code: 'version_mismatch' })
  await expect(other.socket.pluginAccountCopies()).rejects.toMatchObject({ code: 'version_mismatch' })
  // Refused, it still may not send.
  await expect(other.socket.keepPluginAccountCopy(COPY)).rejects.toMatchObject({ code: 'version_mismatch' })
  // Sent on the wire anyway, each request is refused by the host: nothing is kept, replaced, removed or listed.
  const theirs = { account: { ...COPY.account, id: '22222222-2222-4222-8222-000000000002', name: 'Theirs' }, secret: 'made-up-token-from-another-client' }
  for (const operation of [
    { op: 'plugin-account-copy', copy: theirs },
    { op: 'plugin-account-copy', copy: { ...COPY, secret: 'made-up-token-from-another-client' } },
    { op: 'plugin-account-copy-remove', accountId: COPY.account.id },
    { op: 'plugin-account-copies' },
  ]) {
    const answer = await f.raw(other.pairing.clientId, operation)
    expect(answer, operation.op).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect(JSON.stringify(answer)).not.toContain('made-up-token')
  }
  await expect(desktop.socket.pluginAccountCopies()).resolves.toMatchObject([{ id: COPY.account.id, plugin: 'vercel', savedAt: COPY.account.savedAt }])
  for (const file of await f.files()) expect(file.text.includes('made-up-token-from-another-client'), file.path).toBe(false)
})

it('keeps each recorded desktop’s copies as its own: another recorded desktop cannot list, replace or remove them', async () => {
  const f = await hostFixture()
  const laptop = await f.client(true), tower = await f.client(true)
  await laptop.socket.keepPluginAccountCopy(COPY)
  // The second desktop is recorded too, and is offered the feature, but the laptop's copy is not its to see or touch.
  expect(tower.hello.features).toContain('plugin-account-copies')
  await expect(tower.socket.pluginAccountCopies()).resolves.toEqual([])
  await expect(tower.socket.keepPluginAccountCopy({ ...COPY, secret: 'made-up-token-from-the-other-desktop' })).resolves.toEqual({ kept: false, problem: 'held' })
  await expect(tower.socket.removePluginAccountCopy(COPY.account.id)).resolves.toEqual({ removed: false })
  await expect(laptop.socket.pluginAccountCopies()).resolves.toMatchObject([{ id: COPY.account.id, plugin: 'vercel', savedAt: COPY.account.savedAt }])
  for (const file of await f.files()) expect(file.text.includes('made-up-token-from-the-other-desktop'), file.path).toBe(false)
  // Its own account it keeps, and lists, beside the laptop's.
  const theirs = { account: { ...COPY.account, id: '22222222-2222-4222-8222-000000000002', name: 'Personal' }, secret: 'made-up-token-of-the-other-desktop' }
  await expect(tower.socket.keepPluginAccountCopy(theirs)).resolves.toMatchObject({ kept: true })
  await expect(tower.socket.pluginAccountCopies()).resolves.toMatchObject([{ id: theirs.account.id, plugin: 'vercel', savedAt: theirs.account.savedAt }])
})

it('deletes a desktop’s copies and their secrets when the host’s owner revokes it', async () => {
  const f = await hostFixture()
  const laptop = await f.client(true), tower = await f.client(true)
  await laptop.socket.keepPluginAccountCopy(COPY)
  const theirs = { account: { ...COPY.account, id: '22222222-2222-4222-8222-000000000002', name: 'Personal' }, secret: 'made-up-token-of-the-other-desktop' }
  await tower.socket.keepPluginAccountCopy(theirs)
  await f.revoke(laptop.pairing.clientId)
  // The laptop's account and its secret are gone from the host; the other desktop's are as they were.
  await expect.poll(async () => (await f.kept()).accounts.map(account => account.id)).toEqual([theirs.account.id])
  const slots = JSON.parse(await readFile(join(f.data, 'credentials.json'), 'utf8')) as Record<string, string>
  expect(slots).not.toHaveProperty(`plugin:${COPY.account.id}`)
  expect(slots).toHaveProperty(`plugin:${theirs.account.id}`)
  await expect(tower.socket.pluginAccountCopies()).resolves.toHaveLength(1)
})

it('keeps nothing on a host started without a key file, and says it could not be kept', async () => {
  const f = await hostFixture({ key: false })
  const { socket } = await f.client(true)
  await expect(socket.keepPluginAccountCopy(COPY)).resolves.toEqual({ kept: false, problem: 'store' })
  await expect(socket.pluginAccountCopies()).resolves.toEqual([])
  expect((await f.kept()).accounts).toEqual([])
  for (const file of await f.files()) expect(file.text.includes(TOKEN), file.path).toBe(false)
})

it('offers and takes nothing on a stable host', async () => {
  const f = await hostFixture({ version: STABLE })
  const { socket, hello, pairing } = await f.client(true)
  expect(hello.features).not.toContain('plugin-account-copies')
  await expect(socket.keepPluginAccountCopy(COPY)).rejects.toMatchObject({ code: 'version_mismatch' })
  expect(await f.raw(pairing.clientId, { op: 'plugin-account-copy', copy: COPY })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
  expect((await f.kept()).accounts).toEqual([])
  for (const file of await f.files()) expect(file.text.includes(TOKEN), file.path).toBe(false)
})

it('turns away a copy that is not one: no secret, a secret too long to be one, or anything beside the account and its secret', async () => {
  const f = await hostFixture()
  const { pairing } = await f.client(true)
  for (const copy of [{ account: COPY.account }, { ...COPY, secret: '' }, { ...COPY, secret: 'x'.repeat(1_001) }, { ...COPY, extra: true }, { account: { ...COPY.account, plugin: 'github' }, secret: TOKEN },
    { account: { ...COPY.account, token: TOKEN }, secret: TOKEN },
    // A copy that leaves out who may use it would arrive open to every thread, so it is not taken.
    { account: { id: COPY.account.id, plugin: 'vercel', name: 'Work', savedAt: COPY.account.savedAt, signedInAs: null }, secret: TOKEN },
    { account: { ...COPY.account, on: undefined }, secret: TOKEN }, { account: { ...COPY.account, projects: undefined }, secret: TOKEN },
    // Nor one the desktop could not have saved: kept to no project at all, to one twice, or under a name it would have turned away.
    { account: { ...COPY.account, projects: [] }, secret: TOKEN }, { account: { ...COPY.account, projects: ['folder:one', 'folder:one'] }, secret: TOKEN },
    { account: { ...COPY.account, name: '   ' }, secret: TOKEN }, { account: { ...COPY.account, name: 'Work' + String.fromCharCode(7) }, secret: TOKEN }]) {
    const answer = await f.raw(pairing.clientId, { op: 'plugin-account-copy', copy })
    expect(answer.ok, JSON.stringify(Object.keys(copy))).toBe(false)
    expect(JSON.stringify(answer)).not.toContain(TOKEN)
  }
  expect((await f.kept()).accounts).toEqual([])
})
