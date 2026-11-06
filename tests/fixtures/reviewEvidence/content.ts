import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentMessage, AgentRequest } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'

/**
 * What the review-evidence threads say: the kind of session Sotto is compared on, a repository review ("What do you
 * think of this repository?") and then a plan for splitting its largest module, `AgentControl`, across pull requests.
 * The content is Sotto's own repository, described as it is, so file paths, commands and numbers read true. Data only;
 * every pixel still comes from the real renderer.
 */
type Message = AgentMessage
type Activity = AgentActivity

/** Minutes before the capture clock's now, kept inside the fixture era's afternoon. */
export const minutesAgo = (minutes: number): string => new Date(E2E_THREADS_NOW - minutes * 60_000).toISOString()
const user = (id: string, minutes: number, text: string): Message => ({ id, role: 'user', text, createdAt: minutesAgo(minutes) })
const assistant = (id: string, minutes: number, text: string): Message => ({ id, role: 'assistant', text, createdAt: minutesAgo(minutes) })

/**
 * The folder the threads' commands ran in. A provider reports each command's folder, and a thread's commands run in the
 * thread's own folder, which in the capture is the evidence repository; it is only known once the capture builds it.
 */
let commandFolder = 'D:\\Projects\\sotto'
const ranInFixtureFolder: Activity[] = []

/** Puts every command, written and still to be written, in the folder the capture's project is in. */
export function placeCommandsIn(folder: string): void {
  commandFolder = folder
  for (const record of ranInFixtureFolder) record.cwd = folder
}

/** Builds one turn's records in order, so sequence numbers and anchors stay right as a thread is written. */
class Turn {
  private sequence = 0
  readonly records: Activity[] = []
  constructor(readonly turnId: string, readonly anchor: string, status: Activity['status'], durationMs: number | undefined, startedMinutesAgo: number) {
    this.records.push({ id: `turn:${turnId}`, turnId, sequence: this.sequence++, afterMessageId: anchor, kind: 'turn', status, title: 'Turn',
      startedAt: minutesAgo(startedMinutesAgo), timingSource: 'provider', ...(durationMs === undefined ? {} : { durationMs, completedAt: new Date(Date.parse(minutesAgo(startedMinutesAgo)) + durationMs).toISOString() }) })
  }
  private add(patch: Partial<Activity> & Pick<Activity, 'id' | 'kind' | 'title'>, after = this.anchor): this {
    const record: Activity = { turnId: this.turnId, sequence: this.sequence++, afterMessageId: after, status: 'completed', timingSource: 'provider', ...patch }
    if (record.cwd !== undefined) ranInFixtureFolder.push(record)
    this.records.push(record)
    return this
  }
  command(id: string, command: string, output: string, durationMs = 180, status: Activity['status'] = 'completed', after?: string): this {
    return this.add({ id, kind: 'command', title: 'Command', command, cwd: commandFolder, output, status,
      ...(status === 'running' ? {} : { durationMs, exitCode: status === 'failed' ? 1 : 0 }) }, after)
  }
  /** The command just added, with the input Claude sends for it: the command and what it is for. */
  described(description: string): this {
    // In place, so the record keeps its place among those placeCommandsIn moves.
    this.records.at(-1)!.text = JSON.stringify({ command: this.records.at(-1)!.command, description })
    return this
  }
  reasoning(id: string, text: string, after?: string): this { return this.add({ id, kind: 'reasoning', title: 'Reasoning summary', text }, after) }
  edit(id: string, path: string, kind: 'update' | 'add' | 'delete', diff: string, after?: string): this {
    return this.add({ id, kind: 'file-change', title: 'File changes', changes: [{ path, kind, diff }], durationMs: 240 }, after)
  }
  plan(id: string, title: string, steps: NonNullable<Activity['steps']>, status: Activity['status'] = 'running', after?: string): this {
    return this.add({ id, kind: 'plan', title, steps, status }, after)
  }
  subagent(id: string, title: string, text: string, agents: NonNullable<Activity['agents']>, status: Activity['status'] = 'completed', after?: string): this {
    return this.add({ id, kind: 'subagent', title, text, agents, status, ...(status === 'completed' ? { durationMs: 42_000 } : {}) }, after)
  }
}

const CONTROL_TOP = `import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { AgentHost, AgentHostCommand, AgentHostResult } from './host'
import { publishWindow, type PublishWindow } from './publishWindows'
import { ThreadStore } from './threadStore'
…
export class AgentControl {
  private readonly hosts = new Map<ProviderId, AgentHost>()
  private readonly pendingSends = new Map<string, PendingSend>()
  private readonly store: ThreadStore`

const WC = `   7160 src/main/agents/control.ts
   3412 src/main/agents/workspace.ts
   2871 src/main/agents/codex.ts
   2694 src/main/agents/claude.ts
   1980 src/main/ipc/registerIpc.ts
  18117 total`

export interface EvidenceThread {
  readonly key: string
  readonly id: string
  readonly title: string
  readonly modelId: string
  readonly project: 'sotto' | 'workshop' | 'sotto-site' | 'notes'
  readonly status: 'idle' | 'running' | 'error'
  readonly messages: readonly Message[]
  readonly activities?: readonly Activity[]
}

/** Stable identifiers, so a thread is the same thread in every run. */
const threadId = (index: number): string => `5e1f0000-7a11-4c00-8000-${String(index).padStart(12, '0')}`

// ---- The finished review: "What do you think of this repository?" ----

const REVIEW_REPLY = `## The short version

This is a well-kept repository with one large problem. The conventions are written down, the tests are real, and the decisions are recorded where you can find them. The problem is \`src/main/agents/control.ts\`: at 7,160 lines, \`AgentControl\` is the one file every feature has to touch, and it shows in the history.

## What is working

- **The brief is honest.** \`AGENTS.md\` names what is expensive to get wrong and leaves the rest alone. \`CONTEXT.md\` is a glossary people clearly use, because the code's names match it.
- **Decisions have a home.** There are 188 ADRs in \`docs/adr/\`, and the ones I spot-checked still describe the code. ADR-0004 (authority lives only in policy records) is enforced in one place.
- **Tests run real things.** \`tests/integration/\` drives real child processes and the fake providers in \`tests/fixtures/\`, and every adapter passes \`adapterContract.ts\`.
- **Performance has budgets.** \`streamingCopyBudget.perf.test.ts\` counts what one update copies, so a regression fails instead of drifting.

## What worries me

1. **\`AgentControl\` owns too much.** It routes sends, tracks turns, answers permissions, keeps the outbox and publishes state. Those jobs share private fields, so a change to one can break another without a type error.
2. **The update path is easy to slow down.** It reads state without copying, by convention. \`copySites.test.ts\` catches a new copy, but only after someone has written it.
3. **Some test files have grown with it.** \`workspaceControl.test.ts\` builds a whole coordinator for each case, which is why the suite needs generous deadlines.

## Where I would start

Move the code with the fewest readers first. The permission ledger is a good first cut, because everything it touches goes through one seam:

\`\`\`ts
// src/main/agents/control.ts, today
private answerRequest(threadId: string, requestId: string, answer: RequestAnswer): AgentHostResult {
  const thread = this.requireThread(threadId)
  const request = thread.requests.find(item => item.id === requestId)
  if (!request) return { accepted: false, error: 'REQUEST_GONE' }
  return this.policy.answer(thread, request, answer) // the only caller that may grant anything
}
\`\`\`

That method and its four helpers can leave as \`permissionLedger.ts\` with no change to what a window sees. If you want, I can plan the whole split as a series of small pull requests, each one safe to merge by itself.`

