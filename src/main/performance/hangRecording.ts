import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { MainLoopReading } from '../../shared/mainActivity'
import { freeRecordingName, keepNewestRecordings, OUTSIDE_SOTTO, recordingFileSystem, sottoScriptUrl, type RecordingFileSystem } from './activityRecorder'

/**
 * How many of main's hang recordings stay. At most three a minute are saved (`MAIN_RECORDING_GAP_MS`), so a bad stretch
 * keeps its last few minutes; each is tens of kilobytes, so all of them stay under a megabyte.
 */
export const MAIN_HANG_RECORDINGS_KEPT = 10
/**
 * How many of the window's stay. Main's and the window's are counted apart, and apart from Record a minute's, so a busy
 * afternoon of short freezes of main never pushes out a window that stopped, nor either an activity recording.
 */
export const WINDOW_HANG_RECORDINGS_KEPT = 5
/** Frames kept per stack, from the innermost: enough to see what main was doing and where it was called from. */
export const HANG_FRAMES_KEPT = 40

const HANG_NAME = /^sotto-hang-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}(-\d+)?$/u
const HANG_PARTIAL = /^sotto-hang-.*\.partial$/u
/** Matches no folder: for a keep that sweeps no half-written folders, or a sweep that keeps no recordings. */
const NOTHING = /(?!)/u
export const HANG_FILE = 'hang.json'

/** The file operations a hang save makes: a recording's own, and reading a saved one's kind to count each kind apart. */
export interface HangFileSystem extends RecordingFileSystem {
  readFile(path: string): Promise<string>
}

export const hangFileSystem: HangFileSystem = { ...recordingFileSystem, readFile: path => readFile(path, 'utf8') }

/** One frame of a stack, kept to what ADR-0098 keeps of a profile's frame: a place in Sotto's code. */
export interface HangFrame {
  readonly functionName: string
  readonly url: string
  readonly lineNumber: number
  readonly columnNumber: number
}

/** Main's stack at one moment of a hang, `atMs` after main last answered. */
export interface HangStack {
  readonly atMs: number
  readonly frames: readonly HangFrame[]
}

/** One Sotto process at the moment the window stopped answering, as `app.getAppMetrics()` gives it. */
export interface HangProcess {
  readonly type: string
  readonly cpuPercent: number
  readonly workingSetKb: number
  readonly privateKb: number | null
}

/**
 * What a hang recording holds (#1581, ADR-0098's October 26 amendment). Code, timing and process numbers only: no value
 * main held, so nothing a person wrote or said.
 */
export interface HangRecord {
  readonly format: 1
  /** `main`: main's own event loop stopped. `window`: main kept going but the main window did not answer it. */
  readonly kind: 'main' | 'window'
  readonly sottoVersion: string
  readonly platform: string
  /** When the stopped side last answered. */
  readonly startedAt: string
  /** How long until it answered again; null while it had not when the recording was last written. */
  readonly answeredAfterMs: number | null
  /** How long it had not answered when the recording was last written. */
  readonly writtenAfterMs: number
  /** Main hangs: stacks taken while main was still stopped. Empty when main was stopped outside JavaScript. */
  readonly stacks?: readonly HangStack[]
  /** Window hangs: each Sotto process when the window was found not answering. */
  readonly processes?: readonly HangProcess[]
  /** Window hangs: main's own minute, which says whether main was busy too. */
  readonly mainLoop?: Omit<MainLoopReading, 'frozen'>
}

const integer = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0

/**
 * A stack as the debugger's `Debugger.paused` gives it, cleaned as a profile is (ADR-0098): a frame from a script that is
 * not Sotto's own, or with no address, keeps neither its name nor its address. Nothing else of a frame is read, so no
 * value or scope main held reaches the file.
 */
