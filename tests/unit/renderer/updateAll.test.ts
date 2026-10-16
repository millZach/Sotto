import { describe, expect, it } from 'vitest'
import type { AgentClientHost, ProviderClientUpdate } from '../../../src/shared/agents'
import type { UpdateStatus } from '../../../src/shared/contracts'
import type { HostStatus } from '../../../src/shared/hosts'
import type { HostUpdateState } from '../../../src/shared/hostUpdates'
import { clientKey, hostKey, newlyDropped, newlyInLine, updateAllSteps, updateAllView, updateAllWords, versionsText, type UpdateAllPass, type UpdateAllSources } from '../../../src/renderer/src/features/updates/updateAll'

const FORGE = '6f0d1c5e-8c5b-4f8e-9a51-1f6f3f8d2a10'
const FORGE_HOST = '2a6c8e41-3b8f-4d4e-8a3f-7d1c2b9e5f60'
const status = (phase: UpdateStatus['phase']): UpdateStatus => ({ currentVersion: '0.1.37-owl.20261012.1', releaseTrack: 'owl', phase, checkedAt: 1 })
const client = (patch: Partial<ProviderClientUpdate> = {}): ProviderClientUpdate => ({
  id: 'claude', installed: '2.1.40', published: '2.1.42', behind: true, channel: 'npm', canInstall: true, checkedAt: '2026-10-12T10:00:00.000Z', state: 'idle', ...patch,
})
const hostUpdate = (patch: Partial<HostUpdateState> = {}): HostUpdateState => ({
  id: FORGE, name: 'forge', from: '0.1.35', to: '0.1.37', phase: 'needs', owned: true, working: 0, commands: 'sotto-host update', ...patch,
})
const forge = { id: FORGE, name: 'forge', hostId: FORGE_HOST, phase: 'connected', enabled: true } as unknown as HostStatus
const forgeClients = (updates: ProviderClientUpdate[]): AgentClientHost => ({ hostId: FORGE_HOST, connected: true, models: [], capabilities: {} as AgentClientHost['capabilities'], clientUpdates: updates })
function sources(patch: Partial<UpdateAllSources> = {}): UpdateAllSources {
  return { app: status({ phase: 'up-to-date' }), local: [], hosts: [forge], clientHosts: [], hostUpdates: [], ...patch }
}
const pass = (keys: string[], patch: Partial<UpdateAllPass> = {}): UpdateAllPass => ({ touched: new Set(keys), after: new Set(), refused: new Map(), ranBefore: new Map(), ...patch })

describe('what Update all offers', () => {
  it('shows nothing when everything is current', () => {
    expect(updateAllView(sources({ local: [client({ behind: false, published: '2.1.40' })] }), null).phase).toBe('hidden')
  })

  it('lists Sotto, this computer, then each host, and names what one press updates', () => {
    const view = updateAllView(sources({
      app: status({ phase: 'available', version: '0.1.37-owl.20261013.1', problem: null }),
      local: [client(), client({ id: 'grok', canInstall: false, channel: 'unknown', command: 'bun update -g @xai-official/grok' })],
      hostUpdates: [hostUpdate()], clientHosts: [forgeClients([client({ id: 'codex', installed: '0.51.0', published: '0.52.1' })])],
    }), null)
    expect(view.phase).toBe('offer')
    // In the order one press runs them: each host's clients come before the host's own update.
    expect(view.items.map(item => [item.key, item.state])).toEqual([
      ['sotto', 'offered'], [clientKey('local', 'claude'), 'offered'], [clientKey('local', 'grok'), 'by-hand'],
      [clientKey(FORGE, 'codex'), 'offered'], [hostKey(FORGE), 'offered'],
    ])
    expect(view.items[2]!.detail).toBe('Update it yourself with bun update -g @xai-official/grok.')
    const words = updateAllWords(view)
    expect(words.sub).toBe('0.1.37-owl.20261012.1 → 0.1.37-owl.20261013.1')
    expect(words.summary).toBe('Sotto, 2 clients and forge')
    // Each sentence is said once: the host's restart and Sotto's are their own steps' to say.
    expect(words.notes).toEqual(['Threads keep working while clients update.'])
  })

  it('shows a host Sotto did not start with its commands, and offers no press for it', () => {
    const view = updateAllView(sources({ hostUpdates: [hostUpdate({ owned: false })] }), null)
    expect(view.items[0]).toMatchObject({ state: 'by-hand', commands: 'sotto-host update' })
    expect(updateAllWords(view).sub).toBe('Sotto cannot install these itself.')
  })

  it('says a host with working threads updates once they finish', () => {
    const view = updateAllView(sources({ hostUpdates: [hostUpdate({ working: 1 })] }), null)
    expect(view.items[0]!.detail).toBe('1 thread on forge is working. It updates once they finish.')
    expect(updateAllView(sources({ hostUpdates: [hostUpdate({ working: 2, phase: 'waiting' })] }), null).items[0]).toMatchObject({ state: 'waiting', detail: 'Updates once its 2 threads finish.' })
  })

  it('reads a host’s own note before any press as an explanation, not a failure', () => {
    const view = updateAllView(sources({ hostUpdates: [hostUpdate({ error: 'This host still has thread management running.' })] }), null)
    expect(view.items[0]).toMatchObject({ state: 'offered', detail: 'This host still has thread management running.' })
  })
})