const reviewTurn = new Turn('review-1', 'review-u1', 'completed', 214_000, 96)
  .reasoning('review-r1', '**Getting the lay of the land**\n\nStarting from the brief and the glossary, then the largest files, since those are where a repository like this usually keeps its problems.')
  .command('review-c1', 'cat AGENTS.md', '# Sotto\n\nSotto is an Electron desktop app: a dictation tool that is becoming a development coordinator, driving Codex, Claude Code, Grok Build and Devin threads. …', 90)
  .command('review-c2', 'cat CONTEXT.md | head -n 60', '# Sotto domain context\n\nSotto is a desktop dictation app with manual coding threads across native providers. …', 70)
  .command('review-c3', 'ls docs/adr | wc -l', '188', 60)
  .command('review-c4', 'wc -l src/main/agents/*.ts src/main/ipc/*.ts | sort -n | tail -n 6', WC, 140)
  .command('review-c5', 'sed -n 559,640p src/main/agents/control.ts', CONTROL_TOP, 80)
  .command('review-c6', 'git log --since="3 months ago" --format= --name-only | sort | uniq -c | sort -rn | head -n 8',
    '    412 CONTEXT.md\n    388 src/main/agents/control.ts\n    301 src/renderer/src/agents/ThreadPane.tsx\n    276 src/main/index.ts\n    251 src/shared/agents.ts\n    240 src/main/ipc/registerIpc.ts\n    233 README.md\n    198 docs/guide.md', 1_420)
  .command('review-c7', 'rg -n "private answerRequest" src/main/agents/control.ts', '3184:  private answerRequest(threadId: string, requestId: string, answer: RequestAnswer): AgentHostResult {', 60)

const REVIEW: EvidenceThread = {
  key: 'review', id: threadId(1), title: 'Repository review', modelId: 'claude:sonnet', project: 'sotto', status: 'idle',
  messages: [user('review-u1', 96, 'What do you think of this repository?'), assistant('review-a1', 92, REVIEW_REPLY)],
  activities: reviewTurn.records,
}

// ---- The plan running with its steps ----

const PLAN_STEPS: NonNullable<Activity['steps']> = [
  { text: 'List every job AgentControl does and the private fields each one reads', status: 'completed' },
  { text: 'Count the callers of each public method across src/main and src/host', status: 'completed' },
  { text: 'Find which jobs touch the update path, and keep those for last', status: 'completed' },
  { text: 'Order the cuts so each pull request is safe to merge alone', status: 'running', active: 'Ordering the cuts so each pull request is safe to merge alone' },
  { text: 'Write docs/plans/agent-control-split.md with the order and the seams', status: 'pending' },
  { text: 'Name the tests that hold each cut, and what moves with it', status: 'pending' },
  { text: 'Check the plan against ADR-0002 and ADR-0004 before asking for review', status: 'pending' },
]

const planTurn = new Turn('plan-1', 'plan-u1', 'running', undefined, 6)
  .reasoning('plan-r1', '**Planning the split**\n\nThe order matters more than the seams. Each cut has to leave the update path alone until the very end, so nothing here can make streaming slower by accident.')
  .plan('plan-p1', 'Plan the split', PLAN_STEPS)
  .command('plan-c1', 'rg -c "this\\.(pendingSends|outbox|turns|requests)" src/main/agents/control.ts', '412', 70).described('Count reads of the shared private fields')
  .command('plan-c2', 'rg -n "^  (async )?[a-zA-Z]+\\(" src/main/agents/control.ts | wc -l', '184', 60).described('Count the methods AgentControl has')
  .command('plan-c3', 'rg -l "agentControl\\." src/main src/host | xargs wc -l | tail -n 1', '  9841 total', 210).described('Measure the files that call AgentControl')
  .command('plan-c4', 'cat src/main/agents/publishWindows.ts', 'export interface PublishWindow {\n  readonly threadId: string\n  readonly opensAt: number\n  …', 40).described('Read the publish windows module')
  .command('plan-c5', 'cat tests/unit/main/workspaceControl.test.ts | head -n 80', "import { describe, expect, test } from 'vitest'\n…", 0, 'running').described('Read how the workspace control tests build a coordinator')

const PLAN: EvidenceThread = {
  key: 'plan', id: threadId(2), title: 'Plan the split', modelId: 'claude:sonnet', project: 'sotto', status: 'running',
  messages: [
    user('plan-u0', 40, 'Yes, plan it. Split AgentControl across several pull requests, smallest risk first.'),
    assistant('plan-a0', 34, 'I read the callers first. The class does five jobs: routing sends, tracking turns, answering permissions, keeping the outbox and publishing state. Only the last one runs on the update path, so it moves last.'),
    user('plan-u1', 6, 'Good. Write the plan down with an order, the seams and which tests hold each cut.'),
  ],
  activities: planTurn.records,
}

// ---- An edit to a Markdown document ----

const DOC_DIFF = [
  '@@ -1,12 +1,38 @@',
  ' # Splitting AgentControl',
  ' ',
  '-Status: an idea. Nothing is scheduled.',
  '+Status: planned. Five pull requests, smallest risk first. Each one is safe to merge alone and changes nothing a window can see.',
  ' ',
  ' `src/main/agents/control.ts` is the one file every feature touches. It holds five jobs that share private fields, so a change to one can break another without a type error.',
  ' ',
  '-## Open questions',
  '+## The order',
  ' ',
  '-- Which job should leave first?',
  '-- Does the outbox belong with sends or with turns?',
  '+1. **The permission ledger** (`permissionLedger.ts`). Four helpers and one seam, `answerRequest`. Held by `requestPolicy.test.ts`.',
  '+2. **The outbox** (`threadOutbox.ts`). It reads `pendingSends` and nothing else, and it goes with sends rather than turns because a send can outlive its turn.',
  '+3. **Send routing** (`sendRouter.ts`). The largest cut by lines and the smallest by callers: every caller already goes through `submit`.',
  '+4. **Turn tracking** (`turnTracker.ts`). Needs the first three out of the way, because it reads what they wrote.',
  '+5. **Publishing** (`statePublisher.ts`). Last, because it is the only job on the update path. `streamingCopyBudget.perf.test.ts` and `ownerScaleWorkBudget.perf.test.ts` must stay green with no raised budget.',
  '+',
  '+## What stays',
  '+',
  '+`AgentControl` stays as the name every other file imports. After the fifth cut it holds the hosts, wires the five jobs together and answers the same public methods, each one a single line.',
  '+',
  '+## Rules for every cut',
  '+',
  '+- Move first, improve later. A pull request that moves code changes no behaviour, so its diff reads as lines removed in one file and the same lines added in another.',
  '+- Nothing outside a provider adapter learns a provider identifier (ADR-0002), and nothing but the policy record grants anything (ADR-0004).',
  '+- No new copy on the update path. When `copySites.test.ts` goes red, read without the copy.',
  ' ',
  ' ## Not in this plan',
  ' ',
  '-Changing what `AgentControl` does.',
  '+Changing what `AgentControl` does. Anything we notice on the way is a follow-up with its own issue.',
].join('\n')

const docTurn = new Turn('doc-1', 'doc-u1', 'completed', 82_000, 70)
  .reasoning('doc-r1', '**Writing the plan down**\n\nThe draft already has the argument. It needs the order, and the rules that keep each cut small.')
  .command('doc-c1', 'cat docs/plans/agent-control-split.md', '# Splitting AgentControl\n\nStatus: an idea. Nothing is scheduled.\n…', 40)
  .edit('doc-e1', 'docs/plans/agent-control-split.md', 'update', DOC_DIFF)

const DOC: EvidenceThread = {
  key: 'doc', id: threadId(3), title: 'Write the split plan down', modelId: 'codex:gpt', project: 'sotto', status: 'idle',
  messages: [
    user('doc-u1', 71, 'Update docs/plans/agent-control-split.md with the order we agreed, and the rules for each cut.'),
    assistant('doc-a1', 69, 'Updated `docs/plans/agent-control-split.md`. It now gives the five cuts in order, what holds each one, and three rules every cut follows. I left the argument at the top as it was and kept the "not in this plan" section short, so a reader can see what is out of scope.'),
  ],
  activities: docTurn.records,
}

