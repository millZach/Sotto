// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { PairedClients } from '../../src/main/agents/pairing'
import type { HostService } from '../../src/main/agents/hostService'
import { startSocketServer } from '../../src/host/socketServer'
import { SIGN_IN_WORDS } from '../../src/shared/opencodeSignIn'
import { openCodeEverywhere } from '../fixtures/openCodeEverywhere'
import { opencodeFixture } from '../fixtures/fakeOpenCodeFixture'
import { rawPeer } from '../fixtures/rawHostPeer'

/**
 * A host's OpenCode sign-in belongs to the client that started it for as long as it waits (#1107, #1143): after a pasted
 * code OpenCode refused, on either of the host's listeners, and up to a cancel, which always reaches OpenCode.
 */
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })

async function hostWithTwoListeners() {
  const f = await opencodeFixture(undefined, undefined, {}, { openExternal: async () => undefined })
  cleanup.push(f.cleanup)
  await f.script({ oauth: { 'gitlab:pkce': { mode: 'code' } } })
  await f.host.connect()
  const directory = await mkdtemp(join(tmpdir(), 'sotto-host-opencode-sign-in-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const pairing = new PairedClients(directory); await pairing.load()
  const state = openCodeEverywhere()
  const service = { shell: () => state, state: () => state, subscribe: () => () => undefined, command: async () => state, events: () => [] } as unknown as HostService
  // The host's two listeners, loopback and tailnet, share one OpenCode sign-in, as `src/host/index.ts` gives them.
  const signIn = f.host.signIn
  const [loopback, tailnet] = await Promise.all([startSocketServer({ service, pairing, opencodeSignIn: signIn }), startSocketServer({ service, pairing, opencodeSignIn: signIn })])
  cleanup.push(() => loopback.close(), () => tailnet.close())
  const paired = new Map<string, string>()
  const connect = async (name: string, port: number) => {
    paired.set(name, paired.get(name) ?? (await pairing.redeem(pairing.issuePairingCode().code, name)).clientId)
    const peer = await rawPeer(port, pairing.signSession(paired.get(name)!, Date.now()))
    cleanup.push(async () => peer.frames.close())
    expect(await peer.call('hello', { op: 'hello', afterSeq: 0, accepts: ['provider-opencode'] })).toMatchObject({ ok: true })
    let n = 0
    return async (call: Record<string, unknown>) => {
      const answer = await peer.call(`call-${++n}`, { op: 'opencode-sign-in', call })
      return answer.ok ? answer.result : answer.error
    }
  }
  return { f, signIn, loopback, tailnet, connect }
}

it('keeps a sign-in its starter’s after a refused code, so the next paste and a cancel still reach it', async () => {
  const { signIn, loopback, connect } = await hostWithTwoListeners()
  const desktop = await connect('Sotto desktop', loopback.descriptor.port)
  const other = await connect('Another desktop', loopback.descriptor.port)
  const started = await desktop({ action: 'browser', request: { sourceId: 'gitlab', methodId: 'pkce', answer: { instanceUrl: 'https://gitlab.com' } } }) as { status: string; attempt: { id: string } }
  expect(started.status).toBe('waiting')
  const attemptId = started.attempt.id
  expect(await desktop({ action: 'finish', request: { attemptId, code: 'wrong' } })).toEqual({ status: 'refused', reason: 'code-refused', message: SIGN_IN_WORDS.codeRefused('GitLab Duo') })
  // The attempt still waits for a code, and still only for the client that started it.
  expect(await other({ action: 'wait', request: { attemptId } })).toMatchObject({ code: 'forbidden' })
  expect(await desktop({ action: 'wait', request: { attemptId } })).toEqual({ status: 'pending' })
  const cancel = vi.spyOn(signIn, 'cancel')
  expect(await desktop({ action: 'cancel', request: { attemptId } })).toEqual({ status: 'ok' })
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(await desktop({ action: 'wait', request: { attemptId } })).toEqual({ status: 'refused', message: SIGN_IN_WORDS.notRunning })
})

it('finishes a sign-in after a refused code with the right one', async () => {
  const { loopback, connect } = await hostWithTwoListeners()
  const desktop = await connect('Sotto desktop', loopback.descriptor.port)
  const started = await desktop({ action: 'browser', request: { sourceId: 'gitlab', methodId: 'pkce', answer: { instanceUrl: 'https://gitlab.com' } } }) as { attempt: { id: string } }
  const attemptId = started.attempt.id
  expect(await desktop({ action: 'finish', request: { attemptId, code: 'wrong' } })).toMatchObject({ reason: 'code-refused' })
  expect(await desktop({ action: 'finish', request: { attemptId, code: 'good-code' } })).toMatchObject({ status: 'ok' })
})

it('keeps a sign-in its starter’s on the host’s other listener, and refuses it to any other client there', async () => {
  const { signIn, loopback, tailnet, connect } = await hostWithTwoListeners()
  const desktop = await connect('Sotto desktop', loopback.descriptor.port)
  const started = await desktop({ action: 'browser', request: { sourceId: 'gitlab', methodId: 'pkce', answer: { instanceUrl: 'https://gitlab.com' } } }) as { attempt: { id: string } }
  const attemptId = started.attempt.id
  // The same desktop, moved to the tailnet listener, still has its sign-in; another client there does not.
  const moved = await connect('Sotto desktop', tailnet.descriptor.port)
  const stranger = await connect('Another desktop', tailnet.descriptor.port)
  expect(await stranger({ action: 'page', request: { attemptId } })).toMatchObject({ code: 'forbidden' })
  expect(await stranger({ action: 'cancel', request: { attemptId } })).toMatchObject({ code: 'forbidden' })
  expect(await moved({ action: 'wait', request: { attemptId } })).toEqual({ status: 'pending' })
  expect(await moved({ action: 'page', request: { attemptId } })).toEqual({ status: 'ok', address: 'https://sign-in.fixture.invalid/gitlab/authorize?state=fixture-state' })
  const cancel = vi.spyOn(signIn, 'cancel')
  expect(await moved({ action: 'cancel', request: { attemptId } })).toEqual({ status: 'ok' })
  expect(cancel).toHaveBeenCalledTimes(1)
})

it('asks OpenCode itself about a cancel for a sign-in the host holds no owner for, rather than saying it cancelled', async () => {
  const { signIn, loopback, connect } = await hostWithTwoListeners()
  const desktop = await connect('Sotto desktop', loopback.descriptor.port)
  const cancel = vi.spyOn(signIn, 'cancel')
  expect(await desktop({ action: 'cancel', request: { attemptId: 'con_never_started' } })).toEqual({ status: 'ok' })
  expect(cancel).toHaveBeenCalledTimes(1)
  // A cancel that could not run says so, and the next one runs again.
  cancel.mockRejectedValueOnce(new Error('The server went away.'))
  const started = await desktop({ action: 'browser', request: { sourceId: 'gitlab', methodId: 'pkce', answer: { instanceUrl: 'https://gitlab.com' } } }) as { attempt: { id: string } }
  expect(await desktop({ action: 'cancel', request: { attemptId: started.attempt.id } })).toMatchObject({ code: 'unavailable' })
  expect(await desktop({ action: 'cancel', request: { attemptId: started.attempt.id } })).toEqual({ status: 'ok' })
  expect(cancel).toHaveBeenCalledTimes(3)
})
