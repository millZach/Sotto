import { z } from 'zod'

import type { AgentAssignment, AgentModel, AgentProject, AgentThread } from './agents'
import { agentRequestSchema } from './agents'
import { agentActivitySchema, MAX_AGENT_ACTIVITIES } from './agentActivity'

export const E2E_TRANSCRIPT = 'A deterministic local transcript.'
/**
 * Scripted E2E dictations stamp their history entry with this instead of the
 * wall clock, so design captures render one constant date label rather than
 * the minute the suite happened to run. Kept in the fixture era (July 2026,
 * older than a week) so the entry also stays out of the weekly stats tiles.
 */
export const E2E_HISTORY_CREATED_AT = Date.UTC(2026, 6, 12, 19, 30)
export const E2E_PRESERVED_CLIPBOARD = 'Clipboard text that must survive silence.'
export const E2E_CONFLICTING_HOTKEY = 'Ctrl+Alt+9'
export const E2E_SNAPSHOT_CHANNEL = 'sotto:e2e:snapshot'
export const E2E_TRIGGER_SHORTCUT_CHANNEL = 'sotto:e2e:trigger-shortcut'

export const e2eScenarioSchema = z.enum([
  'success',
  'history-disabled',
  'hotkey-conflict',
  'microphone-denied-once',
  'silence',
  'paste-failure',
  'transcription-failure',
  'design-permission',
  'design-processing',
  'design-threads',
  'design-threads-empty',
  'phase3-workspace',
])

export const e2eSnapshotSchema = z.object({
  openedThreadFolder: z.string().nullable().optional(),
  clipboardText: z.string(),
  pasteAttempts: z.number().int().nonnegative(),
  mainVisible: z.boolean(),
}).strict()

export type E2EScenario = z.infer<typeof e2eScenarioSchema>
export type E2ESnapshot = z.infer<typeof e2eSnapshotSchema>

export const e2eAgentEventSchema = z.object({
  type: z.enum(['ready', 'manual', 'question', 'permission', 'disconnect', 'failure', 'reasoner-release', 'uncertain', 'reject', 'connect-reject']),
  threadId: z.string(), text: z.string(), requestId: z.string().optional(), status: z.enum(['idle', 'running', 'error']).optional(),
  request: agentRequestSchema.optional(), activities: z.array(agentActivitySchema).max(MAX_AGENT_ACTIVITIES).optional(),
}).strict()

export interface SottoE2EBridge {
  agentEvent?(event: z.infer<typeof e2eAgentEventSchema>): Promise<void>
  readonly scenario: E2EScenario
  snapshot(): Promise<E2ESnapshot>
  triggerShortcut(): Promise<void>
}

/**
 * The instant the Threads page treats as "now" in the `design-threads`
 * scenario, so "Finished today", "Yesterday" and the clock times in its
 * captures never move. Same fixture era as the history entry above.
 */
export const E2E_THREADS_NOW = Date.UTC(2026, 6, 12, 19, 41)

// Kept between 14:00 and 20:00 UTC so day grouping holds from UTC-7 (the pinned capture zone) to UTC+3.
const fixtureAt = (dayOffset: number, hour: number, minute: number): string =>
  new Date(Date.UTC(2026, 6, 12 + dayOffset, hour, minute)).toISOString()

export interface DesignThreadsFixture {
  readonly models: readonly AgentModel[]
  readonly projects: readonly AgentProject[]
  readonly threads: readonly AgentThread[]
  /** Saved coordinator assignments for the fixture threads; `contextUpdatedAt` is stamped by the caller. */
  readonly assignments: readonly Omit<AgentAssignment, 'contextUpdatedAt'>[]
}

/**
 * Every Threads page state at once: a permission waiting on the user, two
 * running threads, two finished today, one Sotto stopped at the follow-up
 * limit yesterday, one finished yesterday, one from earlier in the week, and
 * one thread Sotto is not managing. Times are relative to `E2E_THREADS_NOW`.
 */
