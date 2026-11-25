// @vitest-environment node
// Command, operation and hello parity between the Node host and the Rust `sotto-host` (ADR-0214, Gate 1 of
// docs/plans/2026-11-24-rust-remote-host-cutover-readiness.md, #2876). Both start on fresh data folders with the referee's
// fake Codex. A recorded desktop and a phone each say hello to both, and every remote command and every v1 operation is
// sent to both, each command on a thread made for it alone. The test compares what each host offers and how each answers:
// ok, or which error. Every difference must be listed in `tests/fixtures/rustHostParityGaps.json`, and every listed
// difference must still be one, so the list only shrinks as the Rust host gains handlers. #2876 is done when it is empty.
//
// An answer's code is compared, not its contents: each command's own behaviour is its handler's own test. Runs when
// `SOTTO_TEST_RUST_HOST=1` (the Rust host CI job, and locally after a `cargo build`). `SOTTO_UPDATE_RUST_PARITY_GAPS=1`
// writes the list as the hosts answer it, for a change that closes a gap; a new gap is a regression, not an update.
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
import { HOST_FEATURES, hostRequestSchema } from '../../src/shared/hostProtocol'
import { buildNodeRefereeHost } from '../referee/nodeHost'
import { prepareFake, REFEREE_OWL_VERSION } from '../referee/providers'
import { DESKTOP_DEFLATE_OFFER, openSocket, pairClient, startHost, type RunningHost, type Socket } from '../referee/wire'
import { COMMAND_PROBES, OPERATION_PROBES, type ProbeIds } from './rustHostParityProbes'

const RUN_RUST_HOST = process.env.SOTTO_TEST_RUST_HOST === '1'
const UPDATE_GAPS = process.env.SOTTO_UPDATE_RUST_PARITY_GAPS === '1'
const GAPS_FILE = resolve('tests/fixtures/rustHostParityGaps.json')
const ANSWER_DEADLINE_MS = 30_000
/**
 * The least time between two of one client's requests. Node closes a client that sends more than 100 messages in a second
 * (`MESSAGES_PER_SECOND`, `src/host/socketServer.ts`), and a run of quick probes would otherwise reach that at once.
 */
const REQUEST_SPACING_MS = 25

