import React from 'react'
import { flushSync } from 'react-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import { useAgentConnection } from '../../src/renderer/src/agents/AgentContext'
import { ThreadOptions } from '../../src/renderer/src/agents/ThreadOptions'
import { pendingSettingsStore } from '../../src/renderer/src/agents/pendingSettings'
import { agentShell, type AgentBridge, type AgentRuntimeMode } from '../../src/shared/agents'
import { claudeFixture } from '../fixtures/claudeFixture'
import { codexFixture } from '../fixtures/codexFixture'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'
import { threadSettingsStack } from '../fixtures/threadSettingsStack'

/**
 * What a permission chip press costs the user to see, measured separately (#319): press to the chip showing the
 * choice (painted selection), press to main's reply reaching the window, and press to the window drawing the
 * provider's confirmation, which is when the pending mark and its caption go. The chips run in the window over
 * the whole host stack of `threadSettingsStack`: the coordinator, the workspace and the real Claude or Codex
 * adapter over the fake client the adapter contract uses, each a real child process. There is no IPC hop, no
 * model and no network. Before this change the chip showed the confirmed value only, so its press to painted
 * selection was the press to confirmed figure.
 *
 * "Painted" is the frame React commits: jsdom lays nothing out, so a real window adds its own layout and paint on
 * top, the same for every column. Timers only, from `performance.now()`: nothing a thread says is read or reported.
 * It asserts no time, so it runs only under `SOTTO_PERF_BENCH=1` (`tests/fixtures/perfBench.ts`):
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/perf/settingsPressToPaint.perf.test.tsx --maxWorkers=1 --disable-console-intercept
 */

afterEach(() => { cleanup(); pendingSettingsStore.clear() })
// The window commits main's state on React's own schedule here, as it does in the app, rather than in act's batches.
const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }

const PRESSES = 6
const LABELS: Record<AgentRuntimeMode, string> = { 'approval-required': 'Ask for approval', 'auto-accept-edits': 'Allow edits', auto: 'Auto', 'full-access': 'Full access' }
/** Claude Code enters and leaves full access only by starting its CLI again; between the other modes it takes the change in place. */
const CASES = [
  { provider: 'claude', label: 'in place', modes: ['auto-accept-edits', 'approval-required'] },
  { provider: 'claude', label: 'restart', modes: ['full-access', 'auto-accept-edits'] },
  { provider: 'codex', label: 'in place', modes: ['full-access', 'auto-accept-edits'] },
] as const

describe.skipIf(!PERF_BENCH)('permission chip press to paint', () => {
  it.each(['claude', 'codex'] as const)('%s: reports press to painted selection, to reply and to confirmed', async provider => {
    const native = provider === 'claude' ? await claudeFixture() : await codexFixture()
    const stack = await threadSettingsStack(provider, native)
    const service = stack.host.service
    const client = desktopWindowClient('thread-settings')
    let repliedAt: number
    const bridge: AgentBridge = {
      get: async () => service.shell(),
      command: async request => { const state = agentShell(await service.command(request, client)); if (request.type === 'configure-thread') repliedAt = performance.now(); return state },
      onState: listener => service.subscribe(state => listener(agentShell(state))),
      threadDetail: async threadId => service.threadDetail(threadId),
    }
    function Chips(): React.ReactElement | null {
      const { state, command } = useAgentConnection(bridge)
      const thread = state?.host.threads.find(item => item.id === stack.threadId)
      return state && thread ? <ThreadOptions thread={thread} state={state} command={command} /> : null
    }
    const wasAct = actEnvironment.IS_REACT_ACT_ENVIRONMENT
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false
    try {
      await stack.watch()
      render(<Chips />)
      const chip = await screen.findByRole('combobox', { name: 'Thread permissions' })
      for (const { label, modes } of CASES.filter(item => item.provider === provider)) {
        const painted: number[] = [], replied: number[] = [], confirmed: number[] = []
        for (let index = 0; index < PRESSES; index += 1) {
          const mode = modes[index % modes.length]!
          if (chip.textContent === LABELS[mode]) continue
          fireEvent.click(chip)
          const option = screen.getByRole('option', { name: LABELS[mode] })
          let confirmedAt = 0
          const unsubscribe = pendingSettingsStore.subscribe(() => {
            if (confirmedAt === 0 && pendingSettingsStore.view(stack.threadId).pending.permissions === undefined) confirmedAt = performance.now()
          })
          repliedAt = 0
          const pressedAt = performance.now()
          flushSync(() => { fireEvent.click(option) })
          const paintedAt = performance.now()
          expect(chip).toHaveTextContent(LABELS[mode])
          expect(chip).toHaveAttribute('data-pending', 'true')
          // Waited outside act: inside it React holds every commit until the callback ends, and the window's commits
          // of main's broadcasts are what this measures.
          for (let waited = 0; confirmedAt === 0 && waited < 15_000; waited += 1) await new Promise(done => { setTimeout(done, 1) })
          unsubscribe()
          expect(chip).not.toHaveAttribute('data-pending')
          expect(chip).toHaveTextContent(LABELS[mode])
          painted.push(paintedAt - pressedAt); replied.push(repliedAt - pressedAt); confirmed.push(confirmedAt - pressedAt)
        }
        console.log(JSON.stringify({ provider, session: 'running', change: label, modes: modes.join(' and '), presses: painted.length,
          pressToPaintedMs: round(median(painted), 2), pressToReplyMs: round(median(replied)), pressToConfirmedMs: round(median(confirmed)),
          maxPressToPaintedMs: round(Math.max(...painted), 2) }))
      }
    } finally { cleanup(); actEnvironment.IS_REACT_ACT_ENVIRONMENT = wasAct; await stack.cleanup() }
  }, 180_000)
})