// ---- The branch with the big diff, for Changes and the Pull request surface ----

const storeTurn = new Turn('store-1', 'store-u1', 'completed', 1_486_000, 190)
  .command('store-c1', 'git diff --stat origin/main', ' 30 files changed, 2960 insertions(+), 1233 deletions(-)', 110)
  .command('store-c2', 'npm test -- tests/integration/threadStoreWorker.test.ts tests/integration/workspaceStoreWorker.test.ts', ' Test Files  2 passed (2)\n      Tests  41 passed (41)', 48_000)
  .command('store-c3', 'npm run typecheck', '', 37_000)

const STORE: EvidenceThread = {
  key: 'store', id: threadId(4), title: 'Thread store on a worker', modelId: 'claude:sonnet', project: 'sotto', status: 'idle',
  messages: [
    user('store-u1', 192, 'Write the thread store on a worker thread and read it only on main. The writes are the biggest cost left on the update path.'),
    assistant('store-a1', 165, 'Done and pushed to `feat/thread-store-worker`, 30 files against `origin/main`. Main now reads the store and hands the worker every write in order. `storeOverlay.ts` answers reads for writes the worker has not committed, and the WAL checkpoint moved into the worker, so `walCheckpointer.ts` is gone. Tests and the typecheck pass. Four small follow-ups are still uncommitted in the working tree.'),
  ],
  activities: storeTurn.records,
}

// ---- A thread waiting on a permission request ----

const permissionTurn = new Turn('perm-1', 'perm-u1', 'running', undefined, 3)
  .command('perm-c1', 'cat tests/perf/threadStoreWorker.perf.test.ts | head -n 30', "import { describe, expect, test } from 'vitest'\n…", 40)
  .command('perm-c2', 'rg -n "SOTTO_PERF_ASSERT" tests/perf docs/ci.md', 'docs/ci.md:212:  Stopwatch budgets are opt-in through `SOTTO_PERF_ASSERT=1`.', 60)

const PERMISSION: EvidenceThread = {
  key: 'permission', id: threadId(5), title: 'Measure the store worker', modelId: 'claude:sonnet', project: 'sotto', status: 'running',
  messages: [
    user('perm-u1', 3, 'Measure the store worker against the old writer on the owner-scale workload, and put the numbers in docs/perf.'),
    assistant('perm-a1', 2, 'The benchmark needs `SOTTO_PERF_ASSERT=1` and writes its results under `docs/perf`, so I want to run it with the stopwatch budgets on. It takes about two minutes and uses real child processes.'),
  ],
  activities: permissionTurn.records,
}

export const PERMISSION_REQUEST: AgentRequest = {
  id: 'perm-request-1', kind: 'permission',
  text: 'Run a command in sotto\nSOTTO_PERF_ASSERT=1 npx vitest run tests/perf/threadStoreWorker.perf.test.ts --maxWorkers=2',
  options: [],
  permissionChoices: [
    { id: 'allow-once', label: 'Allow', kind: 'allow-once' },
    { id: 'allow-session', label: 'Allow for this session', kind: 'allow-session' },
    { id: 'deny', label: 'Deny', kind: 'deny' },
  ],
  context: {
    toolName: 'Bash', command: 'SOTTO_PERF_ASSERT=1 npx vitest run tests/perf/threadStoreWorker.perf.test.ts --maxWorkers=2', cwd: 'D:\\Projects\\sotto',
    summary: 'Runs the store worker benchmark with its stopwatch budgets on.',
  },
}

// ---- The streaming turn, as it really arrives ----

export const STREAM_THREAD_ID = threadId(6)
export const STREAM_MESSAGE_ID = 'stream-a1'
const STREAM_USER = user('stream-u1', 4, 'Trace what happens to a permission request from the provider to the window, and tell me which parts could leave AgentControl.')

/** The reply as it will read when the turn ends; it reaches the window a few words at a time. */
export const STREAM_REPLY = `A permission request crosses four layers, and only one of them needs to know about \`AgentControl\`.

## The path

1. **The adapter hears it.** \`claude.ts\` turns the provider's request into an \`AgentRequest\` and adds it to the thread's record. The provider's own identifiers stay here (ADR-0002).
2. **The coordinator keeps it.** \`AgentControl.onHostSnapshot\` compares requests by ID, and it starts the waiting clock for each new one.
3. **The policy record decides whether to ask.** \`requestPolicy.ts\` is the only place that can answer without the user, and today it has no standing grant for a command (ADR-0004).
4. **The window shows the card.** The request travels in the published state, so \`ThreadPane\` draws it without knowing anything about the provider.

## What could leave

Steps 2 and 3 can move together. Here is the seam they would share:

\`\`\`ts
export interface PermissionLedger {
  /** New requests since the last snapshot, in the order the provider asked. */
  observe(thread: AgentThread): readonly AgentRequest[]
  answer(threadId: string, requestId: string, answer: RequestAnswer): AgentHostResult
  forget(threadId: string): void
}
\`\`\`

\`AgentControl\` would call \`observe\` from its snapshot handler, and nothing else changes. The update path pays for one map lookup per thread, the same as now.

The risk is the waiting clock, because \`needs-you\` reads it directly. I would keep that read in place for the first cut and move it in a second pull request.`

/** The moments, each as the words the reply has reached: part-way through the numbered list, then inside the code block. */
const STREAM_REACHES = { second: '`requestPolicy.ts` is the only place t', third: 'observe(thread: AgentThread): readonly AgentRe' } as const
const reached = (words: string): number => STREAM_REPLY.indexOf(words) + words.length
export const STREAM_MOMENTS = { first: 0, second: reached(STREAM_REACHES.second), third: reached(STREAM_REACHES.third) } as const
/** Words on screen once a moment has arrived, as the renderer draws them. */
export const STREAM_SHOWN = { first: '', second: 'is the only place t', third: 'readonly AgentRe' } as const

const streamBase = (): Turn => new Turn('stream-1', 'stream-u1', 'running', undefined, 4)
  .reasoning('stream-r1', '**Following one request end to end**\n\nThe adapter is where a request starts, so I am reading that first, then the snapshot handler that sees it arrive.')
  .command('stream-c1', 'rg -n "kind: \'permission\'" src/main/agents/claude.ts', "1204:        kind: 'permission', text, options: [],", 60).described('Find where Claude permission requests are built')
  .command('stream-c2', 'sed -n 1190,1240p src/main/agents/claude.ts', "      const request: AgentRequest = {\n        id: requestId,\n        kind: 'permission', text, options: [],\n…", 45).described('Read the permission request builder')

/**
 * Claude's todo list for the trace, as its TodoWrite sends it once the first files are read: the items as written, the one
 * in progress with its activeForm. `writing` is the second TodoWrite, sent before the reply, with the reading done.
 */
const streamPlan = (writing: boolean): NonNullable<Activity['steps']> => [
  { text: 'Find where the Claude adapter builds a permission request', status: 'completed' },
  { text: 'Read the request policy that decides whether to ask', status: 'completed' },
  writing
    ? { text: 'Follow the request through AgentControl\'s snapshot handler', status: 'completed' }
    : { text: 'Follow the request through AgentControl\'s snapshot handler', status: 'running', active: 'Following the request through AgentControl\'s snapshot handler' },
  writing
    ? { text: 'Write up the path and which parts could leave AgentControl', status: 'running', active: 'Writing up the path and which parts could leave AgentControl' }
    : { text: 'Write up the path and which parts could leave AgentControl', status: 'pending' },
]

/**
 * The turn's steps at each moment: it reads, then writes. A provider ends a step before the words after it, so every step
 * comes before the reply being written, as Claude Code sends them; a step after the reply would mean it was done. Before the
 * first word there is no plan yet, so streaming-1 shows the line on its own; once the first files are read Claude writes its
 * todo list, and updates it before it writes the reply, so the reply streams under the plan's checklist.
 */
