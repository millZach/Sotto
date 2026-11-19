// The script the referee plays against a host, for each provider that has a fake: three clients at once, each with the
// hello a real client of its kind sends, taking turns to act, while a fake provider plays its part.
import { PROVIDER_LABELS, publicProviderEntityId } from '../../src/shared/agents'
import type { Held } from './fold'
import type { DriverAction, RefereeProvider } from './providers'

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
  desktop: { offer: 'permessage-deflate; client_no_context_takeover; server_no_context_takeover', summaries: false, hello: { afterSeq: NO_EVENTS_AFTER, accepts: ['client-liveness', 'detail-delta', 'message-aliases', 'client-updates', 'client-update-not-listed', 'answer-receipts', 'usage-history', 'usage-muse-opencode', 'model-catalog-revision', 'host-update', 'activity-bodies', 'changed-thread-records', 'kept-parts', 'plugin-meshy-spending', 'plugin-elevenlabs-spending', 'provider-opencode', 'provider-cursor', 'provider-deepseek', 'provider-pi', 'provider-hermes'] } },
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
}

export interface Step {
  /** What the step does, in words, for the recording and for a failure. */
  readonly say: string
  readonly by: ClientName | 'fake'
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
  readonly until?: (held: Held, context: Omit<StepContext, 'held'> & { readonly client: ClientName }) => boolean
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
const lanesIdle = (held: Held): boolean => held.shell?.globalLaneBusy !== true && ((held.shell?.busyThreadIds ?? []) as unknown[]).length === 0
/** Each send is acknowledged by its provider, which the delivery records with the time it took. */
const deliveriesSettled = (held: Held): boolean => ((held.shell?.deliveries ?? []) as { providerLatencyMs?: unknown }[]).every(delivery => delivery.providerLatencyMs !== undefined)
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

/** One provider's script. Every text in it is the referee's own; nothing comes from a real account. */
export function script(provider: RefereeProvider): Step[] {
  const send = (by: ClientName, text: string): Step => commandStep({ say: `${by} sends "${text}"`, by, request: command({ type: 'manual-send', threadId: THREAD, text }), until: sent(provider, text) })
  const complete = (text: string): Step => ({ say: `the fake ends the turn with "${text}"`, by: 'fake', drive: () => ({ type: 'complete', thread: THREAD, text }), until: ended(text) })
  const projectOf = (held: Held, data: string): { id: string; path: string } | undefined => ((held.shell?.host as { projects?: { id: string; path: string }[] } | undefined)?.projects ?? []).find(item => item.path === data)
  return [
    ...CLIENTS.map((by): Step => ({ say: `${by} says hello`, by, request: () => ({ op: 'hello', ...PROFILES[by].hello }), until: started(provider) })),
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
    // The first observe has the host read the thread's folder with Git, which its record shows once that is done.
    ...CLIENTS.map((by): Step => ({ say: `${by} observes the thread`, by, request: () => ({ op: 'observe', threadIds: [THREAD] }), until: held => threadOf(held)?.worktree?.git !== undefined })),
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
    // Claude Code's adapter hears a reply twice, from the CLI's output and from its transcript, and which comes first
    // differs from run to run; when the transcript wins, the history gains a message-replaced event that repeats the
    // message word for word. So the TypeScript host's event history for a Claude thread is not the same on every run,
    // and is not a record a host in another language can be held to until that is settled.
    ...provider === 'claude' ? [] : [{ say: 'plain reads the events', by: 'plain', request: () => ({ op: 'events', afterSeq: 0, threadId: THREAD }) } satisfies Step],
    { say: 'plain reads the shell', by: 'plain', request: () => ({ op: 'shell' }) },
    { say: 'desktop sends an operation the host does not have', by: 'desktop', request: () => ({ op: 'referee-no-such-operation' }) },
    { say: 'iphone sends a command field the allow-list lacks', by: 'iphone', request: command({ type: 'interrupt', threadId: THREAD, refereeField: true }) },
  ]
}
