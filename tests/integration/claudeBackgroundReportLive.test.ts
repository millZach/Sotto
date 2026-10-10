// @vitest-environment node
/**
 * Opt-in live check that a Claude thread reads Working through the turn Claude Code starts on its own to report
 * finished background work, and Done only once that report is in. It makes a synthetic project in a temporary folder
 * and runs two threads against the installed, signed-in Claude Code: one leaves a background agent running, the
 * other a background command (`sleep 20`, with bypassing allowed so the command needs no answer). Each asks Claude to
 * reply STARTED, end its turn, and report back with a reply that begins REPORT once the work is done. It samples the
 * thread every 100 ms and prints the row state the sidebar would show, with timings; no reply text is printed.
 *
 *   PowerShell:  $env:SOTTO_CLAUDE_LIVE = '1'; npx vitest run tests/integration/claudeBackgroundReportLive.test.ts --maxWorkers=1 --disable-console-intercept
 *   sh:          SOTTO_CLAUDE_LIVE=1 npx vitest run tests/integration/claudeBackgroundReportLive.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClaudeStreamJsonHost } from '../../src/main/agents/claude'
import type { AgentRuntimeMode, AgentThread } from '../../src/shared/agents'

const LIVE = process.env.SOTTO_CLAUDE_LIVE === '1'
const REPORT = 'When it later reports back, reply with one short sentence that begins REPORT:.'
const cases: Array<{ name: string; mode: AgentRuntimeMode; prompt: string }> = [
  { name: 'a background agent', mode: 'approval-required', prompt: 'Use the Agent tool with run_in_background set to true to start exactly one general-purpose background agent. Its prompt: "Without using any tools, write a 700-word short story about a lighthouse keeper, then reply with only its final sentence." After starting it, reply exactly STARTED and end your turn immediately without waiting for it. ' + REPORT },
  { name: 'a background command', mode: 'full-access', prompt: 'Use the Bash tool with run_in_background set to true to run exactly this command: sleep 20. After starting it, reply exactly STARTED and end your turn immediately without waiting. ' + REPORT },
]

/** The sidebar's words for a thread with no request or error, as `threadFacts.ts` chooses them. */
function row(thread: AgentThread): string {
  if (thread.status === 'error') return 'Needs attention'
  if (thread.status === 'running') return 'Working'
  const work = thread.backgroundWork ?? []
  return work.length ? (work.some(task => task.type !== 'command') ? 'Working' : 'Waiting') : 'Done'
}

describe.skipIf(!LIVE)("Claude reporting back on background work (live) (requires SOTTO_CLAUDE_LIVE=1)", () => {
  it.each(cases)('reads Working through the report on $name, then Done', async ({ name, mode, prompt }) => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-claude-report-live-')); const cwd = join(root, 'project'); await mkdir(cwd)
    const host = new ClaudeStreamJsonHost({ userDataPath: root, requestTimeoutMs: 20_000, pollIntervalMs: 100 })
    const id = randomUUID(); const start = Date.now(); const seconds = () => ((Date.now() - start) / 1000).toFixed(1)
    const timeline: string[] = []
    try {
      const status = await host.connect()
      expect(status.connected, status.error ?? 'Claude Code is not signed in').toBe(true)
      await host.execute({ type: 'create-project', commandId: randomUUID(), projectId: 'synthetic', title: 'Synthetic report', path: cwd })
      await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: 'synthetic', title: 'Synthetic report', modelId: 'default', runtimeMode: mode })
      host.observeThreads([id])
      expect(await host.execute({ type: 'send', commandId: randomUUID(), messageId: 'prompt', threadId: id, text: prompt })).toEqual({ accepted: true })
      let last = ''; let started = false; let ended: number | undefined; let reportedAt: number | undefined; let refused: string | undefined
      let doneBeforeReport = 0; let doneSince: number | undefined
      for (const deadline = Date.now() + 240_000; Date.now() < deadline;) {
        const thread = (await host.snapshot()).threads.find(value => value.id === id)!
        const label = row(thread); const replies = thread.messages.filter(message => message.role === 'assistant').map(message => message.text)
        if (label !== last) { timeline.push(`${seconds()}s ${label}`); last = label }
        expect(thread.requests).toEqual([])
        if (thread.backgroundWork?.length) started = true
        if (started && !thread.backgroundWork?.length) ended ??= Date.now()
        const report = replies.some(text => text.startsWith('REPORT'))
        if (report) reportedAt ??= Date.now()
        // The longest the row reads Done between the work ending and the report settling.
        if (ended !== undefined && (!report || thread.status === 'running')) {
          if (label === 'Done') doneSince ??= Date.now()
          else if (doneSince !== undefined) { doneBeforeReport = Math.max(doneBeforeReport, Date.now() - doneSince); doneSince = undefined }
        }
        if (ended !== undefined && refused === undefined && thread.status === 'running') {
          refused = await host.execute({ type: 'send', commandId: randomUUID(), messageId: 'second', threadId: id, text: 'Reply exactly SECOND.' }).then(() => 'sent', () => 'refused')
          timeline.push(`${seconds()}s a prompt sent during the report was ${refused}`)
        }
        if (report && thread.status === 'idle') break
        if (doneSince !== undefined) doneBeforeReport = Math.max(doneBeforeReport, Date.now() - doneSince)
        await new Promise(done => setTimeout(done, 100))
      }
      const thread = (await host.snapshot()).threads.find(value => value.id === id)!
      console.log(`\n${name} (Claude Code ${(await host.snapshot()).version ?? 'unknown'}):\n  ${timeline.join('\n  ')}\n  longest Done before the report settled: ${doneBeforeReport} ms\n`)
      expect(started).toBe(true)
      expect(reportedAt).toBeDefined()
      expect(row(thread)).toBe('Done')
      expect(refused).toBe('refused')
      // A sample or two may fall between the work ending and Claude Code opening its report turn.
      expect(doneBeforeReport).toBeLessThan(500)
    } finally {
      host.disconnect(); await host.closed(); await rm(root, { recursive: true, force: true })
    }
  }, 300_000)
})
