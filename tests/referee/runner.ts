// Plays a provider's script against a host started by its command line, and either records what crossed or compares it
// with a recording. See `docs/verification/2026-11-19-referee-harness.md` for how a host is pointed at it.
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { diff, describeDifferences, equal, patch, type Op } from './diff'
import { ClientFold, FOLDED_PUSHES, type Held } from './fold'
import { Normaliser } from './normalise'
import { drive, prepareFake, REFEREE_OWL_VERSION, type RefereeProvider } from './providers'
import { CLIENTS, PROFILES, script, started, type ClientName, type Step } from './scenario'
import { openSocket, pairClient, startHost, type HostCommand, type RunningHost, type Socket } from './wire'

export const RECORDING_FORMAT = 1

/** One client's part of a step: the frames compared one by one, in order, and what it holds once the step is over. */
export interface RecordedClientStep { readonly frames: unknown[]; readonly held: readonly Op[] }

export interface RecordedStep {
  readonly say: string
  readonly by: ClientName | 'fake'
  /** The request a client sent, or the action the fake was handed. */
  readonly sent: unknown
  readonly clients: Readonly<Record<ClientName, RecordedClientStep>>
}

export interface Recording {
  readonly format: typeof RECORDING_FORMAT
  readonly provider: RefereeProvider
  readonly sottoVersion: string
  /** Each client's pairing over HTTP and the extension its socket was answered with. */
  readonly setup: Readonly<Record<ClientName, { readonly http: unknown[]; readonly extensions: string | null }>>
  readonly steps: readonly RecordedStep[]
}

/**
 * A recording as it is committed: JSON in which any value that fits on a short line is written on one, and the rest is
 * opened one level at a time, so a re-recording's diff shows the values that changed without doubling the file.
 */
export function formatRecording(recording: Recording): string {
  const write = (value: unknown, indent: string): string => {
    const compact = JSON.stringify(value)
    if (compact === undefined || compact.length + indent.length <= 140 || value === null || typeof value !== 'object') return compact ?? 'null'
    const inner = indent + ' '
    // A long list of plain values, such as a host's features, is filled into lines rather than given one each.
    if (Array.isArray(value) && value.every(item => item === null || typeof item !== 'object')) {
      const lines: string[] = []
      for (const item of value.map(entry => JSON.stringify(entry))) {
        if (lines.length && (lines.at(-1)! + ', ' + item).length + inner.length <= 140) lines[lines.length - 1] += ', ' + item
        else lines.push(item)
      }
      return `[\n${lines.map(line => inner + line).join(',\n')}\n${indent}]`
    }
    if (Array.isArray(value)) return `[\n${value.map(item => inner + write(item, inner)).join(',\n')}\n${indent}]`
    return `{\n${Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => `${inner}${JSON.stringify(key)}: ${write(item, inner)}`).join(',\n')}\n${indent}}`
  }
  return write(recording, '') + '\n'
}

/** Changes what one client is sent, for the harness's own tests: see `openSocket`. */
export type Tamper = (frame: Record<string, unknown>, emit: (frame: Record<string, unknown>) => void) => void

export interface RunOptions {
  readonly command: HostCommand
  readonly provider: RefereeProvider
  /** Record, or compare with this recording. */
  readonly against?: Recording
  readonly tamper?: Partial<Record<ClientName, Tamper>>
  /** How long a step may take to reach what it waits for. Generous: a deadline never reached costs nothing. */
  readonly stepDeadlineMs?: number
}

export interface RunResult {
  /** What this run recorded, normalised. */
  readonly recording: Recording
  /** Each difference from the recording, or each problem a client met, in words. Empty when the host matched. */
  readonly failures: string[]
}

const EMPTY_HELD: Held = { shell: undefined, details: {}, events: [] }

/**
 * A shell inside a frame (a hello's, a command's answer, a `shell` read) is stored as the changes from the shell the client
 * held when the step began, under this key: most of it is that shell again. Nothing is lost; a replay puts it back first.
 */
const SHELL_PATCH = '$shellPatch'
const isShell = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && 'configuration' in value && 'host' in value

function encodeFrame(frame: unknown, base: unknown): unknown {
  if (base === undefined) return frame
  const encode = (value: unknown): unknown => isShell(value) ? { [SHELL_PATCH]: diff(base, value) } : value
  const answer = frame as { result?: unknown }
  if (isShell(answer.result)) return { ...answer, result: encode(answer.result) }
  const shell = (answer.result as { shell?: unknown } | undefined)?.shell
  return isShell(shell) ? { ...answer, result: { ...(answer.result as object), shell: encode(shell) } } : frame
}