export function designThreadsFixture(): DesignThreadsFixture {
  const message = (id: string, role: 'user' | 'assistant', dayOffset: number, hour: number, minute: number, text: string): AgentThread['messages'][number] =>
    ({ id, role, text, createdAt: fixtureAt(dayOffset, hour, minute) })
  const thread = (id: string, title: string, projectId: string, modelId: string, status: AgentThread['status'], messages: AgentThread['messages'], requests: AgentThread['requests'] = []): AgentThread =>
    ({ id, title, projectId, modelId, status, messages, requests })
  const assignment = (threadId: string, startedAt: string, origin: AgentAssignment['origin'], followups: number, seen: readonly string[], own: readonly string[],
    extra: Partial<Omit<AgentAssignment, 'contextUpdatedAt'>> = {}): Omit<AgentAssignment, 'contextUpdatedAt'> =>
    ({ threadId, mode: 'managed', instruction: '', followups, paused: false, seenMessageIds: [...seen], ownMessageIds: [...own], handledRequestIds: [],
      lastFailure: '', startedAt, origin, stopReason: 'none', stoppedAt: '', ...extra })
  const threads = [
    thread('visual-gate', 'Visual gate flake', 'workshop', 'claude:sonnet', 'running', [
      message('visual-gate-1', 'user', 0, 19, 32, 'Find why the visual gate flakes on the widget listening capture and fix it.'),
      message('visual-gate-2', 'assistant', 0, 19, 41, 'Found the cause. The listening bars animate from a CSS loop, so the frame depended on where the screenshot landed. Pinned the capture to the reduced-motion branch. I want to run the unit suite before calling it fixed.'),
    ], [{ id: 'visual-gate-permission', kind: 'permission', text: 'Run a command in workshop\nnpm test -- --run tests/unit/agents', options: [] }]),
    thread('footer-links', 'Footer links', 'sotto-site', 'codex:gpt', 'running', [
      message('footer-links-1', 'user', 0, 19, 38, 'Open a Codex session in sotto-site and fix the footer links, they point at the old docs path and the help page is a 404.'),
      message('footer-links-2', 'assistant', 0, 19, 39, 'Fixing the footer links that point at the old docs path. Editing site/help.html now; the 404 on the help page is next.'),
    ]),
    thread('weekly-note', 'Weekly note', 'notes', 'grok:4', 'running', [
      message('weekly-note-1', 'user', 0, 19, 31, 'It is Friday. Write the weekly wrap from this week’s dictations and put it in notes/weekly.'),
      message('weekly-note-2', 'assistant', 0, 19, 33, 'Summarising this week’s dictations into the Friday note. Reading history from Monday onward.'),
    ]),
    thread('release-notes', 'Release notes 1.4', 'workshop', 'codex:gpt', 'idle', [
      message('release-notes-1', 'user', 0, 16, 8, 'Draft the 1.4 release notes from the changelog and my dictation, then put them in the GitHub release.'),
      message('release-notes-2', 'assistant', 0, 16, 32, 'Release notes are in the draft release. I kept the Gatekeeper instructions and the Apple silicon note from the README, as you asked last time.'),
    ]),
    thread('grok-previews', 'Grok voice previews', 'workshop', 'claude:sonnet', 'idle', [
      message('grok-previews-1', 'user', 0, 14, 5, 'Add a preview button beside each Grok voice and move the key into the system keychain.'),
      message('grok-previews-2', 'assistant', 0, 14, 58, 'Done. The preview plays a two-second sample through the selected voice, and the key never touches settings.json.'),
    ]),
    thread('wav-stall', 'Streaming WAV stall', 'workshop', 'codex:gpt', 'idle', [
      message('wav-stall-1', 'user', -1, 15, 40, 'Fix the streaming WAV stall. Playback stops at the length marker.'),
      message('wav-stall-2', 'assistant', -1, 17, 2, 'The length marker fix still fails the same playback test. I do not have an approach that differs from the last three.'),
    ]),
    thread('thread-routing', 'Thread routing', 'workshop', 'claude:sonnet', 'idle', [
      message('thread-routing-1', 'user', -1, 14, 2, 'Fix voice activation and route thread replies to the session that asked.'),
      message('thread-routing-2', 'assistant', -1, 16, 20, 'Merged to the feature branch. The wake phrase now survives a quiet room and replies land on the thread that asked.'),
    ]),
    thread('benchmark', 'Benchmark rerun', 'workshop', 'grok:4', 'idle', [
      message('benchmark-1', 'user', -4, 17, 10, 'Do that benchmark again.'),
      message('benchmark-2', 'assistant', -4, 17, 44, 'Same eleven fixtures, two runs each. Nothing moved more than a point. Table is in the results folder.'),
    ]),
    thread('notes-cleanup', 'Notes cleanup', 'notes', 'grok:4', 'idle', [
      message('notes-cleanup-1', 'user', -3, 15, 10, 'Tidy the notes folder and remove the empty daily files.'),
      message('notes-cleanup-2', 'assistant', -3, 15, 24, 'Removed nine empty daily notes and left everything with content untouched.'),
    ]),
  ]
  // Explicit provider lifecycle facts: idle work can stay open until the user settles it.
  for (const entry of threads) {
    entry.updatedAt = entry.messages.at(-1)?.createdAt
    if (['release-notes', 'thread-routing', 'benchmark', 'notes-cleanup'].includes(entry.id)) {
      entry.settledOverride = 'settled'
      entry.settledAt = entry.updatedAt
    }
  }
  const ids = (threadId: string): string[] => threads.find(entry => entry.id === threadId)?.messages.map(entry => entry.id) ?? []
  return {
    models: [
      { id: 'claude:sonnet', provider: 'Claude', name: 'Sonnet 4.5', ready: true },
      { id: 'codex:gpt', provider: 'Codex', name: 'GPT-5.4', ready: true },
      { id: 'grok:4', provider: 'Grok', name: 'Grok 4.6', ready: true },
    ],
    projects: [
      { id: 'workshop', title: 'workshop', path: 'C:/workshop' },
      { id: 'sotto-site', title: 'sotto-site', path: 'C:/sotto-site' },
      { id: 'notes', title: 'notes', path: 'C:/notes' },
    ],
    threads,
    assignments: [
      assignment('visual-gate', fixtureAt(0, 19, 32), 'voice', 2, ids('visual-gate'), []),
      assignment('footer-links', fixtureAt(0, 19, 38), 'voice', 0, ids('footer-links'), []),
      assignment('weekly-note', fixtureAt(0, 19, 31), 'typed', 1, ids('weekly-note'), ['weekly-note-1']),
      assignment('release-notes', fixtureAt(0, 16, 8), 'voice', 3, ids('release-notes'), []),
      assignment('grok-previews', fixtureAt(0, 14, 5), 'typed', 4, ids('grok-previews'), []),
      assignment('wav-stall', fixtureAt(-1, 15, 40), 'voice', 5, ids('wav-stall'), [], { paused: true, stopReason: 'limit', stoppedAt: fixtureAt(-1, 17, 2) }),
      assignment('thread-routing', fixtureAt(-1, 14, 2), 'typed', 4, ids('thread-routing'), []),
      assignment('benchmark', fixtureAt(-4, 17, 10), 'voice', 1, ids('benchmark'), []),
    ],
  }
}
