// @vitest-environment node
// Command, operation and hello parity between the Node host and the Rust `sotto-host` (ADR-0214, Gate 1 of
// docs/plans/2026-11-24-rust-remote-host-cutover-readiness.md, #2876). Both start on fresh data folders with the referee's
// fake Codex. A recorded desktop and an unrecorded client each say hello to both, and every remote command and every v1
// operation is sent to both, each on a thread made for it alone. The test compares what each host offers and how each
// answers: ok, refused in the state it sends back, or which error. Every difference must be listed in
// `tests/fixtures/rustHostParityGaps.json`, and every listed difference must still be one, so the list only shrinks as the
// Rust host gains handlers. #2876 is done when it is empty.
//
// An answer's kind is compared, not its contents: each command's own behaviour is its handler's own test. What only the
// socket server can show, across clients, is compared whole: which threads count as shown, which sees a failure (ADR-0092).
// Both clients use the loopback listener, where Node counts every client as a desktop; a phone over a tailnet listener is
// not compared here.
// Runs when `SOTTO_TEST_RUST_HOST=1` (the Rust host CI job, and locally after a `cargo build`).
// `SOTTO_UPDATE_RUST_PARITY_GAPS=1` takes closed gaps off the list; it never adds one, since a new gap is a regression.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REMOTE_COMMANDS } from '../../src/host/remoteCommands'
import { agentCommandSchema } from '../../src/shared/agents'
import { DESKTOP_CLIENTS_FILE } from '../../src/shared/desktopClients'
import { hostRequestSchema } from '../../src/shared/hostProtocol'
import { buildNodeRefereeHost } from '../referee/nodeHost'
import { prepareFake, REFEREE_OWL_VERSION } from '../referee/providers'
import { PROFILES } from '../referee/scenario'
import { DESKTOP_DEFLATE_OFFER, openSocket, pairClient, startHost, type RunningHost, type Socket } from '../referee/wire'
import { COMMAND_PROBES, FIXTURE_MODEL, OPERATION_PROBES, type ProbeIds } from './rustHostParityProbes'

const RUN_RUST_HOST = process.env.SOTTO_TEST_RUST_HOST === '1'
const UPDATE_GAPS = process.env.SOTTO_UPDATE_RUST_PARITY_GAPS === '1'
const GAPS_FILE = resolve('tests/fixtures/rustHostParityGaps.json')
const ANSWER_DEADLINE_MS = 30_000
/**
 * The least time between two of one client's requests. Node closes a client that sends more than 100 messages in a second
 * (`MESSAGES_PER_SECOND`, `src/host/socketServer.ts`), and a run of quick probes would otherwise reach that at once.
 */
const REQUEST_SPACING_MS = 25

/**
 * How a host answered one request: `ok`; `refused`, an ok answer to a command whose state names a new error, which is how
 * Node answers a command it turned down; the error's code; or `no answer` within the deadline.
 */
type Outcome = string
type ClientKind = 'desktop' | 'unrecorded'
const CLIENT_KINDS: readonly ClientKind[] = ['desktop', 'unrecorded']
/** Each client's hello, as the desktop's and the iPhone's own clients send it (`tests/referee/scenario.ts`). */
const ACCEPTS: Record<ClientKind, readonly string[]> = { desktop: PROFILES.desktop.hello.accepts as string[], unrecorded: PROFILES.iphone.hello.accepts as string[] }
type Answers = Record<string, { readonly node: Outcome; readonly rust: Outcome }>

/**
 * What a Node host offers a recorded desktop and answers it that the referee's Node host cannot show, so the Rust host is held
 * to it alone: no Node host to update, OpenCode held, and no picture maker in the referee's bundle.
 */
const UNSEEN_FEATURES: readonly string[] = ['host-update', 'opencode-sign-in', 'thread-media-edge']
const UNSEEN_OPERATIONS: readonly string[] = ['host-update', 'opencode-sign-in']

interface Gaps {
  /** Per client: the features Node offers that Rust does not, and those Rust offers that Node does not. */
  readonly features: Partial<Record<ClientKind, { readonly missing: string[]; readonly extra: string[] }>>
  /** What Rust lacks of what the referee's Node host cannot show: features it does not offer, operations it has no handler for. */
  readonly unseen: { readonly features: string[]; readonly operations: string[] }
  /** Per command or operation where the two answer differently: each host's outcome. */
  readonly commands: Answers
  readonly operations: Answers
}

