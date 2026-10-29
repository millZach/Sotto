// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { startSocketServer } from '../../src/host/socketServer'
import { PULL_REQUEST_CONFIRMATION_LIFETIME_MS, PullRequestConfirmations } from '../../src/host/pullRequestConfirmations'
import type { HostService } from '../../src/main/agents/hostService'
import type { AgentCommand } from '../../src/shared/agents'
import type { GitPullRequestDetail, GitPullRequestRequest } from '../../src/shared/gitPullRequests'
import { rawPeer } from '../fixtures/rawHostPeer'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

// A paired client merges, closes or turns on auto-merge only with the host's own confirmation receipt for that press
// (#1691). The desktop's window asks first, but the host cannot see the window, so before this any holder of a pairing
// could merge a thread's pull request with one command.

const fixture = useSocketHostFixture()
const URL = 'https://github.com/millZach/Sotto/pull/42'
const OTHER = 'https://github.com/millZach/Sotto/pull/43'
const SHOWN = 'a'.repeat(40)

/** A pull request read as GitHub answered it; `headId` is left out when GitHub named no head. */
function detail(url: string, headId: string | undefined): GitPullRequestDetail {
  return { number: Number(url.split('/').at(-1)), url, title: 'Fix the badge', body: '', state: 'open', draft: false, baseBranch: 'main', headBranch: 'fix/badge',
    crossRepository: false, reviewDecision: null, reviews: [], mergeable: 'mergeable', checks: [], checksUnknown: false, mergeMethods: ['merge', 'squash', 'rebase'],
    autoMergeAllowed: true, autoMerge: null, mergedAt: null, behindBy: 0, canUpdateBranch: true, linked: 'linked', branch: false, ...(headId === undefined ? {} : { headId }) }
}

/**
 * A host whose service records every pull request press that reaches it, which is as far as a press gets before `gh`, and
 * answers reads of two pull requests. Its confirmation receipts keep time on `clock`, so expiry needs no sleep.
 */
async function confirmingHost(options: { reads?: boolean } = {}) {
  const clock = { now: 1_800_000_000_000 }
  /** The head the host's reads name, as GitHub would say it; undefined for a read that names none. */
  const github: { head: string | undefined } = { head: SHOWN }
  const ran: AgentCommand[] = []
  const service: HostService = {
    shell: () => fixture.host.service.shell(), state: () => fixture.host.service.state(),
    threadProvider: () => 'codex', threadDetail: () => null,
    command: async (command, identity) => {
      if (command.type !== 'git-pull-request-action') return fixture.host.service.command(command, identity)
      ran.push(command)
      return { ...fixture.host.service.state(), error: null }
    },
    events: (afterSeq, threadId, limit) => fixture.host.service.events(afterSeq, threadId, limit), subscribe: listener => fixture.host.service.subscribe(listener),
    ...(options.reads === false ? {} : { gitPullRequest: async (request: GitPullRequestRequest) => detail(request.reference ?? URL, github.head) }),
  }
  const server = await startSocketServer({ service, pairing: fixture.host.pairing, pullRequestConfirmations: new PullRequestConfirmations({ now: () => clock.now }) })
  let calls = 0
  const device = async (name: string) => {
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, name)
    const peer = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(paired.clientId))
    const hello = await peer.call('hello', { op: 'hello', accepts: ['detail-delta'] }) as { result: { features: string[] } }
    const ask = (operation: Record<string, unknown>) => peer.call(`${name}-${++calls}`, operation)
    return {
      peer, features: hello.result.features,
      read: (url = URL) => ask({ op: 'git-pull-request', request: { threadId: 'thread', reference: url } }),
      confirm: (press: Record<string, unknown>) => ask({ op: 'pull-request-confirmation', request: { threadId: 'thread', url: URL, ...press } }),
      press: (press: Record<string, unknown>) => ask({ op: 'command', command: { type: 'git-pull-request-action', threadId: 'thread', url: URL, ...press } }),
      again: (id: string, press: Record<string, unknown>) => peer.call(id, { op: 'command', command: { type: 'git-pull-request-action', threadId: 'thread', url: URL, ...press } }),
    }
  }
  return { server, clock, ran, device, github }
}
type Answer = { ok: boolean; result?: { confirmation: string; expiresAt: string }; error?: { code: string; message: string } }
const receiptOf = (answer: Record<string, unknown>): string => (answer as Answer).result!.confirmation

