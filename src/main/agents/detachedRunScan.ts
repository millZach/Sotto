/**
 * Finding detached runs (#2476): the agent clients running on this computer, each with the marks its environment carries
 * that say which provider session started it. A run a thread cut loose with `nohup`, `setsid` or `Start-Process` is no
 * longer in that thread's process tree, but it keeps the environment it was started with, and Claude Code and Codex both
 * name their own session there for every command they run.
 *
 * Only the names on `RUN_MARKS` are read out of an environment; the rest of it never leaves the read. Nothing here logs
 * a command, a folder or a mark. Plain Node: the headless host runs it too.
 */
import { execFile } from 'node:child_process'
import { readdir, readFile, readlink } from 'node:fs/promises'
import { basename } from 'node:path'
import { MAX_DETACHED_RUN_COMMAND, MAX_MONITOR_LABEL } from '../../shared/agentMonitoring'

/** The environment variables that name the provider session a process was started from. */
export const RUN_MARKS = ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID'] as const
export type RunMarkName = typeof RUN_MARKS[number]
export interface RunMark { readonly name: RunMarkName; readonly value: string }

/** Any process the table lists: enough to walk its parents. */
export interface ListedProcess {
  readonly pid: number
  /** The parent the system records. On Windows it may name a process that has ended, or one that took its number since. */
  readonly parentPid: number | undefined
  /** When it started, in milliseconds since the epoch, where the system says. */
  readonly startedAt: number | undefined
}

/** An agent client the table found, with what its process says about it. */
export interface AgentProcess extends ListedProcess {
  /** The client's own word: Claude Code, Codex. */
  readonly client: string
  /** Its command line as the system shows it. */
  readonly commandLine: string
  /** Its arguments, the command first, as exactly as the system gives them. */
  readonly argv: readonly string[]
  readonly folder?: string
  readonly marks: readonly RunMark[]
}

export interface ProcessTable {
  readonly processes: ReadonlyMap<number, ListedProcess>
  readonly agents: readonly AgentProcess[]
}

/**
 * Reads this computer's processes, and the marks only of the agent clients `include` keeps once every process is listed,
 * so that it can walk their parents and as little as possible is read.
 */
export type ScanProcesses = (include: (process: ListedProcess & { readonly client: string }, table: ReadonlyMap<number, ListedProcess>) => boolean) => Promise<ProcessTable>

/** The agent clients a thread can start, by the name their command goes by, with their word. */
const CLIENTS: ReadonlyMap<string, string> = new Map([
  ['claude', 'Claude Code'], ['codex', 'Codex'], ['grok', 'Grok Build'], ['devin', 'Devin'], ['opencode', 'OpenCode'],
  ['cursor-agent', 'Cursor'], ['gemini', 'Gemini CLI'], ['hermes', 'Hermes'], ['pi', 'Pi'], ['qwen', 'Qwen Code'],
])
/** Clients installed as a package a runtime runs, found by the package in the script's path. */
const PACKAGES: readonly (readonly [string, string])[] = [['@anthropic-ai/claude-code', 'claude'], ['@openai/codex', 'codex'], ['@google/gemini-cli', 'gemini']]
const RUNTIMES = new Set(['node', 'bun', 'deno'])

const commandName = (path: string): string => basename(path.replace(/\\/gu, '/')).toLowerCase().replace(/\.(exe|cmd|bat|ps1|js|mjs|cjs)$/u, '')

/** The client a process runs, from its command and, under a runtime, its script; undefined for anything else. */
export function agentClient(argv: readonly string[]): string | undefined {
  const first = argv[0]
  if (!first) return undefined
  let name = commandName(first)
  if (RUNTIMES.has(name)) {
    const script = argv.slice(1).find(arg => !arg.startsWith('-'))
    if (!script) return undefined
    const path = script.replace(/\\/gu, '/').toLowerCase()
    const packaged = PACKAGES.find(([folder]) => path.includes(`/${folder}/`))
    name = packaged ? packaged[1] : commandName(script)
  }
  return CLIENTS.get(name)
}