describe('parity probes', () => {
  const ids: ProbeIds = { projectId: 'probe-project', threadId: randomUUID(), folder: join(tmpdir(), 'probe') }

  it('has one probe for each remote command, each a command Node parses', () => {
    expect(Object.keys(COMMAND_PROBES).sort()).toEqual(Object.keys(REMOTE_COMMANDS).sort())
    const refused = Object.entries(COMMAND_PROBES).flatMap(([type, probe]) => {
      const parsed = agentCommandSchema.safeParse(probe!(ids))
      return parsed.success ? [] : [`${type}: ${parsed.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ')}`]
    })
    expect(refused).toEqual([])
  })

  it('has one probe for each v1 operation, each a request Node parses', () => {
    const refused = Object.entries(OPERATION_PROBES).flatMap(([op, probe]) => {
      const parsed = hostRequestSchema.safeParse({ v: 1, id: 'probe', session: 'probe', ...probe(ids) })
      return parsed.success ? [] : [`${op}: ${parsed.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ')}`]
    })
    expect(refused).toEqual([])
  })
})

/** One paired client of one host, and the error the state it was last sent named. */
interface Client {
  readonly session: string
  readonly socket: Socket
  next: number
  sentAt: number
  error: string | undefined
}

/** Sends one request and answers the host's reply to it, or undefined when none came within the deadline. */
async function request(client: Client, body: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  const wait = client.sentAt + REQUEST_SPACING_MS - Date.now()
  if (wait > 0) await new Promise(resolveWait => setTimeout(resolveWait, wait))
  client.sentAt = Date.now()
  const id = `probe-${++client.next}`
  const found = (): Record<string, unknown> | undefined => client.socket.crossings.find(crossing => crossing.dir === 'in' && crossing.frame.id === id)?.frame
  return await new Promise(resolveAnswer => {
    const timer = setTimeout(() => { stop(); resolveAnswer(undefined) }, ANSWER_DEADLINE_MS)
    const stop = client.socket.onArrival(() => {
      const frame = found()
      if (frame) { clearTimeout(timer); stop(); resolveAnswer(frame) }
    })
    client.socket.send({ v: 1, id, session: client.session, ...body })
  })
}

/** Sends a request and names how it was answered. A command's state can name an error from before it, so only a new one counts. */
async function outcome(client: Client, body: Record<string, unknown>): Promise<Outcome> {
  const answer = await request(client, body)
  if (answer === undefined) return 'no answer'
  if (answer.ok !== true) return String((answer.error as { code?: unknown } | undefined)?.code ?? 'error')
  if (body.op !== 'command') return 'ok'
  const error = (answer.result as { error?: unknown } | undefined)?.error
  const before = client.error
  client.error = typeof error === 'string' && error.length > 0 ? error : undefined
  return client.error !== undefined && client.error !== before ? 'refused' : 'ok'
}

/** A host on a fresh data folder, with a recorded desktop and an unrecorded client that have said hello. */
interface HostUnderTest {
  readonly label: string
  readonly data: string
  readonly host: RunningHost
  readonly clients: Record<ClientKind, Client>
  readonly hellos: Record<ClientKind, Hello>
  readonly projectId: string
}

async function connect(port: number, data: string, name: string): Promise<{ client: Client; clientId: string }> {
  const paired = await pairClient(port, data, name)
  const socket = await openSocket(port, paired.session, DESKTOP_DEFLATE_OFFER)
  return { client: { session: paired.session, socket, next: 0, sentAt: 0, error: undefined }, clientId: paired.clientId }
}

interface Hello { readonly features: string[]; readonly capabilities: unknown }

async function hello(client: Client, kind: ClientKind): Promise<Hello> {
  const answer = await request(client, { op: 'hello', accepts: [...ACCEPTS[kind]] })
  expect(answer?.ok, JSON.stringify(answer?.error)).toBe(true)
  const result = answer!.result as { features: string[]; capabilities: unknown }
  return { features: [...result.features].sort(), capabilities: result.capabilities }
}

