// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startHeadlessHost } from '../../src/host'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import { REMOTE_PERMISSION_DENIED } from '../../src/main/agents/authority'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { AtomicJsonStore } from '../../src/main/storage/atomicJsonStore'
import { DesktopHostRouter } from '../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import { hostEntityKey } from '../../src/shared/clientIdentity'
import { PendingSettingsStore, settingValues } from '../../src/renderer/src/agents/pendingSettings'
import type { AgentHostSnapshot, AgentRuntimeMode } from '../../src/shared/agents'

class ProfileHost extends E2EAgentHost {
  override async snapshot(): Promise<AgentHostSnapshot> {
    const snapshot = await super.snapshot()
    for (const model of snapshot.models) {
      delete model.runtimeModes
      model.providerModes = [
        { id: 'smart', name: 'Smart', allows: 'edits' },
        { id: 'plan', name: 'Plan', allows: 'nothing' },
        { id: 'bypass', name: 'Bypass', allows: 'everything' },
      ]
    }
    return snapshot
  }
}

let root: string
let host: Awaited<ReturnType<typeof startHeadlessHost>> | undefined
const clients: SocketHostService[] = []
const local = desktopWindowClient('Permission fixture')
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(clients.splice(0).map(client => client.close()))
  await host?.close()
  if (root && dirname(root) === tmpdir() && root.includes('sotto-permissions-')) await rm(root, { recursive: true, force: true })
})
async function fixture(profiles = false) {
  root = await mkdtemp(join(tmpdir(), 'sotto-permissions-'))
  const native = profiles ? new ProfileHost() : new E2EAgentHost()
  await native.initializeWorkingFolders(root)
  host = await startHeadlessHost({ dataDirectory: root, port: 0,
    providers: { codex: native, claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost() }, reasoner: e2eAgentReasoner })
  await host.service.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'], newThreadRuntimeMode: 'full-access' } }, local)
  await host.service.command({ type: 'connect', provider: 'codex' }, local)
  const url = 'http://127.0.0.1:' + host.descriptor!.port
  const pair = async () => {
    const paired = await SocketHostService.pair(url, host!.pairing.issuePairingCode().code, 'Permission fixture')
    const client = new SocketHostService({ url, token: paired.token, expectedHostId: paired.hostId })
    clients.push(client)
    expect((await client.connect()).capabilities.mayAnswer).toBe(false)
    return { client, clientId: paired.clientId }
  }
  const { client, clientId } = await pair()
  const descriptor = JSON.parse(await readFile(join(root, 'host-listener.json'), 'utf8')) as { adminToken: string }
  const allowAnswers = async (allowed: boolean) => {
    const response = await fetch(url + '/v1/admin/' + (allowed ? 'allow-answers' : 'deny-answers'), {
      method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId }),
    })
    expect(response.status).toBe(200)
  }
  const state = client.shell()
  const create = { type: 'create-thread', projectId: state.host.projects[0]!.id, modelId: state.host.models[0]!.id,
    title: 'Permission fixture', managed: false } as const
  return { client, pair, allowAnswers, create, service: host.service, identity: { clientId, user: 'Permission fixture', transport: 'socket' as const } }
}

