// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { devinPolicyPath } from '../../src/main/agents/devinPolicy'
import { DEVIN_CLI_VERSION } from '../../src/main/agents/devinRpc'
import { devinFixture } from '../fixtures/devinFixture'
import { devinOtelDefaults } from '../fixtures/devinOtel.mjs'

// Devin CLI 3000.11.1 added an `otel` block to `_cognition.ai/config/read` (#1045). The fake answers as 3000.11.92 does by
// default, reading back the profile's block filled in with defaults; these scripts change what it reads back.
let f: Awaited<ReturnType<typeof devinFixture>>
const create = (id: string) => f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id,
  projectId: f.projectId, modelId: f.modelId, title: 'Synthetic telemetry check' })
const send = (id: string) => f.host.execute({ type: 'send', commandId: randomUUID(), messageId: randomUUID(), threadId: id, text: 'Synthetic telemetry check' })
const methods = async (method: string) => (await f.driver.requests()).filter(request => request.method === method)
const project = () => f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
beforeEach(async () => { f = await devinFixture(undefined, undefined, 60_000) })
afterEach(async () => { await f?.cleanup() })

it.each(['profile', 'default'])('runs a thread on a Devin that reads otel back as %s, with telemetry pinned off in the profile', async otel => {
  await f.script({ otel })
  const connected = await f.host.connect()
  expect(connected.connected).toBe(true)
  expect(connected.version).toBe(`${DEVIN_CLI_VERSION} / ACP 1`)
  expect(JSON.parse(await readFile(devinPolicyPath(f.root, 'nothing'), 'utf8')).otel).toEqual({ enabled: false })
  await project()
  const id = randomUUID()
  await create(id)
  expect(await send(id)).toEqual({ accepted: true })
  expect(await methods('session/prompt')).toHaveLength(1)
})

it('connects a Devin that leaves otel out of its readback, as 3000.10.31 did', async () => {
  await f.script({ otel: 'absent' })
  const connected = await f.host.connect()
  expect(connected.connected).toBe(true)
  expect(connected.verifiedVersion).toBeUndefined()
})

it('refuses a Devin whose telemetry settings Sotto did not set, in plain words, before any session exists', async () => {
  await f.script({ otel: { enabled: true, ...devinOtelDefaults, endpoint: 'https://private-value.invalid' } })
  const refused = await f.host.connect()
  expect(refused.connected).toBe(false)
  expect(refused.error).toBe('Devin reports telemetry settings that Sotto’s profile does not set, such as a collector to send to. Nothing was sent, and your threads are kept. Remove the otel settings Devin reads, then reconnect.')
  expect(await methods('session/new')).toHaveLength(0)
})

it('says a Devin reporting a settings block Sotto has not checked is newer, and keeps the thread', async () => {
  await f.host.connect()
  await project()
  const id = randomUUID()
  await create(id)
  expect(await send(id)).toEqual({ accepted: true })
  await f.driver.completeTurn(id, 'Finished')
  await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.status).toBe('idle')
  // The update lands between two sends: the second one's own check refuses it, before its prompt.
  await f.script({ newBlock: true, cliVersion: '3000.12.0' })
  const newer = `This Devin version is newer than the one Sotto checked, and it has settings Sotto has not checked. Nothing was sent, and your threads are kept. Use Devin CLI ${DEVIN_CLI_VERSION} until Sotto checks this version.`
  await expect(send(id)).rejects.toThrow(newer)
  expect(await methods('session/prompt')).toHaveLength(1)
  const refused = await f.host.connect()
  expect(refused.error).toBe(newer)
  expect(refused.threads.map(thread => thread.id)).toContain(id)
})
