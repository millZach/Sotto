// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { version as packageVersion } from '../../package.json'
import { startSocketServer } from '../../src/host/socketServer'
import { desktopWindowClient, type HostService } from '../../src/main/agents/hostService'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { SCREENSHOT_NOT_ITS_TYPE, type AgentCommand, type AgentModel, type AgentThreadDetail, type AgentThreadDetailUpdate } from '../../src/shared/agents'
import { HOST_FEATURES, hostVersionMismatch, type HostFeature, type HostOperation } from '../../src/shared/hostProtocol'
import { owlFeaturesForTrack, type OwlFeatureId } from '../../src/shared/owlFeatures'
import { getReleaseTrack } from '../../src/shared/releaseTrack'
import { GitPullRequestRefusal } from '../../src/main/agents/gitPullRequests'
import { HostFactsSource, hostMachineReport, type MachineWork } from '../../src/main/agents/hostFacts'
import { HOST_FACTS_REFRESH_MS } from '../../src/shared/hostFacts'
import { syntheticModelCatalog } from '../fixtures/modelCatalog'
import { rawPeer } from '../fixtures/rawHostPeer'
import { SAME_VERSION_HELD, useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()

const { pair } = fixture

describe('staged images over the socket (ADR-0031)', () => {
  it('stages an image on the host that runs the thread, sends the handle with the draft, and hands the bytes back by digest', async () => {
    const { client } = await pair()
    const bytes = Buffer.alloc(300 * 1024, 3); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
    const dimensions = { original: { width: 3840, height: 2160 }, sent: { width: 2576, height: 1449 } }
    const handle = await client.stageAttachment({ name: 'Remote.png', mimeType: 'image/png', bytes, dimensions })
    expect(handle).toMatchObject({ name: 'Remote.png', mimeType: 'image/png', sizeBytes: bytes.length, digest: createHash('sha256').update(bytes).digest('hex'), dimensions })
    // The content is the host's, in its own data folder; the desktop keeps none of it.
    expect(await readFile(join(fixture.root, 'attachments', `${handle.digest}.png`))).toEqual(bytes)
    await client.command({ type: 'configure', patch: { enabledProviders: ['codex'], provider: 'codex' } })
    await client.command({ type: 'connect', provider: 'codex' })
    const threadId = client.shell().host.threads[0]!.id
    const state = await client.command({ type: 'save-thread-draft', threadId, draftId: randomUUID(), text: 'Look', attachments: [handle], requestId: null })
    expect(state.threadDrafts).toEqual([expect.objectContaining({ threadId, attachments: [handle] })])
    expect(JSON.stringify(client.shell())).not.toContain(bytes.toString('base64').slice(0, 200))
    const content = await client.attachmentContent(handle.digest)
    expect(content?.mimeType).toBe('image/png'); expect(Buffer.from(content!.bytes)).toEqual(bytes)
    expect(await client.attachmentContent('f'.repeat(64))).toBeNull()
    // After a reload a draft's chips ask for their images at once. The host answers one such frame at a time per
    // device, as it does previews, and the client queues them behind one another, so none is refused as busy.
    const many = await Promise.all(Array.from({ length: 4 }, () => client.attachmentContent(handle.digest)))
    expect(many.map(item => item?.bytes.byteLength)).toEqual(Array(4).fill(bytes.length))
    // Staging takes the same one-at-a-time guard, and the client queues it with the reads, so several at once all land.
    const staged = await Promise.all(Array.from({ length: 3 }, (_, index) => {
      const each = Buffer.from(bytes); each[bytes.length - 1] = index
      return client.stageAttachment({ name: `Remote ${index}.png`, mimeType: 'image/png', bytes: each })
    }).concat([client.attachmentContent(handle.digest).then(() => handle)]))
    expect(new Set(staged.map(item => item.digest)).size).toBe(4)
    // Content that is not the image it claims is refused on the host, whoever sent it, and the desktop is told why.
    await expect(client.stageAttachment({ name: 'Fake.png', mimeType: 'image/png', bytes: Buffer.from('<svg/>') })).rejects.toMatchObject({ code: 'invalid_request', message: SCREENSHOT_NOT_ITS_TYPE })
  })
})

describe('host facts over the socket (#1031)', () => {
  it('answers a desktop with its machine’s facts and running threads, and its last reading when asked again at once', async () => {
    const { client } = await pair()
    expect(client.supportsHostFacts).toBe(true)
    const family = ({ win32: 'windows', darwin: 'macos', linux: 'linux' } as Record<string, string>)[process.platform] ?? null
    const first = await client.hostFacts()
    expect(first).toMatchObject({ facts: { os: { family } }, runningThreads: 0 })
    expect(first.facts.logicalCpuCount).toBeGreaterThan(0)
    // Asked again at once, the host answers its last reading rather than reading the machine again.
    expect((await client.hostFacts()).facts.observedAt).toBe(first.facts.observedAt)
  })

  it.each([true, false])('carries a fresh memory reading across the socket once the refresh window has passed, and the last one inside it, with Work across machines %s', async live => {
    let free = 9 * 1024 ** 3, at = Date.parse('2026-10-15T12:00:00.000Z')
    const source = new HostFactsSource({ now: () => new Date(at), sleep: async () => undefined,
      readFile: async path => path === '/proc/meminfo' ? `MemAvailable: ${free / 1024} kB\n` : 'PRETTY_NAME="Omarchy"\nVERSION_ID="4.0.4"\n',
      os: { platform: () => 'linux', release: () => '6.17.1', version: () => '#1 SMP', machine: () => 'x86_64', totalmem: () => 16 * 1024 ** 3, freemem: () => free, cpus: () => Array.from({ length: 16 }, () => ({})) } })
    const service: HostService = {
      shell: () => fixture.host.service.shell(), state: () => fixture.host.service.state(), threadDetail: id => fixture.host.service.threadDetail(id),
      command: (command, identity) => fixture.host.service.command(command, identity), events: () => [], subscribe: () => () => undefined,
      supportsHostFacts: true, hostFacts: () => hostMachineReport(source, () => ({ threads: [{ id: 'a', status: 'running' }, { id: 'b', status: 'idle' }],
        deliveries: [{ threadId: 'b', status: 'queued' }] }) as unknown as MachineWork, live),
    }
    const server = await startSocketServer({ service, pairing: fixture.host.pairing })
    try {
      const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Desktop')
      const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token }); fixture.clients.push(client)
      await client.connect()
      const answer = await client.hostFacts()
      expect(answer).toMatchObject({ runningThreads: 1, facts: { os: { family: 'linux', name: 'Omarchy', version: '4.0.4' }, freeMemoryBytes: 9 * 1024 ** 3 } })
      // Its live load and work placed but not started cross the socket with the facts only with Work across machines on
      // (#1311); with it off the answer is the facts and running threads, as before.
      if (live) expect(answer).toMatchObject({ placedNotStarted: 1,
        load: { availableMemoryBytes: 9 * 1024 ** 3, windowStartAvailableMemoryBytes: 9 * 1024 ** 3, cpuBusyPercent: null, memoryPressurePercent: null } })
      else expect(Object.keys(answer).sort()).toEqual(['facts', 'runningThreads'])
      free = 2 * 1024 ** 3; at += HOST_FACTS_REFRESH_MS - 1
      expect((await client.hostFacts()).facts.freeMemoryBytes).toBe(9 * 1024 ** 3)
      at += 1
      expect((await client.hostFacts()).facts).toMatchObject({ freeMemoryBytes: 2 * 1024 ** 3, observedAt: new Date(at).toISOString() })
    } finally { await server.close() }
  })

  it('is not offered by an older host, which reads unknown, nor by the desktop’s phone listener', async () => {
    const older: HostService = {
      shell: () => fixture.host.service.shell(), state: () => fixture.host.service.state(), threadDetail: id => fixture.host.service.threadDetail(id),
      command: (command, identity) => fixture.host.service.command(command, identity), events: () => [], subscribe: () => () => undefined,
    }
    for (const [service, admin] of [[older, undefined], [fixture.host.service, false]] as const) {
      const server = await startSocketServer({ service, pairing: fixture.host.pairing, ...(admin === false ? { admin } : {}) })
      try {
        expect(server.descriptor.features).not.toContain('host-facts')
        const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Older desktop')
        const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token }); fixture.clients.push(client)
        expect((await client.connect()).features).not.toContain('host-facts')
        expect(client.supportsHostFacts).toBe(false)
        // The desktop never asks; the version sentence stands in, and the host refuses the request if it is sent anyway.
        await expect(client.hostFacts()).rejects.toMatchObject({ code: 'version_mismatch' })
        const raw = client as unknown as { call(op: HostOperation): Promise<unknown> }
        await expect(raw.call({ op: 'host-facts' })).rejects.toMatchObject({ code: 'invalid_request' })
      } finally { await server.close() }
    }
  })
})

