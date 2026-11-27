import { execFile } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { basename } from 'node:path'
import type { LocalServer } from '../../shared/browser'

/** A port some process listens on, on this computer's loopback or every address. */
export interface Listener { readonly port: number; readonly pid: number }
/** A process and its parent, enough to walk up to Sotto. */
export interface ProcessEntry { readonly pid: number; readonly parentPid: number; readonly name: string }

const PROBE_MS = 1000
const PROBE_BYTES = 64 * 1024
const LOCAL_ADDRESSES = new Set(['127.0.0.1', '0.0.0.0', '::1', '::', '[::1]', '[::]', '*', 'localhost'])

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

/** `netstat -ano -p TCP` and `-p TCPv6` on Windows: listening sockets and the process that owns each. */
export function parseNetstat(text: string): Listener[] {
  const found: Listener[] = []
  for (const line of text.split(/\r?\n/u)) {
    const columns = line.trim().split(/\s+/u)
    if (columns.length < 5 || columns[0] !== 'TCP' || columns[3] !== 'LISTENING') continue
    const local = portOf(columns[1]!)
    const pid = Number(columns[4])
    if (local && LOCAL_ADDRESSES.has(local.host) && Number.isInteger(pid)) found.push({ port: local.port, pid })
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
      if (local && LOCAL_ADDRESSES.has(local.host)) found.push({ port: local.port, pid })
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
    if (local && LOCAL_ADDRESSES.has(local.host) && pid) found.push({ port: local.port, pid: Number(pid) })
  }
  return found
}
/** `ps -A -o pid=,ppid=,comm=`, or the same columns from PowerShell on Windows. */
export function parseProcesses(text: string): Map<number, ProcessEntry> {
  const table = new Map<number, ProcessEntry>()
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line)
    if (match) table.set(Number(match[1]), { pid: Number(match[1]), parentPid: Number(match[2]), name: basename(match[3]!.replace(/\\/gu, '/')) })
  }
  return table
}

/**
 * Whether `pid` was started from Sotto: one of Sotto's own processes is among its parents. Sotto's own processes, which
 * run Sotto's executable, are left out themselves, so its tool servers never list as the user's.
 */
export function startedFromSotto(pid: number, table: ReadonlyMap<number, ProcessEntry>, sottoPid: number, sottoName: string): boolean {
  const own = (entry: ProcessEntry | undefined): boolean => !!entry && entry.name.toLowerCase() === sottoName.toLowerCase()
  if (pid === sottoPid || own(table.get(pid))) return false
  let current = table.get(pid)
  for (let depth = 0; current && depth < 64; depth++) {
    if (current.parentPid === sottoPid) return true
    current = table.get(current.parentPid)
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
    return parseProcesses(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name | ForEach-Object { "{0} {1} {2}" -f $_.ProcessId, $_.ParentProcessId, $_.Name }']))
  }
  return parseProcesses(await run('ps', ['-A', '-o', 'pid=,ppid=,comm=']))
}

/** The page a server answers at its root, if it is one: its title, or null for anything that is not a web page. */
function probe(port: number, secure: boolean): Promise<string | null> {
  return new Promise(resolve => {
    const options = { host: '127.0.0.1', port, path: '/', method: 'GET', timeout: PROBE_MS, headers: { accept: 'text/html' }, ...(secure ? { rejectUnauthorized: false, servername: 'localhost' } : {}) }
    const request = (secure ? httpsRequest : httpRequest)(options, response => {
      if (!String(response.headers['content-type'] ?? '').includes('text/html')) { response.destroy(); resolve(null); return }
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { body += chunk; if (body.length > PROBE_BYTES) response.destroy() })
      response.on('close', () => {
        // eslint-disable-next-line no-control-regex -- Untrusted page words, shown on one line.
        const title = /<title[^>]*>([^<]*)<\/title>/iu.exec(body)?.[1]?.replace(/[\x00-\x1f\x7f‪-‮⁦-⁩]/gu, ' ').replace(/\s+/gu, ' ').trim() ?? ''
        resolve(title.slice(0, 300))
      })
    })
    request.on('timeout', () => { request.destroy(); resolve(null) })
    request.on('error', () => resolve(null))
    request.end()
  })
}

/**
 * The web servers on this computer's loopback that were started from Sotto (ADR-0220, decision 4): by an agent, its
 * command or a terminal in Sotto. Each is asked once for its root page, which says whether it is a web page and its
 * title; nothing else is sent, kept or logged. A server started outside Sotto is never asked.
 */
export async function findLocalServers(sottoPid = process.pid, sottoName = basename(process.execPath)): Promise<LocalServer[]> {
  const [listening, table] = await Promise.all([listeners(), processes()])
  const ports = new Map<number, number>()
  for (const listener of listening) if (!ports.has(listener.port) && startedFromSotto(listener.pid, table, sottoPid, sottoName)) ports.set(listener.port, listener.pid)
  const found = await Promise.all([...ports].slice(0, 40).map(async ([port, pid]): Promise<LocalServer | null> => {
    const plain = await probe(port, false)
    const title = plain ?? await probe(port, true)
    if (title === null) return null
    return { port, url: `${plain !== null ? 'http' : 'https'}://localhost:${port}/`, title, process: table.get(pid)?.name.slice(0, 200) ?? '' }
  }))
  return found.filter((server): server is LocalServer => server !== null).sort((a, b) => a.port - b.port)
}
