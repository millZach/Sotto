import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startHeadlessHost } from '../../src/host'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { codexFixture } from './codexFixture'
import { claudeFixture } from './claudeFixture'
import { grokFixture } from './fakeGrokThreadFixture'
import { devinFixture } from './devinFixture'
import type { AdapterSessionOptions } from '../integration/adapterContract'
import type { ProviderId } from '../../src/shared/agents'

async function main(): Promise<void> {
  const [provider, root, sessionJson] = process.argv.slice(2) as [ProviderId, string, string]
  const session = JSON.parse(sessionJson) as AdapterSessionOptions
  const native = await ({ codex: () => codexFixture(root, false, 2000, session), claude: () => claudeFixture(root, 2000, undefined, session), grok: () => grokFixture(root, 2000, 20, session), devin: () => devinFixture(root, 2000, 20, session) }[provider]())
  const host = await startHeadlessHost({ dataDirectory: root, port: 0, providers: { codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost(), [provider]: native.host }, reasoner: e2eAgentReasoner })
  await host.service.command({ type: 'configure', patch: { enabledProviders: [provider], provider } }, desktopWindowClient('socket-fixture'))
  const binding = async (id: string): Promise<string | undefined> => {
    try { return (JSON.parse(await readFile(join(root, 'threads.json'), 'utf8')) as { bindings: { threadId: string; sessionId: string }[] }).bindings.find(item => item.threadId === id)?.sessionId }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }
  process.on('message', message => {
    const request = message as { id: number; method: string; args: string[] }
    void (async () => {
      let result: unknown
      const [id = '', text = ''] = request.args
      if (request.method === 'stop') { await host.close(); process.send?.({ id: request.id, result: null }, () => process.disconnect?.()); return }
      if (request.method === 'pair') result = host.pairing.issuePairingCode()
      else if (request.method === 'nativeStarted') result = (await binding(id)) !== undefined
      else if (request.method === 'delayNextAck') result = await native.driver.delayNextAck(id)
      else if (request.method === 'requests') result = await native.driver.requests()
      else {
        const sessionId = await binding(id)
        if (!sessionId) throw new Error('Missing native test binding.')
        if (request.method === 'starts') result = await native.sessions?.starts(sessionId)
        else if (request.method === 'stopped') result = await native.sessions?.stopped(sessionId)
        else if (request.method === 'typeInProvider') result = await native.driver.typeInProvider(sessionId, text)
        else if (request.method === 'completeTurn') result = await native.driver.completeTurn(sessionId, text)
        else if (request.method === 'raiseQuestion') result = await native.driver.raiseQuestion(sessionId, text)
        else if (request.method === 'raisePermission') result = await native.driver.raisePermission(sessionId, text)
        else throw new Error('Unknown fixture operation.')
      }
      process.send?.({ id: request.id, result: result ?? null })
    })().catch(() => process.send?.({ id: request.id, error: 'Fixture operation failed.' }))
  })
  process.send?.({ ready: true, descriptor: host.descriptor })
}
void main().catch(() => { console.error('socket-fixture-start-failed'); process.exitCode = 1 })