describe('resolved thread permissions through the real socket and coordinator', () => {
  it('returns a remote permission refusal to the desktop and keeps asking usable', async () => {
    const { client, create, allowAnswers } = await fixture()
    const safe = await client.command({ ...create, runtimeMode: 'approval-required' })
    const thread = safe.host.threads.find(item => item.title === create.title)!
    const router = new DesktopHostRouter(emptyDesktopState)
    const hostId = safe.hostId!
    router.add({ hostId, name: 'Forge', kind: 'remote', service: client,
      detail: id => client.readThreadDetail(id), preview: request => client.attachmentPreview(request) })
    const threadId = hostEntityKey(hostId, thread.id)
    try {
      for (const runtimeMode of ['full-access', 'auto', 'auto-accept-edits'] as const) {
        const result = await router.command({ type: 'configure-thread', threadId, runtimeMode }, local)
        expect(result.error).toBe(REMOTE_PERMISSION_DENIED)
        expect(result.host.threads.find(item => item.id === threadId)?.runtimeMode).toBe('approval-required')
      }
      const settings = new PendingSettingsStore()
      const drawn = router.shell()
      settings.press(threadId, 'permissions', 'full-access', { runtimeMode: 'full-access' },
        command => router.command(command, local), settingValues(drawn, drawn.host.threads.find(item => item.id === threadId)!))
      await expect.poll(() => settings.view(threadId).refusals.permissions?.error).toBe(REMOTE_PERMISSION_DENIED)
      expect(settings.view(threadId).pending.permissions).toBeUndefined()
      settings.clear()
      expect((await router.command({ type: 'configure-thread', threadId, runtimeMode: 'approval-required' }, local)).error).toBeNull()
      await allowAnswers(true)
      for (const runtimeMode of ['full-access', 'auto', 'auto-accept-edits', 'approval-required'] as const) {
        const result = await router.command({ type: 'configure-thread', threadId, runtimeMode }, local)
        expect(result.error).toBeNull()
        expect(result.host.threads.find(item => item.id === threadId)?.runtimeMode).toBe(runtimeMode)
      }
    } finally { router.dispose() }
  })

  it.each<AgentRuntimeMode>(['auto-accept-edits', 'auto', 'full-access'])('requires the originating client policy for explicit and inherited %s', async runtimeMode => {
    const { client, pair, allowAnswers, create, service, identity } = await fixture()
    await service.command({ type: 'configure', patch: { newThreadRuntimeMode: runtimeMode } }, local)
    const before = service.shell().host.threads.length
    await expect(client.command({ ...create, runtimeMode })).rejects.toMatchObject({ code: 'forbidden' })
    expect((await client.command(create)).error).toBe(REMOTE_PERMISSION_DENIED)
    expect(service.shell().host.threads).toHaveLength(before)
    const safe = await client.command({ ...create, title: 'Ask first', runtimeMode: 'approval-required' })
    expect(safe.error).toBeNull()
    const thread = safe.host.threads.find(thread => thread.title === 'Ask first')!
    expect(thread.runtimeMode).toBe('approval-required')
    await expect(client.command({ type: 'configure-thread', threadId: thread.id, runtimeMode })).rejects.toMatchObject({ code: 'forbidden' })
    expect((await service.command({ type: 'configure-thread', threadId: thread.id, runtimeMode }, identity)).error).toBe(REMOTE_PERMISSION_DENIED)
    expect(service.shell().host.threads.find(item => item.id === thread.id)?.runtimeMode).toBe('approval-required')
    // A local default remains usable by the desktop; it grants no paired client authority.
    const desktop = await service.command({ ...create, title: 'Desktop' }, local)
    expect(desktop.error).toBeNull()
    expect(desktop.host.threads.find(thread => thread.title === 'Desktop')?.runtimeMode).toBe(runtimeMode)
    await allowAnswers(true)
    const permitted = await client.command({ ...create, title: 'Permitted' })
    expect(permitted.error).toBeNull()
    expect(permitted.host.threads.find(thread => thread.title === 'Permitted')?.runtimeMode).toBe(runtimeMode)
    expect((await client.command({ type: 'configure-thread', threadId: thread.id, runtimeMode })).error).toBeNull()
    const other = await pair()
    expect((await other.client.command(create)).error).toBe(REMOTE_PERMISSION_DENIED)
    await allowAnswers(false)
    expect((await client.command(create)).error).toBe(REMOTE_PERMISSION_DENIED)
    expect((await client.command({ type: 'configure-thread', threadId: thread.id, runtimeMode: 'approval-required' })).error).toBeNull()
  })

  it.each(['create-thread', 'configure-thread'] as const)('rechecks the policy after %s waits for its durable intent', async type => {
    const { client, allowAnswers, create, service } = await fixture()
    const safe = await client.command({ ...create, runtimeMode: 'approval-required' })
    const thread = safe.host.threads.find(item => item.title === create.title)!
    await allowAnswers(true)
    let held!: () => void
    let release!: () => void
    const waiting = new Promise<void>(resolve => { held = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const write = AtomicJsonStore.prototype.write
    const spy = vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(function (this: AtomicJsonStore<unknown>, value: unknown) {
      const written = write.call(this, value)
      if (value && typeof value === 'object' && 'outbox' in value && Array.isArray(value.outbox)
        && value.outbox.some(item => item.type === type)) return written.then(async () => { held(); await gate })
      return written
    })
    const before = service.shell().host.threads.length
    const pending = client.command(type === 'create-thread' ? { ...create, title: 'Revoked while saving' }
      : { type, threadId: thread.id, runtimeMode: 'full-access' })
    try {
      await waiting
      await allowAnswers(false)
    } finally { release() }
    expect((await pending).error).toBe(REMOTE_PERMISSION_DENIED)
    spy.mockRestore()
    expect(service.shell().host.threads).toHaveLength(before)
    expect(service.shell().host.threads.find(item => item.id === thread.id)?.runtimeMode).toBe('approval-required')
  })

  it('keeps unset and asking defaults usable without a grant', async () => {
    const { client, create, service } = await fixture()
    for (const newThreadRuntimeMode of [undefined, 'approval-required'] as const) {
      await service.command({ type: 'configure', patch: { newThreadRuntimeMode } }, local)
      expect((await client.command(create)).error).toBeNull()
    }
  })

  it('checks inherited provider profiles by their allowance and honors safe explicit profiles', async () => {
    const { client, allowAnswers, create, service } = await fixture(true)
    const before = service.shell().host.threads.length
    await expect(client.command({ ...create, providerMode: 'smart' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(client.command({ ...create, providerMode: 'bypass' })).rejects.toMatchObject({ code: 'forbidden' })
    expect((await client.command(create)).error).toBe(REMOTE_PERMISSION_DENIED)
    expect(service.shell().host.threads).toHaveLength(before)
    const safe = await client.command({ ...create, providerMode: 'plan' })
    expect(safe.error).toBeNull()
    const thread = safe.host.threads.find(thread => thread.title === create.title)!
    expect(thread.providerMode).toBe('plan')
    await expect(client.command({ type: 'configure-thread', threadId: thread.id, providerMode: 'smart' })).rejects.toMatchObject({ code: 'forbidden' })
    await allowAnswers(true)
    const permitted = await client.command({ ...create, title: 'Permitted profile' })
    expect(permitted.error).toBeNull()
    expect(permitted.host.threads.find(thread => thread.title === 'Permitted profile')?.providerMode).toBe('smart')
    expect((await client.command({ type: 'configure-thread', threadId: thread.id, providerMode: 'bypass' })).error).toBeNull()
    await allowAnswers(false)
    expect((await client.command({ type: 'configure-thread', threadId: thread.id, providerMode: 'plan' })).error).toBeNull()
  })
})
