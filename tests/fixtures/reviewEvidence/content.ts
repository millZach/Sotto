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

/** Builds one turn's records in order, so sequence numbers and anchors stay right as a thread is written. */
class Turn {
  private sequence = 0
  readonly records: Activity[] = []
  constructor(readonly turnId: string, readonly anchor: string, status: Activity['status'], durationMs: number | undefined, startedMinutesAgo: number) {
    this.records.push({ id: `turn:${turnId}`, turnId, sequence: this.sequence++, afterMessageId: anchor, kind: 'turn', status, title: 'Turn',
      startedAt: minutesAgo(startedMinutesAgo), timingSource: 'provider', ...(durationMs === undefined ? {} : { durationMs, completedAt: new Date(Date.parse(minutesAgo(startedMinutesAgo)) + durationMs).toISOString() }) })
  }
  private add(patch: Partial<Activity> & Pick<Activity, 'id' | 'kind' | 'title'>, after = this.anchor): this {
    this.records.push({ turnId: this.turnId, sequence: this.sequence++, afterMessageId: after, status: 'completed', timingSource: 'provider', ...patch })
    return this
  }
  command(id: string, command: string, output: string, durationMs = 180, status: Activity['status'] = 'completed', after?: string): this {
    return this.add({ id, kind: 'command', title: 'Command', command, cwd: 'D:\\Projects\\sotto', output, status,
      ...(status === 'running' ? {} : { durationMs, exitCode: status === 'failed' ? 1 : 0 }) }, after)
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
  { text: 'Order the cuts so each pull request is safe to merge alone', status: 'running' },
  { text: 'Write docs/plans/agent-control-split.md with the order and the seams', status: 'pending' },
  { text: 'Name the tests that hold each cut, and what moves with it', status: 'pending' },
  { text: 'Check the plan against ADR-0002 and ADR-0004 before asking for review', status: 'pending' },
]

const planTurn = new Turn('plan-1', 'plan-u1', 'running', undefined, 6)
  .reasoning('plan-r1', '**Planning the split**\n\nThe order matters more than the seams. Each cut has to leave the update path alone until the very end, so nothing here can make streaming slower by accident.')
  .plan('plan-p1', 'Plan the split', PLAN_STEPS)
  .command('plan-c1', 'rg -c "this\\.(pendingSends|outbox|turns|requests)" src/main/agents/control.ts', '412', 70)
  .command('plan-c2', 'rg -n "^  (async )?[a-zA-Z]+\\(" src/main/agents/control.ts | wc -l', '184', 60)
  .command('plan-c3', 'rg -l "agentControl\\." src/main src/host | xargs wc -l | tail -n 1', '  9841 total', 210)
  .command('plan-c4', 'cat src/main/agents/publishWindows.ts', 'export interface PublishWindow {\n  readonly threadId: string\n  readonly opensAt: number\n  …', 40)
  .command('plan-c5', 'cat tests/unit/main/workspaceControl.test.ts | head -n 80', "import { describe, expect, test } from 'vitest'\n…", 0, 'running')

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
  .command('stream-c1', 'rg -n "kind: \'permission\'" src/main/agents/claude.ts', "1204:        kind: 'permission', text, options: [],", 60)
  .command('stream-c2', 'sed -n 1190,1240p src/main/agents/claude.ts', "      const request: AgentRequest = {\n        id: requestId,\n        kind: 'permission', text, options: [],\n…", 45)

/** The turn's steps at each moment: it reads, then keeps reading while it writes. */
export function streamActivities(moment: keyof typeof STREAM_MOMENTS): readonly Activity[] {
  const turn = streamBase()
  if (moment === 'first') return turn.command('stream-c3', 'cat src/main/agents/requestPolicy.ts', 'export class RequestPolicy {\n…', 0, 'running').records
  turn.command('stream-c3', 'cat src/main/agents/requestPolicy.ts', 'export class RequestPolicy {\n  answer(thread: AgentThread, request: AgentRequest, answer: RequestAnswer): AgentHostResult {\n…', 55)
    .command('stream-c4', 'rg -n "onHostSnapshot" src/main/agents/control.ts', '2210:  private onHostSnapshot(snapshot: AgentHostSnapshot): void {', 50)
  if (moment === 'second') return turn.command('stream-c5', 'sed -n 2210,2290p src/main/agents/control.ts', '  private onHostSnapshot(snapshot: AgentHostSnapshot): void {\n…', 0, 'running', STREAM_MESSAGE_ID).records
  return turn.command('stream-c5', 'sed -n 2210,2290p src/main/agents/control.ts', '  private onHostSnapshot(snapshot: AgentHostSnapshot): void {\n    for (const thread of snapshot.threads) {\n…', 48, 'completed', STREAM_MESSAGE_ID)
    .command('stream-c6', 'rg -n "waitingSince" src/main/agents src/renderer/src/agents | wc -l', '', 0, 'running', STREAM_MESSAGE_ID).records
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
  { name: 'turnTracker', method: 'recordTurn', lines: 655, test: 'turnTracker', note: 'Two tests had been reading a private field. They now ask the tracker instead.' },
  { name: 'worktreeLeases', method: 'leaseWorktree', lines: 371, test: 'worktreeRestore', note: 'A missing worktree is still refused without removing work.' },
  { name: 'historyWindows', method: 'readEarlier', lines: 243, test: 'threadHistory', note: 'The window size stayed in the shared constant, so the iPhone path is unchanged.' },
  { name: 'titleRequests', method: 'requestTitle', lines: 198, test: 'threadTitles', note: 'Generated names still only replace the temporary branch.' },
  { name: 'providerRecovery', method: 'reconnectHost', lines: 516, test: 'workspaceRecovery', note: 'The backoff read the wrong constant before the move as well. I left it and filed a follow-up.' },
  { name: 'settledState', method: 'settleThread', lines: 227, test: 'threadSettle', note: 'Settling is still a coordinator fact and not a provider one.' },
  { name: 'usageRollup', method: 'recordUsage', lines: 176, test: 'usageLedger', note: 'Numbers still stay on their own host (ADR-0078).' },
  { name: 'pullRequestLinks', method: 'linkPullRequest', lines: 302, test: 'pullRequestLinks', note: 'A thread can still hold several links, and the newest still leads.' },
  { name: 'statePublisher', method: 'publish', lines: 841, test: 'streamingCopyBudget', note: 'No budget moved. One update still copies nothing.' },
]

function longThread(): EvidenceThread {
  const messages: Message[] = [], activities: Activity[] = []
  let minutes = 330
  const step = (by: number): number => { minutes -= by; return minutes }
  messages.push(user('long-u0', step(0), 'Start on the AgentControl split. Follow docs/plans/agent-control-split.md, one cut at a time, and tell me after each one before moving on.'))
  messages.push(assistant('long-a0', step(1), 'Starting with the permission ledger, since it has the fewest readers. I will move code without changing it, run its tests and stop for you after each cut.'))
  for (let round = 0; round < 52; round += 1) {
    const cut = LONG_CUTS[round % LONG_CUTS.length]!
    const pass = Math.floor(round / LONG_CUTS.length)
    const uid = `long-u${round + 1}`, aid = `long-a${round + 1}`
    const asks = pass === 0
      ? `Good. Move \`${cut.name}\` next.`
      : pass === 1
        ? `Check \`${cut.name}\` again now the later cuts are in. Did anything start reaching back into AgentControl?`
        : pass === 2
          ? `Does \`${cut.name}\` still need its own test file, or can the coordinator's tests cover it?`
          : `Last look at \`${cut.name}\`. Anything to tidy before the pull request?`
    messages.push(user(uid, step(2), asks))
    const turn = new Turn(`long-turn-${round}`, uid, 'completed', 40_000 + (round * 7_919) % 180_000, minutes)
    turn.command(`long-${round}-c1`, `rg -n "${cut.method}" src/main/agents/control.ts`, `${1200 + round * 37}:  private ${cut.method}(threadId: string): AgentHostResult {`, 60)
    turn.command(`long-${round}-c2`, `sed -n ${1200 + round * 37},${1260 + round * 37}p src/main/agents/control.ts`, `  private ${cut.method}(threadId: string): AgentHostResult {\n    const thread = this.requireThread(threadId)\n…`, 45)
    if (pass === 0) {
      turn.edit(`long-${round}-e1`, `src/main/agents/${cut.name}.ts`, 'add', `+export class ${cut.name[0]!.toUpperCase()}${cut.name.slice(1)} {\n+  constructor(private readonly store: ThreadStore) {}\n+\n+  ${cut.method}(threadId: string): AgentHostResult {\n+    const thread = this.store.requireThread(threadId)\n+    // moved unchanged from control.ts\n+  }\n+}`)
      turn.edit(`long-${round}-e2`, 'src/main/agents/control.ts', 'update', `@@ -${1200 + round * 37},12 +${1200 + round * 37},3 @@ export class AgentControl {\n-  private ${cut.method}(threadId: string): AgentHostResult {\n-    const thread = this.requireThread(threadId)\n-    // ${cut.lines} lines moved\n-  }\n+  private ${cut.method}(threadId: string): AgentHostResult {\n+    return this.${cut.name}.${cut.method}(threadId)\n+  }`)
    }
    turn.command(`long-${round}-c3`, `npx vitest run tests/unit/main/${cut.test}.test.ts`, ` Test Files  1 passed (1)\n      Tests  ${12 + round % 23} passed (${12 + round % 23})`, 6_000 + round * 110)
    if (round % 5 === 3) turn.command(`long-${round}-c4`, 'npm run typecheck', round % 10 === 3 ? `src/main/agents/${cut.name}.ts(41,7): error TS2339: Property 'requireThread' does not exist on type 'ThreadStore'.` : '', 36_000, round % 10 === 3 ? 'failed' : 'completed')
    activities.push(...turn.records)
    const reply = pass === 0
      ? `Moved \`${cut.method}\` and its helpers to \`src/main/agents/${cut.name}.ts\`, ${cut.lines} lines. \`control.ts\` keeps a one-line call, so nothing outside the class changed. \`${cut.test}.test.ts\` passes. ${cut.note}`
      : pass === 1
        ? `\`${cut.name}\` is still clean. It reads only what its constructor is given, and \`rg\` finds no call back into \`AgentControl\`. ${cut.note}`
        : pass === 2
          ? `Keep it. \`${cut.test}.test.ts\` builds only this class, which takes it from about ${200 + (round * 13) % 400} ms a case to under ${10 + round % 15} ms. The coordinator's tests would have to build everything again to reach the same cases.`
          : `One small thing: the doc comment on \`${cut.method}\` still says "AgentControl". I fixed that and nothing else. It is ready.`
    messages.push(assistant(aid, step(1), reply))
  }
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

