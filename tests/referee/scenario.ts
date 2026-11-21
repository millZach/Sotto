// The script the referee plays against a host, for each provider that has a fake: three clients at once, each with the
// hello a real client of its kind sends, taking turns to act, while a fake provider plays its part.
import { PROVIDER_LABELS, publicProviderEntityId } from '../../src/shared/agents'
import type { Held } from './fold'
import { createHash } from 'node:crypto'
import { LOSES_ACKNOWLEDGEMENT, type DriverAction, type RefereeProvider } from './providers'

/** The clients a recording holds, in the order their material is compared. */
export const CLIENTS = ['desktop', 'iphone', 'plain'] as const
export type ClientName = typeof CLIENTS[number]

export interface ClientProfile {
  /** The `Sec-WebSocket-Extensions` offer it sends, if any. */
  readonly offer: string | undefined
  /** Whether it accepts `activity-summaries`, so its activity records are summaries. */
  readonly summaries: boolean
  /** What its hello carries beside `op`. */
  readonly hello: Record<string, unknown>
}

/** `Number.MAX_SAFE_INTEGER`: the cursor both real clients send to ask for no retained events. */
const NO_EVENTS_AFTER = 9_007_199_254_740_991

/**
 * Each client as the real one says hello (`socketHostService.ts` for the desktop, `IncomingFrame.swift`'s `snapshotHello`
 * for the iPhone). The desktop's list is the features it accepts wherever a host lists them, without those it accepts only
 * when its own switches are on. `plain` is a client from before every optional feature: whole shells and whole details.
 */
export const PROFILES: Record<ClientName, ClientProfile> = {
  desktop: { offer: 'permessage-deflate; client_no_context_takeover; server_no_context_takeover', summaries: false, hello: { afterSeq: NO_EVENTS_AFTER, accepts: ['client-liveness', 'detail-delta', 'detail-read-held', 'message-aliases', 'client-updates', 'client-update-not-listed', 'answer-receipts', 'usage-history', 'usage-muse-opencode', 'model-catalog-revision', 'host-update', 'activity-bodies', 'changed-thread-records', 'kept-parts', 'plugin-meshy-spending', 'plugin-elevenlabs-spending', 'provider-opencode', 'provider-cursor', 'provider-deepseek', 'provider-hermes'] } },
  iphone: { offer: 'permessage-deflate', summaries: true, hello: { afterSeq: NO_EVENTS_AFTER, accepts: ['detail-delta', 'client-liveness', 'activity-summaries', 'model-catalog-revision', 'provider-opencode', 'provider-cursor', 'provider-deepseek', 'changed-thread-records', 'reply-thread-records', 'provider-mode-lists', 'settled-threads-on-request', 'usable-models', 'command-changed-thread-records', 'step-window', 'thread-media-edge', 'kept-parts', 'plugin-meshy-phone'] } },
  plain: { offer: undefined, summaries: false, hello: { accepts: ['provider-opencode', 'provider-cursor'] } },
}

/** The thread every script works in: chosen by the client, as `create-thread` lets it, so it is the same in every run. */
export const THREAD = '00000000-0000-4000-8000-00000000000a'

/** The fake's own model in each provider, as the fixtures name it. */
const FAKE_MODELS: Record<RefereeProvider, string> = {
  codex: 'fixture-model', claude: 'fixture-model', grok: 'fixture-model', devin: 'fixture-model', muse: 'fixture-model',
  opencode: 'opencode/fixture-model', cursor: 'gpt-fixture',
}

export interface StepContext {
  readonly provider: RefereeProvider
  readonly data: string
  /** What the client that acts holds now. */
  readonly held: Held
  /** The handles the host answered the acting client's staging with, in order. */
  readonly staged: readonly Record<string, unknown>[]
}

export interface Step {
  /** What the step does, in words, for the recording and for a failure. */
  readonly say: string
  /** `host`: the host process is stopped and started again over the same data folder, and every client opens a new session. */
  readonly by: ClientName | 'fake' | 'host'
  /** For a client's step: the request beside `v`, `id` and `session`. */
  readonly request?: (context: StepContext) => Record<string, unknown>
  /** For the fake's step: the action it takes. */
  readonly drive?: (context: StepContext) => DriverAction
  /**
   * While recording, the step is over once every client that has said hello holds what passes this (and an acting client
   * has its answer). It
   * names the last thing the step changes, so nothing it causes is still on its way when the next step starts. A replay
   * waits instead for every client to hold what the recording holds.
   */
  readonly until?: (held: Held, context: Omit<StepContext, 'held' | 'staged'> & { readonly client: ClientName }) => boolean
}

