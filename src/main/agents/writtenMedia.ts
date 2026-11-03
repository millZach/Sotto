import { stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { MAX_ACTIVITY_MEDIA, type AgentActivityMedia } from '../../shared/agentActivity'
import { AGENT_MAX_IMAGE_BYTES } from '../../shared/agents'
import { runGitStatusCommand, type RunGitCommand } from './gitStatus'
import { videoHandle } from './shownMedia'
import type { ThreadMediaStore } from './threadMedia'

/**
 * Pictures and videos an agent wrote in a turn (ADR-0170, part 4, and part 7's switch): the files in the thread's folder,
 * git-ignored ones included, whose content changed after the turn began. Found once the turn ends, by one listing of the
 * folder's picture and video files, never while it works, so a turn's updates do no more than they did, and only while
 * **Show every picture and video an agent makes** is on. `node_modules` is never looked at. A picture is kept in the thread media store as
 * any picture is; a video stays where it was written.
 */
/** Past this many picture and video files the folder is too full of them to say which the turn wrote: none is shown. */
export const WRITTEN_LISTING_MAX = 5_000
/** How many files are looked at the same time. */
const STATS_AT_ONCE = 16

/** A file the listing found: where it is and what its last change says of it. */
export interface WrittenFile { readonly path: string; readonly sizeBytes: number; readonly modifiedMs: number }

/** Whether a listed path is or is inside a `node_modules` folder, which is never looked at. */
const inDependencies = (path: string): boolean => /(^|\/)node_modules(\/|$)/u.test(path)
/** Whether a path names a picture or video by its extension; its bytes decide later what it is. */
const namesMedia = (path: string): boolean => /\.(png|jpe?g|gif|webp|mp4|m4v|mov|webm)$/iu.test(path)
/** Past this many untracked or ignored folders, only the first are looked into. */
const FOLDERS_LOOKED_INTO = 50

/**
 * The picture and video files in `folder` a turn could have written, outside `node_modules`. One `git status` names the
 * tracked files changed since the last commit, staged or not, and the untracked and ignored files, with a folder that
 * holds only such files named once; one more listing looks for pictures and videos inside those folders, never inside
 * `node_modules`, which Git therefore never walks. A tracked file unchanged since the last commit was written by no turn,
 * so the folder's committed pictures are never looked at. Undefined when the folder is no Git working copy, Git cannot
 * be run, or it holds more than `WRITTEN_LISTING_MAX` of them.
 */
export async function listMediaFiles(folder: string, git: RunGitCommand = runGitStatusCommand): Promise<string[] | undefined> {
  const status = await git(folder, 'git', ['status', '-z', '--porcelain=v1', '--untracked-files=normal', '--ignored=matching']).catch(() => undefined)
  if (status === undefined) return undefined
  const paths = new Set<string>(), untracked: string[] = [], ignored: string[] = []
  const entries = status.split('\0')
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!
    if (entry.length < 4) continue
    const code = entry.slice(0, 2), path = entry.slice(3)
    // A rename or copy names where it came from next; the file is where it went.
    if (/[RC]/u.test(code)) index++
    if (inDependencies(path)) continue
    if (code === '??' || code === '!!') {
      if (path.endsWith('/')) (code === '??' ? untracked : ignored).push(path)
      else if (namesMedia(path)) paths.add(path)
    } else if (!code.includes('D') && namesMedia(path)) paths.add(path)
  }
  // Inside the folders Git named once, the pictures and videos alone: `:(glob,icase)` so `Shot.PNG` counts.
  const inside = (folders: string[]) => folders.slice(0, FOLDERS_LOOKED_INTO).flatMap(folder => ['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'm4v', 'mov', 'webm']
    .map(extension => `:(glob,icase)${folder}**/*.${extension}`))
  const listings = await Promise.all([
    untracked.length ? git(folder, 'git', ['ls-files', '-z', '--others', '--exclude-standard', '--', ...inside(untracked)]) : '',
    ignored.length ? git(folder, 'git', ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ...inside(ignored)]) : '',
  ]).catch(() => undefined)
  if (!listings) return undefined
  for (const listing of listings) for (const path of listing.split('\0')) if (path && !inDependencies(path)) paths.add(path)
  return paths.size > WRITTEN_LISTING_MAX ? undefined : [...paths]
}

/**
 * The files among `paths` whose content changed at or after `since`, newest first, at most `MAX_ACTIVITY_MEDIA`: what
 * the turn that began then wrote. A file that is gone, or is not a plain file, is not one.
 */
export async function writtenSince(folder: string, paths: readonly string[], since: number): Promise<WrittenFile[]> {
  const found: WrittenFile[] = []
  for (let start = 0; start < paths.length; start += STATS_AT_ONCE) {
    const batch = await Promise.all(paths.slice(start, start + STATS_AT_ONCE).map(async path => {
      const info = await stat(join(folder, path)).catch(() => undefined)
      return info?.isFile() && info.size > 0 && info.mtimeMs >= since ? { path, sizeBytes: info.size, modifiedMs: info.mtimeMs } : undefined
    }))
    for (const file of batch) if (file) found.push(file)
  }
  return found.sort((a, b) => b.modifiedMs - a.modifiedMs || a.path.localeCompare(b.path)).slice(0, MAX_ACTIVITY_MEDIA)
}

/** Whether `path` is a video by its name, as the listing found it; its bytes decide whether it is one a tile plays. */
const namesVideo = (path: string): boolean => /\.(mp4|m4v|mov|webm)$/iu.test(path)

/** What a turn wrote, as one step carries it: the files by their place in the folder, and their handles. */
export interface WrittenMedia { readonly changes: { path: string; kind: string }[]; readonly media: AgentActivityMedia[] }

/** What keeps a turn's written pictures and remembers where its videos are: the thread media store. */
export type WrittenMediaStore = Pick<ThreadMediaStore, 'captureFile' | 'keepVideo'>

/**
 * The pictures and videos the turn that began at `since` wrote in `folder`, newest first: each picture kept by the
 * store's `captureFile` with its own bytes deciding its type, each video a handle whose file the store remembers.
 * Undefined when there are none, and when the folder cannot be listed.
 */
export async function writtenMedia(folder: string, since: number, store: WrittenMediaStore, git?: RunGitCommand): Promise<WrittenMedia | undefined> {
  const paths = await listMediaFiles(folder, git)
  if (!paths?.length) return undefined
  const files = await writtenSince(folder, paths, since)
  const media: AgentActivityMedia[] = [], changes: { path: string; kind: string }[] = []
  for (const file of files) {
    const absolute = join(folder, file.path)
    const video = namesVideo(file.path) ? await videoHandle(absolute, media.length, file) : undefined
    if (video) store.keepVideo(video.handle.digest, video.file)
    const handle = video?.handle ?? (!namesVideo(file.path) && file.sizeBytes <= AGENT_MAX_IMAGE_BYTES ? (await store.captureFile(absolute, 'file'))[0] : undefined)
    if (!handle) continue
    // The store names a picture by its place among the ones it was given; here it is its place among the turn's.
    media.push({ ...handle, id: `m${media.length}`, ...handle.kind === 'image' ? { name: basename(file.path).slice(0, 200) || handle.name } : {} })
    // `Write`, so the step's line says the agent wrote it, in the window's words.
    changes.push({ path: file.path, kind: 'Write' })
  }
  return media.length ? { changes, media } : undefined
}