/**
 * A command line split into its arguments, for one the system shows only as a line (Windows, macOS): spaces separate,
 * double quotes hold spaces, and a backslash escapes a quote. Good enough to read flags; the line itself is what is shown.
 */
export function splitCommandLine(line: string): string[] {
  const out: string[] = []
  let current = '', quoted = false, any = false
  for (let at = 0; at < line.length; at++) {
    const char = line[at]!
    if (char === '\\' && line[at + 1] === '"') { current += '"'; at++; any = true; continue }
    if (char === '"') { quoted = !quoted; any = true; continue }
    if (!quoted && /\s/u.test(char)) { if (any) out.push(current); current = ''; any = false; continue }
    current += char; any = true
  }
  if (any) out.push(current)
  return out
}

const SECRET_FLAG = /(key|token|secret|password|passwd|credential|auth)/iu
/** A flag's value, as `--flag value` or `--flag=value`. */
function flagValue(argv: readonly string[], names: readonly string[]): string | undefined {
  for (let at = 1; at < argv.length; at++) {
    const arg = argv[at]!
    for (const name of names) {
      if (arg === name) return argv[at + 1]
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
    }
  }
  return undefined
}
/** Codex's `-c key=value` overrides, for the effort it was given that way. */
function codexOverride(argv: readonly string[], key: string): string | undefined {
  for (let at = 1; at < argv.length; at++) {
    const value = argv[at] === '-c' || argv[at] === '--config' ? argv[at + 1] : undefined
    if (value?.startsWith(`${key}=`)) return value.slice(key.length + 1).replace(/^["']|["']$/gu, '')
  }
  return undefined
}

const shown = (value: string | undefined): string | undefined => {
  const text = value?.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim()
  return text ? text.slice(0, MAX_MONITOR_LABEL) : undefined
}

/** Flags whose value can carry a credential whatever the flag is called: a request header, settings, an environment. */
const SECRET_VALUE_FLAGS = new Set(['--header', '-H', '--mcp-config', '--settings', '--env'])
const BEARER = /\b(bearer|basic)\s+\S+/giu
/**
 * One argument as a row shows it, with what could be a credential left out: inline JSON, such as an MCP configuration
 * whose servers carry keys in their environment; a bearer or basic credential anywhere in it; and the value of any
 * \`name=value\`, \`-c\` override or flag included, whose name speaks of a key, a token, a secret, a password or auth.
 */
function shownArgument(arg: string): string {
  if (/^\s*[{[]/u.test(arg)) return '{…}'
  const equals = arg.indexOf('=')
  if (equals > 0 && SECRET_FLAG.test(arg.slice(0, equals))) return `${arg.slice(0, equals)}=…`
  return arg.replace(BEARER, '$1 …')
}

/**
 * The command as a row shows it: anything that could be a credential left out (\`shownArgument\`), and the value after a
 * flag that names one or carries one, no control characters, cut at the row's limit.
 */
export function shownCommand(argv: readonly string[]): string {
  const parts: string[] = []
  for (let at = 0; at < argv.length; at++) {
    const arg = argv[at]!
    const shown = shownArgument(arg)
    parts.push(/\s/u.test(shown) || shown === '' ? `"${shown}"` : shown)
    if (arg.startsWith('-') && !arg.includes('=') && (SECRET_FLAG.test(arg) || SECRET_VALUE_FLAGS.has(arg)) && at + 1 < argv.length) { parts.push('…'); at++ }
  }
  const line = parts.join(' ').replace(/\p{Cc}/gu, ' ')
  return line.length > MAX_DETACHED_RUN_COMMAND ? `${line.slice(0, MAX_DETACHED_RUN_COMMAND - 1)}…` : line
}

/** What a detached run's row says about it, read from its arguments: its name, model and effort where its command gives them. */
export function runWords(process: Pick<AgentProcess, 'client' | 'argv'>): { readonly name?: string; readonly model?: string; readonly effort?: string } {
  const { argv } = process
  const name = shown(flagValue(argv, ['--name']))
  const model = shown(flagValue(argv, ['--model', '-m']))
  const effort = shown(flagValue(argv, ['--effort', '--reasoning-effort']) ?? codexOverride(argv, 'model_reasoning_effort'))
  return { ...(name ? { name } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
}

/** The marks among `KEY=value` entries, the names compared as the system compares them. */
export function marksIn(entries: Iterable<string>, caseless: boolean): RunMark[] {
  const marks: RunMark[] = []
  for (const entry of entries) {
    const equals = entry.indexOf('=')
    if (equals <= 0) continue
    const key = caseless ? entry.slice(0, equals).toUpperCase() : entry.slice(0, equals)
    const name = RUN_MARKS.find(mark => mark === key)
    const value = entry.slice(equals + 1).trim()
    if (name && value && value.length <= 200 && !marks.some(mark => mark.name === name)) marks.push({ name, value })
  }
  return marks
}

// --- Linux ---------------------------------------------------------------------------------------------------------

/** The parent and the start, in clock ticks after boot, from `/proc/<pid>/stat`, whose second field may hold spaces. */
export function parseLinuxStat(stat: string): { readonly parentPid: number; readonly startTicks: number } | undefined {
  const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/u)
  const parentPid = Number(fields[1]), startTicks = Number(fields[19])
  return Number.isSafeInteger(parentPid) && Number.isSafeInteger(startTicks) ? { parentPid, startTicks } : undefined
}

/** Linux's clock ticks a second, which `getconf CLK_TCK` says is 100 on every architecture Sotto runs on. */
const LINUX_TICKS = 100

async function scanLinux(include: Parameters<ScanProcesses>[0]): Promise<ProcessTable> {
  const bootLine = /^btime\s+(\d+)$/mu.exec(await readFile('/proc/stat', 'utf8').catch(() => ''))
  const boot = bootLine ? Number(bootLine[1]) * 1000 : undefined
  const processes = new Map<number, ListedProcess>()
  const found: { listed: ListedProcess; client: string; argv: string[] }[] = []
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/u.test(entry)) continue
    const pid = Number(entry)
    const stat = parseLinuxStat(await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => ''))
    if (!stat) continue
    const listed: ListedProcess = { pid, parentPid: stat.parentPid || undefined, startedAt: boot === undefined ? undefined : boot + stat.startTicks * 1000 / LINUX_TICKS }
    processes.set(pid, listed)
    const raw = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')
    const argv = raw.split('\0').filter((arg, at, all) => at < all.length - 1 || arg !== '')
    const client = agentClient(argv)
    if (client) found.push({ listed, client, argv })
  }
  const agents: AgentProcess[] = []
  for (const { listed, client, argv } of found) {
    if (!include({ ...listed, client }, processes)) continue
    const pid = listed.pid
    // Another user's environment cannot be read; that process is not this user's run.
    const environment = await readFile(`/proc/${pid}/environ`, 'utf8').catch(() => undefined)
    if (environment === undefined) continue
    const folder = await readlink(`/proc/${pid}/cwd`).catch(() => undefined)
    agents.push({ ...listed, client, argv, commandLine: argv.join(' '), ...(folder ? { folder } : {}), marks: marksIn(environment.split('\0'), false) })
  }
  return { processes, agents }
}

// --- macOS ---------------------------------------------------------------------------------------------------------

/**
 * A listing's output. Any failure fails it, so a table cut short by a timeout, an overflow or a script that stopped partway
 * is never read as the whole table, which would drop the runs it left out. `partial` lets a read about named processes
 * keep what it printed when it exits 1 for one that has just ended, as `ps -p` and `lsof -p` do; a kill or an overflow
 * still fails it.
 */
const run = (file: string, args: readonly string[], options: { readonly timeout?: number; readonly env?: NodeJS.ProcessEnv; readonly partial?: boolean } = {}): Promise<string> => new Promise((done, fail) => {
  execFile(file, [...args], { encoding: 'utf8', timeout: options.timeout ?? 20_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true, ...(options.env ? { env: options.env } : {}) }, (error, stdout) => {
    if (!error) { done(stdout); return }
    const cut = error.killed === true || error.signal !== null && error.signal !== undefined || (error as { code?: unknown }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
    if (options.partial === true && stdout && !cut) done(stdout); else fail(error)
  })
})

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/**
 * `ps`'s `lstart` in the C locale, `Tue Nov 11 17:00:00 2026`, local time, in milliseconds. It is the start the system
 * records, to the second, so a run's identity is the same at every read; one worked out from its elapsed time and the
 * clock could move a second between two reads.
 */
export function parseStarted(fields: readonly string[]): number | undefined {
  const [, month, day, time, year] = fields
  const at = MONTHS.indexOf(month ?? '')
  const clock = /^(\d{1,2}):(\d{2}):(\d{2})$/u.exec(time ?? '')
  if (at < 0 || !clock || !/^\d{1,2}$/u.test(day ?? '') || !/^\d{4}$/u.test(year ?? '')) return undefined
  return new Date(Number(year), at, Number(day), Number(clock[1]), Number(clock[2]), Number(clock[3])).getTime()
}

/** `ps -axww -o pid=,ppid=,lstart=,command=`: each process's parent, its start and its command line. */
export function parseMacTable(output: string): { pid: number; parentPid: number; startedAt: number | undefined; commandLine: string }[] {
  const rows: { pid: number; parentPid: number; startedAt: number | undefined; commandLine: string }[] = []
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/u.exec(line)
    if (!match) continue
    rows.push({ pid: Number(match[1]), parentPid: Number(match[2]), startedAt: parseStarted(match[3]!.split(/\s+/u)), commandLine: match[4]!.trimEnd() })
  }
  return rows
}

interface ListedRow { readonly pid: number; readonly parentPid: number; readonly startedAt: number | undefined; readonly commandLine: string }
interface Candidate { readonly listed: ListedProcess; readonly client: string; readonly commandLine: string; readonly argv: string[] }
/**
 * A system that shows each command only as a line (macOS, Windows): every row listed for its parents, and the agent clients
 * `include` keeps once all are listed, their lines split into arguments.
 */
function candidates(rows: readonly ListedRow[], include: Parameters<ScanProcesses>[0]): { processes: Map<number, ListedProcess>; wanted: Candidate[] } {
  const processes = new Map<number, ListedProcess>()
  const found: Candidate[] = []
  for (const row of rows) {
    const listed: ListedProcess = { pid: row.pid, parentPid: row.parentPid || undefined, startedAt: row.startedAt }
    processes.set(row.pid, listed)
    if (!row.commandLine) continue
    const argv = splitCommandLine(row.commandLine)
    const client = agentClient(argv)
    if (client) found.push({ listed, client, commandLine: row.commandLine, argv })
  }
  return { processes, wanted: found.filter(item => include({ ...item.listed, client: item.client }, processes)) }
}

async function scanMac(include: Parameters<ScanProcesses>[0]): Promise<ProcessTable> {
  const { processes, wanted } = candidates(parseMacTable(await run('/bin/ps', ['-axww', '-o', 'pid=,ppid=,lstart=,command='], { env: { ...process.env, LC_ALL: 'C' } })), include)
  if (!wanted.length) return { processes, agents: [] }
  const pids = wanted.map(item => item.listed.pid).join(',')
  // With -E, ps puts the environment after the command, which it reads only for this user's own processes.
  const environments = new Map<number, string>()
  for (const line of (await run('/bin/ps', ['-E', '-ww', '-o', 'pid=,command=', '-p', pids], { partial: true })).split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line)
    if (match) environments.set(Number(match[1]), match[2]!)
  }
  const folders = new Map<number, string>()
  let current: number | undefined
  for (const line of (await run('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-Fn', '-p', pids], { partial: true }).catch(() => '')).split('\n')) {
    if (line.startsWith('p')) current = Number(line.slice(1))
    else if (line.startsWith('n') && current !== undefined) folders.set(current, line.slice(1))
  }
  const agents = wanted.flatMap(({ listed, client, commandLine, argv }) => {
    const environment = environments.get(listed.pid)
    if (environment === undefined) return []
    // The command comes first and may hold spaces of its own, so only what follows it is read for marks.
    const tail = environment.startsWith(commandLine) ? environment.slice(commandLine.length) : environment
    const folder = folders.get(listed.pid)
    return [{ ...listed, client, argv, commandLine, ...(folder ? { folder } : {}), marks: marksIn(tail.split(/\s+/u), false) }]
  })
  return { processes, agents }
}