type Thread = {
  status?: string; requests?: { id: string; kind: string; context?: { summaryAsk?: string; toolCallId?: string } }[]; worktree?: { git?: unknown }
  lastTurn?: { id: string }; lastUserMessageId?: string
}
type ProviderRow = { id: string; connection?: string }
type Activity = { kind?: string; status?: string; turnId?: string; afterMessageId?: string; command?: string }
const rowsOf = (held: Held): ProviderRow[] => (held.shell?.host as { providers?: ProviderRow[] } | undefined)?.providers ?? []
const threadOf = (held: Held): Thread | undefined => ((held.shell?.host as { threads?: (Thread & { id: string })[] } | undefined)?.threads ?? []).find(thread => thread.id === THREAD)
const activitiesOf = (held: Held): Activity[] => (held.details[THREAD]?.activities ?? []) as Activity[]
const textOf = (held: Held): string => JSON.stringify(held.details[THREAD]?.messages ?? [])
/**
 * A host connects every provider it has at start (ADR-0036): the fake's, and the rest, which the referee host holds, so
 * their connect fails at once. It then reads the fake's client for the client update line (ADR-0042), except Claude
 * Code's, which it does not list there. Start-up is over when none is still connecting, the fake's is connected and,
 * where it is listed, its client has been read.
 */
export const started = (provider: RefereeProvider) => (held: Held): boolean => {
  const rows = rowsOf(held)
  const read = provider === 'claude' || ((held.shell?.clientUpdates ?? []) as { id: string; checkedAt?: unknown }[]).some(item => item.id === provider && item.checkedAt !== undefined)
  return read && rows.some(row => row.id === provider && row.connection === 'connected') && rows.every(row => row.connection !== 'connecting')
}
/** A command's lane closes a publish after its answer: the shell stops naming it busy. Every command step waits for that. */
export const lanesIdle = (held: Held): boolean => held.shell?.globalLaneBusy !== true && ((held.shell?.busyThreadIds ?? []) as unknown[]).length === 0
/** Each send is acknowledged by its provider, which the delivery records with the time it took, or refused before it. */
export const deliveriesSettled = (held: Held): boolean => ((held.shell?.deliveries ?? []) as { status?: string; providerLatencyMs?: unknown }[])
  .every(delivery => delivery.status === 'failed' || delivery.providerLatencyMs !== undefined)
/**
 * The providers whose turn record names the prompt it follows (`afterMessageId`) from the start of the turn. Codex names it
 * a publish after the record first shows, Grok Build once the turn ends, and Devin never.
 */
const NAMES_PROMPT: ReadonlySet<RefereeProvider> = new Set(['codex', 'claude', 'muse', 'opencode', 'cursor'])
/**
 * A send is over once the thread runs the turn it started: the prompt in the detail, the turn named on the thread with its
 * prompt, the turn's own record open in the detail (keyed by the turn, or by its prompt as Claude Code's is), the delivery
 * acknowledged and the lane closed.
 */
const sent = (provider: RefereeProvider, text: string) => (held: Held, { client }: { client: ClientName }): boolean => {
  const thread = threadOf(held)
  const turn = thread?.lastTurn as { id: string; messageId?: string } | undefined
  if (thread?.status !== 'running' || !textOf(held).includes(text) || thread.lastUserMessageId === undefined || !turn) return false
  const record = activitiesOf(held).find(item => item.kind === 'turn' && item.status === 'running' && (item.turnId === turn.id || item.turnId === turn.messageId))
  // An activity summary, which the iPhone accepts, leaves `afterMessageId` out.
  const named = !NAMES_PROMPT.has(provider) || PROFILES[client].summaries || record?.afterMessageId === thread.lastUserMessageId
  return record !== undefined && named && deliveriesSettled(held) && lanesIdle(held)
}
/** A turn is over once the thread is idle with the reply, and no record of it is still running: a turn's closes a moment later. */
/**
 * A turn the host first could not confirm is over once its thread's record shows the reply too: the record catches up a
 * publish after the detail there.
 */
const recordEnded = (text: string) => (held: Held): boolean => ended(text)(held)
  && ((threadOf(held) as { summary?: { lastAssistant?: { text?: string } } } | undefined)?.summary?.lastAssistant?.text ?? '').includes(text) && lanesIdle(held)