describe('a press of Update all', () => {
  it('counts as running from the press, before an updater has taken each part', () => {
    const touched = [clientKey('local', 'claude'), hostKey(FORGE)]
    const view = updateAllView(sources({ local: [client()], hostUpdates: [hostUpdate()] }), pass(touched))
    expect(view.phase).toBe('running')
    expect(view.items.map(item => item.detail)).toEqual(['Starting…', 'Starting…'])
    expect(updateAllWords(view)).toMatchObject({ sub: '0 of 2 done', pill: 'Updating · 0 of 2' })
  })

  it('holds a host back while the clients asked of it are still going', () => {
    const view = updateAllView(sources({ hostUpdates: [hostUpdate()], clientHosts: [forgeClients([client({ id: 'codex', state: 'updating' })])] }),
      pass([hostKey(FORGE), clientKey(FORGE, 'codex')], { after: new Set([FORGE]) }))
    expect(view.items.find(item => item.kind === 'host')).toMatchObject({ state: 'running', detail: 'Updates once forge’s clients have.' })
  })

  // The incident of October 16, 2026: forge restarted while Codex was in its line, and came back with the line empty.
  it('reads a host client whose line was lost as failed, never as starting forever', () => {
    const key = clientKey(FORGE, 'codex')
    const codex = (patch: Partial<ProviderClientUpdate> = {}) => forgeClients([client({ id: 'codex', installed: '0.51.0', published: '0.52.1', ranAt: 'earlier', ...patch })])
    const before = new Map([[key, 'earlier']])
    // Between the queue's reply and the host's next shell, the client still reads idle: that is the start, not a loss.
    const gap = pass([key], { ranBefore: before })
    expect(updateAllView(sources({ clientHosts: [codex()] }), gap).items[0]).toMatchObject({ state: 'running', detail: 'Starting…' })
    expect(newlyInLine(sources({ clientHosts: [codex()] }), gap)).toEqual([])
    // The host says it is in the line: the card marks it seen, as it is listed then.
    expect(newlyInLine(sources({ clientHosts: [codex({ state: 'queued' })] }), gap)).toEqual([key])
    const listed = updateAllView(sources({ clientHosts: [codex({ state: 'queued' })] }), gap).items[0]!
    const seen = pass([key], { ranBefore: before, seen: new Map([[key, listed]]) })
    expect(newlyInLine(sources({ clientHosts: [codex({ state: 'updating' })] }), seen)).toEqual([])
    expect(updateAllView(sources({ clientHosts: [codex({ state: 'updating' })] }), seen).items[0]).toMatchObject({ state: 'running' })
    // forge goes out of reach while it restarts: the step stays listed, and the press is not read as over.
    const away = sources({ clientHosts: [{ ...codex({ state: 'updating' }), connected: false }] })
    expect(updateAllView(away, seen)).toMatchObject({ phase: 'running', items: [{ key, state: 'running', detail: 'Waiting to hear from forge…' }] })
    expect(newlyDropped(away, seen)).toEqual([key])
    // Sotto Bug Bot on #1084: a connected host that leaves the client out of what it reports, as one restarted with checks
    // off or the provider not connected does, lost the line; the step never waits for it forever.
    for (const reported of [[], undefined]) {
      const quiet = updateAllView(sources({ clientHosts: [{ ...codex(), clientUpdates: reported }] }), pass([key], { ranBefore: before, seen: new Map([[key, listed]]), dropped: new Set([key]) }))
      expect(quiet.items).toMatchObject([{ key, state: 'failed', detail: 'forge restarted before Codex updated. Nothing was changed. Try again.' }])
      expect(quiet.phase).toBe('done')
    }
    expect(updateAllView(sources({ clientHosts: [{ ...codex(), clientUpdates: [] }] }), seen).items[0])
      .toMatchObject({ state: 'failed', detail: 'The Codex update on forge stopped before it finished. Nothing was changed. Try again.' })
    expect(newlyDropped(sources({ clientHosts: [codex({ state: 'updating' })] }), seen)).toEqual([])
    const dropped = pass([key], { ranBefore: before, seen: new Map([[key, listed]]), dropped: new Set([key]) })
    // The new host process has no results in memory, so Codex comes back with none: its line went with the restart.
    const lost = updateAllView(sources({ clientHosts: [codex({ ranAt: undefined })] }), dropped)
    expect(lost.items[0]).toMatchObject({ state: 'failed', detail: 'forge restarted before Codex updated. Nothing was changed. Try again.' })
    expect(updateAllWords(lost)).toMatchObject({ title: 'Not everything updated', sub: 'forge’s Codex did not update.' })
    // Out of the line without forge going away, as when Cancel update on its tile took it out, is not called a restart.
    expect(updateAllView(sources({ clientHosts: [codex()] }), seen).items[0])
      .toMatchObject({ state: 'failed', detail: 'The Codex update on forge stopped before it finished. Nothing was changed. Try again.' })
    // A result of its own still says how it ended, and a host that runs the new version anyway is done.
    expect(updateAllView(sources({ clientHosts: [codex({ state: 'updated', ranAt: 'now', installed: '0.52.1', behind: false })] }), seen).items[0]).toMatchObject({ state: 'done' })
    expect(updateAllView(sources({ clientHosts: [codex({ ranAt: undefined, installed: '0.52.1', behind: false })] }), dropped).items[0]).toMatchObject({ state: 'done', detail: 'Now 0.52.1.' })
    // Sol, review of #1084: a registry that does not answer reads as not behind, which says nothing of whether it updated.
    const unanswered = updateAllView(sources({ clientHosts: [codex({ ranAt: undefined, behind: false, published: undefined })] }), dropped)
    expect(unanswered.items[0]).toMatchObject({ state: 'failed', detail: 'forge restarted before Codex updated. Nothing was changed. Try again.' })
    expect(unanswered.phase).toBe('done')
    expect(updateAllWords(unanswered).title).toBe('Not everything updated')
    // A client this press did not ask for is never read as lost.
    expect(updateAllView(sources({ clientHosts: [codex()] }), pass([], { seen: new Map([[key, listed]]) })).items[0]).toMatchObject({ state: 'offered' })
  })

  it('reads this computer’s clients as never losing their line', () => {
    const key = clientKey('local', 'claude')
    const listed = updateAllView(sources({ local: [client({ state: 'queued' })] }), pass([key])).items[0]!
    const view = updateAllView(sources({ local: [client({ ranAt: 'earlier' })] }), pass([key], { ranBefore: new Map([[key, 'earlier']]), seen: new Map([[key, listed]]) }))
    expect(view.items[0]).toMatchObject({ state: 'running' })
  })

  it('says a host waiting for its client update line updates once its clients have', () => {
    const waiting = updateAllView(sources({ hostUpdates: [hostUpdate({ phase: 'waiting', clientsUpdating: true })] }), pass([hostKey(FORGE)]))
    expect(waiting.items[0]).toMatchObject({ state: 'running', detail: 'Updates once forge’s clients have.', cancellable: true })
    expect(waiting.phase).toBe('running')
    // Once under way, the update runs on and only its restart waits for the clients.
    const at = (step: HostUpdateState['step']) => updateAllView(sources({ hostUpdates: [hostUpdate({ phase: 'updating', step, clientsUpdating: true })] }), pass([hostKey(FORGE)])).items[0]!.detail
    expect(at('download')).toBe('Step 1 of 4 · Download 0.1.37 · Restarts once forge’s clients have.')
    expect(at('restart')).toBe('Step 4 of 4 · Restart forge’s host once its clients have')
    const busy = updateAllView(sources({ hostUpdates: [hostUpdate({ phase: 'waiting', clientsUpdating: true, working: 2 })] }), pass([hostKey(FORGE)]))
    expect(busy.items[0]).toMatchObject({ state: 'waiting', detail: 'Updates once its 2 threads finish and its clients have.', cancellable: true })
  })

  it('does not read a result from before the press as the press’s own', () => {
    const key = clientKey('local', 'claude')
    const failedBefore = client({ state: 'failed', ranAt: 'earlier', error: 'EBUSY' })
    expect(updateAllView(sources({ local: [failedBefore] }), pass([key], { ranBefore: new Map([[key, 'earlier']]) })).items[0]).toMatchObject({ state: 'running' })
    const failedNow = client({ state: 'failed', ranAt: 'now', error: 'EBUSY' })
    expect(updateAllView(sources({ local: [failedNow] }), pass([key], { ranBefore: new Map([[key, 'earlier']]) })).items[0])
      .toMatchObject({ state: 'failed', detail: 'Claude Code did not update. Nothing was changed. Settings → Providers shows what the installer said.' })
  })

  it('asks to restart once Sotto is downloaded and nothing it started is still going, and says what happens to working threads', () => {
    const view = updateAllView(sources({ app: status({ phase: 'downloaded', version: '0.1.37-owl.20261013.1', problem: null }),
      local: [client({ state: 'updated', installed: '2.1.42', behind: false, ranAt: 'now' })] }), pass(['sotto', clientKey('local', 'claude')]))
    expect(view.phase).toBe('restart')
    expect(view.ready).toBe('0.1.37-owl.20261013.1')
    expect(updateAllWords(view)).toMatchObject({ title: 'Restart to finish', sub: '0.1.37-owl.20261012.1 → 0.1.37-owl.20261013.1', notes: [] })
    // The restart step says what restarting installs and what happens to the threads it stops.
    const restart = (working: number, resumes: boolean) => updateAllSteps(view, { working, resumes }).at(-1)
    expect(restart(2, true)).toMatchObject({ title: 'Restart Sotto', state: 'ready', detail: 'Installs 0.1.37-owl.20261013.1. 2 working threads here stop and resume after.' })
    expect(restart(1, false)!.detail).toBe('Installs 0.1.37-owl.20261013.1. 1 working thread here stops; drafts and history stay.')
    expect(restart(0, true)!.detail).toBe('Installs 0.1.37-owl.20261013.1.')
  })

  it('does not wait for a host that waits for its threads before asking to restart', () => {
    const view = updateAllView(sources({ app: status({ phase: 'downloaded', version: '0.1.38', problem: null }), hostUpdates: [hostUpdate({ phase: 'waiting', working: 1 })] }),
      pass(['sotto', hostKey(FORGE)]))
    expect(view.phase).toBe('restart')
    // Its wait lasts only while Sotto is open, and the card says so.
    expect(updateAllWords(view).notes).toEqual(['forge is waiting for its threads. If Sotto restarts first, Update all offers it again.'])
    expect(view.items.find(item => item.kind === 'host')).toMatchObject({ state: 'waiting', cancellable: true })
  })

  it('ends without a restart when Sotto itself had nothing new, naming what did not update', () => {
    const view = updateAllView(sources({ app: status({ phase: 'unsupported' }), hostUpdates: [hostUpdate({ phase: 'failed', failure: { step: 'download', message: 'forge could not download it.', kept: 'It still runs 0.1.35.', next: 'Try again.' } })] }),
      pass([hostKey(FORGE)]))
    expect(view.phase).toBe('done')
    const words = updateAllWords(view)
    expect(words).toMatchObject({ title: 'Not everything updated', sub: 'forge’s host did not update.', pill: '1 update did not finish' })
    expect(view.items[0]).toMatchObject({ detail: 'forge could not download it. It still runs 0.1.35. Try again.', commands: 'sotto-host update' })
  })

  it('counts an install that finished with its provider disconnected as finished', () => {
    const key = clientKey('local', 'claude')
    const view = updateAllView(sources({ local: [client({ state: 'idle', ranAt: 'now' })] }), pass([key], { ranBefore: new Map([[key, 'earlier']]) }))
    expect(view.phase).toBe('done')
    expect(view.items[0]).toMatchObject({ state: 'done', detail: 'The installer finished. Connect Claude Code to see the version it runs now.' })
  })

  it('offers what is still out of date before asking to restart, when Sotto was downloaded on its own', () => {
    const view = updateAllView(sources({ app: status({ phase: 'downloaded', version: '0.1.38', problem: null }), local: [client()] }), null)
    expect(view.phase).toBe('offer')
    expect(updateAllWords(view).notes).toEqual(['Threads keep working while clients update.'])
    // Sotto's download is done; its restart waits behind what is still offered.
    expect(updateAllSteps(view, { working: 0, resumes: true }).map(step => [step.title, step.state, step.detail])).toEqual([
      ['Download Sotto Owl', 'done', 'This computer · Downloaded. It installs when Sotto restarts.'],
      ['Update Claude Code', 'offered', 'This computer'],
      ['Restart Sotto', 'last', 'Last. Sotto asks before it restarts.'],
    ])
  })

  it('offers Cancel update while a host downloads and checks, and not once it installs', () => {
    const at = (step: HostUpdateState['step']) => updateAllView(sources({ hostUpdates: [hostUpdate({ phase: 'updating', step })] }), pass([hostKey(FORGE)])).items[0]!.cancellable
    expect([at('download'), at('check'), at('install'), at('restart')]).toEqual([true, true, false, false])
  })

  it('says why an updater refused part of the press', () => {
    const key = clientKey('local', 'claude')
    const view = updateAllView(sources({ local: [client()] }), pass([key], { refused: new Map([[key, 'Another update is running.']]) }))
    expect(view.items[0]).toMatchObject({ state: 'failed', detail: 'Another update is running.' })
  })
})

