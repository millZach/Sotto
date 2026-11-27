import { execFile } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { basename } from 'node:path'
import type { LocalServer } from '../../shared/browser'

/** The loopback address a server answers on: IPv4's, or IPv6's for a server that listens only there. */
export type LoopbackAddress = '127.0.0.1' | '::1'
/** A port some process listens on, on this computer's loopback or every address, and the loopback that reaches it. */
export interface Listener { readonly port: number; readonly pid: number; readonly address: LoopbackAddress }
/** A process and its parent, enough to walk up to Sotto. */
/**
 * One process: its parent, its program's name, and on Windows when it started (`started`, Windows file time), since
 * Windows keeps a process's parent ID after the parent exits and may give that ID to a new process.
 */
export interface ProcessEntry { readonly pid: number; readonly parentPid: number; readonly name: string; readonly started?: number }

const PROBE_MS = 1000
const PROBE_BYTES = 64 * 1024
/** The addresses that reach a listener from this computer, by the loopback each is reached on. */
const LOCAL_ADDRESSES = new Map<string, LoopbackAddress>([
  ['127.0.0.1', '127.0.0.1'], ['0.0.0.0', '127.0.0.1'], ['*', '127.0.0.1'], ['localhost', '127.0.0.1'],
  ['::1', '::1'], ['::', '::1'], ['[::1]', '::1'], ['[::]', '::1'],
])
/** IPv4's loopback is asked first, as a browser opening `localhost` usually is. */
const LOOPBACKS: readonly LoopbackAddress[] = ['127.0.0.1', '::1']

function run(command: string, args: readonly string[]): Promise<string> {
  return new Promise(resolve => {
    execFile(command, args, { windowsHide: true, timeout: 5000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }, (error, stdout) => resolve(error && !stdout ? '' : String(stdout)))
  })
}
const portOf = (address: string): { host: string; port: number } | null => {
  const at = address.lastIndexOf(':')
  if (at < 0) return null
  const port = Number(address.slice(at + 1))
  return Number.isInteger(port) && port > 0 && port < 65536 ? { host: address.slice(0, at), port } : null
}

/**
 * `netstat -ano -p TCP` and `-p TCPv6` on Windows: listening sockets and the process that owns each. The state column
 * is in the system's language (ABHÖREN in German), so a listening socket is told by its shape instead: no connection
 * has a remote port of 0. The process ID is the last column.
 */
export function parseNetstat(text: string): Listener[] {
  const found: Listener[] = []
  for (const line of text.split(/\r?\n/u)) {
    const columns = line.trim().split(/\s+/u)
    if (columns.length < 5 || columns[0] !== 'TCP') continue
    const local = portOf(columns[1]!)
    const remote = /^(?:0\.0\.0\.0|\[::\]|\*):0$/u.test(columns[2]!)
    const pid = Number(columns[columns.length - 1])
    const address = local ? LOCAL_ADDRESSES.get(local.host) : undefined
    if (local && address && remote && Number.isInteger(pid) && pid > 0) found.push({ port: local.port, pid, address })
  }
  return found
}
/** `lsof -nP -iTCP -sTCP:LISTEN -Fpn` on macOS: `p<pid>` then each `n<address>:<port>`. */
export function parseLsof(text: string): Listener[] {
  const found: Listener[] = []
  let pid = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid) {
      const local = portOf(line.slice(1))
      const address = local ? LOCAL_ADDRESSES.get(local.host) : undefined
      if (local && address) found.push({ port: local.port, pid, address })
    }
  }
  return found
}
/** `ss -ltnpH` on Linux: `LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=1234,fd=20))`. */
export function parseSs(text: string): Listener[] {
  const found: Listener[] = []
  for (const line of text.split('\n')) {
    const columns = line.trim().split(/\s+/u)
    if (columns.length < 5) continue
    const local = portOf(columns[3]!.replace(/%[^:\]]+/u, ''))
    const pid = /pid=(\d+)/u.exec(line)?.[1]
    const address = local ? LOCAL_ADDRESSES.get(local.host) : undefined
    if (local && address && pid) found.push({ port: local.port, pid: Number(pid), address })
  }
  return found
}
/** `ps -A -o pid=,ppid=,comm=`, or from PowerShell on Windows the same with each process's start (`withStart`) before its name. */
export function parseProcesses(text: string, withStart = false): Map<number, ProcessEntry> {
  const table = new Map<number, ProcessEntry>()
  const row = withStart ? /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/u : /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u
  for (const line of text.split(/\r?\n/u)) {
    const match = row.exec(line)
    if (!match) continue
    const started = withStart ? Number(match[3]) : 0
    const name = basename((withStart ? match[4] : match[3])!.replace(/\\/gu, '/'))
    table.set(Number(match[1]), { pid: Number(match[1]), parentPid: Number(match[2]), name, ...started > 0 ? { started } : {} })
  }
  return table
}

/**
 * Whether `pid` was started from Sotto: one of Sotto's own processes is among its parents. Sotto's own processes, which
 * run Sotto's executable, are left out themselves, so its tool servers never list as the user's. A parent that started
 * after its child is not its parent: Windows gave the exited parent's ID to that newer process, which could be Sotto,
 * and a server started before Sotto, such as one a test or the user runs, would otherwise list as Sotto's.
 */