const ended = (text: string) => (held: Held): boolean => threadOf(held)?.status === 'idle' && textOf(held).includes(text)
  && activitiesOf(held).every(record => record.status !== 'running')
/**
 * A request shows once its card is there, any summary the host asked for on the side is in (#2077), and every command
 * record names its command. OpenCode's tool record can land a moment after its permission card, and names its command
 * later still, so for OpenCode the record of the tool the card names is there too.
 */
const asking = (provider: RefereeProvider, count: number) => (held: Held): boolean => {
  const requests = threadOf(held)?.requests ?? []
  const records = activitiesOf(held) as (Activity & { id?: string })[]
  return requests.length === count && requests.every(request => request.context?.summaryAsk !== 'waiting')
    && records.every(record => record.kind !== 'command' || record.command !== undefined)
    && (provider !== 'opencode' || requests.every(request => !request.context?.toolCallId || records.some(record => record.id === `opencode-tool-${request.context!.toolCallId}`)))
}
const command = (value: Record<string, unknown>) => () => ({ op: 'command', command: value })
const requestOf = (held: Held): string => {
  const request = threadOf(held)?.requests?.[0]
  if (!request) throw new Error('The thread shows no request to answer.')
  return request.id
}
/** Every client step that sends a command also waits for its lane to close. */
const commandStep = (step: Step): Step => ({ ...step, until: (held, context) => lanesIdle(held) && (step.until?.(held, context) ?? true) })

/**
 * The scripts a provider is recorded with, each its own recording: `main`, every provider's whole conversation; `restart`,
 * the host stopped and started again during a turn; `lost-acknowledgement`, a prompt whose acknowledgement comes after the
 * adapter stopped waiting; `attachments`, a send carrying a staged text file; `pictures`, one carrying a staged picture.
 */
export const SCENARIOS = ['main', 'restart', 'lost-acknowledgement', 'attachments', 'pictures'] as const
export type ScenarioName = typeof SCENARIOS[number]

/**
 * The scripts the TypeScript host does not play the same way from run to run, so none is recorded or replayed until its
 * issue is fixed: each names the issue and what differs. A replay says it skipped each one, and why.
 */
export const HELD_OUT: Readonly<Partial<Record<ScenarioName, { readonly providers: ReadonlySet<RefereeProvider>; readonly reason: string }>>> = {
  restart: { providers: new Set(['codex', 'claude', 'grok', 'devin', 'muse', 'opencode', 'cursor']),
    reason: 'After the host starts again, whether the turn the restart stopped is sent the resume note, and whether it goes before or after the clients observe the thread again, differ from run to run (#2710).' },
}

/** Why a provider's script is held out, or undefined when it is recorded and replayed. */
export const heldOut = (provider: RefereeProvider, scenario: ScenarioName): string | undefined =>
  HELD_OUT[scenario]?.providers.has(provider) ? HELD_OUT[scenario]!.reason : undefined

/** Where a script is recorded: `main` as the provider alone, any other after it. */
export const recordingName = (provider: RefereeProvider, scenario: ScenarioName): string => scenario === 'main' ? provider : `${provider}-${scenario}`

/** The providers whose fake's model reads images; Grok Build's and Devin's read none. */
const READS_IMAGES: ReadonlySet<RefereeProvider> = new Set(['codex', 'claude', 'muse', 'opencode', 'cursor'])

/** A tiny PNG and a short text file, each the referee's own. */
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const NOTES = Buffer.from('Referee notes\nsecond line\n')

/**
 * One provider's script for a scenario, or undefined where the scenario does not apply to it: only a fake that loses an
 * acknowledgement through its files has one lost. Every text in it is the referee's own; nothing comes from a real account.
 */