describe('setting up a copy of a project over the socket (#1690)', () => {
  const request = { repository: { host: 'github.com', owner: 'millZach', name: 'Sotto' }, title: 'Sotto' }
  const service = (setUp: HostService['setUpProject']): HostService => ({
    shell: () => fixture.host.service.shell(), state: () => fixture.host.service.state(), threadDetail: id => fixture.host.service.threadDetail(id),
    command: (command, identity) => fixture.host.service.command(command, identity), events: () => [], subscribe: () => () => undefined,
    supportsProjectSetup: true, ...setUp ? { setUpProject: setUp } : {},
  })
  it('answers a desktop with the project it set up, or its refusal in plain words, and refuses only a setup that did not answer', async () => {
    const asked: unknown[] = []
    let answer: unknown = { ok: true, projectId: 'p-1', title: 'Sotto', path: '/home/zach/Projects/Sotto', how: 'cloned', current: true }
    const server = await startSocketServer({ service: service(async setUp => { asked.push(setUp); if (answer instanceof Error) throw answer; return answer as never }), pairing: fixture.host.pairing })
    try {
      const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Desktop')
      const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token }); fixture.clients.push(client)
      expect((await client.connect()).features).toContain('project-setup')
      expect(client.supportsProjectSetup).toBe(true)
      expect(await client.setUpProject(request)).toEqual(answer)
      expect(asked).toEqual([request])
      answer = { ok: false, message: 'There is already a folder named Sotto in /home/zach/Projects that is not a copy of millZach/Sotto.' }
      expect(await client.setUpProject(request)).toEqual(answer)
      // A failure of its own, whatever it said, crosses as the host's refusal and never as its words.
      answer = new Error('fatal: /secret/path')
      await expect(client.setUpProject(request)).rejects.toMatchObject({ code: 'unavailable' })
    } finally { await server.close() }
  })
  it('is offered only to a desktop by a host that sets up copies, and never by the desktop’s phone listener', async () => {
    for (const [hosted, admin] of [[service(undefined), undefined], [service(async () => ({ ok: false, message: 'No.' })), false]] as const) {
      const server = await startSocketServer({ service: hosted, pairing: fixture.host.pairing, ...(admin === false ? { admin } : {}) })
      try {
        expect(server.descriptor.features).not.toContain('project-setup')
        const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Older desktop')
        const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token }); fixture.clients.push(client)
        expect((await client.connect()).features).not.toContain('project-setup')
        expect(client.supportsProjectSetup).toBe(false)
        await expect(client.setUpProject(request)).rejects.toMatchObject({ code: 'version_mismatch' })
        const raw = client as unknown as { call(op: HostOperation): Promise<unknown> }
        await expect(raw.call({ op: 'project-setup', request })).rejects.toMatchObject({ code: 'invalid_request' })
      } finally { await server.close() }
    }
  })
})

