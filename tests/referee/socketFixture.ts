// The adapter contract's fixture across the socket: a host started by its command line over a fake provider's data folder,
// a paired client of it as the contract's `AgentHost` (`socketAgentHost.ts`), and the provider fixture's own driver, which
// writes the fake's control and script files and reads what the fake recorded, all in that folder. Nothing here reaches
// into the host: a restart is the host process stopped and started again.
import type { AdapterFixture } from '../fixtures/adapterFixture'
import { publicProviderEntityId } from '../../src/shared/agents'
import { REFEREE_FIXTURES } from './fixtures'
import { adapterSession, type RefereeProvider } from './providers'
import { newContractNames, SocketAgentHost } from './socketAgentHost'
import { openSession, pairClient, startHost, type HostCommand, type RunningHost } from './wire'

const LAZY = 'Each case counts or checks a thread\'s provider session from the moment the thread is made, or waits for a reaper window it sets. A host makes the session on the thread\'s first send (the thread reads `nativeSessionStarted: false` until then, and `start-thread-session` on the wire starts one the way that send would), so there is nothing to count before it; the reaper\'s short windows (`reaperSweepMs`, `sessionIdleMs`) are the adapter\'s options, which no client sets; and every fixture but Claude Code\'s reads whether a session is open from its adapter in process. The host service contract\'s reaping case carries lazy sessions across the socket.'
const DRAFT_START = 'An early start for a thread not made yet names its model and folder in process (`startThreadSession`\'s draft); on the wire, `start-thread-session` names a thread the host already has.'

/**
 * Every contract case that cannot cross the socket, by its name, with the reason. Each one watches something inside the
 * host that no client can see or send, so across the socket it would test nothing, or test the referee's own client. The
 * verification note lists the same cases with the same reasons (`docs/verification/2026-11-19-referee-harness.md`).
 */