export function script(provider: RefereeProvider, scenario: ScenarioName = 'main'): Step[] | undefined {
  const send = (by: ClientName, text: string): Step => commandStep({ say: `${by} sends "${text}"`, by, request: command({ type: 'manual-send', threadId: THREAD, text }), until: sent(provider, text) })
  const complete = (text: string): Step => ({ say: `the fake ends the turn with "${text}"`, by: 'fake', drive: () => ({ type: 'complete', thread: THREAD, text }), until: ended(text) })
  const projectOf = (held: Held, data: string): { id: string; path: string } | undefined => ((held.shell?.host as { projects?: { id: string; path: string }[] } | undefined)?.projects ?? []).find(item => item.path === data)
  const hellos = CLIENTS.map((by): Step => ({ say: `${by} says hello`, by, request: () => ({ op: 'hello', ...PROFILES[by].hello }), until: started(provider) }))
  // The first observe has the host read the thread's folder with Git, which its record shows once that is done.
  const observes = CLIENTS.map((by): Step => ({ say: `${by} observes the thread`, by, request: () => ({ op: 'observe', threadIds: [THREAD] }), until: held => threadOf(held)?.worktree?.git !== undefined }))
  const opening: Step[] = [
    ...hellos,
    commandStep({ say: `desktop turns ${provider} on`, by: 'desktop', request: command({ type: 'configure', patch: { enabledProviders: [provider], provider } }),
      until: held => {
        const configuration = held.shell?.configuration as { provider?: string; enabledProviders?: string[] } | undefined
        return configuration?.provider === provider && configuration.enabledProviders?.join() === provider && started(provider)(held)
      } }),
    // Connecting a provider that is connected already says so, a moment after the command is answered.
    commandStep({ say: `desktop connects ${provider}`, by: 'desktop', request: command({ type: 'connect', provider }),
      until: held => started(provider)(held) && held.shell?.notice === `${PROVIDER_LABELS[provider]} connected` }),
    commandStep({ say: 'desktop adds the data folder as a project', by: 'desktop', request: ({ data }) => ({ op: 'command', command: { type: 'create-project', provider, title: 'Referee project', path: data, useExisting: true } }),
      until: (held, { data }) => projectOf(held, data) !== undefined }),
    commandStep({ say: 'desktop makes the thread', by: 'desktop', request: ({ held, data }) => {
      const project = projectOf(held, data)
      if (!project) throw new Error('The desktop holds no project for the data folder.')
      return { op: 'command', command: { type: 'create-thread', threadId: THREAD, projectId: project.id, title: 'Referee thread', titleSource: 'user', modelId: publicProviderEntityId(provider, 'model', FAKE_MODELS[provider]), workingCopy: 'shared', managed: false } }
    }, until: held => threadOf(held)?.status === 'idle' }),
    ...observes,
  ]
  const reads: Step[] = [
    { say: 'desktop reads the thread', by: 'desktop', request: () => ({ op: 'detail', threadId: THREAD }) },
    { say: 'plain reads the shell', by: 'plain', request: () => ({ op: 'shell' }) },
  ]
  if (scenario === 'restart') return [
    ...opening,
    send('desktop', 'Referee prompt one'),
    // Every client is gone while the host is down, and comes back on a new session, saying hello and observing again.
    { say: 'the host stops and starts again', by: 'host' },
    ...hellos,
    ...CLIENTS.map((by): Step => ({ say: `${by} observes the thread again`, by, request: () => ({ op: 'observe', threadIds: [THREAD] }),
      until: (held, { client }) => (client !== by || held.details[THREAD] !== undefined) && lanesIdle(held) && deliveriesSettled(held) })),
    ...provider === 'cursor' ? [
      // Cursor's host sends the turn the restart stopped Sotto's resume note (ADR-0076) while the fake still answers the
      // prompt from before it, so the reply ends that prompt and the note runs as a turn of its own, which the fake ends next.
      { say: 'the fake answers the prompt from before the restart with "Referee reply one"', by: 'fake', drive: () => ({ type: 'complete', thread: THREAD, text: 'Referee reply one' }),
        until: held => textOf(held).includes('Referee reply one') && lanesIdle(held) && activitiesOf(held).some(record => record.kind === 'turn' && record.status === 'running') },
      complete('Referee reply to the resume note'),
    ] satisfies Step[] : [complete('Referee reply one')],
    ...reads,
  ]
  if (scenario === 'lost-acknowledgement') return LOSES_ACKNOWLEDGEMENT[provider] && [
    ...opening,
    { say: 'the fake will acknowledge the next prompt late', by: 'fake', drive: () => ({ type: 'lose-acknowledgement' }) },
    // The send is over once the host has settled what became of it: the delivery says, and the lane is closed. Where the
    // late acknowledgement shows its turn running after the prompt shows, the step waits for the turn too: the prompt
    // alone, still idle, lasts only until the acknowledgement lands, and a busy machine can miss it (#2708).
    commandStep({ say: 'desktop sends "Referee prompt one"', by: 'desktop', request: command({ type: 'manual-send', threadId: THREAD, text: 'Referee prompt one' }),
      until: (held, context) => textOf(held).includes('Referee prompt one') && ((held.shell?.deliveries ?? []) as { status?: string }[]).every(delivery => delivery.status !== 'submitting' && delivery.status !== 'queued')
        && (!LOSES_ACKNOWLEDGEMENT[provider]!.startsTurn || sent(provider, 'Referee prompt one')(held, context)) }),
    { say: 'the fake acknowledges prompts again', by: 'fake', drive: () => ({ type: 'acknowledge-again' }) },
    { ...complete('Referee reply one'), until: recordEnded('Referee reply one') },
    ...reads,
  ]
  // A send carrying what the desktop staged: the turn it starts, or, for a model that reads no picture, the host's refusal of
  // the send whole, saying why, before its provider hears anything.
  const sendStaged = (say: string, until: NonNullable<Step['until']>): Step => commandStep({ say, by: 'desktop',
    request: ({ staged }) => ({ op: 'command', command: { type: 'manual-send', threadId: THREAD, text: 'Referee prompt one', attachments: staged } }), until })
  const refused: NonNullable<Step['until']> = held => ((held.shell?.deliveries ?? []) as { status?: string }[]).some(delivery => delivery.status === 'failed')
  if (scenario === 'attachments') return [
    ...opening,
    { say: 'desktop stages a text file', by: 'desktop', request: () => ({ op: 'stage-file-part', part: { uploadId: '00000000-0000-4000-8000-0000000000f1', index: 0, count: 1,
      name: 'Referee notes.txt', mimeType: 'text/plain', sizeBytes: NOTES.byteLength, digest: createHash('sha256').update(NOTES).digest('hex'), data: NOTES.toString('base64') } }) },
    sendStaged('desktop sends "Referee prompt one" with it', sent(provider, 'Referee prompt one')),
    complete('Referee reply one'),
    ...reads,
  ]
  if (scenario === 'pictures') return [
    ...opening,
    { say: 'desktop stages a picture', by: 'desktop', request: () => ({ op: 'stage-attachment', image: { name: 'Referee.png', mimeType: 'image/png', data: PIXEL } }) },
    ...READS_IMAGES.has(provider)
      ? [sendStaged('desktop sends "Referee prompt one" with it', sent(provider, 'Referee prompt one')), complete('Referee reply one')]
      : [sendStaged('desktop sends "Referee prompt one" with it, which the model refuses', refused)],
    ...reads,
  ]
  return [
    ...opening,
    // A turn, from the desktop.
    send('desktop', 'Referee prompt one'),
    complete('Referee reply one'),
    // A question, from the iPhone.
    send('iphone', 'Referee prompt two'),
    { say: 'the fake asks a question', by: 'fake', drive: () => ({ type: 'question', thread: THREAD, text: 'Which colour?' }), until: asking(provider, 1) },
    commandStep({ say: 'iphone answers it', by: 'iphone', request: ({ held }) => ({ op: 'command', command: { type: 'answer', threadId: THREAD, requestId: requestOf(held), answer: 'Blue' } }), until: asking(provider, 0) }),
    complete('Referee reply two'),
    // A permission, from the plain client.
    send('plain', 'Referee prompt three'),
    { say: 'the fake asks for a permission', by: 'fake', drive: () => ({ type: 'permission', thread: THREAD, text: 'Run the referee build?' }), until: asking(provider, 1) },
    commandStep({ say: 'plain allows it', by: 'plain', request: ({ held }) => ({ op: 'command', command: { type: 'answer', threadId: THREAD, requestId: requestOf(held), answer: '', approved: true } }), until: asking(provider, 0) }),
    complete('Referee reply three'),
    // A stop, from the desktop.
    send('desktop', 'Referee prompt four'),
    commandStep({ say: 'desktop stops the turn', by: 'desktop', request: command({ type: 'interrupt', threadId: THREAD }), until: ended('Referee prompt four') }),
    // Reads, and two requests a host refuses.
    { say: 'desktop reads the thread', by: 'desktop', request: () => ({ op: 'detail', threadId: THREAD }) },
    { say: 'iphone reads the thread', by: 'iphone', request: () => ({ op: 'detail', threadId: THREAD }) },
    { say: 'plain reads the events', by: 'plain', request: () => ({ op: 'events', afterSeq: 0, threadId: THREAD }) },
    { say: 'plain reads the shell', by: 'plain', request: () => ({ op: 'shell' }) },
    { say: 'desktop sends an operation the host does not have', by: 'desktop', request: () => ({ op: 'referee-no-such-operation' }) },
    { say: 'iphone sends a command field the allow-list lacks', by: 'iphone', request: command({ type: 'interrupt', threadId: THREAD, refereeField: true }) },
  ]
}
