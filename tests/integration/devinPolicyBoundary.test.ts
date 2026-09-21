// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { devinFixture } from '../fixtures/devinFixture'

let f: Awaited<ReturnType<typeof devinFixture>>
const create = (id: string) => f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id,
  projectId: f.projectId, modelId: f.modelId, title: 'Synthetic policy check' })
const send = (id: string) => f.host.execute({ type: 'send', commandId: randomUUID(), messageId: randomUUID(), threadId: id, text: 'Synthetic policy check' })
const prompts = async () => (await f.driver.requests()).filter(request => request.method === 'session/prompt')
beforeEach(async () => {
  // The test explicitly drives reads; no periodic background race is needed.
  f = await devinFixture(undefined, 5000, 60_000)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
})
afterEach(async () => { await f?.cleanup() })

it.each(['enableMcpAfterNew', 'changePolicyAfterNew'])('refuses native %s changes before confirming a created thread', async flag => {
  await f.script({ [flag]: true })
  const id = randomUUID()
  await expect(create(id)).rejects.toThrow(/approval profile|MCP servers/u)
  await expect.poll(() => f.sessions.stopped(id)).toBe(true)
  expect(await prompts()).toHaveLength(0)
})

async function settledThread(): Promise<string> {
  const id = randomUUID()
  await create(id)
  expect(await send(id)).toEqual({ accepted: true })
  await f.driver.completeTurn(id, 'Finished')
  await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.status).toBe('idle')
  return id
}

it('refuses integrations activated by session load before sending on a resumed owner', async () => {
  const id = await settledThread()
  f = await f.driver.restart()
  await f.host.connect()
  await f.script({ enableMcpAfterLoad: true })
  await expect(send(id)).rejects.toThrow(/MCP servers/u)
  expect(await prompts()).toHaveLength(1)
})

it('refuses integrations activated by the final observer replay before a follow-up', async () => {
  const id = await settledThread()
  await f.script({ enableMcpAfterLoad: true })
  await expect(send(id)).rejects.toThrow(/MCP servers/u)
  expect(await prompts()).toHaveLength(1)
})


// A refused connection reports itself in the snapshot instead of throwing, the
// way the other providers do, so what Sotto already knows survives the attempt.
// It is still refused: `connected` stays false and no prompt is sent.
it('refuses connection readiness if catalog discovery activates a native integration', async () => {
  f.host.disconnect()
  await f.host.closed()
  await f.script({ enableMcpAfterNew: true })
  const snapshot = await f.host.connect()
  expect(snapshot.connected).toBe(false)
  expect(snapshot.error).toMatch(/MCP servers/u)
  expect(await prompts()).toHaveLength(0)
})


it('keeps signed-out setup actionable without sending a prompt', async () => {
  f.host.disconnect(); await f.host.closed()
  await f.script({ signedOut: true })
  const snapshot = await f.host.connect()
  expect(snapshot.connected).toBe(false)
  expect(snapshot.error).toContain('devin auth login')
  expect((await f.host.snapshot()).connected).toBe(false)
  expect(await prompts()).toHaveLength(0)
})

// Sotto's data folder holds one checkout per worktree-backed thread, so what
// those checkouts contain cannot decide whether Devin connects. The catalog
// session runs in a folder Sotto keeps empty instead of the data folder.
it('gives the catalog session a folder of its own, not the one holding thread checkouts', async () => {
  f.host.disconnect(); await f.host.closed()
  const checkout = join(f.root, 'thread-worktrees', 'thread', '.devin')
  await mkdir(checkout, { recursive: true })
  await writeFile(join(checkout, 'mcp_config.json'), 'private native values must never be read')
  const snapshot = await f.host.connect()
  expect(snapshot.connected).toBe(true)
  expect(snapshot.error).toBeUndefined()
  const created = (await f.driver.requests()).filter(request => request.method === 'session/new')
  expect(created).not.toHaveLength(0)
  for (const request of created) {
    expect((request.params as { cwd: string }).cwd).toBe(join(f.root, 'devin', 'catalog'))
  }
})

// Replacing what this process holds is the last thing a connection does, so a
// refusal leaves the threads and their messages rather than emptying them.
it('keeps the threads it already knows when a reconnect is refused', async () => {
  const id = await settledThread()
  const before = (await f.host.snapshot()).threads.find(thread => thread.id === id)!
  expect(before.messages.length).toBeGreaterThan(0)
  f.host.disconnect(); await f.host.closed()
  await f.script({ signedOut: true })
  const snapshot = await f.host.connect()
  expect(snapshot.connected).toBe(false)
  expect(snapshot.threads.find(thread => thread.id === id)?.messages).toHaveLength(before.messages.length)
})

// The folder is Sotto's own, not exempt: the same checks decide it.
it('still refuses when the catalog folder itself carries native configuration', async () => {
  f.host.disconnect(); await f.host.closed()
  const native = join(f.root, 'devin', 'catalog', '.devin')
  await mkdir(native, { recursive: true })
  await writeFile(join(native, 'mcp_config.json'), 'private native values must never be read')
  const snapshot = await f.host.connect()
  expect(snapshot.connected).toBe(false)
  expect(snapshot.error).toMatch(/native configuration/u)
  expect(await prompts()).toHaveLength(0)
})

it('connects to a client newer than the checked version and records which one it checked (ADR-0020)', async () => {
  f.host.disconnect(); await f.host.closed()
  await f.script({ cliVersion: '3000.11.02' })
  const snapshot = await f.host.connect()
  expect(snapshot.connected).toBe(true)
  expect(snapshot.verifiedVersion).toBe('3000.10.31')
})

it('names the checked CLI version when the installed version is older than it', async () => {
  f.host.disconnect(); await f.host.closed()
  await f.script({ cliVersion: '2999.1.1' })
  const snapshot = await f.host.connect()
  expect(snapshot.connected).toBe(false)
  expect(snapshot.error).toContain('3000.10.31')
  expect((await f.host.snapshot()).connected).toBe(false)
  expect(await prompts()).toHaveLength(0)
})