/** How a host answered one request: `ok`, the error's code, or `no answer` within the deadline. */
type Outcome = string
interface Gaps {
  /** Per client: the features Node offers that Rust does not, and those Rust offers that Node does not. */
  readonly features: Record<string, { readonly missing: string[]; readonly extra: string[] }>
  /** Per command or operation where the two answer differently: each host's outcome. */
  readonly commands: Record<string, { readonly node: Outcome; readonly rust: Outcome }>
  readonly operations: Record<string, { readonly node: Outcome; readonly rust: Outcome }>
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

/** One paired client of one host. */
interface Client {
  readonly session: string
  readonly socket: Socket
  next: number
  sentAt: number
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

const outcomeOf = (frame: Record<string, unknown> | undefined): Outcome => frame === undefined ? 'no answer'
  : frame.ok === true ? 'ok' : String((frame.error as { code?: unknown } | undefined)?.code ?? 'error')

/** A host on a fresh data folder, with a recorded desktop and a phone that have said hello. */
interface HostUnderTest {
  readonly label: string
  readonly data: string
  readonly host: RunningHost
  readonly desktop: Client
  readonly phone: Client
  readonly hellos: Record<'desktop' | 'phone', Hello>
  projectId: string
}

async function connect(port: number, data: string, name: string): Promise<{ client: Client; clientId: string }> {
  const paired = await pairClient(port, data, name)
  const socket = await openSocket(port, paired.session, DESKTOP_DEFLATE_OFFER)
  return { client: { session: paired.session, socket, next: 0, sentAt: 0 }, clientId: paired.clientId }
}

interface Hello { readonly features: string[]; readonly capabilities: unknown }

async function hello(client: Client): Promise<Hello> {
  const answer = await request(client, { op: 'hello', accepts: [...HOST_FEATURES] })
  expect(answer?.ok, JSON.stringify(answer?.error)).toBe(true)
  const result = answer!.result as { features: string[]; capabilities: unknown }
  return { features: [...result.features].sort(), capabilities: result.capabilities }
}

async function startUnderTest(command: readonly string[], label: string): Promise<HostUnderTest> {
  const data = await mkdtemp(join(tmpdir(), `sotto-parity-${label}-`))
  await prepareFake(data, 'codex')
  const host = await startHost(command, data, 'codex', 60_000)
  const desktop = await connect(host.port, data, `Parity desktop on ${label}`)
  const phone = await connect(host.port, data, `Parity phone on ${label}`)
  // The launch script records the desktop it was started for; both hosts read the record again at each hello.
  await writeFile(join(data, DESKTOP_CLIENTS_FILE), JSON.stringify([desktop.clientId]))
  const hellos = { desktop: await hello(desktop.client), phone: await hello(phone.client) }
  const folder = join(data, 'probe-project')
  await mkdir(folder, { recursive: true })
  const created = await request(desktop.client, { op: 'command', command: { type: 'create-project', title: 'Parity project', path: folder, useExisting: true } })
  expect(created?.ok, `${label} create-project: ${JSON.stringify(created?.error)}`).toBe(true)
  const projects = ((created!.result as { host?: { projects?: { id: string; path?: string }[] } }).host?.projects ?? [])
  const projectId = projects.find(project => project.path === folder)?.id ?? projects[0]?.id
  expect(projectId, `${label} made no project`).toBeTruthy()
  return { label, data, host, desktop: desktop.client, phone: phone.client, hellos, projectId: projectId! }
}

async function probeIds(under: HostUnderTest, threadId: string, after: string): Promise<ProbeIds> {
  const made = await request(under.desktop, { op: 'command', command: { type: 'create-thread', projectId: under.projectId, title: 'Parity thread', modelId: 'fixture-model', threadId } })
  expect(made?.ok, `${under.label} made no thread after ${after}: ${made ? JSON.stringify(made.error) : 'no answer'}\n${under.host.stderr().slice(-2_000)}`).toBe(true)
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
  return { ...folders, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
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
  const found: Gaps = { features: {}, commands: {}, operations: {} }
  const saved = { ...process.env }

  beforeAll(async () => {
    build = await mkdtemp(join(tmpdir(), 'sotto-parity-build-'))
    const nodeCommand = await buildNodeRefereeHost(build)
    // The hosts start with this environment. Neither may reach a real provider client, its sign-in or GitHub: their home
    // and app folders are the test's own, the PATH holds only Node and Git, gh has no sign-in and git no user's settings.
    Object.assign(process.env, await isolatedEnvironment(build))
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN']) delete process.env[key]
    const rustCommand = [rustHostBinary(), '--data', '{data}', '--fake', '{provider}', '--fixtures-dir', resolve('tests/fixtures'), '--sotto-version', REFEREE_OWL_VERSION]
    ;[node, rust] = await Promise.all([startUnderTest(nodeCommand, 'node'), startUnderTest(rustCommand, 'rust')])
  }, 600_000)

  afterAll(async () => {
    for (const under of [node, rust]) {
      if (!under) continue
      under.desktop.socket.close(); under.phone.socket.close()
      await under.host.stop()
      await rm(under.data, { recursive: true, force: true })
    }
    if (build) await rm(build, { recursive: true, force: true })
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
  })

  it('gives each client the capabilities Node gives it', () => {
    for (const client of ['desktop', 'phone'] as const) expect(rust.hellos[client].capabilities, client).toEqual(node.hellos[client].capabilities)
  })

  it('offers each client the features Node offers it, except the listed gaps', () => {
    for (const client of ['desktop', 'phone'] as const) {
      const nodeOffers = node.hellos[client].features, rustOffers = rust.hellos[client].features
      found.features[client] = {
        missing: nodeOffers.filter(feature => !rustOffers.includes(feature)),
        extra: rustOffers.filter(feature => !nodeOffers.includes(feature)),
      }
    }
  })

  it('answers every remote command as Node does, except the listed gaps', async () => {
    let previous = 'the start'
    for (const [type, probe] of Object.entries(COMMAND_PROBES)) {
      const threadId = randomUUID()
      const [nodeIds, rustIds] = await Promise.all([probeIds(node, threadId, previous), probeIds(rust, threadId, previous)])
      previous = type
      const [nodeAnswer, rustAnswer] = await Promise.all([
        request(node.desktop, { op: 'command', command: probe!(nodeIds) }),
        request(rust.desktop, { op: 'command', command: probe!(rustIds) }),
      ])
      const outcomes = { node: outcomeOf(nodeAnswer), rust: outcomeOf(rustAnswer) }
      if (outcomes.node !== outcomes.rust) found.commands[type] = outcomes
    }
  }, 600_000)

  it('answers every v1 operation as Node does, except the listed gaps', async () => {
    let previous = 'the commands'
    for (const [op, probe] of Object.entries(OPERATION_PROBES)) {
      if (op === 'hello' || op === 'command') continue
      const threadId = randomUUID()
      const [nodeIds, rustIds] = await Promise.all([probeIds(node, threadId, previous), probeIds(rust, threadId, previous)])
      previous = op
      const [nodeAnswer, rustAnswer] = await Promise.all([
        request(node.desktop, probe(nodeIds) as Record<string, unknown>),
        request(rust.desktop, probe(rustIds) as Record<string, unknown>),
      ])
      const outcomes = { node: outcomeOf(nodeAnswer), rust: outcomeOf(rustAnswer) }
      if (outcomes.node !== outcomes.rust) found.operations[op] = outcomes
    }
  }, 600_000)

  it('differs from Node only where the gap list says, and in every place it says', async () => {
    const sorted = <T>(record: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))
    const actual: Gaps = { features: sorted(found.features), commands: sorted(found.commands), operations: sorted(found.operations) }
    if (UPDATE_GAPS) await writeFile(GAPS_FILE, JSON.stringify(actual, null, 2) + '\n')
    const listed = JSON.parse(await readFile(GAPS_FILE, 'utf8')) as Gaps
    expect(actual).toEqual(listed)
  })
})