function decodeFrame(frame: unknown, base: unknown): unknown {
  const decode = (value: unknown): unknown => value !== null && typeof value === 'object' && SHELL_PATCH in value ? patch(base, (value as Record<string, Op[]>)[SHELL_PATCH]!) : value
  const answer = frame as { result?: unknown }
  if (answer.result === null || typeof answer.result !== 'object') return frame
  if (SHELL_PATCH in answer.result) return { ...answer, result: decode(answer.result) }
  const shell = (answer.result as { shell?: unknown }).shell
  return shell !== null && typeof shell === 'object' && SHELL_PATCH in shell ? { ...answer, result: { ...answer.result, shell: decode(shell) } } : frame
}

interface Client {
  readonly name: ClientName
  readonly socket: Socket
  readonly session: string
  readonly fold: ClientFold
  /** The frames compared one by one since the step began, decoded as the client reads them. */
  frames: unknown[]
  /** Requests this client sent and is waiting on, by ID, with their operation. */
  readonly pending: Map<string, Record<string, unknown>>
  /** The IDs of the sends it made: their answers' thread records are read as `answer echoes` says. */
  readonly sends: Set<string>
  read: number
  next: number
  /** How many of its fold's problems have been reported. */
  reported: number
}

/** Reads every message that has arrived on a client's socket and not been read, in order. */
function readArrivals(client: Client): void {
  const { crossings } = client.socket
  for (; client.read < crossings.length; client.read++) {
    const crossing = crossings[client.read]!
    if (crossing.dir !== 'in') continue
    const frame = crossing.frame
    if (frame.v !== 1) client.fold.problems.push(`A frame names protocol version ${JSON.stringify(frame.v)}, not 1: ${JSON.stringify(frame).slice(0, 120)}`)
    if (typeof frame.event === 'string') {
      if (FOLDED_PUSHES.has(frame.event)) client.fold.push(frame)
      else client.frames.push(frame)
      continue
    }
    const id = typeof frame.id === 'string' ? frame.id : undefined
    const request = id ? client.pending.get(id) : undefined
    if (id) client.pending.delete(id)
    if (frame.ok === true && request) {
      const result = request.op === 'hello' ? client.fold.hello(frame.result)
        : request.op === 'shell' ? client.fold.shellRead(frame.result)
          : request.op === 'command' ? client.fold.commandAnswer(frame.result) : frame.result
      // The host pushes each thread an `observe` names whole before it answers (docs/host-protocol.md, "Requests").
      if (request.op === 'observe') for (const threadId of request.threadIds as string[]) if (!(threadId in client.fold.held.details)) client.fold.problems.push(`The host answered observe before it pushed thread ${threadId}.`)
      client.frames.push({ ...frame, result })
    } else client.frames.push(frame)
  }
}

/**
 * The problems each client met since they were last reported, each under the step it was met in. It reads nothing new:
 * what arrives after a step matched is the next step's, and is compared there.
 */
function newProblems(clients: readonly Client[], label: string): string[] {
  const found: string[] = []
  for (const client of clients) {
    for (const problem of client.fold.problems.slice(client.reported)) found.push(`${label}, ${client.name}: ${problem}`)
    client.reported = client.fold.problems.length
  }
  return found
}

/** Waits until `ready` is true, read again whenever a message arrives on any socket. False at the deadline. */
function settle(clients: readonly Client[], ready: () => boolean, deadlineMs: number): Promise<boolean> {
  return new Promise(resolveSettle => {
    let done = false
    const offs: (() => void)[] = []
    const finish = (value: boolean): void => { if (done) return; done = true; clearTimeout(timer); for (const off of offs) off(); resolveSettle(value) }
    const check = (): void => { for (const client of clients) readArrivals(client); if (ready()) finish(true) }
    const timer = setTimeout(() => { check(); finish(false) }, deadlineMs)
    for (const client of clients) offs.push(client.socket.onArrival(check))
    check()
  })
}

/** A step's material for one client, normalised in the order every run normalises it. */
function material(normaliser: Normaliser, client: Client, provider: RefereeProvider): { frames: unknown[]; held: Held } {
  const frames = client.frames.map(frame => {
    const answer = frame as { id?: unknown; ok?: unknown; result?: unknown }
    return normaliser.value(answer.ok === true && client.sends.has(String(answer.id)) ? { ...answer, result: normaliser.sendAnswer(answer.result, provider) } : frame)
  })
  return { frames, held: normaliser.value(client.fold.snapshot()) as Held }
}

