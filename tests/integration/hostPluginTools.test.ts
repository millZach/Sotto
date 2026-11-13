// @vitest-environment node
// A thread on a paired host uses a plugin account its desktop copied there (ADR-0205, decision 4): the headless host
// serves `sotto_plugins` to its own threads over its account copies and this machine's own gh, through its real socket
// listener, its real encrypted credential file and its real loopback tool server. A fake Codex stands in for the
// provider's own process, a stand-in for gh, and a stand-in for Vercel: nothing here reaches a real service.
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { codexFixture } from '../fixtures/codexFixture'
import { startFixtureHeadlessHost } from '../fixtures/desktopHostStack'
import type { RunGitCommand } from '../../src/main/agents/git/gitStatus'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import type { ScopedThreadTools } from '../../src/main/agents/threadToolServer'
import { PLUGIN_CHANGE_PREFIX } from '../../src/main/plugins/pendingChanges'
import type { VercelFetch } from '../../src/main/plugins/vercel/read'
import { DESKTOP_CLIENTS_FILE } from '../../src/shared/desktopClients'
import type { PluginAccountCopy } from '../../src/shared/pluginAccountCopies'

const OWL = '0.1.38-owl.20261013.1'
const STABLE = '0.1.38'
/** The window on the host machine itself, which may give any permission, as the user at that machine may. */
const LOCAL = { clientId: 'host-window', user: 'Synthetic user at the host', transport: 'ipc' } as const
/** A made-up account and a made-up token: nothing here is a real credential. */
const TOKEN = 'made-up-vercel-token-for-a-host-thread'
const COPY: PluginAccountCopy = {
  account: { id: '22222222-2222-4222-8222-000000000001', plugin: 'vercel', name: 'Work', savedAt: '2026-11-12T08:00:00.000Z', signedInAs: 'example-user', on: true, projects: null },
  secret: TOKEN,
}
const DEPLOYMENT = 'dpl_example1'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function hostFixture(version = OWL) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-host-plugin-tools-'))
  const data = join(root, 'data')
  const keyFile = join(root, 'host.key')
  await writeFile(keyFile, 'made-up-host-key-of-enough-length')
  // Codex's own app server, faked as a child process, which takes Sotto's tool servers at each launch as the real one does.
  const provider = { tools: [] as readonly ScopedThreadTools[] }
  const native = await codexFixture(undefined, false, 10_000); cleanups.push(native.cleanup)
  const useThreadTools = native.adapter.useThreadTools.bind(native.adapter)
  native.adapter.useThreadTools = tools => { provider.tools = tools; useThreadTools(tools) }
  // This machine's own gh, signed in as someone other than the desktop's account, and Vercel, which knows one token.
  const ghCalls: (readonly string[])[] = []
  const gh: RunGitCommand = async (_cwd, _command, args) => {
    ghCalls.push(args)
    return args[0] === 'auth' ? JSON.stringify({ hosts: { 'github.com': [{ active: true, login: 'host-user', state: 'success' }] } }) : JSON.stringify([{ number: 12, title: 'A made-up issue' }])
  }
  const vercelCalls: { method: string; url: string; authorization: string | undefined }[] = []
  const vercelFetch: VercelFetch = async (url, init) => {
    vercelCalls.push({ method: init.method, url, authorization: init.headers['Authorization'] })
    if (init.headers['Authorization'] !== `Bearer ${TOKEN}`) return new Response(JSON.stringify({ error: { code: 'forbidden', invalidToken: true } }), { status: 403 })
    if (init.method === 'PATCH') return new Response(JSON.stringify({ readyState: 'CANCELED' }), { status: 200 })
    if (url.includes(`/v13/deployments/${DEPLOYMENT}`)) return new Response(JSON.stringify({ name: 'example-project', url: 'example-project-abc.vercel.app', readyState: 'BUILDING', target: null }), { status: 200 })
    return new Response(JSON.stringify({ deployments: [{ uid: DEPLOYMENT, name: 'example-project' }] }), { status: 200 })
  }
  const host = await startFixtureHeadlessHost({ dataDirectory: data, port: 0, sottoVersion: version, keyFile, providers: { codex: native.adapter }, plugins: { gh, vercelFetch } })
  const url = 'http://127.0.0.1:' + host.descriptor!.port
  const clients: SocketHostService[] = []
  cleanups.push(async () => {
    await Promise.all(clients.map(client => client.close()))
    await host.close()
    if (dirname(root) === tmpdir() && root.includes('sotto-host-plugin-tools-')) await rm(root, { recursive: true, force: true })
  })
  const command = async (value: Parameters<typeof host.service.command>[0]) => {
    const state = await host.service.command(value, LOCAL)
    expect(state.error).toBeNull()
    return state
  }
  await command({ type: 'connect', provider: 'codex' })
  const path = join(root, 'project'); await mkdir(path, { recursive: true })
  const project = (await command({ type: 'create-project', provider: 'codex', title: 'Synthetic host project', path, useExisting: true })).host.projects.find(item => item.path === path)!
  const model = host.service.shell().host.models.find(item => item.providerId === 'codex' && item.ready)!
  /** The desktop the launch script recorded, paired and connected over the host's socket. */
  const desktop = async () => {
    const pairing = await SocketHostService.pair(url, host.pairing.issuePairingCode().code, 'Synthetic desktop')
    await writeFile(join(data, DESKTOP_CLIENTS_FILE), JSON.stringify([pairing.clientId]))
    const socket = new SocketHostService({ url, token: pairing.token, expectedHostId: pairing.hostId })
    clients.push(socket)
    await socket.connect()
    return { socket, pairing }
  }
  /** The host's own owner lets a desktop answer here, or stops it, as `--allow-answers` and `--deny-answers` do. */
  const answers = async (clientId: string, allowed: boolean) => {
    const { adminToken } = JSON.parse(await readFile(join(data, 'host-listener.json'), 'utf8')) as { adminToken: string }
    const response = await fetch(url + '/v1/admin/' + (allowed ? 'allow-answers' : 'deny-answers'), { method: 'POST',
      headers: { Authorization: 'Bearer ' + adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId }) })
    expect(response.status).toBe(200)
  }
  /** The provider's own session behind a Sotto thread, as the host's thread registry binds it. */
  const session = async (threadId: string) => {
    let sessionId: string | undefined
    await expect.poll(async () => {
      const registry = JSON.parse(await readFile(join(data, 'threads.json'), 'utf8').catch(() => '{"bindings":[]}')) as { bindings: { threadId: string; sessionId: string }[] }
      sessionId = registry.bindings.find(binding => binding.threadId === threadId)?.sessionId
      return sessionId
    }).toBeDefined()
    return sessionId!
  }
  /** A thread the user started at the host, and their message to it, its turn still running. */
  const thread = async () => {
    const threadId = randomUUID()
    await command({ type: 'create-thread', threadId, projectId: project.id, title: `Synthetic thread ${threadId.slice(0, 8)}`, modelId: model.id, runtimeMode: 'full-access', workingCopy: 'shared' })
    await command({ type: 'manual-send', threadId, draftId: randomUUID(), text: 'Have Codex do this synthetic user request' })
    return threadId
  }
  /** A tool call as the provider makes it: through the thread's own loopback server, with its own token. Its answer as the agent reads it. */
  const call = async (threadId: string, name: string, args: Record<string, unknown>) => {
    const server = await provider.tools.find(tools => tools.name === 'sotto_plugins')?.mcpServer(await session(threadId))
    if (!server) return undefined
    const response = await fetch(server.url, { method: 'POST', headers: { 'Content-Type': 'application/json', [server.headers[0]!.name]: server.headers[0]!.value },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
    expect(response.status).toBe(200)
    const { result } = (await response.json()) as { result: { content: { text: string }[]; isError?: boolean } }
    return { text: result.content.map(part => part.text).join('\n'), failed: result.isError === true }
  }
  /** The plugin change waiting in a thread, as the host shows it to whoever looks at the thread. */
  const card = (threadId: string) => host.service.shell().host.threads.find(item => item.id === threadId)?.requests.find(request => request.id.startsWith(PLUGIN_CHANGE_PREFIX))
  /** Every file the host keeps, as text, to look for something that must not be in any of them in the clear. */
  const files = async (folder = data): Promise<{ path: string; text: string }[]> => {
    const found: { path: string; text: string }[] = []
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const file = join(folder, entry.name)
      if (entry.isDirectory()) found.push(...await files(file))
      else found.push({ path: file, text: await readFile(file, 'utf8').catch(() => '') })
    }
    return found
  }
  return { host, provider, desktop, answers, thread, call, card, files, ghCalls, vercelCalls }
}

