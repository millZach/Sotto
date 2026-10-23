import * as nodeOs from 'node:os'
import { readFile as nodeReadFile } from 'node:fs/promises'
import type { AgentDelivery, AgentFollowup, AgentHostSnapshot } from '../../shared/agents'
import { HOST_FACTS_CPU_COUNT_MAX, HOST_FACTS_REFRESH_MS, HOST_FACTS_TEXT_MAX, HOST_LOAD_SAMPLE_MS, HOST_LOAD_WINDOW_MAX_MS, HOST_RUNNING_THREADS_MAX, hostFactsSchema, hostLoadSchema, type HostFacts, type HostLoad, type HostMachineReport, type HostOs, type HostOsFamily } from '../../shared/hostFacts'

/**
 * Reads this machine's host facts (#1031). It lives beside `hostIdentity.ts` because the headless host
 * (plain Node, `src/host`) and desktop main both import from `src/main/agents`; it must never import
 * Electron. Each fact is read on its own, so one the system will not give reads null and the rest stand.
 */

/** The parts of `node:os` the reader uses, so tests can stand in for any machine. */
export interface HostFactsSystem {
  platform(): string
  release(): string
  version(): string
  machine(): string
  totalmem(): number
  freemem(): number
  cpus(): readonly unknown[]
  /** Absent where a stand-in machine has no load average; Node's own answers zeros on Windows, which never counts. */
  loadavg?(): readonly number[]
}

export interface HostFactsSources {
  readonly os?: HostFactsSystem
  readonly readFile?: (path: string) => Promise<string>
  readonly now?: () => Date
  /** Waits between a load reading's two samples; a test stands in for the clock. */
  readonly sleep?: (ms: number) => Promise<void>
}

/** Windows 11 reports itself as Windows NT 10.0; its builds start at 22000. */
const WINDOWS_11_FIRST_BUILD = 22_000
const MAC_SYSTEM_VERSION = '/System/Library/CoreServices/SystemVersion.plist'
/** The os-release specification's order: the administrator's file first, then the vendor's. */
const OS_RELEASE_FILES = ['/etc/os-release', '/usr/lib/os-release'] as const
const MEMINFO = '/proc/meminfo'
const MEMORY_PRESSURE = '/proc/pressure/memory'
const ARCHITECTURES: Readonly<Record<string, string>> = { x86_64: 'x64', amd64: 'x64', aarch64: 'arm64', arm64: 'arm64' }

function attempt<T>(read: () => T): T | null {
  try { return read() } catch { return null }
}

function text(value: string | null | undefined, max = HOST_FACTS_TEXT_MAX): string | null {
  const trimmed = value?.trim()
  return trimmed && trimmed.length <= max ? trimmed : null
}

/** A number past the schema's bounds reads unknown instead of refusing every fact. */
function count(value: number | null, { positive = false, max = Number.MAX_SAFE_INTEGER } = {}): number | null {
  if (value === null || !Number.isSafeInteger(value) || value < 0 || value > max) return null
  return positive && value === 0 ? null : value
}

async function readText(readFile: (path: string) => Promise<string>, path: string): Promise<string | null> {
  try { return await readFile(path) } catch { return null }
}

function windowsOs(system: HostFactsSystem): HostOs {
  const release = text(attempt(() => system.release()))
  const product = text(attempt(() => system.version()))
  // A server edition shares the desktop builds' numbers, so its product name is the only honest label.
  if (product && /\bServer\b/u.test(product)) return { family: 'windows', name: product, version: release }
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(release ?? '')
  if (!match || match[1] !== '10' || match[2] !== '0') return { family: 'windows', name: null, version: release }
  const name = Number(match[3]) >= WINDOWS_11_FIRST_BUILD ? 'Windows 11' : 'Windows 10'
  return { family: 'windows', name, version: release }
}

async function macOs(readFile: (path: string) => Promise<string>): Promise<HostOs> {
  const plist = await readText(readFile, MAC_SYSTEM_VERSION)
  const version = plist ? /<key>ProductVersion<\/key>\s*<string>(\d+(?:\.\d+){0,2})<\/string>/u.exec(plist)?.[1] ?? null : null
  return { family: 'macos', name: 'macOS', version }
}