export const CANNOT_CROSS: Readonly<Record<string, string>> = {
  'keeps ordinary permissions when main supplies no Watcher profile':
    'Launch profiles are main\'s, handed to the adapter in process (`useLaunchProfiles`); no client sends one.',
  'observes provider takeover and rejects a reply based on stale user input':
    'A client cannot name the user message its reply follows: the host works out `expectedLastUserMessageId` for itself, so no client can send a stale reply. The host service contract carries the takeover half across the socket.',
  'marks the prompt written and its acknowledgement on the stopwatch lent for the send (#763)':
    'The stopwatch is lent to the adapter in process (`lendSendStages`); a client sees only the delivery\'s `localFeedbackMs` and `providerLatencyMs`.',
  'leaves a watched thread\'s messages out of the activity publications of a subscriber that keeps history from events (#322)':
    'Activity subscribers are in process (`subscribeActivitySnapshots`); a client\'s shell never carries messages, whichever way it keeps them.',
  'publishes every change to a thread as an upsert of it, keeping a thread map equal to the activity snapshot after each (#925)':
    'Thread changes are an in-process subscription (`subscribeActivityChanges`) held in a `ThreadMap`; their form on the wire, changed thread records, is what the referee\'s replays hold a host to.',
  'keeps a thread map equal to the activity snapshot from before a thread is first created or read (#925)':
    'Thread changes are an in-process subscription (`subscribeActivityChanges`) held in a `ThreadMap`; their form on the wire, changed thread records, is what the referee\'s replays hold a host to.',
  'publishes a thread that went as a removal of it (#925)':
    'Thread changes are an in-process subscription, and the case takes the thread\'s saved record out between two connections of the adapter, which a client cannot make without the host\'s coordinator reconnecting it.',
  'hands a thread refresh back without messages to a caller that keeps history from events, and with them to any other (#368)':
    '`refreshThread` and its read purposes are the coordinator\'s reads of its adapter; a client reads a thread with `detail`, which always carries its messages.',
  'writes short text on the side, and the thread\'s own session never hears of it (ADR-0026)':
    'The case hands the adapter a prompt and material of its own (`writeShortText`). A client can only ask the host for a title, whose material the host chooses, so the marker the case looks for cannot be put in.',
  'sends a staged image through the handle contract, reading its bytes only at the provider boundary (ADR-0031)':
    'It counts how often the handle\'s bytes are read inside the host. Across the socket the client reads them itself to stage the image, so the count says nothing of the host.',
  'resumes the same thread and messages after restart during a run':
    'It holds the adapter\'s restored thread equal to the one before, field for field. Across the socket the host\'s coordinator stands between them: it decides what a turn the restart stopped becomes (ADR-0076) and when a watched session opens again, so the thread a client is shown after a restart is the coordinator\'s. The referee\'s restart script holds a host to the TypeScript host\'s thread across a restart instead, once #2710 lets it be recorded; the attached-file cases here read messages back across one.',
  // Lazy provider sessions.
  ...Object.fromEntries([
    'connects without starting a session, and starts one when the thread enters the watched set',
    'starts a session for an action on a thread nobody is watching',
    'starts a stopped session for an early start, says it is open, and the send that follows starts none',
    'says a session the reaper stopped after an early start is no longer open',
    'stops a session left idle and starts it again on the next send, with its messages',
    'never stops a session with a running turn, while an idle one beside it is stopped',
    'never stops a watched session, while an unwatched one beside it is stopped',
  ].map(name => [name, LAZY])),
  'creates no provider session for an early start before a thread’s first send': DRAFT_START,
  'creates no provider session for an early start before a thread’s first send, when its folder does not exist yet': DRAFT_START,
  'hands the history to the event store, which answers for a thread nobody is watching':
    'It runs the coordinator\'s event store (`WorkspaceHost`) over the adapter in process; across the socket that store is inside the host, and the host service contract reads its history from there.',
  // Settings on a live session: each opens the thread\'s session without a send, by reading it (`refreshThread`).
  ...Object.fromEntries([
    'applies each change to the running session without starting another',
    'starts the session again when the provider refuses a change, and still ends accepted',
    'leaves a change whose answer was lost unconfirmed, until the session that runs it starts',
  ].map(name => [name, 'The case opens the thread\'s provider session by reading the thread (`refreshThread`) and changes its settings before anything is sent. A host makes the session on the first send, so the change is kept as the thread\'s settings and never reaches a session.'])),
  'hands back the snapshot of a confirmed change, carrying the settings the adapter reports':
    'The case changes a thread that has sent nothing. A host makes the provider session on the first send, so the change is kept as the thread\'s settings and never reaches the provider: across the socket the case would check only that the coordinator shows what it saved.',
  'leaves the messages out of a confirmed change\'s snapshot for a caller that keeps history from events (#368)':
    'A client cannot say how it keeps history: every shell leaves messages out, so the case\'s check would pass whatever the host did.',
  'carries no snapshot on an uncertain change':
    'The case changes a thread that has sent nothing. A host makes the provider session on the first send, so the change is kept as the thread\'s settings and never reaches the provider, and there is no confirmation to lose.',
  // A client update.
  ...Object.fromEntries([
    'lets a working turn finish across the update, stays connected, and reads the new version from the client',
    'does nothing while the provider is not connected',
  ].map(name => [name, 'The case puts a newer client on disk and tells the adapter in process (`clientUpdated`). A host hears of a new client only from its own installer, which `update-client` runs on the host and no client may send (`src/host/remoteCommands.ts`).'])),
}

/**
 * The cases one provider's fixture cannot carry across the socket though another's can, because its driver reaches into
 * the adapter it was made with.
 */
const UNCERTAIN = 'reconciles an uncertain prompt acknowledgement without resending'
const SHORTENED_DEADLINE = 'The fake holds the acknowledgement 3 seconds, past a 2-second deadline the fixture gives its own adapter in process for that one prompt (`requestTimeoutMs`). The host\'s adapter waits its own 15 seconds, so the acknowledgement arrives in time and nothing is lost.'
const PROVIDER_CANNOT_CROSS: Readonly<Partial<Record<RefereeProvider, Readonly<Record<string, string>>>>> = {
  grok: { [UNCERTAIN]: SHORTENED_DEADLINE }, devin: { [UNCERTAIN]: SHORTENED_DEADLINE },
  // This one could cross; it is left out for what it would cost the job, which the brief keeps in view.
  cursor: { [UNCERTAIN]: 'The fake drops the acknowledgement, and the fixture shortens its own adapter\'s wait for it to 2 seconds in process. The host\'s adapter waits its own 30 seconds before it calls the send uncertain, so across the socket the case would cost half a minute a run; it is left out for that, not because a client cannot see it.' },
  claude: { [UNCERTAIN]: 'The fake holds the acknowledgement past the adapter\'s deadline, but the host answers the send accepted: by the time it answers, the prompt shows in the thread, and nothing on the wire says the acknowledgement was late. Codex\'s, Muse\'s and OpenCode\'s cross.' },
}

