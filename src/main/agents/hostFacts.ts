import * as nodeOs from 'node:os'
import { readFile as nodeReadFile } from 'node:fs/promises'
import { HOST_FACTS_CPU_COUNT_MAX, HOST_FACTS_REFRESH_MS, HOST_FACTS_TEXT_MAX, HOST_RUNNING_THREADS_MAX, hostFactsSchema, type HostFacts, type HostMachineReport, type HostOs } from '../../shared/hostFacts'

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
}

export interface HostFactsSources {
  readonly os?: HostFactsSystem
  readonly readFile?: (path: string) => Promise<string>
  readonly now?: () => Date
}

/** Windows 11 reports itself as Windows NT 10.0; its builds start at 22000. */
const WINDOWS_11_FIRST_BUILD = 22_000
const MAC_SYSTEM_VERSION = '/System/Library/CoreServices/SystemVersion.plist'
/** The os-release specification's order: the administrator's file first, then the vendor's. */
const OS_RELEASE_FILES = ['/etc/os-release', '/usr/lib/os-release'] as const
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

/**
 * One machine's facts as a host keeps them (#1031). The operating system, architecture and CPU count are read once, when
 * the host starts; memory is read again when facts are asked for and the last reading is at least `refreshMs` old.
 * Nothing reads on a timer, so a host nobody asks spends nothing.
 */
export class HostFactsSource {
  private first: Promise<HostFacts> | undefined
  private latest: HostFacts | undefined
  private readonly system: HostFactsSystem
  private readonly refreshMs: number

  constructor(private readonly sources: HostFactsSources & { readonly refreshMs?: number } = {}) {
    this.system = sources.os ?? nodeOs
    this.refreshMs = sources.refreshMs ?? HOST_FACTS_REFRESH_MS
  }

  /** Reads everything the first time; later calls answer the latest facts, with memory read again when that reading is old. */
  async read(): Promise<HostFacts> {
    // A first reading that failed is tried again on the next ask rather than kept.
    const first = await (this.first ??= readHostFacts(this.sources).catch((error: unknown) => { this.first = undefined; throw error }))
    const latest = this.latest ?? first
    const now = this.sources.now?.() ?? new Date()
    const age = now.getTime() - Date.parse(latest.observedAt)
    // A clock that went backwards reads again rather than trusting a reading from the future.
    this.latest = age >= this.refreshMs || age < 0 ? hostFactsSchema.parse({ ...latest, observedAt: now.toISOString(), ...memory(this.system) }) : latest
    return this.latest
  }
}

/** A machine's facts and how many of its threads are running a turn now, as the `host-facts` feature answers them. */
export async function hostMachineReport(facts: HostFactsSource, threads: readonly { readonly status: string }[]): Promise<HostMachineReport> {
  const running = threads.filter(thread => thread.status === 'running').length
  return { facts: await facts.read(), runningThreads: running <= HOST_RUNNING_THREADS_MAX ? running : null }
}