it('lets a host’s thread read through an account copy and this machine’s own gh, and never hands it the token', async () => {
  const f = await hostFixture()
  const { socket } = await f.desktop()
  const threadId = await f.thread()
  // Before any copy arrives the thread is told of GitHub, as this machine's gh is signed in, and of no Vercel account.
  const before = await f.call(threadId, 'plugin_accounts', {})
  expect(before?.text).toContain('host-user')
  expect(before?.text).not.toContain('Work')

  await expect(socket.keepPluginAccountCopy(COPY)).resolves.toMatchObject({ kept: true })
  const listed = await f.call(threadId, 'plugin_accounts', {})
  expect(listed?.text).toContain('Vercel: account "Work".')
  expect(listed?.text).toContain('host-user')

  // A read goes to Vercel with the copy's token, from the host, and the agent is handed what Vercel said and no token.
  const read = await f.call(threadId, 'plugin_read', { plugin: 'vercel', path: 'v6/deployments' })
  expect(read).toMatchObject({ failed: false })
  expect(read?.text).toContain(DEPLOYMENT)
  expect(f.vercelCalls).toEqual([{ method: 'GET', url: expect.stringContaining('/v6/deployments'), authorization: `Bearer ${TOKEN}` }])
  // GitHub is read as this machine's gh, which is asked and holds its own sign-in.
  const issues = await f.call(threadId, 'plugin_read', { plugin: 'github', path: 'repos/example-owner/example-repo/issues' })
  expect(issues?.text).toContain('A made-up issue')
  expect(f.ghCalls.some(args => args[0] === 'api')).toBe(true)
  for (const answer of [before, listed, read, issues]) expect(answer?.text).not.toContain(TOKEN)
  // The token is in no file the host keeps in the clear, and no client is told it.
  for (const file of await f.files()) expect(file.text.includes(TOKEN), file.path).toBe(false)
  expect(JSON.stringify(f.host.service.shell())).not.toContain(TOKEN)

  // The desktop takes its copy back: the thread has no Vercel account at its next call, and nothing is asked of Vercel.
  await expect(socket.removePluginAccountCopy(COPY.account.id)).resolves.toEqual({ removed: true })
  f.vercelCalls.length = 0
  const after = await f.call(threadId, 'plugin_read', { plugin: 'vercel', path: 'v6/deployments' })
  expect(after).toMatchObject({ failed: true })
  expect(f.vercelCalls).toEqual([])
  expect((await f.call(threadId, 'plugin_accounts', {}))?.text).not.toContain('Work')
})