export function streamActivities(moment: keyof typeof STREAM_MOMENTS): readonly Activity[] {
  const turn = streamBase()
  if (moment === 'first') return turn.command('stream-c3', 'cat src/main/agents/requestPolicy.ts', 'export class RequestPolicy {\n…', 0, 'running').described('Read the request policy, which decides whether to ask').records
  return turn.command('stream-c3', 'cat src/main/agents/requestPolicy.ts', 'export class RequestPolicy {\n  answer(thread: AgentThread, request: AgentRequest, answer: RequestAnswer): AgentHostResult {\n…', 55).described('Read the request policy, which decides whether to ask')
    .plan('stream-p1', 'Plan', streamPlan(false), 'completed')
    .command('stream-c4', 'rg -n "onHostSnapshot" src/main/agents/control.ts', '2210:  private onHostSnapshot(snapshot: AgentHostSnapshot): void {', 50).described('Find where AgentControl takes a host snapshot')
    .command('stream-c5', 'sed -n 2210,2290p src/main/agents/control.ts', '  private onHostSnapshot(snapshot: AgentHostSnapshot): void {\n    for (const thread of snapshot.threads) {\n…', 48).described('Read the snapshot handler')
    .plan('stream-p2', 'Plan', streamPlan(true), 'completed').records
}

const STREAM: EvidenceThread = {
  key: 'stream', id: STREAM_THREAD_ID, title: 'Trace a permission request', modelId: 'claude:sonnet', project: 'sotto', status: 'running',
  messages: [STREAM_USER], activities: streamActivities('first'),
}

// ---- The long thread: more than 100 messages and tool calls ----

const LONG_CUTS = [
  { name: 'permissionLedger', method: 'answerRequest', lines: 412, test: 'requestPolicy', note: 'One caller outside the class needed the new import.' },
  { name: 'threadOutbox', method: 'drainOutbox', lines: 288, test: 'threadOutbox', note: 'The retry timer moved with it, so the fake clock in the test had to move too.' },
  { name: 'sendRouter', method: 'submit', lines: 934, test: 'sendRouting', note: 'A send that races a rename kept its order, which was the case I was worried about.' },
  { name: 'turnTracker', method: 'recordTurn', lines: 655, test: 'turnTracker', note: '' },
  { name: 'worktreeLeases', method: 'leaseWorktree', lines: 371, test: 'worktreeRestore', note: 'A missing worktree is still refused without removing work.' },
  { name: 'historyWindows', method: 'readEarlier', lines: 243, test: 'threadHistory', note: 'The window size stayed in the shared constant, so the iPhone path is unchanged.' },
  { name: 'titleRequests', method: 'requestTitle', lines: 198, test: 'threadTitles', note: 'Generated names still only replace the temporary branch.' },
  { name: 'providerRecovery', method: 'reconnectHost', lines: 516, test: 'workspaceRecovery', note: 'The backoff read the wrong constant before the move as well. I left it alone; it wants its own change.' },
  { name: 'settledState', method: 'settleThread', lines: 227, test: 'threadSettle', note: 'Settling is still a coordinator fact and not a provider one.' },
  { name: 'usageRollup', method: 'recordUsage', lines: 176, test: 'usageLedger', note: 'Numbers still stay on their own host (ADR-0078).' },
  { name: 'pullRequestLinks', method: 'linkPullRequest', lines: 302, test: 'pullRequestLinks', note: 'A thread can still hold several links, and the newest still leads.' },
  { name: 'statePublisher', method: 'publish', lines: 841, test: 'streamingCopyBudget', note: '' },
] as const
type LongCut = (typeof LONG_CUTS)[number]

/** A command a turn of the long thread ran: what, what came back, how long it took, and whether it failed. */
type LongCommand = readonly [command: string, output: string, ms: number, failed?: boolean]
/**
 * One exchange of the long thread: what the user asked, how long after the reply before it, what the turn did and for how
 * long, and the reply. Written as a real session goes: cuts that take minutes, quick questions answered in seconds from
 * what is already known, checks, a failure and its fix, a rebase, and the pull requests at the end.
 */
interface LongRound {
  readonly ask: string
  readonly reply: string
  /** Minutes between the reply before and this message. */
  readonly gap: number
  /** How long the turn ran. */
  readonly seconds: number
  /** What the turn did, in order. A turn that only thought has its reasoning summary alone. */
  readonly work: readonly LongStep[]
}
type LongStep =
  | { readonly think: string }
  | { readonly run: LongCommand }
  | { readonly edit: readonly [path: string, kind: 'update' | 'add', diff: string] }
  | { readonly cut: LongCut }

const cutNamed = (name: LongCut['name']): LongCut => LONG_CUTS.find(cut => cut.name === name)!
const className = (cut: LongCut): string => `${cut.name[0]!.toUpperCase()}${cut.name.slice(1)}`
const think = (text: string): LongStep => ({ think: text })
const run = (command: string, output: string, ms: number, failed?: true): LongStep => ({ run: failed ? [command, output, ms, true] : [command, output, ms] })
const edit = (path: string, diff: string, kind: 'update' | 'add' = 'update'): LongStep => ({ edit: [path, kind, diff] })
const cutOf = (name: LongCut['name']): LongStep => ({ cut: cutNamed(name) })
const passed = (files: number, tests: number): string => ` Test Files  ${files} passed (${files})\n      Tests  ${tests} passed (${tests})`
const testOf = (name: LongCut['name'], tests: number): LongStep => run(`npx vitest run tests/unit/main/${cutNamed(name).test}.test.ts`, passed(1, tests), 5_800 + tests * 90)
const typecheck = (output = '', failed?: true): LongStep => run('npm run typecheck', output, 36_000, failed)
const moved = (cut: LongCut, rest = ''): string =>
  `Moved \`${cut.method}\` and its helpers to \`src/main/agents/${cut.name}.ts\`, ${cut.lines} lines. \`control.ts\` keeps a one-line call, so nothing outside the class changed. \`${cut.test}.test.ts\` passes.${cut.note ? ` ${cut.note}` : ''}${rest ? ` ${rest}` : ''}`