async function startUnderTest(command: readonly string[], label: string): Promise<HostUnderTest> {
  const data = await mkdtemp(join(tmpdir(), `sotto-parity-${label}-`))
  await prepareFake(data, 'codex')
  const host = await startHost(command, data, 'codex', 60_000)
  const desktop = await connect(host.port, data, `Parity desktop on ${label}`)
  const unrecorded = await connect(host.port, data, `Parity client on ${label}`)
  // The launch script records the desktop it was started for; both hosts read the record again at each hello.
  await writeFile(join(data, DESKTOP_CLIENTS_FILE), JSON.stringify([desktop.clientId]))
  const clients = { desktop: desktop.client, unrecorded: unrecorded.client }
  const hellos = { desktop: await hello(clients.desktop, 'desktop'), unrecorded: await hello(clients.unrecorded, 'unrecorded') }
  const folder = join(data, 'probe-project')
  await mkdir(folder, { recursive: true })
  const created = await request(clients.desktop, { op: 'command', command: { type: 'create-project', title: 'Parity project', path: folder, useExisting: true } })
  const shell = created?.result as { error?: string; host?: { projects?: { id: string; path?: string }[] } } | undefined
  expect(created?.ok && !shell?.error, `${label} create-project: ${JSON.stringify(created?.error ?? shell?.error)}`).toBe(true)
  const projectId = shell?.host?.projects?.find(project => project.path === folder)?.id
  expect(projectId, `${label} made no project`).toBeTruthy()
  return { label, data, host, clients, hellos, projectId: projectId! }
}

/** A thread made for one probe alone, by the ID both hosts are given, and a folder of its own. */
async function probeIds(under: HostUnderTest, threadId: string, after: string): Promise<ProbeIds> {
  const made = await request(under.clients.desktop, { op: 'command', command: { type: 'create-thread', projectId: under.projectId, title: 'Parity thread', modelId: FIXTURE_MODEL, threadId } })
  const shell = made?.result as { error?: string; host?: { threads?: { id: string }[] } } | undefined
  const why = made === undefined ? 'no answer' : JSON.stringify(made.error ?? shell?.error ?? 'no such thread')
  expect(made?.ok === true && shell?.host?.threads?.some(thread => thread.id === threadId), `${under.label} made no thread after ${after}: ${why}\n${under.host.stderr().slice(-2_000)}`).toBe(true)
  under.clients.desktop.error = shell?.error
  const folder = join(under.data, 'probe-folders', randomUUID())
  await mkdir(folder, { recursive: true })
  return { projectId: under.projectId, threadId, folder }
}