describe('the iPhone’s pull request sheet (#1281)', () => {
  it('is offered, phones included, only by a host whose Owl answer turns it on, and leaves the pull request read and babysitting as they were', async () => {
    const base: HostService = {
      shell: () => fixture.host.service.shell(), state: () => fixture.host.service.state(), threadDetail: id => fixture.host.service.threadDetail(id),
      command: (command, identity) => fixture.host.service.command(command, identity), events: () => [], subscribe: () => () => undefined,
      gitPullRequest: async () => null, supportsBabysitting: true,
    }
    for (const [service, offered] of [[{ ...base, supportsPullRequestView: true }, true], [base, false], [{ ...base, supportsPullRequestView: false }, false]] as const) {
      // The desktop's phone listener, which serves phones only.
      const server = await startSocketServer({ service, pairing: fixture.host.pairing, admin: false })
      try {
        const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'iPhone')
        const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token }); fixture.clients.push(client)
        const features = (await client.connect()).features ?? []
        expect(features.includes('pull-request-view')).toBe(offered)
        expect(features).toEqual(expect.arrayContaining(['git-pull-request', 'pull-request-babysit']))
        expect(server.descriptor.features.includes('pull-request-view')).toBe(offered)
      } finally { await server.close() }
    }
  })
  it('says why a pull request read failed as a reason beside today’s refusal, and never sends gh’s words (#1290)', async () => {
    let failure: Error = new Error('unset')
    const service: HostService = {
      shell: () => fixture.host.service.shell(), state: () => fixture.host.service.state(), threadDetail: id => fixture.host.service.threadDetail(id),
      command: (command, identity) => fixture.host.service.command(command, identity), events: () => [], subscribe: () => () => undefined,
      gitPullRequest: async () => { throw failure }, supportsPullRequestView: true,
    }
    const server = await startSocketServer({ service, pairing: fixture.host.pairing, admin: false })
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'iPhone')
    const phone = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(paired.clientId))
    try {
      await phone.call('hello', { op: 'hello', accepts: [] })
      const said = 'gh auth login as octocat at https://token@github.com'
      const cases: Array<[Error, string]> = [
        [new GitPullRequestRefusal(`Could not read the pull request. ${said}`, 'gh-signed-out'), 'gh-signed-out'],
        [new GitPullRequestRefusal(`Could not read the pull request. ${said}`, 'gh-missing'), 'gh-missing'],
        [new GitPullRequestRefusal(`Could not read the pull request. ${said}`, 'offline'), 'offline'],
        [new GitPullRequestRefusal(`Could not read the pull request. ${said}`), 'unreadable'],
        [new Error(said), 'unreadable'],
      ]
      for (const [index, [error, reason]] of cases.entries()) {
        failure = error
        const answer = await phone.call(`pr-${index}`, { op: 'git-pull-request', request: { threadId: 'thread-1', reference: 'https://github.com/o/r/pull/42' } })
        // The code and sentence an older phone reads are today's; the reason is beside them, and nothing gh said is.
        expect(answer).toMatchObject({ ok: false, error: { code: 'unavailable', message: 'The host could not complete this request. Refresh the thread before trying again.', reason } })
        expect(JSON.stringify(answer)).not.toMatch(/octocat|token@|gh auth/u)
      }
      // Any other refusal carries no reason.
      const other = await phone.call('host-facts', { op: 'host-facts' }) as { error: Record<string, unknown> }
      expect(other.error).not.toHaveProperty('reason')
    } finally { phone.frames.close(); await server.close() }
  })
})

