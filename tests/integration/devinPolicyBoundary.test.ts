// @vitest-environment node
import { randomUUID } from 'node:crypto'
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


it('refuses connection readiness if catalog discovery activates a native integration', async () => {
  f.host.disconnect()
  await f.host.closed()
  await f.script({ enableMcpAfterNew: true })
  await expect(f.host.connect()).rejects.toThrow(/MCP servers/u)
  expect(await prompts()).toHaveLength(0)
})


it('keeps signed-out setup actionable without sending a prompt', async () => {
  f.host.disconnect(); await f.host.closed()
  await f.script({ signedOut: true })
  await expect(f.host.connect()).rejects.toThrow('devin auth login')
  expect((await f.host.snapshot()).connected).toBe(false)
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
  await expect(f.host.connect()).rejects.toThrow('3000.10.31')
  expect((await f.host.snapshot()).connected).toBe(false)
  expect(await prompts()).toHaveLength(0)
})