export const cannotCrossFor = (provider: RefereeProvider): Readonly<Record<string, string>> => PROVIDER_CANNOT_CROSS[provider] ?? {}

/**
 * The fixtures whose session counts and live settings are read from the fake's own files alone, so they cross as the
 * driver does. Claude Code's are: the fake records each launch and writes the settings its CLI runs on. The others read
 * whether a session is open from their adapter in process, or have no live settings.
 */
const FILE_DRIVEN_SESSIONS: ReadonlySet<RefereeProvider> = new Set(['claude'])

/** How long a driver action may take to be carried out: half a case's own deadline across the socket. */
const DRIVER_DEADLINE_MS = 30_000

/** The contract's fixture for one provider, against the host `command` starts. */
export async function socketAdapterFixture(command: HostCommand, provider: RefereeProvider): Promise<AdapterFixture> {
  const library = await REFEREE_FIXTURES[provider]()
  const root = library.root
  // Codex's and Claude Code's drivers type into the provider's session log and then ask their own adapter to read it; the
  // host's adapter reads its logs on its own timer, so the driver's adapter, which nothing connects, is told nothing.
  const own = (library as AdapterFixture & { adapter?: { pollSessionLogs?: () => Promise<void> } }).adapter
  if (own?.pollSessionLogs) own.pollSessionLogs = async () => undefined
  let running: RunningHost = await startHost(command, root, provider)
  const paired = await pairClient(running.port, root, 'Contract desktop')
  // The driver was written against the adapter, which names a thread by its own ID: the host's threads.json binds it.
  // Some drivers wait for the fake to carry an action out before they answer; one that never does fails with the action named.
  const bound = <A extends unknown[]>(act: (id: string, ...rest: A) => Promise<void>, what: string) => async (threadId: string, ...rest: A): Promise<void> => {
    const session = await adapterSession(root, threadId)
    let timer: NodeJS.Timeout | undefined
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`The ${provider} fake never carried out ${what} within ${DRIVER_DEADLINE_MS} ms.`)), DRIVER_DEADLINE_MS) })
    try { await Promise.race([act(session, ...rest), late]) } finally { clearTimeout(timer) }
  }
  const work = library.driver.backgroundWork
  const names = newContractNames()
  const make = (host: SocketAgentHost): AdapterFixture => {
    const stop = async (): Promise<void> => { await host.settled().catch(() => undefined); host.close(); await running.stop() }
    return {
      host, root, providerId: provider, projectId: 'project', modelId: publicProviderEntityId(provider, 'model', library.modelId),
      ...(library.protocol ? { protocol: library.protocol } : {}), ...(library.nativePdf ? { nativePdf: true } : {}),
      ...(library.restartStatus ? { restartStatus: library.restartStatus } : {}), ...(library.settings ? { settings: library.settings } : {}),
      skips: library.skips ?? {},
      ...(FILE_DRIVEN_SESSIONS.has(provider) && library.sessions ? { sessions: {
        starts: async id => library.sessions!.starts(await adapterSession(root, id)), stopped: async id => library.sessions!.stopped(await adapterSession(root, id)),
      } } : {}),
      ...(FILE_DRIVEN_SESSIONS.has(provider) && library.liveSettings ? { liveSettings: { ...library.liveSettings,
        effective: async id => library.liveSettings!.effective(await adapterSession(root, id)) } } : {}),
      driver: {
        typeInProvider: bound(library.driver.typeInProvider, 'typing in the provider'), completeTurn: bound(library.driver.completeTurn, 'the end of a turn'),
        raiseQuestion: bound(library.driver.raiseQuestion, 'a question'), raisePermission: bound(library.driver.raisePermission, 'a permission request'),
        // What the fake recorded is read once the host has acted on every command sent before, a disconnect among them.
        delayNextAck: method => library.driver.delayNextAck(method), requests: async () => { await host.settled(); return library.driver.requests() },
        ...(work ? { backgroundWork: { completeLeaving: bound(work.completeLeaving, 'a turn that leaves background work'), end: bound(work.end, 'the end of background work') } } : {}),
        restart: async () => {
          await stop()
          running = await startHost(command, root, provider)
          return make(await SocketAgentHost.open(running.port, await openSession(running.port, paired.token), provider, names))
        },
      },
      cleanup: async () => { try { await stop() } finally { await library.cleanup() } },
    }
  }
  return make(await SocketAgentHost.open(running.port, paired.session, provider, names))
}
