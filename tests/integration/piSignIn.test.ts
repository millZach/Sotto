// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { piFixture } from '../fixtures/fakePiFixture'
import { PiSignIn } from '../../src/main/agents/piSignIn'
import type { PiLoginSpawner } from '../../src/main/agents/piLogin'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { registerPiSignInIpc } from '../../src/main/agents/piSignInIpc'
import { PI_SIGN_IN } from '../../src/shared/piSignIn'
import { ipcRegistry } from '../fixtures/ipcHarness'

// The fake accepts pipes so this contract remains windowless on every CI platform; the live test uses Pi's required PTY.
const pipes: PiLoginSpawner = async (program, args, cwd, output) => {
  const child = spawn(program.executable, [...program.args, 'auth', ...args], { cwd, env: program.env, stdio: 'pipe', windowsHide: true })
  child.stdout.setEncoding('utf8'); child.stdout.on('data', output)
  child.stderr.resume()
  return { write: text => { child.stdin.write(text) }, kill: () => { child.kill() }, ended: new Promise(resolve => child.once('close', code => resolve(code === 0))) }
}
let fixture: Awaited<ReturnType<typeof piFixture>> | undefined
let signIn: PiSignIn | undefined
async function open(lifetimeMs?: number) {
  fixture = await piFixture()
  signIn = new PiSignIn(fixture.host.accounts, { spawn: pipes, openExternal: async () => {}, changed: () => fixture!.host.accountsChanged(), ...(lifetimeMs === undefined ? {} : { lifetimeMs }) })
  return signIn
}
afterEach(async () => { vi.restoreAllMocks(); await signIn?.close(); await fixture?.cleanup(); signIn = undefined; fixture = undefined })
it('keeps a key only in Pi auth, offers its models beside own servers, then signs out', async () => {
  const service = await open()
  await fixture!.host.connect()
  const key = 'synthetic-private-key'
  expect((await service.signInWithKey({ sourceId: 'openai', key })).status).toBe('ok')
  expect(await readFile(join(fixture!.host.folder, 'auth.json'), 'utf8')).toContain(key)
  expect(JSON.stringify(await fixture!.requests())).not.toContain(key)
  expect(await readFile(join(fixture!.host.folder, 'sotto-accounts.json'), 'utf8')).not.toContain(key)
  expect((await fixture!.host.snapshot()).models.map(model => model.id)).toContain('openai/fixture-cloud')
  expect((await service.signOut({ sourceId: 'openai' })).status).toBe('ok')
  expect((await fixture!.host.snapshot()).models.map(model => model.id)).not.toContain('openai/fixture-cloud')
})
it('reports expired credentials and offers none of their models', async () => {
  const service = await open()
  await service.signInWithKey({ sourceId: 'openai', key: 'synthetic-key' })
  await fixture!.host.connect()
  await fixture!.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: fixture!.projectId, title: 'Test', path: fixture!.root })
  const id = randomUUID()
  await fixture!.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: fixture!.projectId, modelId: 'openai/fixture-cloud', title: 'Expired account' })
  await fixture!.script({ authExpired: true })
  await expect(fixture!.host.execute({ type: 'send', commandId: randomUUID(), messageId: randomUUID(), threadId: id, text: 'Keep this draft' })).rejects.toThrow('Your draft is kept')
  const read = await service.sources()
  expect(read.status === 'ok' && read.sources.find(source => source.id === 'openai')?.problem).toBe('unavailable')
  await fixture!.host.accountsChanged()
  expect((await fixture!.host.snapshot()).models.map(model => model.id)).not.toContain('openai/fixture-cloud')
  expect((await fixture!.requests()).some(request => request.method === 'prompt')).toBe(false)
  expect((await service.signOut({ sourceId: 'openai' })).status).toBe('ok')
})
it('keeps a sign-in when logout fails, and rejects control characters before starting a key login', async () => {
  const service = await open()
  expect((await service.signInWithKey({ sourceId: 'openai', key: 'key\ncommand' })).status).toBe('refused')
  expect(await fixture!.requests()).toEqual([])
  expect((await service.signInWithKey({ sourceId: 'openai', key: 'synthetic-key' })).status).toBe('ok')
  await fixture!.script({ signOutFail: true })
  expect((await service.signOut({ sourceId: 'openai' })).status).toBe('refused')
  const read = await service.sources()
  expect(read.status === 'ok' && read.sources.find(source => source.id === 'openai')?.signedIn).toBeDefined()
})
it('expires an unanswered sign-in and allows another after its process closes', async () => {
  const service = await open()
  const start = await service.startBrowserSignIn({ sourceId: 'openai-codex', methodId: 'browser' })
  if (start.status !== 'waiting') throw new Error('No waiting sign-in.')
  expect((await service.startBrowserSignIn({ sourceId: 'openai-codex', methodId: 'browser' })).status).toBe('refused')
  vi.spyOn(Date, 'now').mockReturnValueOnce(start.attempt.expiresAt! + 1)
  expect((await service.wait({ attemptId: start.attempt.id })).status).toBe('expired')
  await expect.poll(async () => (await service.startBrowserSignIn({ sourceId: 'openai-codex', methodId: 'browser' })).status).toBe('waiting')
})
it('carries a key across IPC once and never returns credentials or raw failures', async () => {
  const service = await open()
  const { ipc, main, invoke } = ipcRegistry()
  const close = registerPiSignInIpc(ipc, service, () => [main])
  try {
    const key = 'synthetic-ipc-secret'
    const answer = await invoke(PI_SIGN_IN, [{ action: 'key', request: { sourceId: 'openai', key } }])
    expect(answer).toMatchObject({ status: 'ok' })
    const read = await invoke(PI_SIGN_IN, [{ action: 'sources' }])
    expect(JSON.stringify([answer, read])).not.toContain(key)
    const malformed = await invoke(PI_SIGN_IN, [{ action: 'key', request: { sourceId: 'openai', key }, extra: key }])
    expect(malformed).toMatchObject({ status: 'refused' })
    expect(JSON.stringify(malformed)).not.toContain(key)
    vi.spyOn(service, 'sources').mockRejectedValueOnce(new Error(key))
    expect(JSON.stringify(await invoke(PI_SIGN_IN, [{ action: 'sources' }]))).not.toContain(key)
  } finally { close() }
})
it('carries a device code only in the waiting view, completes and cancels without opening a page itself', async () => {
  const service = await open()
  const start = await service.startBrowserSignIn({ sourceId: 'openai-codex', methodId: 'browser' })
  expect(start.status).toBe('waiting')
  if (start.status !== 'waiting') return
  expect(start.attempt).toMatchObject({ code: 'FIXTURE-CODE', mode: 'auto', page: 'auth.openai.com' })
  expect(await service.wait({ attemptId: start.attempt.id })).toEqual({ status: 'pending' })
  await fixture!.script({ authComplete: true })
  await expect.poll(async () => (await service.wait({ attemptId: start.attempt.id })).status).toBe('ok')
  await fixture!.script({ authComplete: false })
  const next = await service.startBrowserSignIn({ sourceId: 'openai-codex', methodId: 'browser' })
  if (next.status !== 'waiting') throw new Error('No waiting sign-in.')
  expect(await service.cancel({ attemptId: next.attempt.id })).toEqual({ status: 'ok' })
})