export function cleanHangFrames(callFrames: unknown, appRoots: readonly string[], devOrigins: readonly string[] = []): HangFrame[] {
  if (!Array.isArray(callFrames)) return []
  return callFrames.slice(0, HANG_FRAMES_KEPT).map(entry => {
    const frame = (typeof entry === 'object' && entry !== null ? entry : {}) as { functionName?: unknown; url?: unknown; location?: { lineNumber?: unknown; columnNumber?: unknown } }
    const url = sottoScriptUrl(typeof frame.url === 'string' ? frame.url.slice(0, 4_096) : '', appRoots, devOrigins)
    if (url === null) return { functionName: OUTSIDE_SOTTO, url: OUTSIDE_SOTTO, lineNumber: -1, columnNumber: -1 }
    return { functionName: typeof frame.functionName === 'string' ? frame.functionName.slice(0, 512) : '', url,
      lineNumber: integer(frame.location?.lineNumber), columnNumber: integer(frame.location?.columnNumber) }
  })
}

/** The folder name: when the stopped side last answered, in this computer's time, to the second. */
export function hangRecordingName(startedAt: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `sotto-hang-${startedAt.getFullYear()}-${pad(startedAt.getMonth() + 1)}-${pad(startedAt.getDate())}-${pad(startedAt.getHours())}-${pad(startedAt.getMinutes())}-${pad(startedAt.getSeconds())}`
}

/**
 * Writes a new hang recording under `directory` (Sotto's data folder's `performance-recordings`): into a `.partial`
 * folder, renamed once written, then keeps the newest few of each kind. Resolves the folder's name; throws when it could
 * not be written, having removed what it wrote where it could. A half-written folder is removed when Sotto next starts.
 */
export async function saveHangRecording(directory: string, record: HangRecord, fs: HangFileSystem = hangFileSystem): Promise<string> {
  await fs.mkdir(directory)
  const name = await freeRecordingName(directory, hangRecordingName(new Date(record.startedAt)), fs)
  const partial = join(directory, `${name}.partial`)
  try {
    await fs.mkdir(partial)
    await fs.writeFile(join(partial, HANG_FILE), `${JSON.stringify(record, null, 2)}\n`)
    await fs.rename(partial, join(directory, name))
  } catch (error) {
    await fs.rm(partial).catch(() => undefined)
    throw error
  }
  // Another save may be writing its own half-written folder now (main's watch and the window's), so none is swept here.
  await keepNewestHangRecordings(directory, fs)
  return name
}

/**
 * Removes all but the newest of main's hang recordings and of the window's, each kind counted apart and read from its
 * folder's file. One whose file cannot be read counts as main's. Never throws.
 */
async function keepNewestHangRecordings(directory: string, fs: HangFileSystem): Promise<void> {
  let entries: string[]
  try { entries = await fs.readdir(directory) } catch { return }
  const newestFirst = entries.filter(name => HANG_NAME.test(name)).sort().reverse()
  // Too few for either kind to be over: no file is read.
  if (newestFirst.length <= Math.min(MAIN_HANG_RECORDINGS_KEPT, WINDOW_HANG_RECORDINGS_KEPT)) return
  const seen = { main: 0, window: 0 }
  for (const name of newestFirst) {
    const kind = await savedHangKind(directory, name, fs)
    seen[kind] += 1
    if (seen[kind] > (kind === 'window' ? WINDOW_HANG_RECORDINGS_KEPT : MAIN_HANG_RECORDINGS_KEPT)) await fs.rm(join(directory, name)).catch(() => undefined)
  }
}

async function savedHangKind(directory: string, name: string, fs: HangFileSystem): Promise<HangRecord['kind']> {
  try {
    const saved = JSON.parse(await fs.readFile(join(directory, name, HANG_FILE))) as { kind?: unknown }
    return saved.kind === 'window' ? 'window' : 'main'
  } catch { return 'main' }
}

/** Removes the folders hang saves left half-written when Sotto last ended. Run at start, before any save. Never throws. */
export async function sweepPartialHangRecordings(directory: string, fs: RecordingFileSystem = recordingFileSystem): Promise<void> {
  await keepNewestRecordings(directory, NOTHING, HANG_PARTIAL, 0, fs)
}

/**
 * Rewrites a saved hang recording, as when the stopped side answers again after it was first written. Written beside the
 * file and renamed over it, so a reader never finds half a file.
 */
export async function updateHangRecording(directory: string, name: string, record: HangRecord, fs: RecordingFileSystem = recordingFileSystem): Promise<void> {
  const file = join(directory, name, HANG_FILE), next = `${file}.next`
  await fs.writeFile(next, `${JSON.stringify(record, null, 2)}\n`)
  await fs.rename(next, file)
}