describe('host version and features', () => {
  /** What a host lists whatever its Owl answers say, in health and its listener file, and in the hello to a paired client. */
  const LISTED: readonly HostFeature[] = ['client-liveness', 'message-aliases', 'detail-delta', 'git-refs', 'git-changed-files', 'git-pull-request', 'attachment-staging', 'host-folders', 'provider-sign-in', 'client-updates', 'activity-summaries', 'model-catalog-revision', 'thread-files', 'thread-changes', 'subagents', 'answer-receipts', 'answer-check', 'atomic-send', 'draft-revisions', 'background-refresh', 'pull-request-babysit', 'watcher-control', 'watcher-reads', 'watcher-standing-watch', 'watcher-work-settled', 'watcher-outcomes', 'host-facts', 'watcher-muse', 'provider-opencode', 'activity-bodies', 'failure-seen', 'client-update-outcomes', 'provider-cursor', 'watcher-cursor', 'client-update-not-listed', 'thread-prompts', 'pull-request-confirmation', 'watcher-new-owner']
  const GREETED: readonly HostFeature[] = ['client-liveness', 'message-aliases', 'detail-delta', 'git-refs', 'git-changed-files', 'git-pull-request', 'attachment-staging', 'host-folders', 'provider-sign-in', 'client-updates', 'activity-summaries', 'model-catalog-revision', 'thread-files', 'thread-changes', 'subagents', 'answer-receipts', 'answer-check', 'atomic-send', 'draft-revisions', 'background-refresh', 'pull-request-babysit', 'host-facts', 'provider-opencode', 'activity-bodies', 'failure-seen', 'client-update-outcomes', 'provider-cursor', 'client-update-not-listed', 'thread-prompts', 'pull-request-confirmation']
  /**
   * Features a host offers only where its own version's Owl answer is on (ADR-0072), and the answer each reads. Its OpenCode
   * sign-in also needs OpenCode's own adapter, which this host's fake is not; `hostOpenCode.test.ts` has that one.
   */
  const OWL_GATED: Partial<Record<HostFeature, OwlFeatureId>> = { 'usage-dashboard': 'usage', 'usage-history': 'usage', 'thread-starts': 'continue-agent-thread',
    'usage-muse-opencode': 'usage', 'usage-background-refresh': 'usage', 'pull-request-view': 'iphone-pull-request-view', 'agents-view': 'iphone-agents-view', 'thread-delete': 'clear-threads' }
  const offered = (always: readonly HostFeature[]): HostFeature[] => {
    const answers = owlFeaturesForTrack(getReleaseTrack(packageVersion))
    return HOST_FEATURES.filter(feature => always.includes(feature) || OWL_GATED[feature] !== undefined && answers[OWL_GATED[feature]!])
  }

  it('advertises the Sotto version and features in health, the listener file and the hello reply', async () => {
    // Its own features, and those its version's Owl answers turn on, in the protocol's order.
    const listed = offered(LISTED), greeted = offered(GREETED)
    const health = await (await fetch(fixture.url + '/v1/health')).json() as Record<string, unknown>
    expect(health).toMatchObject({ v: 1, status: 'ready', sottoVersion: packageVersion, features: listed })
    const listener = JSON.parse(await readFile(join(fixture.root, 'host-listener.json'), 'utf8')) as Record<string, unknown>
    expect(listener).toMatchObject({ v: 1, sottoVersion: packageVersion, features: listed })
    const { client } = await pair()
    expect(await client.connect()).toMatchObject({ sottoVersion: packageVersion, features: greeted, capabilities: { mayAnswer: false } })
  })

  it('takes the user’s Babysit pull request from a paired client, and refuses one the thread does not know in words (ADR-0061)', async () => {
    const { client } = await pair()
    expect(client.supportsBabysitting).toBe(true)
    await client.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } })
    await client.command({ type: 'connect', provider: 'codex' })
    const threadId = client.shell().host.threads.find(thread => thread.title === 'Workshop')!.id
    const pullRequest = 'https://github.com/o/r/pull/42'
    expect((await client.command({ type: 'babysit-pull-request', threadId, url: pullRequest })).error).toBe('Link this pull request to the thread first. Nothing was started.')
    expect((await client.command({ type: 'stop-babysitting', threadId, url: pullRequest })).notice).toBe('This thread was not babysitting PR #42.')
    expect(client.shell().host.threads.find(thread => thread.id === threadId)!.babysitting).toBeUndefined()
  })

  it('runs client updates only where it offers them: the headless host does, the phone listener does not (#480)', async () => {
    const { client } = await pair()
    expect(client.offersClientUpdates()).toBe(true)
    // The command reaches the host, which refuses it in words: nothing has been checked here yet.
    expect((await client.command({ type: 'queue-client-updates', providers: ['codex'] })).error).toBe('Sotto has not checked Codex yet. Check again, then update it.')
    const phone = await startSocketServer({ service: fixture.host.service, pairing: fixture.host.pairing })
    try {
      expect(phone.descriptor.features).not.toContain('client-updates')
      const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'iPhone')
      const other = new SocketHostService({ url: 'http://127.0.0.1:' + phone.descriptor.port, token: paired.token }); fixture.clients.push(other)
      await other.connect()
      expect(other.offersClientUpdates()).toBe(false)
      await expect(other.command({ type: 'queue-client-updates', providers: ['codex'] })).rejects.toMatchObject({ code: 'forbidden' })
      await expect(other.command({ type: 'cancel-client-updates', providers: ['codex'] })).rejects.toMatchObject({ code: 'forbidden' })
    } finally { await phone.close() }
  })

  it('sends mise’s not-listed failure only to a desktop that accepts it, and the installer’s failure to every other', async () => {
    const reading = { id: 'claude' as const, installed: '2.1.309', published: '2.1.310', behind: true, channel: 'mise' as const, command: 'mise install claude@2.1.310',
      canInstall: true, checkedAt: '2026-10-23T23:50:00.000Z', state: 'failed' as const, step: 1, failure: 'not-listed' as const }
    const service: HostService = {
      shell: () => ({ ...fixture.host.service.shell(), clientUpdates: [reading] }), state: () => fixture.host.service.state(), threadDetail: id => fixture.host.service.threadDetail(id),
      command: (command, identity) => fixture.host.service.command(command, identity), events: () => [], subscribe: () => () => undefined,
    }
    const server = await startSocketServer({ service, pairing: fixture.host.pairing, clientUpdates: true })
    expect(server.descriptor.features).toContain('client-update-not-listed')
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Desktop')
    const desktop = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token }); fixture.clients.push(desktop)
    const session = fixture.host.pairing.signSession(paired.clientId)
    const older = await rawPeer(server.descriptor.port, session), oldest = await rawPeer(server.descriptor.port, session)
    try {
      await desktop.connect()
      expect(desktop.shell().clientUpdates).toEqual([expect.objectContaining({ channel: 'mise', failure: 'not-listed' })])
      // A desktop from before this failure knows client updates but would refuse a shell naming a failure it does not know.
      type Hello = { result: { shell: { clientUpdates: unknown[] } } }
      const before = await older.call('hello', { op: 'hello', accepts: ['client-updates'] }) as Hello
      expect(before.result.shell.clientUpdates).toEqual([expect.objectContaining({ channel: 'mise', state: 'failed', failure: 'installer' })])
      const pre480 = await oldest.call('hello', { op: 'hello', accepts: [] }) as Hello
      expect(pre480.result.shell.clientUpdates).toEqual([expect.objectContaining({ channel: 'unknown', failure: 'installer' })])
    } finally { older.frames.close(); oldest.frames.close(); await server.close() }
  })

  it('sends the mise channel and the waiting state only to a client that accepts client-updates, and the rest as it knew them (#480)', async () => {
    const reading = { id: 'codex' as const, installed: '0.155.1', published: '0.158.0', behind: true, channel: 'mise' as const, command: 'mise upgrade codex',
      canInstall: true, checkedAt: '2026-09-29T12:00:00.000Z', state: 'queued' as const }
    const service: HostService = {
      shell: () => ({ ...fixture.host.service.shell(), clientUpdates: [reading] }), state: () => fixture.host.service.state(), threadDetail: id => fixture.host.service.threadDetail(id),
      command: (command, identity) => fixture.host.service.command(command, identity), events: () => [], subscribe: () => () => undefined,
    }
    // A client accepts client-updates in its hello when the host lists it; one from before #480, or the iPhone client, never does.
    for (const [offered, expected] of [[true, { channel: 'mise', state: 'queued' }], [false, { channel: 'unknown', state: 'idle' }]] as const) {
      const server = await startSocketServer({ service, pairing: fixture.host.pairing, clientUpdates: offered })
      try {
        const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, offered ? 'Desktop' : 'Older desktop')
        const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token }); fixture.clients.push(client)
        await client.connect()
        expect(client.shell().clientUpdates, String(offered)).toEqual([expect.objectContaining(expected)])
      } finally { await server.close() }
    }
  })

  it('keeps the version sentence for an unreadable push from a host of another version when a thread once too large arrives', async () => {
    const message = (text: string) => ({ id: 'reply', role: 'assistant' as const, text, createdAt: '2026-09-23T00:00:00.000Z' })
    let current: AgentThreadDetail = { threadId: 'streaming', revision: 1, messages: [message('Hello')] }
    let emitDetail: (update: AgentThreadDetailUpdate) => void = () => undefined
    let emitShell: (state: ReturnType<HostService['shell']>) => void = () => undefined
    let unreadableShell = false
    const service: HostService = {
      // What a later host might send: a shell this client cannot read.
      shell: () => unreadableShell ? { ...fixture.host.service.shell(), host: 'a later shape' } as unknown as ReturnType<HostService['shell']> : fixture.host.service.shell(),
      state: () => fixture.host.service.state(),
      threadDetail: id => id === 'streaming' ? structuredClone(current) : fixture.host.service.threadDetail(id),
      command: (command, identity) => fixture.host.service.command(command, identity),
      events: (afterSeq, threadId, limit) => fixture.host.service.events(afterSeq, threadId, limit),
      subscribe: listener => { emitShell = listener; return () => undefined },
      subscribeThreadDetail: listener => { emitDetail = listener; return () => undefined },
    }
    const server = await startSocketServer({ service, pairing: fixture.host.pairing, sottoVersion: '0.0.1' })
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Older host')
    const pushErrors: (string | null)[] = []
    const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token, owned: true,
      onPushError: text => pushErrors.push(text), onPushErrorCleared: () => pushErrors.push(null) }); fixture.clients.push(client)
    try {
      await client.connect()
      await client.observe(['streaming'])
      current = { threadId: 'streaming', revision: 2, messages: [message('Hello' + 'x'.repeat(17 * 1024 * 1024))] }
      emitDetail(current)
      await expect.poll(() => pushErrors.at(-1)).toEqual(expect.stringContaining('A thread on this host is too large'))
      unreadableShell = true
      emitShell(fixture.host.service.shell())
      const mismatch = hostVersionMismatch(packageVersion, '0.0.1', true)
      await expect.poll(() => pushErrors.at(-1)).toBe(mismatch)
      // The thread that was too large arrives again; the skew is still there, so the sentence stays.
      current = { threadId: 'streaming', revision: 3, messages: [message('Short again')] }
      await client.observe(['streaming'])
      expect(client.threadDetail('streaming')?.revision).toBe(3)
      expect(pushErrors.at(-1)).toBe(mismatch)
    } finally { await client.close(); await server.close() }
  })

  it('refuses a request it cannot read by its id, and a client of another version names the version instead', async () => {
    const unreadable = { type: 'a-command-from-a-later-version', threadId: 'thread' } as unknown as AgentCommand
    // The same version: the request is refused as unsupported, and the socket stays open.
    const { client } = await pair()
    await expect(client.command(unreadable)).rejects.toMatchObject({ code: 'invalid_request', message: expect.stringContaining('This request is not supported') })
    expect(await client.receipt('still-open')).toEqual({ status: 'unknown' })
    // A host of another version: the same refusal is version skew, and says which side to bring up to date.
    const server = await startSocketServer({ service: fixture.host.service, pairing: fixture.host.pairing, sottoVersion: '0.0.1' })
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Older host')
    const skewed = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token }); fixture.clients.push(skewed)
    try {
      expect((await skewed.connect()).sottoVersion).toBe('0.0.1')
      await expect(skewed.command(unreadable)).rejects.toMatchObject({ code: 'version_mismatch', message: hostVersionMismatch(packageVersion, '0.0.1', false) })
      expect(await skewed.receipt('still-open')).toEqual({ status: 'unknown' })
    } finally { await skewed.close(); await server.close() }
  })
})

