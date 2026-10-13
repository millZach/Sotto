import { describe, expect, it } from 'vitest'
import type { AgentClientHost, ProviderClientUpdate } from '../../../src/shared/agents'
import type { UpdateStatus } from '../../../src/shared/contracts'
import type { HostStatus } from '../../../src/shared/hosts'
import type { HostUpdateState } from '../../../src/shared/hostUpdates'
import { clientKey, hostKey, updateAllView, updateAllWords, type UpdateAllPass, type UpdateAllSources } from '../../../src/renderer/src/features/updates/updateAll'

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
    expect(view.items.map(item => [item.key, item.state])).toEqual([
      ['sotto', 'offered'], [clientKey('local', 'claude'), 'offered'], [clientKey('local', 'grok'), 'by-hand'],
      [hostKey(FORGE), 'offered'], [clientKey(FORGE, 'codex'), 'offered'],
    ])
    expect(view.items[2]!.detail).toBe('Update it yourself with bun update -g @xai-official/grok.')
    const words = updateAllWords(view, { working: 0, resumes: true })
    expect(words.sub).toBe('Sotto, 2 clients and forge')
    expect(words.notes).toEqual(['Threads keep working while clients update.', 'forge’s host restarts, so its threads are unavailable for a few seconds.', 'Sotto restarts last, when you say.'])
  })

  it('shows a host Sotto did not start with its commands, and offers no press for it', () => {
    const view = updateAllView(sources({ hostUpdates: [hostUpdate({ owned: false })] }), null)
    expect(view.items[0]).toMatchObject({ state: 'by-hand', commands: 'sotto-host update' })
    expect(updateAllWords(view, { working: 0, resumes: true }).sub).toBe('Sotto cannot install these itself.')
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
    expect(updateAllWords(view, { working: 0, resumes: true }).pill).toBe('Updating · 0 of 2')
  })

  it('holds a host back while the clients asked of it are still going', () => {
    const view = updateAllView(sources({ hostUpdates: [hostUpdate()], clientHosts: [forgeClients([client({ id: 'codex', state: 'updating' })])] }),
      pass([hostKey(FORGE), clientKey(FORGE, 'codex')], { after: new Set([FORGE]) }))
    expect(view.items[0]).toMatchObject({ state: 'running', detail: 'Updates once forge’s clients have.' })
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
    const resumes = updateAllWords(view, { working: 2, resumes: true })
    expect(resumes.notes).toEqual(['Sotto 0.1.37-owl.20261013.1 is downloaded. Restarting installs it.', '2 threads on this computer are working. They stop for the restart and carry on after it.'])
    expect(updateAllWords(view, { working: 1, resumes: false }).notes[1]).toBe('1 thread on this computer is working. The restart stops it; drafts and history stay.')
  })

  it('does not wait for a host that waits for its threads before asking to restart', () => {
    const view = updateAllView(sources({ app: status({ phase: 'downloaded', version: '0.1.38', problem: null }), hostUpdates: [hostUpdate({ phase: 'waiting', working: 1 })] }),
      pass(['sotto', hostKey(FORGE)]))
    expect(view.phase).toBe('restart')
    // Its wait lasts only while Sotto is open, and the card says so.
    expect(updateAllWords(view, { working: 0, resumes: true }).sub).toBe('forge is waiting for its threads. If Sotto restarts first, Update all offers it again.')
    expect(view.items.find(item => item.kind === 'host')).toMatchObject({ state: 'waiting', cancellable: true })
  })

  it('ends without a restart when Sotto itself had nothing new, naming what did not update', () => {
    const view = updateAllView(sources({ app: status({ phase: 'unsupported' }), hostUpdates: [hostUpdate({ phase: 'failed', failure: { step: 'download', message: 'forge could not download it.', kept: 'It still runs 0.1.35.', next: 'Try again.' } })] }),
      pass([hostKey(FORGE)]))
    expect(view.phase).toBe('done')
    const words = updateAllWords(view, { working: 0, resumes: true })
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
    expect(updateAllWords(view, { working: 0, resumes: true }).notes).toContain('Sotto 0.1.38 is downloaded. It restarts last, when you say.')
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