const LONG_ROUNDS: readonly LongRound[] = [
  { ask: 'Go.', gap: 1, seconds: 104, work: [think('Reading the ledger and its callers'), cutOf('permissionLedger'), testOf('permissionLedger', 31)], reply: moved(cutNamed('permissionLedger')) },
  { ask: 'Which caller? I thought nothing outside the class moved.', gap: 2, seconds: 6, work: [think('The import that moved')],
    reply: '`requestPolicy.ts` imported the ledger\'s `PendingAnswer` type from `control.ts`. The type moved with the class, so that one import now points at `permissionLedger.ts`. No code outside the class changed.' },
  { ask: 'Fine. Outbox next.', gap: 1, seconds: 131, work: [cutOf('threadOutbox'), testOf('threadOutbox', 18)], reply: moved(cutNamed('threadOutbox')) },
  { ask: 'Run the whole agents folder, not just that one file.', gap: 2, seconds: 52, work: [run('npx vitest run tests/unit/main/agents', passed(41, 612), 48_200)],
    reply: 'All 41 files pass, 612 tests. The slowest is `workspaceControl.test.ts` at 9.8 s, as it was before the cut.' },
  { ask: 'Send router.', gap: 1, seconds: 198, work: [think('Where sends and renames meet'), cutOf('sendRouter'), testOf('sendRouter', 44)], reply: moved(cutNamed('sendRouter')) },
  { ask: 'What race exactly?', gap: 3, seconds: 9, work: [think('The rename and the queued send')],
    reply: 'A send that arrives while the thread is being renamed. The router queues it behind the rename, and the rename used to read `pendingSends` straight off the class. It now asks the router, which answers in the same tick, so the send still goes after the rename and before the next one.' },
  { ask: 'ok. turn tracker', gap: 2, seconds: 162, work: [cutOf('turnTracker'), testOf('turnTracker', 27),
    typecheck('tests/unit/main/turnTracker.test.ts(88,24): error TS2341: Property \'turns\' is private and only accessible within class \'TurnTracker\'.\ntests/unit/main/workspaceControl.test.ts(412,19): error TS2339: Property \'turns\' does not exist on type \'AgentControl\'.', true)],
    reply: 'Moved `recordTurn` and its helpers to `src/main/agents/turnTracker.ts`, 655 lines, but the typecheck fails: two tests read `turns` straight off the class. I have not changed them yet. Should they ask the tracker, or should I keep a getter on `AgentControl` for now?' },
  { ask: 'Make them ask the tracker. No getters for tests.', gap: 2, seconds: 113, work: [
    edit('tests/unit/main/turnTracker.test.ts', '@@ -86,3 +86,3 @@\n-    expect(tracker.turns.get(\'thread-1\')?.status).toBe(\'completed\')\n+    expect(tracker.turnOf(\'thread-1\')?.status).toBe(\'completed\')'),
    edit('tests/unit/main/workspaceControl.test.ts', '@@ -410,3 +410,3 @@\n-    const turn = control.turns.get(threadId)\n+    const turn = control.turnTracker.turnOf(threadId)'),
    testOf('turnTracker', 27), run('npx vitest run tests/unit/main/workspaceControl.test.ts', passed(1, 96), 9_800), typecheck()],
    reply: 'Both tests now ask `turnTracker.turnOf(threadId)`. The typecheck, `turnTracker.test.ts` and `workspaceControl.test.ts` pass.' },
  { ask: 'Worktree leases. Careful with that one, it is the one that removes folders.', gap: 4, seconds: 167, work: [think('What removes a checkout, and when'), cutOf('worktreeLeases'), testOf('worktreeLeases', 38), typecheck()],
    reply: moved(cutNamed('worktreeLeases'), 'Nothing in the move touches `git worktree remove`; the class only calls it through the same guard as before.') },
  { ask: 'Did you run the restore tests on a missing folder or only the happy path?', gap: 2, seconds: 11, work: [run('rg -n "missing|replaced|occupied" tests/unit/main/worktreeRestore.test.ts', '58:  it(\'restores a missing checkout on its recorded branch\', async () => {\n97:  it(\'refuses a checkout that was replaced\', async () => {\n131:  it(\'refuses a branch another worktree holds\', async () => {', 140)],
    reply: 'Both. `worktreeRestore.test.ts` has three cases for a missing checkout: restored on its recorded branch, refused when the folder was replaced, and refused when another worktree holds the branch. All three pass.' },
  { ask: 'Good. History windows next.', gap: 1, seconds: 95, work: [cutOf('historyWindows'), testOf('historyWindows', 22)], reply: moved(cutNamed('historyWindows')) },
  { ask: 'Is the iPhone path covered by a test or are you reading the code?', gap: 2, seconds: 14, work: [run('rg -ln "readEarlier|HISTORY_WINDOW" tests/integration', 'tests/integration/hostServiceContract.ts\ntests/integration/socketHost.test.ts', 120)],
    reply: 'Covered. `hostServiceContract.ts` reads earlier messages through the socket host with the shared window size, and `socketHost.test.ts` runs that contract. Both pass against the new class.' },
  { ask: 'Move `titleRequests` next.', gap: 1, seconds: 88, work: [cutOf('titleRequests'), testOf('titleRequests', 16)], reply: moved(cutNamed('titleRequests'), '`threadTitles.test.ts` covers the side call to each provider too.') },
  { ask: 'How big is control.ts now?', gap: 2, seconds: 4, work: [run('wc -l src/main/agents/control.ts', '4906 src/main/agents/control.ts', 40)],
    reply: '4,906 lines, from 7,160 when we started. Seven cuts in, five to go.' },
  { ask: 'Take a break from cutting. Rebase on main, Drake merged the settings history change.', gap: 6, seconds: 141, work: [
    run('git fetch origin', 'From github.com:millZach/Sotto\n   54978c9fb..3f5027092  main       -> origin/main', 2_100),
    run('git rebase origin/main', 'CONFLICT (content): Merge conflict in src/main/agents/control.ts\nerror: could not apply 9c1e2d4... Move requestTitle into titleRequests', 1_400, true),
    edit('src/main/agents/titleRequests.ts', '@@ -41,6 +41,8 @@ export class TitleRequests {\n   requestTitle(threadId: string): AgentHostResult {\n     const thread = this.store.requireThread(threadId)\n+    // Drake: a title asked for while settings history replays waits for it to finish.\n+    if (this.settings.replaying) return this.later(threadId)'),
    run('git rebase --continue', 'Successfully rebased and updated refs/heads/refactor/agent-control-split.', 900),
    testOf('titleRequests', 17), run('npx vitest run tests/integration/settingsHistoryIpc.test.ts', passed(1, 12), 14_300)],
    reply: 'Rebased onto `origin/main` at `3f50270`. One conflict, in `control.ts`, where Drake\'s change touched `requestTitle`\'s old home. I kept the call into `titleRequests` and moved his two lines into the class. `threadTitles.test.ts` and `settingsHistoryIpc.test.ts` pass.' },
  { ask: 'Show me those two lines.', gap: 1, seconds: 5, work: [think('Drake\'s two lines')],
    reply: 'In `TitleRequests.requestTitle`, right after the thread is read:\n\n```ts\n// Drake: a title asked for while settings history replays waits for it to finish.\nif (this.settings.replaying) return this.later(threadId)\n```' },
  { ask: 'Fine. providerRecovery.', gap: 2, seconds: 176, work: [think('Reconnect and its backoff'), cutOf('providerRecovery'), testOf('providerRecovery', 29), typecheck()], reply: moved(cutNamed('providerRecovery')) },
  { ask: 'Open an issue for the backoff now so we do not lose it.', gap: 1, seconds: 7, work: [run('gh issue create --title "Read the reconnect backoff from its own constant" --label bug', 'https://github.com/millZach/Sotto/issues/2101', 2_300)],
    reply: 'Opened #2101, "Read the reconnect backoff from its own constant", with the line that reads `RETRY_MS` and the `RECONNECT_BACKOFF_MS` it should read.' },
  { ask: 'settledState', gap: 3, seconds: 79, work: [cutOf('settledState'), testOf('settledState', 14)], reply: moved(cutNamed('settledState')) },
  { ask: 'Usage rollup, then pull request links. Both small, do them together.', gap: 2, seconds: 154, work: [cutOf('usageRollup'), testOf('usageRollup', 21), cutOf('pullRequestLinks'), testOf('pullRequestLinks', 19)],
    reply: 'Both moved. `usageRollup.ts` is 176 lines and `pullRequestLinks.ts` 302. Numbers still stay on their own host (ADR-0078), and a thread can still hold several links, the newest leading. Both test files pass.' },
  { ask: 'And the publisher. This is the one I care about for the budget.', gap: 2, seconds: 233, work: [think('What the publisher copies per update'), cutOf('statePublisher'),
    run('npx vitest run tests/perf/streamingCopyBudget.perf.test.ts', passed(1, 8), 22_400), run('npx vitest run tests/unit/main/copySites.test.ts', passed(1, 3), 4_100), typecheck()],
    reply: 'Moved `publish` to `src/main/agents/statePublisher.ts`, 841 lines. `streamingCopyBudget.perf.test.ts` counts the same as before: nothing copied per update. `copySites.test.ts` passes with the list unchanged.' },
  { ask: 'Run the owner scale budget too.', gap: 1, seconds: 74, work: [run('npx vitest run tests/perf/ownerScaleWorkBudget.perf.test.ts', passed(1, 6), 69_000)],
    reply: 'It passes on Owl and stable. With a quarter of the history, the work per update is 3% lower than before the split, because the publisher no longer walks the pending sends.' },
  { ask: 'Nice. Now go back over every cut. Did anything start reaching back into AgentControl?', gap: 5, seconds: 61, work: [
    run('rg -n "control\\." src/main/agents/{permissionLedger,threadOutbox,sendRouter,turnTracker,worktreeLeases,historyWindows}.ts', 'src/main/agents/sendRouter.ts:144:    const host = this.control.hosts.get(thread.provider)\nsrc/main/agents/turnTracker.ts:203:      this.control.settle(threadId)', 180),
    run('rg -n "control\\." src/main/agents/{titleRequests,providerRecovery,settledState,usageRollup,pullRequestLinks,statePublisher}.ts', '', 160)],
    reply: 'Two did. `turnTracker` calls `control.settle()` when a turn ends, and `sendRouter` reads `control.hosts` to find a host. The other ten read only what their constructors are given.' },
  { ask: 'Fix both. Pass in what they need.', gap: 1, seconds: 187, work: [
    edit('src/main/agents/turnTracker.ts', '@@ -12,7 +12,7 @@ export class TurnTracker {\n-  constructor(private readonly control: AgentControl, private readonly store: ThreadStore) {}\n+  constructor(private readonly store: ThreadStore, private readonly settle: (threadId: string) => void) {}'),
    edit('src/main/agents/sendRouter.ts', '@@ -20,7 +20,7 @@ export class SendRouter {\n-  constructor(private readonly control: AgentControl) {}\n+  constructor(private readonly hosts: ReadonlyMap<ProviderId, AgentHost>, private readonly store: ThreadStore) {}'),
    edit('src/main/agents/control.ts', '@@ -88,8 +88,8 @@ export class AgentControl {\n-    this.turnTracker = new TurnTracker(this, this.store)\n-    this.sendRouter = new SendRouter(this)\n+    this.turnTracker = new TurnTracker(this.store, threadId => this.settledState.settleThread(threadId))\n+    this.sendRouter = new SendRouter(this.hosts, this.store)'),
    testOf('turnTracker', 27), testOf('sendRouter', 44), typecheck()],
    reply: '`TurnTracker` now takes the store and a `settle` function, and `SendRouter` takes the hosts and the store. Neither imports `AgentControl` any more. Their tests and the typecheck pass.' },
  { ask: 'Does `permissionLedger` still need its own test file, or can the coordinator\'s tests cover it?', gap: 3, seconds: 18, work: [think('What the ledger tests reach that the coordinator cannot'), run('npx vitest run tests/unit/main/requestPolicy.test.ts --reporter=verbose', passed(1, 31), 6_100)],
    reply: 'Keep it. `requestPolicy.test.ts` builds only the ledger, so a case takes about 20 ms. The coordinator\'s tests would have to build a host, a store and a provider to reach the same 31 cases, at about 500 ms each.' },
  { ask: 'And the outbox tests?', gap: 1, seconds: 6, work: [think('The outbox tests and the fake clock')],
    reply: 'Keep those too. They drive the retry timer with a fake clock, which the coordinator\'s tests cannot do without a real host.' },
  { ask: 'ok. Typecheck and the whole unit suite, then tell me what is left.', gap: 2, seconds: 402, work: [typecheck(), run('npm test -- --maxWorkers=2', ' Test Files  1284 passed (1284)\n      Tests  14902 passed (14902)\n   Duration  6m 12s', 372_000)],
    reply: 'The typecheck passes, and so does the unit suite: 1,284 files, 14,902 tests, in 6m 12s. What is left: the doc comments that still say AgentControl, the plan\'s checklist, and the pull requests.' },
  { ask: 'Doc comments first.', gap: 1, seconds: 48, work: [run('rg -n "AgentControl" src/main/agents --glob "!control.ts" -g "*.ts"', 'src/main/agents/permissionLedger.ts:2: * The permission ledger of AgentControl: what each pending request asked and who answered it.\nsrc/main/agents/threadOutbox.ts:3: * AgentControl\'s outbox: sends that wait for a host.', 150),
    edit('src/main/agents/permissionLedger.ts', '@@ -1,4 +1,4 @@\n /**\n- * The permission ledger of AgentControl: what each pending request asked and who answered it.\n+ * The permission ledger: what each pending request asked and who answered it.'),
    edit('src/main/agents/threadOutbox.ts', '@@ -3,4 +3,4 @@\n- * AgentControl\'s outbox: sends that wait for a host.\n+ * The outbox: sends that wait for a host.')],
    reply: 'Two still said AgentControl, in `permissionLedger.ts` and `threadOutbox.ts`. Both now describe their own class, and no code changed.' },
  { ask: 'Tick the plan\'s checklist.', gap: 1, seconds: 21, work: [edit('docs/plans/agent-control-split.md', '@@ -14,14 +14,16 @@\n-- [ ] Cut 1: permission ledger\n+- [x] Cut 1: permission ledger\n …\n-- [ ] Cut 12: state publisher\n+- [x] Cut 12: state publisher\n+\n+Second pass: Cut 3 and Cut 4 no longer reach back into the coordinator.')],
    reply: 'Ticked all twelve cuts in `docs/plans/agent-control-split.md`, and noted the second pass\'s two fixes under them.' },
  { ask: 'Wait, which one was cut 3?', gap: 1, seconds: 3, work: [think('Cut 3')], reply: 'The send router. Cut 4 is the turn tracker.' },
  { ask: 'Right. How would you split this into pull requests? One per cut is too many to review.', gap: 4, seconds: 27, work: [think('Grouping the cuts so each pull request merges alone'), run('git log --oneline origin/main..HEAD', '(23 commits)', 90)],
    reply: 'Three, each safe to merge alone:\n\n1. **Requests and sends**: the ledger, the outbox and the send router, with the second-pass fix to the router.\n2. **Turns and state**: the turn tracker, settling and the publisher, with the budget runs in the description.\n3. **The rest**: worktree leases, history windows, titles, recovery, usage and links, plus the doc comments and the plan.\n\nThe first touches the fewest readers, so it goes first.' },
  { ask: 'Go with that. Make the first branch.', gap: 2, seconds: 44, work: [
    run('git switch -c refactor/split-requests-and-sends origin/main', 'Switched to a new branch \'refactor/split-requests-and-sends\'', 300),
    run('git cherry-pick 9a01c3e 4b7d2f0 c55e8a1 e1f0d93', '[refactor/split-requests-and-sends 2d4c9e1] Move the permission ledger out of AgentControl\n …\n 4 files changed, 1634 insertions(+), 1611 deletions(-)', 1_900),
    run('npx vitest run tests/unit/main/requestPolicy.test.ts tests/unit/main/threadOutbox.test.ts tests/unit/main/sendRouting.test.ts', passed(3, 93), 11_200), typecheck()],
    reply: 'The branch `refactor/split-requests-and-sends` has the four commits on top of `main`. Its three test files and the typecheck pass.' },
  { ask: 'Push it and open the pull request.', gap: 1, seconds: 26, work: [run('git push -u origin refactor/split-requests-and-sends', 'To github.com:millZach/Sotto.git\n * [new branch]      refactor/split-requests-and-sends -> refactor/split-requests-and-sends', 3_400),
    run('gh pr create --title "Move requests and sends out of AgentControl" --body-file .git/PR_BODY.md', 'https://github.com/millZach/Sotto/pull/2104', 4_800)],
    reply: 'Opened #2104, "Move requests and sends out of AgentControl". The description lists the three classes, what still calls each of them, and the tests that cover it.' },
  { ask: 'CI?', gap: 5, seconds: 5, work: [run('gh pr checks 2104', 'Gates (Windows)    pending  4m12s\nPackage result     pending\nDesktop result     pending', 1_600)],
    reply: 'Running. Gates (Windows) has been going for four minutes; Package and Desktop have not started.' },
  { ask: 'While that runs, make the second branch.', gap: 1, seconds: 58, work: [
    run('git switch -c refactor/split-turns-and-state origin/main', 'Switched to a new branch \'refactor/split-turns-and-state\'', 300),
    run('git cherry-pick 77ab0d2 0f3e6c4 a9d10b8 3e2c7f5', '[refactor/split-turns-and-state 81c0a7e] Move the state publisher out of AgentControl\n …\n 5 files changed, 1940 insertions(+), 1902 deletions(-)', 2_200),
    run('npx vitest run tests/unit/main/turnTracker.test.ts tests/unit/main/threadSettle.test.ts', passed(2, 41), 8_400), typecheck()],
    reply: '`refactor/split-turns-and-state` is ready: the tracker, settling and the publisher, with the fix that stops the tracker calling back into the coordinator. Its tests and the typecheck pass. I have not pushed it.' },
  { ask: 'Gates failed on #2104. Look.', gap: 9, seconds: 34, work: [run('gh pr checks 2104', 'Gates (Windows)    fail     11m40s\nPackage result     pass\nDesktop result     pending', 1_500),
    run('gh run view --log-failed --job 58213377', 'shard 3/4  tests/unit/main/sendRouting.test.ts > keeps a send queued behind a rename\n  Error: Test timed out in 30000ms.', 5_200)],
    reply: 'Shard 3 failed on one case: `sendRouting.test.ts`, "keeps a send queued behind a rename", timed out after 30 s on the Windows runner. Package passed. Desktop is still running.' },
  { ask: 'Is that us or a flake?', gap: 1, seconds: 96, work: [think('Whether the rename case can wait for ever'), run('npx vitest run tests/unit/main/sendRouting.test.ts -t "behind a rename" --repeat=20', ' FAIL  tests/unit/main/sendRouting.test.ts > keeps a send queued behind a rename (repeat 7)\n  Error: Test timed out in 30000ms.', 61_000, true)],
    reply: 'Us. It fails here too, once in twenty runs. The test waits for the rename to settle, but on this branch the router asks the store for the rename, and the fake store answers only on the next tick. When the send lands in between, nothing wakes the queue again.' },
  { ask: 'Fix it properly, not by raising the timeout.', gap: 1, seconds: 128, work: [
    edit('src/main/agents/sendRouter.ts', '@@ -151,6 +151,9 @@ export class SendRouter {\n     this.queued.push(send)\n+    // A rename that settles while this send waits wakes the queue, so a send never waits on a tick it missed.\n+    this.store.onSettled(thread.id, () => this.drain(thread.id))'),
    run('npx vitest run tests/unit/main/sendRouting.test.ts -t "behind a rename" --repeat=50', passed(1, 50), 88_000)],
    reply: 'The router now wakes its queue when the rename settles, instead of looking once. Fifty runs of that case pass, and the timeout is unchanged.' },
  { ask: 'push', gap: 1, seconds: 8, work: [run('git push', 'To github.com:millZach/Sotto.git\n   2d4c9e1..6a8f310  refactor/split-requests-and-sends -> refactor/split-requests-and-sends', 3_100)],
    reply: 'Pushed to #2104. CI started again.' },
  { ask: 'Does the second branch need the same fix?', gap: 2, seconds: 5, work: [think('Whether the second branch routes sends')],
    reply: 'No. The second branch does not touch the router; it is only in #2104.' },
  { ask: 'Make the third branch while we wait.', gap: 1, seconds: 63, work: [
    run('git switch -c refactor/split-the-rest origin/main', 'Switched to a new branch \'refactor/split-the-rest\'', 300),
    run('git cherry-pick 5b2e9c0 d8a4f17 12c6e3b 6f0a2d9 b3e7c41 90d1f6a e44c0b7', '[refactor/split-the-rest c0f2b19] Say each class\'s own name in its doc comment\n …\n 9 files changed, 1907 insertions(+), 1844 deletions(-)', 2_600),
    run('npx vitest run tests/unit/main/worktreeRestore.test.ts tests/unit/main/threadHistory.test.ts tests/unit/main/threadTitles.test.ts tests/unit/main/workspaceRecovery.test.ts tests/unit/main/usageLedger.test.ts tests/unit/main/pullRequestLinks.test.ts', passed(6, 142), 19_600), typecheck()],
    reply: '`refactor/split-the-rest` has the other six cuts, the doc comments and the plan. All six test files and the typecheck pass. It still carries Drake\'s two lines in `titleRequests.ts`, which `main` already has.' },
  { ask: 'Is #2104 green yet?', gap: 12, seconds: 4, work: [run('gh pr checks 2104', 'Gates (Windows)    pass     13m02s\nPackage result     pass\nDesktop result     pass', 1_400)],
    reply: 'Yes. Gates (Windows), Package and Desktop all passed.' },
  { ask: 'Merge it, then push the second one and open its pull request.', gap: 1, seconds: 47, work: [
    run('gh pr merge 2104 --merge', '✓ Merged pull request #2104 (Move requests and sends out of AgentControl)', 3_900),
    run('git switch refactor/split-turns-and-state && git rebase origin/main', 'Successfully rebased and updated refs/heads/refactor/split-turns-and-state.', 2_200),
    run('git push -u origin refactor/split-turns-and-state', 'To github.com:millZach/Sotto.git\n * [new branch]      refactor/split-turns-and-state -> refactor/split-turns-and-state', 3_300),
    run('gh pr create --title "Move turns and state out of AgentControl" --body-file .git/PR_BODY.md', 'https://github.com/millZach/Sotto/pull/2107', 4_600)],
    reply: 'Merged #2104 with a merge commit. Rebased the second branch on the new `main`, pushed it and opened #2107, "Move turns and state out of AgentControl", with the budget runs in its description.' },
  { ask: 'What does control.ts look like now on main?', gap: 3, seconds: 6, work: [run('git show origin/main:src/main/agents/control.ts | wc -l', '6110', 300)],
    reply: '6,110 lines on `main`, from 7,160. Once #2107 and the third pull request merge it will be about 2,850, and most of what is left is wiring the classes together.' },
  { ask: 'Ok. Wait for #2107, then the third. Tell me if anything goes red.', gap: 2, seconds: 3, work: [think('Waiting on CI')],
    reply: 'I will. #2107 started its checks a minute ago.' },
  { ask: 'Anything?', gap: 14, seconds: 5, work: [run('gh pr checks 2107', 'Gates (Windows)    pass     12m48s\nPackage result     pass\nDesktop result     pending', 1_400)],
    reply: 'Gates (Windows) and Package passed on #2107. Desktop is still running.' },
  { ask: 'Greptile left a comment on 2107. Is it right?', gap: 4, seconds: 39, work: [run('gh api repos/millZach/Sotto/pulls/2107/comments --jq ".[].body"', 'statePublisher.ts:118 — `publish()` iterates `this.threads` while `settleThread` may delete from it in the same tick. Consider iterating a copy.', 1_800),
    think('Whether settleThread can run inside publish'), run('rg -n "settleThread|publish\\(" src/main/agents/statePublisher.ts src/main/agents/settledState.ts', 'src/main/agents/statePublisher.ts:118:  publish(): void {\nsrc/main/agents/settledState.ts:40:  settleThread(threadId: string): void {', 200)],
    reply: 'No. `settleThread` never runs inside `publish`: settling is queued by the tracker and drained after the publish returns. Iterating a copy would add a copy on the update path that `copySites.test.ts` would refuse. I would answer it rather than change the code.' },
  { ask: 'Answer it.', gap: 1, seconds: 9, work: [run('gh api repos/millZach/Sotto/pulls/2107/comments/4410982/replies -f body="..."', '{"id":4411317}', 1_900)],
    reply: 'Answered on the comment: settling is drained after `publish` returns, so the loop never sees a delete, and a copy there would be one per update.' },
  { ask: 'Merge 2107 when it is green and open the third. Last one.', gap: 8, seconds: 54, work: [
    run('gh pr checks 2107', 'Gates (Windows)    pass     12m48s\nPackage result     pass\nDesktop result     pass', 1_400),
    run('gh pr merge 2107 --merge', '✓ Merged pull request #2107 (Move turns and state out of AgentControl)', 3_800),
    run('git switch refactor/split-the-rest && git rebase origin/main', 'dropping 90d1f6a Keep a title asked for during a settings replay waiting -- patch contents already upstream\nSuccessfully rebased and updated refs/heads/refactor/split-the-rest.', 2_400),
    run('git push -u origin refactor/split-the-rest', 'To github.com:millZach/Sotto.git\n * [new branch]      refactor/split-the-rest -> refactor/split-the-rest', 3_200),
    run('gh pr create --title "Move the rest of AgentControl\'s parts into their own classes" --body-file .git/PR_BODY.md', 'https://github.com/millZach/Sotto/pull/2109', 4_700)],
    reply: 'Merged #2107. The third branch rebased cleanly; Git dropped Drake\'s two lines since `main` has them. Opened #2109, "Move the rest of AgentControl\'s parts into their own classes".' },
  { ask: 'Thanks. Anything you would still change, now it is all in?', gap: 3, seconds: 22, work: [think('What the split left behind')],
    reply: 'Two things, neither for these pull requests. `control.ts` still builds all twelve classes in its constructor, so a test that wants one still builds the coordinator; a small factory would let tests build only what they use. And #2101, the reconnect backoff, is still open.' },
]