/** Parses os-release's shell-like assignments: unquoted, single-quoted or double-quoted with backslash escapes. */
export function parseOsRelease(content: string): ReadonlyMap<string, string> {
  const fields = new Map<string, string>()
  for (const line of content.split(/\r?\n/u)) {
    const [, key, assigned] = /^\s*([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line) ?? []
    if (key === undefined || assigned === undefined) continue
    const raw = assigned.trim()
    let value: string
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) value = raw.slice(1, -1).replace(/\\(["\\$`])/gu, '$1')
    else if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) value = raw.slice(1, -1)
    else value = raw
    fields.set(key, value)
  }
  return fields
}

async function linuxOs(readFile: (path: string) => Promise<string>): Promise<HostOs> {
  for (const path of OS_RELEASE_FILES) {
    const content = await readText(readFile, path)
    if (content === null) continue
    const fields = parseOsRelease(content)
    return {
      family: 'linux',
      name: text(fields.get('PRETTY_NAME')) ?? text(fields.get('NAME')),
      version: text(fields.get('VERSION_ID')),
    }
  }
  return { family: 'linux', name: null, version: null }
}

async function readOs(system: HostFactsSystem, readFile: (path: string) => Promise<string>): Promise<HostOs> {
  const platform = attempt(() => system.platform())
  if (platform === 'win32') return windowsOs(system)
  if (platform === 'darwin') return macOs(readFile)
  if (platform === 'linux') return linuxOs(readFile)
  return { family: null, name: null, version: null }
}

function architecture(system: HostFactsSystem): string | null {
  const machine = text(attempt(() => system.machine()), 32)
  return machine === null ? null : ARCHITECTURES[machine.toLowerCase()] ?? machine
}

function memory(system: HostFactsSystem): Pick<HostFacts, 'totalMemoryBytes' | 'freeMemoryBytes'> {
  return { totalMemoryBytes: count(attempt(() => system.totalmem())), freeMemoryBytes: count(attempt(() => system.freemem())) }
}

export async function readHostFacts(sources: HostFactsSources = {}): Promise<HostFacts> {
  const system = sources.os ?? nodeOs
  const readFile = sources.readFile ?? ((path: string) => nodeReadFile(path, 'utf8'))
  const observedAt = (sources.now?.() ?? new Date()).toISOString()
  return hostFactsSchema.parse({
    observedAt,
    os: await readOs(system, readFile),
    architecture: architecture(system),
    ...memory(system),
    logicalCpuCount: count(attempt(() => system.cpus().length), { positive: true, max: HOST_FACTS_CPU_COUNT_MAX }),
  })
}

/** One sample of what live load is worked out from: when, the CPUs' summed counters and the memory available then. */
interface LoadSample {
  readonly at: number
  readonly cpu: { readonly idle: number; readonly total: number } | null
  readonly availableMemoryBytes: number | null
}

const CPU_TIMES = ['user', 'nice', 'sys', 'idle', 'irq'] as const
type CpuTimes = Partial<Record<(typeof CPU_TIMES)[number], unknown>>

/** Every CPU's counters summed; null when any CPU gives none, since a partial sum would read as a quieter machine. */
function cpuCounters(system: HostFactsSystem): LoadSample['cpu'] {
  const cpus = attempt(() => system.cpus())
  if (!cpus?.length) return null
  let idle = 0, total = 0
  for (const cpu of cpus) {
    const times = (cpu as { times?: CpuTimes } | null)?.times
    if (!times) return null
    for (const name of CPU_TIMES) {
      const value = times[name] ?? 0
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
      total += value
      if (name === 'idle') idle += value
    }
  }
  return { idle, total }
}

/** `MemAvailable` from /proc/meminfo, in bytes; null when the line is missing. */
export function parseMemAvailable(content: string): number | null {
  const kib = /^MemAvailable:\s+(\d+)\s+kB\s*$/mu.exec(content)?.[1]
  return kib === undefined ? null : count(Number(kib) * 1024)
}

/** The `some avg10` share from /proc/pressure/memory; null when it is not there. */
export function parseMemoryPressure(content: string): number | null {
  const value = /^some\b.*\bavg10=(\d+(?:\.\d+)?)/mu.exec(content)?.[1]
  const share = value === undefined ? Number.NaN : Number(value)
  return Number.isFinite(share) && share >= 0 && share <= 100 ? share : null
}

async function availableMemory(system: HostFactsSystem, family: HostOsFamily | null, readFile: (path: string) => Promise<string>): Promise<number | null> {
  // Windows' free memory counts standby pages as available, which is what a new process could have.
  if (family === 'windows') return count(attempt(() => system.freemem()))
  if (family === 'linux') {
    // Linux's free memory leaves out the cache it would give back, so without MemAvailable the honest answer is unknown.
    const meminfo = await readText(readFile, MEMINFO)
    return meminfo === null ? null : parseMemAvailable(meminfo)
  }
  // macOS's free memory leaves out what the system would give back, so it understates; another system is not known.
  return null
}

function loadAverage(system: HostFactsSystem, family: HostOsFamily | null): number | null {
  if (family !== 'linux' && family !== 'macos') return null
  const oneMinute = attempt(() => system.loadavg?.()[0])
  return typeof oneMinute === 'number' && Number.isFinite(oneMinute) && oneMinute >= 0 ? Math.round(oneMinute * 100) / 100 : null
}

/** The share of CPU time not idle between two samples, to a tenth of a percent; null when the counters did not move forward. */
function cpuBusy(start: LoadSample['cpu'], end: LoadSample['cpu']): number | null {
  if (!start || !end || end.total <= start.total || end.idle < start.idle) return null
  const busy = 1 - (end.idle - start.idle) / (end.total - start.total)
  return Math.min(100, Math.max(0, Math.round(busy * 1_000) / 10))
}

/**
 * One machine's facts as a host keeps them (#1031). The operating system, architecture and CPU count are read once, when
 * the host starts; memory is read again when facts are asked for and the last reading is at least `HOST_FACTS_REFRESH_MS` old.
 * Live load (#1311) is read the same way: over the window since the sample the last reading ended on, or over two fresh
 * samples `HOST_LOAD_SAMPLE_MS` apart when that sample is older than `HOST_LOAD_WINDOW_MAX_MS`. Nothing reads on a timer,
 * so a host nobody asks spends nothing.
 */
export class HostFactsSource {
  private first: Promise<HostFacts> | undefined
  private latest: HostFacts | undefined
  private sample: LoadSample | undefined
  private lastLoad: HostLoad | undefined
  private loading: Promise<HostLoad> | undefined
  private readonly system: HostFactsSystem
  private readonly readFile: (path: string) => Promise<string>
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly sources: HostFactsSources = {}) {
    this.system = sources.os ?? nodeOs
    this.readFile = sources.readFile ?? ((path: string) => nodeReadFile(path, 'utf8'))
    this.sleep = sources.sleep ?? (ms => new Promise(resolve => { setTimeout(resolve, ms).unref() }))
  }

  private now(): number { return (this.sources.now?.() ?? new Date()).getTime() }

  private readFirst(): Promise<HostFacts> {
    // A first reading that failed is tried again on the next ask rather than kept.
    return this.first ??= readHostFacts(this.sources).catch((error: unknown) => { this.first = undefined; throw error })
  }

  /** Reads everything the first time; later calls answer the latest facts, with memory read again when that reading is old. */
  async read(): Promise<HostFacts> {
    const first = await this.readFirst()
    const latest = this.latest ?? first
    const now = this.now()
    const age = now - Date.parse(latest.observedAt)
    // A clock that went backwards reads again rather than trusting a reading from the future.
    this.latest = age >= HOST_FACTS_REFRESH_MS || age < 0 ? hostFactsSchema.parse({ ...latest, observedAt: new Date(now).toISOString(), ...memory(this.system) }) : latest
    return this.latest
  }

  /**
   * Takes the first load sample without waiting, so the first ask has a window to read over. The host calls it once as it
   * starts, beside its first facts reading; it starts no timer.
   */
  async primeLoad(): Promise<void> {
    if (this.sample) return
    const sample = await this.takeSample((await this.readFirst()).os.family)
    this.sample ??= sample
  }

  /** The live load, read again when the last reading is at least `HOST_FACTS_REFRESH_MS` old. Asks at once share one reading. */
  load(): Promise<HostLoad> {
    return this.loading ??= this.readLoad().finally(() => { this.loading = undefined })
  }

  private async readLoad(): Promise<HostLoad> {
    const family = (await this.readFirst()).os.family
    const now = this.now()
    const age = this.lastLoad ? now - Date.parse(this.lastLoad.observedAt) : Number.NaN
    if (this.lastLoad && age >= 0 && age < HOST_FACTS_REFRESH_MS) return this.lastLoad
    // A starting sample too old to say how busy the machine is now, or from a clock that went backwards, is sampled again.
    const kept = this.sample, keptAge = kept ? now - kept.at : Number.NaN
    const start = kept && keptAge >= 0 && keptAge <= HOST_LOAD_WINDOW_MAX_MS ? kept : await this.takeSample(family)
    const wait = HOST_LOAD_SAMPLE_MS - (this.now() - start.at)
    if (wait > 0) await this.sleep(wait)
    const end = await this.takeSample(family)
    const pressure = family === 'linux' ? await readText(this.readFile, MEMORY_PRESSURE) : null
    this.sample = end
    this.lastLoad = hostLoadSchema.parse({
      observedAt: new Date(end.at).toISOString(),
      windowMs: Math.max(1, Math.round(end.at - start.at)),
      cpuBusyPercent: cpuBusy(start.cpu, end.cpu),
      loadAverage: loadAverage(this.system, family),
      availableMemoryBytes: end.availableMemoryBytes,
      windowStartAvailableMemoryBytes: start.availableMemoryBytes,
      memoryPressurePercent: pressure === null ? null : parseMemoryPressure(pressure),
    })
    return this.lastLoad
  }

  private async takeSample(family: HostOsFamily | null): Promise<LoadSample> {
    const availableMemoryBytes = await availableMemory(this.system, family, this.readFile)
    return { at: this.now(), cpu: cpuCounters(this.system), availableMemoryBytes }
  }
}

/** A send this host has taken and not yet begun. */
const PLACED_DELIVERIES: ReadonlySet<string> = new Set(['queued', 'submitting'])
/**
 * A follow-up that will start without anyone touching it: queued until it goes, or going. Once the follow-up queue owns a
 * send, its delivery record is gone, so the queue's item is what counts until it starts or the user withdraws it. One
 * paused for the user's review, failed or uncertain waits on the user, not on the machine.
 */
const PLACED_FOLLOWUPS: ReadonlySet<string> = new Set(['queued', 'dispatching'])

/**
 * What a machine report counts beside its facts, as the host holds it now: its threads, and the sends it has taken. Read
 * through a function, after the load is read, because a load reading may wait out its window and counts taken before it
 * would be that much out of date.
 */
export interface MachineWork {
  readonly threads: readonly Pick<AgentHostSnapshot['threads'][number], 'id' | 'status'>[]
  readonly deliveries?: readonly Pick<AgentDelivery, 'threadId' | 'status'>[]
  readonly followups?: readonly Pick<AgentFollowup, 'threadId' | 'status'>[]
  /**
   * Threads Watcher has admitted a start for here whose first prompt has not gone yet, created or not: the start's
   * reservation comes before its thread and its delivery do, so without it a start in progress would count nowhere.
   */
  readonly startsNotYetSent?: readonly string[]
}

/**
 * A machine's facts, how many of its threads are running a turn now, its live load, and its work placed but not started
 * (#1311): threads not running a turn that hold a send not yet begun, such as a thread Watcher has just started there.
 * The counts are read after the facts and the load, so they are as of the answer.
 */
export async function hostMachineReport(facts: HostFactsSource, work: () => MachineWork): Promise<HostMachineReport> {
  // A load that cannot be read leaves the facts standing and reads unknown.
  const [machine, load] = await Promise.all([facts.read(), facts.load().catch(() => null)])
  const { threads, deliveries = [], followups = [], startsNotYetSent = [] } = work()
  const running = new Set(threads.filter(thread => thread.status === 'running').map(thread => thread.id))
  const placed = new Set([
    ...deliveries.filter(item => PLACED_DELIVERIES.has(item.status)).map(item => item.threadId),
    ...followups.filter(item => PLACED_FOLLOWUPS.has(item.status)).map(item => item.threadId),
    // A start whose thread is not created yet has no thread to be running, so it counts.
    ...startsNotYetSent,
  ].filter(threadId => !running.has(threadId))).size
  const within = (value: number) => value <= HOST_RUNNING_THREADS_MAX ? value : null
  return { facts: machine, runningThreads: within(running.size), load, placedNotStarted: within(placed) }
}