export async function runScenario(options: RunOptions): Promise<RunResult> {
  const { provider, against } = options
  const stepDeadlineMs = options.stepDeadlineMs ?? 20_000
  const data = await realpath(await mkdtemp(join(tmpdir(), `sotto-referee-${provider}-`)))
  let normaliser = new Normaliser({ data, repo: resolve('.') })
  const failures: string[] = []
  const steps: RecordedStep[] = []
  const setup = {} as Record<ClientName, { http: unknown[]; extensions: string | null }>
  const clients: Client[] = []
  let host: RunningHost | undefined
  try {
    await prepareFake(data, provider)
    host = await startHost(options.command, data, provider)
    // A host says it is ready before its providers have connected, and a hello answers whatever it holds then. So a client
    // the referee does not compare says hello first and waits for start-up to settle; the recorded clients come after it.
    {
      const warm = await pairClient(host.port, data, 'Referee start-up')
      const socket = await openSocket(host.port, warm.session, undefined)
      const client: Client = { name: 'plain', socket, session: warm.session, fold: new ClientFold(), frames: [], pending: new Map(), sends: new Set(), read: 0, next: 0, reported: 0 }
      socket.send({ v: 1, id: 'start-up', session: warm.session, op: 'hello', ...PROFILES.plain.hello })
      client.pending.set('start-up', { op: 'hello' })
      const settled = await settle([client], () => !client.pending.has('start-up') && client.fold.held.shell !== undefined && started(provider)(client.fold.held), stepDeadlineMs)
      socket.close()
      if (!settled) throw new Error('The host never finished starting: its provider did not connect, or another provider was still connecting.')
    }
    for (const name of CLIENTS) {
      const paired = await pairClient(host.port, data, `Referee ${name}`)
      const socket = await openSocket(host.port, paired.session, PROFILES[name].offer, options.tamper?.[name])
      clients.push({ name, socket, session: paired.session, fold: new ClientFold(), frames: [], pending: new Map(), sends: new Set(), read: 0, next: 0, reported: 0 })
      setup[name] = { http: paired.exchanges.map(exchange => ({ method: exchange.method, path: exchange.path, status: exchange.status, body: normaliser.http(exchange.path, exchange.body) })), extensions: socket.extensions ?? null }
      if (against && !equal(against.setup[name], setup[name])) failures.push(`Pairing ${name}: ${describeDifferences(against.setup[name], setup[name]).join('; ')}`)
    }
    const byName = (name: ClientName): Client => clients.find(client => client.name === name)!
    const lastHeld = Object.fromEntries(CLIENTS.map(name => [name, EMPTY_HELD])) as Record<ClientName, unknown>
    const recordedHeld = Object.fromEntries(CLIENTS.map(name => [name, EMPTY_HELD])) as Record<ClientName, unknown>
    const plan: Step[] = script(provider)
    for (const [index, step] of plan.entries()) {
      const label = `Step ${index + 1} (${step.say})`
      const expected = against?.steps[index]
      if (against && (!expected || expected.say !== step.say)) { failures.push(`${label}: the recording has ${expected ? `"${expected.say}"` : 'no such step'} here. The script changed; record again.`); break }
      const actor = step.by === 'fake' ? undefined : byName(step.by)
      const context = { provider, data, held: (actor ?? byName('desktop')).fold.snapshot() }
      let sent: unknown
      let waitingOn: string | undefined
      if (actor && step.request) {
        const id = `${actor.name}-${++actor.next}`
        const frame: Record<string, unknown> = { v: 1, id, session: actor.session, ...step.request(context) }
        actor.pending.set(id, frame); waitingOn = id
        if (frame.op === 'command' && (frame.command as { type?: unknown } | undefined)?.type === 'manual-send') actor.sends.add(id)
        actor.socket.send(frame)
        sent = normaliser.value(frame)
      } else if (step.drive) {
        const action = step.drive(context)
        sent = normaliser.value(action)
        await drive(data, provider, action)
      }
      if (expected && !equal(expected.sent, sent)) { failures.push(`${label}: the script sent ${JSON.stringify(sent)} where the recording has ${JSON.stringify(expected.sent)}. Record again.`); break }
      const answered = (): boolean => !waitingOn || !actor!.pending.has(waitingOn)
      const runContext = { provider, data }
      if (!expected) {
        // Recording: over once the request is answered and every client holds what the step waits for.
        const reached = await settle(clients, () => answered() && clients.every(client => !step.until || client.fold.held.shell === undefined || step.until(client.fold.held, { ...runContext, client: client.name })), stepDeadlineMs)
        failures.push(...newProblems(clients, label))
        if (!reached) { failures.push(`${label}: the host never reached what this step waits for.`); break }
        const recorded = {} as Record<ClientName, RecordedClientStep>
        for (const client of clients) {
          const { frames, held } = material(normaliser, client, provider)
          recorded[client.name] = { frames: frames.map(frame => encodeFrame(frame, (lastHeld[client.name] as Held).shell)), held: diff(lastHeld[client.name], held) }
          lastHeld[client.name] = held
          // What arrives from here on is the next step's.
          client.frames = []
        }
        steps.push({ say: step.say, by: step.by, sent, clients: recorded })
        continue
      }
      // Replaying: over once every client has as many frames as the recording and holds exactly what it holds. Each try
      // names new IDs on a copy, so a state passed through on the way does not move the names of what follows.
      const want = Object.fromEntries(CLIENTS.map(name => [name, patch(recordedHeld[name], expected.clients[name].held)])) as Record<ClientName, unknown>
      const wantFrames = Object.fromEntries(CLIENTS.map(name => [name, expected.clients[name].frames.map(frame => decodeFrame(frame, (recordedHeld[name] as Held).shell))])) as Record<ClientName, unknown[]>
      let attempt = normaliser
      const tried = (): Record<ClientName, { frames: unknown[]; held: Held }> => {
        attempt = normaliser.copy()
        return Object.fromEntries(clients.map(client => [client.name, material(attempt, client, provider)])) as Record<ClientName, { frames: unknown[]; held: Held }>
      }
      let latest: ReturnType<typeof tried> | undefined
      const matches = (): boolean => {
        if (!answered() || clients.some(client => client.frames.length < wantFrames[client.name].length)) return false
        latest = tried()
        return clients.every(client => equal(latest![client.name].frames, wantFrames[client.name]) && equal(latest![client.name].held, want[client.name]))
      }
      const reached = await settle(clients, matches, stepDeadlineMs)
      failures.push(...newProblems(clients, label))
      latest = tried()
      if (!reached) {
        failures.push(...describeStep(label, wantFrames, latest, want, answered()))
        break
      }
      normaliser = attempt
      const replayed = {} as Record<ClientName, RecordedClientStep>
      for (const client of clients) {
        const name = client.name
        replayed[name] = { frames: latest[name].frames.map(frame => encodeFrame(frame, (lastHeld[name] as Held).shell)), held: diff(lastHeld[name], latest[name].held) }
        recordedHeld[name] = want[name]; lastHeld[name] = latest[name].held
        client.frames = []
      }
      steps.push({ say: step.say, by: step.by, sent, clients: replayed })
    }
    // Nothing compared one by one may follow the last step: a frame there would be one the recording does not have.
    for (const client of clients) {
      readArrivals(client)
      if (client.frames.length) failures.push(`After the last step, ${client.name}: this host sent ${client.frames.length} more frames compared one by one, which the recording does not have: ${client.frames.map(frame => JSON.stringify(frame).slice(0, 120)).join('; ')}`)
    }
    failures.push(...newProblems(clients, 'After the last step'))
  } catch (error) {
    failures.push(`The run stopped: ${error instanceof Error ? error.message : String(error)}${host ? `\nHost stderr:\n${host.stderr()}` : ''}`)
  } finally {
    for (const client of clients) client.socket.close()
    await host?.stop()
    if (failures.length === 0) await rm(data, { recursive: true, force: true })
    else failures.push(`The run's data folder is kept at ${data}.`)
  }
  return { recording: { format: RECORDING_FORMAT, provider, sottoVersion: REFEREE_OWL_VERSION, setup, steps }, failures }
}