// --- Windows -------------------------------------------------------------------------------------------------------

/**
 * Reads a process's working folder and the named variables out of its environment block, through its process
 * parameters, as Process Explorer does. 64-bit processes only; anything it cannot open or read gives null.
 */
const WINDOWS_READER = `using System;
using System.Runtime.InteropServices;
using System.Text;

public static class SottoRunMarks
{
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicInformation { public IntPtr Reserved1; public IntPtr PebBaseAddress; public IntPtr Reserved2; public IntPtr Reserved3; public IntPtr UniqueProcessId; public IntPtr Reserved4; }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool ReadProcessMemory(IntPtr handle, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);
    [DllImport("kernel32.dll")] private static extern bool IsWow64Process(IntPtr handle, out bool wow64);
    [DllImport("ntdll.dll")] private static extern int NtQueryInformationProcess(IntPtr handle, int infoClass, ref BasicInformation info, int length, out int returned);

    private static byte[] Read(IntPtr handle, IntPtr address, long size)
    {
        if (size <= 0 || size > 8 * 1024 * 1024) return null;
        var buffer = new byte[size];
        IntPtr read;
        if (!ReadProcessMemory(handle, address, buffer, (IntPtr)size, out read) || (long)read != size) return null;
        return buffer;
    }

    public static string[] Read(int pid, string[] names)
    {
        if (IntPtr.Size != 8) return null;
        IntPtr handle = OpenProcess(0x0410, false, pid);
        if (handle == IntPtr.Zero) return null;
        try
        {
            bool wow64;
            if (IsWow64Process(handle, out wow64) && wow64) return null;
            var info = new BasicInformation();
            int returned;
            if (NtQueryInformationProcess(handle, 0, ref info, Marshal.SizeOf(info), out returned) != 0) return null;
            var peb = Read(handle, info.PebBaseAddress + 0x20, 8);
            if (peb == null) return null;
            var parameters = Read(handle, (IntPtr)BitConverter.ToInt64(peb, 0), 0x400);
            if (parameters == null) return null;
            string folder = "";
            int folderLength = BitConverter.ToUInt16(parameters, 0x38);
            var folderBytes = Read(handle, (IntPtr)BitConverter.ToInt64(parameters, 0x40), folderLength);
            if (folderBytes != null) folder = Encoding.Unicode.GetString(folderBytes);
            var block = Read(handle, (IntPtr)BitConverter.ToInt64(parameters, 0x80), BitConverter.ToInt64(parameters, 0x3F0));
            if (block == null) return null;
            var found = new StringBuilder();
            foreach (var entry in Encoding.Unicode.GetString(block).Split('\\0'))
            {
                int equals = entry.IndexOf('=');
                if (equals <= 0) continue;
                string key = entry.Substring(0, equals);
                foreach (var name in names) if (string.Equals(key, name, StringComparison.OrdinalIgnoreCase)) found.Append(name).Append('=').Append(entry.Substring(equals + 1)).Append('\\n');
            }
            return new[] { folder, found.ToString() };
        }
        finally { CloseHandle(handle); }
    }
}`