function longThread(): EvidenceThread {
  const messages: Message[] = [], activities: Activity[] = []
  // The thread's last reply came 173 minutes before the captures' now; its first message as long before that as the session took.
  const took = LONG_ROUNDS.reduce((sum, round) => sum + round.gap + round.seconds / 60, 1)
  let minutes = 173 + took
  messages.push(user('long-u0', minutes, 'Start on the AgentControl split. Follow docs/plans/agent-control-split.md, one cut at a time, and tell me after each one before moving on.'))
  minutes -= 1
  messages.push(assistant('long-a0', minutes, 'Starting with the permission ledger, since it has the fewest readers. I will move code without changing it, run its tests and stop for you after each cut.'))
  LONG_ROUNDS.forEach((round, index) => {
    const uid = `long-u${index + 1}`, aid = `long-a${index + 1}`
    minutes -= round.gap
    messages.push(user(uid, minutes, round.ask))
    const turn = new Turn(`long-turn-${index}`, uid, 'completed', round.seconds * 1_000, minutes)
    let at = 0
    const next = (): string => `long-${index}-${++at}`
    for (const step of round.work) {
      if ('think' in step) turn.reasoning(next(), `**${step.think}**`)
      else if ('run' in step) { const [command, output, ms, failed] = step.run; turn.command(next(), command, output, ms, failed ? 'failed' : 'completed') }
      else if ('edit' in step) turn.edit(next(), step.edit[0], step.edit[1], step.edit[2])
      else {
        const { cut } = step, line = 1200 + LONG_CUTS.indexOf(cut) * 37
        turn.command(next(), `rg -n "${cut.method}" src/main/agents/control.ts`, `${line}:  private ${cut.method}(threadId: string): AgentHostResult {`, 60)
        turn.command(next(), `sed -n ${line},${line + 60}p src/main/agents/control.ts`, `  private ${cut.method}(threadId: string): AgentHostResult {\n    const thread = this.requireThread(threadId)\n…`, 45)
        turn.edit(next(), `src/main/agents/${cut.name}.ts`, 'add', `+export class ${className(cut)} {\n+  constructor(private readonly store: ThreadStore) {}\n+\n+  ${cut.method}(threadId: string): AgentHostResult {\n+    const thread = this.store.requireThread(threadId)\n+    // moved unchanged from control.ts\n+  }\n+}`)
        turn.edit(next(), 'src/main/agents/control.ts', 'update', `@@ -${line},12 +${line},3 @@ export class AgentControl {\n-  private ${cut.method}(threadId: string): AgentHostResult {\n-    const thread = this.requireThread(threadId)\n-    // ${cut.lines} lines moved\n-  }\n+  private ${cut.method}(threadId: string): AgentHostResult {\n+    return this.${cut.name}.${cut.method}(threadId)\n+  }`)
      }
    }
    activities.push(...turn.records)
    minutes -= round.seconds / 60
    messages.push(assistant(aid, minutes, round.reply))
  })
  return { key: 'long', id: threadId(7), title: 'Split AgentControl', modelId: 'codex:gpt', project: 'sotto', status: 'idle', messages, activities }
}

