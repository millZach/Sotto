// @vitest-environment node
import { afterEach, expect, it } from 'vitest'
import type { WatcherService } from '../../../src/main/agents/watcher'
import { watcherRefusal } from '../../../src/main/agents/watcher'
import { watcherToolDefinitions, WatcherToolServer } from '../../../src/main/agents/watcherTools'
import { deferred } from '../../fixtures/deferred'

const servers: WatcherToolServer[] = []
afterEach(async () => { for (const server of servers.splice(0)) await server.close() })

/**
 * A Watcher whose calls answer at once, as a call answered inside a client's wait does (Muse, ADR-0079), while the work
 * behind each goes on until the test lets it end.
 */
function slowWatcher() {
  const work = deferred()
  const service = {
    isCurrent: () => true,
    startCall: () => ({ answer: Promise.resolve(watcherRefusal('PROVIDER_UNAVAILABLE', 'Still reading.', true)), settled: work.promise }),
    invoke: () => Promise.resolve(watcherRefusal('PROVIDER_UNAVAILABLE', 'Still reading.', true)),
  } as unknown as WatcherService
  const server = new WatcherToolServer(service)
  servers.push(server)
  return { server, finish: () => work.resolve() }
}

it('keeps a call answered early in the in-flight count until its work ends, so such calls cannot pile past eight', async () => {
  const { server, finish } = slowWatcher()
  const code = async () => (await server.call('watcher', 'list_threads', {}, { waitMs: 300_000 })).structuredContent!.code
  for (let index = 0; index < 8; index++) expect(await code()).toBe('PROVIDER_UNAVAILABLE')
  // Eight calls have answered, but their work still runs: a ninth waits for one of them.
  expect(await code()).toBe('IN_FLIGHT_LIMIT')
  finish()
  await new Promise(resolve => setImmediate(resolve))
  expect(await code()).toBe('PROVIDER_UNAVAILABLE')
})

it('offers swarm arguments, receipts and machine counts only with worker-swarms on', () => {
  const definitions = (on: boolean) => watcherToolDefinitions(true, true, on)
  const start = (on: boolean) => definitions(on).find(tool => tool.name === 'start_thread')!
  const machines = (on: boolean) => definitions(on).find(tool => tool.name === 'list_machines')!
  expect(JSON.stringify(start(false).inputSchema)).not.toContain('"count"')
  expect(JSON.stringify(start(false).inputSchema)).not.toContain('"prompts"')
  expect(JSON.stringify(start(false).outputSchema)).not.toContain('"swarm"')
  expect(JSON.stringify(machines(false).outputSchema)).not.toContain('"workerCeiling"')
  expect(JSON.stringify(start(true).inputSchema)).toContain('"count"')
  expect(JSON.stringify(start(true).inputSchema)).toContain('"prompts"')
  expect(JSON.stringify(start(true).outputSchema)).toContain('"swarmId"')
  expect(JSON.stringify(machines(true).outputSchema)).toContain('"workerCeiling"')
  expect(JSON.stringify(machines(true).outputSchema)).toContain('"usual"')
  expect(start(true).description).toContain('queue in order')
  expect(start(true).description).not.toContain('result carries a warning')
  const read = (on: boolean) => JSON.stringify(definitions(on).find(tool => tool.name === 'read_operation')!.outputSchema)
  for (const field of ['swarm', 'queue', 'effectiveChoices']) {
    expect(read(false)).not.toContain(`"${field}"`)
    expect(read(true)).toContain(`"${field}"`)
  }
})
