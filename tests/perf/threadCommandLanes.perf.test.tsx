import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentControl } from '../../src/main/agents/control'
import { AgentCredentials } from '../../src/main/agents/credentials'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import type { AgentHostCommand } from '../../src/main/agents/host'
import { useAgentConnection } from '../../src/renderer/src/agents/AgentContext'
import type { AgentBridge, AgentState } from '../../src/shared/agents'
import { immediatePublishScheduler } from '../fixtures/publishScheduler'
import { agentBridgeFor } from '../fixtures/agentBridge'

/**
 * How long a settings change on one thread waits while another thread's answer is still pending.
 *
 * The window runs over a real coordinator and the fixture provider, both in this process, so there is
 * no IPC hop: the figures are the wait the window itself adds, not app latency. The provider takes
 * `ACK_MS` to acknowledge the answer, standing in for a real adapter's round trip. Each run answers a
 * fresh question on Docs, then changes Workshop's permission mode at once, and times two things from
 * that second call with `performance.now()`: when the command reaches the bridge, and when its reply
 * lands back in the window. Nothing a user wrote is read or reported, only the two durations.
 *
 * Runs only when asked: `SOTTO_PERF_LANES=1 npx vitest run tests/perf/threadCommandLanes.perf.test.tsx --disable-console-intercept`.
 * With `SOTTO_PERF_ASSERT=1` as well it also holds the window to its budget.
 */

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const RUNS = 8
const ACKS_MS = [0, 250] as const

const median = (values: number[]): number => {
  const sorted = [...values].sort((first, second) => first - second)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}
const round = (value: number): number => Math.round(value * 10) / 10

describe.runIf(process.env.SOTTO_PERF_LANES === '1')('thread command lanes in the window', () => {
  it('reports how long one thread’s settings wait behind another thread’s pending answer', async () => {
    const report: Record<string, { reachedMainMs: number; replyMs: number; answerMs: number }> = {}
    for (const ackMs of ACKS_MS) {
      const root = await mkdtemp(join(tmpdir(), 'sotto-perf-lanes-'))
      const host = new E2EAgentHost()
      const credentials = new AgentCredentials(root, { isEncryptionAvailable: () => false, encryptString: value => Buffer.from(value), decryptString: value => value.toString() })
      const control = new AgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner: e2eAgentReasoner,
        membership: { status: async () => ({ status: 'beta', label: 'Test', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Test', expiresAt: null }) } })
      try {
        await credentials.load(); await control.start(); await control.command({ type: 'connect' })
        const execute = host.execute.bind(host)
        vi.spyOn(host, 'execute').mockImplementation(async (command: AgentHostCommand) => {
          if (command.type === 'answer' && ackMs > 0) await new Promise(done => { setTimeout(done, ackMs) })
          return execute(command)
        })
        let reachedAt = 0
        const inner = agentBridgeFor(control)
        const bridge: AgentBridge = { ...inner, command: request => {
          if (request.type === 'configure-thread') reachedAt = performance.now()
          return inner.command(request)
        } }
        const { result, unmount } = renderHook(() => useAgentConnection(bridge))
        await waitFor(() => expect(result.current.state).not.toBeNull())
        const reached: number[] = [], replied: number[] = [], answered: number[] = []
        for (let run = 0; run < RUNS; run += 1) {
          const requestId = `perf-request-${run}`
          act(() => host.event({ type: 'question', threadId: 'docs', requestId, text: 'Continue?', status: 'waiting' }))
          await waitFor(() => expect(control.get().host.threads.find(thread => thread.id === 'docs')?.requests.some(request => request.id === requestId)).toBe(true))
          let answer: Promise<AgentState | null> | undefined, settings: Promise<AgentState | null> | undefined
          const started = performance.now()
          act(() => {
            answer = result.current.command({ type: 'answer', threadId: 'docs', requestId, answer: 'Yes' })
            settings = result.current.command({ type: 'configure-thread', threadId: 'workshop', runtimeMode: run % 2 === 0 ? 'full-access' : 'approval-required' })
          })
          let answerAt = 0, settingsAt = 0
          await act(async () => {
            await Promise.all([answer!.then(() => { answerAt = performance.now() }), settings!.then(() => { settingsAt = performance.now() })])
          })
          reached.push(reachedAt - started); replied.push(settingsAt - started); answered.push(answerAt - started)
        }
        unmount()
        report[`ack ${ackMs} ms`] = { reachedMainMs: round(median(reached)), replyMs: round(median(replied)), answerMs: round(median(answered)) }
        if (process.env.SOTTO_PERF_ASSERT === '1' && ackMs > 0) expect(median(reached)).toBeLessThan(ackMs / 2)
      } finally {
        cleanup(); control.dispose(); await control.privacyChanged()
        // Only ever removes the folder this run made under the system's temporary directory.
        if (dirname(resolve(root)) === resolve(tmpdir()) && root.includes('sotto-perf-lanes-')) await rm(root, { recursive: true, force: true })
      }
    }
    console.info(`thread command lanes (median of ${RUNS}): ${JSON.stringify(report)}`)
    expect(Object.keys(report)).toHaveLength(ACKS_MS.length)
  }, 60_000)
})
