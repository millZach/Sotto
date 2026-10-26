import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ACTIVITY_RECORDINGS_KEPT, type MainLoopReading } from '../../shared/mainActivity'

/** A V8 CPU profile as the DevTools protocol's Profiler.stop returns it, read loosely. */
export interface RawCpuProfile {
  readonly nodes?: readonly unknown[]
  readonly startTime?: unknown
  readonly endTime?: unknown
  readonly samples?: readonly unknown[]
  readonly timeDeltas?: readonly unknown[]
}

/** One profiler: main's own inspector session, or the window's debugger. */
export interface ProfilerTarget {
  start(): Promise<void>
  stop(): Promise<RawCpuProfile>
  /** Stops without keeping anything; never throws. */
  cancel(): Promise<void>
}

export interface CleanCallFrame {
  readonly functionName: string
  readonly scriptId: string
  readonly url: string
  readonly lineNumber: number
  readonly columnNumber: number
}
export interface CleanProfileNode {
  readonly id: number
  readonly callFrame: CleanCallFrame
  readonly hitCount: number
  readonly children: readonly number[]
}
/** What an activity recording keeps of a profile: function names, script locations inside Sotto, and timings. */
export interface CleanCpuProfile {
  readonly nodes: readonly CleanProfileNode[]
  readonly startTime: number
  readonly endTime: number
  readonly samples: readonly number[]
  readonly timeDeltas: readonly number[]
}

/** The function name and URL a frame outside Sotto's own code is given, so nothing from such a page is kept. */
export const OUTSIDE_SOTTO = '(outside Sotto)'
/** Script URLs inside the app are kept relative to it, under this prefix, so no folder of this computer is saved. */
export const SOTTO_SCRIPT_PREFIX = 'sotto:///'
/**
 * V8's own frames, which belong to no script: the profile's root and the time spent outside JavaScript. They keep their
 * names and their empty URL; every other frame with no URL is treated as outside Sotto.
 */
const V8_PSEUDO_FRAMES: ReadonlySet<string> = new Set(['(root)', '(program)', '(idle)', '(garbage collector)'])

const integer = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0
const text = (value: unknown, limit: number): string => typeof value === 'string' ? value.slice(0, limit) : ''

/**
 * Where a script came from, kept only when it is Sotto's own: Node's and Electron's built-in modules by name, and
 * files under the app's folder (or the development server the window loads from) relative to it. Anything else, such
 * as an embedded page's script or code evaluated with no address at all, comes back null and its frame is renamed.
 */
export function sottoScriptUrl(url: string, appRoots: readonly string[], devOrigins: readonly string[] = []): string | null {
  // A script with no address is code something evaluated, whose function names can be anyone's words.
  if (url === '') return null
  if (/^(node:|internal\/|electron\/js2c\/|electron:)/u.test(url)) return url.slice(0, 512)
  for (const origin of devOrigins) {
    if (url.startsWith(`${origin}/`)) return `${SOTTO_SCRIPT_PREFIX}${url.slice(origin.length + 1).split(/[?#]/u)[0]}`
  }
  let path: string
  try { path = url.startsWith('file:') ? fileURLToPath(url) : url } catch { return null }
  if (!isAbsolute(path)) return null
  for (const root of appRoots) {
    const inside = relative(root, path)
    if (inside !== '' && !inside.startsWith('..') && !/^[a-z]:/iu.test(inside) && !inside.startsWith(sep) && !inside.startsWith('/')) {
      return `${SOTTO_SCRIPT_PREFIX}${inside.split(sep).join('/').split(/[?#]/u)[0]}`
    }
  }
  return null
}

/**
 * Keeps only what the activity recording promises: each node's function name, script, line and column, hit count and
 * children, and the profile's sample timings. `positionTicks`, deopt reasons and anything else the profiler adds are
 * dropped; a frame whose script is not Sotto's own, or has no address and is not one of V8's own frames, keeps neither
 * its name nor its URL.
 */