// ---- The rest of a busy sidebar: older, finished work ----

const background = (index: number, title: string, modelId: string, project: EvidenceThread['project'], hours: number, ask: string, answer: string): EvidenceThread => ({
  key: `background-${index}`, id: threadId(100 + index), title, modelId, project, status: 'idle',
  // Each at a minute of its own, so no two rows tie for their place in the sidebar.
  messages: [user(`bg-${index}-u`, hours * 60 + index * 3 + 12, ask), assistant(`bg-${index}-a`, hours * 60 + index * 3, answer)],
})

const BACKGROUND: readonly EvidenceThread[] = [
  background(1, 'Fix the socket host flake', 'codex:gpt', 'sotto', 1, 'The socket host test failed twice on Windows this morning. Find out why.', 'The test closed its pipe before the host had read the last frame. It now waits for the acknowledgement. Ran it 40 times with no failures.'),
  background(2, 'Bump Electron to 43.8', 'claude:sonnet', 'sotto', 2, 'Bump Electron to 43.8 and check the notices.', 'Bumped and regenerated `THIRD_PARTY_NOTICES.md`. The node-pty binary still loads.'),
  background(3, 'Sidebar rows at 820 wide', 'grok:4', 'sotto', 3, 'The sidebar row actions clip at the minimum window. Fix it.', 'Row actions now take their place only on hover, and nothing clips at 820x560.'),
  background(4, 'Translate Settings into Spanish', 'codex:gpt', 'sotto', 4, 'Run the extract and fill in the Spanish catalog for Settings.', 'Filled in 312 strings. Eleven keep the English product names on purpose.'),
  background(5, 'Help page search', 'claude:sonnet', 'sotto-site', 1, 'Add search to the help page.', 'Added a small client-side index. It adds 9 KB and needs no server.'),
  background(6, 'Docs redirect map', 'codex:gpt', 'sotto-site', 3, 'Redirect the old docs paths.', 'Added 41 redirects, and the link checker passes.'),
  background(7, 'Changelog for 0.1.42', 'grok:4', 'notes', 2, 'Draft the changelog for 0.1.42 from the merged pull requests.', 'Draft is in `notes/releases/0.1.42.md`, grouped by what a user sees.'),
  background(8, 'Review the Android port', 'claude:sonnet', 'workshop', 4, 'Read the Android client and tell me what is missing against the iPhone one.', 'Three gaps: attachments, the Watcher box and reconnect after sleep. The protocol core matches.'),
  background(9, 'Reduce renderer broadcasts', 'codex:gpt', 'workshop', 5, 'Find what makes every pane render on each stream update.', 'One context value changed identity on every update. Narrowed the subscription; a stream update now renders one pane.'),
  background(10, 'Runtime manifest for Linux', 'grok:4', 'workshop', 5, 'Check the runtime manifest covers Omarchy.', 'It does. The hash pin moved with the new theme file.'),
]

/** Every thread the captures add, the ones they look at first. */
export const EVIDENCE_THREADS: readonly EvidenceThread[] = [REVIEW, PLAN, DOC, STORE, PERMISSION, STREAM, longThread(), ...BACKGROUND]
export const evidenceThread = (key: string): EvidenceThread => EVIDENCE_THREADS.find(thread => thread.key === key)!