describe('a paired client’s merge, close and auto-merge (#1691)', () => {
  it('is refused without the host’s confirmation receipt, and nothing runs', async () => {
    const { server, ran, device } = await confirmingHost()
    const phone = await device('Phone')
    try {
      expect(server.descriptor.features).toContain('pull-request-confirmation')
      expect(phone.features).toContain('pull-request-confirmation')
      await phone.read()
      for (const [press, nothing] of [[{ action: 'merge', method: 'squash' }, 'Nothing was merged.'], [{ action: 'enable-auto-merge', method: 'merge' }, 'Auto-merge was not turned on.'],
        [{ action: 'close' }, 'The pull request was not closed.']] as const) {
        const answer = await phone.press(press) as Answer
        expect(answer).toMatchObject({ ok: false, error: { code: 'forbidden' } })
        expect(answer.error!.message).toContain(nothing)
        expect(answer.error!.message).toContain('Update Sotto on this device')
      }
      expect(ran).toEqual([])
    } finally { phone.peer.frames.close(); await server.close() }
  })

  it('runs once with a receipt for exactly that press, held to the head the host read for that device', async () => {
    const { server, ran, device } = await confirmingHost()
    const desktop = await device('Desktop')
    try {
      await desktop.read()
      const asked = await desktop.confirm({ action: 'merge', method: 'squash' }) as Answer
      expect(asked).toMatchObject({ ok: true, result: { confirmation: expect.any(String), expiresAt: new Date(1_800_000_000_000 + PULL_REQUEST_CONFIRMATION_LIFETIME_MS).toISOString() } })
      const confirmation = asked.result!.confirmation
      expect(await desktop.again('merge-1', { action: 'merge', method: 'squash', confirmation })).toMatchObject({ ok: true })
      // The coordinator hears the head, never the receipt.
      expect(ran).toEqual([{ type: 'git-pull-request-action', threadId: 'thread', url: URL, action: 'merge', method: 'squash', matchHeadCommit: SHOWN }])
      // The same request again is the same command, answered from its command receipt, and runs nothing more.
      await desktop.again('merge-1', { action: 'merge', method: 'squash', confirmation })
      await expect.poll(() => desktop.peer.messages.filter(message => message.id === 'merge-1')).toHaveLength(2)
      expect(desktop.peer.messages.filter(message => message.id === 'merge-1')[1]).toMatchObject({ ok: true })
      // A new request with a spent receipt is refused.
      const reused = await desktop.press({ action: 'merge', method: 'squash', confirmation }) as Answer
      expect(reused).toMatchObject({ ok: false, error: { code: 'forbidden', message: 'That confirmation was already used. Nothing was merged. Press Merge again.' } })
      expect(ran).toHaveLength(1)
      // A close goes with its own receipt and takes no head: GitHub's close has none to hold.
      expect(await desktop.press({ action: 'close', confirmation: receiptOf(await desktop.confirm({ action: 'close' })) })).toMatchObject({ ok: true })
      expect(ran[1]).toEqual({ type: 'git-pull-request-action', threadId: 'thread', url: URL, action: 'close' })
    } finally { desktop.peer.frames.close(); await server.close() }
  })

  it('is refused on a receipt that expired, with nothing run', async () => {
    const { server, clock, ran, device } = await confirmingHost()
    const desktop = await device('Desktop')
    try {
      await desktop.read()
      const late = receiptOf(await desktop.confirm({ action: 'merge', method: 'rebase' }))
      const inTime = receiptOf(await desktop.confirm({ action: 'merge', method: 'rebase' }))
      clock.now += PULL_REQUEST_CONFIRMATION_LIFETIME_MS - 1
      expect(await desktop.press({ action: 'merge', method: 'rebase', confirmation: inTime })).toMatchObject({ ok: true })
      clock.now += 1
      expect(await desktop.press({ action: 'merge', method: 'rebase', confirmation: late })).toMatchObject({ ok: false,
        error: { code: 'forbidden', message: 'That confirmation expired before the press reached this host. Nothing was merged. Press Merge again.' } })
      expect(ran).toHaveLength(1)
      // Long after, the host has let it go, and says it has no record of it.
      clock.now += PULL_REQUEST_CONFIRMATION_LIFETIME_MS
      expect(await desktop.press({ action: 'merge', method: 'rebase', confirmation: late })).toMatchObject({ ok: false,
        error: { code: 'forbidden', message: 'This host has no record of that confirmation. It may have restarted since. Nothing was merged. Press Merge again.' } })
      expect(ran).toHaveLength(1)
    } finally { desktop.peer.frames.close(); await server.close() }
  })

  it('is refused on another device’s receipt, which stays its own device’s to use', async () => {
    const { server, ran, device } = await confirmingHost()
    const desktop = await device('Desktop'), phone = await device('Phone')
    try {
      await desktop.read(); await phone.read()
      const confirmation = receiptOf(await desktop.confirm({ action: 'enable-auto-merge', method: 'squash' }))
      expect(await phone.press({ action: 'enable-auto-merge', method: 'squash', confirmation })).toMatchObject({ ok: false,
        error: { code: 'forbidden', message: 'That confirmation was given to another device. Auto-merge was not turned on. Press Merge when ready again on this device.' } })
      expect(ran).toEqual([])
      expect(await desktop.press({ action: 'enable-auto-merge', method: 'squash', confirmation })).toMatchObject({ ok: true })
      expect(ran).toEqual([{ type: 'git-pull-request-action', threadId: 'thread', url: URL, action: 'enable-auto-merge', method: 'squash', matchHeadCommit: SHOWN }])
    } finally { desktop.peer.frames.close(); phone.peer.frames.close(); await server.close() }
  })

  it('is refused on a receipt for another action, pull request, method or thread, which that try spends', async () => {
    const { server, ran, device } = await confirmingHost()
    const desktop = await device('Desktop')
    try {
      await desktop.read()
      const mismatches: Array<[Record<string, unknown>, Record<string, unknown>]> = [
        [{ action: 'merge', method: 'squash' }, { action: 'close' }],
        [{ action: 'merge', method: 'squash' }, { action: 'enable-auto-merge', method: 'squash' }],
        [{ action: 'merge', method: 'squash' }, { action: 'merge', method: 'merge' }],
        [{ action: 'merge', method: 'squash' }, { action: 'merge', method: 'squash', url: OTHER }],
        [{ action: 'merge', method: 'squash' }, { action: 'merge', method: 'squash', threadId: 'another-thread' }],
      ]
      for (const [given, sent] of mismatches) {
        const confirmation = receiptOf(await desktop.confirm(given))
        const answer = await desktop.press({ ...sent, confirmation }) as Answer
        expect(answer, JSON.stringify(sent)).toMatchObject({ ok: false, error: { code: 'forbidden' } })
        expect(answer.error!.message).toMatch(/^That confirmation was for a different press\. /u)
        // The receipt went with the try, so even the press it was for is refused now.
        expect(await desktop.press({ ...given, confirmation })).toMatchObject({ ok: false, error: { message: 'That confirmation was already used. Nothing was merged. Press Merge again.' } })
      }
      expect(ran).toEqual([])
    } finally { desktop.peer.frames.close(); await server.close() }
  })

  it('gives no receipt for a pull request the host has not read for that device, and lets no client name the head', async () => {
    const { server, ran, device } = await confirmingHost()
    const desktop = await device('Desktop'), phone = await device('Phone')
    try {
      // Another device's read is not this one's.
      await phone.read()
      expect(await desktop.confirm({ action: 'merge', method: 'squash' })).toMatchObject({ ok: false, error: { code: 'forbidden',
        message: 'This host has not read this pull request for this device since it started. Nothing was merged. Open the pull request again so Sotto reads it, then press Merge again.' } })
      await desktop.read(OTHER)
      expect(await desktop.confirm({ action: 'merge', method: 'squash' })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
      // A press that needs no receipt is unchanged, and the head is the host's to set from a receipt, never a client's.
      expect(await desktop.press({ action: 'ready' })).toMatchObject({ ok: true })
      expect(await desktop.press({ action: 'merge', method: 'squash', matchHeadCommit: SHOWN })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
      expect(ran).toEqual([{ type: 'git-pull-request-action', threadId: 'thread', url: URL, action: 'ready' }])
    } finally { desktop.peer.frames.close(); phone.peer.frames.close(); await server.close() }
  })

  it('gives no merge or auto-merge receipt for a pull request read without its head commit, and still closes it', async () => {
    const { server, ran, device, github } = await confirmingHost()
    const desktop = await device('Desktop')
    try {
      // GitHub named no head, or something that is not a commit: there is nothing to hold a merge to.
      for (const head of [undefined, 'not-a-commit']) {
        github.head = head
        await desktop.read()
        expect(await desktop.confirm({ action: 'merge', method: 'squash' })).toMatchObject({ ok: false, error: { code: 'forbidden',
          message: 'GitHub did not say which commit this pull request is on when this host last read it for this device. Nothing was merged. Open the pull request again so Sotto reads it, then press Merge again.' } })
        expect(await desktop.confirm({ action: 'enable-auto-merge', method: 'merge' })).toMatchObject({ ok: false, error: { code: 'forbidden',
          message: 'GitHub did not say which commit this pull request is on when this host last read it for this device. Auto-merge was not turned on. Open the pull request again so Sotto reads it, then press Merge when ready again.' } })
      }
      expect(ran).toEqual([])
      // Closing holds GitHub to no head, so it goes on as before.
      expect(await desktop.press({ action: 'close', confirmation: receiptOf(await desktop.confirm({ action: 'close' })) })).toMatchObject({ ok: true })
      expect(ran).toEqual([{ type: 'git-pull-request-action', threadId: 'thread', url: URL, action: 'close' }])
      // Once a read names the head again, a merge receipt is given and holds the merge to it.
      github.head = SHOWN
      await desktop.read()
      expect(await desktop.press({ action: 'merge', method: 'squash', confirmation: receiptOf(await desktop.confirm({ action: 'merge', method: 'squash' })) })).toMatchObject({ ok: true })
      expect(ran.at(-1)).toEqual({ type: 'git-pull-request-action', threadId: 'thread', url: URL, action: 'merge', method: 'squash', matchHeadCommit: SHOWN })
    } finally { desktop.peer.frames.close(); await server.close() }
  })

  it('is not offered by a host that reads no pull requests, which then takes no merge from a paired client at all', async () => {
    const { server, ran, device } = await confirmingHost({ reads: false })
    const desktop = await device('Desktop')
    try {
      expect(server.descriptor.features).not.toContain('pull-request-confirmation')
      expect(await desktop.confirm({ action: 'merge', method: 'squash' })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
      expect(await desktop.press({ action: 'merge', method: 'squash' })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
      expect(ran).toEqual([])
    } finally { desktop.peer.frames.close(); await server.close() }
  })
})
