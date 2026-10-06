// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { expect, it, vi } from 'vitest'
import { claudeFixture } from '../fixtures/claudeFixture'
import { startHeadlessHost } from '../../src/host'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import { RequestDraftService } from '../../src/main/agents/requestDrafts'
import { DesktopHostRouter } from '../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import { hostEntityKey } from '../../src/shared/clientIdentity'
import { requestDraftQuestions } from '../../src/shared/requestDrafts'
import type { ClaudeProtocol } from '../../src/main/agents/claudeProtocol'

it.each([true, false])('recovers a late Claude stdin completion %s after native cancellation and a cached negative receipt', async accepted => {
  const native = await claudeFixture()
  let host: Awaited<ReturnType<typeof startHeadlessHost>> | undefined
  let client: SocketHostService | undefined
  let router: DesktopHostRouter | undefined
  let release: () => void = () => undefined
  let off: (() => void) | undefined
  try {
    await native.host.connect()
    await native.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: native.projectId, title: 'Project', path: native.root })
    const nativeId = randomUUID()
    await native.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: nativeId, projectId: native.projectId, title: 'Late answer', modelId: native.modelId })
    host = await startHeadlessHost({ dataDirectory: join(native.root, 'headless'), port: 0,
      providers: { claude: native.adapter, codex: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost() }, reasoner: e2eAgentReasoner })
    const url = 'http://127.0.0.1:' + host.descriptor!.port
    const paired = await SocketHostService.pair(url, host.pairing.issuePairingCode().code, 'Synthetic laptop')
    const descriptor = JSON.parse(await readFile(join(native.root, 'headless', 'host-listener.json'), 'utf8')) as { adminToken: string }
    expect((await fetch(url + '/v1/admin/allow-answers', { method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.adminToken,
      'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: paired.clientId }) })).status).toBe(200)
    client = new SocketHostService({ url, token: paired.token, expectedHostId: paired.hostId })
    await client.connect()
    await client.command({ type: 'configure', patch: { provider: 'claude', enabledProviders: ['claude'] } })
    await client.command({ type: 'connect', provider: 'claude' })
    const threadId = client.shell().host.threads.find(thread => thread.title === 'Late answer')!.id
    await client.observe([threadId])
    await native.driver.raiseQuestion(nativeId, 'Which color?')
    await expect.poll(() => client!.shell().host.threads.find(thread => thread.id === threadId)?.requests.length).toBe(1)
    const request = client.shell().host.threads.find(thread => thread.id === threadId)!.requests[0]!
    const owner = { kind: 'thread' as const, ownerId: hostEntityKey(paired.hostId, threadId), providerId: 'claude' as const }
    const target = { ...owner, requestId: request.id, questions: requestDraftQuestions(request) }
    router = new DesktopHostRouter(emptyDesktopState, { bindRequestDraftDecision: (target, id, answers) => drafts.bindDecision(target, id, answers) })
    router.add({ hostId: paired.hostId, kind: 'remote', name: 'Forge', service: client,
      detail: id => client!.readThreadDetail(id), preview: request => client!.attachmentPreview(request),
      refreshRequestAnswer: (id, target) => client!.refreshRequestAnswer(id, target) })
    await mkdir(join(native.root, 'desktop'))
    const drafts: RequestDraftService = new RequestDraftService(join(native.root, 'desktop'), input => router!.requestDraftState(input),
      async () => { await router!.refreshRequestDraft(target, (await drafts.get(target))?.decisionId) })
    await drafts.start()
    await drafts.save({ target, revision: 1, held: true, selections: { '0': { optionIds: ['Blue'], other: false, text: '' } } })
    // Forward the real bytes once, holding only stdin's completion callback. The adapter's existing
    // two-second fixture deadline expires naturally; no command or acknowledgement is replayed.
    const runtime = (native.adapter as unknown as { runtimes: Map<string, { protocol: ClaudeProtocol }> }).runtimes.get(nativeId)!
    const stdin = (runtime.protocol as unknown as { child: ChildProcessWithoutNullStreams }).child.stdin
    const write = stdin.write.bind(stdin)
    const delayed = vi.spyOn(stdin, 'write').mockImplementationOnce(((chunk: string, callback: (error?: Error | null) => void) =>
      write(chunk, error => { release = () => { release = () => undefined; callback(accepted ? error : new Error('Synthetic late write failure')) } })) as typeof stdin.write)
    const receipt = vi.spyOn(client, 'receipt')
    const result = await router.command({ type: 'answer', threadId: owner.ownerId, requestId: request.id,
      answer: '', questionAnswers: { '0': { optionIds: ['Blue'] } } }, desktopWindowClient('Synthetic user'))
    expect(result.error).not.toBeNull()
    await expect.poll(() => router!.shell().busyThreadIds?.includes(owner.ownerId) ?? false).toBe(false)
    await native.action(nativeId, { type: 'raw', frame: { type: 'control_cancel_request', request_id: request.id } })
    await expect.poll(() => router!.shell().host.threads.find(thread => thread.id === owner.ownerId)?.requests).toEqual([])
    await router.reconcileRequestDrafts(drafts)
    const held = (await drafts.list(owner))[0]!
    const reads = receipt.mock.calls.length
    expect(held).toMatchObject({ held: true, decisionId: expect.any(String) })
    off = router.subscribe(() => { void router!.reconcileRequestDrafts(drafts) })
    release(); delayed.mockRestore()
    if (accepted) {
      await expect.poll(() => host!.service.requestAnswerRecovery(threadId, 'claude').completed.length).toBe(1)
      await expect.poll(async () => (await drafts.list(owner)).length).toBe(0)
      expect(router.shell().error).toBeNull()
    } else {
      // Drain a new shell response after the adapter processed its failed completion.
      await client.readShell()
      await router.reconcileRequestDrafts(drafts)
      expect(await drafts.list(owner)).toEqual([held])
      expect(router.requestDraftState(owner)?.completed).toEqual([])
      expect(router.shell().error).toBe(result.error)
    }
    await router.reconcileRequestDrafts(drafts)
    expect(receipt).toHaveBeenCalledTimes(reads)
    expect((await native.driver.requests()).filter(record => record.method === 'control_response')).toHaveLength(1)
  } finally {
    off?.(); release(); vi.restoreAllMocks(); router?.dispose(); await client?.close(); await host?.close(); await native.cleanup()
  }
})
