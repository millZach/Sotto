// @vitest-environment node
import { expect, it } from 'vitest'
import { openCodeForOwnServers } from '../../src/main/ownModelServers/openCode'
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