const encoded = (script: string): string[] => ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
const b64 = (value: string): string => Buffer.from(value, 'base64').toString('utf8')

/** Every process, a line each: id, parent, start in UTC and the command line in base64. */
const WINDOWS_TABLE = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
foreach ($p in Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,CommandLine) {
  $start = if ($p.CreationDate) { $p.CreationDate.ToUniversalTime().ToString('o') } else { '' }
  $line = if ($p.CommandLine) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($p.CommandLine)) } else { '' }
  [Console]::Out.WriteLine("$($p.ProcessId)\`t$($p.ParentProcessId)\`t$start\`t$line")
}`

/** The table `WINDOWS_TABLE` prints. A process with no command line, which this user may not read, is listed without one. */
export function parseWindowsTable(output: string): { pid: number; parentPid: number; startedAt: number | undefined; commandLine: string }[] {
  return output.split(/\r?\n/u).flatMap(line => {
    const [pid, parentPid, start = '', command = ''] = line.split('\t')
    if (!pid || !/^\d+$/u.test(pid) || !parentPid || !/^\d+$/u.test(parentPid)) return []
    const startedAt = start ? Date.parse(start) : Number.NaN
    return [{ pid: Number(pid), parentPid: Number(parentPid), startedAt: Number.isFinite(startedAt) ? startedAt : undefined, commandLine: command ? b64(command) : '' }]
  })
}

async function scanWindows(include: Parameters<ScanProcesses>[0]): Promise<ProcessTable> {
  const { processes, wanted } = candidates(parseWindowsTable(await run('powershell.exe', encoded(WINDOWS_TABLE), { timeout: 60_000 })), include)
  if (!wanted.length) return { processes, agents: [] }
  const names = RUN_MARKS.map(name => `'${name}'`).join(',')
  const script = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
${WINDOWS_READER}
'@
foreach ($id in @(${wanted.map(item => item.listed.pid).join(',')})) {
  $read = $null
  try { $read = [SottoRunMarks]::Read($id, @(${names})) } catch { $read = $null }
  if ($null -eq $read) { continue }
  $folder = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($read[0]))
  $marks = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($read[1]))
  [Console]::Out.WriteLine("$id\`t$folder\`t$marks")
}`
  const read = new Map<number, { folder: string; marks: RunMark[] }>()
  for (const line of (await run('powershell.exe', encoded(script), { timeout: 60_000 })).split(/\r?\n/u)) {
    const [pid, folder = '', marks = ''] = line.split('\t')
    if (pid && /^\d+$/u.test(pid)) read.set(Number(pid), { folder: b64(folder).replace(/\\$/u, ''), marks: marksIn(b64(marks).split('\n'), true) })
  }
  const agents = wanted.flatMap(({ listed, client, commandLine, argv }) => {
    const found = read.get(listed.pid)
    return found ? [{ ...listed, client, argv, commandLine, ...(found.folder ? { folder: found.folder } : {}), marks: found.marks }] : []
  })
  return { processes, agents }
}

/** This computer's processes, read the way its system allows. A system Sotto does not run on lists none. */
export const scanProcesses: ScanProcesses = include => process.platform === 'linux' ? scanLinux(include)
  : process.platform === 'darwin' ? scanMac(include)
  : process.platform === 'win32' ? scanWindows(include)
  : Promise.resolve({ processes: new Map(), agents: [] })

/**
 * Whether `pid` runs under `root`, walking the parents the table records. A parent that started after its child is a
 * process that took a dead parent's number, so the walk stops there, as it does at a parent the table does not list.
 */
export function descendsFrom(table: ReadonlyMap<number, ListedProcess>, pid: number, root: number): boolean {
  let current = table.get(pid)
  for (let steps = 0; current && steps < 256; steps++) {
    if (current.pid === root) return true
    const parentPid = current.parentPid
    if (parentPid === undefined || parentPid === current.pid) return false
    if (parentPid === root) return true
    const parent = table.get(parentPid)
    if (!parent || (parent.startedAt !== undefined && current.startedAt !== undefined && parent.startedAt > current.startedAt + 1_000)) return false
    current = parent
  }
  return false
}
