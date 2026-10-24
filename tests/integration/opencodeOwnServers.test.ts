// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { openCodeForOwnServers } from '../../src/main/ownModelServers/openCode'
import { OwnServers } from '../../src/main/ownModelServers/service'
import type { OwnServer } from '../../src/shared/ownModelServers'
import { opencodeFixture } from '../fixtures/fakeOpenCodeFixture'

const spark: OwnServer = {
  id: 'own-spark1', name: 'Spark', address: 'http://spark-head:8888/v1', keyed: false,
  models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', context: 163_840, thinking: true, images: false }],
}

/** What each OpenCode process this fixture started was told on top of its config, oldest first. */
async function configs(f: Awaited<ReturnType<typeof opencodeFixture>>): Promise<{ providers?: Record<string, unknown> }[]> {
  return (await f.driver.requests()).filter(record => record.method === 'fixture/process')
    .map(record => JSON.parse((record.params as { environment: { configContent: string } }).environment.configContent) as { providers?: Record<string, unknown> })
}

it('gives every OpenCode process the saved servers, and moves the sign-in server to a fresh one when they change', async () => {
  let saved: OwnServer[] = []
  const f = await opencodeFixture(undefined, undefined, {}, { ownServers: async () => saved, signInIdleMs: 60_000 })
  try {
    await f.host.connect()
    // The sign-in server starts with the list as it was, and stays up while idle.
    expect((await f.host.signIn.sources()).status).toBe('ok')
    expect((await configs(f)).every(config => config.providers === undefined)).toBe(true)
    const before = (await configs(f)).length

    saved = [spark]
    const openCode = openCodeForOwnServers(f.host)
    expect(openCode.running()).toBe(true)
    openCode.outdated()
    expect(await openCode.catalogAgain()).toBe(true)
    const after = await configs(f)
    // The catalog was read on a process started after the change, which was told about the server.
    expect(after.length).toBe(before + 1)
    expect(Object.keys(after.at(-1)!.providers ?? {})).toEqual(['own-spark1'])
    expect(f.events.every(event => /^opencode-[a-z-]+$/u.test(event))).toBe(true)
  } finally { await f.cleanup() }
})

it('gives OpenCode no servers when the record cannot be read', async () => {
  const f = await opencodeFixture(undefined, undefined, {}, { ownServers: async () => { throw new Error('unreadable') } })
  try {
    await f.host.connect()
    expect((await configs(f)).every(config => config.providers === undefined)).toBe(true)
  } finally { await f.cleanup() }
})

it('starts nothing for a change while OpenCode is not connected', async () => {
  const f = await opencodeFixture(undefined, undefined, {}, { ownServers: async () => [spark] })
  try {
    const openCode = openCodeForOwnServers(f.host)
    expect(openCode.running()).toBe(false)
    openCode.outdated()
    expect(await openCode.catalogAgain()).toBe(false)
    expect(await configs(f)).toEqual([])
  } finally { await f.cleanup() }
})

// Made up for this test; no real key ever goes near a fixture.
const KEY = 'sk-own-server-fixture-key-81d2'
/** The fake OpenCode lists the server's source as OpenCode 2.1.4 lists a provider declared only in config. */
const OWN_SOURCE = { id: 'own-spark1', name: 'Spark', methods: [{ type: 'key', label: 'Manually enter API Key' }] }
const ANTHROPIC = { id: 'anthropic', name: 'Anthropic', methods: [{ type: 'key' }] }

/** The record and Sotto's OpenCode over the fake, the new server's ID fixed so the fake lists its source. */
async function addFixture(script: Record<string, unknown>) {
  const events: string[] = []
  const f = await opencodeFixture(undefined, undefined, {}, { ownServers: () => servers.list(), signInIdleMs: 60_000 })
  const servers = new OwnServers({ directory: f.root, openCode: () => openCodeForOwnServers(f.host), newId: () => 'spark1', log: event => events.push(event) })
  await f.script({ integrations: [ANTHROPIC, OWN_SOURCE], ...script })
  await f.host.connect()
  const credentials = async (): Promise<{ integrationID: string }[]> => JSON.parse(await readFile(join(f.root, 'credentials.json'), 'utf8').catch(() => '[]')) as { integrationID: string }[]
  return { f, servers, events, credentials }
}
const keyed = { name: 'Spark', address: 'spark-head:8888', key: KEY, models: [spark.models[0]!] }

it('keeps a server whose key OpenCode saved when its answer was lost, and keeps it out of OpenCode’s own source list', async () => {
  const { f, servers, credentials } = await addFixture({ loseAnswer: { 'integration.connect.key': true } })
  try {
    expect(await servers.add(keyed)).toMatchObject({ status: 'ok', server: { id: 'own-spark1', keyed: true } })
    expect((await credentials()).map(credential => credential.integrationID)).toEqual(['own-spark1'])
    const sources = await f.host.signIn.sources()
    expect(sources.status === 'ok' && sources.sources.map(source => source.id)).toEqual(['anthropic'])
  } finally { await f.cleanup() }
})

it('asks OpenCode to forget a key it may have saved when the sign-in cannot tell, so none is left once the server is taken out', async () => {
  // The key is saved, its answer is lost, and the read that would say so fails too.
  const { f, servers, events, credentials } = await addFixture({ loseAnswer: { 'integration.connect.key': true }, refuse: { 'integration.list': [500, 1, 1] } })
  try {
    expect(await servers.add(keyed)).toMatchObject({ status: 'refused', reason: 'sign-in-failed' })
    expect(await servers.list()).toEqual([])
    expect(await credentials()).toEqual([])
    // OpenCode had saved it: the key went in once and its credential was deleted again.
    const methods = (await f.driver.requests()).map(record => record.method)
    expect(methods.filter(method => method === 'integration.connect.key')).toHaveLength(1)
    expect(methods.filter(method => method === 'credential.remove')).toHaveLength(1)
    expect(events).toEqual(['own-server-sign-in-failed', 'own-server-add-refused'])
    expect(JSON.stringify(events) + JSON.stringify(f.events)).not.toContain(KEY)
  } finally { await f.cleanup() }
})