it('holds a change from a host’s thread on a card in its thread, and makes it only once a client that may answer there allows it', async () => {
  const f = await hostFixture()
  const { socket, pairing } = await f.desktop()
  await socket.keepPluginAccountCopy(COPY)
  const threadId = await f.thread()

  // The agent asks to cancel a build. Nothing is sent to change anything: the call waits on a card in its thread.
  const cancelling = f.call(threadId, 'vercel_cancel_deployment', { deploymentId: DEPLOYMENT })
  await expect.poll(() => f.card(threadId)).toBeDefined()
  const card = f.card(threadId)!
  // The card says what will happen, to what and as which account, in the host's English, and holds no token.
  expect(JSON.stringify(card)).toContain('Cancel the build of example-project on Vercel?')
  expect(JSON.stringify(card)).toContain('Vercel account: Work')
  expect(JSON.stringify(card)).not.toContain(TOKEN)
  expect(f.vercelCalls.filter(made => made.method !== 'GET')).toEqual([])

  // A desktop the host's owner has not let answer here cannot allow it: the card still waits, and nothing is sent.
  await f.answers(pairing.clientId, false)
  await expect(socket.command({ type: 'answer', threadId, requestId: card.id, answer: '', approved: true })).rejects.toThrow()
  expect(f.card(threadId)?.id).toBe(card.id)
  expect(f.vercelCalls.filter(made => made.method !== 'GET')).toEqual([])

  // Let to answer, the same desktop allows it, and only then is the build cancelled, with the copy's token, from the host.
  await f.answers(pairing.clientId, true)
  await socket.command({ type: 'answer', threadId, requestId: card.id, answer: '', approved: true })
  const cancelled = await cancelling
  expect(cancelled).toMatchObject({ failed: false })
  expect(cancelled?.text).not.toContain(TOKEN)
  expect(f.vercelCalls.filter(made => made.method !== 'GET')).toEqual([{ method: 'PATCH', url: expect.stringContaining(`/v12/deployments/${DEPLOYMENT}/cancel`), authorization: `Bearer ${TOKEN}` }])
  expect(f.card(threadId)).toBeUndefined()

  // Said no to, a change is not made.
  f.vercelCalls.length = 0
  const refused = f.call(threadId, 'vercel_cancel_deployment', { deploymentId: DEPLOYMENT })
  await expect.poll(() => f.card(threadId)).toBeDefined()
  await socket.command({ type: 'answer', threadId, requestId: f.card(threadId)!.id, answer: '', approved: false })
  expect((await refused)?.text).toContain('Nothing was changed.')
  expect(f.vercelCalls.filter(made => made.method !== 'GET')).toEqual([])
})