describe('the steps (ADR-0077, layout C)', () => {
  const owl = (phase: UpdateStatus['phase']): UpdateStatus => ({ currentVersion: '0.1.38-owl.20261014.1', releaseTrack: 'owl', phase, checkedAt: 1 })
  const waiting = { phase: 'available', version: '0.1.38-owl.20261014.2', problem: null } as const
  const forgeHost = hostUpdate({ from: '0.1.38-owl.20261014.1', to: '0.1.38-owl.20261014.2' })
  const both = () => sources({ app: owl(waiting), local: [client({ id: 'codex', installed: '0.47.2', published: '0.48.0' })],
    clientHosts: [forgeClients([client({ id: 'claude', installed: '2.4.0', published: '2.4.1' })])], hostUpdates: [forgeHost] })

  it('lists the press in the order it runs, with Sotto’s versions once in the head', () => {
    const view = updateAllView(both(), null)
    expect(updateAllSteps(view, { working: 0, resumes: true }).map(step => [step.title, step.versions, step.detail, step.state])).toEqual([
      ['Download Sotto Owl', undefined, 'This computer · Downloads now, and installs when Sotto restarts.', 'offered'],
      ['Update Codex', '0.47.2 → 0.48.0', 'This computer', 'offered'],
      ['Update Claude Code', '2.4.0 → 2.4.1', 'forge', 'offered'],
      ['Update forge’s host', undefined, 'Restarts forge’s host, so its threads are unavailable for a few seconds.', 'offered'],
      ['Restart Sotto', undefined, 'Last. Sotto asks before it restarts.', 'last'],
    ])
    expect(updateAllWords(view)).toMatchObject({ title: 'Updates', sub: '0.1.38-owl.20261014.1 → 0.1.38-owl.20261014.2', summary: 'Sotto, 2 clients and forge' })
  })

  it('no longer repeats a host’s restart below the steps', () => {
    const view = updateAllView(sources({ hostUpdates: [hostUpdate()] }), null)
    expect(updateAllSteps(view, { working: 0, resumes: true })).toEqual([expect.objectContaining({ title: 'Update forge’s host', versions: '0.1.35 → 0.1.37',
      detail: 'Restarts forge’s host, so its threads are unavailable for a few seconds.' })])
    expect(updateAllWords(view).notes).toEqual([])
  })

  it('counts the restart among the steps while a press runs', () => {
    const keys = ['sotto', clientKey('local', 'codex'), clientKey(FORGE, 'claude'), hostKey(FORGE)]
    const view = updateAllView(sources({ app: owl({ phase: 'downloading', version: waiting.version, percent: 62 }),
      local: [client({ id: 'codex', installed: '0.48.0', published: '0.48.0', behind: false, state: 'updated', ranAt: 'now' })],
      clientHosts: [forgeClients([client({ id: 'claude', installed: '2.4.0', published: '2.4.1', state: 'updating' })])], hostUpdates: [forgeHost] }),
    pass(keys, { after: new Set([FORGE]) }))
    expect(updateAllWords(view)).toMatchObject({ title: 'Updating', sub: '1 of 5 done', pill: 'Updating · 1 of 5' })
    const steps = updateAllSteps(view, { working: 0, resumes: true })
    expect(steps.map(step => step.state)).toEqual(['running', 'done', 'running', 'running', 'last'])
    expect(steps[0]).toMatchObject({ detail: 'This computer · Downloading · 62%', item: expect.objectContaining({ percent: 62 }) })
    // Done, its sentence says the version it runs, so the versions line goes.
    expect(steps[1]).toMatchObject({ versions: undefined, detail: 'This computer · Now 0.48.0.' })
    expect(steps[3]!.detail).toBe('Updates once forge’s clients have.')
  })

  it('gives a host its own versions when they are not Sotto’s', () => {
    const view = updateAllView(sources({ app: owl(waiting), hostUpdates: [hostUpdate({ from: '0.1.37', to: '0.1.38-owl.20261014.2' })] }), null)
    expect(updateAllSteps(view, { working: 0, resumes: true })[1]).toMatchObject({ title: 'Update forge’s host', versions: '0.1.37 → 0.1.38-owl.20261014.2' })
  })

  it('says a host that finished runs the new version, and asks to restart last', () => {
    const view = updateAllView(sources({ app: owl({ phase: 'downloaded', version: waiting.version, problem: null }), hostUpdates: [{ ...forgeHost, phase: 'done' }] }),
      pass(['sotto', hostKey(FORGE)]))
    expect(view.phase).toBe('restart')
    expect(updateAllSteps(view, { working: 1, resumes: true }).map(step => [step.title, step.state, step.detail])).toEqual([
      ['Download Sotto Owl', 'done', 'This computer · Downloaded. It installs when Sotto restarts.'],
      ['Update forge’s host', 'done', 'forge runs Sotto host 0.1.38-owl.20261014.2.'],
      ['Restart Sotto', 'ready', 'Installs 0.1.38-owl.20261014.2. 1 working thread here stops and resumes after.'],
    ])
    expect(updateAllWords(view)).toMatchObject({ sub: '0.1.38-owl.20261014.1 → 0.1.38-owl.20261014.2', notes: [] })
  })

  it('says so when a host finished a version this computer stopped updating to (Sotto Bug Bot, review)', () => {
    const note = 'forge was already installing 0.1.38-owl.20261014.2 when this computer stopped updating to it, so it finished. Nothing was lost. forge runs a newer Sotto than this computer until this computer updates too.'
    const view = updateAllView(sources({ app: owl({ phase: 'up-to-date' }), hostUpdates: [{ ...forgeHost, phase: 'done', error: note }] }), pass([hostKey(FORGE)]))
    expect(updateAllSteps(view, { working: 0, resumes: true }).map(step => [step.title, step.state, step.detail])).toEqual([['Update forge’s host', 'done', note]])
  })

  it('keeps a client step the press finished once the host’s restart forgets it, and its place before the host', () => {
    const key = clientKey(FORGE, 'claude')
    const finished = updateAllView(sources({ clientHosts: [forgeClients([client({ installed: '2.4.1', published: '2.4.1', behind: false, state: 'updated', ranAt: 'now' })])],
      hostUpdates: [forgeHost] }), pass([key, hostKey(FORGE)]))
    const done = finished.items.find(item => item.key === key)!
    expect(done).toMatchObject({ state: 'done', detail: 'Now 2.4.1.' })
    // forge's host restarts: its update line starts empty, and the client is simply current.
    const restarted = updateAllView(sources({ clientHosts: [forgeClients([client({ installed: '2.4.1', published: '2.4.1', behind: false })])],
      hostUpdates: [{ ...forgeHost, phase: 'done' }] }), pass([key, hostKey(FORGE)], { kept: new Map([[key, done]]) }))
    expect(restarted.items.map(item => [item.key, item.state])).toEqual([[key, 'done'], [hostKey(FORGE), 'done']])
    expect(restarted).toMatchObject({ phase: 'done', finished: 2, total: 2 })
  })

  it('counts every step shown, a download finished before the press among them (Sol, review)', () => {
    // Sotto was downloaded first, from the update control; then a press updates forge's host.
    const view = updateAllView(sources({ app: owl({ phase: 'downloaded', version: waiting.version, problem: null }), hostUpdates: [{ ...forgeHost, phase: 'updating', step: 'download' }] }),
      pass([hostKey(FORGE)]))
    const steps = updateAllSteps(view, { working: 0, resumes: true })
    expect(steps.map(step => step.state)).toEqual(['done', 'running', 'last'])
    expect(view).toMatchObject({ phase: 'running', total: steps.length, finished: 1 })
    expect(updateAllWords(view)).toMatchObject({ sub: '1 of 3 done', pill: 'Updating · 1 of 3' })
  })

  it('carries versions as a pair and words them only for the card (Sol, review)', () => {
    const view = updateAllView(both(), null)
    expect(view.sotto).toEqual({ from: '0.1.38-owl.20261014.1', to: '0.1.38-owl.20261014.2' })
    expect(view.items.find(item => item.kind === 'host')!.versions).toEqual({ from: '0.1.38-owl.20261014.1', to: '0.1.38-owl.20261014.2' })
    expect(view.fingerprint).toContain(`${hostKey(FORGE)}@0.1.38-owl.20261014.1 → 0.1.38-owl.20261014.2`)
    expect(versionsText({ from: '2.4.1' })).toBe('2.4.1')
  })

  it('has no restart step where Sotto cannot update itself', () => {
    const view = updateAllView(sources({ app: owl({ phase: 'unsupported' }), local: [client()] }), null)
    expect(updateAllSteps(view, { working: 0, resumes: true }).map(step => step.title)).toEqual(['Update Claude Code'])
  })
})