export function cleanCpuProfile(raw: RawCpuProfile, appRoots: readonly string[], devOrigins: readonly string[] = []): CleanCpuProfile {
  const nodes: CleanProfileNode[] = []
  for (const entry of raw.nodes ?? []) {
    if (typeof entry !== 'object' || entry === null) continue
    const node = entry as { id?: unknown; callFrame?: Record<string, unknown>; hitCount?: unknown; children?: unknown }
    const frame = node.callFrame ?? {}
    const rawUrl = text(frame['url'], 4_096), rawName = text(frame['functionName'], 512)
    const url = rawUrl === '' && V8_PSEUDO_FRAMES.has(rawName) ? '' : sottoScriptUrl(rawUrl, appRoots, devOrigins)
    nodes.push({
      id: integer(node.id),
      callFrame: {
        functionName: url === null ? OUTSIDE_SOTTO : rawName,
        scriptId: url === null ? '0' : String(integer(Number(frame['scriptId']))),
        url: url ?? OUTSIDE_SOTTO,
        lineNumber: url === null ? -1 : integer(frame['lineNumber']),
        columnNumber: url === null ? -1 : integer(frame['columnNumber']),
      },
      hitCount: integer(node.hitCount),
      children: Array.isArray(node.children) ? node.children.map(integer) : [],
    })
  }
  return {
    nodes,
    startTime: integer(raw.startTime),
    endTime: integer(raw.endTime),
    samples: (raw.samples ?? []).map(integer),
    timeDeltas: (raw.timeDeltas ?? []).map(integer),
  }
}

/** The numbers saved beside the profiles. Nothing in it is text a person wrote. */
export interface ActivitySummary {
  readonly format: 1
  readonly sottoVersion: string
  readonly platform: string
  readonly startedAt: string
  readonly durationMs: number
  readonly files: readonly string[]
  readonly windowRecorded: boolean
  /** The minute before Record a minute was pressed, and the minute it recorded. */
  readonly before: Omit<MainLoopReading, 'frozen'>
  readonly during: Omit<MainLoopReading, 'frozen'>
}

const RECORDING_NAME = /^sotto-activity-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}(-\d+)?$/u
const PARTIAL = /^sotto-activity-.*\.partial$/u

/** The folder name: when the recording started, in this computer's time, to the second. */
export function activityRecordingName(startedAt: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `sotto-activity-${startedAt.getFullYear()}-${pad(startedAt.getMonth() + 1)}-${pad(startedAt.getDate())}-${pad(startedAt.getHours())}-${pad(startedAt.getMinutes())}-${pad(startedAt.getSeconds())}`
}