it('makes no change allowed after the host began to close', async () => {
  const f = await hostFixture()
  const { socket } = await f.desktop()
  await socket.keepPluginAccountCopy(COPY)
  const threadId = await f.thread()
  const cancelling = f.call(threadId, 'vercel_cancel_deployment', { deploymentId: DEPLOYMENT }).catch(() => undefined)
  await expect.poll(() => f.card(threadId)).toBeDefined()
  const card = f.card(threadId)!
  // The host is told to close, and before it has closed anything it waits on, the card is allowed at the host itself.
  const closing = f.host.close()
  await f.host.service.command({ type: 'answer', threadId, requestId: card.id, answer: '', approved: true }, LOCAL).catch(() => undefined)
  await closing
  await cancelling
  // Nothing was sent to change anything: the change stopped when the host began to close.
  expect(f.vercelCalls.filter(made => made.method !== 'GET')).toEqual([])
})

it('uses no copy that is switched off, or that names projects, which a host does not have', async () => {
  const f = await hostFixture()
  const { socket } = await f.desktop()
  const threadId = await f.thread()
  for (const account of [{ ...COPY.account, on: false }, { ...COPY.account, projects: ['folder:one'] }]) {
    await expect(socket.keepPluginAccountCopy({ account, secret: TOKEN })).resolves.toMatchObject({ kept: true })
    const read = await f.call(threadId, 'plugin_read', { plugin: 'vercel', path: 'v6/deployments' })
    expect(read, JSON.stringify(account)).toMatchObject({ failed: true })
    // The thread learns that an account exists and is not its to use, and never its name.
    expect(read?.text).not.toContain('Work')
    expect((await f.call(threadId, 'plugin_accounts', {}))?.text).not.toContain('Work')
  }
  expect(f.vercelCalls).toEqual([])
})

it('gives a stable host’s threads no plugin tools', async () => {
  const f = await hostFixture(STABLE)
  const threadId = await f.thread()
  expect(f.provider.tools.some(tools => tools.name === 'sotto_plugins')).toBe(false)
  expect(await f.call(threadId, 'plugin_accounts', {})).toBeUndefined()
})