/** Home, app and config folders inside `root`, and a PATH of only Node's and Git's folders. */
async function isolatedEnvironment(root: string): Promise<NodeJS.ProcessEnv> {
  const home = join(root, 'home')
  const folders = { HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'), XDG_CACHE_HOME: join(home, '.cache'), GH_CONFIG_DIR: join(home, 'gh') }
  for (const folder of Object.values(folders)) await mkdir(folder, { recursive: true })
  const gitConfig = join(home, '.gitconfig')
  await writeFile(gitConfig, '[user]\n\tname = Parity Probe\n\temail = probe@example.invalid\n')
  const git = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' }).split(/\r?\n/u)[0]!.trim()
  const system = process.platform === 'win32' ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')] : []
  // Git may read and write local repositories only: a clone, fetch or push to anywhere else is refused before it connects.
  return { ...folders, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file',
    PATH: [...new Set([dirname(process.execPath), dirname(git), ...system])].join(delimiter) }
}

function rustHostBinary(): string {
  const exe = process.platform === 'win32' ? 'sotto-host.exe' : 'sotto-host'
  const target = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : resolve('target')
  const candidate = [join(target, 'debug', exe), join(target, 'release', exe)].find(existsSync)
  if (!candidate) throw new Error(`Build the Rust host first: cargo build -p sotto-host --bin sotto-host (looked in ${target}).`)
  return candidate
}

describe.skipIf(!RUN_RUST_HOST)('the Rust host against the Node host', () => {
  let build: string
  let node: HostUnderTest
  let rust: HostUnderTest
  const found: Gaps = { features: {}, unseen: { features: [], operations: [] }, commands: {}, operations: {} }
  const saved = { ...process.env }

  beforeAll(async () => {
    build = await mkdtemp(join(tmpdir(), 'sotto-parity-build-'))
    const nodeCommand = await buildNodeRefereeHost(build)
    // The hosts start with this environment. Neither may reach a real provider client, its sign-in or GitHub: their home
    // and app folders are the test's own, the PATH holds only Node and Git, gh has no sign-in, and Git reads no user's
    // settings and reaches no remote.
    Object.assign(process.env, await isolatedEnvironment(build))
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN']) delete process.env[key]
    const rustCommand = [rustHostBinary(), '--data', '{data}', '--fake', '{provider}', '--fixtures-dir', resolve('tests/fixtures'), '--sotto-version', REFEREE_OWL_VERSION]
    ;[node, rust] = await Promise.all([startUnderTest(nodeCommand, 'node'), startUnderTest(rustCommand, 'rust')])
  }, 600_000)

  afterAll(async () => {
    for (const under of [node, rust]) {
      if (!under) continue
      for (const client of Object.values(under.clients)) client.socket.close()
      await under.host.stop()
      await rm(under.data, { recursive: true, force: true })
    }
    if (build) await rm(build, { recursive: true, force: true })
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
  })

  it('gives each client the capabilities Node gives it', () => {
    for (const client of CLIENT_KINDS) expect(rust.hellos[client].capabilities, client).toEqual(node.hellos[client].capabilities)
  })

  it('offers each client the features Node offers it, except the listed gaps', () => {
    for (const client of CLIENT_KINDS) {
      const nodeOffers = node.hellos[client].features, rustOffers = rust.hellos[client].features
      found.features[client] = {
        missing: nodeOffers.filter(feature => !rustOffers.includes(feature)),
        extra: rustOffers.filter(feature => !nodeOffers.includes(feature) && !UNSEEN_FEATURES.includes(feature)),
      }
    }
    // The referee's Node host offers none of these, so they are not a difference Rust may make by leaving them out.
    expect(node.hellos.desktop.features.filter(feature => UNSEEN_FEATURES.includes(feature))).toEqual([])
    found.unseen.features.push(...UNSEEN_FEATURES.filter(feature => !rust.hellos.desktop.features.includes(feature)))
  })

  /**
   * Sends each probe to both hosts' desktops, each on a thread made for it alone on each, and keeps the answers that differ.
   * The thread has the same ID on both, so the two requests are the same.
   */
  async function compare(probes: readonly (readonly [string, (ids: ProbeIds) => Record<string, unknown>])[], into: Answers): Promise<void> {
    let previous = 'the start'
    for (const [name, probe] of probes) {
      const threadId = randomUUID()
      const ids = await Promise.all([probeIds(node, threadId, previous), probeIds(rust, threadId, previous)])
      previous = name
      const [nodeAnswer, rustAnswer] = await Promise.all([outcome(node.clients.desktop, probe(ids[0])), outcome(rust.clients.desktop, probe(ids[1]))])
      if (UNSEEN_OPERATIONS.includes(name)) {
        // Rust's answer to a request it has no handler for; a handler that refuses says why in another way.
        if (rustAnswer === 'invalid_request') found.unseen.operations.push(name)
      } else if (nodeAnswer !== rustAnswer) into[name] = { node: nodeAnswer, rust: rustAnswer }
    }
  }

  it('answers every remote command as Node does, except the listed gaps', async () => {
    await compare(Object.entries(COMMAND_PROBES).map(([type, probe]) => [type, (ids: ProbeIds) => ({ op: 'command', command: probe!(ids) })] as const), found.commands)
  }, 600_000)

  it('answers every v1 operation as Node does, except the listed gaps', async () => {
    // `hello` and `command` are what every other probe here is made of.
    await compare(Object.entries(OPERATION_PROBES).filter(([op]) => op !== 'hello' && op !== 'command')
      .map(([op, probe]) => [op, (ids: ProbeIds) => probe(ids) as Record<string, unknown>] as const), found.operations)
  }, 600_000)

  /** The thread as the host's state now shows it, read with a `shell` request. */
  async function shownThread(client: Client, threadId: string): Promise<{ status?: string; failureId?: string; failureSeen?: boolean } | undefined> {
    const answer = await request(client, { op: 'shell' })
    const threads = (answer?.result as { host?: { threads?: { id: string; status?: string; failureId?: string; failureSeen?: boolean }[] } } | undefined)?.host?.threads
    return threads?.find(thread => thread.id === threadId)
  }

  /** Sends a prompt the fake fails, and waits until the host names a failure other than `before`. */
  async function failATurn(under: HostUnderTest, threadId: string, before: string | undefined): Promise<string> {
    const sent = await request(under.clients.desktop, { op: 'command', command: { type: 'manual-send', threadId, text: 'Fail this turn', draftId: randomUUID() } })
    expect(sent?.ok, `${under.label} took no prompt: ${JSON.stringify(sent?.error)}`).toBe(true)
    const deadline = Date.now() + ANSWER_DEADLINE_MS
    for (;;) {
      const thread = await shownThread(under.clients.desktop, threadId)
      if (thread?.status === 'error' && thread.failureId && thread.failureId !== before) return thread.failureId
      expect(Date.now() < deadline, `${under.label} never named the failure: ${JSON.stringify(thread)}`).toBe(true)
      await new Promise(resolveWait => setTimeout(resolveWait, 100))
    }
  }

  /**
   * Which threads count as shown, as the socket server decides it, step by step on both hosts: a failure no client shows
   * is news; a desktop behind another app (`shown: false`) shows nothing it observes; a client's own `observe-threads` shows
   * its threads; and once that client goes, it shows nothing, so the thread's next failure is news again.
   */
  it('sees a failure when a client shows its thread, as Node does', async () => {
    const steps = async (under: HostUnderTest): Promise<Record<string, boolean>> => {
      const { threadId } = await probeIds(under, randomUUID(), 'the probes')
      const script = join(under.data, 'script.json')
      const current = JSON.parse(await readFile(script, 'utf8').catch(() => '{}')) as Record<string, unknown>
      await writeFile(script, JSON.stringify({ ...current, fail: true }))
      const seen = async (): Promise<boolean> => (await shownThread(under.clients.desktop, threadId))?.failureSeen === true
      const first = await failATurn(under, threadId, undefined)
      const unshown = await seen()
      await request(under.clients.desktop, { op: 'observe', threadIds: [threadId], shown: false })
      const behind = await seen()
      const viewer = await connect(under.host.port, under.data, `Parity viewer on ${under.label}`)
      await hello(viewer.client, 'unrecorded')
      await request(viewer.client, { op: 'command', command: { type: 'observe-threads', threadIds: [threadId] } })
      const shown = await seen()
      viewer.client.socket.close()
      // The host hears the close in its own time: wait until a shell no longer shows the viewer's threads as shown.
      await new Promise(resolveWait => setTimeout(resolveWait, 500))
      await failATurn(under, threadId, first)
      const afterGone = await seen()
      return { unshown, behind, shown, afterGone }
    }
    const [onNode, onRust] = await Promise.all([steps(node), steps(rust)])
    expect(onNode).toEqual({ unshown: false, behind: false, shown: true, afterGone: false })
    expect(onRust).toEqual(onNode)
  }, 120_000)

  it('differs from Node only where the gap list says, and in every place it says', async () => {
    const sorted = <T>(record: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))
    const actual: Gaps = { features: found.features, unseen: { features: found.unseen.features.sort(), operations: found.unseen.operations.sort() },
      commands: sorted(found.commands), operations: sorted(found.operations) }
    let listed = JSON.parse(await readFile(GAPS_FILE, 'utf8')) as Gaps
    if (UPDATE_GAPS) {
      // The list may only shrink: a gap the hosts show that is not on it is not written, so it fails below.
      const kept = (now: Answers, before: Answers): Answers => Object.fromEntries(Object.entries(now).filter(([name]) => name in before))
      const within = (now: string[], before: string[] | undefined): string[] => now.filter(name => before?.includes(name))
      listed = {
        features: Object.fromEntries(CLIENT_KINDS.map(client => [client, { missing: within(actual.features[client]?.missing ?? [], listed.features[client]?.missing),
          extra: within(actual.features[client]?.extra ?? [], listed.features[client]?.extra) }])),
        unseen: { features: within(actual.unseen.features, listed.unseen.features), operations: within(actual.unseen.operations, listed.unseen.operations) },
        commands: kept(actual.commands, listed.commands), operations: kept(actual.operations, listed.operations),
      }
      await writeFile(GAPS_FILE, JSON.stringify(listed, null, 2) + '\n')
    }
    expect(actual).toEqual(listed)
  })
})