describe('a host still being checked (ADR-0077, Sol, review)', () => {
  const owl = (phase: UpdateStatus['phase']): UpdateStatus => ({ currentVersion: '0.1.38-owl.20261014.1', releaseTrack: 'owl', phase, checkedAt: 1 })
  const downloaded = owl({ phase: 'downloaded', version: '0.1.38-owl.20261014.2', problem: null })
  const forgeOnOwl = { ...forge, version: '0.1.38-owl.20261014.1', owned: true } as HostStatus

  it('is a step one press covers, and keeps the restart back while the releases page is asked', () => {
    const view = updateAllView(sources({ app: downloaded, hosts: [forgeOnOwl], hostChecks: [FORGE] }), null)
    // Not the restart: the host may be offered the new version in a moment.
    expect(view.phase).toBe('offer')
    expect(updateAllSteps(view, { working: 0, resumes: true }).map(step => [step.title, step.state, step.versions, step.detail])).toEqual([
      ['Download Sotto Owl', 'done', undefined, 'This computer · Downloaded. It installs when Sotto restarts.'],
      ['Update forge’s host', 'checking', undefined, 'Checking the releases page for its update…'],
      ['Restart Sotto', 'last', undefined, 'Last. Sotto asks before it restarts.'],
    ])
    expect(updateAllWords(view)).toMatchObject({ summary: 'forge', pill: 'Update all' })
  })

  it('takes the place of an offer the check may change, and of nothing at all', () => {
    const offered = updateAllView(sources({ app: downloaded, hostUpdates: [hostUpdate({ to: '0.1.38-owl.20261014.1' })], hostChecks: [FORGE] }), null)
    expect(offered.items.map(item => [item.key, item.state])).toEqual([['sotto', 'done'], [hostKey(FORGE), 'checking']])
    // A host already updating keeps its own step.
    const updating = updateAllView(sources({ app: downloaded, hostUpdates: [hostUpdate({ phase: 'updating', step: 'install' })], hostChecks: [FORGE] }), pass([hostKey(FORGE)]))
    expect(updating.items[1]).toMatchObject({ state: 'running' })
  })

  it('holds the restart back for a host whose step is not its check, and gives a host Sotto did not start no check step', () => {
    // forge waits for its threads; the releases page is still asked about the version it is to get.
    const waitingHost = updateAllView(sources({ app: downloaded, hostUpdates: [hostUpdate({ phase: 'waiting', working: 1 })], hostChecks: [FORGE] }), null)
    expect(waitingHost.items[1]).toMatchObject({ state: 'waiting' })
    expect(waitingHost.phase).toBe('offer')
    // A host Sotto did not start keeps its commands, and the press does not name it. Its check shows no step, so it
    // holds nothing back: the restart is offered at once (Sotto Bug Bot, review).
    const notOurs = updateAllView(sources({ app: downloaded, hosts: [{ ...forgeOnOwl, owned: false } as HostStatus], hostChecks: [FORGE] }), null)
    expect(notOurs.items.map(item => item.state)).toEqual(['done'])
    expect(notOurs.phase).toBe('restart')
    expect(updateAllWords(notOurs).summary).not.toContain('forge')
  })

  it('runs while a press waits for the answer, and asks to restart once there is nothing more', () => {
    const waitingForIt = updateAllView(sources({ app: downloaded, hosts: [forgeOnOwl], hostChecks: [FORGE] }), pass(['sotto', hostKey(FORGE)], { joining: new Set([FORGE]) }))
    expect(waitingForIt.phase).toBe('running')
    expect(updateAllWords(waitingForIt)).toMatchObject({ title: 'Updating', sub: '1 of 3 done' })
    // The page had nothing for it: no step, and the restart is next.
    const nothing = updateAllView(sources({ app: downloaded, hosts: [forgeOnOwl] }), pass(['sotto', hostKey(FORGE)], { joining: new Set([FORGE]) }))
    expect(nothing.phase).toBe('restart')
    // It had the new version: the host's update reads as starting until the card starts it.
    const offered = updateAllView(sources({ app: downloaded, hosts: [forgeOnOwl], hostUpdates: [hostUpdate({ from: '0.1.38-owl.20261014.1', to: '0.1.38-owl.20261014.2' })] }),
      pass(['sotto', hostKey(FORGE)], { joining: new Set([FORGE]) }))
    expect(offered.phase).toBe('running')
    expect(offered.items[1]).toMatchObject({ state: 'running', detail: 'Starting…', target: '0.1.38-owl.20261014.2' })
  })
})