/** The file operations a save makes, so a test can make one of them fail. */
export interface RecordingFileSystem {
  mkdir(path: string): Promise<unknown>
  readdir(path: string): Promise<string[]>
  writeFile(path: string, data: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  rm(path: string): Promise<void>
  stat(path: string): Promise<unknown>
}

export const recordingFileSystem: RecordingFileSystem = {
  mkdir: path => mkdir(path, { recursive: true }),
  readdir: path => readdir(path),
  writeFile: (path, data) => writeFile(path, data),
  rename: (from, to) => rename(from, to),
  rm: path => rm(path, { recursive: true, force: true }),
  stat: path => stat(path),
}

/** Removes one entry under `directory`; says whether it is gone rather than throwing. */
async function removeEntry(fs: RecordingFileSystem, directory: string, name: string): Promise<boolean> {
  try { await fs.rm(join(directory, name)); return true } catch { return false }
}

/** Removes every folder a save left half-written. Never throws; returns the ones it could not remove. */
export async function sweepPartialActivityRecordings(directory: string, fs: RecordingFileSystem = recordingFileSystem): Promise<readonly string[]> {
  let entries: string[]
  try { entries = await fs.readdir(directory) } catch { return [] }
  const left: string[] = []
  for (const name of entries.filter(entry => PARTIAL.test(entry))) if (!await removeEntry(fs, directory, name)) left.push(name)
  return left
}

/**
 * Removes all but the newest `kept` recordings, and any folder a save left half-written. Never throws: a folder that
 * cannot be removed now is tried again at the next save. Returns what was removed.
 */
export async function pruneActivityRecordings(directory: string, kept = ACTIVITY_RECORDINGS_KEPT, fs: RecordingFileSystem = recordingFileSystem): Promise<readonly string[]> {
  return keepNewestRecordings(directory, RECORDING_NAME, PARTIAL, kept, fs)
}

/**
 * Removes all but the newest `kept` folders `recording` matches, and every folder `partial` matches: one kind of
 * recording at a time, so activity and hang recordings never push each other out. Never throws; returns what was removed.
 */
export async function keepNewestRecordings(directory: string, recording: RegExp, partial: RegExp, kept: number, fs: RecordingFileSystem = recordingFileSystem): Promise<readonly string[]> {
  let entries: string[]
  try { entries = await fs.readdir(directory) } catch { return [] }
  const recordings = entries.filter(name => recording.test(name)).sort()
  const remove = [...recordings.slice(0, Math.max(0, recordings.length - kept)), ...entries.filter(name => partial.test(name))]
  const removed: string[] = []
  for (const name of remove) if (await removeEntry(fs, directory, name)) removed.push(name)
  return removed
}

/** `name`, or `name-2`, `name-3` and so on: the first that no folder under `directory` has yet. */
export async function freeRecordingName(directory: string, name: string, fs: RecordingFileSystem = recordingFileSystem): Promise<string> {
  let free = name
  for (let attempt = 2; await exists(fs, join(directory, free)); attempt += 1) free = `${name}-${attempt}`
  return free
}

export interface SavedActivityRecording {
  readonly name: string
  readonly folder: string
  readonly files: readonly string[]
  readonly bytes: number
}

/**
 * A save that failed. Sotto removes whatever it had written; `left` names the folder it could not remove, if any, so
 * what the person is told is true. A half-written folder (`.partial`) is removed again when Sotto next starts or saves a
 * recording, which `removedLater` says. Only a recording thrown away after it was published, whose folder could neither
 * be marked half-written nor removed, is left under a recording's own name: it is kept like a saved one until five
 * newer recordings are saved.
 */
export class ActivityRecordingSaveError extends Error {
  readonly removedLater: boolean
  constructor(readonly left: string | null) {
    super('The activity recording could not be saved.')
    this.name = 'ActivityRecordingSaveError'
    this.removedLater = left !== null && PARTIAL.test(left)
  }
}

export interface SaveActivityRecordingOptions {
  readonly fs?: RecordingFileSystem
  /**
   * Asked before the recording is published and again once it is: false means Stop without saving was pressed while it
   * was being written, and nothing is kept.
   */
  readonly keep?: () => boolean
}

/**
 * Writes one recording under `directory` (Sotto's data folder's `performance-recordings`): into a `.partial` folder
 * first, renamed once every file is written, then prunes to the newest few. Resolves null when `keep` said the
 * recording was thrown away. On any failure nothing it wrote stays, or the error names what does.
 */
export async function saveActivityRecording(directory: string, name: string, profiles: { readonly main: CleanCpuProfile; readonly window: CleanCpuProfile | null },
  summary: Omit<ActivitySummary, 'files' | 'windowRecorded'>, options: SaveActivityRecordingOptions = {}): Promise<SavedActivityRecording | null> {
  const fs = options.fs ?? recordingFileSystem, keep = options.keep ?? (() => true)
  const files = ['main.cpuprofile', ...(profiles.window ? ['window.cpuprofile'] : []), 'summary.json']
  const full: ActivitySummary = { ...summary, files, windowRecorded: profiles.window !== null }
  const contents = [JSON.stringify(profiles.main), ...(profiles.window ? [JSON.stringify(profiles.window)] : []), `${JSON.stringify(full, null, 2)}\n`]
  try { await fs.mkdir(directory) } catch { throw new ActivityRecordingSaveError(null) }
  await sweepPartialActivityRecordings(directory, fs)
  const folderName = await freeRecordingName(directory, name, fs)
  const partialName = `${folderName}.partial`
  const partial = join(directory, partialName), folder = join(directory, folderName)
  let published = false
  try {
    await fs.mkdir(partial)
    for (const [index, file] of files.entries()) await fs.writeFile(join(partial, file), contents[index]!)
    if (keep()) { await fs.rename(partial, folder); published = true }
  } catch {
    throw new ActivityRecordingSaveError(await removeEntry(fs, directory, partialName) ? null : partialName)
  }
  if (published) await pruneActivityRecordings(directory, ACTIVITY_RECORDINGS_KEPT, fs)
  if (!published || !keep()) {
    // Thrown away while it was written: Stop without saving wins until the folder is shown as saved. A published folder
    // is first marked half-written again, so that if it cannot be removed now, the next start or save removes it.
    let target = published ? folderName : partialName
    if (published) {
      try { await fs.rename(folder, partial); target = partialName } catch { /* removed under its own name below */ }
    }
    if (!await removeEntry(fs, directory, target)) throw new ActivityRecordingSaveError(target)
    return null
  }
  const bytes = contents.reduce((sum, content) => sum + Buffer.byteLength(content), 0)
  return { name: folderName, folder, files, bytes }
}

async function exists(fs: RecordingFileSystem, path: string): Promise<boolean> {
  try { await fs.stat(path); return true } catch { return false }
}