export function startedFromSotto(pid: number, table: ReadonlyMap<number, ProcessEntry>, sottoPid: number, sottoName: string): boolean {
  const own = (entry: ProcessEntry | undefined): boolean => !!entry && entry.name.toLowerCase() === sottoName.toLowerCase()
  const parentOf = (child: ProcessEntry, parent: ProcessEntry | undefined): boolean => !parent || child.started === undefined || parent.started === undefined || parent.started <= child.started
  if (pid === sottoPid || own(table.get(pid))) return false
  let current = table.get(pid)
  for (let depth = 0; current && depth < 64; depth++) {
    const parent = table.get(current.parentPid)
    if (!parentOf(current, parent)) return false
    if (current.parentPid === sottoPid) return true
    current = parent
  }
  return false
}

async function listeners(): Promise<Listener[]> {
  if (process.platform === 'win32') return parseNetstat(`${await run('netstat', ['-ano', '-p', 'TCP'])}\n${await run('netstat', ['-ano', '-p', 'TCPv6'])}`)
  if (process.platform === 'darwin') return parseLsof(await run('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']))
  return parseSs(await run('ss', ['-ltnpH']))
}
async function processes(): Promise<Map<number, ProcessEntry>> {
  if (process.platform === 'win32') {
    return parseProcesses(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate | ForEach-Object { "{0} {1} {2} {3}" -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }), $_.Name }']), true)
  }
  return parseProcesses(await run('ps', ['-A', '-o', 'pid=,ppid=,comm=']))
}

/** A page's title as Sotto shows it: untrusted words on one line, or empty for a page with none. */
function titleOf(body: string): string {
  // eslint-disable-next-line no-control-regex -- Untrusted page words, shown on one line.
  const title = /<title[^>]*>([^<]*)<\/title>/iu.exec(body)?.[1]?.replace(/[\x00-\x1f\x7f‪-‮⁦-⁩]/gu, ' ').replace(/\s+/gu, ' ').trim() ?? ''
  return title.slice(0, 300)
}

/**
 * The page a server answers at its root on one loopback address, if it is one: its title, or null for anything that is
 * not a web page. The answer settles once: on the page's end, on its first 64 KiB, on an error, or at `deadlineMs`
 * from the start however the server trickles its page, and the request is closed then.
 */
export function probeLocalPage(address: LoopbackAddress, port: number, secure: boolean, deadlineMs = PROBE_MS): Promise<string | null> {
  return new Promise(resolve => {
    let settled = false
    const settle = (title: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      request.destroy()
      resolve(title)
    }
    const deadline = setTimeout(() => settle(null), deadlineMs)
    const options = { host: address, port, path: '/', method: 'GET', headers: { accept: 'text/html' }, ...(secure ? { rejectUnauthorized: false, servername: 'localhost' } : {}) }
    const request = (secure ? httpsRequest : httpRequest)(options, response => {
      if (!String(response.headers['content-type'] ?? '').toLowerCase().includes('text/html')) { settle(null); return }
      let body = ''
      response.setEncoding('utf8')
      const read = (): void => settle(titleOf(body))
      response.on('data', (chunk: string) => { body += chunk; if (body.length > PROBE_BYTES) read() })
      response.on('end', read)
      // A page cut short still says it is a web page, and what it is called if that came first.
      response.on('close', read)
    })
    request.on('error', () => settle(null))
    request.end()
  })
}

/**
 * Each port a process started from Sotto listens on, with that process and the loopback addresses that reach it, IPv4's
 * first. Another process listening on the same port at another address is never asked.
 */
export function probeTargets(listening: readonly Listener[], table: ReadonlyMap<number, ProcessEntry>, sottoPid: number, sottoName: string): Map<number, { pid: number; addresses: LoopbackAddress[] }> {
  const ports = new Map<number, { pid: number; addresses: LoopbackAddress[] }>()
  for (const listener of listening) {
    const known = ports.get(listener.port)
    if (known) {
      if (known.pid === listener.pid && !known.addresses.includes(listener.address)) known.addresses.push(listener.address)
      continue
    }
    if (startedFromSotto(listener.pid, table, sottoPid, sottoName)) ports.set(listener.port, { pid: listener.pid, addresses: [listener.address] })
  }
  for (const target of ports.values()) target.addresses.sort((a, b) => LOOPBACKS.indexOf(a) - LOOPBACKS.indexOf(b))
  return ports
}

/**
 * The web servers on this computer's loopback that were started from Sotto (ADR-0220, decision 4): by an agent, its
 * command or a terminal in Sotto. Each is asked once for its root page, which says whether it is a web page and its
 * title; nothing else is sent, kept or logged. A server started outside Sotto is never asked.
 */
export async function findLocalServers(sottoPid = process.pid, sottoName = basename(process.execPath)): Promise<LocalServer[]> {
  const [listening, table] = await Promise.all([listeners(), processes()])
  const ports = probeTargets(listening, table, sottoPid, sottoName)
  const found = await Promise.all([...ports].slice(0, 40).map(async ([port, { pid, addresses }]): Promise<LocalServer | null> => {
    for (const address of addresses) {
      const plain = await probeLocalPage(address, port, false)
      const title = plain ?? await probeLocalPage(address, port, true)
      if (title !== null) return { port, url: `${plain !== null ? 'http' : 'https'}://localhost:${port}/`, title, process: table.get(pid)?.name.slice(0, 200) ?? '' }
    }
    return null
  }))
  return found.filter((server): server is LocalServer => server !== null).sort((a, b) => a.port - b.port)
}
