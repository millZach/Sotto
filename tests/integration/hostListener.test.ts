// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { parseHostArguments, startHeadlessHost } from '../../src/host'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'

let root: string | undefined, host: Awaited<ReturnType<typeof startHeadlessHost>> | undefined
afterEach(async () => {
  await host?.close(); host = undefined
  if (root && dirname(root) === tmpdir()) await rm(root, { recursive: true, force: true })
  root = undefined
})
async function start(options: { startedBy?: 'launch-script' } = {}) {
  root ??= await mkdtemp(join(tmpdir(), 'sotto-host-listener-'))
  host = await startHeadlessHost({ dataDirectory: root, port: 0, ...options, reasoner: e2eAgentReasoner,
    providers: { codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost() } })
  return host
}
it('records in its descriptor that the launch script started it, and only then', async () => {
  await start({ startedBy: 'launch-script' })
  expect(JSON.parse(await readFile(join(root!, 'host-listener.json'), 'utf8'))).toMatchObject({ startedBy: 'launch-script', pid: process.pid })
  await host!.close(); host = undefined
  await start()
  expect(JSON.parse(await readFile(join(root!, 'host-listener.json'), 'utf8'))).not.toHaveProperty('startedBy')
})
it('reads the launch script mark from SOTTO_HOST_STARTED_BY and nothing else', () => {
  expect(parseHostArguments(['--data', './data'], { SOTTO_HOST_STARTED_BY: 'launch-script' })).toEqual({ dataDirectory: resolve('data'), port: 0, startedBy: 'launch-script' })
  expect(parseHostArguments(['--data', './data'], { SOTTO_HOST_STARTED_BY: 'someone' })).toEqual({ dataDirectory: resolve('data'), port: 0 })
})