describe('model catalog revisions (#699)', () => {
  /** A host whose shell lists `models()`, rebuilt into new arrays on every read the way the coordinator's shell is. */
  function catalogHost(models: () => AgentModel[], large: () => boolean = () => false) {
    let publish = (): void => undefined
    const huge = [{ id: 'huge', role: 'assistant' as const, text: 'x'.repeat(17 * 1024 * 1024), createdAt: new Date().toISOString() }]
    const service: HostService = {
      shell: () => {
        const state = fixture.host.service.shell()
        const threads = large() ? [{ id: 'huge', projectId: 'project', title: 'Huge', modelId: 'fixture-model', status: 'idle' as const, messages: huge, requests: [] }] : state.host.threads
        return { ...state, host: { ...state.host, threads, models: structuredClone(models()) } }
      },
      state: () => fixture.host.service.state(), threadDetail: id => fixture.host.service.threadDetail(id),
      command: (command, identity) => fixture.host.service.command(command, identity), events: () => [],
      subscribe: listener => { publish = () => listener(service.shell()); return () => undefined },
    }
    return { service, publish: () => publish() }
  }
  type Frame = Record<string, unknown> & { result?: { host?: Record<string, unknown>; shell?: { host: Record<string, unknown> } }; state?: { host: Record<string, unknown> } }
  /** The host of the first shell push `peer` receives after `send`, or the error push sent in its place. */
  async function nextShell(peer: Awaited<ReturnType<typeof rawPeer>>, send: () => void): Promise<Record<string, unknown>> {
    const from = peer.messages.length
    const arrived = () => peer.messages.slice(from).find(message => message.event === 'shell' || message.event === 'error') as Frame | undefined
    send()
    await expect.poll(arrived).toBeDefined()
    const frame = arrived()!
    return frame.event === 'shell' ? frame.state!.host : frame
  }

  it('sends an accepting client the catalog once per revision, again when it changes and on a fresh connection, and every other client the whole catalog', async () => {
    let models = syntheticModelCatalog(5)
    const { service, publish } = catalogHost(() => models)
    const server = await startSocketServer({ service, pairing: fixture.host.pairing })
    expect(server.descriptor.features).toContain('model-catalog-revision')
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'iPhone')
    const session = fixture.host.pairing.signSession(paired.clientId)
    const phone = await rawPeer(server.descriptor.port, session), older = await rawPeer(server.descriptor.port, session)
    let fresh: Awaited<ReturnType<typeof rawPeer>> | undefined
    try {
      const hello = await phone.call('hello', { op: 'hello', accepts: ['detail-delta', 'model-catalog-revision'] }) as Frame
      expect(hello.result!.shell!.host).toMatchObject({ models, modelsRevision: expect.any(Number) })
      const first = hello.result!.shell!.host.modelsRevision as number
      const olderHello = await older.call('hello', { op: 'hello', accepts: ['detail-delta'] }) as Frame
      expect(olderHello.result!.shell!.host.models).toEqual(models)
      expect(olderHello.result!.shell!.host).not.toHaveProperty('modelsRevision')

      // Unchanged: every shell names the revision and leaves the catalog out, push, read and command answer alike.
      const pushed = await nextShell(phone, publish)
      expect(pushed).toMatchObject({ modelsRevision: first }); expect(pushed).not.toHaveProperty('models')
      const read = await phone.call('read', { op: 'shell' }) as Frame
      expect(read.result!.host).toMatchObject({ modelsRevision: first }); expect(read.result!.host).not.toHaveProperty('models')
      const answered = await phone.call('select', { op: 'command', command: { type: 'select-project', projectId: 'project' } }) as Frame
      expect(answered).toMatchObject({ ok: true }); expect(answered.result!.host).toMatchObject({ modelsRevision: first })
      expect(answered.result!.host).not.toHaveProperty('models')

      // A client that did not accept the feature is sent exactly what v1 sends: the whole catalog, every time. Its answer
      // comes first: a push of the shell it was already pushed is not sent again, and one after an answer is.
      const olderAnswer = await older.call('select', { op: 'command', command: { type: 'select-project', projectId: 'project' } }) as Frame
      expect(olderAnswer.result!.host!.models).toEqual(models); expect(olderAnswer.result!.host).not.toHaveProperty('modelsRevision')
      const olderPush = await nextShell(older, publish)
      expect(olderPush.models).toEqual(models); expect(olderPush).not.toHaveProperty('modelsRevision')

      // A changed catalog goes whole once, under a new revision, then is named again.
      models = syntheticModelCatalog(6)
      const changed = await nextShell(phone, publish)
      expect(changed.models).toEqual(models)
      const second = changed.modelsRevision as number
      expect(second).toBeGreaterThan(first)
      const repeat = await nextShell(phone, publish)
      expect(repeat).toMatchObject({ modelsRevision: second }); expect(repeat).not.toHaveProperty('models')

      // A new connection starts with nothing recorded, so its hello carries the catalog whole.
      fresh = await rawPeer(server.descriptor.port, session)
      const again = await fresh.call('hello', { op: 'hello', accepts: ['model-catalog-revision'] }) as Frame
      expect(again.result!.shell!.host).toMatchObject({ models, modelsRevision: second })
    } finally { phone.frames.close(); older.frames.close(); fresh?.frames.close(); await server.close() }
  })

  it('records a catalog as sent only once a frame carrying it was written, not when too_large went in its place', async () => {
    let models = syntheticModelCatalog(3), large = false
    const { service, publish } = catalogHost(() => models, () => large)
    const server = await startSocketServer({ service, pairing: fixture.host.pairing })
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'iPhone')
    const phone = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(paired.clientId))
    try {
      const hello = await phone.call('hello', { op: 'hello', accepts: ['model-catalog-revision'] }) as Frame
      const first = hello.result!.shell!.host.modelsRevision as number
      models = syntheticModelCatalog(4); large = true
      expect(await nextShell(phone, publish)).toMatchObject({ event: 'error', error: { code: 'too_large' } })
      expect(await phone.call('read', { op: 'shell' })).toMatchObject({ ok: false, error: { code: 'too_large' } })
      large = false
      const next = await nextShell(phone, publish)
      expect(next.models).toEqual(models)
      expect(next.modelsRevision).toBeGreaterThan(first)
    } finally { phone.frames.close(); await server.close() }
  })

  it('sends the desktop’s own client the catalog once per revision, and puts it back in every shell it reads', async () => {
    let models = syntheticModelCatalog(4)
    const { service, publish } = catalogHost(() => models)
    const server = await startSocketServer({ service, pairing: fixture.host.pairing })
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Desktop')
    const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token, heldProviders: SAME_VERSION_HELD }); fixture.clients.push(client)
    const transport = client as unknown as { receive(text: string): void }
    const receive = transport.receive.bind(client), wire: Record<string, unknown>[] = []
    transport.receive = text => { wire.push(JSON.parse(text) as Record<string, unknown>); receive(text) }
    const wireHosts = () => wire.flatMap(frame => {
      const result = frame.result as { host?: Record<string, unknown>; shell?: { host: Record<string, unknown> } } | undefined
      const host = frame.event === 'shell' ? (frame.state as { host: Record<string, unknown> }).host : result?.shell?.host ?? result?.host
      return host ? [host] : []
    })
    try {
      await client.connect()
      expect(client.shell().host.models).toEqual(models)
      let shells = 0
      client.subscribe(() => { shells++ })
      publish()
      await expect.poll(() => shells).toBe(1)
      expect(client.shell().host.models).toEqual(models)
      expect((await client.readShell()).host.models).toEqual(models)
      expect((await client.command({ type: 'select-project', projectId: 'project' })).host.models).toEqual(models)
      // On the wire only hello carried the catalog; every later shell named its revision and left it out.
      const [hello, ...later] = wireHosts()
      expect(hello).toHaveProperty('models'); expect(later.length).toBeGreaterThanOrEqual(3)
      for (const host of later) expect(host).not.toHaveProperty('models')
      expect(client.shell().host).not.toHaveProperty('modelsRevision')
      // A changed catalog arrives whole once and is what every shell reads from then on.
      models = syntheticModelCatalog(5)
      publish()
      await expect.poll(() => client.shell().host.models).toEqual(models)
      expect((await client.readShell()).host.models).toEqual(models)
      expect(wireHosts().at(-1)).not.toHaveProperty('models')
    } finally { await client.close(); await server.close() }
  })
})

it('targets the peer selection for cancel-draft and preserves the host thread draft', async () => {
    const { client } = await pair()
    await client.command({ type: 'connect', provider: 'codex' })
    const threads = client.shell().host.threads
    await fixture.host.service.command({ type: 'select-thread', threadId: threads[0]!.id }, desktopWindowClient())
    await fixture.host.service.command({ type: 'compose', text: 'Host draft' }, desktopWindowClient())
    await client.command({ type: 'select-thread', threadId: threads[1]!.id })
    await client.command({ type: 'compose', text: 'Remote draft' })
    const before = fixture.host.service.shell()
    expect((await client.command({ type: 'cancel-draft' })).error).toBeNull()
    expect(fixture.host.service.shell().activeThreadId).toBe(before.activeThreadId)
    expect(fixture.host.service.shell().draft).toBe(before.draft)
    expect(fixture.host.service.shell().threadDrafts?.find(draft => draft.threadId === threads[1]!.id)?.text).toBeUndefined()
  })