/** What a step that never matched shows, client by client: frames first, then what the client holds. */
function describeStep(label: string, wantFrames: Record<ClientName, unknown[]>, actual: Record<ClientName, { frames: unknown[]; held: Held }>, want: Record<ClientName, unknown>, answered: boolean): string[] {
  const lines: string[] = []
  if (!answered) lines.push(`${label}: the host never answered the request.`)
  for (const name of CLIENTS) {
    const recorded = wantFrames[name], sent = actual[name].frames
    const kind = (frame: unknown): string => {
      const value = frame as { id?: string; event?: string; ok?: boolean }
      return value.event ? `push "${value.event}"` : `answer to ${String(value.id)}${value.ok === false ? ' (refused)' : ''}`
    }
    if (recorded.length !== sent.length) lines.push(`${label}, ${name}: the recording has ${recorded.length} frames compared one by one (${recorded.map(kind).join(', ') || 'none'}); this host sent ${sent.length} (${sent.map(kind).join(', ') || 'none'}).`)
    for (let index = 0; index < Math.min(recorded.length, sent.length); index++) {
      if (equal(recorded[index], sent[index])) continue
      lines.push(`${label}, ${name}, ${kind(recorded[index])}:`, ...describeDifferences(recorded[index], sent[index]).map(line => `  ${line}`))
    }
    if (!equal(want[name], actual[name].held)) lines.push(`${label}, ${name}, what the client holds once the step is over:`, ...describeDifferences(want[name], actual[name].held).map(line => `  ${line}`))
  }
  return lines
}
